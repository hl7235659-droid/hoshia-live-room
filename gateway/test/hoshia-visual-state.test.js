import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  createHoshiaVisualStateService,
  hoshiaStagePngAssets,
  normalizeHoshiaNewsSignal,
  normalizeHoshiaTickWindow,
  randomHoshiaTickDelayMs,
  selectAssetForState,
  visualDescriptionForStagePng
} from "../src/hoshia-visual-state.js";

test("visual state service creates a default persisted Hoshia state", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const state = service.publicState();
    assert.equal(state.character_id, "hoshia");
    assert.equal(state.activity, "idle");
    assert.equal(state.mood, "calm");
    assert.equal(state.current_png, "/assets/hoshia/stage-png/idle_calm_01.png");
    assert.match(state.visual_description, /white-haired/i);
    assert.equal(db.getHoshiaState("hoshia").current_png, state.current_png);
  } finally {
    cleanup();
  }
});

test("quiet late-night interaction only nudges internal energy and social need", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const before = service.publicState();
    const result = service.applyUserInteraction({
      text: "今天晚上晚安，辛苦啦",
      session: { user_id: "user-1", nickname: "viewer" }
    });

    assert.equal(result.changed, true);
    assert.equal(result.state.activity, before.activity);
    assert.equal(result.state.mood, before.mood);
    assert.equal(result.state.current_png, before.current_png);
    assert.ok(result.state.energy < before.energy);
    assert.ok(result.state.social_need >= before.social_need);
  } finally {
    cleanup();
  }
});

test("viewer topic does not directly switch activity mood or PNG", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const result = service.applyUserInteraction({
      text: "that ranked match was a lost game, need more practice",
      session: { user_id: "user-1", nickname: "viewer" }
    });

    assert.equal(result.changed, true);
    assert.equal(result.state.activity, "idle");
    assert.equal(result.state.mood, "calm");
    assert.match(result.state.current_png, /idle_calm_01/);
    assert.ok(result.state.social_need < 48);
  } finally {
    cleanup();
  }
});

test("news signal does not directly switch PNG and only affects state on tick", () => {
  const { db, cleanup } = openTempDb();
  try {
    const now = new Date("2026-06-10T10:00:00.000Z");
    const service = createHoshiaVisualStateService({
      db,
      clock: () => now
    });

    const before = service.publicState();
    const signal = service.applyNewsSignal({
      activity_hint: "happy",
      mood_hint: "playful",
      energy_delta: 20,
      social_need_delta: -10,
      expires_at: "2026-06-10T11:00:00.000Z",
      reason: "light news topic reaction"
    });
    const afterSignal = service.publicState();

    assert.equal(signal.accepted, true);
    assert.equal(signal.changed, false);
    assert.equal(afterSignal.activity, before.activity);
    assert.equal(afterSignal.mood, before.mood);
    assert.equal(afterSignal.energy, before.energy);
    assert.equal(afterSignal.current_png, before.current_png);

    const ticked = service.tick({
      now: new Date("2026-06-10T10:10:00.000Z"),
      reason: "scheduled visual refresh"
    });

    assert.equal(ticked.state.activity, "happy");
    assert.equal(ticked.state.mood, "playful");
    assert.ok(ticked.state.energy > before.energy);
    assert.notEqual(ticked.state.current_png, before.current_png);
  } finally {
    cleanup();
  }
});

test("expired news signal is rejected before it can affect visual state", () => {
  assert.equal(normalizeHoshiaNewsSignal({
    activity_hint: "happy",
    energy_delta: 20,
    expires_at: "2026-06-10T09:00:00.000Z"
  }, new Date("2026-06-10T10:00:00.000Z")), null);
});

test("scheduled tick applies late-night rhythm and unmet social need", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });
    service.update({
      activity: "idle",
      mood: "calm",
      energy: 50,
      social_need: 62,
      state_reason: "test setup",
      updated_at: "2026-06-10T10:00:00.000Z"
    });

    const result = service.tick({
      reason: "scheduled visual refresh",
      now: new Date("2026-06-10T16:30:00.000Z")
    });

    assert.equal(result.state.activity, "sleepy");
    assert.equal(result.state.mood, "lonely");
    assert.equal(result.state.energy, 43);
    assert.equal(result.state.social_need, 68);
    assert.match(result.state.current_png, /sleepy_lonely_02/);
  } finally {
    cleanup();
  }
});

test("scheduled tick applies active daily canon event before fallback rhythm", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const result = service.tick({
      reason: "scheduled visual refresh",
      now: new Date("2026-06-10T10:10:00.000Z"),
      canonEvent: {
        title: "Game replay in her head",
        type: "anime_game",
        state_delta: {
          energy: -3,
          social_need: 8,
          mood: "competitive",
          activity: "gaming"
        }
      }
    });

    assert.equal(result.state.activity, "gaming");
    assert.equal(result.state.mood, "competitive");
    assert.equal(result.state.energy, 69);
    assert.equal(result.state.social_need, 56);
    assert.match(result.state.state_reason, /daily canon/i);
    assert.match(result.state.current_png, /gaming_competitive_01/);
  } finally {
    cleanup();
  }
});

test("scheduled tick maps concrete diary events to current mood and activity", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const sleep = service.tick({
      reason: "scheduled visual refresh",
      now: new Date("2026-06-10T16:30:00.000Z"),
      canonEvent: {
        title: "Dorm sleep",
        type: "sleep",
        state_delta: { energy: -10, social_need: 3, mood: "sleepy", activity: "sleepy" }
      }
    });
    assert.equal(sleep.state.activity, "sleepy");
    assert.equal(sleep.state.mood, "sleepy");

    const library = service.tick({
      reason: "scheduled visual refresh",
      now: new Date("2026-06-11T02:30:00.000Z"),
      canonEvent: {
        title: "Library study",
        type: "study",
        state_delta: { energy: -5, social_need: -4, mood: "focused", activity: "thinking" }
      }
    });
    assert.equal(library.state.activity, "thinking");
    assert.equal(library.state.mood, "focused");

    const livehouse = service.tick({
      reason: "scheduled visual refresh",
      now: new Date("2026-06-11T11:30:00.000Z"),
      canonEvent: {
        title: "Live House standing ticket",
        type: "music_live",
        state_delta: { energy: -10, social_need: -12, mood: "excited", activity: "happy" }
      }
    });
    assert.equal(livehouse.state.activity, "happy");
    assert.equal(livehouse.state.mood, "excited");
    assert.match(livehouse.state.state_reason, /daily canon: Live House standing ticket/);
  } finally {
    cleanup();
  }
});

test("scheduled tick decays stale transient activities toward idle", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });
    service.update({
      activity: "gaming",
      mood: "competitive",
      energy: 65,
      social_need: 40,
      state_reason: "scheduled visual refresh",
      updated_at: "2026-06-10T10:00:00.000Z"
    });

    const result = service.tick({
      reason: "scheduled visual refresh",
      now: new Date("2026-06-10T03:00:00.000Z")
    });

    assert.equal(result.state.activity, "idle");
    assert.equal(result.state.mood, "calm");
    assert.equal(result.state.social_need, 44);
    assert.match(result.state.current_png, /idle_calm_01|idle_calm_02/);
  } finally {
    cleanup();
  }
});

test("visual state reason strips path-like or internal details before module events use it", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaVisualStateService({
      db,
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const result = service.tick({
      reason: "loaded from C:\\Users\\owner\\secret\\.env",
      now: new Date("2026-06-10T10:30:00.000Z")
    });

    assert.equal(result.reason, "visual state updated");
    assert.equal(result.state.state_reason, "visual state updated");
    assert.doesNotMatch(result.reason, /C:\\|\.env|secret/i);
  } finally {
    cleanup();
  }
});

test("visual tick rotates within a matching asset pool", () => {
  const current = {
    character_id: "hoshia",
    activity: "idle",
    mood: "calm",
    energy: 72,
    social_need: 40,
    current_png: "/assets/hoshia/stage-png/idle_calm_01.png",
    state_reason: "test",
    updated_at: "2026-06-10T10:00:00.000Z"
  };

  const next = selectAssetForState(current, current.current_png);
  assert.equal(next.path, "/assets/hoshia/stage-png/idle_calm_02.png");
  assert.equal(hoshiaStagePngAssets.length, 16);
});

test("tick window randomization stays inside the configured range", () => {
  assert.deepEqual(normalizeHoshiaTickWindow(60, 20), { minMinutes: 20, maxMinutes: 60 });
  assert.equal(randomHoshiaTickDelayMs({ minMinutes: 20, maxMinutes: 20 }, () => 0.5), 20 * 60 * 1000);
  assert.equal(randomHoshiaTickDelayMs({ minMinutes: 20, maxMinutes: 60 }, () => 0), 20 * 60 * 1000);
  assert.equal(randomHoshiaTickDelayMs({ minMinutes: 20, maxMinutes: 60 }, () => 0.9999), 60 * 60 * 1000);
});

test("visual description can be resolved for any stage asset", () => {
  assert.match(visualDescriptionForStagePng("/assets/hoshia/stage-png/gaming_competitive_01.png"), /controller|game/i);
  assert.match(visualDescriptionForStagePng("/assets/hoshia/stage-png/unknown.png"), /white-haired/i);
});

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-visual-state-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
