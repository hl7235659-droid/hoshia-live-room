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
  assert.ok(plan.events.length >= 5);
  assert.ok(plan.events.length <= 8);
  for (const event of plan.events) {
    assert.ok(event.id);
    assert.match(event.time_range, /^\d{2}:\d{2}-\d{2}:\d{2}$/);
    assert.ok(event.type);
    assert.ok(event.title);
    assert.ok(event.summary);
    assert.ok(event.detail_seed);
    assert.ok(event.detail_seed.length <= 180);
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

  assert.equal(active.time_range, "21:10-22:00");
  assert.equal(active.type, "interest_intake");
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
