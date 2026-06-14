import assert from "node:assert/strict";
import test from "node:test";
import {
  commentReplyRolloutForInteraction,
  createHoshiaCommentReplyGeneratedEvent,
  createHoshiaCommentReplyService,
  defaultCommentReplyGenerator,
  normalizeCommentReplyDelayConfig,
  stablePercentBucket
} from "../src/hoshia-comment-reply.js";

test("comment reply service schedules comment replies within delay bounds", () => {
  const db = {
    pendingCalls: [],
    markHoshiaCommentReplyPending(input) {
      this.pendingCalls.push(input);
      return input;
    }
  };
  const service = createHoshiaCommentReplyService({
    db,
    clock: () => new Date("2026-06-10T12:00:00.000Z"),
    random: () => 0.5,
    minDelayMinutes: 4,
    maxDelayMinutes: 10
  });

  const scheduled = service.scheduleCommentReply({
    comment: {
      id: "comment_1",
      type: "comment"
    }
  });

  assert.equal(scheduled.commentId, "comment_1");
  assert.equal(scheduled.replyDueAt, "2026-06-10T12:07:00.000Z");
  assert.equal(db.pendingCalls.length, 1);
  assert.equal(service.scheduleCommentReply({ comment: { id: "like_1", type: "like" } }), null);
});

test("comment reply service keeps compatibility pendingFields helper", () => {
  const service = createHoshiaCommentReplyService({
    db: {},
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  });

  const fields = service.pendingFields({
    random: () => 0,
    minDelayMinutes: 3,
    maxDelayMinutes: 20
  });

  assert.deepEqual(fields, {
    reply_status: "pending",
    reply_due_at: "2026-06-10T12:03:00.000Z",
    replied_at: ""
  });
  assert.deepEqual(normalizeCommentReplyDelayConfig(20, 3), {
    minMinutes: 3,
    maxMinutes: 20
  });
});

test("comment reply rollout schedules shadow pending comments at 100 percent", () => {
  const input = {
    id: "comment_shadow",
    post_id: "post_1",
    user_id: "user_1",
    created_at: "2026-06-10T12:00:00.000Z"
  };

  assert.deepEqual(commentReplyRolloutForInteraction(input, {
    asyncEnabled: true,
    mode: "shadow",
    greyPercent: 100
  }), {
    mode: "shadow",
    shouldSchedule: true,
    reason: "scheduled",
    bucket: 23
  });
  assert.deepEqual(commentReplyRolloutForInteraction(input, {
    asyncEnabled: true,
    mode: "shadow",
    greyPercent: 0
  }), {
    mode: "shadow",
    shouldSchedule: false,
    reason: "grey_percent_zero"
  });
});

test("comment reply rollout uses deterministic grey percent buckets", () => {
  const input = {
    post_id: "post_1",
    user_id: "user_1",
    created_at: "2026-06-10T12:00:00.000Z"
  };

  assert.equal(stablePercentBucket("comment_1"), 30);
  assert.equal(stablePercentBucket("comment_1"), 30);
  assert.equal(stablePercentBucket("post_1:user_1:2026-06-10T12:00:00.000Z"), 40);
  assert.deepEqual(commentReplyRolloutForInteraction(input, {
    mode: "live",
    greyPercent: 40
  }), {
    mode: "live",
    shouldSchedule: false,
    reason: "grey_percent_skip",
    bucket: 40
  });
  assert.deepEqual(commentReplyRolloutForInteraction(input, {
    mode: "live",
    greyPercent: 41
  }), {
    mode: "live",
    shouldSchedule: true,
    reason: "scheduled",
    bucket: 40
  });
});

test("comment reply service processes due comments into reply interactions and life memory", async () => {
  const post = {
    id: "post_1",
    mood: "annoyed",
    activity: "gaming"
  };
  const comment = {
    id: "comment_1",
    post_id: "post_1",
    user_id: "user_1",
    nickname: "Alice",
    type: "comment",
    content: "菜就多练吗？",
    reply_status: "pending",
    reply_due_at: "2026-06-10T12:00:00.000Z"
  };
  const db = createFakeDb({ post, dueComments: [comment] });
  const recordedMemories = [];
  const moduleEvents = [];
  const service = createHoshiaCommentReplyService({
    db,
    lifeMemoryService: {
      buildMemoryPacket(input) {
        assert.equal(input.scene, "post_comment_reply");
        assert.equal(input.postId, "post_1");
        return ["memory packet"];
      },
      recordInteraction(input) {
        recordedMemories.push(input);
      }
    },
    moduleEventStore: {
      append(event) {
        moduleEvents.push(event);
      }
    },
    generator: async ({ post: generatorPost, comment: generatorComment, memoryPacket, replyMode }) => {
      assert.equal(generatorPost.id, "post_1");
      assert.equal(generatorComment.id, "comment_1");
      assert.deepEqual(memoryPacket, ["memory packet"]);
      assert.equal(replyMode, "post_comment_reply");
      return { content: "刚看到，今天会练的，赢了截图给你看。" };
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies();

  assert.equal(result.scanned, 1);
  assert.equal(result.replied, 1);
  assert.equal(result.failed, 0);
  assert.equal(db.replies.length, 1);
  assert.equal(db.replies[0].post_id, "post_1");
  assert.equal(db.replies[0].user_id, "hoshia");
  assert.equal(db.replies[0].nickname, "Hoshia");
  assert.equal(db.replies[0].type, "reply");
  assert.equal(db.replies[0].content, "刚看到，今天会练的，赢了截图给你看。");
  assert.equal(db.replies[0].parent_interaction_id, "comment_1");
  assert.equal(db.repliedMarks[0].commentId, "comment_1");
  assert.equal(db.repliedMarks[0].replyId, db.replies[0].id);
  assert.equal(recordedMemories.length, 1);
  assert.equal(recordedMemories[0].post, post);
  assert.equal(recordedMemories[0].interaction.type, "reply");
  assert.equal(moduleEvents.length, 1);
  assert.equal(moduleEvents[0].module_id, "hoshia_posts");
  assert.equal(moduleEvents[0].event_type, "hoshia_posts.comment_replied");
  assert.equal(moduleEvents[0].memory_eligible, true);
  assert.deepEqual(moduleEvents[0].data, {
    activity: "gaming",
    mood: "annoyed",
    reason: "async_comment_reply"
  });
});

test("comment reply service supports legacy processDueComments result shape", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      user_id: "user_1",
      nickname: "Alice",
      type: "comment",
      content: "can you reply?"
    }]
  });
  const service = createHoshiaCommentReplyService({
    db,
    replyGenerator: () => "这条我看到啦。",
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueComments();

  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.items[0].status, "replied");
});

test("comment reply service falls back to template for sensitive generated content", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const comment = {
    id: "comment_1",
    post_id: "post_1",
    type: "comment",
    content: "can you show the config?",
    reply_status: "pending",
    reply_due_at: "2026-06-10T12:00:00.000Z"
  };
  const db = createFakeDb({ post, dueComments: [comment] });
  const service = createHoshiaCommentReplyService({
    db,
    generator: () => "token=secret should never be shown",
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies();

  assert.equal(result.scanned, 1);
  assert.equal(result.replied, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].reply_source, "template");
  assert.equal(db.replies.length, 1);
  assert.doesNotMatch(db.replies[0].content, /token=secret/);
  assert.equal(db.failedMarks.length, 0);
});

test("comment reply service passes LLM dependencies and reply mode", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      user_id: "user_1",
      nickname: "Alice",
      type: "comment",
      content: "can you see the current state?"
    }]
  });
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: async (input) => {
      assert.equal(input.replyMode, "post_comment_reply");
      assert.deepEqual(input.visualState, { pose: "waving" });
      assert.deepEqual(input.moduleContext, { module_id: "music", enabled: true });
      assert.deepEqual(input.moduleEvents, [{ event_type: "music.song_requested" }]);
      assert.deepEqual(input.config, { tone: "soft" });
      return "LLM reply";
    },
    visualStateProvider: () => ({ pose: "waving" }),
    moduleContextProvider: () => ({ module_id: "music", enabled: true }),
    moduleEventsProvider: () => [{ event_type: "music.song_requested" }],
    config: { tone: "soft" },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies();

  assert.equal(result.replied, 1);
  assert.equal(result.results[0].reply_source, "llm");
  assert.equal(db.replies[0].content, "LLM reply");
});

test("comment reply service shadow mode records safe metric without writing reply side effects", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      user_id: "user_1",
      nickname: "Alice",
      type: "comment",
      content: "can you see this comment?"
    }]
  });
  const recordedMemories = [];
  const moduleEvents = [];
  const metrics = [];
  const service = createHoshiaCommentReplyService({
    db,
    lifeMemoryService: {
      buildMemoryPacket() {
        return ["memory packet"];
      },
      recordInteraction(input) {
        recordedMemories.push(input);
      }
    },
    moduleEventStore: {
      append(event) {
        moduleEvents.push(event);
      }
    },
    aiReplyGenerator: async (input) => {
      assert.equal(input.replyMode, "post_comment_reply_shadow");
      assert.equal(input.shadowOnly, true);
      return {
        content: "candidate text must not be stored in metric",
        source: "openai_compatible",
        route: "comment_reply_shadow",
        latency_ms: 42
      };
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({
    shadowOnly: true,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.replied, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.shadowed, 1);
  assert.equal(result.results[0].status, "shadowed");
  assert.equal(result.results[0].shadow_status, "success");
  assert.equal(db.replies.length, 0);
  assert.equal(db.repliedMarks.length, 0);
  assert.equal(db.failedMarks.length, 0);
  assert.equal(db.skippedMarks.length, 0);
  assert.equal(recordedMemories.length, 0);
  assert.equal(moduleEvents.length, 0);
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.comment_reply_shadow.success",
    status: "success",
    reason: "comment_reply_shadow",
    source: "openai_compatible",
    replyMode: "post_comment_reply_shadow",
    commentId: "comment_1",
    postId: "post_1",
    latencyMs: 42
  }]);
  const metricJson = JSON.stringify(metrics);
  assert.equal(metricJson.includes("candidate text"), false);
  assert.equal(/raw prompt|raw response|token|url|path/i.test(metricJson), false);
});

test("comment reply service shadow consumes pending comment without reply memory or module event writes", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      user_id: "user_1",
      nickname: "Alice",
      type: "comment",
      content: "can you answer this shadow pending comment?",
      reply_status: "pending",
      reply_due_at: "2026-06-10T12:00:00.000Z"
    }]
  });
  const recordedMemories = [];
  const moduleEvents = [];
  const metrics = [];
  const service = createHoshiaCommentReplyService({
    db,
    lifeMemoryService: {
      buildMemoryPacket() {
        return ["memory packet"];
      },
      recordInteraction(input) {
        recordedMemories.push(input);
      }
    },
    moduleEventStore: {
      append(event) {
        moduleEvents.push(event);
      }
    },
    shadowGenerator: (input) => {
      assert.equal(input.replyMode, "post_comment_reply_shadow");
      assert.equal(input.shadowOnly, true);
      return {
        text: "shadow reply candidate",
        source: "hoshiaclaw",
        route: "post_comment_reply_shadow"
      };
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({
    shadowOnly: true,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.shadowed, 1);
  assert.equal(result.replied, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].status, "shadowed");
  assert.equal(result.results[0].shadow_status, "success");
  assert.equal(db.replies.length, 0);
  assert.equal(db.repliedMarks.length, 0);
  assert.equal(db.failedMarks.length, 0);
  assert.equal(db.skippedMarks.length, 0);
  assert.equal(recordedMemories.length, 0);
  assert.equal(moduleEvents.length, 0);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].eventType, "hoshiaclaw.comment_reply_shadow.success");
});

test("comment reply service shadow low priority skip is not a provider failure", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_low",
      post_id: "post_1",
      user_id: "user_1",
      nickname: "Alice",
      type: "comment",
      content: "hello",
      reply_status: "pending",
      reply_due_at: "2026-06-10T12:00:00.000Z"
    }]
  });
  const metrics = [];
  let shadowCalls = 0;
  const service = createHoshiaCommentReplyService({
    db,
    shadowGenerator: () => {
      shadowCalls += 1;
      throw new Error("provider should not be called for low priority comments");
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({
    shadowOnly: true,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.shadowed, 0);
  assert.equal(result.replied, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].status, "skipped");
  assert.equal(result.results[0].reason, "low_priority");
  assert.equal(shadowCalls, 0);
  assert.equal(db.replies.length, 0);
  assert.equal(db.failedMarks.length, 0);
  assert.equal(db.skippedMarks.length, 0);
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.comment_reply_shadow.skip",
    status: "skip",
    reason: "low_priority_comment",
    source: "gateway",
    replyMode: "post_comment_reply_shadow",
    commentId: "comment_low",
    postId: "post_1"
  }]);
});

test("comment reply service uses caller-provided shadow generator only for shadow mode", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      type: "comment",
      content: "can you reply with the shadow generator?"
    }]
  });
  let liveCalls = 0;
  let shadowCalls = 0;
  const metrics = [];
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: () => {
      liveCalls += 1;
      return "live reply";
    },
    shadowGenerator: (input) => {
      shadowCalls += 1;
      assert.equal(input.replyMode, "post_comment_reply_shadow");
      assert.equal(input.shadowOnly, true);
      return {
        text: "shadow candidate text",
        source: "hoshiaclaw",
        route: "comment_reply_shadow"
      };
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const shadowResult = await service.processDueReplies({
    shadowOnly: true,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(shadowResult.shadowed, 1);
  assert.equal(shadowResult.results[0].reply_source, "hoshiaclaw");
  assert.equal(metrics[0].source, "hoshiaclaw");
  assert.equal(liveCalls, 0);
  assert.equal(shadowCalls, 1);
  assert.equal(db.replies.length, 0);

  const liveResult = await service.processDueReplies();

  assert.equal(liveResult.replied, 1);
  assert.equal(liveCalls, 1);
  assert.equal(shadowCalls, 1);
  assert.equal(db.replies[0].content, "live reply");
});

test("comment reply service shadow skip does not affect later live processing", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      type: "comment",
      content: "can you reply after shadow skip?"
    }]
  });
  const metrics = [];
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: (input) => {
      if (input.shadowOnly) {
        return {
          skipped: true,
          source: "hoshiaclaw",
          error: "judge_skip",
          latency_ms: 7
        };
      }
      return "live reply after skip";
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const shadowResult = await service.processDueReplies({
    shadow: true,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });
  const liveResult = await service.processDueReplies();

  assert.equal(shadowResult.shadowed, 1);
  assert.equal(shadowResult.results[0].shadow_status, "skip");
  assert.equal(metrics[0].status, "skip");
  assert.equal(metrics[0].reason, "judge_skip");
  assert.equal(liveResult.replied, 1);
  assert.equal(db.replies.length, 1);
  assert.equal(db.replies[0].content, "live reply after skip");
  assert.equal(db.failedMarks.length, 0);
});

test("comment reply service shadow failed metric is sanitized and leaves live flow intact", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      type: "comment",
      content: "can you reply after shadow failure?"
    }]
  });
  const metrics = [];
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: (input) => {
      if (input.shadowOnly) {
        throw new Error("token leaked at http://internal.example/path");
      }
      return "live reply after failed shadow";
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const shadowResult = await service.processDueReplies({
    shadowOnly: true,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });
  const liveResult = await service.processDueReplies();

  assert.equal(shadowResult.shadowed, 1);
  assert.equal(shadowResult.results[0].shadow_status, "failed");
  assert.equal(metrics[0].status, "failed");
  assert.equal(metrics[0].reason, "shadow_failed");
  assert.equal(/token|http|url|path/i.test(JSON.stringify(metrics)), false);
  assert.equal(db.failedMarks.length, 0);
  assert.equal(liveResult.replied, 1);
  assert.equal(db.replies[0].content, "live reply after failed shadow");
});

test("comment reply service shadow low-priority skip does not call provider or mark db skipped", async () => {
  const post = { id: "post_1", mood: "calm", activity: "gaming" };
  const db = createFakeDb({
    post,
    dueComments: [
      { id: "comment_1", post_id: "post_1", type: "comment", content: "can you reply 1?" },
      { id: "comment_2", post_id: "post_1", type: "comment", content: "can you reply 2?" },
      { id: "comment_3", post_id: "post_1", type: "comment", content: "ordinary note" }
    ]
  });
  let providerCalls = 0;
  const metrics = [];
  const service = createHoshiaCommentReplyService({
    db,
    maxRepliesPerTick: 2,
    aiReplyGenerator: ({ comment, shadowOnly }) => {
      providerCalls += 1;
      assert.equal(shadowOnly, true);
      return {
        text: `shadow ${comment.id}`,
        source: "hoshiaclaw",
        route: "comment_reply_shadow"
      };
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({
    shadowOnly: true,
    limit: 10,
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.shadowed, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[2].reason, "low_priority");
  assert.equal(providerCalls, 2);
  assert.equal(metrics.length, 3);
  assert.deepEqual(metrics[2], {
    eventType: "hoshiaclaw.comment_reply_shadow.skip",
    status: "skip",
    reason: "low_priority_comment",
    source: "gateway",
    replyMode: "post_comment_reply_shadow",
    commentId: "comment_3",
    postId: "post_1"
  });
  assert.equal(db.replies.length, 0);
  assert.equal(db.skippedMarks.length, 0);
});

test("comment reply service falls back to template when LLM throws", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      type: "comment",
      nickname: "Alice",
      content: "can you stay with me?",
      reply_status: "pending",
      reply_due_at: "2026-06-10T12:00:00.000Z"
    }]
  });
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: () => {
      throw new Error("llm_unavailable");
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies();

  assert.equal(result.replied, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].reply_source, "template");
  assert.equal(db.replies.length, 1);
  assert.ok(db.replies[0].content);
  assert.equal(db.failedMarks.length, 0);
});

test("comment reply service keeps live replies flowing when context providers fail", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      type: "comment",
      nickname: "Alice",
      content: "can you reply even if context fails?",
      reply_status: "pending",
      reply_due_at: "2026-06-10T12:00:00.000Z"
    }]
  });
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: (input) => {
      assert.equal(input.moduleContext, null);
      assert.equal(input.moduleEvents, null);
      return "live reply with provider fallback";
    },
    moduleContextProvider: () => {
      throw new Error("context provider failed");
    },
    moduleEventsProvider: {
      listRecentEvents() {
        throw new Error("events provider failed");
      }
    },
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies();

  assert.equal(result.replied, 1);
  assert.equal(result.failed, 0);
  assert.equal(db.failedMarks.length, 0);
  assert.equal(db.replies[0].content, "live reply with provider fallback");
});

test("comment reply service limits each tick to two replies", async () => {
  const post = { id: "post_1", mood: "calm", activity: "gaming" };
  const db = createFakeDb({
    post,
    dueComments: [
      { id: "comment_1", post_id: "post_1", type: "comment", content: "can you reply 1?" },
      { id: "comment_2", post_id: "post_1", type: "comment", content: "can you reply 2?" },
      { id: "comment_3", post_id: "post_1", type: "comment", content: "can you reply 3?" }
    ]
  });
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: ({ comment }) => `reply to ${comment.id}`,
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({ limit: 10 });

  assert.equal(result.scanned, 3);
  assert.equal(result.replied, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(db.replies.map((reply) => reply.parent_interaction_id), ["comment_1", "comment_2"]);
  assert.equal(result.results[2].reason, "low_priority");
  assert.equal(db.skippedMarks.length, 1);
  assert.equal(db.skippedMarks[0].commentId, "comment_3");
});

test("comment reply service force option processes not-yet-due comments", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [{
      id: "comment_1",
      post_id: "post_1",
      type: "comment",
      content: "can you reply later?",
      reply_status: "pending",
      reply_due_at: "2026-06-10T13:00:00.000Z"
    }]
  });
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: ({ comment }) => `reply to ${comment.id}`,
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({ force: true });

  assert.equal(result.scanned, 1);
  assert.equal(result.replied, 1);
  assert.equal(db.replies.length, 1);
  assert.equal(db.replies[0].parent_interaction_id, "comment_1");
});

test("comment reply service prioritizes emotional and question comments over ordinary comments", async () => {
  const post = { id: "post_1", mood: "calm", activity: "idle" };
  const db = createFakeDb({
    post,
    dueComments: [
      { id: "comment_ordinary", post_id: "post_1", type: "comment", content: "hello" },
      { id: "comment_sad", post_id: "post_1", type: "comment", content: "I feel lonely, can you stay?" },
      { id: "comment_question", post_id: "post_1", type: "comment", content: "what are you doing now?" }
    ]
  });
  const service = createHoshiaCommentReplyService({
    db,
    aiReplyGenerator: ({ comment }) => `reply to ${comment.id}`,
    clock: () => new Date("2026-06-10T12:05:00.000Z")
  });

  const result = await service.processDueReplies({ limit: 10 });

  assert.equal(result.replied, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(
    db.replies.map((reply) => reply.parent_interaction_id).sort(),
    ["comment_question", "comment_sad"]
  );
  assert.equal(result.results[0].status, "skipped");
  assert.equal(result.results[0].reason, "low_priority");
});

test("comment reply service skips non-comment due rows", async () => {
  const db = createFakeDb({
    dueComments: [{
      id: "like_1",
      post_id: "post_1",
      type: "like"
    }]
  });
  const service = createHoshiaCommentReplyService({ db });

  const result = await service.processDueReplies();

  assert.equal(result.scanned, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].reason, "not_comment");
  assert.equal(db.replies.length, 0);
});

test("default comment reply generator returns a safe template reply", async () => {
  const reply = await defaultCommentReplyGenerator({
    post: {
      mood: "annoyed",
      activity: "gaming"
    },
    comment: {
      nickname: "Alice",
      content: "今天练了吗"
    }
  });

  assert.match(reply, /Alice/);
  assert.match(reply, /今天练了吗/);
  assert.match(reply, /刚打完一小局才看到评论/);
});

test("comment reply module event sanitizes unsafe data fields", () => {
  const event = createHoshiaCommentReplyGeneratedEvent({
    post: {
      activity: "gaming",
      mood: "annoyed",
      internal_path: "E:\\secret\\.env"
    },
    comment: {
      user_id: "user_1",
      nickname: "Alice",
      content: "hello"
    },
    reply: {
      id: "reply_1",
      created_at: "2026-06-10T12:00:00.000Z"
    }
  });

  assert.equal(event.module_id, "hoshia_posts");
  assert.equal(event.event_type, "hoshia_posts.comment_replied");
  assert.equal(event.data.activity, "gaming");
  assert.equal(event.data.mood, "annoyed");
  assert.equal(event.data.internal_path, undefined);
});

function createFakeDb({ post = null, dueComments = [] } = {}) {
  return {
    post,
    dueComments,
    replies: [],
    repliedMarks: [],
    failedMarks: [],
    skippedMarks: [],
    listDueHoshiaCommentReplies({ limit, force = false }) {
      if (force) return this.dueComments.slice(0, limit);
      return this.dueComments
        .filter((item) => String(item.reply_due_at || "") <= "2026-06-10T12:05:00.000Z")
        .slice(0, limit);
    },
    listDueHoshiaPostComments({ limit, force = false }) {
      return this.listDueHoshiaCommentReplies({ limit, force });
    },
    getHoshiaPost(postId) {
      return this.post?.id === postId ? this.post : null;
    },
    addHoshiaPostInteraction(input) {
      const reply = {
        ...input,
        id: input.id || "reply_1"
      };
      this.replies.push(reply);
      return reply;
    },
    markHoshiaCommentReplyReplied(input) {
      this.repliedMarks.push(input);
      return input;
    },
    markHoshiaCommentReplyFailed(input) {
      this.failedMarks.push(input);
      return input;
    },
    markHoshiaCommentReplySkipped(input) {
      this.skippedMarks.push(input);
      return input;
    }
  };
}
