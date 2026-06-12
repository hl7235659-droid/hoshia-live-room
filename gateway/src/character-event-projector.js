const USER_MESSAGE_RECEIVED = "user.message_received";
const MAX_APPLIED_EVENT_IDS = 20;

export function projectUserMessageReceivedEvent(snapshot = {}, event = {}) {
  const next = clonePlainObject(snapshot);
  if (safeText(event.event_type || event.eventType, 80) !== USER_MESSAGE_RECEIVED) {
    return next;
  }

  const publicBlock = ensureObject(next, "public");
  const explain = ensureObject(publicBlock, "explain");
  const internal = ensureObject(next, "internal");
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

  return next;
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
