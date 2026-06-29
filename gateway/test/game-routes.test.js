import assert from "node:assert/strict";
import test from "node:test";
import { registerPixelGameRoutes } from "../src/game-routes.js";

function createMockApp() {
  const routes = [];
  return {
    routes,
    get(path, ...handlers) {
      routes.push({ method: "GET", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "POST", path, handlers });
    }
  };
}

function createRes() {
  return {
    body: null,
    statusCode: 200,
    json(value) {
      this.body = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    }
  };
}

async function runRoute(route, req = {}) {
  const res = createRes();
  let index = 0;
  async function next() {
    index += 1;
    const handler = route.handlers[index];
    if (handler) await handler(req, res, next);
  }
  await route.handlers[0](req, res, next);
  return res;
}

function createDeps(overrides = {}) {
  const events = [];
  const gameService = {
    publicState: () => ({
      ok: true,
      enabled: true,
      profile: { total_runs: 1, best_score: 9000 },
      unlocked_classes: ["star_idol"],
      active_run: null,
      leaderboard: []
    }),
    leaderboard: () => ({
      ok: true,
      leaderboard: [{
        run_id: "pgr-board",
        nickname: "Viewer",
        class_id: "star_idol",
        stage_id: "neon_radio_rooftop",
        difficulty_tier: "B",
        score: 9000,
        kills: 50,
        level: 4,
        waves_cleared: 5,
        boss_result: "failed",
        result: "defeated",
        score_tier: "B",
        duration_seconds: 240,
        finished_at: "2026-06-12T00:04:00.000Z"
      }]
    }),
    startRun: ({ session, classId }) => ({
      ok: true,
      resumed: false,
      run: publicRun({ id: "pgr-start", class_id: classId || "star_idol", nickname: session.nickname })
    }),
    finishRun: async ({ session, runId, payload, reportGenerator }) => {
      if (runId === "other-run") return { ok: false, status: 404, error: "run_not_found" };
      if (runId === "done-run") {
        return {
          ok: true,
          already_finished: true,
          accepted: true,
          run: publicRun({ id: "done-run", status: "finished", score_tier: "A" }),
          report: "already done"
        };
      }
      const run = publicRun({
        id: runId,
        status: "finished",
        score_tier: "A",
        duration_seconds: payload.duration_seconds,
        waves_cleared: payload.waves_cleared,
        boss_result: payload.boss_result,
        result: payload.result
      });
      const report = await reportGenerator({ run, finish: payload, scoreTier: "A", result: payload.result });
      return { ok: true, accepted: true, run, report, unlocked_classes: ["radio_miko"], leaderboard: [] };
    },
    abandonRun: () => ({ ok: true, run: publicRun({ id: "pgr-abandon", status: "abandoned" }) }),
    insertRunEvent: (event) => events.push(event)
  };
  return {
    config: { roomId: "room-test" },
    events,
    gameService,
    moduleEventStore: {
      append(event) {
        if (event) events.push(event);
        return event;
      }
    },
    requireSession(req, res, next) {
      if (!req.session?.user_id) return res.status(401).json({ ok: false, error: "unauthorized" });
      return next();
    },
    generateGameReport: async () => "safe Hoshia report",
    normalizeStoredAiProfile: () => ({ memory_enabled: true }),
    ...overrides
  };
}

function publicRun(overrides = {}) {
  return {
    id: overrides.id || "pgr-test",
    run_id: overrides.id || "pgr-test",
    status: overrides.status || "active",
    accepted: overrides.accepted ?? true,
    class_id: overrides.class_id || "star_idol",
    seed: "12345",
    stage_id: overrides.stage_id || "neon_radio_rooftop",
    difficulty_tier: overrides.difficulty_tier || "B",
    locked_activity: overrides.locked_activity || "idle",
    locked_mood: overrides.locked_mood || "calm",
    locked_energy: 50,
    locked_social_need: 50,
    started_at: "2026-06-12T00:00:00.000Z",
    expires_at: "2026-06-12T00:16:30.000Z",
    finished_at: overrides.finished_at || "2026-06-12T00:04:00.000Z",
    duration_seconds: overrides.duration_seconds ?? 240,
    score: overrides.score ?? 9000,
    kills: overrides.kills ?? 50,
    level: overrides.level ?? 4,
    waves_cleared: overrides.waves_cleared ?? 5,
    boss_result: overrides.boss_result || "failed",
    result: overrides.result || "defeated",
    score_tier: overrides.score_tier || "B"
  };
}

const viewerSession = {
  user_id: "viewer-1",
  nickname: "Viewer",
  ai_profile: { memory_enabled: true }
};

test("pixel game routes register planned endpoints", () => {
  const app = createMockApp();
  registerPixelGameRoutes(app, createDeps());

  const routeKeys = app.routes.map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(routeKeys, [
    "GET /api/hoshia/pixel-game/leaderboard",
    "GET /api/hoshia/pixel-game/profile",
    "GET /api/hoshia/pixel-game/runs/:id",
    "GET /api/hoshia/pixel-game/state",
    "POST /api/hoshia/pixel-game/runs",
    "POST /api/hoshia/pixel-game/runs/:id/abandon",
    "POST /api/hoshia/pixel-game/runs/:id/finish"
  ].sort());
});

test("pixel game routes require a logged-in session", async () => {
  const app = createMockApp();
  registerPixelGameRoutes(app, createDeps());
  const route = app.routes.find((item) => item.method === "GET" && item.path === "/api/hoshia/pixel-game/state");

  const res = await runRoute(route, { session: null });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: "unauthorized" });
});

test("pixel game finish route rejects other-user runs without module events", async () => {
  const app = createMockApp();
  const deps = createDeps();
  registerPixelGameRoutes(app, deps);
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/hoshia/pixel-game/runs/:id/finish");

  const res = await runRoute(route, {
    session: viewerSession,
    params: { id: "other-run" },
    body: { duration_seconds: 60, score: 100, kills: 1 }
  });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, status: 404, error: "run_not_found" });
  assert.equal(deps.events.length, 0);
});

test("pixel game finish route is idempotent and does not re-emit events", async () => {
  const app = createMockApp();
  const deps = createDeps();
  registerPixelGameRoutes(app, deps);
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/hoshia/pixel-game/runs/:id/finish");

  const res = await runRoute(route, {
    session: viewerSession,
    params: { id: "done-run" },
    body: { duration_seconds: 1, score: 1, kills: 1 }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.already_finished, true);
  assert.equal(deps.events.length, 0);
});

test("pixel game finish route emits only sanitized game module fields", async () => {
  const app = createMockApp();
  const deps = createDeps();
  registerPixelGameRoutes(app, deps);
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/hoshia/pixel-game/runs/:id/finish");

  const res = await runRoute(route, {
    session: viewerSession,
    params: { id: "pgr-finish" },
    body: {
      duration_seconds: 240,
      score: 12000,
      kills: 80,
      waves_cleared: 8,
      boss_result: "failed",
      result: "defeated",
      user_id: "attacker",
      locked_hoshia_state: { token: "secret" }
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.report, "safe Hoshia report");
  const moduleEvents = deps.events.filter((event) => event.module_id === "hoshia_pixel_game");
  assert.equal(moduleEvents.length, 2);
  assert.deepEqual(Object.keys(moduleEvents[0].data).sort(), [
    "boss_result",
    "class_id",
    "difficulty_tier",
    "duration_seconds",
    "result",
    "score_tier",
    "stage_id",
    "state_activity",
    "state_mood",
    "waves_cleared"
  ].sort());
  assert.equal(JSON.stringify(moduleEvents), JSON.stringify(moduleEvents).replace(/attacker|secret|locked_hoshia_state/i, ""));
});
