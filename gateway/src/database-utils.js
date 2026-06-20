const defaultSummaryTimeZone = "Asia/Shanghai";

export function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function compactContextMessage(row) {
  const event = parseJsonObject(row.event_json);
  const message = {
    id: row.id,
    room_id: row.room_id,
    type: row.type,
    role: row.role,
    user_id: row.user_id || "",
    nickname: row.nickname || "",
    text: row.text,
    timestamp: row.timestamp,
    created_at: row.created_at
  };
  const color = normalizePublicColor(event.color);
  if (color) message.color = color;
  return message;
}

export function isDisplayableRoomMessage(event) {
  if (!event || event.role !== "ai") return true;
  const text = String(event.text || "").trim();
  if (!/^[\[{]/.test(text)) return true;
  try {
    JSON.parse(text);
  } catch {
    return false;
  }
  return false;
}

export function normalizePublicColor(value) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : "";
}

export function compactPostInteraction(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    user_id: row.user_id || "",
    nickname: row.nickname || "",
    type: row.type,
    content: row.content || "",
    parent_interaction_id: row.parent_interaction_id || "",
    reply_status: row.reply_status || "",
    reply_due_at: row.reply_due_at || "",
    replied_at: row.replied_at || "",
    created_at: row.created_at
  };
}

export function dayKeyForTimeZone(value = new Date(), timeZone = defaultSummaryTimeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || defaultSummaryTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((item) => item.type === "year")?.value || "0000";
  const month = parts.find((item) => item.type === "month")?.value || "01";
  const day = parts.find((item) => item.type === "day")?.value || "01";
  return `${year}${month}${day}`;
}

export function normalizeLifeMemoryRow(row) {
  return {
    ...row,
    user_id: row.user_id || "",
    source_id: row.source_id || "",
    importance: Number(row.importance || 0),
    emotion: row.emotion || "",
    tags: parseTags(row.tags_json),
    last_accessed_at: row.last_accessed_at || "",
    expires_at: row.expires_at || ""
  };
}

export function parseTags(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => String(item).slice(0, 40)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function memorySearchTerms(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[\s,，。！？!?;；:：#]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

export function scoreMemory(memory, terms) {
  const base = Number(memory.importance || 0) * 10;
  if (!terms.length) return base + 1;
  const haystack = `${memory.content} ${memory.emotion} ${memory.tags.join(" ")}`.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits * 20 + base;
}

export function isSqliteUniqueError(error) {
  return String(error?.code || "").includes("CONSTRAINT_UNIQUE") ||
    String(error?.message || "").includes("UNIQUE constraint failed");
}

export function migrateUsersTable(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!columns.has("avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  }
  if (!columns.has("danmaku_color")) {
    db.exec("ALTER TABLE users ADD COLUMN danmaku_color TEXT");
  }
  if (!columns.has("total_online_seconds")) {
    db.exec("ALTER TABLE users ADD COLUMN total_online_seconds INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("onboarding_completed")) {
    db.exec("ALTER TABLE users ADD COLUMN onboarding_completed INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.has("ai_profile_json")) {
    db.exec("ALTER TABLE users ADD COLUMN ai_profile_json TEXT");
  }
}

export function migrateHoshiaPostInteractionsTable(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(hoshia_post_interactions)").all().map((column) => column.name));
  if (!columns.has("reply_status")) {
    db.exec("ALTER TABLE hoshia_post_interactions ADD COLUMN reply_status TEXT");
  }
  if (!columns.has("reply_due_at")) {
    db.exec("ALTER TABLE hoshia_post_interactions ADD COLUMN reply_due_at TEXT");
  }
  if (!columns.has("replied_at")) {
    db.exec("ALTER TABLE hoshia_post_interactions ADD COLUMN replied_at TEXT");
  }
}
