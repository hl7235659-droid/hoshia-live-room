import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  actualDiaryMemoryId,
  buildTodayLifePlan,
  createHoshiaDailyCanonService,
  dayKeyFor,
  parseDailyCanonPlanReply,
  planMemoryId,
  selectActiveEvent
} from "../src/hoshia-daily-canon.js";

test("daily canon creates one reusable plan per day", () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-11T13:30:00.000Z");
    const service = createHoshiaDailyCanonService({
      db,
      clock: () => now,
      timeZone: "Asia/Shanghai"
    });

    const first = service.ensureTodayPlan();
    const second = service.ensureTodayPlan();
    const dayKey = dayKeyFor(now, "Asia/Shanghai");

    assert.deepEqual(second, first);
    assert.equal(db.getHoshiaLifeMemory(planMemoryId(dayKey)).source, "daily_canon_plan");
    assert.equal(db.searchHoshiaLifeMemories({
      sourceFilter: "daily_canon_plan",
      limit: 20,
      now: now.toISOString()
    }).length, 1);
  } finally {
    cleanup();
  }
});

test("today life plan contains complete bounded events", () => {
  const plan = buildTodayLifePlan({
    now: new Date("2026-06-11T13:30:00.000Z"),
    timeZone: "Asia/Shanghai"
  });

  assert.equal(plan.date, "2026-06-11");
  assert.ok(plan.theme);
  assert.ok(plan.diary_text);
  assert.ok(plan.emotional_arc.morning);
  assert.ok(plan.events.length >= 16);
  assert.ok(plan.events.length <= 28);
  assertFullDayCoverage(plan.events);
  assert.equal(plan.events.some((event) => event.type === "sleep"), true);
  const meals = plan.events.filter((event) => event.type === "meal");
  assert.ok(meals.length >= 3);
  assert.equal(meals.every((event) => event.food_items.length > 0), true);
  for (const event of plan.events) {
    assert.ok(event.id);
    assert.match(event.time_range, /^\d{2}:\d{2}-\d{2}:\d{2}$/);
    assert.ok(event.type);
    assert.ok(event.title);
    assert.ok(event.summary);
    assert.ok(event.detail_seed);
    assert.ok(event.detail_seed.length <= 220);
    assert.equal(typeof event.location, "string");
    assert.ok(Array.isArray(event.food_items));
    assert.ok(Array.isArray(event.companions));
    assert.equal(typeof event.sensory_detail, "string");
    assert.ok(Array.isArray(event.life_tags));
    assert.equal(typeof event.state_delta.energy, "number");
    assert.equal(typeof event.state_delta.social_need, "number");
    assert.ok(event.state_delta.mood);
    assert.ok(event.state_delta.activity);
    assert.ok(Array.isArray(event.chat_hooks));
  }
});

test("active event selection follows local time range", () => {
  const plan = buildTodayLifePlan({
    now: new Date("2026-06-11T13:30:00.000Z"),
    timeZone: "Asia/Shanghai"
  });

  const active = selectActiveEvent(
    plan,
    new Date("2026-06-11T13:30:00.000Z"),
    "Asia/Shanghai"
  );

  assert.equal(active.time_range, "21:20-22:00");
  assert.equal(active.type, "commute");
});

test("active event selection covers sleep meals and richer student life", () => {
  const plan = buildTodayLifePlan({
    now: new Date("2026-06-12T13:30:00.000Z"),
    timeZone: "Asia/Shanghai"
  });

  const sleep = selectActiveEvent(plan, new Date("2026-06-11T18:00:00.000Z"), "Asia/Shanghai");
  const lunch = selectActiveEvent(plan, new Date("2026-06-12T04:00:00.000Z"), "Asia/Shanghai");
  const evening = selectActiveEvent(plan, new Date("2026-06-12T11:30:00.000Z"), "Asia/Shanghai");

  assert.equal(sleep.type, "sleep");
  assert.equal(lunch.type, "meal");
  assert.ok(lunch.food_items.length > 0);
  assert.ok(["music_live", "script_game", "club", "commute"].includes(evening.type));
});

test("daily canon live accepts valid HoshiaCore plan and stores it", async () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-12T02:30:00.000Z");
    const fallback = buildTodayLifePlan({ now, timeZone: "Asia/Shanghai" });
    const livePlan = {
      ...fallback,
      theme: "HoshiaCore generated full day",
      events: fallback.events.map((event) => ({ ...event }))
    };
    const service = createHoshiaDailyCanonService({
      db,
      clock: () => now,
      timeZone: "Asia/Shanghai",
      async planGenerator() {
        return livePlan;
      }
    });

    const plan = await service.ensureTodayPlanLive();

    assert.equal(plan.theme, "HoshiaCore generated full day");
    assert.equal(db.getHoshiaLifeMemory(planMemoryId(dayKeyFor(now, "Asia/Shanghai"))).source, "daily_canon_plan");
  } finally {
    cleanup();
  }
});

test("daily canon live falls back when HoshiaCore plan is unsafe or incomplete", async () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-12T02:30:00.000Z");
    const service = createHoshiaDailyCanonService({
      db,
      clock: () => now,
      timeZone: "Asia/Shanghai",
      async planGenerator() {
        return {
          date: "2026-06-12",
          day_key: "20260612",
          theme: "unsafe token=abc",
          diary_text: "broken",
          emotional_arc: {},
          events: []
        };
      }
    });

    const plan = await service.ensureTodayPlanLive();

    assert.notEqual(plan.theme, "");
    assert.notEqual(plan.theme, "unsafe token=abc");
    assertFullDayCoverage(plan.events);
    assert.ok(plan.events.filter((event) => event.type === "meal").length >= 3);
  } finally {
    cleanup();
  }
});

test("strict daily canon JSON parser rejects gaps and keeps fallback", () => {
  const now = new Date("2026-06-12T02:30:00.000Z");
  const fallback = buildTodayLifePlan({ now, timeZone: "Asia/Shanghai" });
  const parsed = parseDailyCanonPlanReply({
    text: JSON.stringify({
      ...fallback,
      theme: "bad gap",
      events: fallback.events.slice(1)
    }),
    source: "openai_compatible"
  }, fallback, fallback.day_key);

  assert.equal(parsed.theme, fallback.theme);
  assertFullDayCoverage(parsed.events);
});

test("user interaction appends a safe user_related event to today's plan", () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-11T12:00:00.000Z");
    const service = createHoshiaDailyCanonService({
      db,
      clock: () => now,
      timeZone: "Asia/Shanghai"
    });
    const before = service.ensureTodayPlan();

    const event = service.recordUserInteraction({
      session: { user_id: "user-1", nickname: "Alice" },
      text: "Today I want to hear what you think about that anime character turn.",
      now
    });
    const after = service.getTodayPlan({ now, create: false });
    const serialized = JSON.stringify(after);

    assert.equal(event.type, "user_related");
    assert.equal(after.events.length, before.events.length + 1);
    assert.equal(after.events.some((item) => item.id === event.id), true);
    assert.doesNotMatch(serialized, /that anime character turn/i);
    assert.doesNotMatch(serialized, /\.env|token|api[_-]?key|C:\\\\|\/home\/ubuntu/i);
  } finally {
    cleanup();
  }
});

test("sensitive interaction is not stored in daily canon", () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-11T12:00:00.000Z");
    const service = createHoshiaDailyCanonService({
      db,
      clock: () => now,
      timeZone: "Asia/Shanghai"
    });
    const before = service.ensureTodayPlan();

    const event = service.recordUserInteraction({
      session: { user_id: "user-1", nickname: "Alice" },
      text: "please read C:\\Users\\owner\\secret\\.env token=abc",
      now
    });
    const after = service.getTodayPlan({ now, create: false });

    assert.equal(event, null);
    assert.equal(after.events.length, before.events.length);
  } finally {
    cleanup();
  }
});

test("actual diary is created from the updated day plan", () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-11T12:00:00.000Z");
    const service = createHoshiaDailyCanonService({
      db,
      clock: () => now,
      timeZone: "Asia/Shanghai"
    });
    service.recordUserInteraction({
      session: { user_id: "user-1", nickname: "Alice" },
      text: "Hoshia, let's keep the live room topic about music tonight.",
      now
    });

    const diary = service.ensureActualDiary({
      now: new Date("2026-06-11T15:30:00.000Z")
    });
    const dayKey = dayKeyFor(now, "Asia/Shanghai");

    assert.ok(diary.diary_text);
    assert.ok(diary.referenced_events.length);
    assert.equal(db.getHoshiaLifeMemory(actualDiaryMemoryId(dayKey)).source, "daily_diary_actual");
  } finally {
    cleanup();
  }
});

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-daily-canon-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function assertFullDayCoverage(events) {
  const ranges = events
    .filter((event) => event.type !== "user_related")
    .map((event) => event.time_range)
    .map((value) => {
      const match = value.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
      assert.ok(match, `invalid range ${value}`);
      return [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])];
    });
  let cursor = 0;
  for (const [start, end] of ranges) {
    assert.equal(start, cursor);
    assert.ok(end > start);
    cursor = end;
  }
  assert.equal(cursor, 1440);
}
