import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  createHoshiaInterestSystem,
  hoshiaInterestProfile,
  scoreInterestProfile
} from "../src/hoshia-interest-system.js";
import { createHoshiaLifeMemoryService } from "../src/hoshia-life-memory.js";

test("interest system records a daily canon summary once per day", () => {
  const { db, cleanup } = openTempDb();
  try {
    const lifeMemoryService = createHoshiaLifeMemoryService({ db });
    const system = createHoshiaInterestSystem({
      lifeMemoryService,
      clock: () => new Date("2026-06-11T12:00:00.000Z")
    });

    const first = system.recordDailyPost({
      id: "post-1",
      activity: "gaming",
      mood: "competitive",
      source_type: "daily_state",
      content: "Hoshia felt competitive today."
    });
    const second = system.recordDailyPost({
      id: "post-2",
      activity: "otaku",
      mood: "curious",
      source_type: "state_pulse",
      content: "Hoshia still wants to talk about anime."
    });

    const memories = db.searchHoshiaLifeMemories({
      sourceFilter: "daily_canon",
      query: "",
      limit: 10
    });

    assert.equal(first?.source, "daily_canon");
    assert.equal(second, null);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].source_id, "20260611");
    assert.match(memories[0].content, /daily canon/i);
  } finally {
    cleanup();
  }
});

test("interest system captures purified interest signals and stays sensitive-safe", () => {
  const { db, cleanup } = openTempDb();
  try {
    const lifeMemoryService = createHoshiaLifeMemoryService({ db });
    const system = createHoshiaInterestSystem({
      lifeMemoryService,
      clock: () => new Date("2026-06-11T12:00:00.000Z")
    });

    const memories = system.recordInteractionSignals({
      batch: [
        {
          session: { user_id: "user-1", nickname: "Alice" },
          text: "你今天想不想聊新番和比赛？"
        }
      ],
      moduleMemoryEvents: [
        {
          module_id: "music",
          user_id: "user-1",
          nickname: "Alice",
          summary_hint: "Alice mentioned a song request with token=secret"
        }
      ]
    });

    const allMemories = db.searchHoshiaLifeMemories({
      sourceFilter: "interest_system",
      query: "",
      limit: 20
    });

    assert.equal(memories.length >= 1, true);
    assert.equal(allMemories.length >= 1, true);
    assert.equal(allMemories.every((memory) => memory.type === "event"), true);
    assert.equal(allMemories.every((memory) => Date.parse(memory.expires_at) <= Date.parse("2026-06-18T12:00:01.000Z")), true);
    assert.equal(JSON.stringify(allMemories).includes("token=secret"), false);
    assert.equal(JSON.stringify(allMemories).includes(".env"), false);
  } finally {
    cleanup();
  }
});

test("explicit interest preference may become a short preference memory", () => {
  const { db, cleanup } = openTempDb();
  try {
    const lifeMemoryService = createHoshiaLifeMemoryService({ db });
    const system = createHoshiaInterestSystem({
      lifeMemoryService,
      clock: () => new Date("2026-06-11T12:00:00.000Z")
    });

    system.recordInteractionSignals({
      batch: [
        {
          session: { user_id: "user-1", nickname: "Alice" },
          text: "记住，我喜欢新番和二次元话题"
        }
      ]
    });

    const allMemories = db.searchHoshiaLifeMemories({
      sourceFilter: "interest_system",
      query: "",
      limit: 20
    });

    assert.equal(allMemories.some((memory) => memory.type === "preference"), true);
  } finally {
    cleanup();
  }
});

test("interest system skips duplicate memory ids instead of throwing", () => {
  let writes = 0;
  const lifeMemoryService = {
    searchMemories() {
      return [];
    },
    addMemory(memory) {
      writes += 1;
      if (writes > 1) throw new Error("UNIQUE constraint failed: hoshia_life_memories.id");
      return memory;
    }
  };
  const system = createHoshiaInterestSystem({
    lifeMemoryService,
    clock: () => new Date("2026-06-11T12:00:00.000Z")
  });

  const input = {
    batch: [
      {
        session: { user_id: "user-1", nickname: "Alice" },
        text: "anime episode and manga topic"
      }
    ]
  };

  assert.equal(system.recordInteractionSignals(input).length, 1);
  assert.deepEqual(system.recordInteractionSignals(input), []);
});

test("interest profile scoring prefers matching themes and adds fatigue", () => {
  const ranked = scoreInterestProfile(hoshiaInterestProfile, {
    memories: [
      {
        content: "Alice talked about anime and the new episode.",
        user_id: "user-1",
        tags: ["anime"],
        created_at: "2026-06-11T00:00:00.000Z",
        importance: 0.8
      },
      {
        content: "Alice also asked about ranked esports and patch notes.",
        user_id: "user-1",
        tags: ["esports"],
        created_at: "2026-06-11T01:00:00.000Z",
        importance: 0.8
      },
      {
        content: "Alice kept talking about esports again.",
        user_id: "user-1",
        tags: ["esports"],
        created_at: "2026-06-11T02:00:00.000Z",
        importance: 0.8
      }
    ],
    userId: "user-1",
    now: new Date("2026-06-11T12:00:00.000Z")
  });

  assert.equal(ranked[0].id === "anime" || ranked[0].id === "esports", true);
  const esports = ranked.find((item) => item.id === "esports");
  assert.equal(typeof esports?.fatigue, "number", true);
  assert.equal(esports.score <= 1.4, true);
});

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-interest-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
