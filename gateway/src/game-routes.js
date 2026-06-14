import {
  formatPixelGameReportFallback
} from "./game-service.js";
import {
  createPixelGameClassUnlockedEvent,
  createPixelGameRunFinishedEvent,
  createPixelGameRunStartedEvent
} from "./module-context.js";

export function registerPixelGameRoutes(app, {
  config,
  gameService,
  moduleEventStore,
  requireSession,
  generateGameReport = null,
  normalizeStoredAiProfile = () => null,
  appendCharacterEvent = null
} = {}) {
  if (!app || !gameService || !requireSession) throw new Error("pixel_game_routes_missing_deps");

  app.get("/api/hoshia/pixel-game/state", requireSession, (req, res) => {
    res.json(gameService.publicState(req.session));
  });

  app.get("/api/hoshia/pixel-game/profile", requireSession, (req, res) => {
    const state = gameService.publicState(req.session);
    res.json({ ok: true, profile: state.profile, unlocked_classes: state.unlocked_classes, active_run: state.active_run });
  });

  app.get("/api/hoshia/pixel-game/leaderboard", requireSession, (req, res) => {
    res.json(gameService.leaderboard({ classId: req.query?.class_id || req.query?.classId || "", limit: req.query?.limit || 10 }));
  });

  app.post("/api/hoshia/pixel-game/runs", requireSession, (req, res) => {
    const result = gameService.startRun({ session: req.session, classId: req.body?.class_id || req.body?.classId || "", clientVersion: req.body?.client_version || req.body?.clientVersion || "" });
    if (!result.ok) return res.status(400).json(result);
    if (!result.resumed && result.run) {
      moduleEventStore?.append(createPixelGameRunStartedEvent(result.run, req.session, { roomId: config.roomId }));
      appendPixelGameCharacterEvent(appendCharacterEvent, {
        eventType: "hoshia_pixel_game.run_started",
        run: result.run,
        session: req.session,
        roomId: config.roomId,
        status: "started"
      });
      gameService.insertRunEvent?.({
        runId: result.run.run_id,
        roomId: config.roomId,
        userId: req.session.user_id,
        eventType: "hoshia_pixel_game.run_started",
        summary: `${req.session.nickname} started a pixel game run`,
        data: {
          class_id: result.run.class_id,
          stage_id: result.run.stage_id,
          state_activity: result.run.locked_activity,
          state_mood: result.run.locked_mood,
          difficulty_tier: result.run.difficulty_tier
        }
      });
    }
    return res.json(result);
  });

  app.get("/api/hoshia/pixel-game/runs/:id", requireSession, (req, res) => {
    const state = gameService.publicState(req.session);
    const run = state.active_run?.run_id === req.params.id ? state.active_run : null;
    if (!run) return res.status(404).json({ ok: false, error: "run_not_found" });
    return res.json({ ok: true, run });
  });

  app.post("/api/hoshia/pixel-game/runs/:id/finish", requireSession, async (req, res) => {
    const result = await gameService.finishRun({
      session: req.session,
      runId: req.params.id,
      payload: req.body || {},
      reportGenerator: async ({ run, finish, scoreTier, result: finishResult }) => {
        if (typeof generateGameReport === "function") {
          const aiReport = await generateGameReport({ run, finish, scoreTier, result: finishResult, session: req.session });
          if (aiReport) return aiReport;
        }
        return formatPixelGameReportFallback({ run, finish, scoreTier, result: finishResult });
      }
    });
    if (!result.ok) return res.status(result.status || 400).json(result);

    if (result.run && !result.already_finished) {
      const memoryEnabled = normalizeStoredAiProfile(req.session.ai_profile)?.memory_enabled === true;
      moduleEventStore?.append(createPixelGameRunFinishedEvent(result.run, req.session, {
        roomId: config.roomId,
        memoryEligible: memoryEnabled && result.accepted && ["A", "S"].includes(result.run.score_tier)
      }));
      appendPixelGameCharacterEvent(appendCharacterEvent, {
        eventType: "hoshia_pixel_game.run_finished",
        run: result.run,
        session: req.session,
        roomId: config.roomId,
        status: "finished"
      });
      for (const classId of result.unlocked_classes || []) {
        moduleEventStore?.append(createPixelGameClassUnlockedEvent({ classId, run: result.run }, req.session, { roomId: config.roomId, memoryEligible: memoryEnabled }));
        appendPixelGameCharacterEvent(appendCharacterEvent, {
          eventType: "hoshia_pixel_game.class_unlocked",
          run: { ...result.run, class_id: classId },
          session: req.session,
          roomId: config.roomId,
          status: "unlocked"
        });
      }
      gameService.insertRunEvent?.({
        runId: result.run.run_id,
        roomId: config.roomId,
        userId: req.session.user_id,
        eventType: "hoshia_pixel_game.run_finished",
        summary: `${req.session.nickname} finished a pixel game run with ${result.run.score_tier || "C"} tier`,
        data: {
          class_id: result.run.class_id,
          stage_id: result.run.stage_id,
          state_activity: result.run.locked_activity,
          state_mood: result.run.locked_mood,
          difficulty_tier: result.run.difficulty_tier,
          result: result.run.result,
          waves_cleared: String(result.run.waves_cleared),
          boss_result: result.run.boss_result,
          duration_seconds: String(result.run.duration_seconds),
          score_tier: result.run.score_tier
        }
      });
    }
    return res.json(result);
  });

  app.post("/api/hoshia/pixel-game/runs/:id/abandon", requireSession, (req, res) => {
    const result = gameService.abandonRun({ session: req.session, runId: req.params.id });
    if (!result.ok) return res.status(result.status || 400).json(result);
    return res.json(result);
  });
}

function appendPixelGameCharacterEvent(appendCharacterEvent, { eventType, run, session, status } = {}) {
  if (typeof appendCharacterEvent !== "function" || !eventType || !run) return null;
  return appendCharacterEvent({
    event_type: eventType,
    actor_type: "user",
    user_id: session?.user_id || run.user_id || "",
    nickname: session?.nickname || run.nickname || "",
    source_kind: "hoshia_pixel_game",
    source_id: run.run_id || run.id || `${eventType}:${session?.user_id || "viewer"}`,
    occurred_at: run.finished_at || run.started_at || new Date().toISOString(),
    public_hint: `Viewer pixel game ${status || "activity"}`,
    private_hint: `Viewer pixel game ${status || "activity"}`,
    reason: status || eventType,
    data: {
      status,
      class_id: run.class_id || "",
      stage_id: run.stage_id || "",
      state_activity: run.locked_activity || "",
      state_mood: run.locked_mood || "",
      difficulty_tier: run.difficulty_tier || "",
      result: run.result || "",
      score_tier: run.score_tier || ""
    }
  });
}
