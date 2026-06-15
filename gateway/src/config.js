import { normalizeProactiveLiveConfig, normalizeProactiveReplyConfig } from "./proactive-reply.js";

export const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: required("SESSION_SECRET"),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 43200),
  cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: parseBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || ""
  },
  registerCodeTtlSeconds: Number(process.env.REGISTER_CODE_TTL_SECONDS || 600),
  registerCodeCooldownSeconds: Number(process.env.REGISTER_CODE_COOLDOWN_SECONDS || 60),
  inviteCodeHashes: split(process.env.INVITE_CODE_HASHES),
  roomTokenHashes: split(process.env.ROOM_TOKEN_HASHES || process.env.INVITE_CODE_HASHES),
  sqliteDbPath: process.env.SQLITE_DB_PATH || "./data/live-room.sqlite",
  allowedNicknames: split(process.env.ALLOWED_NICKNAMES),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379/0",
  roomId: process.env.ROOM_ID || "private-pixel-live",
  adminQqId: process.env.ADMIN_QQ_ID || "",
  maxMessageLength: Number(process.env.MAX_MESSAGE_LENGTH || 500),
  rateWindowSeconds: Number(process.env.MESSAGE_RATE_LIMIT_WINDOW_SECONDS || 10),
  rateLimitCount: Number(process.env.MESSAGE_RATE_LIMIT_COUNT || 8),
  aiMode: enumValue(process.env.AI_MODE || "mock", ["mock", "astrbot", "hoshiaclaw"], "mock"),
  astrbotBridgeUrl: process.env.ASTRBOT_BRIDGE_URL || "",
  astrbotBridgeToken: process.env.ASTRBOT_BRIDGE_TOKEN || "",
  astrbotTimeoutMs: Number(process.env.ASTRBOT_TIMEOUT_MS || 45000),
  astrbotFallbackToMock: parseBool(process.env.ASTRBOT_FALLBACK_TO_MOCK, true),
  astrbotStreamingEnabled: parseBool(process.env.ASTRBOT_STREAMING_ENABLED, true),
  hoshiaClawBridgeUrl: process.env.HOSHIACLAW_BRIDGE_URL || "",
  hoshiaClawBridgeToken: process.env.HOSHIACLAW_TOKEN || "",
  hoshiaClawTimeoutMs: Number(process.env.HOSHIACLAW_TIMEOUT_MS || 45000),
  hoshiaClawFallbackToMock: parseBool(process.env.HOSHIACLAW_FALLBACK_TO_MOCK, true),
  hoshiaClawStreamingEnabled: parseBool(process.env.HOSHIACLAW_STREAMING_ENABLED, true),
  hoshiaClawProactiveShadowEnabled: parseBool(process.env.HOSHIACLAW_PROACTIVE_SHADOW_ENABLED, false),
  ...proactiveLiveSettings(process.env),
  hoshiaClawDailyPostShadowEnabled: parseBool(process.env.HOSHIACLAW_DAILY_POST_SHADOW_ENABLED, false),
  hoshiaClawNewsTopicGenerateShadowEnabled: parseBool(process.env.HOSHIACLAW_NEWS_TOPIC_GENERATE_SHADOW_ENABLED, false),
  hoshiaClawDailyPostLiveEnabled: parseBool(process.env.HOSHIACLAW_DAILY_POST_LIVE_ENABLED, false),
  hoshiaClawNewsTopicLiveEnabled: parseBool(process.env.HOSHIACLAW_NEWS_TOPIC_LIVE_ENABLED, false),
  characterStateAuthority: enumValue(process.env.CHARACTER_STATE_AUTHORITY || "legacy", ["legacy", "event_log"], "legacy"),
  singleUserDirectReplyEnabled: parseBool(process.env.SINGLE_USER_DIRECT_REPLY_ENABLED, true),
  singleUserReplyDelayMs: Number(process.env.SINGLE_USER_REPLY_DELAY_MS || 600),
  shortTermContextMaxMessages: Number(process.env.SHORT_TERM_CONTEXT_MAX_MESSAGES || 100),
  contextSummaryLookbackMessages: Number(process.env.CONTEXT_SUMMARY_LOOKBACK_MESSAGES || 600),
  contextSummaryCompressMessages: Number(process.env.CONTEXT_SUMMARY_COMPRESS_MESSAGES || 20),
  realityContextEnabled: parseBool(process.env.REALITY_CONTEXT_ENABLED, true),
  realityContextTimezone: process.env.REALITY_CONTEXT_TIMEZONE || "Asia/Shanghai",
  realityContextIncludeOps: parseBool(process.env.REALITY_CONTEXT_INCLUDE_OPS, true),
  welcomeGreetingEnabled: parseBool(process.env.WELCOME_GREETING_ENABLED, true),
  welcomeGreetingCooldownSeconds: Number(process.env.WELCOME_GREETING_COOLDOWN_SECONDS || 1800),
  welcomeGreetingDelayMs: Number(process.env.WELCOME_GREETING_DELAY_MS || 900),
  proactiveReply: normalizeProactiveReplyConfig(process.env),
  hoshiaStateTickMinMinutes: Number(process.env.HOSHIA_STATE_TICK_MIN_MINUTES || process.env.HOSHIA_STATE_TICK_MINUTES || 20),
  hoshiaStateTickMaxMinutes: Number(process.env.HOSHIA_STATE_TICK_MAX_MINUTES || process.env.HOSHIA_STATE_TICK_MINUTES || 60),
  hoshiaAsyncCommentReplyEnabled: parseBool(process.env.HOSHIA_ASYNC_COMMENT_REPLY_ENABLED, true),
  hoshiaCommentReplyRolloutMode: enumValue(process.env.HOSHIA_COMMENT_REPLY_ROLLOUT_MODE || "off", ["live", "shadow", "off"], "off"),
  hoshiaCommentReplyGreyPercent: clampNumber(process.env.HOSHIA_COMMENT_REPLY_GREY_PERCENT, 0, 100, 100),
  hoshiaCommentReplyMinDelayMinutes: Number(process.env.HOSHIA_COMMENT_REPLY_MIN_DELAY_MINUTES || 3),
  hoshiaCommentReplyMaxDelayMinutes: Number(process.env.HOSHIA_COMMENT_REPLY_MAX_DELAY_MINUTES || 45),
  hoshiaCommentReplyTickLimit: Number(process.env.HOSHIA_COMMENT_REPLY_TICK_LIMIT || 2),
  hoshiaCommentReplyDailyLimit: Number(process.env.HOSHIA_COMMENT_REPLY_DAILY_LIMIT || 20),
  hoshiaDailyPostEnabled: parseBool(process.env.HOSHIA_DAILY_POST_ENABLED, true),
  hoshiaDailyPostMin: Number(process.env.HOSHIA_DAILY_POST_MIN || 1),
  hoshiaDailyPostMax: Number(process.env.HOSHIA_DAILY_POST_MAX || process.env.HOSHIA_DAILY_POST_LIMIT || 5),
  hoshiaStatePostMinIntervalMinutes: Number(process.env.HOSHIA_STATE_POST_MIN_INTERVAL_MINUTES || 90),
  hoshiaStatePostActiveWindowStart: process.env.HOSHIA_STATE_POST_ACTIVE_WINDOW_START || "08:00",
  hoshiaStatePostActiveWindowEnd: process.env.HOSHIA_STATE_POST_ACTIVE_WINDOW_END || "23:50",
  hoshiaNewsEnabled: parseBool(process.env.HOSHIA_NEWS_ENABLED, true),
  hoshiaNewsPostEnabled: parseBool(process.env.HOSHIA_NEWS_POST_ENABLED, true),
  hoshiaNewsPostDailyLimit: Number(process.env.HOSHIA_NEWS_POST_DAILY_LIMIT || 1),
  hoshiaNewsSignalTtlHours: Number(process.env.HOSHIA_NEWS_SIGNAL_TTL_HOURS || 6),
  hoshiaNewsTopicMaxAgeHours: Number(process.env.HOSHIA_NEWS_TOPIC_MAX_AGE_HOURS || 36),
  hoshiaNewsBridgeMode: enumValue(process.env.HOSHIA_NEWS_BRIDGE_MODE || "", ["", "mock", "astrbot", "hoshiaclaw"], ""),
  musicEnabled: parseBool(process.env.MUSIC_ENABLED, false),
  musicProvider: enumValue(process.env.MUSIC_PROVIDER || "xiaomusic", ["xiaomusic"], "xiaomusic"),
  musicProviderBaseUrl: process.env.MUSIC_PROVIDER_BASE_URL || "",
  musicAdminUsernames: split(process.env.MUSIC_ADMIN_USERNAMES).map((item) => item.toLowerCase()),
  musicQueueMax: Number(process.env.MUSIC_QUEUE_MAX || 20),
  musicRequestWindowSeconds: Number(process.env.MUSIC_REQUEST_RATE_LIMIT_WINDOW_SECONDS || 60),
  musicRequestLimitCount: Number(process.env.MUSIC_REQUEST_RATE_LIMIT_COUNT || 3),
  musicProviderTimeoutMs: Number(process.env.MUSIC_PROVIDER_TIMEOUT_MS || 12000),
  musicXiaomusicSearchChain: process.env.MUSIC_XIAOMUSIC_SEARCH_CHAIN || "musicfree:QQMusicVIP,lx:tx,musicfree:all"
};

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith("change-me")) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function split(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function proactiveLiveSettings(env) {
  const live = normalizeProactiveLiveConfig(env);
  return {
    hoshiaClawProactiveLiveEnabled: live.enabled,
    hoshiaClawProactiveLivePercent: live.percent
  };
}
