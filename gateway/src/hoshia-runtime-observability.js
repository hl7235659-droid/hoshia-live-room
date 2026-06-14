export function createRuntimeObservabilityCounters() {
  return {
    presentationEmitted: 0,
    presentationSanitized: 0,
    hoshiaCoreProvider: {
      success: 0,
      skip: 0,
      failed: 0
    },
    astrbotFallback: 0,
    eventLogFallback: 0,
    shadow: {
      success: 0,
      skip: 0,
      failed: 0
    }
  };
}

export function recordAiProviderObservation(counters, reply = {}) {
  if (!counters) return counters;
  const source = safeMetricIdentifier(reply?.source || "unknown", 80);
  if (source === "mock_fallback") {
    counters.astrbotFallback = Number(counters.astrbotFallback || 0) + 1;
    return counters;
  }
  if (!source.startsWith("openai_compatible") && !source.startsWith("hoshiaclaw")) return counters;
  const status = reply?.skipped
    ? "skip"
    : (!reply?.text || source === "gateway_error" ? "failed" : "success");
  counters.hoshiaCoreProvider[status] = Number(counters.hoshiaCoreProvider[status] || 0) + 1;
  return counters;
}

export function buildRuntimeObservabilitySnapshot({
  counters,
  moduleMemoryPending = 0,
  characterSnapshotAgeMs = null
} = {}) {
  const safeCounters = counters || createRuntimeObservabilityCounters();
  return {
    presentation_emitted: Number(safeCounters.presentationEmitted || 0),
    presentation_sanitized: Number(safeCounters.presentationSanitized || 0),
    hoshia_core_provider_success: Number(safeCounters.hoshiaCoreProvider?.success || 0),
    hoshia_core_provider_skip: Number(safeCounters.hoshiaCoreProvider?.skip || 0),
    hoshia_core_provider_failed: Number(safeCounters.hoshiaCoreProvider?.failed || 0),
    astrbot_fallback_count: Number(safeCounters.astrbotFallback || 0),
    event_log_fallback_count: Number(safeCounters.eventLogFallback || 0),
    module_memory_pending: Number(moduleMemoryPending || 0),
    shadow_success: Number(safeCounters.shadow?.success || 0),
    shadow_skip: Number(safeCounters.shadow?.skip || 0),
    shadow_failed: Number(safeCounters.shadow?.failed || 0),
    character_snapshot_age_ms: Number.isFinite(characterSnapshotAgeMs) ? characterSnapshotAgeMs : null
  };
}

function safeMetricIdentifier(value, maxLength = 80) {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLength);
  if (!text || hasSensitiveMetricMarker(text)) return "";
  return text;
}

function hasSensitiveMetricMarker(value) {
  return /(?:token|secret|bearer|\.env|ssh|cloudflared|trycloudflare|https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|[A-Za-z]:[\\/]|\/home\/|\/root\/|\/users\/|\/var\/|\/etc\/|internal|raw[_-]?(?:prompt|response)|candidate[_-]?text)/i.test(String(value || ""));
}
