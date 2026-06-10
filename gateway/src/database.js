import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const defaultSummaryTimeZone = "Asia/Shanghai";

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

    CREATE TABLE IF NOT EXISTS hoshia_state (
      character_id TEXT PRIMARY KEY,
      mood TEXT NOT NULL,
      activity TEXT NOT NULL,
      energy INTEGER NOT NULL,
      social_need INTEGER NOT NULL,
      current_png TEXT NOT NULL,
      state_reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hoshia_posts (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      content TEXT NOT NULL,
      image_url TEXT,
      mood TEXT,
      activity TEXT,
      source_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hoshia_posts_recent
      ON hoshia_posts(character_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS hoshia_post_interactions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES hoshia_posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      nickname TEXT,
      type TEXT NOT NULL,
      content TEXT,
      parent_interaction_id TEXT,
      reply_status TEXT,
      reply_due_at TEXT,
      replied_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hoshia_post_interactions_post
      ON hoshia_post_interactions(post_id, created_at ASC, id ASC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_hoshia_post_likes_unique
      ON hoshia_post_interactions(post_id, user_id, type)
      WHERE type = 'like';

    CREATE TABLE IF NOT EXISTS hoshia_life_memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      user_id TEXT,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      content TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      emotion TEXT,
      tags_json TEXT,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_hoshia_life_memories_lookup
      ON hoshia_life_memories(character_id, user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_character_profiles (
      user_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      familiarity INTEGER NOT NULL DEFAULT 0,
      trust INTEGER NOT NULL DEFAULT 0,
      teasing_level INTEGER NOT NULL DEFAULT 0,
      preferred_topics TEXT,
      interaction_style TEXT,
      summary TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, character_id)
    );
  `);
  migrateUsersTable(db);
  migrateHoshiaPostInteractionsTable(db);
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

  getHoshiaState(characterId = "hoshia") {
    return this.db.prepare(`
      SELECT character_id, mood, activity, energy, social_need, current_png, state_reason, updated_at
      FROM hoshia_state
      WHERE character_id = ?
    `).get(characterId) || null;
  }

  upsertHoshiaState({
    character_id,
    mood,
    activity,
    energy,
    social_need,
    current_png,
    state_reason,
    updated_at
  }) {
    this.db.prepare(`
      INSERT INTO hoshia_state (
        character_id,
        mood,
        activity,
        energy,
        social_need,
        current_png,
        state_reason,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        mood = excluded.mood,
        activity = excluded.activity,
        energy = excluded.energy,
        social_need = excluded.social_need,
        current_png = excluded.current_png,
        state_reason = excluded.state_reason,
        updated_at = excluded.updated_at
    `).run(
      character_id,
      mood,
      activity,
      energy,
      social_need,
      current_png,
      state_reason,
      updated_at
    );
    return this.getHoshiaState(character_id);
  }

  createHoshiaPost({
    id,
    character_id = "hoshia",
    content,
    image_url = "",
    mood = "",
    activity = "",
    source_type = "manual",
    created_at = new Date().toISOString(),
    updated_at = created_at
  }) {
    this.db.prepare(`
      INSERT INTO hoshia_posts (
        id,
        character_id,
        content,
        image_url,
        mood,
        activity,
        source_type,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      character_id,
      content,
      image_url || null,
      mood || null,
      activity || null,
      source_type,
      created_at,
      updated_at
    );
    return this.getHoshiaPost(id);
  }

  getHoshiaPost(postId) {
    return this.db.prepare(`
      SELECT id, character_id, content, image_url, mood, activity, source_type, created_at, updated_at
      FROM hoshia_posts
      WHERE id = ?
    `).get(postId) || null;
  }

  listHoshiaPosts({ characterId = "hoshia", limit = 20, viewerUserId = "" } = {}) {
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 20), 100));
    const rows = this.db.prepare(`
      SELECT
        post.id,
        post.character_id,
        post.content,
        COALESCE(post.image_url, '') AS image_url,
        COALESCE(post.mood, '') AS mood,
        COALESCE(post.activity, '') AS activity,
        post.source_type,
        post.created_at,
        post.updated_at,
        COALESCE(SUM(CASE WHEN interaction.type = 'like' THEN 1 ELSE 0 END), 0) AS like_count,
        COALESCE(SUM(CASE WHEN interaction.type = 'comment' THEN 1 ELSE 0 END), 0) AS comment_count,
        COALESCE(MAX(CASE WHEN interaction.type = 'like' AND interaction.user_id = ? THEN 1 ELSE 0 END), 0) AS liked_by_viewer
      FROM hoshia_posts post
      LEFT JOIN hoshia_post_interactions interaction ON interaction.post_id = post.id
      WHERE post.character_id = ?
      GROUP BY post.id
      ORDER BY datetime(post.created_at) DESC, post.id DESC
      LIMIT ?
    `).all(viewerUserId || "", characterId, safeLimit);
    return rows.map((row) => ({
      ...row,
      like_count: Number(row.like_count || 0),
      comment_count: Number(row.comment_count || 0),
      liked_by_viewer: Boolean(row.liked_by_viewer),
      interactions: this.listHoshiaPostInteractions(row.id)
    }));
  }

  addHoshiaPostInteraction({
    id,
    post_id,
    user_id,
    nickname = "",
    type,
    content = "",
    parent_interaction_id = "",
    reply_status = "",
    reply_due_at = "",
    replied_at = "",
    created_at = new Date().toISOString()
  }) {
    const status = type === "comment" ? (reply_status || "none") : "";
    this.db.prepare(`
      INSERT OR IGNORE INTO hoshia_post_interactions (
        id,
        post_id,
        user_id,
        nickname,
        type,
        content,
        parent_interaction_id,
        reply_status,
        reply_due_at,
        replied_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      post_id,
      user_id,
      nickname || null,
      type,
      content || null,
      parent_interaction_id || null,
      status || null,
      reply_due_at || null,
      replied_at || null,
      created_at
    );
    const inserted = this.getHoshiaPostInteraction(id) || (type === "like"
      ? this.db.prepare(`
        SELECT id, post_id, user_id, nickname, type, content, parent_interaction_id, reply_status, reply_due_at, replied_at, created_at
        FROM hoshia_post_interactions
        WHERE post_id = ? AND user_id = ? AND type = 'like'
        LIMIT 1
      `).get(post_id, user_id)
      : null);
    return inserted ? compactPostInteraction(inserted) : null;
  }

  getHoshiaPostInteraction(id) {
    const row = this.db.prepare(`
      SELECT id, post_id, user_id, nickname, type, content, parent_interaction_id, reply_status, reply_due_at, replied_at, created_at
      FROM hoshia_post_interactions
      WHERE id = ?
    `).get(id) || null;
    return row ? compactPostInteraction(row) : null;
  }

  listHoshiaPostInteractions(postId) {
    return this.db.prepare(`
      SELECT id, post_id, user_id, COALESCE(nickname, '') AS nickname, type, COALESCE(content, '') AS content, COALESCE(parent_interaction_id, '') AS parent_interaction_id, COALESCE(reply_status, '') AS reply_status, COALESCE(reply_due_at, '') AS reply_due_at, COALESCE(replied_at, '') AS replied_at, created_at
      FROM hoshia_post_interactions
      WHERE post_id = ?
      ORDER BY datetime(created_at) ASC, id ASC
    `).all(postId).map(compactPostInteraction);
  }

  listDueHoshiaPostComments({ now = new Date().toISOString(), limit = 10, force = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 10), 50));
    const forcePending = Boolean(force);
    const query = this.db.prepare(`
      SELECT
        interaction.id,
        interaction.post_id,
        interaction.user_id,
        COALESCE(interaction.nickname, '') AS nickname,
        interaction.type,
        COALESCE(interaction.content, '') AS content,
        COALESCE(interaction.parent_interaction_id, '') AS parent_interaction_id,
        COALESCE(interaction.reply_status, '') AS reply_status,
        COALESCE(interaction.reply_due_at, '') AS reply_due_at,
        COALESCE(interaction.replied_at, '') AS replied_at,
        interaction.created_at,
        post.character_id,
        post.content AS post_content,
        COALESCE(post.image_url, '') AS post_image_url,
        COALESCE(post.mood, '') AS post_mood,
        COALESCE(post.activity, '') AS post_activity,
        post.source_type,
        post.created_at AS post_created_at,
        post.updated_at AS post_updated_at
      FROM hoshia_post_interactions interaction
      JOIN hoshia_posts post ON post.id = interaction.post_id
      WHERE interaction.type = 'comment'
        AND interaction.reply_status = 'pending'
        AND interaction.reply_due_at IS NOT NULL
        ${forcePending ? "" : "AND interaction.reply_due_at <= ?"}
      ORDER BY datetime(interaction.reply_due_at) ASC, interaction.id ASC
      LIMIT ?
    `);
    return forcePending ? query.all(safeLimit) : query.all(now, safeLimit);
  }

  listDueHoshiaCommentReplies(options = {}) {
    return this.listDueHoshiaPostComments(options);
  }

  markHoshiaPostCommentReplyStatus(commentId, {
    status,
    replyId = "",
    reason = "",
    replyDueAt = null,
    repliedAt = null
  } = {}) {
    this.db.prepare(`
      UPDATE hoshia_post_interactions
      SET reply_status = ?,
          reply_due_at = ?,
          replied_at = ?
      WHERE id = ? AND type = 'comment'
    `).run(status || null, replyDueAt || null, repliedAt || null, commentId);
    return this.getHoshiaPostInteraction(commentId);
  }

  markHoshiaCommentReplyPending({ commentId, replyDueAt } = {}) {
    return this.markHoshiaPostCommentReplyStatus(commentId, {
      status: "pending",
      replyDueAt,
      repliedAt: ""
    });
  }

  markHoshiaCommentReplyReplied({ commentId, repliedAt } = {}) {
    const comment = this.getHoshiaPostInteraction(commentId);
    return this.markHoshiaPostCommentReplyStatus(commentId, {
      status: "replied",
      replyDueAt: comment?.reply_due_at || "",
      repliedAt
    });
  }

  markHoshiaCommentReplyFailed({ commentId, failedAt } = {}) {
    const comment = this.getHoshiaPostInteraction(commentId);
    return this.markHoshiaPostCommentReplyStatus(commentId, {
      status: "failed",
      replyDueAt: comment?.reply_due_at || "",
      repliedAt: failedAt
    });
  }

  markHoshiaCommentReplySkipped({ commentId, skippedAt } = {}) {
    const comment = this.getHoshiaPostInteraction(commentId);
    return this.markHoshiaPostCommentReplyStatus(commentId, {
      status: "skipped",
      replyDueAt: comment?.reply_due_at || "",
      repliedAt: skippedAt
    });
  }

  countHoshiaPostsBySourceOnDate({ sourceType, date, characterId = "hoshia" } = {}) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM hoshia_posts
      WHERE character_id = ?
        AND source_type = ?
        AND substr(created_at, 1, 10) = ?
    `).get(characterId, sourceType, date);
    return Number(row?.total || 0);
  }

  findHoshiaPostBySourceOnDate({ sourceType, date, characterId = "hoshia" } = {}) {
    return this.db.prepare(`
      SELECT id, character_id, content, image_url, mood, activity, source_type, created_at, updated_at
      FROM hoshia_posts
      WHERE character_id = ?
        AND source_type = ?
        AND substr(created_at, 1, 10) = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 1
    `).get(characterId, sourceType, date) || null;
  }

  countHoshiaPostsForDay({ now = new Date().toISOString(), timeZone = defaultSummaryTimeZone, characterId = "hoshia" } = {}) {
    const targetDay = dayKeyForTimeZone(now, timeZone);
    const rows = this.db.prepare(`
      SELECT source_type, created_at
      FROM hoshia_posts
      WHERE character_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
    `).all(characterId);
    const bySource = {};
    let total = 0;
    for (const row of rows) {
      if (dayKeyForTimeZone(row.created_at, timeZone) !== targetDay) continue;
      total += 1;
      const sourceType = String(row.source_type || "manual");
      bySource[sourceType] = Number(bySource[sourceType] || 0) + 1;
    }
    return { day_key: targetDay, total, by_source: bySource };
  }

  countHoshiaRepliesForDay({ now = new Date().toISOString(), timeZone = defaultSummaryTimeZone, characterId = "hoshia" } = {}) {
    const targetDay = dayKeyForTimeZone(now, timeZone);
    const rows = this.db.prepare(`
      SELECT interaction.created_at
      FROM hoshia_post_interactions interaction
      JOIN hoshia_posts post ON post.id = interaction.post_id
      WHERE post.character_id = ?
        AND interaction.type = 'reply'
      ORDER BY datetime(interaction.created_at) DESC, interaction.id DESC
    `).all(characterId);
    let total = 0;
    for (const row of rows) {
      if (dayKeyForTimeZone(row.created_at, timeZone) === targetDay) total += 1;
    }
    return { day_key: targetDay, total };
  }

  countHoshiaCommentReplyStatuses({ characterId = "hoshia" } = {}) {
    const rows = this.db.prepare(`
      SELECT COALESCE(interaction.reply_status, '') AS reply_status, COUNT(*) AS total
      FROM hoshia_post_interactions interaction
      JOIN hoshia_posts post ON post.id = interaction.post_id
      WHERE post.character_id = ?
        AND interaction.type = 'comment'
      GROUP BY COALESCE(interaction.reply_status, '')
    `).all(characterId);
    const counts = {};
    for (const row of rows) {
      const key = String(row.reply_status || "none") || "none";
      counts[key] = Number(row.total || 0);
    }
    return counts;
  }

  addHoshiaLifeMemory({
    id,
    character_id = "hoshia",
    user_id = "",
    type = "event",
    source = "system",
    source_id = "",
    content,
    importance = 0.5,
    emotion = "",
    tags = [],
    created_at = new Date().toISOString(),
    last_accessed_at = null,
    expires_at = null
  }) {
    this.db.prepare(`
      INSERT INTO hoshia_life_memories (
        id,
        character_id,
        user_id,
        type,
        source,
        source_id,
        content,
        importance,
        emotion,
        tags_json,
        created_at,
        last_accessed_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      character_id,
      user_id || null,
      type,
      source,
      source_id || null,
      content,
      Math.max(0, Math.min(Number(importance) || 0.5, 1)),
      emotion || null,
      JSON.stringify(Array.isArray(tags) ? tags : []),
      created_at,
      last_accessed_at,
      expires_at
    );
    return this.getHoshiaLifeMemory(id);
  }

  getHoshiaLifeMemory(id) {
    const row = this.db.prepare(`
      SELECT id, character_id, user_id, type, source, source_id, content, importance, emotion, tags_json, created_at, last_accessed_at, expires_at
      FROM hoshia_life_memories
      WHERE id = ?
    `).get(id);
    return row ? normalizeLifeMemoryRow(row) : null;
  }

  searchHoshiaLifeMemories({
    characterId = "hoshia",
    userId = "",
    query = "",
    sourceFilter = "",
    limit = 8,
    now = new Date().toISOString()
  } = {}) {
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 8), 50));
    const terms = memorySearchTerms(query);
    const rows = this.db.prepare(`
      SELECT id, character_id, user_id, type, source, source_id, content, importance, emotion, tags_json, created_at, last_accessed_at, expires_at
      FROM hoshia_life_memories
      WHERE character_id = ?
        AND (? = '' OR user_id IS NULL OR user_id = ?)
        AND (? = '' OR source = ?)
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY importance DESC, datetime(created_at) DESC, id DESC
      LIMIT 80
    `).all(characterId, userId || "", userId || "", sourceFilter || "", sourceFilter || "", now);
    return rows
      .map(normalizeLifeMemoryRow)
      .map((memory) => ({ ...memory, match_score: scoreMemory(memory, terms) }))
      .filter((memory) => !terms.length || memory.match_score > 0)
      .sort((a, b) => b.match_score - a.match_score || b.importance - a.importance || b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }

  upsertUserCharacterProfile({
    user_id,
    character_id = "hoshia",
    familiarity = 0,
    trust = 0,
    teasing_level = 0,
    preferred_topics = "",
    interaction_style = "",
    summary = "",
    updated_at = new Date().toISOString()
  }) {
    this.db.prepare(`
      INSERT INTO user_character_profiles (
        user_id,
        character_id,
        familiarity,
        trust,
        teasing_level,
        preferred_topics,
        interaction_style,
        summary,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_id) DO UPDATE SET
        familiarity = excluded.familiarity,
        trust = excluded.trust,
        teasing_level = excluded.teasing_level,
        preferred_topics = excluded.preferred_topics,
        interaction_style = excluded.interaction_style,
        summary = excluded.summary,
        updated_at = excluded.updated_at
    `).run(
      user_id,
      character_id,
      Math.max(0, Math.min(Math.floor(Number(familiarity) || 0), 100)),
      Math.max(0, Math.min(Math.floor(Number(trust) || 0), 100)),
      Math.max(0, Math.min(Math.floor(Number(teasing_level) || 0), 100)),
      preferred_topics || null,
      interaction_style || null,
      summary || null,
      updated_at
    );
    return this.getUserCharacterProfile(user_id, character_id);
  }

  getUserCharacterProfile(userId, characterId = "hoshia") {
    return this.db.prepare(`
      SELECT user_id, character_id, familiarity, trust, teasing_level, preferred_topics, interaction_style, summary, updated_at
      FROM user_character_profiles
      WHERE user_id = ? AND character_id = ?
    `).get(userId, characterId) || null;
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

function compactPostInteraction(row) {
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

function dayKeyForTimeZone(value = new Date(), timeZone = defaultSummaryTimeZone) {
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

function normalizeLifeMemoryRow(row) {
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

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => String(item).slice(0, 40)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function memorySearchTerms(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[\s,，。！？!?;；:：#]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

function scoreMemory(memory, terms) {
  const base = Number(memory.importance || 0) * 10;
  if (!terms.length) return base + 1;
  const haystack = `${memory.content} ${memory.emotion} ${memory.tags.join(" ")}`.toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits * 20 + base;
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

function migrateHoshiaPostInteractionsTable(db) {
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
