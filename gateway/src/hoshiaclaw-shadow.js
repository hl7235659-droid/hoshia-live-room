const DEFAULT_EVENT_PREFIX = "hoshiaclaw.shadow";
const DAILY_POST_EVENT_PREFIX = "hoshiaclaw.daily_post_shadow";
const NEWS_TOPIC_EVENT_PREFIX = "hoshiaclaw.news_topic_generate_shadow";
const DAILY_POST_REPLY_MODE = "daily_post_shadow";
const NEWS_TOPIC_REPLY_MODE = "news_topic_generate_shadow";

export async function runHoshiaClawShadow({
  enabled = false,
  eventPrefix = DEFAULT_EVENT_PREFIX,
  replyMode = "shadow",
  session = null,
  prompt = "",
  roomSession = null,
  config = {},
  generateAiReply,
  fetchImpl = globalThis.fetch,
  metadata = {},
  recordMetric = null,
  logger = console,
  requirePrompt = false
} = {}) {
  const safeEventPrefix = cleanEventPrefix(eventPrefix) || DEFAULT_EVENT_PREFIX;
  const safeReplyMode = cleanIdentifier(replyMode, 48) || "shadow";
  if (!enabled) return { status: "disabled", called: false };

  const safePrompt = cleanPrompt(prompt);
  if (!session || typeof generateAiReply !== "function") {
    const result = shadowResult(safeEventPrefix, "skip", {
      reason: "missing_dependency",
      source: "gateway"
    });
    recordShadowMetric(recordMetric, result, safeReplyMode);
    return result;
  }
  if (requirePrompt && !safePrompt) {
    const result = shadowResult(safeEventPrefix, "skip", {
      reason: "missing_prompt",
      source: "gateway"
    });
    recordShadowMetric(recordMetric, result, safeReplyMode);
    return result;
  }

  try {
    const reply = await generateAiReply(roomSession || shadowRoomSession(session, config), safePrompt, {
      ...config,
      aiMode: "hoshiaclaw",
      fallbackToMock: false,
      hoshiaClawFallbackToMock: false,
      hoshiaclawFallbackToMock: false,
      streamingEnabled: false,
      hoshiaClawStreamingEnabled: false,
      hoshiaclawStreamingEnabled: false
    }, fetchImpl, {
      ...metadata,
      roomSession: true,
      forceReply: true,
      replyMode: safeReplyMode,
      onDelta: null
    });

    const result = classifyHoshiaClawShadowReply(reply, {
      eventPrefix: safeEventPrefix,
      fallbackReason: safeReplyMode
    });
    recordShadowMetric(recordMetric, result, safeReplyMode);
    return result;
  } catch (error) {
    const result = shadowResult(safeEventPrefix, "failed", {
      reason: cleanMetricReason(error?.message) || "shadow_failed",
      source: "gateway"
    });
    logger.warn?.("hoshiaclaw_shadow_failed", {
      type: cleanIdentifier(error?.name || "Error", 48) || "Error",
      message: cleanMetricReason(error?.message) || "shadow_failed",
      reply_mode: safeReplyMode
    });
    recordShadowMetric(recordMetric, result, safeReplyMode);
    return result;
  }
}

export async function runDailyPostShadow({
  prompt = "",
  postInput = null,
  state = null,
  reason = "daily_post",
  dailyPostEnabled = true,
  dailyPostPlan = null,
  dailyPostService = null,
  planDailyPost = null,
  planOptions = {},
  ...options
} = {}) {
  if (!dailyPostEnabled) {
    const result = shadowResult(DAILY_POST_EVENT_PREFIX, "skip", {
      reason: "daily_post_disabled",
      source: "gateway"
    });
    recordShadowMetric(options.recordMetric, result, DAILY_POST_REPLY_MODE);
    return result;
  }
  let safePostInput = postInput;
  let safeState = state;
  let skipReason = "daily_post_shadow_no_candidate";
  if (!prompt) {
    try {
      const plan = resolveDailyPostShadowPlan({
        postInput,
        state,
        dailyPostPlan,
        dailyPostService,
        planDailyPost,
        planOptions
      });
      safePostInput = plan.postInput;
      safeState = plan.state;
      skipReason = plan.skipReason;
    } catch (error) {
      const result = shadowResult(DAILY_POST_EVENT_PREFIX, "failed", {
        reason: cleanMetricReason(error?.message) || "shadow_failed",
        source: "gateway"
      });
      options.logger?.warn?.("hoshiaclaw_daily_post_shadow_plan_failed", {
        type: cleanIdentifier(error?.name || "Error", 48) || "Error",
        message: cleanMetricReason(error?.message) || "shadow_failed",
        reply_mode: DAILY_POST_REPLY_MODE
      });
      recordShadowMetric(options.recordMetric, result, DAILY_POST_REPLY_MODE);
      return result;
    }
    if (!hasDailyPostShadowCandidate(safePostInput)) {
      const result = shadowResult(DAILY_POST_EVENT_PREFIX, "skip", {
        reason: skipReason,
        source: "gateway"
      });
      recordShadowMetric(options.recordMetric, result, DAILY_POST_REPLY_MODE);
      return result;
    }
  }
  return runHoshiaClawShadow({
    ...options,
    eventPrefix: DAILY_POST_EVENT_PREFIX,
    replyMode: DAILY_POST_REPLY_MODE,
    prompt: prompt || buildDailyPostShadowPrompt({ postInput: safePostInput, state: safeState, reason }),
    requirePrompt: true
  });
}

export function dailyPostShadowPreflightSkipReason({
  shadowEnabled = false,
  dailyPostEnabled = true,
  force = false
} = {}) {
  if (!shadowEnabled) return "daily_post_shadow_disabled";
  if (!force && !dailyPostEnabled) return "daily_post_disabled";
  return "";
}

export async function runNewsTopicGenerateShadow({
  prompt = "",
  topic = null,
  state = null,
  reason = "news_topic_generate",
  ...options
} = {}) {
  if (!hasNewsTopicShadowCandidate(topic)) {
    const result = shadowResult(NEWS_TOPIC_EVENT_PREFIX, "skip", {
      reason: hasNewsTopicInput(topic) ? "news_topic_shadow_unsafe_topic" : "news_topic_shadow_no_topic",
      source: "gateway"
    });
    recordShadowMetric(options.recordMetric, result, NEWS_TOPIC_REPLY_MODE);
    return result;
  }
  return runHoshiaClawShadow({
    ...options,
    eventPrefix: NEWS_TOPIC_EVENT_PREFIX,
    replyMode: NEWS_TOPIC_REPLY_MODE,
    prompt: prompt || buildNewsTopicGenerateShadowPrompt({ topic, state, reason }),
    requirePrompt: true
  });
}

export function classifyHoshiaClawShadowReply(reply = {}, {
  eventPrefix = DEFAULT_EVENT_PREFIX,
  fallbackReason = "shadow"
} = {}) {
  const safeEventPrefix = cleanEventPrefix(eventPrefix) || DEFAULT_EVENT_PREFIX;
  const source = cleanMetricSource(reply?.source) || "hoshiaclaw";
  const latencyMs = safeNumber(reply?.latency_ms);
  if (reply?.skipped) {
    return shadowResult(safeEventPrefix, "skip", {
      reason: cleanMetricReason(reply?.error || reply?.judge?.reason || reply?.route) || "skipped",
      source,
      latencyMs
    });
  }
  if (!hasReplyText(reply) || source === "gateway_error") {
    return shadowResult(safeEventPrefix, "failed", {
      reason: cleanMetricReason(reply?.error || reply?.route) || "empty_or_error_reply",
      source,
      latencyMs
    });
  }
  return shadowResult(safeEventPrefix, "success", {
    reason: cleanMetricReason(reply?.route) || cleanMetricReason(fallbackReason) || "candidate_generated",
    source,
    latencyMs
  });
}

export const classifyShadowReply = classifyHoshiaClawShadowReply;

export function buildDailyPostShadowPrompt({ postInput = null, state = null, reason = "daily_post" } = {}) {
  const safePost = postInput && typeof postInput === "object" ? postInput : {};
  const safeState = state && typeof state === "object" ? state : {};
  const lines = [
    "Shadow-check this Hoshia daily timeline post candidate. Do not publish or store it.",
    "Return only a concise candidate or an explicit skip decision for gateway evaluation.",
    `reply_mode: ${DAILY_POST_REPLY_MODE}`,
    `reason: ${cleanIdentifier(reason, 48) || "daily_post"}`,
    `source_type: ${cleanIdentifier(safePost.source_type, 48) || "daily_state"}`,
    `activity: ${cleanIdentifier(safePost.activity || safeState.activity, 48) || "idle"}`,
    `mood: ${cleanIdentifier(safePost.mood || safeState.mood, 48) || "calm"}`
  ];
  const content = cleanPromptLine(safePost.content, 900);
  if (content) lines.push(`candidate_post: ${content}`);
  return lines.filter(Boolean).join("\n");
}

export function buildNewsTopicGenerateShadowPrompt({ topic = null, state = null, reason = "news_topic_generate" } = {}) {
  const safeTopic = sanitizeTopicForPrompt(topic);
  if (!safeTopic) return "";
  const safeState = state && typeof state === "object" ? state : {};
  const lines = [
    "Shadow-generate a Hoshia-style casual live-room take from this provided news topic only.",
    "Do not refresh, browse, list topics, publish, or store the generated candidate.",
    `reply_mode: ${NEWS_TOPIC_REPLY_MODE}`,
    `reason: ${cleanIdentifier(reason, 48) || "news_topic_generate"}`,
    `category: ${safeTopic.category || "general"}`,
    `activity: ${cleanIdentifier(safeState.activity, 48) || "idle"}`,
    `mood: ${cleanIdentifier(safeState.mood, 48) || "calm"}`,
    `topic_title: ${safeTopic.title || "untitled"}`,
    `topic_seed: ${safeTopic.post_seed || safeTopic.conversation_starter || safeTopic.what_happened}`
  ];
  if (safeTopic.reaction_style) lines.push(`reaction_style: ${safeTopic.reaction_style}`);
  if (safeTopic.meme_hooks.length) lines.push(`meme_hooks: ${safeTopic.meme_hooks.join(" | ")}`);
  if (safeTopic.reply_hooks.length) lines.push(`reply_hooks: ${safeTopic.reply_hooks.join(" | ")}`);
  return lines.filter(Boolean).join("\n");
}

function shadowResult(eventPrefix, status, { reason = "", source = "", latencyMs = undefined } = {}) {
  return {
    called: true,
    eventType: `${eventPrefix}.${status === "failed" ? "failed" : status}`,
    status,
    reason: cleanMetricReason(reason) || status,
    source: cleanMetricSource(source) || "gateway",
    ...(latencyMs !== undefined ? { latencyMs } : {})
  };
}

function recordShadowMetric(recordMetric, result, replyMode) {
  if (typeof recordMetric !== "function" || !result?.eventType) return;
  recordMetric({
    eventType: result.eventType,
    status: result.status,
    reason: result.reason,
    source: result.source,
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {})
  });
}

function resolveDailyPostShadowPlan({
  postInput = null,
  state = null,
  dailyPostPlan = null,
  dailyPostService = null,
  planDailyPost = null,
  planOptions = {}
} = {}) {
  if (postInput && typeof postInput === "object") {
    return {
      postInput,
      state,
      skipReason: "daily_post_shadow_no_candidate"
    };
  }

  const providedPlan = dailyPostPlan && typeof dailyPostPlan === "object" ? dailyPostPlan : null;
  const planner = typeof planDailyPost === "function"
    ? planDailyPost
    : (typeof dailyPostService?.planDailyPost === "function" ? dailyPostService.planDailyPost.bind(dailyPostService) : null);
  const plan = providedPlan || (planner ? planner(safeObject(planOptions)) : null);
  return {
    postInput: plan?.postInput && typeof plan.postInput === "object" ? plan.postInput : null,
    state: plan?.state && typeof plan.state === "object" ? plan.state : state,
    skipReason: cleanMetricReason(plan?.reason) || "daily_post_shadow_no_candidate"
  };
}

function shadowRoomSession(session = {}, config = {}) {
  return {
    user_id: "room",
    username: "room",
    nickname: "Live room",
    room_id: cleanIdentifier(session.room_id || config.roomId, 80) || ""
  };
}

function sanitizeTopicForPrompt(topic) {
  if (!topic || typeof topic !== "object") return null;
  const title = cleanPromptLine(topic.title || topic.headline, 120);
  const whatHappened = cleanPromptLine(topic.what_happened || topic.summary, 220);
  const conversationStarter = cleanPromptLine(topic.conversation_starter || topic.starter, 180);
  const postSeed = cleanPromptLine(topic.post_seed || topic.postSeed, 220);
  if (!title && !whatHappened && !conversationStarter && !postSeed) return null;
  return {
    title,
    what_happened: whatHappened,
    conversation_starter: conversationStarter,
    post_seed: postSeed,
    category: cleanIdentifier(topic.category || "general", 32) || "general",
    reaction_style: cleanPromptLine(topic.reaction_style || topic.reactionStyle, 100),
    meme_hooks: cleanPromptList(topic.meme_hooks || topic.memeHooks, 4, 90),
    reply_hooks: cleanPromptList(topic.reply_hooks || topic.replyHooks, 4, 90)
  };
}

function hasDailyPostShadowCandidate(postInput) {
  if (!postInput || typeof postInput !== "object") return false;
  return Boolean(cleanPromptLine(postInput.content, 900));
}

function hasNewsTopicShadowCandidate(topic) {
  return Boolean(sanitizeTopicForPrompt(topic));
}

function hasNewsTopicInput(topic) {
  if (!topic || typeof topic !== "object") return false;
  const values = [
    topic.title,
    topic.headline,
    topic.what_happened,
    topic.summary,
    topic.conversation_starter,
    topic.starter,
    topic.post_seed,
    topic.postSeed,
    topic.reaction_style,
    topic.reactionStyle,
    ...(Array.isArray(topic.meme_hooks) ? topic.meme_hooks : []),
    ...(Array.isArray(topic.memeHooks) ? topic.memeHooks : []),
    ...(Array.isArray(topic.reply_hooks) ? topic.reply_hooks : []),
    ...(Array.isArray(topic.replyHooks) ? topic.replyHooks : [])
  ];
  return values.some((value) => String(value || "").trim());
}

function cleanPrompt(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .trim()
    .slice(0, 4000);
}

function cleanPromptLine(value, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text || forbiddenPattern().test(text)) return "";
  return text;
}

function cleanPromptList(value, maxItems, maxLength) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[|,]/g);
  return items
    .map((item) => cleanPromptLine(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanEventPrefix(value) {
  const text = cleanIdentifier(value, 96);
  return text.startsWith("hoshiaclaw.") ? text : "";
}

function cleanMetricReason(value) {
  const raw = String(value || "").trim();
  if (forbiddenPattern().test(raw)) return "";
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(raw)) return "";
  const text = cleanIdentifier(raw, 80);
  return /[a-z0-9]/i.test(text) ? text : "";
}

function cleanMetricSource(value) {
  const raw = String(value || "").trim();
  if (forbiddenPattern().test(raw)) return "";
  return cleanIdentifier(raw, 80);
}

function cleanIdentifier(value, maxLength) {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLength);
  if (!text || forbiddenPattern().test(text)) return "";
  return text;
}

function hasReplyText(reply) {
  return String(reply?.text || "").trim().length > 0;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

function forbiddenPattern() {
  return /(?:token|secret|bearer|\.env|ssh|cloudflared|trycloudflare|https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|(?:\b\d{1,3}(?:\.\d{1,3}){3}\b)|\b[A-Za-z]:(?:[\\/]|_)|\/home\/|\/root\/|\/users\/|\/var\/|\/etc\/|\/tmp\/|internal)/i;
}
