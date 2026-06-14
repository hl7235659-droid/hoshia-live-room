import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  createHoshiaLifeMemoryService,
  normalizeCommentInput,
  normalizePostInput,
  publicPost
} from "../src/hoshia-life-memory.js";

test("life memory service records posts comments and builds a memory packet", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });
    const postInput = normalizePostInput({
      content: "刚刚排位输了两把，但我觉得问题不在我。",
      mood: "annoyed",
      activity: "gaming",
      source_type: "manual"
    }, new Date("2026-06-10T11:58:00.000Z"));
    const post = db.createHoshiaPost(postInput);
    service.recordPost(post);

    const commentInput = normalizeCommentInput({
      content: "菜就多练，今天练了吗"
    }, {
      user_id: "user-1",
      nickname: "Alice"
    }, new Date("2026-06-10T11:59:00.000Z"));
    const interaction = db.addHoshiaPostInteraction({
      ...commentInput,
      post_id: post.id
    });
    service.recordInteraction({ post, interaction });

    const packet = service.buildMemoryPacket({
      batch: [{
        session: { user_id: "user-1", nickname: "Alice" },
        text: "今天练了吗"
      }]
    });
    assert.equal(packet.some((line) => line.includes("post_comment")), false);
    assert.equal(packet.some((line) => line.includes("菜就多练")), true);
    assert.equal(packet.some((line) => line.includes("Hoshia 生活记忆")), true);

    const listed = db.listHoshiaPosts({ viewerUserId: "user-1" }).map(publicPost);
    assert.equal(listed[0].interactions[0].content, "菜就多练，今天练了吗");
  } finally {
    cleanup();
  }
});

test("life memory service filters sensitive-looking memory content", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({ db });
    const memory = service.addMemory({
      content: "token=secret should not be saved",
      source: "chat",
      importance: 0.9
    });
    assert.equal(memory, null);
    assert.equal(db.searchHoshiaLifeMemories({ query: "secret" }).length, 0);
  } finally {
    cleanup();
  }
});

test("memory packet links a dynamic comment to a live-room question", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });
    const post = db.createHoshiaPost(normalizePostInput({
      id: "post-practice",
      content: "刚刚排位输了两把，但我觉得问题不在我。",
      mood: "annoyed",
      activity: "gaming",
      source_type: "manual"
    }, new Date("2026-06-10T11:55:00.000Z")));
    service.recordPost(post);

    const comment = db.addHoshiaPostInteraction({
      ...normalizeCommentInput({
        id: "comment-practice",
        content: "菜就多练，今天练了吗"
      }, {
        user_id: "user-1",
        nickname: "Alice"
      }, new Date("2026-06-10T11:58:00.000Z")),
      post_id: post.id
    });
    service.recordInteraction({ post, interaction: comment });

    const reply = db.addHoshiaPostInteraction({
      id: "reply-practice",
      post_id: post.id,
      user_id: "hoshia",
      nickname: "Hoshia",
      type: "reply",
      content: "我会练，等下把下一局结果告诉你。",
      parent_interaction_id: comment.id,
      created_at: "2026-06-10T11:59:00.000Z"
    });
    service.recordInteraction({ post, interaction: reply });

    db.addHoshiaLifeMemory({
      id: "memory-sensitive-practice",
      character_id: "hoshia",
      user_id: "user-1",
      type: "event",
      source: "post_comment",
      source_id: post.id,
      content: "Alice pasted api_key=secret-value while talking about 今天练了吗.",
      importance: 1,
      created_at: "2026-06-10T11:59:30.000Z"
    });

    const packet = service.buildMemoryPacket({
      session: { user_id: "user-1", nickname: "Alice" },
      query: "今天练了吗",
      scene: "live_room",
      limit: 4
    });

    assert.equal(packet.some((line) => line.includes("菜就多练，今天练了吗") || line.includes("下一局结果")), true);
    assert.equal(packet.some((line) => line.includes("secret-value") || line.includes("api_key=")), false);
  } finally {
    cleanup();
  }
});

test("memory packet falls back to recent viewer post memories for short live-room queries", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });
    db.addHoshiaLifeMemory({
      id: "memory-global",
      character_id: "hoshia",
      type: "event",
      source: "post",
      content: "Hoshia wrote a quiet room update.",
      importance: 0.95,
      created_at: "2026-06-10T11:57:00.000Z"
    });
    db.addHoshiaLifeMemory({
      id: "memory-comment",
      character_id: "hoshia",
      user_id: "user-1",
      type: "event",
      source: "post_comment",
      content: "Alice commented on Hoshia's gaming update: practice more after the ranked loss.",
      importance: 0.4,
      created_at: "2026-06-10T11:59:00.000Z",
      expires_at: "2026-07-10T11:59:00.000Z"
    });

    const packet = service.buildMemoryPacket({
      session: { user_id: "user-1", nickname: "Alice" },
      query: "today?",
      limit: 2
    });

    assert.equal(packet.some((line) => line.includes("practice more after the ranked loss")), true);
  } finally {
    cleanup();
  }
});

test("memory packet prioritizes commitments and post replies", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });
    db.addHoshiaLifeMemory({
      id: "memory-event",
      character_id: "hoshia",
      user_id: "user-1",
      type: "event",
      source: "chat",
      content: "Alice talked about today's snack.",
      importance: 1,
      created_at: "2026-06-10T11:59:00.000Z"
    });
    db.addHoshiaLifeMemory({
      id: "memory-reply",
      character_id: "hoshia",
      user_id: "user-1",
      type: "commitment",
      source: "post_reply",
      content: "Hoshia promised in the post thread to show the next win screenshot.",
      importance: 0.35,
      created_at: "2026-06-09T11:00:00.000Z"
    });

    const packet = service.buildMemoryPacket({
      session: { user_id: "user-1", nickname: "Alice" },
      query: "what did you say before?",
      limit: 2
    });

    assert.equal(packet[1].includes("next win screenshot"), true);
  } finally {
    cleanup();
  }
});

test("memory packet filters sensitive rows even if they already exist in storage", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });
    db.addHoshiaLifeMemory({
      id: "memory-safe",
      character_id: "hoshia",
      user_id: "user-1",
      type: "event",
      source: "chat",
      content: "Alice likes late-night gaming talk.",
      importance: 0.6,
      created_at: "2026-06-10T11:58:00.000Z"
    });
    db.addHoshiaLifeMemory({
      id: "memory-sensitive",
      character_id: "hoshia",
      user_id: "user-1",
      type: "event",
      source: "chat",
      content: "Alice pasted token=secret-value from a local config.",
      importance: 1,
      created_at: "2026-06-10T11:59:00.000Z"
    });

    const packet = service.buildMemoryPacket({
      session: { user_id: "user-1", nickname: "Alice" },
      query: "gaming",
      limit: 3
    });

    assert.equal(packet.some((line) => line.includes("late-night gaming talk")), true);
    assert.equal(packet.some((line) => line.includes("secret-value")), false);
    assert.equal(packet.some((line) => line.includes("token=")), false);
  } finally {
    cleanup();
  }
});

test("module memory processor records purified music and pixel game memories", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const music = service.recordModuleMemoryEvent({
      id: "evt-music",
      module_id: "music",
      event_type: "music.song_requested",
      user_id: "user-1",
      nickname: "Alice",
      summary_hint: "Alice explicitly likes classic rock",
      memory_eligible: true,
      memory_kind: "music_preference_candidate",
      retention_days: 30,
      occurred_at: "2026-06-10T11:50:00.000Z",
      data: {
        title: "Purple Rain",
        artist: "Prince",
        source: "musicfree",
        url: "https://example.test/track",
        raw_response: "hidden"
      }
    });
    const game = service.recordModuleMemoryEvent({
      id: "evt-game",
      module_id: "hoshia_pixel_game",
      event_type: "hoshia_pixel_game.run_finished",
      user_id: "user-1",
      nickname: "Alice",
      summary_hint: "Alice finished a strong pixel game run",
      memory_eligible: true,
      memory_kind: "pixel_game_preference_candidate",
      occurred_at: "2026-06-10T11:55:00.000Z",
      data: {
        class_id: "star_idol",
        stage_id: "night_rooftop",
        score_tier: "S",
        raw_prompt: "hidden"
      }
    });

    assert.equal(music.type, "preference");
    assert.equal(game.type, "preference");
    const memories = db.searchHoshiaLifeMemories({ userId: "user-1", query: "", limit: 10 });
    assert.equal(memories.some((memory) => memory.content.includes("style or artist affinity")), true);
    assert.equal(memories.some((memory) => memory.content.includes("playstyle context")), true);
    assert.equal(memories.some((memory) => /raw_response|raw_prompt|https?:\/\//.test(memory.content)), false);
  } finally {
    cleanup();
  }
});

test("module memory processor skips weak or sensitive candidates", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaLifeMemoryService({
      db,
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const weakInterest = service.recordModuleMemoryEvent({
      id: "evt-interest",
      module_id: "hoshia_interest_knowledge",
      event_type: "interest.topic_mentioned",
      user_id: "user-1",
      nickname: "Alice",
      summary_hint: "Alice mentioned a topic once",
      memory_eligible: true,
      memory_kind: "interest_preference_candidate",
      data: { topic: "anime" }
    });
    const sensitiveMusic = service.recordModuleMemoryEvent({
      id: "evt-sensitive",
      module_id: "music",
      event_type: "music.song_requested",
      user_id: "user-1",
      nickname: "Alice",
      summary_hint: "Alice likes token=secret",
      memory_eligible: true,
      memory_kind: "music_preference_candidate",
      data: { title: "token=secret", artist: "Hidden" }
    });

    assert.equal(weakInterest, null);
    assert.equal(sensitiveMusic, null);
    assert.equal(db.searchHoshiaLifeMemories({ userId: "user-1", query: "", limit: 10 }).length, 0);
  } finally {
    cleanup();
  }
});

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-life-memory-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
