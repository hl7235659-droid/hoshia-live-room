import { nanoid } from "nanoid";
import { sanitizeModuleEvent } from "./module-context.js";

const CHARACTER_ID = "hoshia";
const DEFAULT_MIN_DELAY_MINUTES = 3;
const DEFAULT_MAX_DELAY_MINUTES = 20;
const DEFAULT_LIMIT = 10;
const sensitivePattern = /(?:\.env|token=|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|cloudflared|trycloudflare|[A-Za-z]:[\\/]|\/home\/ubuntu|\b\d{1,3}(?:\.\d{1,3}){3}\b|https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.))/i;

export function createHoshiaCommentReplyService({
  db,
  lifeMemoryService,
  moduleEventStore = null,
  generator,
  replyGenerator,
  clock = () => new Date(),
  random = Math.random,
  minDelayMinutes = DEFAULT_MIN_DELAY_MINUTES,
  maxDelayMinutes = DEFAULT_MAX_DELAY_MINUTES,
  defaultLimit = DEFAULT_LIMIT
} = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  const generateReply = generator || replyGenerator || defaultCommentReplyGenerator;
  if (typeof generateReply !== "function") {
    throw new Error("generator must be a function");
  }

  const delayConfig = normalizeCommentReplyDelayConfig(minDelayMinutes, maxDelayMinutes);

  return {
    pendingFields({ now = clock(), minDelayMinutes: min = delayConfig.minMinutes, maxDelayMinutes: max = delayConfig.maxMinutes, random: localRandom = random } = {}) {
      const localDelay = normalizeCommentReplyDelayConfig(min, max);
      return {
        reply_status: "pending",
        reply_due_at: dueAt(now, localDelay, localRandom),
        replied_at: ""
      };
    },

    scheduleCommentReply({ comment, now = clock() } = {}) {
      if (!isComment(comment)) return null;
      const replyDueAt = dueAt(now, delayConfig, random);
      if (typeof db.markHoshiaCommentReplyPending === "function") {
        return db.markHoshiaCommentReplyPending({
          commentId: comment.id,
          replyDueAt,
          now: toIso(now)
        });
      }
      if (typeof db.markHoshiaPostCommentReplyStatus === "function") {
        return db.markHoshiaPostCommentReplyStatus(comment.id, {
          status: "pending",
          replyDueAt,
          repliedAt: ""
        });
      }
      return {
        ...comment,
        reply_status: "pending",
        reply_due_at: replyDueAt
      };
    },

    async processDueReplies({ limit = defaultLimit, now = clock() } = {}) {
      return processDue({
        db,
        lifeMemoryService,
        moduleEventStore,
        generator: generateReply,
        limit,
        defaultLimit,
        now
      });
    },

    async processDueComments({ limit = defaultLimit, now = clock() } = {}) {
      const result = await processDue({
        db,
        lifeMemoryService,
        moduleEventStore,
        generator: generateReply,
        limit,
        defaultLimit,
        now
      });
      return {
        ok: true,
        processed_count: result.replied,
        failed_count: result.failed,
        scanned_count: result.scanned,
        skipped_count: result.skipped,
        items: result.results
      };
    }
  };
}

export async function defaultCommentReplyGenerator({ post, comment } = {}) {
  const nickname = cleanText(comment?.nickname, 24) || "你";
  const activity = cleanIdentifier(post?.activity, 32);
  const mood = cleanIdentifier(post?.mood, 32);
  const commentText = cleanText(comment?.content, 120);
  const prefix = activity === "gaming"
    ? "刚打完一小局才看到评论"
    : "刚回来看了一眼动态";
  const moodTail = mood === "annoyed"
    ? "我才没有被戳到，只是记下来了。"
    : "这条我先记着啦。";
  const echo = commentText ? `你刚才说“${commentText}”，` : "";
  return `${prefix}，${nickname}，${echo}${moodTail}`;
}

export const defaultReplyGenerator = defaultCommentReplyGenerator;

export function normalizeCommentReplyDelayConfig(minValue, maxValue) {
  let minMinutes = clampInt(minValue, 0, 1440, DEFAULT_MIN_DELAY_MINUTES);
  let maxMinutes = clampInt(maxValue, 0, 1440, DEFAULT_MAX_DELAY_MINUTES);
  if (minMinutes > maxMinutes) {
    [minMinutes, maxMinutes] = [maxMinutes, minMinutes];
  }
  return { minMinutes, maxMinutes };
}

export function createHoshiaCommentReplyGeneratedEvent({ post, comment, reply, roomId = "" } = {}) {
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "hoshia_posts",
    event_type: "hoshia_posts.comment_replied",
    user_id: comment?.user_id || "",
    nickname: comment?.nickname || "",
    summary_hint: `Hoshia replied to ${cleanText(comment?.nickname, 32) || "a viewer"} on a post.`,
    memory_eligible: true,
    memory_kind: "post_reply",
    retention_days: 45,
    occurred_at: reply?.created_at || new Date().toISOString(),
    data: {
      activity: post?.activity,
      mood: post?.mood,
      reason: "async_comment_reply"
    }
  });
}

async function processDue({
  db,
  lifeMemoryService,
  moduleEventStore,
  generator,
  limit,
  defaultLimit,
  now
}) {
  const nowIso = toIso(now);
  const dueComments = listDueComments(db, {
    now: nowIso,
    limit: clampInt(limit, 1, 50, defaultLimit)
  });
  const results = [];

  for (const rawComment of dueComments) {
    const dueComment = normalizeDueComment(rawComment);
    const result = await processOneDueComment({
      db,
      lifeMemoryService,
      moduleEventStore,
      generator,
      dueComment,
      now: nowIso
    });
    results.push(result);
  }

  return {
    scanned: results.length,
    replied: results.filter((item) => item.status === "replied").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results
  };
}

function listDueComments(db, options) {
  if (typeof db.listDueHoshiaCommentReplies === "function") {
    return db.listDueHoshiaCommentReplies(options) || [];
  }
  if (typeof db.listDueHoshiaPostComments === "function") {
    return db.listDueHoshiaPostComments(options) || [];
  }
  throw new Error("db.listDueHoshiaCommentReplies is required");
}

async function processOneDueComment({
  db,
  lifeMemoryService,
  moduleEventStore,
  generator,
  dueComment,
  now
}) {
  if (!isComment(dueComment)) {
    return skipped(dueComment, "not_comment");
  }

  const post = dueComment.post || postFromDueRow(dueComment) || (typeof db.getHoshiaPost === "function"
    ? db.getHoshiaPost(dueComment.post_id)
    : null);
  if (!post?.id) {
    return failComment(db, dueComment, "post_not_found", now);
  }

  try {
    const memoryPacket = typeof lifeMemoryService?.buildMemoryPacket === "function"
      ? lifeMemoryService.buildMemoryPacket({
        session: { user_id: dueComment.user_id, nickname: dueComment.nickname },
        query: `${post.content || ""} ${dueComment.content || ""}`,
        scene: "post_comment_reply",
        postId: post.id,
        limit: 6
      })
      : [];
    const generated = await generator({
      post,
      comment: dueComment,
      memoryPacket,
      now,
      lifeMemoryService
    });
    const content = normalizeGeneratedContent(generated);
    if (!content) {
      return failComment(db, dueComment, "reply_invalid", now);
    }

    if (typeof db.addHoshiaPostInteraction !== "function") {
      throw new Error("db.addHoshiaPostInteraction is required");
    }

    const reply = db.addHoshiaPostInteraction({
      id: objectId(generated) || `reply_${dueComment.id}_${nanoid(8)}`,
      post_id: dueComment.post_id,
      user_id: CHARACTER_ID,
      nickname: "Hoshia",
      type: "reply",
      content,
      parent_interaction_id: dueComment.id,
      created_at: now
    });
    if (!reply) {
      return failComment(db, dueComment, "reply_insert_failed", now);
    }

    if (typeof lifeMemoryService?.recordInteraction === "function") {
      lifeMemoryService.recordInteraction({ post, interaction: reply });
    }

    markReplied(db, dueComment, reply, now);

    if (typeof moduleEventStore?.append === "function") {
      moduleEventStore.append(createHoshiaCommentReplyGeneratedEvent({
        post,
        comment: dueComment,
        reply
      }));
    }

    return {
      status: "replied",
      comment_id: dueComment.id,
      reply_id: reply.id
    };
  } catch (error) {
    return failComment(db, dueComment, cleanText(error?.message, 80) || "reply_failed", now);
  }
}

function markReplied(db, comment, reply, now) {
  if (typeof db.markHoshiaCommentReplyReplied === "function") {
    db.markHoshiaCommentReplyReplied({
      commentId: comment.id,
      replyId: reply.id,
      repliedAt: now
    });
    return;
  }
  if (typeof db.markHoshiaPostCommentReplyStatus === "function") {
    db.markHoshiaPostCommentReplyStatus(comment.id, {
      status: "replied",
      replyId: reply.id,
      replyDueAt: comment.reply_due_at || "",
      repliedAt: now
    });
  }
}

function normalizeGeneratedContent(generated) {
  const content = cleanText(typeof generated === "string" ? generated : generated?.content, 500);
  if (!content || sensitivePattern.test(content)) return "";
  return content;
}

function objectId(value) {
  return value && typeof value === "object" ? cleanIdentifier(value.id, 80) : "";
}

function failComment(db, comment, reason, now) {
  const cleanReason = cleanIdentifier(reason, 80) || "reply_failed";
  if (typeof db.markHoshiaCommentReplyFailed === "function" && comment?.id) {
    db.markHoshiaCommentReplyFailed({
      commentId: comment.id,
      reason: cleanReason,
      failedAt: now
    });
  } else if (typeof db.markHoshiaPostCommentReplyStatus === "function" && comment?.id) {
    db.markHoshiaPostCommentReplyStatus(comment.id, {
      status: "failed",
      reason: cleanReason,
      replyDueAt: comment.reply_due_at || "",
      repliedAt: now
    });
  }
  return {
    status: "failed",
    comment_id: comment?.id || "",
    reason: cleanReason
  };
}

function skipped(comment, reason) {
  return {
    status: "skipped",
    comment_id: comment?.id || "",
    reason
  };
}

function isComment(interaction) {
  return interaction?.id && interaction.type === "comment";
}

function dueAt(now, delayConfig, random) {
  const base = new Date(toIso(now));
  const spread = delayConfig.maxMinutes - delayConfig.minMinutes;
  const offset = delayConfig.minMinutes + Math.floor(spread * clampNumber(random(), 0, 1, 0));
  return new Date(base.getTime() + offset * 60000).toISOString();
}

function normalizeDueComment(row) {
  if (!row || typeof row !== "object") return row;
  if (row.post) return row;
  return {
    id: row.id,
    post_id: row.post_id,
    user_id: row.user_id || "",
    nickname: row.nickname || "viewer",
    type: row.type,
    content: row.content || "",
    parent_interaction_id: row.parent_interaction_id || "",
    reply_status: row.reply_status || "",
    reply_due_at: row.reply_due_at || "",
    replied_at: row.replied_at || "",
    created_at: row.created_at || "",
    post: postFromDueRow(row)
  };
}

function postFromDueRow(row) {
  if (!row?.post_content && !row?.post_mood && !row?.post_activity) return null;
  return {
    id: row.post_id,
    character_id: row.character_id || CHARACTER_ID,
    content: row.post_content || "",
    image_url: row.post_image_url || "",
    mood: row.post_mood || "",
    activity: row.post_activity || "",
    source_type: row.source_type || "",
    created_at: row.post_created_at || "",
    updated_at: row.post_updated_at || ""
  };
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanIdentifier(value, maxLength = 48) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, maxLength);
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}
