export const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: required("SESSION_SECRET"),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 43200),
  cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
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
  aiMode: enumValue(process.env.AI_MODE || "mock", ["mock", "astrbot"], "mock"),
  astrbotBridgeUrl: process.env.ASTRBOT_BRIDGE_URL || "",
  astrbotBridgeToken: process.env.ASTRBOT_BRIDGE_TOKEN || "",
  astrbotTimeoutMs: Number(process.env.ASTRBOT_TIMEOUT_MS || 15000),
  astrbotFallbackToMock: parseBool(process.env.ASTRBOT_FALLBACK_TO_MOCK, true),
  singleUserDirectReplyEnabled: parseBool(process.env.SINGLE_USER_DIRECT_REPLY_ENABLED, true),
  singleUserReplyDelayMs: Number(process.env.SINGLE_USER_REPLY_DELAY_MS || 600),
  shortTermContextMaxMessages: Number(process.env.SHORT_TERM_CONTEXT_MAX_MESSAGES || 100),
  contextSummaryLookbackMessages: Number(process.env.CONTEXT_SUMMARY_LOOKBACK_MESSAGES || 600),
  contextSummaryCompressMessages: Number(process.env.CONTEXT_SUMMARY_COMPRESS_MESSAGES || 20),
  realityContextEnabled: parseBool(process.env.REALITY_CONTEXT_ENABLED, true),
  realityContextTimezone: process.env.REALITY_CONTEXT_TIMEZONE || "Asia/Shanghai",
  realityContextIncludeOps: parseBool(process.env.REALITY_CONTEXT_INCLUDE_OPS, true)
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
