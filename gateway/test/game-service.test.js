import assert from "node:assert/strict";
import test from "node:test";
import { createHoshiaPixelGameService } from "../src/game-service.js";

function createFakePixelGameDb() {
  const profiles = new Map();
  const unlocks = new Map();
  const runs = new Map();
  const runEvents = [];
  let finishCalls = 0;
  let shouldForceAlreadyFinishedAtFinish = false;

  function profileKey(userId, roomId) {
    return `${roomId}:${userId}`;
  }

  function clone(value) {
    return value ? JSON.parse(JSON.stringify(value)) : value;
  }

  const db = {
    get finishCalls() {
      return finishCalls;
    },
    get runEvents() {
      return runEvents.map(clone);
    },
    forceAlreadyFinishedAtFinish() {
      shouldForceAlreadyFinishedAtFinish = true;
    },
    ensurePixelGameProfile({ userId, roomId, now }) {
      const key = profileKey(userId, roomId);
      if (!profiles.has(key)) {
        profiles.set(key, {
          user_id: userId,
          room_id: roomId,
          total_runs: 0,
          total_play_seconds: 0,
          total_kills: 0,
          best_score: 0,
          best_level: 1,
          best_wave: 0,
          boss_defeated_count: 0,
          selected_class_id: "",
          created_at: now,
          updated_at: now
        });
      }
      return clone(profiles.get(key));
    },
    listPixelGameClassUnlocks(userId) {
      return [...(unlocks.get(userId) || new Map()).entries()].map(([class_id, item]) => ({
        user_id: userId,
        class_id,
        unlocked_at: item.unlocked_at,
        unlock_reason: item.unlock_reason
      }));
    },
    unlockPixelGameClass({ userId, classId, reason = "progress", now }) {
      if (!unlocks.has(userId)) unlocks.set(userId, new Map());
      const byUser = unlocks.get(userId);
      if (!byUser.has(classId)) byUser.set(classId, { unlocked_at: now, unlock_reason: reason });
      return this.listPixelGameClassUnlocks(userId).find((item) => item.class_id === classId) || null;
    },
    expirePixelGameRuns({ roomId, userId, now }) {
      for (const run of runs.values()) {
        if (run.room_id !== roomId) continue;
        if (userId && run.user_id !== userId) continue;
        if (run.status === "active" && Date.parse(now) > Date.parse(run.expires_at)) {
          run.status = "expired";
          run.updated_at = now;
        }
      }
    },
    getActivePixelGameRun({ roomId, userId, now }) {
      return clone([...runs.values()].find((run) => run.room_id === roomId && run.user_id === userId && run.status === "active" && Date.parse(now) <= Date.parse(run.expires_at)) || null);
    },
    createPixelGameRun(run) {
      const saved = {
        ...run,
        status: "active",
        accepted: 0,
        finished_at: "",
        duration_seconds: 0,
        score: 0,
        kills: 0,
        level: 1,
        waves_cleared: 0,
        boss_result: "not_reached",
        result: "active",
        score_tier: ""
      };
      runs.set(run.id, saved);
      return clone(saved);
    },
    getPixelGameRun(runId) {
      return clone(runs.get(runId) || null);
    },
    getPixelGameRunForUser({ runId, roomId, userId }) {
      const run = runs.get(runId);
      if (!run || run.room_id !== roomId || run.user_id !== userId) return null;
      return clone(run);
    },
    finishPixelGameRun({ runId, roomId, userId, accepted, finishedAt, durationSeconds, score, kills, level, wavesCleared, bossResult, result, scoreTier, reportText }) {
      finishCalls += 1;
      const run = runs.get(runId);
      if (shouldForceAlreadyFinishedAtFinish && run?.status === "active") {
        shouldForceAlreadyFinishedAtFinish = false;
        Object.assign(run, {
          status: "finished",
          accepted: 1,
          finished_at: finishedAt,
          duration_seconds: 120,
          score: 4000,
          kills: 20,
          level: 2,
          waves_cleared: 2,
          boss_result: "failed",
          result: "defeated",
          score_tier: "C",
          report_text: "first concurrent report",
          updated_at: finishedAt
        });
        return { ...clone(run), already_finished: true };
      }
      if (!run || run.room_id !== roomId || run.user_id !== userId || run.status !== "active") return run ? { ...clone(run), already_finished: true } : null;
      Object.assign(run, {
        status: "finished",
        accepted: accepted ? 1 : 0,
        finished_at: finishedAt,
        duration_seconds: durationSeconds,
        score,
        kills,
        level,
        waves_cleared: wavesCleared,
        boss_result: bossResult,
        result,
        score_tier: scoreTier,
        report_text: reportText,
        updated_at: finishedAt
      });
      if (accepted) {
        const key = profileKey(userId, roomId);
        const profile = profiles.get(key) || this.ensurePixelGameProfile({ userId, roomId, now: finishedAt });
        Object.assign(profile, {
          total_runs: Number(profile.total_runs || 0) + 1,
          total_play_seconds: Number(profile.total_play_seconds || 0) + Number(durationSeconds || 0),
          total_kills: Number(profile.total_kills || 0) + Number(kills || 0),
          best_score: Math.max(Number(profile.best_score || 0), Number(score || 0)),
          best_level: Math.max(Number(profile.best_level || 1), Number(level || 1)),
          best_wave: Math.max(Number(profile.best_wave || 0), Number(wavesCleared || 0)),
          boss_defeated_count: Number(profile.boss_defeated_count || 0) + (bossResult === "defeated" ? 1 : 0),
          updated_at: finishedAt
        });
      }
      return clone(run);
    },
    abandonPixelGameRun({ runId, roomId, userId, now }) {
      const run = runs.get(runId);
      if (!run || run.room_id !== roomId || run.user_id !== userId) return null;
      run.status = "abandoned";
      run.updated_at = now;
      return clone(run);
    },
    listPixelGameLeaderboard({ roomId, classId = "", limit = 10 }) {
      return [...runs.values()]
        .filter((run) => run.room_id === roomId && run.status === "finished" && run.accepted)
        .filter((run) => !classId || run.class_id === classId)
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, limit)
        .map(clone);
    },
    insertPixelGameRunEvent(event) {
      runEvents.push(clone(event));
      return clone(event);
    },
    listRecentPixelGameEvents() {
      return this.runEvents;
    }
  };

  return db;
}

function createService({ now = "2026-06-12T00:00:00.000Z", visualState = {}, id = "testid" } = {}) {
  const db = createFakePixelGameDb();
  let currentNow = now;
  const service = createHoshiaPixelGameService({
    db,
    roomId: "room-1",
    hoshiaVisualStateProvider: () => visualState,
    clock: () => new Date(currentNow),
    idGenerator: () => id
  });
  return {
    db,
    service,
    setNow(value) {
      currentNow = value;
    }
  };
}

const viewer = { user_id: "user-1", nickname: "Viewer One" };

test("pixel game start locks sanitized Hoshia visual state into run director fields", () => {
  const { service } = createService({
    visualState: {
      activity: "gaming",
      mood: "competitive!!!",
      energy: 92,
      social_need: 71,
      current_png: "C:\\secret\\stage.png",
      provider_url: "https://internal.example/token=secret"
    }
  });

  const result = service.startRun({ session: viewer, classId: "neon_samurai", clientVersion: "web-1" });

  assert.equal(result.ok, true);
  assert.equal(result.resumed, false);
  assert.equal(result.run.class_id, "neon_samurai");
  assert.equal(result.run.stage_id, "ranked_arcade_matrix");
  assert.equal(result.run.locked_activity, "gaming");
  assert.equal(result.run.locked_mood, "competitive");
  assert.equal(result.run.locked_energy, 92);
  assert.equal(result.run.locked_social_need, 71);
  assert.equal(result.run.difficulty_tier, "S");

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret|https?:\/\/|C:\\/i);
});

test("pixel game finish rejects runs over the 15 minute gameplay cap and abnormal scores", async () => {
  const { service, setNow } = createService({ visualState: { activity: "gaming", mood: "calm", energy: 50, social_need: 30 } });
  const started = service.startRun({ session: viewer, classId: "star_idol" });
  setNow("2026-06-12T00:16:00.000Z");

  const tooLong = await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 960, score: 100, kills: 1, level: 1, waves_cleared: 0 }
  });

  assert.equal(tooLong.ok, true);
  assert.equal(tooLong.accepted, false);
  assert.equal(tooLong.suspicious, true);
  assert.equal(tooLong.reason, "duration_too_long");

  const second = service.startRun({ session: { user_id: "user-2", nickname: "Score Hacker" }, classId: "star_idol" });
  setNow("2026-06-12T00:18:00.000Z");
  const tooHigh = await service.finishRun({
    session: { user_id: "user-2", nickname: "Score Hacker" },
    runId: second.run.run_id,
    payload: { duration_seconds: 60, score: 50000, kills: 1, level: 1, waves_cleared: 0 }
  });

  assert.equal(tooHigh.accepted, false);
  assert.equal(tooHigh.reason, "score_too_high");
});

test("pixel game finish rejects spoofed client results and impossible early kill counts", async () => {
  const { service, setNow } = createService({ visualState: { activity: "gaming", mood: "happy", energy: 55, social_need: 45 }, id: "spoof" });
  const started = service.startRun({ session: viewer, classId: "star_idol" });
  setNow("2026-06-12T00:05:00.000Z");

  const spoofed = await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 300, score: 1200, kills: 10, level: 2, waves_cleared: 4, boss_result: "failed", result: "cleared" }
  });

  assert.equal(spoofed.accepted, false);
  assert.equal(spoofed.reason, "result_mismatch");
  assert.equal(spoofed.run.result, "defeated");

  const second = service.startRun({ session: { user_id: "user-fast", nickname: "Fast" }, classId: "star_idol" });
  setNow("2026-06-12T00:06:00.000Z");
  const tooManyKills = await service.finishRun({
    session: { user_id: "user-fast", nickname: "Fast" },
    runId: second.run.run_id,
    payload: { duration_seconds: 60, score: 1000, kills: 120, level: 2, waves_cleared: 1, boss_result: "failed", result: "defeated" }
  });

  assert.equal(tooManyKills.accepted, false);
  assert.equal(tooManyKills.reason, "kills_too_fast");
});

test("pixel game finish requires final wave before boss defeated settlement", async () => {
  const { service, setNow } = createService({ visualState: { activity: "gaming", mood: "competitive", energy: 80, social_need: 50 } });
  const started = service.startRun({ session: viewer, classId: "stream_hacker" });
  setNow("2026-06-12T00:08:00.000Z");

  const result = await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 480, score: 12000, kills: 80, level: 5, waves_cleared: 14, boss_result: "defeated" }
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "boss_before_final_wave");
  assert.equal(result.run.boss_result, "defeated");
  assert.equal(result.run.accepted, false);
});

test("pixel game finish is idempotent after first settlement", async () => {
  const { service, setNow, db } = createService({ visualState: { activity: "gaming", mood: "happy", energy: 60, social_need: 40 } });
  const started = service.startRun({ session: viewer, classId: "star_idol" });
  setNow("2026-06-12T00:05:00.000Z");

  const first = await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 300, score: 10000, kills: 60, level: 4, waves_cleared: 6, boss_result: "failed" }
  });
  const second = await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 1, score: 1, kills: 1, level: 1, waves_cleared: 0 }
  });

  assert.equal(first.accepted, true);
  assert.equal(second.ok, true);
  assert.equal(second.already_finished, true);
  assert.equal(second.accepted, true);
  assert.equal(second.run.score, first.run.score);
  assert.equal(db.finishCalls, 1);
});

test("pixel game finish preserves idempotency when the database reports an already-finished run", async () => {
  const { service, setNow, db } = createService({ visualState: { activity: "gaming", mood: "happy", energy: 60, social_need: 40 } });
  const started = service.startRun({ session: viewer, classId: "star_idol" });
  setNow("2026-06-12T00:03:00.000Z");
  db.forceAlreadyFinishedAtFinish();

  const result = await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 180, score: 8000, kills: 50, level: 4, waves_cleared: 4, boss_result: "failed", result: "defeated" },
    reportGenerator: async () => "second concurrent report"
  });

  assert.equal(result.ok, true);
  assert.equal(result.already_finished, true);
  assert.equal(result.accepted, true);
  assert.equal(result.report, "first concurrent report");
  assert.equal(result.unlocked_classes.length, 0);
});

test("pixel game service rejects unauthenticated and other-user run settlement", async () => {
  const { service, setNow } = createService();
  const started = service.startRun({ session: viewer, classId: "star_idol" });
  setNow("2026-06-12T00:02:00.000Z");

  const anonymous = await service.finishRun({ session: {}, runId: started.run.run_id, payload: {} });
  const otherUser = await service.finishRun({
    session: { user_id: "user-2", nickname: "Other" },
    runId: started.run.run_id,
    payload: { duration_seconds: 60, score: 100, kills: 1 }
  });

  assert.equal(anonymous.status, 401);
  assert.equal(otherUser.status, 404);
});

test("pixel game leaderboard exposes only public fields", async () => {
  const { service, setNow } = createService();
  const started = service.startRun({ session: viewer, classId: "star_idol" });
  setNow("2026-06-12T00:04:00.000Z");

  await service.finishRun({
    session: viewer,
    runId: started.run.run_id,
    payload: { duration_seconds: 240, score: 9000, kills: 50, level: 4, waves_cleared: 5 }
  });

  const result = service.leaderboard({ limit: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.leaderboard.length, 1);
  assert.deepEqual(Object.keys(result.leaderboard[0]).sort(), [
    "boss_result",
    "class_id",
    "difficulty_tier",
    "duration_seconds",
    "finished_at",
    "kills",
    "level",
    "nickname",
    "result",
    "run_id",
    "score",
    "score_tier",
    "stage_id",
    "waves_cleared"
  ].sort());
  assert.equal(result.leaderboard[0].nickname, "Viewer One");
  assert.equal("user_id" in result.leaderboard[0], false);
  assert.equal("report_text" in result.leaderboard[0], false);
});
