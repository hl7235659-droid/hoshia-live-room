import assert from "node:assert/strict";
import test from "node:test";
import {
  createHoshiaCommentReplyGeneratedEvent,
  createHoshiaCommentReplyService,
  defaultCommentReplyGenerator,
  normalizeCommentReplyDelayConfig
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
    }
  };
}
