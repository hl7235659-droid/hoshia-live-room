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
    assert.equal(packet.some((line) => line.includes("Hoshia life memory")), true);

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
