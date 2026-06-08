import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openLiveRoomDatabase(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      avatar_url TEXT,
      danmaku_color TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      total_online_seconds INTEGER NOT NULL DEFAULT 0,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      ai_profile_json TEXT
    );

    CREATE TABLE IF NOT EXISTS registration_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      used_by_user_id TEXT REFERENCES users(id),
      used_at TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_registration_codes_unused
      ON registration_codes(used_at, expires_at);

    CREATE TABLE IF NOT EXISTS room_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      user_id TEXT,
      nickname TEXT,
      text TEXT NOT NULL,
      event_json TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_room_messages_recent
      ON room_messages(room_id, created_at, id);

    CREATE TABLE IF NOT EXISTS room_context_summaries (
      room_id TEXT PRIMARY KEY,
      summary_text TEXT NOT NULL DEFAULT '',
      summarized_until_created_at TEXT,
      summarized_until_id TEXT,
      coverage_start_timestamp TEXT,
      coverage_end_timestamp TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  migrateUsersTable(db);
  return new LiveRoomDatabase(db);
}

export function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

export class LiveRoomDatabase {
  constructor(db) {
    this.db = db;
  }

  findUserByUsername(username) {
    return this.db.prepare(`
      SELECT id, username, username_normalized, password_hash, nickname, avatar_url, danmaku_color, created_at, last_login_at, total_online_seconds, onboarding_completed, ai_profile_json
      FROM users
      WHERE username_normalized = ?
    `).get(normalizeUsername(username));
  }

  findUserById(userId) {
    return this.db.prepare(`
      SELECT id, username, username_normalized, password_hash, nickname, avatar_url, danmaku_color, created_at, last_login_at, total_online_seconds, onboarding_completed, ai_profile_json
      FROM users
      WHERE id = ?
    `).get(userId);
  }

  updateLastLogin(userId, now = new Date().toISOString()) {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
  }

  updateUserProfile(userId, { nickname, avatarUrl, danmakuColor }) {
    this.db.prepare(`
      UPDATE users
      SET nickname = ?, avatar_url = ?, danmaku_color = ?
      WHERE id = ?
    `).run(nickname, avatarUrl || null, danmakuColor || null, userId);
    return this.findUserById(userId);
  }

  updateUserPassword(userId, passwordHash) {
    this.db.prepare(`
      UPDATE users
      SET password_hash = ?
      WHERE id = ?
    `).run(passwordHash, userId);
    return this.findUserById(userId);
  }

  completeUserOnboarding(userId, profile) {
    this.db.prepare(`
      UPDATE users
      SET onboarding_completed = 1, ai_profile_json = ?
      WHERE id = ?
    `).run(profile ? JSON.stringify(profile) : null, userId);
    return this.findUserById(userId);
  }

  addUserOnlineSeconds(userId, seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!safeSeconds) return this.findUserById(userId);
    this.db.prepare(`
      UPDATE users
      SET total_online_seconds = COALESCE(total_online_seconds, 0) + ?
      WHERE id = ?
    `).run(safeSeconds, userId);
    return this.findUserById(userId);
  }

  countUsers() {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM users").get();
    return Number(row.total || 0);
  }

  listAudienceUsers() {
    return this.db.prepare(`
      SELECT
        id,
        username,
        nickname,
        avatar_url,
        danmaku_color,
        created_at,
        last_login_at,
        COALESCE(total_online_seconds, 0) AS total_online_seconds,
        onboarding_completed,
        ai_profile_json
      FROM users
      ORDER BY last_login_at IS NULL, datetime(last_login_at) DESC, username_normalized ASC
    `).all();
  }

  createUserWithRegistrationCode({ user, registrationCodeHash, now = new Date().toISOString() }) {
    const normalized = normalizeUsername(user.username);
    let committed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const code = this.db.prepare(`
        SELECT id, used_at, expires_at
        FROM registration_codes
        WHERE code_hash = ?
      `).get(registrationCodeHash);

      if (!code) {
        throw new DatabaseError("registration_code_invalid");
      }
      if (code.used_at) {
        throw new DatabaseError("registration_code_used");
      }
      if (code.expires_at && Date.parse(code.expires_at) <= Date.parse(now)) {
        throw new DatabaseError("registration_code_expired");
      }

      this.db.prepare(`
        INSERT INTO users (
          id,
          username,
          username_normalized,
          password_hash,
          nickname,
          avatar_url,
          onboarding_completed,
          created_at,
          last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.username,
        normalized,
        user.passwordHash,
        user.nickname,
        user.avatarUrl || null,
        0,
        now,
        now
      );

      this.db.prepare(`
        UPDATE registration_codes
        SET used_by_user_id = ?, used_at = ?
        WHERE id = ? AND used_at IS NULL
      `).run(user.id, now, code.id);

      this.db.exec("COMMIT");
      committed = true;
      return this.findUserByUsername(user.username);
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      if (isSqliteUniqueError(error)) {
        throw new DatabaseError("username_taken");
      }
      throw error;
    }
  }

  insertRegistrationCode({ id, codeHash, createdAt = new Date().toISOString(), expiresAt = null }) {
    this.db.prepare(`
      INSERT INTO registration_codes (id, code_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(id, codeHash, createdAt, expiresAt);
  }

  countRegistrationCodes() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS available
      FROM registration_codes
    `).get();
    return {
      total: Number(row.total || 0),
      available: Number(row.available || 0)
    };
  }

  insertRoomMessage(event, now = new Date().toISOString()) {
    this.db.prepare(`
      INSERT OR REPLACE INTO room_messages (
        id,
        room_id,
        type,
        role,
        user_id,
        nickname,
        text,
        event_json,
        timestamp,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.room_id,
      event.type,
      event.role,
      event.user_id || null,
      event.nickname || null,
      event.text,
      JSON.stringify(event),
      event.timestamp,
      now
    );
  }

  listRecentRoomMessages(roomId, limit = 100) {
    const rows = this.db.prepare(`
      SELECT event_json
      FROM room_messages
      WHERE room_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(roomId, limit);
    return rows.reverse().map((row) => JSON.parse(row.event_json));
  }

  listRecentContextMessages(roomId, limit = 100) {
    const rows = this.db.prepare(`
      SELECT id, room_id, type, role, user_id, nickname, text, timestamp, created_at
      FROM room_messages
      WHERE room_id = ?
        AND role IN ('user', 'ai')
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(roomId, limit);
    return rows.reverse().map(compactContextMessage);
  }

  listContextMessagesAfter(roomId, afterCreatedAt = "", afterId = "", limit = 600) {
    const rows = this.db.prepare(`
      SELECT id, room_id, type, role, user_id, nickname, text, timestamp, created_at
      FROM room_messages
      WHERE room_id = ?
        AND role IN ('user', 'ai')
        AND (
          ? = ''
          OR created_at > ?
          OR (created_at = ? AND id > ?)
        )
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(roomId, afterCreatedAt || "", afterCreatedAt || "", afterCreatedAt || "", afterId || "", limit);
    return rows.map(compactContextMessage);
  }

  getRoomContextSummary(roomId) {
    return this.db.prepare(`
      SELECT room_id, summary_text, summarized_until_created_at, summarized_until_id, coverage_start_timestamp, coverage_end_timestamp, updated_at
      FROM room_context_summaries
      WHERE room_id = ?
    `).get(roomId) || null;
  }

  upsertRoomContextSummary({
    roomId,
    summaryText,
    summarizedUntilCreatedAt,
    summarizedUntilId,
    coverageStartTimestamp,
    coverageEndTimestamp,
    updatedAt = new Date().toISOString()
  }) {
    this.db.prepare(`
      INSERT INTO room_context_summaries (
        room_id,
        summary_text,
        summarized_until_created_at,
        summarized_until_id,
        coverage_start_timestamp,
        coverage_end_timestamp,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        summarized_until_created_at = excluded.summarized_until_created_at,
        summarized_until_id = excluded.summarized_until_id,
        coverage_start_timestamp = COALESCE(room_context_summaries.coverage_start_timestamp, excluded.coverage_start_timestamp),
        coverage_end_timestamp = excluded.coverage_end_timestamp,
        updated_at = excluded.updated_at
    `).run(
      roomId,
      String(summaryText || "").trim(),
      summarizedUntilCreatedAt || null,
      summarizedUntilId || null,
      coverageStartTimestamp || null,
      coverageEndTimestamp || null,
      updatedAt
    );
    return this.getRoomContextSummary(roomId);
  }

  pruneRoomMessages(roomId, keep = 500) {
    this.db.prepare(`
      DELETE FROM room_messages
      WHERE room_id = ?
        AND id NOT IN (
          SELECT id
          FROM room_messages
          WHERE room_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        )
    `).run(roomId, roomId, keep);
  }

  close() {
    this.db.close();
  }
}

function compactContextMessage(row) {
  return {
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
}

export class DatabaseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isSqliteUniqueError(error) {
  return String(error?.code || "").includes("CONSTRAINT_UNIQUE") ||
    String(error?.message || "").includes("UNIQUE constraint failed");
}

function migrateUsersTable(db) {
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
