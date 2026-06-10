import { dayKeyFor } from "./hoshia-daily-post.js";

const characterId = "hoshia";
const defaultTimeZone = "Asia/Shanghai";
const sensitivePattern = /(?:https?:\/\/|www\.|\.env\b|token\b|api[_-]?key|authorization:|bearer\s+|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|rsshub|tavily|cloudflared|trycloudflare|localhost|[A-Za-z]:[\\/]|\/home\/ubuntu|\/app\/data|\b\d{1,3}(?:\.\d{1,3}){3}\b)/i;

export function buildHoshiaOpsSummary({
  db,
  visualState = null,
  newsStatus = null,
  config = {},
  now = new Date(),
  timeZone = defaultTimeZone,
  targetCharacterId = characterId
} = {}) {
  if (!db) throw new Error("db is required");
  const currentNow = asDate(now);
  const currentDayKey = dayKeyFor(currentNow, timeZone || defaultTimeZone);
  const postCounts = typeof db.countHoshiaPostsForDay === "function"
    ? db.countHoshiaPostsForDay({ now: currentNow, timeZone, characterId: targetCharacterId })
    : { day_key: currentDayKey, total: 0, by_source: {} };
  const replyCounts = typeof db.countHoshiaRepliesForDay === "function"
    ? db.countHoshiaRepliesForDay({ now: currentNow, timeZone, characterId: targetCharacterId })
    : { day_key: currentDayKey, total: 0 };
  const replyStatusCounts = typeof db.countHoshiaCommentReplyStatuses === "function"
    ? db.countHoshiaCommentReplyStatuses({ characterId: targetCharacterId })
    : {};
  const safeState = sanitizeVisualState(visualState);
  const safeNews = sanitizeNewsStatus({
    status: newsStatus,
    config,
    newsPostCountToday: Number(
      postCounts.by_source?.daily_news
      || postCounts.by_source?.hoshia_news
      || postCounts.by_source?.news
      || postCounts.by_source?.news_topic
      || 0
    )
  });

  return {
    day_key: currentDayKey,
    generated_post_count: Number(postCounts.total || 0),
    daily_state_count: Number(postCounts.by_source?.daily_state || 0),
    state_pulse_count: Number(postCounts.by_source?.state_pulse || 0),
    reply_processed_today: Number(replyCounts.total || 0),
    pending_comment_count: Number(replyStatusCounts.pending || 0),
    failed_comment_count: Number(replyStatusCounts.failed || 0),
    skipped_comment_count: Number(replyStatusCounts.skipped || 0),
    visual_state: safeState,
    state_summary: stateSummaryFor(safeState),
    news: safeNews,
    limits: {
      daily_post_enabled: Boolean(config.hoshiaDailyPostEnabled),
      daily_min: Number(config.hoshiaDailyPostMin || 0),
      daily_max: Number(config.hoshiaDailyPostMax || 0),
      post_min_interval_minutes: Number(config.hoshiaStatePostMinIntervalMinutes || 0),
      post_active_window_start: safeText(config.hoshiaStatePostActiveWindowStart, 16),
      post_active_window_end: safeText(config.hoshiaStatePostActiveWindowEnd, 16),
      async_comment_reply_enabled: Boolean(config.hoshiaAsyncCommentReplyEnabled),
      comment_reply_tick_limit: Number(config.hoshiaCommentReplyTickLimit || 0),
      comment_reply_daily_limit: Number(config.hoshiaCommentReplyDailyLimit || 0),
      comment_reply_min_delay_minutes: Number(config.hoshiaCommentReplyMinDelayMinutes || 0),
      comment_reply_max_delay_minutes: Number(config.hoshiaCommentReplyMaxDelayMinutes || 0),
      state_tick_min_minutes: Number(config.hoshiaStateTickMinMinutes || 0),
      state_tick_max_minutes: Number(config.hoshiaStateTickMaxMinutes || 0)
    }
  };
}

function sanitizeNewsStatus({ status = {}, config = {}, newsPostCountToday = 0 } = {}) {
  const raw = status && typeof status === "object" ? status : {};
  const recentTitles = Array.isArray(raw.recent_titles)
    ? raw.recent_titles
    : Array.isArray(raw.recentTitles)
      ? raw.recentTitles
      : Array.isArray(raw.topics)
        ? raw.topics.map((topic) => topic?.title || topic)
        : [];
  return {
    enabled: Boolean(raw.enabled ?? config.hoshiaNewsEnabled),
    running: Boolean(raw.running),
    stage: safeIdentifier(raw.stage || "idle", 40) || "idle",
    topic_count: clampNumber(raw.topic_count ?? raw.topicCount ?? recentTitles.length, 0, 100, 0),
    recent_titles: cleanTextList(recentTitles, 5, 100),
    recent_signal: safeText(raw.recent_signal ?? raw.recentSignal, 140),
    news_post_count_today: clampNumber(newsPostCountToday, 0, 100, 0)
  };
}

function sanitizeVisualState(input = {}) {
  const safeInput = input && typeof input === "object" ? input : {};
  return {
    mood: safeText(safeInput.mood, 32) || "calm",
    activity: safeText(safeInput.activity, 32) || "idle",
    energy: clampNumber(safeInput.energy, 0, 100, 0),
    social_need: clampNumber(safeInput.social_need, 0, 100, 0),
    visual_description: safeText(safeInput.visual_description, 220),
    state_reason: safeText(safeInput.state_reason, 160),
    updated_at: safeText(safeInput.updated_at, 40)
  };
}

function stateSummaryFor(state) {
  const reason = state.state_reason ? `, reason ${state.state_reason}` : "";
  return `${state.activity}/${state.mood}, energy ${state.energy}, social ${state.social_need}${reason}`.slice(0, 220);
}

function safeText(value, max = 120) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text || sensitivePattern.test(text)) return "";
  return text.slice(0, max);
}

function cleanTextList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeIdentifier(value, max = 40) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}
