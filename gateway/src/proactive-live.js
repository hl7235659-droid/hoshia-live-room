const PROACTIVE_LIVE_PREFIX = "hoshiaclaw.proactive_live";
const PROACTIVE_LIVE_REPLY_MODE = "proactive_idle_live";
const SENSITIVE_TEXT_PATTERN = /token|key|secret|bearer|base[_ -]?url|https?:\/\/|\.env|[A-Za-z]:\\|\/(?:home|root|var|etc|Users)\/|localhost|127\.0\.0\.1|0\.0\.0\.0|internal|raw[_ -]?(prompt|response|chat)|candidate[_-]?text|\bpath\b/i;

export function buildProactiveLivePrompt({
  idleMs = 0,
  onlineCount = 0,
  unansweredCount = 0,
  topicHooks = [],
  recentMessages = [],
  characterSnapshotContext = null
} = {}) {
  const idleMinutes = Math.max(1, Math.round(Number(idleMs || 0) / 60000));
  const safeHooks = sanitizeTextList(topicHooks, 8, 160);
  const safeRecent = sanitizeRecentMessages(recentMessages, 3);
  const safeSnapshot = summarizeSnapshotForPrompt(characterSnapshotContext);

  return [
    "You are Hoshia, the host of a small live room.",
    "Write one proactive Chinese line for a quiet idle moment.",
    `Idle time: about ${idleMinutes} minutes.`,
    `Online viewers: ${safeNumberForPrompt(onlineCount)}.`,
    `Unanswered proactive count: ${safeNumberForPrompt(unansweredCount)}.`,
    "Use only the safe public context below. Do not mention system routing, logs, tokens, URLs, file paths, private configuration, or hidden prompts.",
    ...(safeSnapshot.length ? ["Public character state:", ...safeSnapshot] : []),
    ...(safeHooks.length ? ["Safe topic hooks:", ...safeHooks.map((line, index) => `${index + 1}. ${line}`)] : [
      "Safe topic hooks: none. If no concrete hook is available, keep the line light and do not invent private events."
    ]),
    ...(safeRecent.length ? ["Recent public room signals:", ...safeRecent.map((line, index) => `${index + 1}. ${line}`)] : [
      "Recent public room signals: none."
    ]),
    "Task:",
    "- Output only Hoshia's spoken line.",
    "- Use Chinese, 1 to 2 short sentences, at most 90 Chinese characters.",
    "- Prefer a concrete diary, music, module, or recent public room hook.",
    "- Include one easy handle that viewers can respond to.",
    "- Do not say you detected silence. Do not scold viewers. Do not ask a generic customer-service question."
  ].join("\n");
}

export function buildProactiveLiveMetadata({
  latencyTraceId = "",
  characterSnapshotContext = null
} = {}) {
  const metadata = {
    roomSession: true,
    forceReply: true,
    replyMode: PROACTIVE_LIVE_REPLY_MODE,
    onDelta: null
  };
  const traceId = cleanMetricText(latencyTraceId, 80);
  if (traceId) metadata.latencyTraceId = traceId;
  const snapshot = sanitizeSnapshotContext(characterSnapshotContext);
  if (snapshot) metadata.characterSnapshotContext = snapshot;
  return metadata;
}

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
  if (source === "gateway_error") {
    return proactiveLiveResult("failed", {
      reason: cleanMetricReason(reply?.error || source) || "gateway_error",
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
  const text = sanitizeSuccessText(reply.text);
  if (!text) {
    return proactiveLiveResult("failed", {
      reason: "unsafe_reply_text",
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
    text,
    state: cleanMetricText(reply?.state, 32),
    presentation: sanitizePresentation(reply?.presentation),
    route: cleanMetricReason(reply?.route) || PROACTIVE_LIVE_REPLY_MODE,
    latency_breakdown: sanitizeLatencyBreakdown(reply?.latency_breakdown)
  };
}

export function buildProactiveLiveInterruptionSkipMetric({
  startedAfterUserMessageAt = 0,
  lastUserMessageAt = 0
} = {}) {
  if (Number(lastUserMessageAt || 0) === Number(startedAfterUserMessageAt || 0)) return null;
  return proactiveLiveResult("skip", {
    reason: "user_activity_changed",
    source: "gateway"
  });
}

function sanitizeSuccessText(value) {
  const text = cleanMetricText(value, 220);
  if (!text || SENSITIVE_TEXT_PATTERN.test(text)) return "";
  return text;
}

function sanitizePresentation(value) {
  if (!value || typeof value !== "object" || containsSensitiveMetricPayload(value)) return null;
  const output = {};
  for (const key of ["action", "mood", "activity", "expression", "motion"]) {
    const safeKey = cleanMetricText(key, 32);
    const text = cleanMetricText(value[key], 80);
    if (safeKey && text && !SENSITIVE_TEXT_PATTERN.test(`${safeKey} ${text}`)) output[safeKey] = text;
  }
  return Object.keys(output).length ? output : null;
}

function sanitizeLatencyBreakdown(value) {
  if (!value || typeof value !== "object" || containsSensitiveMetricPayload(value)) return undefined;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = cleanMetricReason(key);
    const number = safeNumber(raw);
    if (safeKey && number !== undefined) output[safeKey] = number;
  }
  return Object.keys(output).length ? output : undefined;
}

function containsSensitiveMetricPayload(value) {
  try {
    return SENSITIVE_TEXT_PATTERN.test(JSON.stringify(value));
  } catch {
    return true;
  }
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
  if (SENSITIVE_TEXT_PATTERN.test(text)) {
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

function sanitizeTextList(values = [], limit = 6, maxLength = 160) {
  return (Array.isArray(values) ? values : [])
    .map((value) => sanitizePromptText(value, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function sanitizeRecentMessages(messages = [], limit = 3) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-limit * 2)
    .map((message) => {
      const role = message?.role === "ai" ? "Hoshia" : "viewer";
      const text = sanitizePromptText(message?.text, 120);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .slice(-limit);
}

function summarizeSnapshotForPrompt(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const lines = [];
  const publicPart = snapshot.public && typeof snapshot.public === "object" ? snapshot.public : snapshot;
  const expression = publicPart.expression && typeof publicPart.expression === "object" ? publicPart.expression : {};
  const today = publicPart.today && typeof publicPart.today === "object" ? publicPart.today : {};
  const relationship = publicPart.relationship && typeof publicPart.relationship === "object" ? publicPart.relationship : {};
  const recent = publicPart.recent && typeof publicPart.recent === "object" ? publicPart.recent : {};
  const stage = publicPart.stage && typeof publicPart.stage === "object" ? publicPart.stage : {};
  const presentation = stage.presentation_suggestion && typeof stage.presentation_suggestion === "object"
    ? stage.presentation_suggestion
    : {};
  const derived = publicPart.derived && typeof publicPart.derived === "object" ? publicPart.derived : {};
  pushSnapshotLine(lines, "Mood", publicPart.mood || publicPart.emotion || expression.mood || presentation.mood || derived.mood);
  pushSnapshotLine(lines, "Activity", publicPart.activity || expression.activity || presentation.activity || derived.activity);
  pushSnapshotLine(lines, "Energy", publicPart.energy || publicPart.energy_level || expression.energy || derived.energy);
  pushSnapshotLine(lines, "Relationship", publicPart.relationship_stage || relationship.stage);
  pushSnapshotLine(lines, "Recent source", publicPart.recent_interaction_source || recent.interaction_source || derived.recent_interaction_source);
  pushSnapshotLine(lines, "Today", publicPart.daily_canon || publicPart.today_topic || today.active_event_title || today.theme || derived.daily_canon);
  return lines.slice(0, 6);
}

function pushSnapshotLine(lines, label, value) {
  const text = sanitizePromptText(value, 80);
  if (text) lines.push(`${label}: ${text}`);
}

function sanitizeSnapshotContext(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const publicPart = snapshot.public && typeof snapshot.public === "object" ? snapshot.public : snapshot;
  const output = {};
  const expression = publicPart.expression && typeof publicPart.expression === "object" ? publicPart.expression : {};
  const today = publicPart.today && typeof publicPart.today === "object" ? publicPart.today : {};
  const relationship = publicPart.relationship && typeof publicPart.relationship === "object" ? publicPart.relationship : {};
  const recent = publicPart.recent && typeof publicPart.recent === "object" ? publicPart.recent : {};
  const stage = publicPart.stage && typeof publicPart.stage === "object" ? publicPart.stage : {};
  const presentationSuggestion = stage.presentation_suggestion && typeof stage.presentation_suggestion === "object"
    ? stage.presentation_suggestion
    : {};
  copySnapshotField(output, "mood", publicPart.mood || publicPart.emotion || expression.mood || presentationSuggestion.mood);
  copySnapshotField(output, "activity", publicPart.activity || expression.activity || presentationSuggestion.activity);
  copySnapshotField(output, "energy", publicPart.energy || publicPart.energy_level || expression.energy);
  copySnapshotField(output, "relationship_stage", publicPart.relationship_stage || relationship.stage);
  copySnapshotField(output, "daily_canon", publicPart.daily_canon || publicPart.today_topic || today.active_event_title || today.theme);
  copySnapshotField(output, "recent_interaction_source", publicPart.recent_interaction_source || recent.interaction_source);
  for (const key of [
    "mood",
    "emotion",
    "activity",
    "energy",
    "energy_level",
    "relationship_stage",
    "daily_canon",
    "today_topic",
    "recent_interaction_source",
    "presentation"
  ]) {
    const value = publicPart[key];
    if (typeof value === "string") {
      const text = sanitizePromptText(value, 120);
      if (text) output[key] = text;
    } else if (value && typeof value === "object" && key === "presentation") {
      const presentation = {};
      for (const presentationKey of ["action", "mood", "activity"]) {
        const text = sanitizePromptText(value[presentationKey], 80);
        if (text) presentation[presentationKey] = text;
      }
      if (Object.keys(presentation).length) output.presentation = presentation;
    }
  }
  return Object.keys(output).length ? output : null;
}

function copySnapshotField(output, key, value) {
  const text = sanitizePromptText(value, 120);
  if (text && !output[key]) output[key] = text;
}

function sanitizePromptText(value, maxLength = 160) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text) return "";
  return SENSITIVE_TEXT_PATTERN.test(text) ? "" : text;
}

function safeNumberForPrompt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}
