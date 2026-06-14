const USER_MESSAGE_RECEIVED = "user.message_received";
const AI_REPLY_SENT = "ai.reply_sent";
const MUSIC_SONG_REQUESTED = "module.music.song_requested";
const MUSIC_CONTROL = "module.music.control";
const VISUAL_STATE_CHANGED = "hoshia_visual_state.changed";
const TIMELINE_POST_CREATED = "hoshia_timeline.post_created";
const COMMENT_REPLY_PENDING = "hoshia_timeline.comment_reply_pending";
const COMMENT_REPLIED = "hoshia_timeline.comment_replied";
const HOSHIACLAW_PROACTIVE_SHADOW_PREFIX = "hoshiaclaw.proactive_shadow.";
const HOSHIACLAW_PROACTIVE_LIVE_PREFIX = "hoshiaclaw.proactive_live.";
const HOSHIACLAW_DAILY_POST_SHADOW_PREFIX = "hoshiaclaw.daily_post_shadow.";
const HOSHIACLAW_NEWS_TOPIC_SHADOW_PREFIX = "hoshiaclaw.news_topic_generate_shadow.";
const HOSHIA_NEWS_PREFIX = "hoshia_news.";
const MAX_APPLIED_EVENT_IDS = 20;

export function projectCharacterEvent(snapshot = {}, event = {}) {
  const eventType = safeText(event.event_type || event.eventType, 80);
  if (eventType === USER_MESSAGE_RECEIVED) return projectUserMessageReceivedEvent(snapshot, event);
  if (eventType === AI_REPLY_SENT) return projectAiReplySentEvent(snapshot, event);
  if (eventType === MUSIC_SONG_REQUESTED) return projectMusicSongRequestedEvent(snapshot, event);
  if (eventType === MUSIC_CONTROL) return projectMusicControlEvent(snapshot, event);
  if (eventType === VISUAL_STATE_CHANGED) return projectVisualStateChangedEvent(snapshot, event);
  if (eventType === TIMELINE_POST_CREATED) return projectTimelinePostCreatedEvent(snapshot, event);
  if (eventType === COMMENT_REPLY_PENDING || eventType === COMMENT_REPLIED) return projectTimelineCommentReplyEvent(snapshot, event);
  if (eventType.startsWith(HOSHIACLAW_PROACTIVE_SHADOW_PREFIX) || eventType.startsWith(HOSHIACLAW_PROACTIVE_LIVE_PREFIX)) {
    return projectHoshiaClawProactiveActivityEvent(snapshot, event);
  }
  if (eventType.startsWith(HOSHIACLAW_DAILY_POST_SHADOW_PREFIX) || eventType.startsWith(HOSHIACLAW_NEWS_TOPIC_SHADOW_PREFIX)) {
    return projectHoshiaClawShadowActivityEvent(snapshot, event);
  }
  if (eventType.startsWith(HOSHIA_NEWS_PREFIX)) return projectHoshiaNewsEvent(snapshot, event);
  return clonePlainObject(snapshot);
}

export function projectUserMessageReceivedEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== USER_MESSAGE_RECEIVED) {
    return next;
  }

  applyEventMetadata(next, event);

  return next;
}

export function projectAiReplySentEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== AI_REPLY_SENT) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  if (occurredAt) recent.last_ai_reply_at = occurredAt;
  recent.last_ai_reply_route = safeText(data.route || event.reason, 80);
  recent.last_ai_reply_source = safeText(data.source_type || event.source_kind || event.sourceKind, 80);
  derived.last_ai_reply_event_id = eventIdentifier(event);

  return next;
}

export function projectMusicSongRequestedEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== MUSIC_SONG_REQUESTED) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const title = safeText(data.title, 120);
  const artist = safeText(data.artist, 120);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  recent.last_music_request = {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(occurredAt ? { requested_at: occurredAt } : {})
  };
  derived.last_music_event_id = eventIdentifier(event);

  return next;
}

export function projectMusicControlEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== MUSIC_CONTROL) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const action = safeText(data.action || event.reason, 40);
  const status = safeText(data.status || "done", 40);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  recent.last_music_control = {
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(occurredAt ? { controlled_at: occurredAt } : {})
  };
  derived.last_music_event_id = eventIdentifier(event);

  return next;
}

export function projectVisualStateChangedEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== VISUAL_STATE_CHANGED) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const expression = ensureObject(publicBlock, "expression");
  const recent = ensureObject(publicBlock, "recent");
  const stage = ensureObject(publicBlock, "stage");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const mood = safeText(data.mood, 40);
  const activity = safeText(data.activity, 40);
  const source = safeText(data.source || data.source_type || event.source_kind || event.sourceKind, 60);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  if (mood) expression.mood = mood;
  if (activity) expression.activity = activity;
  recent.last_visual_state_change = {
    ...(mood ? { mood } : {}),
    ...(activity ? { activity } : {}),
    ...(source ? { source } : {}),
    ...(occurredAt ? { changed_at: occurredAt } : {})
  };
  stage.presentation_suggestion = buildPresentationSuggestion(expression);
  derived.last_visual_event_id = eventIdentifier(event);

  return next;
}

export function projectTimelinePostCreatedEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== TIMELINE_POST_CREATED) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const today = ensureObject(publicBlock, "today");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const activity = safeText(data.activity, 40);
  const mood = safeText(data.mood, 40);
  const sourceType = safeText(data.source_type || data.source || event.source_kind || event.sourceKind, 60);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  today.last_activity = activity || today.last_activity || "";
  recent.last_timeline_post = {
    ...(activity ? { activity } : {}),
    ...(mood ? { mood } : {}),
    ...(sourceType ? { source_type: sourceType } : {}),
    ...(occurredAt ? { posted_at: occurredAt } : {})
  };
  derived.last_daily_event_id = eventIdentifier(event);

  return next;
}

export function projectTimelineCommentReplyEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  const eventType = safeText(event.event_type || event.eventType, 80);
  if (eventType !== COMMENT_REPLY_PENDING && eventType !== COMMENT_REPLIED) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const status = safeText(data.status || (eventType === COMMENT_REPLY_PENDING ? "pending" : "replied"), 40);
  const mood = safeText(data.mood, 40);
  const activity = safeText(data.activity, 40);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  recent.last_comment_reply = {
    status,
    ...(activity ? { activity } : {}),
    ...(mood ? { mood } : {}),
    ...(occurredAt ? { updated_at: occurredAt } : {})
  };
  derived.last_comment_event_id = eventIdentifier(event);

  return next;
}

export function projectHoshiaClawProactiveActivityEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  const eventType = safeText(event.event_type || event.eventType, 80);
  if (!eventType.startsWith(HOSHIACLAW_PROACTIVE_SHADOW_PREFIX) && !eventType.startsWith(HOSHIACLAW_PROACTIVE_LIVE_PREFIX)) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const status = safeText(data.status || statusFromEventType(eventType), 40);
  const route = safeText(data.route || (eventType.startsWith(HOSHIACLAW_PROACTIVE_LIVE_PREFIX) ? "proactive_idle_live" : "proactive_idle_shadow"), 80);
  const sourceType = safeText(data.source_type || event.source_kind || event.sourceKind || "hoshiaclaw", 60);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  recent.last_proactive_activity = {
    ...(status ? { status } : {}),
    ...(route ? { route } : {}),
    ...(sourceType ? { source_type: sourceType } : {}),
    ...(occurredAt ? { updated_at: occurredAt } : {})
  };
  derived.last_proactive_event_id = eventIdentifier(event);

  return next;
}

export function projectHoshiaClawShadowActivityEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  const eventType = safeText(event.event_type || event.eventType, 80);
  if (!eventType.startsWith(HOSHIACLAW_DAILY_POST_SHADOW_PREFIX) && !eventType.startsWith(HOSHIACLAW_NEWS_TOPIC_SHADOW_PREFIX)) {
    return next;
  }

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const status = safeText(data.status || statusFromEventType(eventType), 40);
  const route = safeText(data.route || (eventType.startsWith(HOSHIACLAW_NEWS_TOPIC_SHADOW_PREFIX) ? "news_topic_generate_shadow" : "daily_post_shadow"), 80);
  const sourceType = safeText(data.source_type || event.source_kind || event.sourceKind || "hoshiaclaw", 60);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  recent.last_shadow_activity = {
    ...(status ? { status } : {}),
    ...(route ? { route } : {}),
    ...(sourceType ? { source_type: sourceType } : {}),
    ...(occurredAt ? { updated_at: occurredAt } : {})
  };
  if (route === "daily_post_shadow") derived.last_daily_shadow_event_id = eventIdentifier(event);
  if (route === "news_topic_generate_shadow") derived.last_news_shadow_event_id = eventIdentifier(event);

  return next;
}

export function projectHoshiaNewsEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  const eventType = safeText(event.event_type || event.eventType, 80);
  if (!eventType.startsWith(HOSHIA_NEWS_PREFIX)) return next;

  applyEventMetadata(next, event);
  const publicBlock = ensureObject(next, "public");
  const today = ensureObject(publicBlock, "today");
  const recent = ensureObject(publicBlock, "recent");
  const internal = ensureObject(next, "internal");
  const derived = ensureObject(internal, "derived");
  const data = eventData(event);
  const status = safeText(data.status, 40);
  const sourceType = safeText(data.source_type || event.source_kind || event.sourceKind || "hoshia_news", 60);
  const topic = safeText(data.topic || data.category || event.reason, 120);
  const occurredAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);

  if (eventType === "hoshia_news.topic_post_created") {
    today.last_activity = "news_topic";
  }
  recent.last_news_activity = {
    event_type: eventType,
    ...(status ? { status } : {}),
    ...(sourceType ? { source_type: sourceType } : {}),
    ...(topic ? { topic } : {}),
    ...(occurredAt ? { updated_at: occurredAt } : {})
  };
  derived.last_news_event_id = eventIdentifier(event);

  return next;
}

function applyEventMetadata(snapshot, event) {
  const publicBlock = ensureObject(snapshot, "public");
  const explain = ensureObject(publicBlock, "explain");
  const internal = ensureObject(snapshot, "internal");
  const derived = ensureObject(internal, "derived");

  const existingIds = Array.isArray(derived.last_applied_event_ids)
    ? derived.last_applied_event_ids.map((item) => safeText(item, 100)).filter(Boolean)
    : [];
  const eventId = eventIdentifier(event);
  if (eventId) {
    derived.last_applied_event_ids = [...new Set([...existingIds, eventId])].slice(-MAX_APPLIED_EVENT_IDS);
  } else {
    derived.last_applied_event_ids = existingIds.slice(-MAX_APPLIED_EVENT_IDS);
  }

  const updatedAt = safeTimestamp(event.occurred_at || event.occurredAt || event.created_at || event.createdAt);
  if (updatedAt) {
    explain.updated_at = updatedAt;
  } else if (typeof explain.updated_at !== "string") {
    explain.updated_at = "";
  }
}

function eventData(event) {
  if (event?.data && typeof event.data === "object" && !Array.isArray(event.data)) return event.data;
  const raw = typeof event?.data_json === "string" ? event.data_json : event?.dataJson;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function eventIdentifier(event) {
  return safeText(event.event_id || event.eventId || event.id || event.idempotency_key || event.idempotencyKey, 100);
}

function ensureObject(target, key) {
  if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
    target[key] = {};
  }
  return target[key];
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function buildPresentationSuggestion(expression = {}) {
  const mood = safeText(expression.mood, 40) || "calm";
  const activity = safeText(expression.activity, 40) || "idle";
  return {
    mood,
    activity,
    source: "character_snapshot"
  };
}

function statusFromEventType(eventType = "") {
  const text = String(eventType || "");
  if (text.endsWith(".success")) return "success";
  if (text.endsWith(".skip")) return "skip";
  if (text.endsWith(".failed")) return "failed";
  return "";
}

function safeTimestamp(value) {
  const text = safeText(value, 40);
  return text && !Number.isNaN(Date.parse(text)) ? text : "";
}

function safeText(value, maxLength) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text || /(?:token|secret|bearer|\.env|ssh|cloudflared|https?:\/\/|[A-Za-z]:\\|\/home\/|\/root\/|127\.0\.0\.1|localhost)/i.test(text)) {
    return "";
  }
  return text.slice(0, maxLength);
}
