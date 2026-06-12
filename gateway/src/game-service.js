import { nanoid } from "nanoid";

export const pixelGameClassIds = [
  "star_idol",
  "neon_samurai",
  "stream_hacker",
  "radio_miko",
  "pixel_nekomata",
  "quantum_tuner",
  "barrage_knight",
  "scrap_engineer",
  "moon_courier",
  "dream_director"
];

const defaultClassIds = new Set(["star_idol", "neon_samurai", "stream_hacker"]);
const maxRunSeconds = 15 * 60;
const finishGraceSeconds = 90;

const activityStageMap = {
  idle: "neon_radio_rooftop",
  gaming: "ranked_arcade_matrix",
  sports: "ranked_arcade_matrix",
  otaku: "starlight_signal_plaza",
  sleepy: "midnight_cache_rain",
  happy: "starlight_signal_plaza",
  thinking: "data_library_loop",
  emo: "static_back_alley"
};

export function createHoshiaPixelGameService({
  db,
  roomId,
  hoshiaVisualStateProvider = () => null,
  clock = () => new Date(),
  idGenerator = () => nanoid(12)
} = {}) {
  return {
    classIds: [...pixelGameClassIds],

    publicState(session) {
      const userId = session?.user_id || "";
      if (!userId) return disabledState();
      const now = clock().toISOString();
      db.expirePixelGameRuns({ roomId, userId, now });
      const profile = ensureProfileWithDefaults(db, { userId, roomId, now });
      const activeRun = db.getActivePixelGameRun({ roomId, userId, now });
      const unlocks = unlockedClassIds(db, userId);
      const leaderboard = db.listPixelGameLeaderboard({ roomId, limit: 10 });
      return {
        ok: true,
        enabled: true,
        profile: publicProfile(profile),
        unlocked_classes: unlocks,
        active_run: activeRun ? publicRun(activeRun) : null,
        leaderboard: leaderboard.map(publicLeaderboardRun),
        rules: {
          duration_seconds: maxRunSeconds,
          class_ids: [...pixelGameClassIds]
        }
      };
    },

    startRun({ session, classId = "", clientVersion = "" } = {}) {
      const userId = session?.user_id || "";
      if (!userId) return { ok: false, error: "unauthorized" };
      const nowDate = clock();
      const now = nowDate.toISOString();
      db.expirePixelGameRuns({ roomId, userId, now });
      ensureProfileWithDefaults(db, { userId, roomId, now });
      const activeRun = db.getActivePixelGameRun({ roomId, userId, now });
      if (activeRun) return { ok: true, resumed: true, run: publicRun(activeRun) };

      const requestedClass = normalizeClassId(classId) || "star_idol";
      const unlocks = unlockedClassIds(db, userId);
      const safeClassId = unlocks.includes(requestedClass) ? requestedClass : "star_idol";
      const visualState = sanitizeVisualState(hoshiaVisualStateProvider());
      const stageId = stageForVisualState(visualState);
      const difficultyTier = difficultyTierForState(visualState);
      const runId = `pgr_${idGenerator()}`;
      const seed = seedForRun({ runId, userId, now, stageId, classId: safeClassId });
      const expiresAt = new Date(nowDate.getTime() + (maxRunSeconds + finishGraceSeconds) * 1000).toISOString();
      const run = db.createPixelGameRun({
        id: runId,
        room_id: roomId,
        user_id: userId,
        nickname: session.nickname || "",
        class_id: safeClassId,
        seed,
        stage_id: stageId,
        difficulty_tier: difficultyTier,
        locked_activity: visualState.activity,
        locked_mood: visualState.mood,
        locked_energy: visualState.energy,
        locked_social_need: visualState.social_need,
        started_at: now,
        expires_at: expiresAt,
        client_version: cleanText(clientVersion, 40),
        created_at: now,
        updated_at: now
      });
      return { ok: true, resumed: false, run: publicRun(run), visual_state: visualState };
    },

    async finishRun({ session, runId, payload = {}, reportGenerator = null } = {}) {
      const userId = session?.user_id || "";
      if (!userId) return { ok: false, status: 401, error: "unauthorized" };
      const now = clock().toISOString();
      const run = db.getPixelGameRunForUser({ runId, roomId, userId });
      if (!run) return { ok: false, status: 404, error: "run_not_found" };
      if (run.status !== "active") {
        return { ok: true, already_finished: true, accepted: Boolean(run.accepted), run: publicRun(run), report: run.report_text || fallbackReport(run) };
      }
      const normalized = normalizeFinishPayload(payload, run, now);
      const validation = validateFinish(run, normalized, now);
      const scoreTier = scoreTierFor(normalized.score, normalized.boss_result, normalized.waves_cleared);
      const result = resultForFinish(normalized);
      let reportText = "";
      if (validation.accepted && typeof reportGenerator === "function") {
        try {
          reportText = await reportGenerator({ run, finish: normalized, scoreTier, result }) || "";
        } catch {
          reportText = "";
        }
      }
      if (!reportText) reportText = fallbackReport({ ...run, ...normalized, score_tier: scoreTier, result });
      const finished = db.finishPixelGameRun({
        runId,
        roomId,
        userId,
        accepted: validation.accepted,
        finishedAt: now,
        durationSeconds: normalized.duration_seconds,
        score: normalized.score,
        kills: normalized.kills,
        level: normalized.level,
        wavesCleared: normalized.waves_cleared,
        bossResult: normalized.boss_result,
        result,
        scoreTier,
        reportText
      });
      if (finished?.already_finished) {
        return {
          ok: true,
          already_finished: true,
          accepted: Boolean(finished.accepted),
          run: publicRun(finished),
          report: finished.report_text || fallbackReport(finished),
          unlocked_classes: [],
          leaderboard: db.listPixelGameLeaderboard({ roomId, limit: 10 }).map(publicLeaderboardRun)
        };
      }
      const unlocked = validation.accepted ? unlockProgressClasses(db, { userId, roomId, run: finished, now }) : [];
      return {
        ok: true,
        accepted: validation.accepted,
        suspicious: !validation.accepted,
        reason: validation.reason,
        run: publicRun(finished),
        report: reportText,
        unlocked_classes: unlocked,
        leaderboard: db.listPixelGameLeaderboard({ roomId, limit: 10 }).map(publicLeaderboardRun)
      };
    },

    abandonRun({ session, runId } = {}) {
      const userId = session?.user_id || "";
      if (!userId) return { ok: false, status: 401, error: "unauthorized" };
      const run = db.abandonPixelGameRun({ runId, roomId, userId, now: clock().toISOString() });
      if (!run) return { ok: false, status: 404, error: "run_not_found" };
      return { ok: true, run: publicRun(run) };
    },

    leaderboard({ classId = "", limit = 10 } = {}) {
      return { ok: true, leaderboard: db.listPixelGameLeaderboard({ roomId, classId: normalizeClassId(classId), limit }).map(publicLeaderboardRun) };
    },

    recentEvents({ session, limit = 6 } = {}) {
      return db.listRecentPixelGameEvents({ roomId, userId: session?.user_id || "", limit });
    },

    insertRunEvent(event) {
      return db.insertPixelGameRunEvent({ id: `pge_${idGenerator()}`, ...event });
    }
  };
}

export function formatPixelGameReportFallback({ run, finish, scoreTier = "B", result = "finished" } = {}) {
  const source = finish || run || {};
  const minutes = Math.max(0, Math.floor(Number(source.duration_seconds || 0) / 60));
  const seconds = Math.max(0, Number(source.duration_seconds || 0) % 60);
  const boss = source.boss_result === "defeated" ? "击破了最终信号体" : "还没完全压住最终信号体";
  return `本局心境战结算：存活 ${minutes}:${String(seconds).padStart(2, "0")}，清理 ${Number(source.kills || 0)} 个噪声，评级 ${scoreTier}，${boss}。`;
}

function disabledState() {
  return { ok: true, enabled: false, profile: null, unlocked_classes: [], active_run: null, leaderboard: [] };
}

function ensureProfileWithDefaults(db, { userId, roomId, now }) {
  const profile = db.ensurePixelGameProfile({ userId, roomId, now });
  for (const classId of defaultClassIds) {
    db.unlockPixelGameClass({ userId, classId, reason: "default", now });
  }
  return profile;
}

function unlockedClassIds(db, userId) {
  const ids = db.listPixelGameClassUnlocks(userId).map((item) => item.class_id);
  return [...new Set([...defaultClassIds, ...ids])].filter((id) => pixelGameClassIds.includes(id));
}

function unlockProgressClasses(db, { userId, run, now }) {
  const unlocked = [];
  const attempts = [
    ["radio_miko", Number(run.score || 0) >= 1000, "score_1000"],
    ["pixel_nekomata", Number(run.level || 0) >= 6, "level_6"],
    ["quantum_tuner", Number(run.kills || 0) >= 120, "kills_120"],
    ["barrage_knight", Number(run.duration_seconds || 0) >= 600, "survive_600"],
    ["scrap_engineer", Number(run.waves_cleared || 0) >= 10, "wave_10"],
    ["moon_courier", ["A", "S"].includes(run.score_tier), "score_tier"],
    ["dream_director", run.boss_result === "defeated", "boss_defeated"]
  ];
  for (const [classId, condition, reason] of attempts) {
    if (!condition) continue;
    const before = db.listPixelGameClassUnlocks(userId).some((item) => item.class_id === classId);
    db.unlockPixelGameClass({ userId, classId, reason, now });
    if (!before) unlocked.push(classId);
  }
  return unlocked;
}

function sanitizeVisualState(state = {}) {
  return {
    activity: cleanIdentifier(state?.activity, 32) || "idle",
    mood: cleanIdentifier(state?.mood, 32) || "calm",
    energy: clampInt(state?.energy, 0, 100, 50),
    social_need: clampInt(state?.social_need ?? state?.socialNeed, 0, 100, 50)
  };
}

function stageForVisualState(state) {
  return activityStageMap[state.activity] || activityStageMap.idle;
}

function difficultyTierForState(state) {
  const pressure = Number(state.energy || 0) * 0.6 + Number(state.social_need || 0) * 0.3 + (["competitive", "annoyed", "emo"].includes(state.mood) ? 15 : 0);
  if (pressure >= 85) return "S";
  if (pressure >= 68) return "A";
  if (pressure >= 45) return "B";
  return "C";
}

function seedForRun({ runId, userId, now, stageId, classId }) {
  const text = `${runId}:${userId}:${now}:${stageId}:${classId}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}

function normalizeFinishPayload(payload = {}, run, now) {
  const serverElapsed = Math.max(0, Math.floor((Date.parse(now) - Date.parse(run.started_at)) / 1000));
  const duration = clampInt(payload.duration_seconds ?? payload.durationSeconds ?? payload.elapsed_seconds ?? payload.elapsedSeconds, 0, maxRunSeconds + finishGraceSeconds, Math.min(serverElapsed, maxRunSeconds));
  return {
    duration_seconds: duration,
    score: clampInt(payload.score, 0, 250000, 0),
    kills: clampInt(payload.kills, 0, 8000, 0),
    level: clampInt(payload.level, 1, 80, 1),
    waves_cleared: clampInt(payload.waves_cleared ?? payload.wavesCleared, 0, 15, 0),
    boss_result: normalizeEnum(payload.boss_result ?? payload.bossResult, ["not_reached", "failed", "defeated"], "not_reached"),
    client_result: normalizeEnum(payload.result, ["cleared", "defeated", "timeout", "abandoned", "finished"], "")
  };
}

function validateFinish(run, finish, now) {
  const serverElapsed = Math.max(0, Math.floor((Date.parse(now) - Date.parse(run.started_at)) / 1000));
  if (Date.parse(now) > Date.parse(run.expires_at) + 30_000) return { accepted: false, reason: "run_expired" };
  if (finish.duration_seconds > maxRunSeconds) return { accepted: false, reason: "duration_too_long" };
  if (finish.duration_seconds > serverElapsed + 45 && serverElapsed > 0) return { accepted: false, reason: "duration_ahead_of_server" };
  if (finish.boss_result === "defeated" && finish.waves_cleared < 15) return { accepted: false, reason: "boss_before_final_wave" };
  const serverResult = resultForFinish(finish);
  if (finish.client_result && finish.client_result !== "finished" && finish.client_result !== serverResult) return { accepted: false, reason: "result_mismatch" };
  if (finish.duration_seconds < 120 && finish.kills > 30 + finish.duration_seconds * 1.2) return { accepted: false, reason: "kills_too_fast" };
  const maxKills = 120 + finish.duration_seconds * 8;
  if (finish.kills > maxKills) return { accepted: false, reason: "kills_too_high" };
  const theoreticalScore = finish.kills * 90 + finish.waves_cleared * 900 + finish.level * 500 + (finish.boss_result === "defeated" ? 10000 : 0) + 3000;
  if (finish.score > theoreticalScore) return { accepted: false, reason: "score_too_high" };
  if (finish.duration_seconds < 30 && finish.score > 5000) return { accepted: false, reason: "score_too_fast" };
  return { accepted: true, reason: "accepted" };
}

function resultForFinish(finish) {
  if (finish.boss_result === "defeated") return "cleared";
  if (finish.duration_seconds >= maxRunSeconds) return "timeout";
  return "defeated";
}

function scoreTierFor(score, bossResult, waves) {
  if (bossResult === "defeated" && score >= 40000) return "S";
  if (score >= 26000 || waves >= 15) return "A";
  if (score >= 12000 || waves >= 8) return "B";
  return "C";
}

function fallbackReport(run) {
  return formatPixelGameReportFallback({ run, scoreTier: run?.score_tier || "B", result: run?.result || "finished" });
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    total_runs: Number(profile.total_runs || 0),
    total_play_seconds: Number(profile.total_play_seconds || 0),
    total_kills: Number(profile.total_kills || 0),
    best_score: Number(profile.best_score || 0),
    best_level: Number(profile.best_level || 1),
    best_wave: Number(profile.best_wave || 0),
    boss_defeated_count: Number(profile.boss_defeated_count || 0),
    selected_class_id: profile.selected_class_id || ""
  };
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    run_id: run.id,
    status: run.status,
    accepted: Boolean(run.accepted),
    class_id: run.class_id,
    seed: run.seed,
    stage_id: run.stage_id,
    difficulty_tier: run.difficulty_tier || "B",
    locked_activity: run.locked_activity || "idle",
    locked_mood: run.locked_mood || "calm",
    locked_energy: Number(run.locked_energy || 0),
    locked_social_need: Number(run.locked_social_need || 0),
    started_at: run.started_at,
    expires_at: run.expires_at,
    finished_at: run.finished_at || "",
    duration_seconds: Number(run.duration_seconds || 0),
    score: Number(run.score || 0),
    kills: Number(run.kills || 0),
    level: Number(run.level || 1),
    waves_cleared: Number(run.waves_cleared || 0),
    boss_result: run.boss_result || "not_reached",
    result: run.result || "active",
    score_tier: run.score_tier || ""
  };
}

function publicLeaderboardRun(run) {
  return {
    run_id: run.id,
    nickname: run.nickname || "viewer",
    class_id: run.class_id,
    stage_id: run.stage_id,
    difficulty_tier: run.difficulty_tier || "B",
    score: Number(run.score || 0),
    kills: Number(run.kills || 0),
    level: Number(run.level || 1),
    waves_cleared: Number(run.waves_cleared || 0),
    boss_result: run.boss_result || "not_reached",
    result: run.result || "finished",
    score_tier: run.score_tier || "",
    duration_seconds: Number(run.duration_seconds || 0),
    finished_at: run.finished_at || ""
  };
}

function normalizeClassId(value) {
  const id = cleanIdentifier(value, 40);
  return pixelGameClassIds.includes(id) ? id : "";
}

function normalizeEnum(value, allowed, fallback) {
  const text = cleanIdentifier(value, 40);
  return allowed.includes(text) ? text : fallback;
}

function cleanIdentifier(value, maxLength = 80) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, maxLength);
}

function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
