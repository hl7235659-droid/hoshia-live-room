import { useEffect, useMemo, useState } from "react";
import { Gamepad2, Pause, Play, RotateCcw, Trophy, X } from "lucide-react";
import type {
  HoshiaVisualState,
  PixelGameDataBundle,
  PixelGameFinishPayload,
  PixelGameFinishResponse,
  PixelGameJob,
  PixelGameLeaderboardEntry,
  PixelGamePublicRun,
  PixelGameSnapshot,
  PixelGameStatePayload,
  PixelGameUpgradeOption,
  Session
} from "../types";
import { loadPixelGameData } from "./pixelGameData";
import { PixiGameHost, type PixelGameClassPick, type PixelGameUpgradePick } from "./PixiGameHost";

type Phase = "boot" | "menu" | "playing" | "upgrade" | "class_select" | "settling" | "result";

type Props = {
  session: Session;
  isDemo: boolean;
  hoshiaState: HoshiaVisualState | null;
  onClose: () => void;
};

const baseUrl = import.meta.env.BASE_URL || "/";
const defaultSnapshot: PixelGameSnapshot = {
  status: "idle",
  hp: 1,
  maxHp: 1,
  level: 1,
  xp: 0,
  xpToNext: 1,
  score: 0,
  kills: 0,
  elapsedSeconds: 0,
  remainingSeconds: 900,
  wavesCleared: 0,
  enemies: 0,
  projectiles: 0,
  chosenClassId: "",
  upgradeIds: [],
  shield: 0,
  bossResult: "not_reached"
};

function apiPath(path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

export function HoshiaGameOverlay({ session, isDemo, hoshiaState, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("boot");
  const [data, setData] = useState<PixelGameDataBundle | null>(null);
  const [serverState, setServerState] = useState<PixelGameStatePayload | null>(null);
  const [selectedClassId, setSelectedClassId] = useState("star_idol");
  const [run, setRun] = useState<PixelGamePublicRun | null>(null);
  const [snapshot, setSnapshot] = useState<PixelGameSnapshot>(defaultSnapshot);
  const [upgradeOptions, setUpgradeOptions] = useState<PixelGameUpgradeOption[]>([]);
  const [classOptions, setClassOptions] = useState<PixelGameJob[]>([]);
  const [appliedUpgrade, setAppliedUpgrade] = useState<PixelGameUpgradePick | null>(null);
  const [appliedClass, setAppliedClass] = useState<PixelGameClassPick | null>(null);
  const [pickSequence, setPickSequence] = useState(1);
  const [paused, setPaused] = useState(false);
  const [finishPayload, setFinishPayload] = useState<PixelGameFinishPayload | null>(null);
  const [finishResult, setFinishResult] = useState<PixelGameFinishResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    async function boot() {
      setError("");
      const bundle = await loadPixelGameData();
      const state = isDemo ? demoGameState(session, hoshiaState, bundle) : await fetchGameState();
      if (disposed) return;
      setData(bundle);
      setServerState(state);
      const firstUnlocked = state.unlocked_classes?.[0] || bundle.jobs[0]?.id || "star_idol";
      setSelectedClassId(firstUnlocked);
      setRun(state.active_run);
      setPhase("menu");
    }
    void boot().catch((err) => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : "Game data failed to load");
        setPhase("menu");
      }
    });
    return () => {
      disposed = true;
    };
  }, [isDemo, session, hoshiaState]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== "escape" && key !== "p" && key !== " ") return;
      if (phase === "playing") {
        event.preventDefault();
        setPaused((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase]);

  const jobs = data?.jobs || [];
  const unlocked = useMemo(() => new Set(serverState?.unlocked_classes || []), [serverState?.unlocked_classes]);
  const selectedJob = jobs.find((job) => job.id === selectedClassId) || jobs[0];
  const leaderboard = finishResult?.leaderboard || serverState?.leaderboard || [];
  const canPlay = Boolean(data && selectedJob && (isDemo || unlocked.has(selectedJob.id)));
  const playing = Boolean(run && ["playing", "upgrade", "class_select", "settling"].includes(phase));
  const hostPaused = paused || phase !== "playing";

  async function fetchGameState(): Promise<PixelGameStatePayload> {
    const response = await fetch(apiPath("api/hoshia/pixel-game/state"));
    if (!response.ok) throw new Error(response.status === 401 ? "Please sign in before playing" : "Game state failed to load");
    return await response.json() as PixelGameStatePayload;
  }

  async function startRun(classId = selectedClassId) {
    if (!data) return;
    setError("");
    setFinishResult(null);
    setFinishPayload(null);
    setSnapshot(defaultSnapshot);
    setPaused(false);
    setAppliedUpgrade(null);
    setAppliedClass(null);
    setPickSequence(1);
    try {
      const response = isDemo
        ? demoStartRun(session, classId, hoshiaState)
        : await fetch(apiPath("api/hoshia/pixel-game/runs"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ class_id: classId, client_version: "pixel-game-v1" })
        }).then((res) => res.ok ? res.json() : Promise.reject(new Error("Run start failed")));
      if (!response?.ok || !response.run) throw new Error(response?.error || "Run start failed");
      setRun(response.run);
      setSelectedClassId(response.run.class_id);
      setPhase("playing");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run start failed");
    }
  }

  async function abandonAndClose() {
    if (!isDemo && run?.status === "active" && phase !== "result" && phase !== "settling") {
      try {
        await fetch(apiPath(`api/hoshia/pixel-game/runs/${run.run_id}/abandon`), { method: "POST" });
      } catch {
        // Closing the overlay should not be blocked by an abandon request failure.
      }
    }
    onClose();
  }

  async function finishRun(payload: PixelGameFinishPayload) {
    if (!run) return;
    setFinishPayload(payload);
    setPhase("settling");
    setPaused(true);
    try {
      const result = isDemo
        ? demoFinishRun(run, payload, session)
        : await fetch(apiPath(`api/hoshia/pixel-game/runs/${run.run_id}/finish`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then((res) => res.ok ? res.json() : Promise.reject(new Error("Settlement failed")));
      setFinishResult(result);
      if (result?.run) setRun(result.run);
      if (result?.leaderboard && serverState) {
        setServerState({ ...serverState, leaderboard: result.leaderboard });
      }
      setPhase("result");
    } catch (err) {
      setFinishResult({ ok: false, accepted: false, suspicious: true, error: err instanceof Error ? err.message : "Settlement failed" });
      setPhase("result");
    }
  }

  function chooseUpgrade(upgrade: PixelGameUpgradeOption) {
    const sequence = pickSequence + 1;
    setPickSequence(sequence);
    setAppliedUpgrade({ sequence, upgrade });
    setUpgradeOptions([]);
    setPaused(false);
    setPhase("playing");
  }

  function chooseClass(job: PixelGameJob) {
    const sequence = pickSequence + 1;
    setPickSequence(sequence);
    setAppliedClass({ sequence, job });
    setClassOptions([]);
    setPaused(false);
    setPhase("playing");
  }

  function renderBody() {
    if (phase === "boot" || !data) {
      return <div className="pixel-game-loading">Tuning the pixel radio channel...</div>;
    }

    if (!playing) {
      return (
        <div className="pixel-game-menu">
          <section className="pixel-game-hero-card">
            <span>HOSHIA PIXEL SURVIVOR</span>
            <h2>Radio Pixel Mowdown</h2>
            <p>Starting a run locks Hoshia mood, activity, energy, and social need into the stage director.</p>
            <div className="pixel-game-state-line">
              <b>Locked signal</b>
              <em>{hoshiaState?.activity || "idle"} / {hoshiaState?.mood || "calm"}</em>
              <em>Energy {hoshiaState?.energy ?? "?"}</em>
            </div>
          </section>

          <section className="pixel-game-class-grid" aria-label="Class selection">
            {jobs.map((job) => {
              const locked = !isDemo && !unlocked.has(job.id);
              return (
                <button
                  key={job.id}
                  type="button"
                  className={`pixel-game-class-card ${selectedClassId === job.id ? "selected" : ""}`}
                  disabled={locked}
                  onClick={() => setSelectedClassId(job.id)}
                >
                  <span>{locked ? "Locked" : job.role || "Mood class"}</span>
                  <strong>{job.name}</strong>
                  <small>{job.tagline || job.passive || "Pixel avatar ready."}</small>
                </button>
              );
            })}
          </section>

          <div className="pixel-game-menu-footer">
            {serverState?.active_run ? (
              <button type="button" className="pixel-game-secondary" onClick={() => {
                setRun(serverState.active_run);
                setSelectedClassId(serverState.active_run?.class_id || selectedClassId);
                setPhase("playing");
              }}>
                Continue active run
              </button>
            ) : null}
            <button type="button" className="pixel-game-primary" disabled={!canPlay} onClick={() => void startRun(selectedClassId)}>
              <Gamepad2 size={18} /> Start 15-minute waves
            </button>
          </div>
          {error ? <p className="pixel-game-error">{error}</p> : null}
        </div>
      );
    }

    return (
      <div className="pixel-game-playfield">
        {run ? (
          <PixiGameHost
            run={run}
            data={data}
            paused={hostPaused}
            appliedUpgrade={appliedUpgrade}
            appliedClass={appliedClass}
            onSnapshot={setSnapshot}
            onLevelUp={(options, level) => {
              setUpgradeOptions(options);
              setPhase("upgrade");
              setPaused(true);
              setSnapshot((current) => ({ ...current, level, status: "upgrade" }));
            }}
            onClassChoice={(options, level) => {
              setClassOptions(options);
              setPhase("class_select");
              setPaused(true);
              setSnapshot((current) => ({ ...current, level, status: "class_select" }));
            }}
            onFinish={(payload) => void finishRun(payload)}
          />
        ) : null}
        <PixelGameHud snapshot={snapshot} run={run} paused={paused} onPauseToggle={() => {
          if (phase === "playing") setPaused((current) => !current);
        }} />
        {paused && phase === "playing" ? (
          <div className="pixel-game-pause-card">
            <strong>Paused</strong>
            <span>Move with WASD / arrow keys, or use the virtual stick.</span>
            <button type="button" onClick={() => setPaused(false)}><Play size={16} />Resume</button>
          </div>
        ) : null}
        {phase === "upgrade" ? <UpgradeChoiceModal options={upgradeOptions} onChoose={chooseUpgrade} /> : null}
        {phase === "class_select" ? <ClassChoiceModal options={classOptions} onChoose={chooseClass} /> : null}
        {phase === "settling" ? <div className="pixel-game-loading over">Sending battle report to Hoshia...</div> : null}
      </div>
    );
  }

  return (
    <section className="hoshia-pixel-game-shell" aria-label="Hoshia pixel survivor game">
      <div className="pixel-game-scanline" aria-hidden="true" />
      <header className="pixel-game-topbar">
        <div>
          <span>PIXEL MOWDOWN</span>
          <strong>Mood Signal Run</strong>
        </div>
        <button type="button" onClick={() => void abandonAndClose()} aria-label="Close game">
          <X size={20} />
        </button>
      </header>
      {renderBody()}
      {phase === "result" ? (
        <ResultPanel
          result={finishResult}
          payload={finishPayload}
          leaderboard={leaderboard}
          onRestart={() => void startRun(selectedClassId)}
          onClose={onClose}
        />
      ) : null}
    </section>
  );
}

function PixelGameHud({ snapshot, run, paused, onPauseToggle }: { snapshot: PixelGameSnapshot; run: PixelGamePublicRun | null; paused: boolean; onPauseToggle: () => void }) {
  const hpRatio = Math.max(0, Math.min(1, snapshot.hp / Math.max(1, snapshot.maxHp)));
  const xpRatio = Math.max(0, Math.min(1, snapshot.xp / Math.max(1, snapshot.xpToNext)));
  return (
    <aside className="pixel-game-hud" aria-label="Game status">
      <div className="pixel-game-hud-row primary">
        <strong>Lv.{snapshot.level}</strong>
        <span>{formatClock(snapshot.remainingSeconds)}</span>
        <button type="button" onClick={onPauseToggle} aria-label={paused ? "Resume" : "Pause"}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      </div>
      <div className="pixel-game-meter hp"><i style={{ width: `${hpRatio * 100}%` }} /></div>
      <div className="pixel-game-meter xp"><i style={{ width: `${xpRatio * 100}%` }} /></div>
      <div className="pixel-game-hud-grid">
        <span>Score <b>{snapshot.score}</b></span>
        <span>Kills <b>{snapshot.kills}</b></span>
        <span>Wave <b>{snapshot.wavesCleared}/15</b></span>
        <span>Enemies <b>{snapshot.enemies}</b></span>
      </div>
      <div className="pixel-game-lock-line">
        <span>{run?.stage_id || "stage"}</span>
        <em>{run?.locked_activity || "idle"}/{run?.locked_mood || "calm"}</em>
      </div>
      {snapshot.shield ? <div className="pixel-game-shield">Shield x{snapshot.shield}</div> : null}
    </aside>
  );
}

function UpgradeChoiceModal({ options, onChoose }: { options: PixelGameUpgradeOption[]; onChoose: (option: PixelGameUpgradeOption) => void }) {
  return (
    <div className="pixel-game-choice-backdrop">
      <section className="pixel-game-choice-card">
        <span>LEVEL UP</span>
        <h3>Choose one upgrade</h3>
        <div className="pixel-game-choice-grid">
          {options.map((option) => (
            <button key={option.id} type="button" className={`upgrade-rarity-${option.rarity || "common"}`} onClick={() => onChoose(option)}>
              <em>{rarityLabel(option.rarity)}</em>
              <strong>{option.name || option.title}</strong>
              <small>{option.effect || option.description || option.flavor || "Upgrade this run."}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ClassChoiceModal({ options, onChoose }: { options: PixelGameJob[]; onChoose: (option: PixelGameJob) => void }) {
  return (
    <div className="pixel-game-choice-backdrop">
      <section className="pixel-game-choice-card class-choice">
        <span>SPECIALIZE</span>
        <h3>Level 5 specialization</h3>
        <p>Pick an extra class route for the rest of this run.</p>
        <div className="pixel-game-choice-grid">
          {options.map((job) => (
            <button key={job.id} type="button" onClick={() => onChoose(job)}>
              <em>{job.role || "Specialty"}</em>
              <strong>{job.name}</strong>
              <small>{job.passive || job.tagline || "Gain this route bonus for the run."}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ResultPanel({ result, payload, leaderboard, onRestart, onClose }: {
  result: PixelGameFinishResponse | null;
  payload: PixelGameFinishPayload | null;
  leaderboard: PixelGameLeaderboardEntry[];
  onRestart: () => void;
  onClose: () => void;
}) {
  const accepted = result?.accepted !== false && !result?.suspicious;
  return (
    <div className="pixel-game-result-backdrop">
      <section className="pixel-game-result-card">
        <span>{accepted ? "BATTLE REPORT" : "CHECKED"}</span>
        <h3>{accepted ? "Battle settled" : "Report needs review"}</h3>
        <div className="pixel-game-result-stats">
          <b>{result?.run?.score ?? payload?.score ?? 0}</b>
          <em>Tier {result?.run?.score_tier || "C"}</em>
          <em>{payload?.boss_result === "defeated" ? "BOSS defeated" : "BOSS survived"}</em>
        </div>
        <p>{result?.report || result?.error || "Hoshia is still sorting this signal."}</p>
        {result?.unlocked_classes?.length ? (
          <div className="pixel-game-unlocks">Unlocked: {result.unlocked_classes.join(" / ")}</div>
        ) : null}
        <div className="pixel-game-leaderboard-mini">
          <strong><Trophy size={15} /> Room leaderboard</strong>
          {leaderboard.slice(0, 5).map((row, index) => (
            <span key={row.run_id}><i>#{index + 1}</i>{row.nickname}<b>{row.score}</b></span>
          ))}
          {!leaderboard.length ? <small>No settled runs yet.</small> : null}
        </div>
        <div className="pixel-game-result-actions">
          <button type="button" onClick={onRestart}><RotateCcw size={16} />Run again</button>
          <button type="button" onClick={onClose}>Back to room</button>
        </div>
      </section>
    </div>
  );
}

function demoGameState(session: Session, hoshiaState: HoshiaVisualState | null, data: PixelGameDataBundle): PixelGameStatePayload {
  return {
    ok: true,
    enabled: true,
    profile: { total_runs: 3, total_play_seconds: 1200, total_kills: 360, best_score: 18800, best_level: 7, best_wave: 10, boss_defeated_count: 0, selected_class_id: "star_idol" },
    unlocked_classes: data.jobs.map((job) => job.id),
    active_run: null,
    leaderboard: [
      { run_id: "demo-board-1", nickname: session.nickname, class_id: "star_idol", stage_id: stageForDemo(hoshiaState), difficulty_tier: "B", score: 18800, kills: 260, level: 7, waves_cleared: 10, boss_result: "failed", result: "timeout", score_tier: "B", duration_seconds: 640, finished_at: new Date().toISOString() }
    ],
    rules: { duration_seconds: 900, class_ids: data.jobs.map((job) => job.id) }
  };
}

function demoStartRun(session: Session, classId: string, hoshiaState: HoshiaVisualState | null) {
  const now = new Date();
  const run: PixelGamePublicRun = {
    id: `demo-${now.getTime()}`,
    run_id: `demo-${now.getTime()}`,
    status: "active",
    accepted: true,
    class_id: classId,
    seed: String(now.getTime()),
    stage_id: stageForDemo(hoshiaState),
    difficulty_tier: "B",
    locked_activity: hoshiaState?.activity || "idle",
    locked_mood: hoshiaState?.mood || "calm",
    locked_energy: hoshiaState?.energy ?? 50,
    locked_social_need: hoshiaState?.social_need ?? 50,
    started_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 990000).toISOString(),
    duration_seconds: 0,
    score: 0,
    kills: 0,
    level: 1,
    waves_cleared: 0,
    boss_result: "not_reached",
    result: "active",
    score_tier: ""
  };
  void session;
  return { ok: true, resumed: false, run, visual_state: { activity: run.locked_activity, mood: run.locked_mood, energy: run.locked_energy, social_need: run.locked_social_need } };
}

function demoFinishRun(run: PixelGamePublicRun, payload: PixelGameFinishPayload, session: Session): PixelGameFinishResponse {
  const scoreTier = payload.boss_result === "defeated" ? "S" : payload.score >= 26000 ? "A" : payload.score >= 12000 ? "B" : "C";
  const finished: PixelGamePublicRun = {
    ...run,
    status: "finished",
    finished_at: new Date().toISOString(),
    duration_seconds: payload.duration_seconds,
    score: payload.score,
    kills: payload.kills,
    level: payload.level,
    waves_cleared: payload.waves_cleared,
    boss_result: payload.boss_result,
    result: payload.result,
    score_tier: scoreTier
  };
  return {
    ok: true,
    accepted: true,
    run: finished,
    report: `Hoshia: ${session.nickname} cleared ${payload.kills} noise monsters on the ${run.locked_mood} channel. Tier ${scoreTier}!`,
    unlocked_classes: [],
    leaderboard: [{ run_id: finished.run_id, nickname: session.nickname, class_id: finished.class_id, stage_id: finished.stage_id, difficulty_tier: finished.difficulty_tier, score: finished.score, kills: finished.kills, level: finished.level, waves_cleared: finished.waves_cleared, boss_result: finished.boss_result, result: finished.result, score_tier: finished.score_tier, duration_seconds: finished.duration_seconds, finished_at: finished.finished_at || "" }]
  };
}

function stageForDemo(state: HoshiaVisualState | null) {
  if (state?.activity === "gaming" || state?.activity === "sports") return "ranked_arcade_matrix";
  if (state?.activity === "sleepy") return "midnight_cache_rain";
  if (state?.activity === "thinking") return "data_library_loop";
  if (state?.mood === "emo") return "static_back_alley";
  return "neon_radio_rooftop";
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function rarityLabel(rarity: string | undefined) {
  if (rarity === "signal") return "Signal";
  if (rarity === "epic") return "Epic";
  if (rarity === "rare") return "Rare";
  return "Common";
}

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}
