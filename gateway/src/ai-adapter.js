import { isValidState } from "./state-machine.js";

const safeStates = new Set(["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"]);

export async function generateAiReply(session, text, options, fetchImpl = globalThis.fetch) {
  if (options.aiMode !== "astrbot") {
    return mockAiReply(text, session.nickname);
  }

  try {
    const reply = await requestAstrBotReply(session, text, options, fetchImpl);
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

async function requestAstrBotReply(session, text, options, fetchImpl) {
  if (!fetchImpl) throw new Error("fetch_unavailable");
  if (!options.astrbotBridgeUrl) throw new Error("astrbot_bridge_url_missing");
  if (!options.astrbotBridgeToken) throw new Error("astrbot_bridge_token_missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.astrbotTimeoutMs);

  try {
    const response = await fetchImpl(options.astrbotBridgeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${options.astrbotBridgeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: `${options.roomId}:${session.user_id}`,
        room_id: options.roomId,
        user_id: session.user_id,
        nickname: session.nickname,
        text
      }),
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
  if (/在吗|hello|hi|嗨|你好/i.test(clean)) {
    return { text: `${nickname}，我在的。弹幕信号已经收到。`, state: "SPEAKING", source: "mock" };
  }
  if (/错误|坏了|失败|断线|error/i.test(clean)) {
    return { text: "检测到异常关键词，已切换到 ERROR 提示。房间仍会保持可见。", state: "ERROR", source: "mock" };
  }
  if (/语音|tts/i.test(clean)) {
    return { text: "当前先不播放真实 TTS，后续可以把这条回复转进 VoxCPM2 队列。", state: "SPEAKING", source: "mock" };
  }
  return { text: `收到：${clean.slice(0, 80)}。我先用 mock AI 陪你测试直播间。`, state: "SPEAKING", source: "mock" };
}
