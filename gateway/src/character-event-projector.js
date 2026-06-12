const USER_MESSAGE_RECEIVED = "user.message_received";
const AI_REPLY_SENT = "ai.reply_sent";
const MUSIC_SONG_REQUESTED = "module.music.song_requested";
const MAX_APPLIED_EVENT_IDS = 20;

export function projectCharacterEvent(snapshot = {}, event = {}) {
  const eventType = safeText(event.event_type || event.eventType, 80);
  if (eventType === USER_MESSAGE_RECEIVED) return projectUserMessageReceivedEvent(snapshot, event);
  if (eventType === AI_REPLY_SENT) return projectAiReplySentEvent(snapshot, event);
  if (eventType === MUSIC_SONG_REQUESTED) return projectMusicSongRequestedEvent(snapshot, event);
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
