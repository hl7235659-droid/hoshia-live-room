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

export const databaseAccountRepository = {
  findUserByUsername(username) {
      return this.db.prepare(`
        SELECT id, username, username_normalized, password_hash, nickname, avatar_url, danmaku_color, created_at, last_login_at, total_online_seconds, onboarding_completed, ai_profile_json
        FROM users
        WHERE username_normalized = ?
      `).get(normalizeUsername(username));
    },
  
    findUserById(userId) {
      return this.db.prepare(`
        SELECT id, username, username_normalized, password_hash, nickname, avatar_url, danmaku_color, created_at, last_login_at, total_online_seconds, onboarding_completed, ai_profile_json
        FROM users
        WHERE id = ?
      `).get(userId);
    },
  
    updateLastLogin(userId, now = new Date().toISOString()) {
      this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
    },
  
    updateUserProfile(userId, { nickname, avatarUrl, danmakuColor }) {
      this.db.prepare(`
        UPDATE users
        SET nickname = ?, avatar_url = ?, danmaku_color = ?
        WHERE id = ?
      `).run(nickname, avatarUrl || null, danmakuColor || null, userId);
      return this.findUserById(userId);
    },
  
    updateUserPassword(userId, passwordHash) {
      this.db.prepare(`
        UPDATE users
        SET password_hash = ?
        WHERE id = ?
      `).run(passwordHash, userId);
      return this.findUserById(userId);
    },
  
    completeUserOnboarding(userId, profile) {
      this.db.prepare(`
        UPDATE users
        SET onboarding_completed = 1, ai_profile_json = ?
        WHERE id = ?
      `).run(profile ? JSON.stringify(profile) : null, userId);
      return this.findUserById(userId);
    },
  
    addUserOnlineSeconds(userId, seconds) {
      const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
      if (!safeSeconds) return this.findUserById(userId);
      this.db.prepare(`
        UPDATE users
        SET total_online_seconds = COALESCE(total_online_seconds, 0) + ?
        WHERE id = ?
      `).run(safeSeconds, userId);
      return this.findUserById(userId);
    },
  
    countUsers() {
      const row = this.db.prepare("SELECT COUNT(*) AS total FROM users").get();
      return Number(row.total || 0);
    },
  
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
    },
  
    createUser({ user, now = new Date().toISOString() }) {
      const normalized = normalizeUsername(user.username);
      try {
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
        return this.findUserByUsername(user.username);
      } catch (error) {
        if (isSqliteUniqueError(error)) {
          throw new DatabaseError("username_taken");
        }
        throw error;
      }
    },
  
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
    },
  
    insertRegistrationCode({ id, codeHash, createdAt = new Date().toISOString(), expiresAt = null }) {
      this.db.prepare(`
        INSERT INTO registration_codes (id, code_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(id, codeHash, createdAt, expiresAt);
    },
  
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
    },
  
    insertEmailVerificationCode({ id, email, purpose = "register", codeHash, createdAt = new Date().toISOString(), expiresAt }) {
      this.db.prepare(`
        UPDATE email_verification_codes
        SET used_at = ?
        WHERE email = ? AND purpose = ? AND used_at IS NULL
      `).run(createdAt, normalizeUsername(email), purpose);
      this.db.prepare(`
        INSERT INTO email_verification_codes (id, email, purpose, code_hash, created_at, expires_at, used_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(id, normalizeUsername(email), purpose, codeHash, createdAt, expiresAt);
      return this.getLatestEmailVerificationCode({ email, purpose });
    },
  
    getLatestEmailVerificationCode({ email, purpose = "register" }) {
      return this.db.prepare(`
        SELECT id, email, purpose, code_hash, created_at, expires_at, used_at
        FROM email_verification_codes
        WHERE email = ? AND purpose = ?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 1
      `).get(normalizeUsername(email), purpose) || null;
    },
  
    consumeEmailVerificationCode({ email, purpose = "register", codeHash, now = new Date().toISOString() }) {
      let committed = false;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const code = this.getLatestEmailVerificationCode({ email, purpose });
        if (!code || code.code_hash !== codeHash) {
          throw new DatabaseError("email_code_invalid");
        }
        if (code.used_at) {
          throw new DatabaseError("email_code_used");
        }
        if (Date.parse(code.expires_at) <= Date.parse(now)) {
          throw new DatabaseError("email_code_expired");
        }
        this.db.prepare(`
          UPDATE email_verification_codes
          SET used_at = ?
          WHERE id = ? AND used_at IS NULL
        `).run(now, code.id);
        this.db.exec("COMMIT");
        committed = true;
        return code;
      } catch (error) {
        if (!committed) this.db.exec("ROLLBACK");
        throw error;
      }
    }
};
