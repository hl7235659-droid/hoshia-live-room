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
    },
    routes: createRouteCounters()
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
  const routeCounters = normalizeRouteCounters(safeCounters.routes);
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
    route_metrics: routeCounters,
    proactive_live_success: routeCounters.proactive_live.success,
    proactive_live_skip: routeCounters.proactive_live.skip,
    proactive_live_failed: routeCounters.proactive_live.failed,
    comment_reply_live_success: routeCounters.comment_reply_live.success,
    comment_reply_live_skip: routeCounters.comment_reply_live.skip,
    comment_reply_live_failed: routeCounters.comment_reply_live.failed,
    daily_post_live_success: routeCounters.daily_post_live.success,
    daily_post_live_skip: routeCounters.daily_post_live.skip,
    daily_post_live_failed: routeCounters.daily_post_live.failed,
    news_topic_live_success: routeCounters.news_topic_live.success,
    news_topic_live_skip: routeCounters.news_topic_live.skip,
    news_topic_live_failed: routeCounters.news_topic_live.failed,
    proactive_shadow_success: routeCounters.proactive_shadow.success,
    proactive_shadow_skip: routeCounters.proactive_shadow.skip,
    proactive_shadow_failed: routeCounters.proactive_shadow.failed,
    comment_reply_shadow_success: routeCounters.comment_reply_shadow.success,
    comment_reply_shadow_skip: routeCounters.comment_reply_shadow.skip,
    comment_reply_shadow_failed: routeCounters.comment_reply_shadow.failed,
    daily_post_shadow_success: routeCounters.daily_post_shadow.success,
    daily_post_shadow_skip: routeCounters.daily_post_shadow.skip,
    daily_post_shadow_failed: routeCounters.daily_post_shadow.failed,
    news_topic_shadow_success: routeCounters.news_topic_shadow.success,
    news_topic_shadow_skip: routeCounters.news_topic_shadow.skip,
    news_topic_shadow_failed: routeCounters.news_topic_shadow.failed,
    character_snapshot_age_ms: Number.isFinite(characterSnapshotAgeMs) ? characterSnapshotAgeMs : null
  };
}

export function recordRouteObservation(counters, route, status) {
  if (!counters) return counters;
  const safeRoute = normalizeRouteName(route);
  const safeStatus = normalizeStatus(status);
  if (!safeRoute || !safeStatus) return counters;
  if (!counters.routes) counters.routes = createRouteCounters();
  if (!counters.routes[safeRoute]) counters.routes[safeRoute] = createStatusCounters();
  counters.routes[safeRoute][safeStatus] = Number(counters.routes[safeRoute][safeStatus] || 0) + 1;
  return counters;
}

export function routeStatusFromCounts({ success = 0, skip = 0, failed = 0 } = {}) {
  if (Number(failed || 0) > 0) return "failed";
  if (Number(success || 0) > 0) return "success";
  if (Number(skip || 0) > 0) return "skip";
  return "";
}

function createRouteCounters() {
  return {
    proactive_live: createStatusCounters(),
    comment_reply_live: createStatusCounters(),
    daily_post_live: createStatusCounters(),
    news_topic_live: createStatusCounters(),
    proactive_shadow: createStatusCounters(),
    comment_reply_shadow: createStatusCounters(),
    daily_post_shadow: createStatusCounters(),
    news_topic_shadow: createStatusCounters()
  };
}

function createStatusCounters() {
  return {
    success: 0,
    skip: 0,
    failed: 0
  };
}

function normalizeRouteCounters(routes = {}) {
  const counters = createRouteCounters();
  for (const route of Object.keys(counters)) {
    counters[route] = {
      success: Number(routes?.[route]?.success || 0),
      skip: Number(routes?.[route]?.skip || 0),
      failed: Number(routes?.[route]?.failed || 0)
    };
  }
  return counters;
}

function normalizeRouteName(value) {
  const route = safeMetricIdentifier(value, 80);
  const aliases = {
    proactive_idle_live: "proactive_live",
    post_comment_reply_live: "comment_reply_live",
    comment_reply_live: "comment_reply_live",
    daily_post_live: "daily_post_live",
    news_topic_generate_live: "news_topic_live",
    news_topic_live: "news_topic_live",
    proactive_idle_shadow: "proactive_shadow",
    post_comment_reply_shadow: "comment_reply_shadow",
    comment_reply_shadow: "comment_reply_shadow",
    daily_post_shadow: "daily_post_shadow",
    news_topic_generate_shadow: "news_topic_shadow",
    news_topic_shadow: "news_topic_shadow"
  };
  return aliases[route] || "";
}

function normalizeStatus(value) {
  const status = String(value || "");
  return ["success", "skip", "failed"].includes(status) ? status : "";
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
