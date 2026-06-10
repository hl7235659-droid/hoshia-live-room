import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  createHoshiaVisualStateService,
  hoshiaStagePngAssets,
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

test("visual state only nudges internal energy and social need on chat", () => {
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
