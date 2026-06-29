import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DatabaseError } from "./database-error.js";
export { DatabaseError } from "./database-error.js";
export { normalizeUsername } from "./database-utils.js";
import { databaseAccountRepository } from "./database-account-repository.js";
import { databaseRoomRepository } from "./database-room-repository.js";
import { databaseHoshiaRepository } from "./database-hoshia-repository.js";
import { databaseCharacterRepository } from "./database-character-repository.js";
import { databaseGameRepository } from "./database-game-repository.js";
import {
  compactContextMessage,
  compactPostInteraction,
  dayKeyForTimeZone,
  isDisplayableRoomMessage,
  isSqliteUniqueError,
  memorySearchTerms,
  migrateHoshiaPostInteractionsTable,
  migrateUsersTable,
  normalizeLifeMemoryRow,
  parseJsonObject,
  scoreMemory
} from "./database-utils.js";

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

    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_email_verification_codes_lookup
      ON email_verification_codes(email, purpose, used_at, expires_at, created_at);

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

    CREATE TABLE IF NOT EXISTS character_events (
      event_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      character_id TEXT NOT NULL DEFAULT 'hoshia',
      room_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'system',
      user_id TEXT,
      nickname TEXT,
      source_kind TEXT NOT NULL DEFAULT 'system',
      source_id TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      public_hint TEXT NOT NULL DEFAULT '',
      private_hint TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      raw_text_stored INTEGER NOT NULL DEFAULT 0,
      applied_to_snapshot INTEGER NOT NULL DEFAULT 0,
      applied_at TEXT,
      dedupe_status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_character_events_room_time
      ON character_events(room_id, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS idx_character_events_type
      ON character_events(room_id, event_type);

    CREATE TABLE IF NOT EXISTS character_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL DEFAULT 'hoshia',
      room_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      source_revision TEXT NOT NULL DEFAULT '',
      generated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_character_snapshots_latest
      ON character_snapshots(room_id, character_id, generated_at DESC);

    CREATE TABLE IF NOT EXISTS hoshia_pixel_game_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL,
      total_runs INTEGER NOT NULL DEFAULT 0,
      total_play_seconds INTEGER NOT NULL DEFAULT 0,
      total_kills INTEGER NOT NULL DEFAULT 0,
      best_score INTEGER NOT NULL DEFAULT 0,
      best_level INTEGER NOT NULL DEFAULT 1,
      best_wave INTEGER NOT NULL DEFAULT 0,
      boss_defeated_count INTEGER NOT NULL DEFAULT 0,
      selected_class_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hoshia_pixel_game_class_unlocks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_id TEXT NOT NULL,
      unlocked_at TEXT NOT NULL,
      unlock_reason TEXT NOT NULL,
      PRIMARY KEY (user_id, class_id)
    );

    CREATE TABLE IF NOT EXISTS hoshia_pixel_game_runs (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT,
      status TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 1,
      class_id TEXT NOT NULL,
      seed TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      difficulty_tier TEXT NOT NULL DEFAULT 'B',
      locked_activity TEXT,
      locked_mood TEXT,
      locked_energy INTEGER,
      locked_social_need INTEGER,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      finished_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      waves_cleared INTEGER NOT NULL DEFAULT 0,
      boss_result TEXT NOT NULL DEFAULT 'not_reached',
      result TEXT NOT NULL DEFAULT 'active',
      score_tier TEXT NOT NULL DEFAULT '',
      report_text TEXT NOT NULL DEFAULT '',
      client_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pixel_game_runs_active
      ON hoshia_pixel_game_runs(room_id, user_id, status, expires_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pixel_game_runs_one_active
      ON hoshia_pixel_game_runs(room_id, user_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_pixel_game_runs_leaderboard
      ON hoshia_pixel_game_runs(room_id, accepted, score DESC, finished_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pixel_game_runs_class_leaderboard
      ON hoshia_pixel_game_runs(room_id, class_id, accepted, score DESC);

    CREATE TABLE IF NOT EXISTS hoshia_pixel_game_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES hoshia_pixel_game_runs(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pixel_game_run_events_recent
      ON hoshia_pixel_game_run_events(room_id, occurred_at DESC, id DESC);
  `);
  migrateUsersTable(db);
  migrateHoshiaPostInteractionsTable(db);
  return new LiveRoomDatabase(db);
}

export class LiveRoomDatabase {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }
}
Object.assign(
  LiveRoomDatabase.prototype,
  databaseAccountRepository,
  databaseRoomRepository,
  databaseHoshiaRepository,
  databaseCharacterRepository,
  databaseGameRepository
);
