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
  aiReplyGenerator,
  shadowGenerator = null,
  visualStateProvider = null,
  moduleContextProvider = null,
  moduleEventsProvider = null,
  config = {},
  dailyReplyLimit = 20,
  clock = () => new Date(),
  random = Math.random,
  minDelayMinutes = DEFAULT_MIN_DELAY_MINUTES,
  maxDelayMinutes = DEFAULT_MAX_DELAY_MINUTES,
  defaultLimit = DEFAULT_LIMIT,
  maxRepliesPerTick = 2
} = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  const generateReply = aiReplyGenerator || generator || replyGenerator || null;
  if (generateReply && typeof generateReply !== "function") {
    throw new Error("generator must be a function");
  }
  if (shadowGenerator && typeof shadowGenerator !== "function") {
    throw new Error("shadowGenerator must be a function");
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

    async processDueReplies({ limit = defaultLimit, force = false, now = clock(), shadow = false, shadowOnly = false, recordMetric = null } = {}) {
      return processDue({
        db,
        lifeMemoryService,
        moduleEventStore,
        generator: generateReply,
        shadowGenerator,
        visualStateProvider,
        moduleContextProvider,
        moduleEventsProvider,
        config,
        dailyReplyLimit,
        limit,
        force,
        shadowOnly: Boolean(shadow || shadowOnly),
        recordMetric,
        defaultLimit,
        maxRepliesPerTick,
        now
      });
    },

    async processDueComments({ limit = defaultLimit, force = false, now = clock(), shadow = false, shadowOnly = false, recordMetric = null } = {}) {
      const result = await processDue({
        db,
        lifeMemoryService,
        moduleEventStore,
        generator: generateReply,
        shadowGenerator,
        visualStateProvider,
        moduleContextProvider,
        moduleEventsProvider,
        config,
        dailyReplyLimit,
        limit,
        force,
        shadowOnly: Boolean(shadow || shadowOnly),
        recordMetric,
        defaultLimit,
        maxRepliesPerTick,
        now
      });
      return {
        ok: true,
        processed_count: result.replied,
        failed_count: result.failed,
        scanned_count: result.scanned,
        skipped_count: result.skipped,
        shadowed_count: result.shadowed,
        items: result.results
      };
    }
  };
}

export async function defaultCommentReplyGenerator({ post, comment } = {}) {
  const nickname = cleanText(comment?.nickname, 24) || "\u4f60";
  const activity = cleanIdentifier(post?.activity, 32);
  const mood = cleanIdentifier(post?.mood, 32);
  const commentText = cleanText(comment?.content, 120);
  const prefix = activity === "gaming"
    ? "\u521a\u6253\u5b8c\u4e00\u5c0f\u5c40\u624d\u770b\u5230\u8bc4\u8bba"
    : "\u521a\u56de\u6765\u770b\u4e86\u4e00\u773c\u52a8\u6001";
  const moodTail = mood === "annoyed"
    ? "\u6211\u624d\u6ca1\u6709\u88ab\u6233\u5230\uff0c\u53ea\u662f\u8bb0\u4e0b\u6765\u4e86\u3002"
    : "\u8fd9\u6761\u6211\u5148\u8bb0\u7740\u5566\u3002";
  const echo = commentText ? `\u4f60\u521a\u624d\u8bf4\u201c${commentText}\u201d\uff0c` : "";
  return `${prefix}\uff0c${nickname}\uff0c${echo}${moodTail}`;
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

export function commentReplyRolloutForInteraction(input = {}, {
  asyncEnabled = true,
  mode = "live",
  greyPercent = 100
} = {}) {
  if (!asyncEnabled) {
    return { mode: "off", shouldSchedule: false, reason: "async_comment_reply_disabled" };
  }
  const rolloutMode = ["live", "shadow", "off"].includes(mode) ? mode : "live";
  if (rolloutMode === "off") {
    return { mode: rolloutMode, shouldSchedule: false, reason: "rollout_off" };
  }
  const percent = clampNumber(greyPercent, 0, 100, 100);
  if (percent <= 0) {
    return { mode: rolloutMode, shouldSchedule: false, reason: "grey_percent_zero" };
  }
  const seed = input?.id || `${input?.post_id || ""}:${input?.user_id || ""}:${input?.created_at || ""}`;
  const bucket = stablePercentBucket(seed);
  return {
    mode: rolloutMode,
    shouldSchedule: bucket < percent,
    reason: bucket < percent ? "scheduled" : "grey_percent_skip",
    bucket
  };
}

export function stablePercentBucket(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export const deterministicCommentReplyGreyBucket = stablePercentBucket;

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
  shadowGenerator,
  visualStateProvider,
  moduleContextProvider,
  moduleEventsProvider,
  config,
  dailyReplyLimit,
  limit,
  force,
  shadowOnly,
  recordMetric,
  defaultLimit,
  maxRepliesPerTick,
  now
}) {
  const nowIso = toIso(now);
  const dueComments = listDueComments(db, {
    now: nowIso,
    limit: clampInt(limit, 1, 50, defaultLimit),
    force: Boolean(force)
  });
  const normalizedComments = dueComments.map((rawComment) => normalizeDueComment(rawComment));
  const remainingDailyReplies = Math.max(0, clampInt(dailyReplyLimit, 0, 100, 20) - countRepliesToday(db, nowIso));
  const perTickReplyLimit = clampInt(maxRepliesPerTick, 1, 2, 2);
  const replyLimit = shadowOnly ? perTickReplyLimit : Math.min(perTickReplyLimit, remainingDailyReplies);
  if (replyLimit <= 0) {
    return {
      scanned: normalizedComments.length,
      replied: 0,
      failed: 0,
      skipped: normalizedComments.length,
      shadowed: 0,
      results: normalizedComments.map((comment) => skipped(comment, "daily_reply_limit_reached"))
    };
  }
  const selectedIds = new Set(selectReplyCandidates(normalizedComments, replyLimit).map((item) => item.id));
  const results = [];

  for (const dueComment of normalizedComments) {
    if (isComment(dueComment) && !selectedIds.has(dueComment.id)) {
      if (!shadowOnly) {
        markSkipped(db, dueComment, nowIso);
      } else {
        const post = dueComment.post || postFromDueRow(dueComment) || (typeof db.getHoshiaPost === "function"
          ? db.getHoshiaPost(dueComment.post_id)
          : null);
        const result = commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.skip", {
          reason: "low_priority_comment",
          source: "gateway"
        });
        recordCommentReplyShadowMetric(recordMetric, result, {
          comment: dueComment,
          post
        });
      }
      results.push(skipped(dueComment, "low_priority"));
      continue;
    }
    const result = await processOneDueComment({
      db,
      lifeMemoryService,
      moduleEventStore,
      generator,
      shadowGenerator,
      visualStateProvider,
      moduleContextProvider,
      moduleEventsProvider,
      config,
      dueComment,
      shadowOnly,
      recordMetric,
      now: nowIso
    });
    results.push(result);
  }

  return {
    scanned: results.length,
    replied: results.filter((item) => item.status === "replied").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    shadowed: results.filter((item) => item.status === "shadowed").length,
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
  shadowGenerator,
  visualStateProvider,
  moduleContextProvider,
  moduleEventsProvider,
  config,
  dueComment,
  shadowOnly,
  recordMetric,
  now
}) {
  if (!isComment(dueComment)) {
    return skipped(dueComment, "not_comment");
  }

  const post = dueComment.post || postFromDueRow(dueComment) || (typeof db.getHoshiaPost === "function"
    ? db.getHoshiaPost(dueComment.post_id)
    : null);
  if (!post?.id) {
    if (shadowOnly) {
      const result = commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.failed", {
        reason: "post_not_found",
        source: "gateway"
      });
      recordCommentReplyShadowMetric(recordMetric, result, {
        comment: dueComment,
        post
      });
      return shadowedCommentResult(dueComment, post, result);
    }
    return failComment(db, dueComment, "post_not_found", now);
  }

  try {
    const memoryPacket = typeof lifeMemoryService?.buildMemoryPacket === "function"
      ? await lifeMemoryService.buildMemoryPacket({
        session: { user_id: dueComment.user_id, nickname: dueComment.nickname },
        query: `${post.content || ""} ${dueComment.content || ""}`,
        scene: "post_comment_reply",
        postId: post.id,
        limit: 6
      })
      : [];
    const replyContext = await buildReplyContext({
      post,
      comment: dueComment,
      now,
      visualStateProvider,
      moduleContextProvider,
      moduleEventsProvider
    });
    if (shadowOnly) {
      const result = await generateCommentReplyShadowCandidate({
        generator: shadowGenerator || generator,
        post,
        comment: dueComment,
        memoryPacket,
        now,
        lifeMemoryService,
        config,
        ...replyContext
      });
      recordCommentReplyShadowMetric(recordMetric, result, {
        comment: dueComment,
        post
      });
      return shadowedCommentResult(dueComment, post, result);
    }
    const generated = await generateWithFallback({
      generator,
      post,
      comment: dueComment,
      memoryPacket,
      now,
      lifeMemoryService,
      config,
      ...replyContext
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
        reply,
        roomId: config?.roomId || config?.room_id || ""
      }));
    }

    return {
      status: "replied",
      comment_id: dueComment.id,
      reply_id: reply.id,
      reply_source: generated?.source || "template"
    };
  } catch (error) {
    if (shadowOnly) {
      const result = commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.failed", {
        reason: cleanShadowMetricText(error?.message, 80) || "shadow_failed",
        source: "gateway"
      });
      recordCommentReplyShadowMetric(recordMetric, result, {
        comment: dueComment,
        post
      });
      return shadowedCommentResult(dueComment, post, result);
    }
    return failComment(db, dueComment, cleanText(error?.message, 80) || "reply_failed", now);
  }
}

async function generateWithFallback({
  generator,
  post,
  comment,
  memoryPacket,
  now,
  lifeMemoryService,
  config,
  visualState,
  moduleContext,
  moduleEvents
}) {
  const input = {
    post,
    comment,
    memoryPacket,
    now,
    lifeMemoryService,
    config,
    visualState,
    moduleContext,
    moduleEvents,
    replyMode: "post_comment_reply"
  };

  if (generator) {
    try {
      const generated = await generator(input);
      const content = normalizeGeneratedContent(generated);
      if (content) {
        return normalizeGeneratedReply(generated, content, "llm");
      }
    } catch {
      // Template fallback keeps async replies from failing when the LLM is unavailable.
    }
  }

  const fallback = await defaultCommentReplyGenerator(input);
  const fallbackContent = normalizeGeneratedContent(fallback);
  return normalizeGeneratedReply(fallback, fallbackContent, "template");
}

async function generateCommentReplyShadowCandidate({
  generator,
  post,
  comment,
  memoryPacket,
  now,
  lifeMemoryService,
  config,
  visualState,
  moduleContext,
  moduleEvents
}) {
  const input = {
    post,
    comment,
    memoryPacket,
    now,
    lifeMemoryService,
    config,
    visualState,
    moduleContext,
    moduleEvents,
    replyMode: "post_comment_reply_shadow",
    shadowOnly: true
  };

  try {
    if (generator) {
      const generated = await generator(input);
      return classifyCommentReplyShadowCandidate(generated, {
        source: generated?.source || "llm"
      });
    }
    const fallback = await defaultCommentReplyGenerator(input);
    return classifyCommentReplyShadowCandidate(fallback, {
      source: "template"
    });
  } catch (error) {
    return commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.failed", {
      reason: cleanShadowMetricText(error?.message, 80) || "shadow_failed",
      source: "gateway"
    });
  }
}

function normalizeGeneratedReply(generated, content, source) {
  if (generated && typeof generated === "object") {
    return {
      ...generated,
      content,
      source
    };
  }
  return {
    content,
    source
  };
}

async function buildReplyContext({
  post,
  comment,
  now,
  visualStateProvider,
  moduleContextProvider,
  moduleEventsProvider
}) {
  const input = {
    post,
    comment,
    now,
    session: { user_id: comment.user_id, nickname: comment.nickname }
  };
  const [visualState, moduleContext, moduleEvents] = await Promise.all([
    resolveProviderValue(visualStateProvider, input),
    resolveProviderValue(moduleContextProvider, input),
    resolveProviderValue(moduleEventsProvider, input)
  ]);
  return { visualState, moduleContext, moduleEvents };
}

async function resolveProviderValue(provider, input) {
  if (!provider) return null;
  try {
    if (typeof provider === "function") return await provider(input);
    if (typeof provider.getCapabilityContext === "function") return await provider.getCapabilityContext(input.session || input);
    if (typeof provider.getContext === "function") return await provider.getContext(input);
    if (typeof provider.getCurrentState === "function") return await provider.getCurrentState(input);
    if (typeof provider.listRecentEvents === "function") return await provider.listRecentEvents(input);
    if (typeof provider.list === "function") return await provider.list(input);
    return provider;
  } catch {
    return null;
  }
}

function classifyCommentReplyShadowCandidate(generated, { source = "" } = {}) {
  const resultSource = cleanShadowMetricText(generated?.source || source || "llm", 80) || "llm";
  const latencyMs = safeMetricNumber(generated?.latency_ms ?? generated?.latencyMs);
  if (generated?.skipped) {
    return commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.skip", {
      reason: cleanShadowMetricText(generated?.error || generated?.judge?.reason || generated?.route || "skipped", 80) || "skipped",
      source: resultSource,
      latencyMs
    });
  }
  const content = normalizeGeneratedCandidateText(generated);
  if (!content || generated?.failed || generated?.ok === false || resultSource === "gateway_error") {
    return commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.failed", {
      reason: cleanShadowMetricText(generated?.error || generated?.route || "empty_or_error_reply", 80) || "shadow_failed",
      source: resultSource,
      latencyMs
    });
  }
  return commentReplyShadowResult("hoshiaclaw.comment_reply_shadow.success", {
    reason: cleanShadowMetricText(generated?.route || "candidate_generated", 80) || "candidate_generated",
    source: resultSource,
    latencyMs
  });
}

function commentReplyShadowResult(eventType, { reason = "", source = "", latencyMs = undefined } = {}) {
  const status = eventType.endsWith(".success")
    ? "success"
    : eventType.endsWith(".skip")
      ? "skip"
      : "failed";
  return {
    called: true,
    eventType,
    status,
    reason: cleanShadowMetricText(reason, 80) || (status === "failed" ? "shadow_failed" : status),
    source: cleanShadowMetricText(source, 80) || "unknown",
    ...(latencyMs !== undefined ? { latencyMs } : {})
  };
}

function recordCommentReplyShadowMetric(recordMetric, result, { comment, post } = {}) {
  if (typeof recordMetric !== "function" || !result?.eventType) return;
  try {
    recordMetric({
      eventType: result.eventType,
      status: result.status,
      reason: result.reason,
      source: result.source,
      replyMode: "post_comment_reply_shadow",
      commentId: cleanIdentifier(comment?.id, 80),
      postId: cleanIdentifier(post?.id, 80),
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {})
    });
  } catch {
    // Metrics must never change comment reply behavior.
  }
}

function shadowedCommentResult(comment, post, result) {
  return {
    status: "shadowed",
    comment_id: comment?.id || "",
    post_id: post?.id || comment?.post_id || "",
    shadow_status: result.status,
    shadow_event_type: result.eventType,
    reason: result.reason,
    reply_source: result.source
  };
}

function selectReplyCandidates(comments, maxCount) {
  return comments
    .filter(isComment)
    .map((comment, index) => ({
      ...comment,
      _replyPriority: scoreReplyCandidate(comment),
      _index: index
    }))
    .filter((comment) => comment._replyPriority > 0)
    .sort((left, right) => {
      if (right._replyPriority !== left._replyPriority) return right._replyPriority - left._replyPriority;
      return left._index - right._index;
    })
    .slice(0, maxCount);
}

function scoreReplyCandidate(comment) {
  const text = cleanText(comment?.content, 240).toLowerCase();
  if (!text) return 0;
  const activity = cleanIdentifier(comment?.post?.activity, 48);
  const mood = cleanIdentifier(comment?.post?.mood, 48);

  let score = 0;
  if (/[?？吗呢]/.test(text) || /(怎么|为什么|为啥|如何|能不能|可以|what|why|how|can you)/i.test(text)) {
    score += 5;
  }
  if (/(难过|伤心|孤独|陪陪|抱抱|低落|不开心|emo|哭|累|烦|sad|lonely|tired|upset)/i.test(text)) {
    score += 6;
  }
  if (/(哈哈|笑死|真的假的|然后呢|你说呢|不会吧|菜就多练|调侃|追问|lol|really)/i.test(text)) {
    score += 3;
  }
  if (/(现在|刚才|动态|直播|游戏|排位|动漫|运动|打完|赢|输|截图|音乐|歌|队列|礼物|新闻|tts|声音|live2d|表情|姿势|状态)/i.test(text)) {
    score += 4;
  }
  if ((activity && text.includes(activity)) || (mood && text.includes(mood))) {
    score += 4;
  }
  if (activity === "gaming" && /(game|gaming|play|win|lose|游戏|排位|赢|输)/i.test(text)) {
    score += 4;
  }
  if (activity === "music" && /(music|song|queue|音乐|歌|队列)/i.test(text)) {
    score += 4;
  }
  if (activity === "live2d" && /(live2d|pose|face|expression|表情|姿势|动作)/i.test(text)) {
    score += 4;
  }

  return score;
}

function countRepliesToday(db, nowIso) {
  if (typeof db?.listHoshiaPosts !== "function") return 0;
  const day = String(nowIso || "").slice(0, 10);
  if (!day) return 0;
  return db.listHoshiaPosts({ characterId: CHARACTER_ID, limit: 100, viewerUserId: "" })
    .flatMap((post) => Array.isArray(post.interactions) ? post.interactions : [])
    .filter((interaction) => interaction.type === "reply" && String(interaction.created_at || "").startsWith(day))
    .length;
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

function markSkipped(db, comment, now) {
  if (typeof db.markHoshiaCommentReplySkipped === "function") {
    db.markHoshiaCommentReplySkipped({
      commentId: comment.id,
      skippedAt: now
    });
    return;
  }
  if (typeof db.markHoshiaPostCommentReplyStatus === "function") {
    db.markHoshiaPostCommentReplyStatus(comment.id, {
      status: "skipped",
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

function normalizeGeneratedCandidateText(generated) {
  const content = cleanText(
    typeof generated === "string" ? generated : generated?.content || generated?.text,
    500
  );
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

function cleanShadowMetricText(value, maxLength = 80) {
  const text = cleanText(value, maxLength);
  if (!text || sensitivePattern.test(text)) return "";
  if (/(?:raw[_ -]?(?:prompt|response)|candidate[_ -]?text|token|secret|bearer|url|path|\.env|ssh|cloudflared)/i.test(text)) {
    return "";
  }
  return text;
}

function safeMetricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
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

