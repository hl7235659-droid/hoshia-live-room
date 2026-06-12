import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nanoid } from "nanoid";
import { DatabaseError, openLiveRoomDatabase } from "../src/database.js";
import { hashAccessCode, hashPassword } from "../src/security.js";

test("registration code creates one user and cannot be reused", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({
      id: nanoid(12),
      codeHash: hashAccessCode("HOSHA-7K2P-MQ9A")
    });

    const user = db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("hosha-7k2p-mq9a"),
      user: {
        id: "user-1",
        username: "Friend.One",
        passwordHash: hashPassword("password-1"),
        nickname: "Friend"
      }
    });

    assert.equal(user.id, "user-1");
    assert.equal(db.countRegistrationCodes().available, 0);
    assert.throws(() => {
      db.createUserWithRegistrationCode({
        registrationCodeHash: hashAccessCode("HOSHA-7K2P-MQ9A"),
        user: {
          id: "user-2",
          username: "friend-two",
          passwordHash: hashPassword("password-2"),
          nickname: "Friend Two"
        }
      });
    }, (error) => error instanceof DatabaseError && error.code === "registration_code_used");
  } finally {
    cleanup();
  }
});

test("usernames are unique after normalization", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({ id: "code-1", codeHash: hashAccessCode("HOSHA-AAAA-1111") });
    db.insertRegistrationCode({ id: "code-2", codeHash: hashAccessCode("HOSHA-BBBB-2222") });

    db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("HOSHA-AAAA-1111"),
      user: {
        id: "user-1",
        username: "Friend",
        passwordHash: hashPassword("password-1"),
        nickname: "Friend"
      }
    });

    assert.throws(() => {
      db.createUserWithRegistrationCode({
        registrationCodeHash: hashAccessCode("HOSHA-BBBB-2222"),
        user: {
          id: "user-2",
          username: "friend",
          passwordHash: hashPassword("password-2"),
          nickname: "Friend Again"
        }
      });
    }, (error) => error instanceof DatabaseError && error.code === "username_taken");
  } finally {
    cleanup();
  }
});

test("room messages are persisted and returned oldest to newest within limit", () => {
  const { db, cleanup } = openTempDb();
  try {
    for (let index = 0; index < 105; index += 1) {
      db.insertRoomMessage({
        type: "danmaku",
        id: `message-${index}`,
        room_id: "room-1",
        user_id: "user-1",
        nickname: "Friend",
        role: "user",
        text: `message ${index}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      }, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
    }

    const messages = db.listRecentRoomMessages("room-1", 100);
    assert.equal(messages.length, 100);
    assert.equal(messages[0].id, "message-5");
    assert.equal(messages[99].id, "message-104");
  } finally {
    cleanup();
  }
});

test("context messages and rolling summaries are persisted", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRoomMessage({
      type: "danmaku",
      id: "message-1",
      room_id: "room-1",
      user_id: "user-1",
      nickname: "Alice",
      role: "user",
      text: "I am preparing a demo this week",
      timestamp: "2026-06-09T00:00:00.000Z"
    }, "2026-06-09T00:00:00.000Z");
    db.insertRoomMessage({
      type: "ai_reply",
      id: "message-2",
      room_id: "room-1",
      user_id: "ai-host",
      nickname: "Hoshia",
      role: "ai",
      text: "I will remember the demo context.",
      timestamp: "2026-06-09T00:00:01.000Z"
    }, "2026-06-09T00:00:01.000Z");

    const contextMessages = db.listContextMessagesAfter("room-1", "", "", 10);
    assert.equal(contextMessages.length, 2);
    assert.equal(contextMessages[0].nickname, "Alice");
    assert.equal(contextMessages[1].role, "ai");

    const summary = db.upsertRoomContextSummary({
      roomId: "room-1",
      summaryText: "Alice is preparing a demo this week.",
      summarizedUntilCreatedAt: contextMessages[1].created_at,
      summarizedUntilId: contextMessages[1].id,
      coverageStartTimestamp: contextMessages[0].timestamp,
      coverageEndTimestamp: contextMessages[1].timestamp,
      updatedAt: "2026-06-09T00:00:02.000Z"
    });
    assert.equal(summary.summary_text, "Alice is preparing a demo this week.");

    const afterSummary = db.listContextMessagesAfter("room-1", summary.summarized_until_created_at, summary.summarized_until_id, 10);
    assert.equal(afterSummary.length, 0);
  } finally {
    cleanup();
  }
});

test("hoshia visual state is persisted and upserted", () => {
  const { db, cleanup } = openTempDb();
  try {
    assert.equal(db.getHoshiaState("hoshia"), null);

    const created = db.upsertHoshiaState({
      character_id: "hoshia",
      mood: "calm",
      activity: "idle",
      energy: 70,
      social_need: 40,
      current_png: "/assets/hoshia/stage-png/idle_calm_01.png",
      state_reason: "initial state",
      updated_at: "2026-06-10T00:00:00.000Z"
    });
    assert.equal(created.current_png, "/assets/hoshia/stage-png/idle_calm_01.png");
    assert.equal(created.energy, 70);

    const updated = db.upsertHoshiaState({
      character_id: "hoshia",
      mood: "competitive",
      activity: "gaming",
      energy: 82,
      social_need: 25,
      current_png: "/assets/hoshia/stage-png/gaming_competitive_01.png",
      state_reason: "viewer talked about gaming",
      updated_at: "2026-06-10T00:10:00.000Z"
    });
    assert.equal(updated.activity, "gaming");
    assert.equal(updated.mood, "competitive");
    assert.equal(db.getHoshiaState("hoshia").current_png, "/assets/hoshia/stage-png/gaming_competitive_01.png");
  } finally {
    cleanup();
  }
});

test("hoshia posts interactions and life memories are persisted", () => {
  const { db, cleanup } = openTempDb();
  try {
    const post = db.createHoshiaPost({
      id: "post-1",
      character_id: "hoshia",
      content: "刚刚排位输了两把，但我觉得问题不在我。",
      image_url: "/assets/hoshia/stage-png/gaming_annoyed_02.png",
      mood: "annoyed",
      activity: "gaming",
      source_type: "manual",
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z"
    });
    assert.equal(post.activity, "gaming");

    db.addHoshiaPostInteraction({
      id: "like-1",
      post_id: "post-1",
      user_id: "user-1",
      nickname: "Alice",
      type: "like",
      created_at: "2026-06-10T00:01:00.000Z"
    });
    db.addHoshiaPostInteraction({
      id: "like-duplicate",
      post_id: "post-1",
      user_id: "user-1",
      nickname: "Alice",
      type: "like",
      created_at: "2026-06-10T00:02:00.000Z"
    });
    db.addHoshiaPostInteraction({
      id: "comment-1",
      post_id: "post-1",
      user_id: "user-1",
      nickname: "Alice",
      type: "comment",
      content: "菜就多练",
      created_at: "2026-06-10T00:03:00.000Z"
    });

    const posts = db.listHoshiaPosts({ characterId: "hoshia", viewerUserId: "user-1" });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].like_count, 1);
    assert.equal(posts[0].comment_count, 1);
    assert.equal(posts[0].liked_by_viewer, true);
    assert.equal(posts[0].interactions.length, 2);

    db.addHoshiaLifeMemory({
      id: "memory-1",
      character_id: "hoshia",
      user_id: "user-1",
      type: "event",
      source: "post_comment",
      source_id: "comment-1",
      content: "Alice commented on Hoshia's gaming update: 菜就多练",
      importance: 0.7,
      tags: ["gaming", "comment"],
      created_at: "2026-06-10T00:04:00.000Z"
    });

    const memories = db.searchHoshiaLifeMemories({
      characterId: "hoshia",
      userId: "user-1",
      query: "今天练了吗 gaming",
      limit: 5,
      now: "2026-06-10T00:05:00.000Z"
    });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].source, "post_comment");
  } finally {
    cleanup();
  }
});

test("hoshia ops counters group daily posts replies and comment statuses", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.createHoshiaPost({
      id: "post-daily",
      character_id: "hoshia",
      content: "daily",
      mood: "calm",
      activity: "idle",
      source_type: "daily_state",
      created_at: "2026-06-10T16:30:00.000Z",
      updated_at: "2026-06-10T16:30:00.000Z"
    });
    db.createHoshiaPost({
      id: "post-pulse",
      character_id: "hoshia",
      content: "pulse",
      mood: "happy",
      activity: "happy",
      source_type: "state_pulse",
      created_at: "2026-06-11T02:00:00.000Z",
      updated_at: "2026-06-11T02:00:00.000Z"
    });
    db.addHoshiaPostInteraction({
      id: "comment-pending",
      post_id: "post-daily",
      user_id: "user-1",
      nickname: "Alice",
      type: "comment",
      content: "pending",
      reply_status: "pending",
      reply_due_at: "2026-06-11T03:00:00.000Z",
      created_at: "2026-06-11T02:10:00.000Z"
    });
    db.addHoshiaPostInteraction({
      id: "comment-failed",
      post_id: "post-daily",
      user_id: "user-2",
      nickname: "Bob",
      type: "comment",
      content: "failed",
      reply_status: "failed",
      replied_at: "2026-06-11T03:10:00.000Z",
      created_at: "2026-06-11T02:20:00.000Z"
    });
    db.addHoshiaPostInteraction({
      id: "comment-skipped",
      post_id: "post-pulse",
      user_id: "user-3",
      nickname: "Caro",
      type: "comment",
      content: "skipped",
      reply_status: "skipped",
      replied_at: "2026-06-11T03:20:00.000Z",
      created_at: "2026-06-11T02:30:00.000Z"
    });
    db.addHoshiaPostInteraction({
      id: "reply-1",
      post_id: "post-pulse",
      user_id: "hoshia",
      nickname: "Hoshia",
      type: "reply",
      content: "reply",
      parent_interaction_id: "comment-pending",
      created_at: "2026-06-11T03:30:00.000Z"
    });

    const posts = db.countHoshiaPostsForDay({
      now: "2026-06-11T04:00:00.000Z",
      timeZone: "Asia/Shanghai"
    });
    const replies = db.countHoshiaRepliesForDay({
      now: "2026-06-11T04:00:00.000Z",
      timeZone: "Asia/Shanghai"
    });
    const statuses = db.countHoshiaCommentReplyStatuses();

    assert.equal(posts.day_key, "20260611");
    assert.equal(posts.total, 2);
    assert.equal(posts.by_source.daily_state, 1);
    assert.equal(posts.by_source.state_pulse, 1);
    assert.equal(replies.total, 1);
    assert.equal(statuses.pending, 1);
    assert.equal(statuses.failed, 1);
    assert.equal(statuses.skipped, 1);
  } finally {
    cleanup();
  }
});

test("user profile and password can be updated", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({ id: "code-1", codeHash: hashAccessCode("HOSHA-PROF-1111") });
    const user = db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("HOSHA-PROF-1111"),
      user: {
        id: "user-1",
        username: "Friend",
        passwordHash: hashPassword("password-1"),
        nickname: "Friend"
      }
    });

    const updated = db.updateUserProfile(user.id, {
      nickname: "Blue Friend",
      avatarUrl: "https://example.com/avatar.png",
      danmakuColor: "#7DDCFF"
    });
    assert.equal(updated.nickname, "Blue Friend");
    assert.equal(updated.avatar_url, "https://example.com/avatar.png");
    assert.equal(updated.danmaku_color, "#7DDCFF");

    const passwordUpdated = db.updateUserPassword(user.id, hashPassword("new-password-1"));
    assert.equal(passwordUpdated.id, "user-1");
    assert.notEqual(passwordUpdated.password_hash, user.password_hash);

    const onlineUpdated = db.addUserOnlineSeconds(user.id, 95);
    assert.equal(onlineUpdated.total_online_seconds, 95);
    assert.equal(db.countUsers(), 1);

    const audience = db.listAudienceUsers();
    assert.equal(audience.length, 1);
    assert.equal(audience[0].nickname, "Blue Friend");
    assert.equal(audience[0].danmaku_color, "#7DDCFF");
    assert.equal(audience[0].total_online_seconds, 95);
  } finally {
    cleanup();
  }
});

test("character events are idempotent and snapshots are cached", () => {
  const { db, cleanup } = openTempDb();
  try {
    const first = db.insertCharacterEvent({
      event_id: "evt-1",
      idempotency_key: "room:user.message:msg-1",
      room_id: "room",
      character_id: "hoshia",
      event_type: "user.message_received",
      actor_type: "user",
      user_id: "user-1",
      nickname: "Tester",
      source_kind: "chat",
      source_id: "msg-1",
      occurred_at: "2026-06-12T00:00:00.000Z",
      public_hint: "Tester sent a message",
      private_hint: "Tester greeted Hoshia",
      reason: "viewer message",
      data_json: "{\"status\":\"received\"}"
    });
    const duplicate = db.insertCharacterEvent({
      event_id: "evt-duplicate",
      idempotency_key: "room:user.message:msg-1",
      room_id: "room",
      character_id: "hoshia",
      event_type: "user.message_received",
      occurred_at: "2026-06-12T00:00:01.000Z"
    });

    assert.equal(first.event_id, "evt-1");
    assert.equal(duplicate.event_id, "evt-1");
    assert.equal(db.listRecentCharacterEvents({ roomId: "room" }).length, 1);

    db.upsertCharacterSnapshot({
      roomId: "room",
      snapshot: {
        schema_version: 1,
        character_id: "hoshia",
        snapshot_id: "snap-1",
        generated_at: "2026-06-12T00:00:02.000Z",
        source_revision: "rev-1",
        public: { presence: { character_state: "IDLE" } }
      }
    });
    assert.equal(db.getLatestCharacterSnapshot({ roomId: "room" }).snapshot_id, "snap-1");
  } finally {
    cleanup();
  }
});

test("onboarding profile can be completed or skipped", () => {
  const { db, cleanup } = openTempDb();
  try {
    db.insertRegistrationCode({ id: "code-1", codeHash: hashAccessCode("HOSHA-AI-1111") });
    const user = db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode("HOSHA-AI-1111"),
      user: {
        id: "user-ai",
        username: "AiFriend",
        passwordHash: hashPassword("password-1"),
        nickname: "Ai Friend"
      }
    });

    assert.equal(user.onboarding_completed, 0);
    assert.equal(user.ai_profile_json, null);

    const profile = {
      preferred_name: "前辈",
      reply_style: "teasing_friend",
      reply_style_text: "像损友一样",
      interests: "游戏和音乐",
      memory_enabled: true
    };
    const completed = db.completeUserOnboarding(user.id, profile);
    assert.equal(completed.onboarding_completed, 1);
    assert.deepEqual(JSON.parse(completed.ai_profile_json), profile);

    const skipped = db.completeUserOnboarding(user.id, null);
    assert.equal(skipped.onboarding_completed, 1);
    assert.equal(skipped.ai_profile_json, null);
  } finally {
    cleanup();
  }
});

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-db-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
