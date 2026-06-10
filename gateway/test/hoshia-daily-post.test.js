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
  assert.equal(plan.postInput.id, "daily_20260610_1_gaming_annoyed");
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
    assert.equal(created.daily_count, 1);
    assert.equal(created.daily_min, 1);
    assert.equal(created.daily_max, 5);
    assert.equal(created.moduleEvent.module_id, "hoshia_daily_post");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 1);
  } finally {
    cleanup();
  }
});

test("daily tick creates at least one daily_state and caps each day at five posts", () => {
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

    const results = Array.from({ length: 6 }, () => service.tick());

    assert.equal(results[0].created, true);
    assert.equal(results[0].post.source_type, "daily_state");
    assert.equal(results[0].post.id, "daily_20260610_1_sleepy_sleepy");
    assert.equal(results[0].daily_count, 1);
    assert.equal(results[4].created, true);
    assert.equal(results[4].post.source_type, "state_pulse");
    assert.equal(results[4].post.id, "pulse_20260610_5_sleepy_sleepy");
    assert.equal(results[4].daily_count, 5);
    assert.equal(results[5].created, false);
    assert.equal(results[5].reason, "daily_max_reached");
    assert.equal(results[5].daily_count, 5);
    assert.equal(results[5].daily_min, 1);
    assert.equal(results[5].daily_max, 5);
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 5);
  } finally {
    cleanup();
  }
});

test("dailyMin controls daily_state quota before state_pulse posts", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      dailyMin: 2,
      dailyMax: 5,
      visualStateService: visualState({ activity: "thinking", mood: "focused" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const first = service.tick();
    const second = service.tick();
    const third = service.tick();

    assert.equal(first.post.source_type, "daily_state");
    assert.equal(second.post.source_type, "daily_state");
    assert.equal(third.post.source_type, "state_pulse");
    assert.equal(first.post.id, "daily_20260610_1_thinking_focused");
    assert.equal(second.post.id, "daily_20260610_2_thinking_focused");
    assert.equal(third.post.id, "pulse_20260610_3_thinking_focused");
  } finally {
    cleanup();
  }
});

test("daily tick respects minimum interval unless forced", () => {
  const { db, cleanup } = openTempDb();
  try {
    let now = new Date("2026-06-10T12:00:00.000Z");
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      minIntervalMinutes: 60,
      visualStateService: visualState({ activity: "happy", mood: "playful" }),
      clock: () => now
    });

    const first = service.tick();
    now = new Date("2026-06-10T12:30:00.000Z");
    const skipped = service.tick();
    const forced = service.tick({ force: true });

    assert.equal(first.created, true);
    assert.equal(skipped.created, false);
    assert.equal(skipped.reason, "daily_post_min_interval");
    assert.equal(skipped.daily_count, 1);
    assert.equal(forced.created, true);
    assert.equal(forced.post.source_type, "state_pulse");
    assert.equal(forced.daily_count, 2);
  } finally {
    cleanup();
  }
});

test("repeated identical state creates non-conflicting sequence ids", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({ activity: "otaku", mood: "curious" }),
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const ids = Array.from({ length: 5 }, () => service.tick().post.id);

    assert.deepEqual(ids, [
      "daily_20260610_1_otaku_curious",
      "pulse_20260610_2_otaku_curious",
      "pulse_20260610_3_otaku_curious",
      "pulse_20260610_4_otaku_curious",
      "pulse_20260610_5_otaku_curious"
    ]);
    assert.equal(new Set(ids).size, 5);
  } finally {
    cleanup();
  }
});

test("force bypasses disabled and active window checks but not daily max", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: false,
      activeWindow: { startHour: 9, endHour: 17 },
      visualStateService: visualState({ activity: "sports", mood: "energetic" }),
      clock: () => new Date("2026-06-10T18:00:00.000Z")
    });

    const results = Array.from({ length: 6 }, () => service.tick({ force: true }));

    assert.equal(results.filter((result) => result.created).length, 5);
    assert.equal(results[5].created, false);
    assert.equal(results[5].reason, "daily_max_reached");
    assert.equal(results[5].daily_count, 5);
  } finally {
    cleanup();
  }
});

test("ignoreLimit is available only for tests that need to bypass daily max", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({ activity: "gaming", mood: "competitive" }),
      clock: () => new Date("2026-06-10T09:00:00.000Z")
    });

    const results = Array.from({ length: 6 }, () => service.tick({ ignoreLimit: true }));

    assert.equal(results[5].created, true);
    assert.equal(results[5].daily_count, 6);
    assert.equal(results[5].post.id, "pulse_20260610_6_gaming_competitive");
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
