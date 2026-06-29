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

export const databaseGameRepository = {
  getPixelGameProfile(userId, roomId = "") {
      return this.db.prepare(`
        SELECT user_id, room_id, total_runs, total_play_seconds, total_kills, best_score, best_level, best_wave, boss_defeated_count, COALESCE(selected_class_id, '') AS selected_class_id, created_at, updated_at
        FROM hoshia_pixel_game_profiles
        WHERE user_id = ? AND (? = '' OR room_id = ?)
      `).get(userId, roomId || "", roomId || "") || null;
    },
  
    ensurePixelGameProfile({ userId, roomId, now = new Date().toISOString() } = {}) {
      this.db.prepare(`
        INSERT OR IGNORE INTO hoshia_pixel_game_profiles (
          user_id, room_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run(userId, roomId, now, now);
      return this.getPixelGameProfile(userId, roomId);
    },
  
    listPixelGameClassUnlocks(userId) {
      return this.db.prepare(`
        SELECT user_id, class_id, unlocked_at, unlock_reason
        FROM hoshia_pixel_game_class_unlocks
        WHERE user_id = ?
        ORDER BY unlocked_at ASC, class_id ASC
      `).all(userId);
    },
  
    unlockPixelGameClass({ userId, classId, reason = "progress", now = new Date().toISOString() } = {}) {
      this.db.prepare(`
        INSERT OR IGNORE INTO hoshia_pixel_game_class_unlocks (user_id, class_id, unlocked_at, unlock_reason)
        VALUES (?, ?, ?, ?)
      `).run(userId, classId, now, reason || "progress");
      return this.listPixelGameClassUnlocks(userId).find((item) => item.class_id === classId) || null;
    },
  
    getActivePixelGameRun({ roomId, userId, now = new Date().toISOString() } = {}) {
      return this.db.prepare(`
        SELECT *
        FROM hoshia_pixel_game_runs
        WHERE room_id = ? AND user_id = ? AND status = 'active' AND datetime(expires_at) > datetime(?)
        ORDER BY datetime(started_at) DESC, id DESC
        LIMIT 1
      `).get(roomId, userId, now) || null;
    },
  
    expirePixelGameRuns({ roomId, userId = "", now = new Date().toISOString() } = {}) {
      this.db.prepare(`
        UPDATE hoshia_pixel_game_runs
        SET status = 'expired', result = 'expired', updated_at = ?
        WHERE room_id = ?
          AND status = 'active'
          AND datetime(expires_at) <= datetime(?)
          AND (? = '' OR user_id = ?)
      `).run(now, roomId, now, userId || "", userId || "");
    },
  
    createPixelGameRun(run) {
      this.db.prepare(`
        INSERT INTO hoshia_pixel_game_runs (
          id, room_id, user_id, nickname, status, accepted, class_id, seed, stage_id, difficulty_tier,
          locked_activity, locked_mood, locked_energy, locked_social_need,
          started_at, expires_at, client_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.room_id,
        run.user_id,
        run.nickname || null,
        run.class_id,
        run.seed,
        run.stage_id,
        run.difficulty_tier || "B",
        run.locked_activity || "",
        run.locked_mood || "",
        Number(run.locked_energy || 0),
        Number(run.locked_social_need || 0),
        run.started_at,
        run.expires_at,
        run.client_version || null,
        run.created_at || run.started_at,
        run.updated_at || run.started_at
      );
      return this.getPixelGameRun(run.id);
    },
  
    getPixelGameRun(runId) {
      return this.db.prepare(`
        SELECT *
        FROM hoshia_pixel_game_runs
        WHERE id = ?
      `).get(runId) || null;
    },
  
    getPixelGameRunForUser({ runId, roomId, userId } = {}) {
      return this.db.prepare(`
        SELECT *
        FROM hoshia_pixel_game_runs
        WHERE id = ? AND room_id = ? AND user_id = ?
      `).get(runId, roomId, userId) || null;
    },
  
    finishPixelGameRun({ runId, roomId, userId, accepted, finishedAt, durationSeconds, score, kills, level, wavesCleared, bossResult, result, scoreTier, reportText = "" } = {}) {
      let committed = false;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getPixelGameRunForUser({ runId, roomId, userId });
        if (!existing) {
          this.db.exec("ROLLBACK");
          committed = true;
          return null;
        }
        if (existing.status !== "active") {
          this.db.exec("COMMIT");
          committed = true;
          return { ...existing, already_finished: true };
        }
        const safeAccepted = accepted ? 1 : 0;
        this.db.prepare(`
          UPDATE hoshia_pixel_game_runs
          SET status = 'finished', accepted = ?, finished_at = ?, duration_seconds = ?, score = ?, kills = ?, level = ?, waves_cleared = ?, boss_result = ?, result = ?, score_tier = ?, report_text = ?, updated_at = ?
          WHERE id = ? AND room_id = ? AND user_id = ? AND status = 'active'
        `).run(
          safeAccepted,
          finishedAt,
          durationSeconds,
          score,
          kills,
          level,
          wavesCleared,
          bossResult,
          result,
          scoreTier,
          reportText || "",
          finishedAt,
          runId,
          roomId,
          userId
        );
        if (safeAccepted) {
          this.ensurePixelGameProfile({ userId, roomId, now: finishedAt });
          this.db.prepare(`
            UPDATE hoshia_pixel_game_profiles
            SET total_runs = total_runs + 1,
                total_play_seconds = total_play_seconds + ?,
                total_kills = total_kills + ?,
                best_score = MAX(best_score, ?),
                best_level = MAX(best_level, ?),
                best_wave = MAX(best_wave, ?),
                boss_defeated_count = boss_defeated_count + ?,
                selected_class_id = ?,
                updated_at = ?
            WHERE user_id = ? AND room_id = ?
          `).run(
            durationSeconds,
            kills,
            score,
            level,
            wavesCleared,
            bossResult === "defeated" ? 1 : 0,
            existing.class_id,
            finishedAt,
            userId,
            roomId
          );
        }
        this.db.exec("COMMIT");
        committed = true;
        return this.getPixelGameRun(runId);
      } catch (error) {
        if (!committed) this.db.exec("ROLLBACK");
        throw error;
      }
    },
  
    abandonPixelGameRun({ runId, roomId, userId, now = new Date().toISOString() } = {}) {
      this.db.prepare(`
        UPDATE hoshia_pixel_game_runs
        SET status = 'abandoned', accepted = 0, result = 'abandoned', finished_at = ?, updated_at = ?
        WHERE id = ? AND room_id = ? AND user_id = ? AND status = 'active'
      `).run(now, now, runId, roomId, userId);
      return this.getPixelGameRunForUser({ runId, roomId, userId });
    },
  
    listPixelGameLeaderboard({ roomId, classId = "", limit = 10 } = {}) {
      const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 10), 50));
      return this.db.prepare(`
        SELECT id, room_id, user_id, COALESCE(nickname, '') AS nickname, class_id, stage_id, difficulty_tier, score, kills, level, waves_cleared, boss_result, result, score_tier, duration_seconds, finished_at
        FROM hoshia_pixel_game_runs
        WHERE room_id = ? AND status = 'finished' AND accepted = 1 AND (? = '' OR class_id = ?)
        ORDER BY score DESC, waves_cleared DESC, datetime(finished_at) ASC, id ASC
        LIMIT ?
      `).all(roomId, classId || "", classId || "", safeLimit);
    },
  
    insertPixelGameRunEvent({ id, runId, roomId, userId, eventType, summary, data = {}, occurredAt = new Date().toISOString(), createdAt = occurredAt } = {}) {
      this.db.prepare(`
        INSERT INTO hoshia_pixel_game_run_events (id, run_id, room_id, user_id, event_type, summary, data_json, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, runId, roomId, userId, eventType, summary, JSON.stringify(data || {}), occurredAt, createdAt);
      return { id, run_id: runId, room_id: roomId, user_id: userId, event_type: eventType, summary, data_json: JSON.stringify(data || {}), occurred_at: occurredAt, created_at: createdAt };
    },
  
    listRecentPixelGameEvents({ roomId, userId = "", limit = 12 } = {}) {
      const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 12), 50));
      return this.db.prepare(`
        SELECT id, run_id, room_id, user_id, event_type, summary, data_json, occurred_at, created_at
        FROM hoshia_pixel_game_run_events
        WHERE room_id = ? AND (? = '' OR user_id = ?)
        ORDER BY datetime(occurred_at) DESC, id DESC
        LIMIT ?
      `).all(roomId, userId || "", userId || "", safeLimit).map((row) => ({
        ...row,
        data: parseJsonObject(row.data_json)
      }));
    }
};
