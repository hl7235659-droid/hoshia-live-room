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

export const databaseHoshiaRepository = {
  getHoshiaState(characterId = "hoshia") {
      return this.db.prepare(`
        SELECT character_id, mood, activity, energy, social_need, current_png, state_reason, updated_at
        FROM hoshia_state
        WHERE character_id = ?
      `).get(characterId) || null;
    },
  
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
    },
  
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
    },
  
    getHoshiaPost(postId) {
      return this.db.prepare(`
        SELECT id, character_id, content, image_url, mood, activity, source_type, created_at, updated_at
        FROM hoshia_posts
        WHERE id = ?
      `).get(postId) || null;
    },
  
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
    },
  
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
    },
  
    getHoshiaPostInteraction(id) {
      const row = this.db.prepare(`
        SELECT id, post_id, user_id, nickname, type, content, parent_interaction_id, reply_status, reply_due_at, replied_at, created_at
        FROM hoshia_post_interactions
        WHERE id = ?
      `).get(id) || null;
      return row ? compactPostInteraction(row) : null;
    },
  
    listHoshiaPostInteractions(postId) {
      return this.db.prepare(`
        SELECT id, post_id, user_id, COALESCE(nickname, '') AS nickname, type, COALESCE(content, '') AS content, COALESCE(parent_interaction_id, '') AS parent_interaction_id, COALESCE(reply_status, '') AS reply_status, COALESCE(reply_due_at, '') AS reply_due_at, COALESCE(replied_at, '') AS replied_at, created_at
        FROM hoshia_post_interactions
        WHERE post_id = ?
        ORDER BY datetime(created_at) ASC, id ASC
      `).all(postId).map(compactPostInteraction);
    },
  
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
    },
  
    listDueHoshiaCommentReplies(options = {}) {
      return this.listDueHoshiaPostComments(options);
    },
  
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
    },
  
    markHoshiaCommentReplyPending({ commentId, replyDueAt } = {}) {
      return this.markHoshiaPostCommentReplyStatus(commentId, {
        status: "pending",
        replyDueAt,
        repliedAt: ""
      });
    },
  
    markHoshiaCommentReplyReplied({ commentId, repliedAt } = {}) {
      const comment = this.getHoshiaPostInteraction(commentId);
      return this.markHoshiaPostCommentReplyStatus(commentId, {
        status: "replied",
        replyDueAt: comment?.reply_due_at || "",
        repliedAt
      });
    },
  
    markHoshiaCommentReplyFailed({ commentId, failedAt } = {}) {
      const comment = this.getHoshiaPostInteraction(commentId);
      return this.markHoshiaPostCommentReplyStatus(commentId, {
        status: "failed",
        replyDueAt: comment?.reply_due_at || "",
        repliedAt: failedAt
      });
    },
  
    markHoshiaCommentReplySkipped({ commentId, skippedAt } = {}) {
      const comment = this.getHoshiaPostInteraction(commentId);
      return this.markHoshiaPostCommentReplyStatus(commentId, {
        status: "skipped",
        replyDueAt: comment?.reply_due_at || "",
        repliedAt: skippedAt
      });
    },
  
    countHoshiaPostsBySourceOnDate({ sourceType, date, characterId = "hoshia" } = {}) {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS total
        FROM hoshia_posts
        WHERE character_id = ?
          AND source_type = ?
          AND substr(created_at, 1, 10) = ?
      `).get(characterId, sourceType, date);
      return Number(row?.total || 0);
    },
  
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
    },
  
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
    },
  
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
    },
  
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
    },
  
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
    },
  
    getHoshiaLifeMemory(id) {
      const row = this.db.prepare(`
        SELECT id, character_id, user_id, type, source, source_id, content, importance, emotion, tags_json, created_at, last_accessed_at, expires_at
        FROM hoshia_life_memories
        WHERE id = ?
      `).get(id);
      return row ? normalizeLifeMemoryRow(row) : null;
    },
  
    updateHoshiaLifeMemory({
      id,
      content,
      importance = null,
      emotion = null,
      tags = null,
      expires_at = null,
      last_accessed_at = new Date().toISOString()
    } = {}) {
      const existing = this.getHoshiaLifeMemory(id);
      if (!existing) return null;
      this.db.prepare(`
        UPDATE hoshia_life_memories
        SET content = ?,
            importance = ?,
            emotion = ?,
            tags_json = ?,
            expires_at = ?,
            last_accessed_at = ?
        WHERE id = ?
      `).run(
        String(content || ""),
        importance === null ? Number(existing.importance || 0.5) : Math.max(0, Math.min(Number(importance) || 0.5, 1)),
        emotion === null ? (existing.emotion || null) : (emotion || null),
        JSON.stringify(Array.isArray(tags) ? tags : existing.tags || []),
        expires_at === null ? existing.expires_at || null : expires_at,
        last_accessed_at || null,
        id
      );
      return this.getHoshiaLifeMemory(id);
    },
  
    upsertHoshiaLifeMemory({
      id,
      character_id = "hoshia",
      user_id = "",
      type = "event",
      source = "system",
      source_id = "",
      content = "",
      importance = 0.5,
      emotion = "",
      tags = [],
      created_at = new Date().toISOString(),
      last_accessed_at = null,
      expires_at = null
    } = {}) {
      const existing = this.getHoshiaLifeMemory(id);
      if (existing) {
        return this.updateHoshiaLifeMemory({
          id,
          content,
          importance,
          emotion,
          tags,
          expires_at,
          last_accessed_at: last_accessed_at || created_at
        });
      }
      return this.addHoshiaLifeMemory({
        id,
        character_id,
        user_id,
        type,
        source,
        source_id,
        content,
        importance,
        emotion,
        tags,
        created_at,
        last_accessed_at,
        expires_at
      });
    },
  
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
    },
  
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
    },
  
    getUserCharacterProfile(userId, characterId = "hoshia") {
      return this.db.prepare(`
        SELECT user_id, character_id, familiarity, trust, teasing_level, preferred_topics, interaction_style, summary, updated_at
        FROM user_character_profiles
        WHERE user_id = ? AND character_id = ?
      `).get(userId, characterId) || null;
    }
};
