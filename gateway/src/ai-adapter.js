import { isValidState } from "./state-machine.js";

const safeStates = new Set(["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"]);

export async function generateAiReply(session, text, options, fetchImpl = globalThis.fetch, metadata = {}) {
  const profile = bridgeProfile(options);
  if (!profile) {
    return mockAiReply(text, session.nickname);
  }

  try {
    const reply = await requestBridgeReply(session, text, options, fetchImpl, metadata, profile);
    return normalizeReply(reply, profile.kind);
  } catch (error) {
    console.error(`${profile.kind}_bridge_failed`, {
      type: error.name || "Error",
      message: error.message,
      fallback: profile.fallbackToMock
    });

    if (profile.fallbackToMock && isRoomReply(metadata)) {
      return {
        ok: true,
        skipped: true,
        text: "",
        state: "IDLE",
        source: `${profile.kind}_error_skipped`,
        error: error.message
      };
    }

    if (profile.fallbackToMock) {
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

function isRoomReply(metadata = {}) {
  return metadata.roomSession === true || Array.isArray(metadata.messages);
}

async function requestBridgeReply(session, text, options, fetchImpl, metadata = {}, profile = bridgeProfile(options)) {
  if (!fetchImpl) throw new Error("fetch_unavailable");
  if (!profile?.bridgeUrl) throw new Error(`${profile?.kind || "ai"}_bridge_url_missing`);
  if (!profile?.bridgeToken) throw new Error(`${profile?.kind || "ai"}_bridge_token_missing`);

  const body = astrBotReplyBody(session, text, options, metadata);
  const shouldStream = profile.streamingEnabled !== false && typeof metadata.onDelta === "function";
  const targetNormalizer = createSingleTargetPrefixNormalizer(metadata.replyTargets);
  const onDelta = shouldStream
    ? (event) => {
        const normalizedText = targetNormalizer.normalizeDelta(event?.text || "");
        if (normalizedText) metadata.onDelta({ ...event, text: normalizedText });
      }
    : null;
  if (shouldStream) {
    try {
      const reply = await requestBridgeStream(profile, fetchImpl, { ...body, stream: true }, onDelta);
      return normalizeSingleTargetReplyText(reply, targetNormalizer);
    } catch (error) {
      console.warn(`${profile.kind}_stream_failed_falling_back`, {
        type: error.name || "Error",
        message: safeBridgeLogMessage(error.message)
      });
    }
  }

  const reply = await requestBridgeJsonReply(profile, fetchImpl, body);
  return normalizeSingleTargetReplyText(reply, targetNormalizer);
}

function astrBotReplyBody(session, text, options, metadata = {}) {
  const prompt = String(text || "");
  const body = {
    session_id: metadata.roomSession ? `${options.roomId}:room` : `${options.roomId}:${session.user_id}`,
    room_id: options.roomId,
    user_id: session.user_id,
    nickname: session.nickname,
    text: bridgeVisibleText(metadata, prompt),
    prompt,
    reply_targets: Array.isArray(metadata.replyTargets) ? metadata.replyTargets : [],
    messages: Array.isArray(metadata.messages) ? metadata.messages : []
  };
  if (metadata.forceReply === true) body.force_reply = true;
  if (metadata.replyMode) body.reply_mode = String(metadata.replyMode);
  if (metadata.replyRoute) body.reply_route = String(metadata.replyRoute).slice(0, 48);
  if (metadata.latencyTraceId) body.latency_trace_id = String(metadata.latencyTraceId).slice(0, 80);
  if (metadata.activeContext && typeof metadata.activeContext === "object") body.active_context = metadata.activeContext;
  if (metadata.contextPolicy && typeof metadata.contextPolicy === "object") body.context_policy = metadata.contextPolicy;
  if (Array.isArray(metadata.recentContext) && metadata.recentContext.length) body.recent_context = metadata.recentContext;
  if (metadata.contextSummary) body.context_summary = String(metadata.contextSummary).slice(0, 4000);
  if (metadata.characterSnapshotContext && typeof metadata.characterSnapshotContext === "object") {
    body.character_snapshot_context = metadata.characterSnapshotContext;
  }
  if (Array.isArray(metadata.moduleContext) && metadata.moduleContext.length) body.module_context = metadata.moduleContext;
  if (Array.isArray(metadata.moduleEvents) && metadata.moduleEvents.length) body.module_events = metadata.moduleEvents;
  if (Array.isArray(metadata.moduleMemoryEvents) && metadata.moduleMemoryEvents.length) body.module_memory_events = metadata.moduleMemoryEvents;
  return body;
}

function bridgeVisibleText(metadata = {}, fallback = "") {
  const messages = Array.isArray(metadata.messages) ? metadata.messages : [];
  const lines = messages
    .map((item) => {
      const nickname = String(item?.nickname || "").trim().slice(0, 32);
      const text = String(item?.text || "").replace(/\s+/g, " ").trim();
      if (!text) return "";
      return nickname ? `${nickname}: ${text}` : text;
    })
    .filter(Boolean);
  const value = lines.length ? lines.join("\n") : String(fallback || "");
  return value.slice(0, 2800);
}

async function requestBridgeJsonReply(profile, fetchImpl, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);

  try {
    const response = await fetchImpl(profile.bridgeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${profile.bridgeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${profile.kind}_bridge_http_${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(`${profile.kind}_bridge_${payload?.error || "failed"}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestBridgeStream(profile, fetchImpl, body, onDelta) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);

  try {
    const response = await fetchImpl(profile.bridgeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${profile.bridgeToken}`,
        "Content-Type": "application/json",
        "Accept": "application/x-ndjson"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${profile.kind}_bridge_http_${response.status}`);
    }
    const contentType = String(response.headers?.get?.("content-type") || "");
    if (!contentType.includes("application/x-ndjson")) {
      const payload = await response.json();
      if (!payload?.ok) throw new Error(`${profile.kind}_bridge_${payload?.error || "failed"}`);
      return payload;
    }
    return parseBridgeNdjson(response, onDelta, profile.kind);
  } finally {
    clearTimeout(timeout);
  }
}

async function parseBridgeNdjson(response, onDelta, source = "ai") {
  if (!response.body?.getReader) throw new Error(`${source}_stream_body_unavailable`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  let streamed = false;

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) continue;
        if (event.type === "delta") {
          const text = String(event.text || "");
          if (text) {
            streamed = true;
            onDelta({ text, route: event.route, latencyTraceId: event.latency_trace_id });
          }
        } else if (event.type === "done" || event.type === "skipped") {
          donePayload = event;
        } else if (event.type === "error") {
          throw new Error(`${source}_stream_${event.error || "failed"}`);
        }
      }
    }
    if (done) break;
  }
  buffer += decoder.decode();

  const tail = parseStreamLine(buffer);
  if (tail?.type === "delta") {
    const text = String(tail.text || "");
    if (text) {
      streamed = true;
      onDelta({ text, route: tail.route, latencyTraceId: tail.latency_trace_id });
    }
  } else if (tail?.type === "done" || tail?.type === "skipped") {
    donePayload = tail;
  } else if (tail?.type === "error") {
    throw new Error(`${source}_stream_${tail.error || "failed"}`);
  }

  if (!donePayload) throw new Error(`${source}_stream_missing_done`);
  if (!donePayload.ok) throw new Error(`${source}_bridge_${donePayload.error || "failed"}`);
  return { ...donePayload, streamed };
}

function parseStreamLine(line) {
  const clean = String(line || "").trim();
  if (!clean) return null;
  return JSON.parse(clean);
}

function createSingleTargetPrefixNormalizer(replyTargets = []) {
  const targets = Array.isArray(replyTargets) ? replyTargets.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const target = targets.length === 1 ? targets[0].slice(0, 32) : "";
  const prefix = target ? `@${target}` : "";
  let emitted = false;
  const leadingPattern = prefix ? new RegExp(`^\\s*@${escapeRegExp(target)}(?:\\s+|[\u3001\uff0c,:\uff1a])?`, "i") : null;

  return {
    hasTarget: Boolean(prefix),
    normalizeDelta(text = "") {
      const value = String(text || "");
      if (!prefix || !value) return value;
      if (!emitted) {
        emitted = true;
        return normalizeTargetedReplyPrefix(leadingPattern.test(value) ? value : `${prefix} ${value}`, leadingPattern, prefix);
      }
      return stripLeadingDisplayAliasMentions(value.replace(leadingPattern, "")).replace(/^\s+/, "");
    },
    normalizeFinalText(text = "") {
      const value = String(text || "").trim();
      if (!prefix || !value) return value;
      const withoutTargetRepeats = value
        .replace(new RegExp(`\\s*@${escapeRegExp(target)}(?:\\s+|[\u3001\uff0c,:\uff1a])?`, "gi"), " ")
        .replace(/\s+/g, " ")
        .replace(/([\u3001\uff0c,.!?。？！:：])\s+/g, "$1")
        .trim();
      return `${prefix} ${stripLeadingDisplayAliasMentions(withoutTargetRepeats)}`.trim();
    }
  };
}

function normalizeTargetedReplyPrefix(value, leadingPattern, prefix) {
  const body = stripLeadingDisplayAliasMentions(String(value || "").replace(leadingPattern, "")).replace(/^\s+/, "");
  return `${prefix} ${body}`.trim();
}

function stripLeadingDisplayAliasMentions(text = "") {
  let value = String(text || "");
  const aliasPattern = /^\s*@(特别联系人|特殊网友|联系人|Hoshia|hoshia)(?:\s+|[\u3001\uff0c,:\uff1a])?/i;
  for (let index = 0; index < 4; index += 1) {
    if (!aliasPattern.test(value)) break;
    value = value.replace(aliasPattern, "");
  }
  return value;
}

function normalizeSingleTargetReplyText(reply, normalizer) {
  if (!reply || !normalizer?.hasTarget || reply.skipped) return reply;
  return {
    ...reply,
    text: normalizer.normalizeFinalText(reply.text)
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function summarizeLiveRoomContext(options, payload, fetchImpl = globalThis.fetch) {
  const profile = bridgeProfile(options);
  if (!profile) return "";
  if (!fetchImpl) throw new Error("fetch_unavailable");
  if (!profile.bridgeUrl) throw new Error(`${profile.kind}_bridge_url_missing`);
  if (!profile.bridgeToken) throw new Error(`${profile.kind}_bridge_token_missing`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);

  try {
    const response = await fetchImpl(bridgeEndpoint(profile.bridgeUrl, "/live-room/context/summarize"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${profile.bridgeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        room_id: options.roomId,
        previous_summary: String(payload?.previousSummary || "").slice(0, 4000),
        messages: Array.isArray(payload?.messages) ? payload.messages : []
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${profile.kind}_context_summary_http_${response.status}`);
    }

    const body = await response.json();
    if (!body?.ok) {
      throw new Error(`${profile.kind}_context_summary_${body?.error || "failed"}`);
    }
    return String(body.summary || "").trim().slice(0, 4000);
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshNewsTopics(options, payload = {}, fetchImpl = globalThis.fetch) {
  const body = await requestBridgeEndpointJson(
    options,
    "/live-room/capabilities/news/refresh",
    {
      room_id: options.roomId,
      force: Boolean(payload?.force),
      reason: String(payload?.reason || "gateway_manual").slice(0, 80)
    },
    fetchImpl,
    "news_refresh"
  );
  if (!body?.ok) {
    throw new Error(`astrbot_news_refresh_${body?.error || "failed"}`);
  }
  return body;
}

export async function getNewsRefreshStatus(options, payload = {}, fetchImpl = globalThis.fetch) {
  return requestBridgeEndpointJson(
    options,
    "/live-room/capabilities/news/status",
    {
      room_id: options.roomId,
      include_recent: payload?.includeRecent !== false
    },
    fetchImpl,
    "news_status"
  );
}

export async function listNewsTopics(options, payload = {}, fetchImpl = globalThis.fetch) {
  const limit = Math.max(1, Math.min(Number(payload?.limit) || 10, 30));
  const body = await requestBridgeEndpointJson(
    options,
    "/live-room/capabilities/news/topics",
    {
      room_id: options.roomId,
      query: String(payload?.query || "daily news topics").slice(0, 200),
      limit
    },
    fetchImpl,
    "news_topics"
  );
  if (!body?.ok) {
    throw new Error(`astrbot_news_topics_${body?.error || "failed"}`);
  }
  return body;
}

export async function recognizeMusicIntent(session, text, options, fetchImpl = globalThis.fetch, metadata = {}) {
  const profile = bridgeProfile(options);
  if (!profile) return noneMusicIntent("ai_mode_not_bridge");
  if (!fetchImpl || !profile.bridgeUrl || !profile.bridgeToken) {
    return noneMusicIntent(`${profile.kind}_bridge_unavailable`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);

  try {
    const response = await fetchImpl(bridgeEndpoint(profile.bridgeUrl, "/live-room/music/intent"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${profile.bridgeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        room_id: options.roomId,
        user_id: session?.user_id || "",
        username: session?.username || "",
        nickname: session?.nickname || "",
        text: String(text || "").slice(0, 500),
        music_state: safeMusicStateForIntent(metadata.musicState),
        module_events: Array.isArray(metadata.moduleEvents) ? metadata.moduleEvents.slice(0, 24) : []
      }),
      signal: controller.signal
    });

    if (!response.ok) return noneMusicIntent(`${profile.kind}_music_intent_http_${response.status}`);
    const payload = await response.json();
    if (!payload?.ok) return noneMusicIntent(`${profile.kind}_music_intent_${payload?.error || "failed"}`);
    return normalizeMusicIntent(payload.intent || payload, profile.kind);
  } catch (error) {
    console.warn("music_intent_recognition_failed", {
      type: error.name || "Error",
      message: "bridge_request_failed"
    });
    return noneMusicIntent("music_intent_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function requestBridgeEndpointJson(options, pathname, body, fetchImpl, errorPrefix) {
  const profile = bridgeProfile(options);
  if (!profile) throw new Error(`ai_mode_not_bridge_${errorPrefix}`);
  if (!fetchImpl) throw new Error("fetch_unavailable");
  if (!profile.bridgeUrl) throw new Error(`${profile.kind}_bridge_url_missing`);
  if (!profile.bridgeToken) throw new Error(`${profile.kind}_bridge_token_missing`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);

  try {
    const response = await fetchImpl(bridgeEndpoint(profile.bridgeUrl, pathname), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${profile.bridgeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${profile.kind}_${errorPrefix}_http_${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function bridgeEndpoint(baseUrl, pathname) {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

const musicIntents = new Set(["request", "request_many", "pause", "resume", "next", "previous", "remove", "status", "none"]);
const musicTargetKinds = new Set(["", "queue_index", "requested_by_self"]);

function normalizeMusicIntent(value, source = "astrbot") {
  if (!value || typeof value !== "object") return noneMusicIntent("bad_music_intent");
  const intent = String(value.intent || "none").trim().toLowerCase();
  const normalizedIntent = musicIntents.has(intent) ? intent : "none";
  let confidence = Number(value.confidence || 0);
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  confidence = Math.max(0, Math.min(confidence || 0, 1));
  const target = normalizeMusicIntentTarget(value.target);
  return {
    intent: normalizedIntent,
    confidence,
    query: String(value.query || "").trim().slice(0, 160),
    queries: normalizeMusicIntentQueries(value.queries),
    count: clampMusicIntentCount(value.count),
    target,
    reply_hint: String(value.reply_hint || "").trim().slice(0, 160),
    source: String(value.source || `${source}_music_intent`).slice(0, 80)
  };
}

function normalizeMusicIntentQueries(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const queries = [];
  for (const item of value) {
    const query = String(item || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= 5) break;
  }
  return queries;
}

function clampMusicIntentCount(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(number, 5));
}

function normalizeMusicIntentTarget(value) {
  if (!value || typeof value !== "object") return { kind: "" };
  const kind = String(value.kind || "").trim().toLowerCase();
  const safeKind = musicTargetKinds.has(kind) ? kind : "";
  const target = { kind: safeKind };
  if (safeKind === "queue_index") {
    const index = Math.floor(Number(value.index));
    if (Number.isFinite(index)) target.index = Math.max(1, Math.min(index, 100));
  }
  return target;
}

function noneMusicIntent(reason = "") {
  return {
    intent: "none",
    confidence: 0,
    query: "",
    queries: [],
    count: 0,
    target: { kind: "" },
    reply_hint: "",
    source: reason || "none"
  };
}

function safeMusicStateForIntent(state) {
  if (!state || typeof state !== "object") return { enabled: false };
  return {
    enabled: Boolean(state.enabled),
    status: String(state.status || "idle").slice(0, 32),
    current: safeTrackForIntent(state.current),
    queue: Array.isArray(state.queue) ? state.queue.slice(0, 20).map(safeTrackForIntent).filter(Boolean) : [],
    can_control: Boolean(state.can_control)
  };
}

function safeTrackForIntent(track) {
  if (!track || typeof track !== "object") return null;
  return {
    title: String(track.title || "").slice(0, 120),
    artist: String(track.artist || "").slice(0, 120),
    source: String(track.source || "").slice(0, 40),
    requested_by: String(track.requested_by || "").slice(0, 32)
  };
}

function normalizeReply(reply, fallbackSource) {
  if (reply?.skipped) {
    return {
      skipped: true,
      source: String(reply?.source || "heartflow_judge"),
      judge: reply?.judge,
      latency_ms: Number.isFinite(Number(reply?.latency_ms)) ? Number(reply.latency_ms) : undefined,
      ...optionalReplyMetadata(reply)
    };
  }

  const text = String(reply?.text || "").trim();
  if (!text) throw new Error("astrbot_bridge_empty_text");

  const state = String(reply?.state || "SPEAKING").toUpperCase();
  return {
    text: text.slice(0, 2000),
    state: safeStates.has(state) && isValidState(state) ? state : "SPEAKING",
    source: String(reply?.source || fallbackSource),
    latency_ms: Number.isFinite(Number(reply?.latency_ms)) ? Number(reply.latency_ms) : undefined,
    ...optionalReplyMetadata(reply)
  };
}

function optionalReplyMetadata(reply) {
  const metadata = {};
  const breakdown = normalizeLatencyBreakdown(reply?.latency_breakdown);
  if (breakdown) metadata.latency_breakdown = breakdown;
  const route = String(reply?.route || "").trim().slice(0, 48);
  if (route) metadata.route = route;
  if (reply?.streamed === true) metadata.streamed = true;
  if (reply?.presentation && typeof reply.presentation === "object") metadata.presentation = reply.presentation;
  return metadata;
}

function bridgeProfile(options = {}) {
  if (options.aiMode === "astrbot") {
    return {
      kind: "astrbot",
      bridgeUrl: options.astrbotBridgeUrl || "",
      bridgeToken: options.astrbotBridgeToken || "",
      timeoutMs: Number(options.astrbotTimeoutMs || 45000),
      fallbackToMock: options.astrbotFallbackToMock !== false,
      streamingEnabled: options.astrbotStreamingEnabled !== false
    };
  }
  if (options.aiMode === "hoshiaclaw") {
    return {
      kind: "hoshiaclaw",
      bridgeUrl: options.hoshiaClawBridgeUrl || options.hoshiaclawBridgeUrl || "",
      bridgeToken: options.hoshiaClawBridgeToken || options.hoshiaclawToken || "",
      timeoutMs: Number(options.hoshiaClawTimeoutMs || options.hoshiaclawTimeoutMs || 45000),
      fallbackToMock: options.hoshiaClawFallbackToMock !== false && options.hoshiaclawFallbackToMock !== false,
      streamingEnabled: options.hoshiaClawStreamingEnabled !== false && options.hoshiaclawStreamingEnabled !== false
    };
  }
  return null;
}

function normalizeLatencyBreakdown(value) {
  if (!value || typeof value !== "object") return undefined;
  const output = {};
  for (const key of ["router_ms", "batch_wait_ms", "pending_visible_ms", "context_load_ms", "gateway_context_load_ms", "bridge_context_load_ms", "memory_recall_ms", "llm_first_token_ms", "llm_total_ms", "tts_ms", "gateway_total_ms", "total_ms"]) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) output[key] = Math.round(number);
  }
  return Object.keys(output).length ? output : undefined;
}

function safeBridgeLogMessage(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "bridge_stream_failed";
  if (/provider_failed/i.test(text)) return "bridge_stream_failed";
  if (/(?:token|secret|bearer|\.env|ssh|cloudflared|https?:\/\/|[A-Za-z]:\\|\/home\/|\/root\/|127\.0\.0\.1|localhost)/i.test(text)) {
    return "bridge_stream_failed";
  }
  return text.slice(0, 120);
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
  return { text: `\u6536\u5230\uff1a${clean.slice(0, 80)}\u3002\u6211\u5148\u5728\u8fd9\u4e2a\u6d4b\u8bd5\u5c0f\u623f\u95f4\u966a\u4f60\u804a\u4e00\u4f1a\u513f\u3002`, state: "SPEAKING", source: "mock" };
}
