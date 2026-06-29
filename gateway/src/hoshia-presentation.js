const actions = new Set([
  "idle",
  "listen",
  "think",
  "speak",
  "react_positive",
  "react_negative",
  "react_surprised",
  "recover"
]);

const intensities = new Set(["low", "normal", "high"]);
const states = new Set(["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"]);
const sources = new Set(["ai_reply", "character_state", "hoshia_state", "system"]);
const fallbackPngPrefix = "/assets/hoshia/stage-png/";
const rawPromptKeys = new Set(["prompt", "raw_prompt", "rawPrompt"]);
const rawResponseKeys = new Set(["response", "raw_response", "rawResponse"]);

const stateActionMap = {
  IDLE: "idle",
  LISTENING: "listen",
  THINKING: "think",
  SPEAKING: "speak",
  ERROR: "recover"
};

const stateCueMap = {
  IDLE: "standby",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  ERROR: "recovering"
};

export function normalizeHoshiaPresentation(input = {}, context = {}) {
  const now = context.now || new Date().toISOString();
  const fallbackState = normalizeState(input.fallback_state || input.fallbackState || input.state || context.state);
  const action = normalizeAction(input.action, fallbackState);
  return {
    version: 1,
    action,
    intensity: intensities.has(input.intensity) ? input.intensity : defaultIntensity(action),
    duration_ms: clampNumber(input.duration_ms ?? input.durationMs, defaultDuration(action), 200, 15000),
    ...(safeText(input.expression, 80) ? { expression: safeText(input.expression, 80) } : {}),
    ...(safeText(input.motion, 80) ? { motion: safeText(input.motion, 80) } : {}),
    fallback_state: fallbackState,
    ...(safeFallbackPng(input.fallback_png || input.fallbackPng) ? { fallback_png: safeFallbackPng(input.fallback_png || input.fallbackPng) } : {}),
    ...(safeText(input.cue || stateCueMap[fallbackState], 120) ? { cue: safeText(input.cue || stateCueMap[fallbackState], 120) } : {}),
    source: sources.has(input.source) ? input.source : context.source || "system",
    ...(safeText(input.trace_id || input.traceId || context.traceId, 80) ? { trace_id: safeText(input.trace_id || input.traceId || context.traceId, 80) } : {}),
    ...(safeText(input.reason || context.reason, 160) ? { reason: safeText(input.reason || context.reason, 160) } : {}),
    timestamp: safeText(input.timestamp, 40) || now
  };
}

export function presentationFromCharacterState(state, context = {}) {
  const fallbackState = normalizeState(state);
  return normalizeHoshiaPresentation({
    action: stateActionMap[fallbackState],
    fallback_state: fallbackState,
    source: "character_state",
    cue: stateCueMap[fallbackState]
  }, context);
}

export function presentationFromVisualState(state = {}, context = {}) {
  return normalizeHoshiaPresentation({
    action: "idle",
    fallback_state: context.characterState || "IDLE",
    fallback_png: state.current_png,
    expression: state.mood,
    motion: state.activity,
    source: "hoshia_state",
    reason: state.state_reason
  }, context);
}

export function presentationFromClawEnvelope(envelope = {}, context = {}) {
  return normalizeHoshiaPresentation({
    ...(typeof envelope.presentation === "object" && envelope.presentation ? envelope.presentation : {}),
    fallback_state: envelope.state || envelope.character_state?.state || context.state,
    action: envelope.presentation?.action,
    source: "ai_reply",
    trace_id: envelope.latency_trace_id || context.traceId,
    reason: envelope.route || context.reason
  }, context);
}

export function collectPresentationObservabilityCounts(input = {}, context = {}) {
  const isEnvelope = Boolean(input?.presentation && typeof input.presentation === "object");
  const presentationInput = isEnvelope ? input.presentation : input;
  const normalized = isEnvelope
    ? presentationFromClawEnvelope(input, context)
    : normalizeHoshiaPresentation(input, context);
  const rawDuration = presentationInput?.duration_ms ?? presentationInput?.durationMs;
  const rawFallbackPng = presentationInput?.fallback_png ?? presentationInput?.fallbackPng;
  const requestedAction = String(presentationInput?.action || "").trim();
  const roundedDuration = Math.round(Number(rawDuration));

  return Object.freeze({
    presentation_count: input && typeof input === "object" ? 1 : 0,
    normalized_field_count: Object.keys(normalized).length,
    action_fallback_count: requestedAction && requestedAction !== normalized.action ? 1 : 0,
    duration_clamped_count: rawDuration !== undefined && Number.isFinite(roundedDuration) && roundedDuration !== normalized.duration_ms ? 1 : 0,
    fallback_png_allowed_count: normalized.fallback_png ? 1 : 0,
    fallback_png_rejected_count: rawFallbackPng && !normalized.fallback_png ? 1 : 0,
    sensitive_field_rejected_count: countSensitiveValues(input),
    trace_passthrough_count: normalized.trace_id ? 1 : 0,
    prompt_omitted_count: countMatchingKeys(input, rawPromptKeys),
    response_omitted_count: countMatchingKeys(input, rawResponseKeys)
  });
}

function normalizeAction(value, fallbackState) {
  const action = String(value || "").trim();
  if (actions.has(action)) return action;
  return stateActionMap[normalizeState(fallbackState)] || "idle";
}

function normalizeState(value) {
  const state = String(value || "IDLE").trim().toUpperCase();
  return states.has(state) ? state : "IDLE";
}

function defaultIntensity(action) {
  if (action === "react_surprised" || action === "react_positive" || action === "react_negative") return "high";
  if (action === "idle" || action === "listen") return "low";
  return "normal";
}

function defaultDuration(action) {
  if (action === "speak") return 1800;
  if (action === "think") return 1400;
  if (action.startsWith("react_")) return 1200;
  return 900;
}

function clampNumber(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function safeText(value, maxLength) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text || hasSensitiveMarker(text)) return "";
  return text.slice(0, maxLength);
}

function safeFallbackPng(value) {
  const text = safeText(value, 180);
  if (!text) return "";
  if (!text.startsWith(fallbackPngPrefix)) return "";
  if (text.includes("..") || text.includes("\\") || text.includes("//")) return "";
  if (!/^\/assets\/hoshia\/stage-png\/[A-Za-z0-9._/-]+\.png$/i.test(text)) return "";
  return text;
}

function hasSensitiveMarker(value) {
  return /(?:token|secret|bearer|\.env|ssh|cloudflared|127\.0\.0\.1|localhost|https?:\/\/|[A-Za-z]:\\|\/home\/|\/root\/)/i.test(value);
}

function countSensitiveValues(value, seen = new Set()) {
  if (typeof value === "string") return hasSensitiveMarker(value) ? 1 : 0;
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countSensitiveValues(item, seen), 0);
  }
  return Object.values(value).reduce((total, item) => total + countSensitiveValues(item, seen), 0);
}

function countMatchingKeys(value, keys, seen = new Set()) {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countMatchingKeys(item, keys, seen), 0);
  }
  return Object.entries(value).reduce((total, [key, item]) => {
    return total + (keys.has(key) ? 1 : 0) + countMatchingKeys(item, keys, seen);
  }, 0);
}
