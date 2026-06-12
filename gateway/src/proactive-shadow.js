const SHADOW_SUCCESS = "hoshiaclaw.proactive_shadow.success";
const SHADOW_SKIP = "hoshiaclaw.proactive_shadow.skip";
const SHADOW_FAILED = "hoshiaclaw.proactive_shadow.failed";

export async function runHoshiaClawProactiveShadow({
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
    const result = shadowResult(SHADOW_SKIP, {
      reason: "missing_dependency",
      source: "gateway"
    });
    recordShadowMetric(recordMetric, result);
    return result;
  }

  try {
    const reply = await generateAiReply(roomSession || shadowRoomSession(session, config), prompt, {
      ...config,
      aiMode: "hoshiaclaw",
      hoshiaClawFallbackToMock: false,
      hoshiaclawFallbackToMock: false,
      hoshiaClawStreamingEnabled: false,
      hoshiaclawStreamingEnabled: false
    }, fetchImpl, {
      ...metadata,
      roomSession: true,
      forceReply: true,
      replyMode: "proactive_idle_shadow",
      onDelta: null
    });

    const result = classifyShadowReply(reply);
    recordShadowMetric(recordMetric, result);
    return result;
  } catch (error) {
    const result = shadowResult(SHADOW_FAILED, {
      reason: safeText(error?.message, 80) || "shadow_failed",
      source: "gateway"
    });
    logger.warn?.("hoshiaclaw_proactive_shadow_failed", {
      type: error?.name || "Error",
      message: safeText(error?.message, 120) || "shadow_failed"
    });
    recordShadowMetric(recordMetric, result);
    return result;
  }
}

export function classifyShadowReply(reply = {}) {
  const source = safeText(reply?.source, 80) || "hoshiaclaw";
  if (reply?.skipped) {
    return shadowResult(SHADOW_SKIP, {
      reason: safeText(reply?.error || reply?.judge?.reason || reply?.route || "skipped", 80),
      source,
      latencyMs: safeNumber(reply?.latency_ms)
    });
  }
  if (!safeText(reply?.text, 1) || source === "gateway_error") {
    return shadowResult(SHADOW_FAILED, {
      reason: safeText(reply?.error || reply?.route || "empty_or_error_reply", 80),
      source,
      latencyMs: safeNumber(reply?.latency_ms)
    });
  }
  return shadowResult(SHADOW_SUCCESS, {
    reason: safeText(reply?.route || "candidate_generated", 80),
    source,
    latencyMs: safeNumber(reply?.latency_ms)
  });
}

function shadowResult(eventType, { reason = "", source = "", latencyMs = undefined } = {}) {
  const status = eventType.endsWith(".success")
    ? "success"
    : eventType.endsWith(".skip")
      ? "skip"
      : "failed";
  return {
    called: true,
    eventType,
    status,
    reason: safeText(reason, 80),
    source: safeText(source, 80),
    ...(latencyMs !== undefined ? { latencyMs } : {})
  };
}

function recordShadowMetric(recordMetric, result) {
  if (typeof recordMetric !== "function" || !result?.eventType) return;
  recordMetric({
    eventType: result.eventType,
    status: result.status,
    reason: result.reason,
    source: result.source,
    latencyMs: result.latencyMs
  });
}

function shadowRoomSession(session = {}, config = {}) {
  return {
    user_id: "room",
    username: "room",
    nickname: "Live room",
    room_id: session.room_id || config.roomId || ""
  };
}

function safeText(value, maxLength) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text || /(?:token|secret|bearer|\.env|ssh|cloudflared|https?:\/\/|[A-Za-z]:\\|\/home\/|\/root\/|127\.0\.0\.1|localhost)/i.test(text)) return "";
  return text.slice(0, maxLength);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}
