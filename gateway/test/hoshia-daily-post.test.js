import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  buildDailyPostContent,
  createHoshiaDailyPostCreatedEvent,
  createHoshiaDailyPostService,
  dayKeyFor,
  normalizeDailyPostLimit
} from "../src/hoshia-daily-post.js";

test("daily post service plans an internal state post from visual state", () => {
  const service = createHoshiaDailyPostService({
    visualStateService: visualState({
      activity: "gaming",
      mood: "annoyed",
      energy: 82,
      social_need: 30
    }),
    clock: () => new Date("2026-06-10T13:00:00.000Z")
  });

  const plan = service.planDailyPost();

  assert.equal(plan.ok, true);
  assert.equal(plan.postInput.character_id, "hoshia");
  assert.equal(plan.postInput.source_type, "daily_state");
  assert.equal(plan.postInput.activity, "gaming");
  assert.equal(plan.postInput.mood, "annoyed");
  assert.equal(plan.postInput.image_url, "");
  assert.match(plan.postInput.content, /排位|键盘|游戏/);
  assert.doesNotMatch(plan.postInput.content, /小红书|微博|B站|http/i);
});

test("daily tick is disabled by default unless forced by the caller", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      visualStateService: visualState({ activity: "idle", mood: "calm" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const skipped = service.tick();
    assert.equal(skipped.created, false);
    assert.equal(skipped.reason, "daily_post_disabled");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 0);

    const created = service.tick({ force: true });
    assert.equal(created.created, true);
    assert.equal(created.post.source_type, "daily_state");
    assert.equal(created.moduleEvent.module_id, "hoshia_daily_post");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 1);
  } finally {
    cleanup();
  }
});

test("daily tick creates at most one post for the same Shanghai day", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({
        activity: "sleepy",
        mood: "sleepy",
        energy: 22,
        social_need: 80
      }),
      clock: () => new Date("2026-06-10T15:30:00.000Z")
    });

    const first = service.tick();
    const second = service.tick();

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.reason, "daily_limit_reached");
    assert.equal(second.post.id, first.post.id);
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 1);
  } finally {
    cleanup();
  }
});

test("daily limit uses Asia Shanghai calendar days", () => {
  assert.equal(dayKeyFor("2026-06-09T16:30:00.000Z"), "20260610");
  assert.equal(dayKeyFor("2026-06-10T15:59:59.000Z"), "20260610");
  assert.equal(dayKeyFor("2026-06-10T16:00:00.000Z"), "20260611");
});

test("daily post event exposes only safe short module data", () => {
  const event = createHoshiaDailyPostCreatedEvent(
    {
      id: "post-1",
      created_at: "2026-06-10T12:00:00.000Z"
    },
    {
      activity: "thinking",
      mood: "focused",
      state_reason: "token=secret"
    },
    { roomId: "live-room-dev" }
  );

  assert.equal(event.module_id, "hoshia_daily_post");
  assert.equal(event.event_type, "hoshia_daily_post.created");
  assert.equal(event.memory_eligible, true);
  assert.deepEqual(event.data, {
    activity: "thinking",
    mood: "focused",
    source: "daily_state",
    reason: "internal_state_daily_post"
  });
});

test("daily content reflects energy and social need without external topics", () => {
  const content = buildDailyPostContent({
    activity: "emo",
    mood: "lonely",
    energy: 12,
    social_need: 90
  }, new Date("2026-06-10T18:00:00.000Z"));

  assert.match(content, /低电量|能量条|有人来/);
  assert.doesNotMatch(content, /小红书|微博|B站|新闻|http/i);
  assert.equal(normalizeDailyPostLimit(0), 1);
  assert.equal(normalizeDailyPostLimit(20), 10);
});

function visualState(state) {
  return {
    publicState() {
      return {
        character_id: "hoshia",
        energy: 72,
        social_need: 48,
        current_png: "",
        state_reason: "test",
        updated_at: "2026-06-10T12:00:00.000Z",
        ...state
      };
    }
  };
}

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-daily-post-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
