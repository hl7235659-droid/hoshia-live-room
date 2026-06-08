import { isValidState } from "./state-machine.js";

const safeStates = new Set(["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"]);

export async function generateAiReply(session, text, options, fetchImpl = globalThis.fetch, metadata = {}) {
  if (options.aiMode !== "astrbot") {
    return mockAiReply(text, session.nickname);
  }

  try {
    const reply = await requestAstrBotReply(session, text, options, fetchImpl, metadata);
    return normalizeReply(reply, "astrbot");
  } catch (error) {
    console.error("astrbot_bridge_failed", {
      type: error.name || "Error",
      message: error.message,
      fallback: options.astrbotFallbackToMock
    });

    if (options.astrbotFallbackToMock) {
      return {
        ...mockAiReply(text, session.nickname),
        source: "mock_fallback"
      };
    }
    return {
      text: "AstrBot bridge is temporarily unavailable.",
      state: "ERROR",
      source: "gateway_error"
    };
  }
}

async function requestAstrBotReply(session, text, options, fetchImpl, metadata = {}) {
  if (!fetchImpl) throw new Error("fetch_unavailable");
  if (!options.astrbotBridgeUrl) throw new Error("astrbot_bridge_url_missing");
  if (!options.astrbotBridgeToken) throw new Error("astrbot_bridge_token_missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.astrbotTimeoutMs);

  try {
    const body = {
      session_id: metadata.roomSession ? `${options.roomId}:room` : `${options.roomId}:${session.user_id}`,
      room_id: options.roomId,
      user_id: session.user_id,
      nickname: session.nickname,
      text,
      prompt: text,
      reply_targets: Array.isArray(metadata.replyTargets) ? metadata.replyTargets : [],
      messages: Array.isArray(metadata.messages) ? metadata.messages : []
    };
    if (metadata.forceReply === true) body.force_reply = true;
    if (metadata.replyMode) body.reply_mode = String(metadata.replyMode);

    const response = await fetchImpl(options.astrbotBridgeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${options.astrbotBridgeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`astrbot_bridge_http_${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(`astrbot_bridge_${payload?.error || "failed"}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeReply(reply, fallbackSource) {
  if (reply?.skipped) {
    return {
      skipped: true,
      source: String(reply?.source || "heartflow_judge"),
      judge: reply?.judge,
      latency_ms: Number.isFinite(Number(reply?.latency_ms)) ? Number(reply.latency_ms) : undefined
    };
  }

  const text = String(reply?.text || "").trim();
  if (!text) throw new Error("astrbot_bridge_empty_text");

  const state = String(reply?.state || "SPEAKING").toUpperCase();
  return {
    text: text.slice(0, 2000),
    state: safeStates.has(state) && isValidState(state) ? state : "SPEAKING",
    source: String(reply?.source || fallbackSource),
    latency_ms: Number.isFinite(Number(reply?.latency_ms)) ? Number(reply.latency_ms) : undefined
  };
}

export function mockAiReply(text, nickname) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (/(?:\u5728\u5417|hello|hi|\u4f60\u597d)/i.test(clean)) {
    return { text: `${nickname}\uff0c\u6211\u5728\u7684\u3002\u5f39\u5e55\u4fe1\u53f7\u5df2\u7ecf\u6536\u5230\u3002`, state: "SPEAKING", source: "mock" };
  }
  if (/(?:\u9519\u8bef|\u574f\u4e86|\u5931\u8d25|\u65ad\u7ebf|error)/i.test(clean)) {
    return { text: "\u68c0\u6d4b\u5230\u5f02\u5e38\u5173\u952e\u8bcd\uff0c\u5df2\u5207\u6362\u5230 ERROR \u63d0\u793a\u3002\u623f\u95f4\u4ecd\u4f1a\u4fdd\u6301\u53ef\u89c1\u3002", state: "ERROR", source: "mock" };
  }
  if (/(?:\u8bed\u97f3|tts)/i.test(clean)) {
    return { text: "\u5f53\u524d\u5148\u4e0d\u64ad\u653e\u771f\u5b9e TTS\uff0c\u540e\u7eed\u53ef\u4ee5\u628a\u8fd9\u6761\u56de\u590d\u8f6c\u8fdb VoxCPM2 \u961f\u5217\u3002", state: "SPEAKING", source: "mock" };
  }
  return { text: `\u6536\u5230\uff1a${clean.slice(0, 80)}\u3002\u6211\u5148\u7528 mock AI \u966a\u4f60\u6d4b\u8bd5\u76f4\u64ad\u95f4\u3002`, state: "SPEAKING", source: "mock" };
}
