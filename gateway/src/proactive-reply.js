const defaultMinIdleSeconds = 300;
const defaultMaxIdleSeconds = 900;

export function normalizeProactiveReplyConfig(env = process.env) {
  const minIdleSeconds = clampInt(env.PROACTIVE_REPLY_MIN_IDLE_SECONDS, defaultMinIdleSeconds, 60, 86400);
  const maxIdleSeconds = Math.max(
    minIdleSeconds,
    clampInt(env.PROACTIVE_REPLY_MAX_IDLE_SECONDS, defaultMaxIdleSeconds, 60, 86400)
  );
  return {
    enabled: parseBool(env.PROACTIVE_REPLY_ENABLED, false),
    minIdleSeconds,
    maxIdleSeconds,
    maxUnanswered: clampInt(env.PROACTIVE_REPLY_MAX_UNANSWERED, 3, 1, 20),
    contextMessages: clampInt(env.PROACTIVE_REPLY_CONTEXT_MESSAGES, 24, 5, 100)
  };
}

export function normalizeProactiveLiveConfig(env = process.env) {
  return {
    enabled: parseBool(env.HOSHIACLAW_PROACTIVE_LIVE_ENABLED, false),
    percent: clampInt(env.HOSHIACLAW_PROACTIVE_LIVE_PERCENT, 0, 0, 100)
  };
}

export function createProactiveReplyState(now = Date.now()) {
  return {
    lastUserMessageAtMs: now,
    lastProactiveAtMs: 0,
    unansweredCount: 0,
    generating: false,
    timer: null,
    nextDueAtMs: 0,
    nextDelayMs: 0,
    recentTexts: []
  };
}

export function nextProactiveDelayMs(settings, random = Math.random) {
  const minMs = Math.max(0, Number(settings?.minIdleSeconds || defaultMinIdleSeconds) * 1000);
  const maxMs = Math.max(minMs, Number(settings?.maxIdleSeconds || defaultMaxIdleSeconds) * 1000);
  if (maxMs === minMs) return minMs;
  return Math.floor(minMs + random() * (maxMs - minMs));
}

export function shouldRunProactiveReply({
  settings,
  state,
  now = Date.now(),
  onlineCount = 0,
  pendingReplyCount = 0,
  replyBatchRunning = false
} = {}) {
  if (!settings?.enabled) return { ok: false, reason: "disabled" };
  if (!onlineCount) return { ok: false, reason: "no_online_users" };
  if (state?.generating) return { ok: false, reason: "already_generating" };
  if (replyBatchRunning) return { ok: false, reason: "reply_batch_running" };
  if (pendingReplyCount > 0) return { ok: false, reason: "pending_user_messages" };
  if (Number(state?.unansweredCount || 0) >= Number(settings.maxUnanswered || 0)) {
    return { ok: false, reason: "max_unanswered" };
  }
  if (Number(state?.nextDueAtMs || 0) && now < state.nextDueAtMs) {
    return { ok: false, reason: "not_due" };
  }
  const idleMs = now - Number(state?.lastUserMessageAtMs || now);
  const minIdleMs = Number(settings.minIdleSeconds || defaultMinIdleSeconds) * 1000;
  if (idleMs < minIdleMs) return { ok: false, reason: "not_idle_enough" };
  return { ok: true, reason: "ready", idleMs };
}

export function rememberProactiveReply(state, text, now = Date.now(), limit = 5) {
  state.lastProactiveAtMs = now;
  state.unansweredCount += 1;
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  state.recentTexts.unshift(cleaned.slice(0, 160));
  state.recentTexts.splice(Math.max(1, limit));
}

export function markUserActivityForProactive(state, now = Date.now()) {
  state.lastUserMessageAtMs = now;
  state.unansweredCount = 0;
}

export function shouldRunHoshiaClawProactiveLive({
  config = {},
  session = null,
  bucketKey = ""
} = {}) {
  if (config.aiMode !== "hoshiaclaw") return { ok: false, reason: "ai_mode_not_hoshiaclaw" };
  if (!config.hoshiaClawProactiveLiveEnabled) return { ok: false, reason: "proactive_live_disabled" };
  const percent = clampInt(config.hoshiaClawProactiveLivePercent, 0, 0, 100);
  if (percent <= 0) return { ok: false, reason: "proactive_live_percent_zero" };
  if (percent >= 100) return { ok: true, reason: "proactive_live_enabled", bucket: 0 };
  const key = bucketKey || `${config.roomId || "room"}:${session?.user_id || session?.nickname || "anonymous"}`;
  const bucket = stablePercentBucket(key);
  if (bucket >= percent) return { ok: false, reason: "proactive_live_bucket_miss", bucket };
  return { ok: true, reason: "proactive_live_enabled", bucket };
}

export function stablePercentBucket(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

function clampInt(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
