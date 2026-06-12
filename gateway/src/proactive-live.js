const PROACTIVE_LIVE_PREFIX = "hoshiaclaw.proactive_live";
const PROACTIVE_LIVE_REPLY_MODE = "proactive_idle_live";

export async function runHoshiaClawProactiveLive({
  enabled = false,
  session = null,
  prompt = "",
  roomSession = null,
  config = {},
  generateAiReply,
  fetchImpl = globalThis.fetch,
  metadata = {},
  recordMetric = null,
  logger = console
} = {}) {
  if (!enabled) return { status: "disabled", called: false };
  if (!session || typeof generateAiReply !== "function") {
    const result = proactiveLiveResult("skip", { reason: "missing_dependency", source: "gateway" });
    recordProactiveLiveMetric(recordMetric, result);
    return result;
  }

  const safePrompt = String(prompt || "").trim();
  if (!safePrompt) {
    const result = proactiveLiveResult("skip", { reason: "missing_prompt", source: "gateway" });
    recordProactiveLiveMetric(recordMetric, result);
    return result;
  }

  try {
    const reply = await generateAiReply(roomSession || proactiveRoomSession(session, config), safePrompt, {
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
      replyMode: PROACTIVE_LIVE_REPLY_MODE,
      onDelta: null
    });

    const result = classifyProactiveLiveReply(reply);
    recordProactiveLiveMetric(recordMetric, result);
    return result;
  } catch (error) {
    const result = proactiveLiveResult("failed", {
      reason: cleanMetricReason(error?.message) || "proactive_live_failed",
      source: "gateway"
    });
    logger.warn?.("hoshiaclaw_proactive_live_failed", {
      type: cleanMetricText(error?.name || "Error", 48) || "Error",
      message: result.reason,
      reply_mode: PROACTIVE_LIVE_REPLY_MODE
    });
    recordProactiveLiveMetric(recordMetric, result);
    return result;
  }
}

export function classifyProactiveLiveReply(reply = {}) {
  const source = cleanMetricSource(reply?.source) || "hoshiaclaw";
  const latencyMs = safeNumber(reply?.latency_ms);
  if (reply?.skipped) {
    return proactiveLiveResult("skip", {
      reason: cleanMetricReason(reply?.error || reply?.judge?.reason || reply?.route) || "skipped",
      source,
      latencyMs
    });
  }
  if (!String(reply?.text || "").trim()) {
    return proactiveLiveResult("failed", {
      reason: cleanMetricReason(reply?.error || reply?.route) || "empty_or_error_reply",
      source,
      latencyMs
    });
  }
  if (source !== "openai_compatible") {
    return proactiveLiveResult("failed", {
      reason: "unsupported_source",
      source,
      latencyMs
    });
  }
  return {
    ...proactiveLiveResult("success", {
      reason: cleanMetricReason(reply?.route) || PROACTIVE_LIVE_REPLY_MODE,
      source,
      latencyMs
    }),
    text: String(reply.text).slice(0, 220),
    state: cleanMetricText(reply?.state, 32),
    presentation: reply?.presentation && typeof reply.presentation === "object" ? reply.presentation : null,
    route: cleanMetricReason(reply?.route) || PROACTIVE_LIVE_REPLY_MODE,
    latency_breakdown: reply?.latency_breakdown && typeof reply.latency_breakdown === "object"
      ? reply.latency_breakdown
      : undefined
  };
}

function proactiveLiveResult(status, { reason = "", source = "", latencyMs = undefined } = {}) {
  return {
    called: true,
    eventType: `${PROACTIVE_LIVE_PREFIX}.${status === "failed" ? "failed" : status}`,
    status,
    reason: cleanMetricReason(reason) || status,
    source: cleanMetricSource(source) || "gateway",
    ...(latencyMs !== undefined ? { latencyMs } : {})
  };
}

function recordProactiveLiveMetric(recordMetric, result) {
  if (typeof recordMetric !== "function" || !result?.eventType) return;
  recordMetric({
    eventType: result.eventType,
    status: result.status,
    reason: result.reason,
    source: result.source,
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {})
  });
}

function proactiveRoomSession(session, config) {
  return {
    user_id: "room",
    username: "room",
    nickname: "Hoshia",
    room_id: session?.room_id || config?.roomId || config?.room_id || "room"
  };
}

function cleanMetricSource(value) {
  const text = cleanMetricText(value, 48);
  if (!text) return "";
  if (/^(openai_compatible|hoshiaclaw|gateway|gateway_error|astrbot|mock)$/i.test(text)) return text;
  return "unknown";
}

function cleanMetricReason(value) {
  const text = cleanMetricText(value, 80);
  if (!text) return "";
  if (/token|key|secret|base[_ -]?url|https?:\/\/|\.env|[A-Za-z]:\\|\/home\/|raw[_ -]?(prompt|response|chat)/i.test(text)) {
    return "proactive_live_failed";
  }
  return text.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80);
}

function cleanMetricText(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
