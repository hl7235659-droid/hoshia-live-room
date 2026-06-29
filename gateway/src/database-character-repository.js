import { DatabaseError } from "./database-error.js";
import {
  compactContextMessage,
  compactPostInteraction,
  dayKeyForTimeZone,
  defaultSummaryTimeZone,
  isDisplayableRoomMessage,
  isSqliteUniqueError,
  memorySearchTerms,
  normalizeLifeMemoryRow,
  normalizePublicColor,
  normalizeUsername,
  parseJsonObject,
  scoreMemory
} from "./database-utils.js";

export const databaseCharacterRepository = {
  insertCharacterEvent(event, now = new Date().toISOString()) {
      const payload = {
        event_id: event.event_id,
        idempotency_key: event.idempotency_key,
        schema_version: Number(event.schema_version || 1),
        character_id: event.character_id || "hoshia",
        room_id: event.room_id,
        event_type: event.event_type,
        actor_type: event.actor_type || "system",
        user_id: event.user_id || null,
        nickname: event.nickname || null,
        source_kind: event.source_kind || "system",
        source_id: event.source_id || null,
        occurred_at: event.occurred_at || now,
        received_at: event.received_at || now,
        visibility: event.visibility || "public",
        public_hint: event.public_hint || "",
        private_hint: event.private_hint || "",
        reason: event.reason || "",
        data_json: event.data_json || "{}",
        raw_text_stored: event.raw_text_stored ? 1 : 0,
        created_at: now
      };
      this.db.prepare(`
        INSERT OR IGNORE INTO character_events (
          event_id,
          idempotency_key,
          schema_version,
          character_id,
          room_id,
          event_type,
          actor_type,
          user_id,
          nickname,
          source_kind,
          source_id,
          occurred_at,
          received_at,
          visibility,
          public_hint,
          private_hint,
          reason,
          data_json,
          raw_text_stored,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.event_id,
        payload.idempotency_key,
        payload.schema_version,
        payload.character_id,
        payload.room_id,
        payload.event_type,
        payload.actor_type,
        payload.user_id,
        payload.nickname,
        payload.source_kind,
        payload.source_id,
        payload.occurred_at,
        payload.received_at,
        payload.visibility,
        payload.public_hint,
        payload.private_hint,
        payload.reason,
        payload.data_json,
        payload.raw_text_stored,
        payload.created_at
      );
      return this.getCharacterEventByIdempotencyKey(payload.idempotency_key);
    },
  
    getCharacterEventByIdempotencyKey(idempotencyKey) {
      return this.db.prepare(`
        SELECT event_id, idempotency_key, schema_version, character_id, room_id, event_type, actor_type, user_id, nickname, source_kind, source_id, occurred_at, received_at, visibility, public_hint, private_hint, reason, data_json, raw_text_stored, applied_to_snapshot, applied_at, dedupe_status, created_at
        FROM character_events
        WHERE idempotency_key = ?
      `).get(idempotencyKey) || null;
    },
  
    listRecentCharacterEvents({ roomId, characterId = "hoshia", limit = 20 } = {}) {
      const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 20), 100));
      return this.db.prepare(`
        SELECT event_id, idempotency_key, schema_version, character_id, room_id, event_type, actor_type, user_id, nickname, source_kind, source_id, occurred_at, received_at, visibility, public_hint, private_hint, reason, data_json, raw_text_stored, applied_to_snapshot, applied_at, dedupe_status, created_at
        FROM character_events
        WHERE room_id = ? AND character_id = ?
        ORDER BY datetime(occurred_at) DESC, event_id DESC
        LIMIT ?
      `).all(roomId, characterId, safeLimit);
    },
  
    upsertCharacterSnapshot({ roomId, characterId = "hoshia", snapshot, generatedAt = new Date().toISOString() } = {}) {
      if (!snapshot?.snapshot_id) return null;
      this.db.prepare(`
        INSERT OR REPLACE INTO character_snapshots (
          snapshot_id,
          character_id,
          room_id,
          snapshot_json,
          source_revision,
          generated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.snapshot_id,
        characterId,
        roomId,
        JSON.stringify(snapshot),
        snapshot.source_revision || "",
        generatedAt,
        generatedAt
      );
      return snapshot;
    },
  
    getLatestCharacterSnapshot({ roomId, characterId = "hoshia" } = {}) {
      const row = this.db.prepare(`
        SELECT snapshot_json
        FROM character_snapshots
        WHERE room_id = ? AND character_id = ?
        ORDER BY datetime(generated_at) DESC, snapshot_id DESC
        LIMIT 1
      `).get(roomId, characterId);
      if (!row) return null;
      try {
        return JSON.parse(row.snapshot_json);
      } catch {
        return null;
      }
    },
  
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
};
