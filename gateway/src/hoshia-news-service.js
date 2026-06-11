import {
  getNewsRefreshStatus,
  listNewsTopics,
  refreshNewsTopics
} from "./ai-adapter.js";

const DEFAULT_MAX_AGE_MINUTES = 24 * 60;
const DEFAULT_DAILY_LIMIT = 3;
const DEFAULT_TOPIC_LIMIT = 8;
const NEWS_STAGES = new Set(["idle", "queued", "fetching", "enriching", "editing", "memory_writing", "done", "failed"]);
const NEWS_STAGE_ALIASES = new Map([
  ["rss_fetching", "fetching"],
  ["tavily_enriching", "enriching"],
  ["llm_editing", "editing"]
]);

export class HoshiaNewsService {
  constructor(config = {}, {
    fetchImpl = globalThis.fetch,
    adapter = {}
  } = {}) {
    this.config = normalizeHoshiaNewsConfig(config);
    this.fetchImpl = fetchImpl;
    this.adapter = {
      refreshNewsTopics: adapter.refreshNewsTopics || refreshNewsTopics,
      getNewsRefreshStatus: adapter.getNewsRefreshStatus || getNewsRefreshStatus,
      listNewsTopics: adapter.listNewsTopics || listNewsTopics
    };
    this.refreshCounts = new Map();
    this.cachedStatus = this.safeLocalStatus();
    this.cachedTopics = [];
  }

  enabled() {
    return this.config.enabled;
  }

  async refresh({ force = false, reason = "manual" } = {}) {
    if (!this.enabled()) return disabledResult();
    if (!force && !this.canRefreshToday()) {
      return {
        ok: false,
        enabled: true,
        reason: "news_daily_limit_reached",
        status: this.safeLocalStatus()
      };
    }

    try {
      const payload = await this.adapter.refreshNewsTopics(
        this.config.bridgeOptions,
        { force, reason: cleanIdentifier(reason, 80) || "manual" },
        this.fetchImpl
      );
      this.recordRefresh();
      const topics = this.setCachedTopics(sanitizeNewsTopics(payload?.topics || [], {
        maxAgeMs: this.config.maxAgeMs,
        limit: DEFAULT_TOPIC_LIMIT
      }));
      this.cachedStatus = this.withTopicSnapshot(sanitizeNewsStatus(payload, { maxAgeMs: this.config.maxAgeMs }), topics);
      return {
        ok: true,
        enabled: true,
        status: this.cachedStatus,
        topics
      };
    } catch {
      return bridgeUnavailableResult(this.safeLocalStatus());
    }
  }

  async status() {
    if (!this.enabled()) return disabledResult();
    try {
      const payload = await this.adapter.getNewsRefreshStatus(
        this.config.bridgeOptions,
        { includeRecent: true },
        this.fetchImpl
      );
      this.cachedStatus = this.withTopicSnapshot(
        sanitizeNewsStatus(payload, { maxAgeMs: this.config.maxAgeMs }),
        this.cachedTopics
      );
      return {
        ok: true,
        enabled: true,
        status: this.cachedStatus
      };
    } catch {
      return bridgeUnavailableResult(this.safeLocalStatus());
    }
  }

  async topics({ limit = DEFAULT_TOPIC_LIMIT, query = "daily news topics" } = {}) {
    if (!this.enabled()) return { ...disabledResult(), topics: [] };
    try {
      const payload = await this.adapter.listNewsTopics(
        this.config.bridgeOptions,
        { limit: clampInt(limit, 1, 30, DEFAULT_TOPIC_LIMIT), query },
        this.fetchImpl
      );
      return {
        ok: true,
        enabled: true,
        topics: this.setCachedTopics(sanitizeNewsTopics(payload?.topics || payload?.results || [], {
          maxAgeMs: this.config.maxAgeMs,
          limit: clampInt(limit, 1, 30, DEFAULT_TOPIC_LIMIT)
        }))
      };
    } catch {
      return { ...bridgeUnavailableResult(this.safeLocalStatus()), topics: [] };
    }
  }

  publicState() {
    return {
      enabled: this.enabled(),
      ok: this.enabled() && !this.cachedStatus.stale,
      ...this.cachedStatus,
      status: this.cachedStatus,
      topics: this.getTopics(),
      reason: ""
    };
  }

  getStatus() {
    return this.publicState();
  }

  getTopics() {
    return this.cachedTopics.slice(0, DEFAULT_TOPIC_LIMIT).map((topic) => ({ ...topic }));
  }

  featuredTopic() {
    const usable = this.cachedTopics.filter((topic) => topic?.post_seed && hasReactionPoint(topic) && !isHighRiskTopic(topic));
    return usable.find((topic) => ["anime_game", "music_movie", "sports_campus", "tech_tools", "light_trends"].includes(topic.category)) || usable[0] || null;
  }

  getCapabilityContext() {
    const state = this.publicState();
    if (!state.enabled) {
      return {
        module_id: "news",
        enabled: false,
        current_state: ["News topic module is disabled."],
        capabilities: [],
        limits: ["Hoshia cannot refresh or read daily news topics right now."]
      };
    }

    const currentState = [
      `News refresh stage: ${cleanIdentifier(state.status.stage || "idle", 32) || "idle"}.`,
      `Recent safe topics: ${state.topics.length}.`
    ];
    for (const topic of state.topics.slice(0, 5)) {
      currentState.push(`${topic.title}${topic.conversation_starter ? ` - ${topic.conversation_starter}` : ""}`);
    }

    return {
      module_id: "news",
      enabled: true,
      current_state: cleanList(currentState, 8, 180),
      capabilities: [
        "Hoshia can use recent safe daily news topics as casual live-room conversation material.",
        "The gateway can ask the bridge to refresh topics and inspect refresh progress."
      ],
      limits: [
        "Only sanitized topic summaries and conversation starters are exposed.",
        "No source URLs, tokens, paths, internal addresses, raw logs, or provider configuration are exposed.",
        "News topics should be used as light conversation prompts, not as authoritative reporting."
      ]
    };
  }

  canRefreshToday(now = new Date()) {
    return this.refreshCountForDay(dayKey(now)) < this.config.dailyLimit;
  }

  refreshCountForDay(key = dayKey()) {
    return Number(this.refreshCounts.get(key) || 0);
  }

  recordRefresh(now = new Date()) {
    const key = dayKey(now);
    this.refreshCounts.set(key, this.refreshCountForDay(key) + 1);
  }

  safeLocalStatus() {
    return {
      enabled: this.enabled(),
      stage: "idle",
      running: false,
      stale: true,
      topic_count: 0,
      stored_count: 0,
      recent_titles: [],
      recent_signal: "",
      safe_summary: "",
      daily_refresh_count: this.refreshCountForDay(),
      daily_refresh_limit: this.config.dailyLimit
    };
  }

  setCachedTopics(topics) {
    this.cachedTopics = Array.isArray(topics) ? topics : [];
    this.cachedStatus = this.withTopicSnapshot(this.cachedStatus, this.cachedTopics);
    return this.cachedTopics;
  }

  withTopicSnapshot(status, topics = []) {
    const safeTopics = Array.isArray(topics) ? topics : [];
    const firstTopic = safeTopics.find(Boolean) || {};
    return {
      ...this.safeLocalStatus(),
      ...status,
      enabled: this.enabled(),
      topic_count: Math.max(Number(status?.topic_count || 0), safeTopics.length),
      recent_titles: safeTopics.length
        ? safeTopics.map((topic) => topic.title).filter(Boolean).slice(0, 8)
        : cleanList(status?.recent_titles, 8, 120),
      recent_signal: cleanText(firstTopic.state_signal || firstTopic.reaction_style || status?.recent_signal, 140),
      safe_summary: cleanText(firstTopic.post_seed || firstTopic.conversation_starter || status?.safe_summary, 160),
      daily_refresh_count: this.refreshCountForDay(),
      daily_refresh_limit: this.config.dailyLimit
    };
  }
}

export function createHoshiaNewsService(config, dependencies) {
  return new HoshiaNewsService(config, dependencies);
}

export function normalizeHoshiaNewsConfig(config = {}) {
  const enabled = parseBool(firstDefined(
    config.hoshiaNewsEnabled,
    config.newsEnabled,
    config.NEWS_ENABLED,
    config.HOSHIA_NEWS_ENABLED
  ), false);
  const dailyLimit = clampInt(firstDefined(
    config.hoshiaNewsDailyLimit,
    config.newsDailyLimit,
    config.hoshiaNewsPostDailyLimit,
    config.HOSHIA_NEWS_DAILY_LIMIT,
    config.HOSHIA_NEWS_POST_DAILY_LIMIT,
    config.NEWS_DAILY_LIMIT
  ), 1, 24, DEFAULT_DAILY_LIMIT);
  const maxAgeHours = firstDefined(
    config.hoshiaNewsTopicMaxAgeHours,
    config.HOSHIA_NEWS_TOPIC_MAX_AGE_HOURS
  );
  const maxAgeMinutes = clampInt(firstDefined(
    config.hoshiaNewsMaxAgeMinutes,
    config.newsMaxAgeMinutes,
    config.HOSHIA_NEWS_MAX_AGE_MINUTES,
    config.NEWS_MAX_AGE_MINUTES,
    Number.isFinite(Number(maxAgeHours)) ? Number(maxAgeHours) * 60 : undefined
  ), 5, 7 * 24 * 60, DEFAULT_MAX_AGE_MINUTES);

  return {
    enabled,
    dailyLimit,
    maxAgeMinutes,
    maxAgeMs: maxAgeMinutes * 60 * 1000,
    bridgeOptions: {
      roomId: String(config.roomId || config.ROOM_ID || "private-pixel-live").slice(0, 80),
      astrbotBridgeUrl: String(config.astrbotBridgeUrl || config.ASTRBOT_BRIDGE_URL || ""),
      astrbotBridgeToken: String(config.astrbotBridgeToken || config.ASTRBOT_BRIDGE_TOKEN || ""),
      astrbotTimeoutMs: clampInt(config.astrbotTimeoutMs || config.ASTRBOT_TIMEOUT_MS, 100, 120000, 15000)
    }
  };
}

export function sanitizeNewsStatus(value, { maxAgeMs = DEFAULT_MAX_AGE_MINUTES * 60 * 1000 } = {}) {
  const rawStage = cleanIdentifier(value?.stage, 32);
  const stage = NEWS_STAGE_ALIASES.get(rawStage) || rawStage;
  const finishedAt = cleanIsoTime(value?.finished_at);
  const startedAt = cleanIsoTime(value?.started_at);
  return {
    capability: cleanIdentifier(value?.capability, 48) || "news_topics",
    ok: Boolean(value?.ok),
    running: Boolean(value?.running),
    stage: NEWS_STAGES.has(stage) ? stage : "idle",
    started_at: startedAt,
    finished_at: finishedAt,
    stale: isStale(finishedAt || startedAt, maxAgeMs),
    latency_ms: clampInt(value?.latency_ms, 0, 10 * 60 * 1000, 0),
    topic_count: clampInt(value?.topic_count, 0, 1000, 0),
    stored_count: clampInt(value?.stored_count, 0, 1000, 0),
    recent_titles: cleanList(value?.recent_titles, 8, 120),
    recent_signal: cleanText(value?.recent_signal || value?.recentSignal, 140),
    safe_summary: cleanText(value?.safe_summary || value?.safeSummary || value?.summary, 160)
  };
}

export function sanitizeNewsTopics(value, { maxAgeMs = DEFAULT_MAX_AGE_MINUTES * 60 * 1000, limit = DEFAULT_TOPIC_LIMIT } = {}) {
  if (!Array.isArray(value)) return [];
  const topics = [];
  for (const item of value) {
    const topic = sanitizeNewsTopic(item, { maxAgeMs });
    if (!topic) continue;
    topics.push(topic);
    if (topics.length >= limit) break;
  }
  return topics;
}

export function sanitizeNewsTopic(value, { maxAgeMs = DEFAULT_MAX_AGE_MINUTES * 60 * 1000 } = {}) {
  if (!value || typeof value !== "object") return null;
  const createdAt = cleanIsoTime(value.created_at || value.create_time || value.date);
  if (createdAt && isStale(createdAt, maxAgeMs)) return null;

  const title = cleanText(value.title || value.headline || value.content, 100);
  const conversationStarter = cleanText(value.conversation_starter || value.starter, 180);
  const whatHappened = cleanText(value.what_happened || value.summary || value.content, 220);
  const postSeed = cleanText(value.post_seed || value.postSeed, 220);
  if (!title && !conversationStarter && !whatHappened && !postSeed) return null;

  return {
    title,
    what_happened: whatHappened,
    hoshia_take: cleanText(value.hoshia_take || value.take, 220),
    conversation_starter: conversationStarter,
    why_it_matters: cleanText(value.why_it_matters, 180),
    category: normalizeTopicCategory(value.category || value.source),
    meme_hooks: cleanList(value.meme_hooks || value.memeHooks, 4, 90),
    reaction_style: cleanText(value.reaction_style || value.reactionStyle, 100),
    state_signal: cleanText(value.state_signal || value.stateSignal, 140),
    post_seed: postSeed,
    reply_hooks: cleanList(value.reply_hooks || value.replyHooks, 4, 90),
    risk_level: cleanIdentifier(value.risk_level || value.riskLevel || value.risk || value.safety_risk || value.safetyRisk, 24),
    high_risk: parseBool(value.high_risk || value.highRisk, false),
    risk_note: cleanText(value.risk_note, 120),
    created_at: createdAt
  };
}

function disabledResult() {
  return {
    ok: false,
    enabled: false,
    reason: "news_disabled",
    status: {
      stage: "idle",
      running: false,
      stale: true,
      topic_count: 0,
      stored_count: 0
    }
  };
}

function bridgeUnavailableResult(status) {
  return {
    ok: false,
    enabled: true,
    reason: "news_bridge_unavailable",
    status
  };
}

function hasReactionPoint(topic) {
  return Boolean(
    topic?.reaction_style
    || topic?.state_signal
    || (Array.isArray(topic?.meme_hooks) && topic.meme_hooks.length)
    || (Array.isArray(topic?.reply_hooks) && topic.reply_hooks.length)
  );
}

function isHighRiskTopic(topic) {
  if (!topic || typeof topic !== "object") return false;
  const riskLevel = cleanIdentifier(topic.risk_level || topic.riskLevel || topic.risk || topic.safety_risk || topic.safetyRisk, 24);
  return topic.high_risk === true
    || topic.highRisk === true
    || ["high", "critical", "unsafe", "blocked", "danger"].includes(riskLevel);
}

function normalizeTopicCategory(value) {
  const category = cleanIdentifier(value, 32);
  const aliases = {
    anime: "anime_game",
    game: "anime_game",
    gaming: "anime_game",
    esports: "anime_game",
    bilibili: "light_trends",
    trend: "light_trends",
    trends: "light_trends",
    music: "music_movie",
    movie: "music_movie",
    film: "music_movie",
    entertainment: "music_movie",
    sport: "sports_campus",
    sports: "sports_campus",
    campus: "sports_campus",
    life: "sports_campus",
    tech: "tech_tools",
    tech_ai: "tech_tools",
    business: "general",
    general: "general"
  };
  return aliases[category] || (["anime_game", "music_movie", "sports_campus", "tech_tools", "light_trends", "general"].includes(category) ? category : "general");
}

function cleanList(value, maxItems, maxLength) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[|,，、]/g);
  return list
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanText(value, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text || forbiddenPattern().test(text)) return "";
  return text;
}

function cleanIdentifier(value, maxLength) {
  const text = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, maxLength);
  if (!text || forbiddenPattern().test(text)) return "";
  return text;
}

function cleanIsoTime(value) {
  const text = cleanText(value, 40);
  if (!text) return "";
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString();
}

function isStale(value, maxAgeMs) {
  if (!value) return true;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > maxAgeMs;
}

function forbiddenPattern() {
  return /(?:\.env|ssh-|BEGIN [A-Z ]*PRIVATE KEY|token=|password=|secret=|cloudflared|trycloudflare|https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|(?:\b\d{1,3}(?:\.\d{1,3}){3}\b)|[A-Za-z]:[\\/]|\/home\/|\/users\/|\/var\/|\/etc\/|internal)/i;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
