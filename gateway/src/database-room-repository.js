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

export const databaseRoomRepository = {
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
    },
  
    listRecentRoomMessages(roomId, limit = 100) {
      const rows = this.db.prepare(`
        SELECT event_json
        FROM room_messages
        WHERE room_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(roomId, limit);
      return rows.reverse()
        .map((row) => JSON.parse(row.event_json))
        .filter(isDisplayableRoomMessage);
    },
  
    listRecentContextMessages(roomId, limit = 100) {
      const rows = this.db.prepare(`
        SELECT id, room_id, type, role, user_id, nickname, text, event_json, timestamp, created_at
        FROM room_messages
        WHERE room_id = ?
          AND role IN ('user', 'ai')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(roomId, limit);
      return rows.reverse().map(compactContextMessage);
    },
  
    listContextMessagesAfter(roomId, afterCreatedAt = "", afterId = "", limit = 600) {
      const rows = this.db.prepare(`
        SELECT id, room_id, type, role, user_id, nickname, text, event_json, timestamp, created_at
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
    },
  
    getRoomContextSummary(roomId) {
      return this.db.prepare(`
        SELECT room_id, summary_text, summarized_until_created_at, summarized_until_id, coverage_start_timestamp, coverage_end_timestamp, updated_at
        FROM room_context_summaries
        WHERE room_id = ?
      `).get(roomId) || null;
    },
  
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
};
