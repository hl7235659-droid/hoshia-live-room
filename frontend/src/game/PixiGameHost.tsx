import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PixelGameBossResult,
  PixelGameDataBundle,
  PixelGameEnemyTuning,
  PixelGameFinishPayload,
  PixelGameJob,
  PixelGamePublicRun,
  PixelGameSnapshot,
  PixelGameUpgradeOption,
  PixelGameWeaponTuning,
  PixelGameWaveRule
} from "../types";
import { buildDirectorProfile, type PixelGameDirectorProfile } from "./pixelGameDirector";
import { createPixelGameVisualRenderer } from "./pixelGameVisualRenderer";
import type { PixelGameVisualEffect, PixelGameVisualRenderer } from "./pixelGameVisualRenderer";

export type PixelGameUpgradePick = {
  sequence: number;
  upgrade: PixelGameUpgradeOption;
};

export type PixelGameClassPick = {
  sequence: number;
  job: PixelGameJob;
};

type PixiModule = typeof import("pixi.js");
type PixiApplication = import("pixi.js").Application;
type PixiGraphics = import("pixi.js").Graphics;

type Props = {
  run: PixelGamePublicRun;
  data: PixelGameDataBundle;
  paused: boolean;
  appliedUpgrade: PixelGameUpgradePick | null;
  appliedClass: PixelGameClassPick | null;
  onSnapshot: (snapshot: PixelGameSnapshot) => void;
  onLevelUp: (options: PixelGameUpgradeOption[], level: number) => void;
  onClassChoice: (options: PixelGameJob[], level: number) => void;
  onFinish: (payload: PixelGameFinishPayload) => void;
};

type Enemy = {
  id: string;
  typeId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xp: number;
  score: number;
  size: number;
  color: string;
  boss?: boolean;
  phase: number;
};

type Projectile = {
  id: string;
  weaponId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  life: number;
  size: number;
  color: string;
  range: number;
  traveled: number;
  pierce: number;
  homing: boolean;
  chain: number;
  hitIds: Set<string>;
};

type Zone = {
  id: string;
  weaponId: string;
  x: number;
  y: number;
  radius: number;
  damage: number;
  tickEvery: number;
  tickTimer: number;
  life: number;
  color: string;
  pulse: boolean;
};

type Turret = {
  id: string;
  weaponId: string;
  x: number;
  y: number;
  range: number;
  damage: number;
  cooldownMs: number;
  timerMs: number;
  life: number;
  color: string;
};

type Gem = {
  id: string;
  x: number;
  y: number;
  xp: number;
  color: string;
};

type EngineState = {
  worldWidth: number;
  worldHeight: number;
  elapsed: number;
  finished: boolean;
  awaitingUpgrade: boolean;
  awaitingClass: boolean;
  bossSpawned: boolean;
  bossResult: PixelGameBossResult;
  classId: string;
  specializationId: string;
  classJob: PixelGameJob | undefined;
  specializationJob: PixelGameJob | undefined;
  director: PixelGameDirectorProfile;
  primaryWeapon: PixelGameWeaponTuning;
  activeWeaponIds: string[];
  upgradeIds: string[];
  upgradeRanks: Map<string, number>;
  hp: number;
  maxHp: number;
  shield: number;
  level: number;
  xp: number;
  xpToNext: number;
  xpMultiplier: number;
  score: number;
  kills: number;
  damageMultiplier: number;
  speed: number;
  cooldownMs: number;
  projectileSpeed: number;
  projectileCount: number;
  pickupRange: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  attackTimer: number;
  spawnTimer: number;
  specialEventTimer: number;
  supplyTimer: number;
  dashTrailTimer: number;
  shieldTimer: number;
  hurtCooldown: number;
  rng: () => number;
  biomePalette: string[];
  biomeFamilies: string[];
  bossId: string;
  bossSpawnSecond: number;
  enemies: Enemy[];
  projectiles: Projectile[];
  zones: Zone[];
  turrets: Turret[];
  gems: Gem[];
  effects: PixelGameVisualEffect[];
};

type Controls = {
  keyboard: Record<string, boolean>;
  stickX: number;
  stickY: number;
};

const maxRunSeconds = 15 * 60;
const snapshotEveryMs = 120;

export function PixiGameHost(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<PixiApplication | null>(null);
  const graphicsRef = useRef<{ bg: PixiGraphics; actors: PixiGraphics; fx: PixiGraphics } | null>(null);
  const visualRendererRef = useRef<PixelGameVisualRenderer | null>(null);
  const engineRef = useRef<EngineState | null>(null);
  const propsRef = useRef(props);
  const controlsRef = useRef<Controls>({ keyboard: {}, stickX: 0, stickY: 0 });
  const lastUpgradeSeqRef = useRef(0);
  const lastClassSeqRef = useRef(0);
  const lastSnapshotRef = useRef(0);
  const [stickActive, setStickActive] = useState(false);
  const [stickKnob, setStickKnob] = useState({ x: 0, y: 0 });

  propsRef.current = props;

  const classJob = useMemo(() => {
    return props.data.jobs.find((job) => job.id === props.run.class_id) || props.data.jobs[0];
  }, [props.data.jobs, props.run.class_id]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let PIXI: PixiModule | null = null;

    async function boot() {
      PIXI = await import("pixi.js");
      if (disposed || !hostRef.current || !PIXI) return;
      const app = new PIXI.Application({
        width: Math.max(320, hostRef.current.clientWidth || 800),
        height: Math.max(240, hostRef.current.clientHeight || 540),
        antialias: false,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        backgroundAlpha: 0
      });
      appRef.current = app;
      hostRef.current.appendChild(app.view as HTMLCanvasElement);
      const bg = new PIXI.Graphics();
      const actors = new PIXI.Graphics();
      const fx = new PIXI.Graphics();
      const visualRenderer = createPixelGameVisualRenderer(PIXI, propsRef.current.data.visuals);
      visualRendererRef.current = visualRenderer;
      graphicsRef.current = { bg, actors, fx };
      app.stage.addChild(bg, visualRenderer.worldLayer, actors, fx, visualRenderer.fxLayer);

      engineRef.current = createEngine(propsRef.current.run, propsRef.current.data, classJob);
      propsRef.current.onSnapshot(snapshotFromEngine(engineRef.current));

      resizeObserver = new ResizeObserver(() => {
        if (!hostRef.current || !appRef.current) return;
        appRef.current.renderer.resize(
          Math.max(320, hostRef.current.clientWidth || 800),
          Math.max(240, hostRef.current.clientHeight || 540)
        );
      });
      resizeObserver.observe(hostRef.current);

      app.ticker.add(() => {
        const engine = engineRef.current;
        if (!engine || !appRef.current || !graphicsRef.current) return;
        const dt = Math.min(0.05, appRef.current.ticker.deltaMS / 1000 || 0.016);
        const nowMs = performance.now();
        if (!propsRef.current.paused && !engine.awaitingUpgrade && !engine.awaitingClass && !engine.finished) {
          updateEngine(engine, propsRef.current, controlsRef.current, dt);
        }
        drawEngine(PIXI!, appRef.current, graphicsRef.current, visualRendererRef.current, engine);
        if (nowMs - lastSnapshotRef.current >= snapshotEveryMs || engine.finished) {
          lastSnapshotRef.current = nowMs;
          propsRef.current.onSnapshot(snapshotFromEngine(engine));
        }
      });
    }

    void boot();

    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const key = normalizeKey(event.key);
      if (!key) return;
      controlsRef.current.keyboard[key] = true;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
    }

    function onKeyUp(event: KeyboardEvent) {
      const key = normalizeKey(event.key);
      if (!key) return;
      controlsRef.current.keyboard[key] = false;
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      resizeObserver?.disconnect();
      controlsRef.current = { keyboard: {}, stickX: 0, stickY: 0 };
      visualRendererRef.current?.destroy();
      visualRendererRef.current = null;
      appRef.current?.destroy(true, { children: true, texture: true, baseTexture: true });
      appRef.current = null;
      graphicsRef.current = null;
      engineRef.current = null;
    };
  }, [props.run.run_id, classJob]);

  useEffect(() => {
    const pick = props.appliedUpgrade;
    const engine = engineRef.current;
    if (!pick || !engine || pick.sequence === lastUpgradeSeqRef.current) return;
    lastUpgradeSeqRef.current = pick.sequence;
    applyUpgrade(engine, pick.upgrade);
    engine.awaitingUpgrade = false;
    props.onSnapshot(snapshotFromEngine(engine));
  }, [props.appliedUpgrade, props]);

  useEffect(() => {
    const pick = props.appliedClass;
    const engine = engineRef.current;
    if (!pick || !engine || pick.sequence === lastClassSeqRef.current) return;
    lastClassSeqRef.current = pick.sequence;
    applySpecialization(engine, pick.job, props.data);
    engine.awaitingClass = false;
    props.onSnapshot(snapshotFromEngine(engine));
  }, [props.appliedClass, props]);

  function updateStickFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = event.clientX - (rect.left + radius);
    const dy = event.clientY - (rect.top + radius);
    const length = Math.hypot(dx, dy) || 1;
    const magnitude = Math.min(1, length / Math.max(1, radius - 10));
    const nx = (dx / length) * magnitude;
    const ny = (dy / length) * magnitude;
    controlsRef.current.stickX = nx;
    controlsRef.current.stickY = ny;
    setStickKnob({ x: nx * 30, y: ny * 30 });
  }

  return (
    <div className="pixel-game-canvas-wrap">
      <div ref={hostRef} className="pixel-game-canvas-host" />
      <div
        className={`pixel-game-stick ${stickActive ? "active" : ""}`}
        role="application"
        aria-label="Movement stick"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setStickActive(true);
          updateStickFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (stickActive) updateStickFromPointer(event);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setStickActive(false);
          controlsRef.current.stickX = 0;
          controlsRef.current.stickY = 0;
          setStickKnob({ x: 0, y: 0 });
        }}
        onPointerCancel={() => {
          setStickActive(false);
          controlsRef.current.stickX = 0;
          controlsRef.current.stickY = 0;
          setStickKnob({ x: 0, y: 0 });
        }}
      >
        <span style={{ transform: `translate(${stickKnob.x}px, ${stickKnob.y}px)` }} />
      </div>
    </div>
  );
}

function createEngine(run: PixelGamePublicRun, data: PixelGameDataBundle, job: PixelGameJob | undefined): EngineState {
  const base = job?.baseStats || {};
  const biome = data.biomes.find((item) => item.id === run.stage_id) || data.biomes[0];
  const bossId = biome?.boss_id || "boss_signal_hydra";
  const hp = clamp(Number(base.maxHp || 96), 60, 180);
  const serverElapsed = Math.max(0, Math.floor((Date.now() - Date.parse(run.started_at || "")) / 1000));
  const director = buildDirectorProfile(data, run, job);
  const primaryWeapon = resolveWeapon(data, job);
  return {
    worldWidth: 1800,
    worldHeight: 1200,
    elapsed: clamp(Number(run.duration_seconds || 0) || serverElapsed, 0, maxRunSeconds),
    finished: false,
    awaitingUpgrade: false,
    awaitingClass: false,
    bossSpawned: false,
    bossResult: "not_reached",
    classId: run.class_id,
    specializationId: "",
    classJob: job,
    specializationJob: undefined,
    director,
    primaryWeapon,
    activeWeaponIds: [primaryWeapon.id],
    upgradeIds: [],
    upgradeRanks: new Map(),
    hp,
    maxHp: hp,
    shield: 0,
    level: 1,
    xp: 0,
    xpToNext: 8,
    xpMultiplier: 1,
    score: 0,
    kills: 0,
    damageMultiplier: clamp(Number(base.attack || 1), 0.7, 1.6),
    speed: 168 * clamp(Number(base.speed || 1), 0.75, 1.45),
    cooldownMs: 520 * clamp(Number(base.cooldown || 1), 0.55, 1.5),
    projectileSpeed: 500,
    projectileCount: 1,
    pickupRange: 92 * clamp(Number(base.pickup || 1), 0.75, 1.8),
    x: 900,
    y: 600,
    lastX: 900,
    lastY: 600,
    attackTimer: 0,
    spawnTimer: 0,
    specialEventTimer: 18,
    supplyTimer: 42,
    dashTrailTimer: 0,
    shieldTimer: 0,
    hurtCooldown: 0,
    rng: makeRng(`${run.seed || run.run_id}:${run.class_id}`),
    biomePalette: biome?.palette || ["#071226", "#21f3ff", "#ff4fd8", "#ffe66d"],
    biomeFamilies: biome?.enemy_families || [],
    bossId,
    bossSpawnSecond: bossSpawnSecond(data, bossId),
    enemies: [],
    projectiles: [],
    zones: [],
    turrets: [],
    gems: [],
    effects: []
  };
}

function updateEngine(engine: EngineState, props: Props, controls: Controls, dt: number) {
  engine.elapsed += dt;
  engine.attackTimer -= dt * 1000;
  engine.spawnTimer -= dt;
  engine.hurtCooldown = Math.max(0, engine.hurtCooldown - dt);
  engine.shieldTimer += dt;
  engine.specialEventTimer -= dt;
  engine.supplyTimer -= dt;
  engine.dashTrailTimer -= dt;
  if (engine.supplyTimer <= 0 && (engine.specializationId === "moon_courier" || engine.upgradeIds.includes("moon_supply") || engine.director.pickupBias.includes("supply"))) {
    engine.supplyTimer = engine.specializationId === "moon_courier" ? 34 : 58;
    dropBonusGem(engine, engine.x + (engine.rng() - 0.5) * 220, engine.y + (engine.rng() - 0.5) * 220, 7, "#ffe66d");
  }

  if (engine.shieldTimer >= 28 && engine.shield < 3) {
    engine.shieldTimer = 0;
    if (engine.upgradeIds.includes("crt_guard") || engine.upgradeIds.includes("repair_drone")) engine.shield += 1;
  }

  const input = movementVector(controls);
  engine.lastX = engine.x;
  engine.lastY = engine.y;
  engine.x = clamp(engine.x + input.x * engine.speed * dt, 40, engine.worldWidth - 40);
  engine.y = clamp(engine.y + input.y * engine.speed * dt, 40, engine.worldHeight - 40);
  maybeEmitMovementTrail(engine, input);
  maybeTriggerDirectorEvent(engine);

  spawnEnemies(engine, props.data, dt);
  autoAttack(engine, props.data);
  updateProjectiles(engine, dt);
  updateZones(engine, dt);
  updateTurrets(engine, dt);
  updateEnemies(engine, dt);
  updateGems(engine, dt);
  updateEffects(engine, dt);
  processLevelUps(engine, props);
  maybeSpawnBoss(engine, props.data);

  if (engine.hp <= 0) {
    finishEngine(engine, props, "defeated");
    return;
  }
  if (engine.elapsed >= maxRunSeconds) {
    finishEngine(engine, props, engine.bossResult === "defeated" ? "cleared" : "timeout");
  }
}

function spawnEnemies(engine: EngineState, data: PixelGameDataBundle, dt: number) {
  const wave = currentWave(data.waves, engine.elapsed);
  const difficulty = 1 + Math.min(1.35, engine.elapsed / maxRunSeconds) + difficultyBonus(engine);
  const interval = clamp(0.72 / (wave.spawn_rate || 1) / difficulty / engine.director.spawnTempo, 0.13, 1.05);
  const maxAlive = Math.floor((34 + engine.elapsed / 18) * clamp(engine.director.spawnTempo, 0.78, 1.24));
  if (engine.enemies.length >= maxAlive) return;
  if (engine.spawnTimer > 0) return;
  engine.spawnTimer = interval;
  const batchBase = engine.elapsed > 420 ? 2 : engine.elapsed > 180 ? 1 + (engine.rng() > 0.55 ? 1 : 0) : 1;
  const batch = batchBase + (engine.director.spawnTempo > 1.08 && engine.rng() < 0.22 ? 1 : 0);
  for (let index = 0; index < batch && engine.enemies.length < maxAlive; index += 1) {
    const enemy = pickEnemy(data.enemies, wave, engine);
    engine.enemies.push(createEnemy(enemy, engine, difficulty));
  }
  void dt;
}

function maybeSpawnBoss(engine: EngineState, data: PixelGameDataBundle) {
  if (engine.bossSpawned || engine.elapsed < engine.bossSpawnSecond) return;
  engine.bossSpawned = true;
  const boss = data.bosses.find((item) => item.id === engine.bossId) || data.bosses[0];
  if (!boss) return;
  const angle = engine.rng() * Math.PI * 2;
  const hp = boss.hp * clamp(engine.director.enemyHpMultiplier * (0.94 + engine.director.eliteRate * 0.08), 0.85, 1.35);
  engine.enemies.push({
    id: `boss-${Date.now()}`,
    typeId: boss.id,
    x: clamp(engine.x + Math.cos(angle) * 430, 70, engine.worldWidth - 70),
    y: clamp(engine.y + Math.sin(angle) * 320, 70, engine.worldHeight - 70),
    hp,
    maxHp: hp,
    speed: boss.speed * clamp(engine.director.enemySpeedMultiplier, 0.82, 1.24),
    damage: boss.damage * clamp(engine.director.eliteRate, 0.86, 1.3),
    xp: Math.round(70 * engine.director.dropMultiplier),
    score: Math.round(2600 * clamp(engine.director.eliteRate, 0.9, 1.28)),
    size: 44,
    color: boss.color || "#ff4fd8",
    boss: true,
    phase: engine.rng() * 9
  });
}

function bossSpawnSecond(data: PixelGameDataBundle, bossId: string) {
  const boss = data.bosses.find((item) => item.id === bossId) || data.bosses[0];
  const bossWave = data.waves.find((wave) => wave.boss);
  const minute = Number(boss?.spawn_minute ?? bossWave?.minute ?? 15);
  // Spawn slightly before the hard cap so the 15-minute run still has a visible BOSS duel.
  return clamp(minute * 60 - 30, 60, maxRunSeconds);
}

function pickEnemy(enemies: PixelGameEnemyTuning[], wave: PixelGameWaveRule, engine: EngineState) {
  const families = uniqueStrings([
    ...((wave.families?.length ? wave.families : engine.biomeFamilies) || []),
    ...engine.director.preferredFamilies
  ]);
  const pool = enemies.filter((enemy) => !families.length || families.includes(enemy.family || ""));
  const candidates = pool.length ? pool : enemies;
  const total = candidates.reduce((sum, enemy) => sum + enemySpawnWeight(enemy, engine), 0) || 1;
  let cursor = engine.rng() * total;
  for (const enemy of candidates) {
    cursor -= enemySpawnWeight(enemy, engine);
    if (cursor <= 0) return enemy;
  }
  return candidates[0];
}

function createEnemy(template: PixelGameEnemyTuning, engine: EngineState, difficulty: number): Enemy {
  const edge = Math.floor(engine.rng() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) { x = engine.x - 520; y = engine.y + (engine.rng() - 0.5) * 620; }
  if (edge === 1) { x = engine.x + 520; y = engine.y + (engine.rng() - 0.5) * 620; }
  if (edge === 2) { x = engine.x + (engine.rng() - 0.5) * 820; y = engine.y - 420; }
  if (edge === 3) { x = engine.x + (engine.rng() - 0.5) * 820; y = engine.y + 420; }
  const elite = template.archetype === "elite" || engine.rng() < Math.max(0, engine.director.eliteRate - 1) * 0.12;
  const hpScale = (0.8 + difficulty * 0.48) * engine.director.enemyHpMultiplier * (elite && template.archetype !== "elite" ? 1.8 : 1);
  const speedScale = (0.88 + difficulty * 0.08) * engine.director.enemySpeedMultiplier * (elite && template.archetype !== "elite" ? 0.88 : 1);
  const xpScale = engine.director.dropMultiplier * (elite ? 1.55 : 1);
  const scoreScale = elite ? 1.7 : 1;
  return {
    id: `enemy-${Date.now()}-${Math.floor(engine.rng() * 100000)}`,
    typeId: template.id,
    x: clamp(x, 24, engine.worldWidth - 24),
    y: clamp(y, 24, engine.worldHeight - 24),
    hp: Math.max(4, template.hp * hpScale),
    maxHp: Math.max(4, template.hp * hpScale),
    speed: template.speed * speedScale,
    damage: template.damage * (0.86 + difficulty * 0.08) * (elite ? 1.22 : 1),
    xp: Math.max(1, Math.round(template.xp * xpScale)),
    score: Math.round(template.score * scoreScale),
    size: (template.size || 12) * (elite && template.archetype !== "elite" ? 1.18 : 1),
    color: elite && template.archetype !== "elite" ? "#ffe66d" : template.color || "#44f5ff",
    phase: engine.rng() * 10
  };
}

function autoAttack(engine: EngineState, data: PixelGameDataBundle) {
  if (engine.attackTimer > 0) return;
  const weapon = engine.primaryWeapon;
  const target = nearestEnemy(engine, weapon.range);
  if (!target) return;
  engine.attackTimer = Math.max(120, weapon.cooldown_ms * clamp(engine.cooldownMs / 520, 0.45, 1.8));
  const baseAngle = Math.atan2(target.y - engine.y, target.x - engine.x);
  const damage = weapon.damage * engine.damageMultiplier;
  const kind = weapon.kind || "projectile";

  if (kind === "slash") {
    const hits = damageEnemiesInArc(engine, engine.x, engine.y, weapon.range, baseAngle, Math.PI * 0.72, damage * 1.16);
    pushNeonEffect(engine, {
      kind: "hit",
      x: engine.x + Math.cos(baseAngle) * weapon.range * 0.48,
      y: engine.y + Math.sin(baseAngle) * weapon.range * 0.48,
      duration: 0.22,
      color: weapon.color || "#ff5fd7",
      size: weapon.range * (hits ? 0.8 : 0.55)
    });
    if (engine.upgradeIds.includes("blade_afterimage") || engine.specializationId === "neon_samurai") {
      setTimeoutSafeSlash(engine, baseAngle, weapon, damage * 0.45);
    }
    return;
  }

  if (kind === "aura" || kind === "pulse" || kind === "orbital_pulse") {
    const radius = kind === "orbital_pulse" ? weapon.range * 0.78 : weapon.range;
    damageEnemiesInRadius(engine, engine.x, engine.y, radius, damage, weapon.color || "#ffe66d");
    pushNeonEffect(engine, {
      kind: "hit",
      x: engine.x,
      y: engine.y,
      duration: 0.34,
      color: weapon.color || "#ffe66d",
      size: radius
    });
    if (kind === "orbital_pulse" && engine.upgradeIds.includes("orbit_ofuda")) {
      spawnRingProjectiles(engine, weapon, Math.max(3, engine.projectileCount + 2), damage * 0.45);
    }
    return;
  }

  if (kind === "zone") {
    engine.zones.push({
      id: `zone-${Date.now()}-${Math.floor(engine.rng() * 9999)}`,
      weaponId: weapon.id,
      x: engine.x + Math.cos(baseAngle) * Math.min(weapon.range * 0.55, 110),
      y: engine.y + Math.sin(baseAngle) * Math.min(weapon.range * 0.55, 110),
      radius: weapon.range * 0.58,
      damage: damage * 0.38,
      tickEvery: 0.34,
      tickTimer: 0,
      life: engine.specializationId === "quantum_tuner" ? 3.6 : 2.4,
      color: weapon.color || "#b18cff",
      pulse: false
    });
    return;
  }

  if (kind === "turret") {
    engine.turrets.push({
      id: `turret-${Date.now()}-${Math.floor(engine.rng() * 9999)}`,
      weaponId: weapon.id,
      x: clamp(engine.x + (engine.rng() - 0.5) * 120, 40, engine.worldWidth - 40),
      y: clamp(engine.y + (engine.rng() - 0.5) * 120, 40, engine.worldHeight - 40),
      range: weapon.range,
      damage: damage * 0.72,
      cooldownMs: Math.max(220, weapon.cooldown_ms * 0.68),
      timerMs: 0,
      life: engine.specializationId === "scrap_engineer" ? 13 : 8,
      color: weapon.color || "#c8ff4d"
    });
    if (engine.turrets.length > (engine.specializationId === "scrap_engineer" ? 4 : 2)) engine.turrets.shift();
    return;
  }

  if (kind === "guard") {
    engine.shield = Math.min(5, engine.shield + 1);
    damageEnemiesInArc(engine, engine.x, engine.y, weapon.range, baseAngle, Math.PI * 0.95, damage);
    spawnRingProjectiles(engine, weapon, Math.max(4, engine.projectileCount + engine.shield), damage * 0.36);
    return;
  }

  if (kind === "dash_echo") {
    const echoX = engine.x - Math.cos(baseAngle) * 18;
    const echoY = engine.y - Math.sin(baseAngle) * 18;
    damageEnemiesInRadius(engine, echoX, echoY, weapon.range * 0.55, damage * 0.86, weapon.color || "#6c7bff");
    spawnProjectile(engine, weapon, baseAngle, damage * 0.72, {
      pierce: 2,
      speed: engine.projectileSpeed * 0.9,
      range: weapon.range * 1.4
    });
    return;
  }

  const count = Math.max(1, Math.min(8, Math.floor(engine.projectileCount + (kind === "projectile" ? 1 : 0))));
  for (let index = 0; index < count; index += 1) {
    const spread = (index - (count - 1) / 2) * (kind === "homing" ? 0.08 : 0.16);
    spawnProjectile(engine, weapon, baseAngle + spread, damage, {
      homing: kind === "homing",
      pierce: kind === "pierce" ? 3 : 1,
      chain: engine.upgradeIds.includes("static_chain") || weapon.tags?.includes("chain") ? 1 : 0
    });
  }
  maybeAddBonusWeapon(engine, data, weapon, baseAngle, damage);
}

function updateProjectiles(engine: EngineState, dt: number) {
  for (const projectile of engine.projectiles) {
    if (projectile.homing) {
      const target = nearestEnemy(engine, 260);
      if (target) {
        const desired = Math.atan2(target.y - projectile.y, target.x - projectile.x);
        const speed = Math.hypot(projectile.vx, projectile.vy) || engine.projectileSpeed;
        const current = Math.atan2(projectile.vy, projectile.vx);
        const angle = lerpAngle(current, desired, 0.11);
        projectile.vx = Math.cos(angle) * speed;
        projectile.vy = Math.sin(angle) * speed;
      }
    }
    const lastX = projectile.x;
    const lastY = projectile.y;
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.traveled += distance(lastX, lastY, projectile.x, projectile.y);
    projectile.life -= dt;
    if (projectile.traveled > projectile.range) projectile.life = 0;
  }
  for (const projectile of engine.projectiles) {
    if (projectile.life <= 0) continue;
    for (const enemy of engine.enemies) {
      if (enemy.hp <= 0) continue;
      if (projectile.hitIds.has(enemy.id)) continue;
      if (distance(projectile.x, projectile.y, enemy.x, enemy.y) > enemy.size + projectile.size) continue;
      const killed = damageEnemy(engine, enemy, projectile.damage, projectile.color, projectile.size * 5);
      projectile.hitIds.add(enemy.id);
      projectile.pierce -= 1;
      if (projectile.chain > 0 && (killed || engine.rng() < 0.32)) {
        const next = nearestEnemyFrom(engine, projectile.x, projectile.y, 170, projectile.hitIds);
        if (next) {
          const angle = Math.atan2(next.y - projectile.y, next.x - projectile.x);
          spawnProjectileById(engine, projectile.weaponId, projectile.x, projectile.y, angle, projectile.damage * 0.62, projectile.color, {
            homing: true,
            chain: projectile.chain - 1,
            range: 180
          });
        }
      }
      if (projectile.pierce <= 0) projectile.life = 0;
      break;
    }
  }
  engine.projectiles = engine.projectiles.filter((projectile) => projectile.life > 0 && projectile.x > -80 && projectile.x < engine.worldWidth + 80 && projectile.y > -80 && projectile.y < engine.worldHeight + 80);
  engine.enemies = engine.enemies.filter((enemy) => enemy.hp > 0);
}

function updateZones(engine: EngineState, dt: number) {
  for (const zone of engine.zones) {
    zone.life -= dt;
    zone.tickTimer -= dt;
    if (zone.tickTimer <= 0) {
      zone.tickTimer = zone.tickEvery;
      damageEnemiesInRadius(engine, zone.x, zone.y, zone.radius, zone.damage, zone.color);
      pushNeonEffect(engine, {
        kind: "hit",
        x: zone.x,
        y: zone.y,
        duration: 0.18,
        color: zone.color,
        size: zone.radius
      });
    }
  }
  engine.zones = engine.zones.filter((zone) => zone.life > 0).slice(-12);
  engine.enemies = engine.enemies.filter((enemy) => enemy.hp > 0);
}

function updateTurrets(engine: EngineState, dt: number) {
  for (const turret of engine.turrets) {
    turret.life -= dt;
    turret.timerMs -= dt * 1000;
    if (turret.timerMs > 0) continue;
    const target = nearestEnemyFrom(engine, turret.x, turret.y, turret.range);
    if (!target) continue;
    turret.timerMs = turret.cooldownMs;
    const angle = Math.atan2(target.y - turret.y, target.x - turret.x);
    spawnProjectileById(engine, turret.weaponId, turret.x, turret.y, angle, turret.damage, turret.color, {
      range: turret.range,
      speed: engine.projectileSpeed * 0.78,
      pierce: engine.upgradeIds.includes("repair_drone") ? 2 : 1
    });
  }
  engine.turrets = engine.turrets.filter((turret) => turret.life > 0).slice(-6);
}

function spawnProjectile(
  engine: EngineState,
  weapon: PixelGameWeaponTuning,
  angle: number,
  damage: number,
  options: Partial<Pick<Projectile, "homing" | "pierce" | "chain" | "range">> & { speed?: number } = {}
) {
  spawnProjectileById(engine, weapon.id, engine.x, engine.y, angle, damage, weapon.color || engine.biomePalette[1] || "#44f5ff", {
    ...options,
    range: options.range || weapon.range,
    speed: options.speed || engine.projectileSpeed
  });
}

function spawnProjectileById(
  engine: EngineState,
  weaponId: string,
  x: number,
  y: number,
  angle: number,
  damage: number,
  color: string,
  options: Partial<Pick<Projectile, "homing" | "pierce" | "chain" | "range">> & { speed?: number } = {}
) {
  const speed = options.speed || engine.projectileSpeed;
  engine.projectiles.push({
    id: `shot-${Date.now()}-${Math.floor(engine.rng() * 999999)}`,
    weaponId,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    damage,
    life: clamp((options.range || 300) / Math.max(1, speed), 0.18, 2.4),
    size: weaponId.includes("katana") || weaponId.includes("blade") ? 7 : 5,
    color,
    range: options.range || 300,
    traveled: 0,
    pierce: Math.max(1, Math.floor(options.pierce || 1)),
    homing: Boolean(options.homing),
    chain: Math.max(0, Math.floor(options.chain || 0)),
    hitIds: new Set()
  });
}

function spawnRingProjectiles(engine: EngineState, weapon: PixelGameWeaponTuning, count: number, damage: number) {
  const safeCount = Math.max(3, Math.min(12, Math.floor(count)));
  for (let index = 0; index < safeCount; index += 1) {
    const angle = (Math.PI * 2 * index) / safeCount + engine.elapsed * 0.1;
    spawnProjectile(engine, weapon, angle, damage, {
      pierce: 1,
      range: weapon.range * 1.25,
      speed: engine.projectileSpeed * 0.74
    });
  }
}

function damageEnemy(engine: EngineState, enemy: Enemy, amount: number, color: string, size: number) {
  const critical = shouldCrit(engine, enemy);
  const damage = amount * (critical ? 1.85 : 1);
  const willKill = enemy.hp - damage <= 0;
  enemy.hp -= damage;
  pushNeonEffect(engine, {
    kind: "hit",
    x: enemy.x,
    y: enemy.y,
    duration: willKill ? 0.16 : 0.22,
    color: critical ? "#ffe66d" : color || enemy.color,
    size: Math.max(18, size || enemy.size * (enemy.boss ? 1.2 : 1.8)),
    targetTypeId: enemy.typeId,
    boss: Boolean(enemy.boss)
  });
  if (enemy.hp <= 0) {
    killEnemy(engine, enemy);
    return true;
  }
  return false;
}

function damageEnemiesInRadius(engine: EngineState, x: number, y: number, radius: number, damage: number, color: string) {
  let hits = 0;
  for (const enemy of engine.enemies) {
    if (enemy.hp <= 0) continue;
    if (distance(x, y, enemy.x, enemy.y) > radius + enemy.size) continue;
    hits += 1;
    damageEnemy(engine, enemy, damage, color, radius * 0.28);
  }
  return hits;
}

function damageEnemiesInArc(engine: EngineState, x: number, y: number, radius: number, angle: number, arc: number, damage: number) {
  let hits = 0;
  for (const enemy of engine.enemies) {
    if (enemy.hp <= 0) continue;
    const dist = distance(x, y, enemy.x, enemy.y);
    if (dist > radius + enemy.size) continue;
    const targetAngle = Math.atan2(enemy.y - y, enemy.x - x);
    if (Math.abs(angleDelta(angle, targetAngle)) > arc / 2) continue;
    hits += 1;
    damageEnemy(engine, enemy, damage, engine.primaryWeapon.color || enemy.color, radius * 0.32);
  }
  return hits;
}

function addAfterimageSlash(engine: EngineState, angle: number, weapon: PixelGameWeaponTuning, damage: number) {
  const x = engine.x + Math.cos(angle) * weapon.range * 0.35;
  const y = engine.y + Math.sin(angle) * weapon.range * 0.35;
  damageEnemiesInArc(engine, x, y, weapon.range * 0.9, angle, Math.PI * 0.64, damage);
  pushNeonEffect(engine, {
    kind: "hit",
    x,
    y,
    duration: 0.2,
    color: weapon.color || "#ff5fd7",
    size: weapon.range * 0.72
  });
}

function setTimeoutSafeSlash(engine: EngineState, angle: number, weapon: PixelGameWeaponTuning, damage: number) {
  addAfterimageSlash(engine, angle, weapon, damage);
}

function maybeAddBonusWeapon(engine: EngineState, data: PixelGameDataBundle, weapon: PixelGameWeaponTuning, angle: number, damage: number) {
  if (!engine.upgradeIds.includes("counter_burst") && engine.specializationId !== "barrage_knight") return;
  if (engine.rng() > 0.24) return;
  const shieldWeapon = findWeapon(data, "bullet_shield") || weapon;
  spawnRingProjectiles(engine, shieldWeapon, 5, damage * 0.42);
}

function maybeEmitMovementTrail(engine: EngineState, input: { x: number; y: number }) {
  if (engine.dashTrailTimer > 0) return;
  const moved = Math.hypot(engine.x - engine.lastX, engine.y - engine.lastY);
  if (moved < 1) return;
  const trailEligible =
    engine.primaryWeapon.kind === "dash_echo" ||
    engine.specializationId === "pixel_nekomata" ||
    engine.specializationId === "moon_courier" ||
    engine.upgradeIds.includes("neon_step");
  if (!trailEligible) return;
  engine.dashTrailTimer = engine.specializationId === "pixel_nekomata" ? 0.22 : 0.34;
  const x = engine.x - input.x * 22;
  const y = engine.y - input.y * 22;
  engine.zones.push({
    id: `trail-${Date.now()}-${Math.floor(engine.rng() * 9999)}`,
    weaponId: engine.primaryWeapon.id,
    x,
    y,
    radius: engine.specializationId === "moon_courier" ? 62 : 46,
    damage: engine.primaryWeapon.damage * engine.damageMultiplier * 0.18,
    tickEvery: 0.22,
    tickTimer: 0,
    life: 0.8,
    color: engine.primaryWeapon.color || "#6c7bff",
    pulse: true
  });
}

function maybeTriggerDirectorEvent(engine: EngineState) {
  if (engine.specialEventTimer > 0) return;
  engine.specialEventTimer = 24 + engine.rng() * 18;
  const tags = new Set(engine.director.preferredEventTags);
  if (tags.has("safe_circle") || tags.has("safe_lane") || engine.hp / Math.max(1, engine.maxHp) < 0.32) {
    engine.shield = Math.min(5, engine.shield + 1);
    engine.zones.push({
      id: `safe-${Date.now()}-${Math.floor(engine.rng() * 9999)}`,
      weaponId: "director_safe_circle",
      x: engine.x,
      y: engine.y,
      radius: 110,
      damage: engine.primaryWeapon.damage * 0.22,
      tickEvery: 0.42,
      tickTimer: 0,
      life: 3.2,
      color: "#9ad1ff",
      pulse: false
    });
  } else if (tags.has("supply_drop") || tags.has("gift_spark")) {
    dropBonusGem(engine, engine.x + (engine.rng() - 0.5) * 180, engine.y + (engine.rng() - 0.5) * 180, 8, "#ffe66d");
  } else if (tags.has("glitch_path") || tags.has("scene_rewrite")) {
    for (const enemy of engine.enemies.slice(0, 18)) {
      enemy.phase += Math.PI * 0.85;
      enemy.speed *= 0.94;
    }
  } else {
    damageEnemiesInRadius(engine, engine.x, engine.y, 120, engine.primaryWeapon.damage * engine.damageMultiplier * 0.55, engine.biomePalette[2] || "#ff4fd8");
  }
}

function updateEnemies(engine: EngineState, dt: number) {
  for (const enemy of engine.enemies) {
    const angle = Math.atan2(engine.y - enemy.y, engine.x - enemy.x);
    const wobble = enemy.boss ? Math.sin(engine.elapsed * 2 + enemy.phase) * 0.3 : Math.sin(engine.elapsed * 4 + enemy.phase) * 0.12;
    enemy.x += Math.cos(angle + wobble) * enemy.speed * dt;
    enemy.y += Math.sin(angle + wobble) * enemy.speed * dt;
    const hitDistance = enemy.size + 15;
    if (distance(enemy.x, enemy.y, engine.x, engine.y) <= hitDistance && engine.hurtCooldown <= 0) {
      if (engine.shield > 0) {
        engine.shield -= 1;
        if (engine.specializationId === "barrage_knight" || engine.upgradeIds.includes("counter_burst")) {
          spawnRingProjectiles(engine, engine.primaryWeapon, 6, engine.primaryWeapon.damage * engine.damageMultiplier * 0.44);
        }
      } else {
        engine.hp -= enemy.damage;
      }
      engine.hurtCooldown = 0.45;
    }
  }
}

function updateGems(engine: EngineState, dt: number) {
  for (const gem of engine.gems) {
    const dist = distance(gem.x, gem.y, engine.x, engine.y);
    if (dist < engine.pickupRange) {
      const pull = clamp((engine.pickupRange - dist) / engine.pickupRange, 0.25, 1);
      const angle = Math.atan2(engine.y - gem.y, engine.x - gem.x);
      gem.x += Math.cos(angle) * 420 * pull * dt;
      gem.y += Math.sin(angle) * 420 * pull * dt;
    }
    if (dist < 20) {
      engine.xp += gem.xp * engine.xpMultiplier;
      gem.xp = 0;
    }
  }
  engine.gems = engine.gems.filter((gem) => gem.xp > 0).slice(-120);
}

function updateEffects(engine: EngineState, dt: number) {
  let writeIndex = 0;
  for (const effect of engine.effects) {
    effect.age += dt;
    if (effect.age < effect.duration) {
      engine.effects[writeIndex] = effect;
      writeIndex += 1;
    }
  }
  engine.effects.length = writeIndex;
  if (engine.effects.length > 96) engine.effects.splice(0, engine.effects.length - 96);
}

function killEnemy(engine: EngineState, enemy: Enemy) {
  engine.kills += enemy.boss ? 1 : 1;
  engine.score += Math.floor(enemy.score * (enemy.boss ? 1.6 : 1));
  if (enemy.boss) engine.bossResult = "defeated";
  pushNeonEffect(engine, {
    kind: "kill",
    x: enemy.x,
    y: enemy.y,
    duration: enemy.boss ? 0.72 : 0.42,
    color: enemy.boss ? "#ffe66d" : enemy.color,
    size: enemy.boss ? enemy.size * 2.4 : Math.max(32, enemy.size * 2.8),
    targetTypeId: enemy.typeId,
    boss: Boolean(enemy.boss)
  });
  if (engine.specializationId === "stream_hacker" && (enemy.boss || enemy.score >= 80 || enemy.typeId.includes("glitch"))) {
    engine.score += 45;
    dropBonusGem(engine, enemy.x, enemy.y, 3, "#8bff7a");
  }
  if (engine.specializationId === "star_idol" && engine.kills % 18 === 0) {
    engine.pickupRange *= 1.006;
    damageEnemiesInRadius(engine, enemy.x, enemy.y, 72, engine.primaryWeapon.damage * 0.55, "#44f5ff");
  }
  if (engine.specializationId === "pixel_nekomata" && engine.kills % 12 === 0) {
    engine.speed *= 1.006;
  }
  if (engine.specializationId === "moon_courier" && engine.kills % 28 === 0) {
    dropBonusGem(engine, enemy.x, enemy.y, 6, "#ffe66d");
  }
  const dropBiasBonus = engine.director.pickupBias.some((tag) => ["pickup", "supply", "recovery", "charm"].includes(tag)) ? 1 : 0;
  const gems = enemy.boss ? 12 : enemy.xp >= 6 ? 3 + dropBiasBonus : 1 + (engine.rng() < (engine.director.dropMultiplier - 1) * 0.6 ? 1 : 0);
  for (let index = 0; index < gems; index += 1) {
    dropBonusGem(engine, enemy.x + (engine.rng() - 0.5) * enemy.size * 2, enemy.y + (engine.rng() - 0.5) * enemy.size * 2, Math.max(1, Math.ceil(enemy.xp / gems)), enemy.boss ? "#ffe66d" : "#7cffc4");
  }
}

function pushNeonEffect(
  engine: EngineState,
  effect: Omit<PixelGameVisualEffect, "id" | "age">
) {
  engine.effects.push({
    ...effect,
    id: `fx-${Date.now()}-${Math.floor(engine.rng() * 100000)}`,
    age: 0
  });
  if (engine.effects.length > 96) engine.effects.splice(0, engine.effects.length - 96);
}

function processLevelUps(engine: EngineState, props: Props) {
  if (engine.awaitingUpgrade || engine.awaitingClass || engine.finished) return;
  if (!engine.specializationId && engine.level >= 5) {
    engine.awaitingClass = true;
    props.onClassChoice(pickClassChoices(props.data.jobs, engine), engine.level);
    return;
  }
  if (engine.xp < engine.xpToNext) return;
  engine.xp -= engine.xpToNext;
  engine.level += 1;
  engine.xpToNext = Math.floor(engine.xpToNext * 1.22 + 5);
  engine.hp = Math.min(engine.maxHp, engine.hp + Math.ceil(engine.maxHp * 0.1));
  engine.awaitingUpgrade = true;
  props.onLevelUp(pickUpgradeChoices(props.data.upgrades, engine, props.run), engine.level);
}

function finishEngine(engine: EngineState, props: Props, result: "cleared" | "defeated" | "timeout") {
  if (engine.finished) return;
  engine.finished = true;
  const duration = Math.max(1, Math.min(maxRunSeconds, Math.floor(engine.elapsed)));
  const waves = result === "cleared" || duration >= maxRunSeconds ? 15 : Math.min(15, Math.floor(engine.elapsed / 60));
  const bossResult: PixelGameBossResult = engine.bossResult === "defeated" ? "defeated" : engine.bossSpawned ? "failed" : "not_reached";
  const score = Math.max(0, Math.floor(engine.score + waves * 450 + engine.level * 180 + (bossResult === "defeated" ? 8000 : 0)));
  props.onFinish({
    duration_seconds: duration,
    score,
    kills: engine.kills,
    level: engine.level,
    waves_cleared: waves,
    boss_result: bossResult,
    result,
    upgrade_ids: engine.upgradeIds,
    specialization_id: engine.specializationId
  });
}

function applyUpgrade(engine: EngineState, upgrade: PixelGameUpgradeOption) {
  const rank = (engine.upgradeRanks.get(upgrade.id) || 0) + 1;
  engine.upgradeRanks.set(upgrade.id, rank);
  engine.upgradeIds.push(upgrade.id);
  const tags = new Set([...(upgrade.tags || []), upgrade.id]);
  if (tags.has("damage") || tags.has("sound") || tags.has("blade") || upgrade.id.includes("amp")) engine.damageMultiplier *= 1.12;
  if (tags.has("mobility") || tags.has("dash") || upgrade.id.includes("step")) engine.speed *= 1.08;
  if (tags.has("survival") || tags.has("recovery") || upgrade.id.includes("heart")) {
    engine.maxHp += 15;
    engine.hp = Math.min(engine.maxHp, engine.hp + 24);
  }
  if (tags.has("pickup") || upgrade.id.includes("magnet")) engine.pickupRange *= 1.18;
  if (tags.has("tempo") || upgrade.id.includes("cooldown")) engine.cooldownMs *= 0.92;
  if (tags.has("shield") || tags.has("guard")) engine.shield = Math.min(4, engine.shield + 1);
  if (tags.has("chain") || tags.has("orbit") || tags.has("summon") || upgrade.id.includes("drone")) engine.projectileCount = Math.min(6, engine.projectileCount + 1);
  if (tags.has("utility") || tags.has("data")) engine.projectileSpeed *= 1.06;
  if (tags.has("charm")) engine.xpMultiplier *= 1.08;
  if (tags.has("crit") || tags.has("mark")) engine.damageMultiplier *= 1.06;
  if (tags.has("zone") || tags.has("resonance")) engine.cooldownMs *= 0.96;
  if (tags.has("supply") || upgrade.id.includes("supply")) {
    dropBonusGem(engine, engine.x + 28, engine.y - 20, 6, "#ffe66d");
  }
  if (upgrade.id === "signal_miracle") {
    engine.hp = engine.maxHp;
    damageEnemiesInRadius(engine, engine.x, engine.y, 240, 90 * engine.damageMultiplier, "#ffe66d");
  }
  if (upgrade.id === "overclock_broadcast") {
    engine.director.spawnTempo = clamp(engine.director.spawnTempo * 1.06, 0.72, 1.42);
  }
}

function applySpecialization(engine: EngineState, job: PixelGameJob, data: PixelGameDataBundle) {
  engine.specializationId = job.id;
  engine.specializationJob = job;
  const stats = job.baseStats || {};
  engine.damageMultiplier *= 1 + (Number(stats.attack || 1) - 1) * 0.7;
  engine.speed *= 1 + (Number(stats.speed || 1) - 1) * 0.55;
  engine.cooldownMs *= 1 + (Number(stats.cooldown || 1) - 1) * 0.55;
  engine.pickupRange *= 1 + (Number(stats.pickup || 1) - 1) * 0.55;
  engine.maxHp += Math.max(0, Math.floor((Number(stats.maxHp || 96) - 96) * 0.35));
  engine.hp = Math.min(engine.maxHp, engine.hp + 30);
  engine.score += 250;
  const tags = new Set(job.upgradeTags || []);
  if (job.startingWeapon?.id && !engine.activeWeaponIds.includes(job.startingWeapon.id)) {
    engine.activeWeaponIds.push(job.startingWeapon.id);
  }
  const specializationWeapon = resolveWeapon(data, job);
  if (specializationWeapon) {
    engine.primaryWeapon = {
      ...specializationWeapon,
      damage: (engine.primaryWeapon.damage + specializationWeapon.damage) / 2,
      cooldown_ms: Math.min(engine.primaryWeapon.cooldown_ms, specializationWeapon.cooldown_ms),
      range: Math.max(engine.primaryWeapon.range, specializationWeapon.range),
      tags: uniqueStrings([...(engine.primaryWeapon.tags || []), ...(specializationWeapon.tags || [])])
    };
  }
  if (job.id === "star_idol") {
    engine.xpMultiplier *= 1.12;
    engine.pickupRange *= 1.18;
  } else if (job.id === "neon_samurai") {
    engine.damageMultiplier *= 1.18;
    engine.primaryWeapon = { ...engine.primaryWeapon, kind: "slash", range: Math.max(engine.primaryWeapon.range, 124) };
  } else if (job.id === "stream_hacker") {
    engine.projectileCount += 1;
    engine.primaryWeapon = { ...engine.primaryWeapon, kind: "homing", tags: uniqueStrings([...(engine.primaryWeapon.tags || []), "chain"]) };
  } else if (job.id === "radio_miko") {
    engine.shield = Math.min(5, engine.shield + 2);
    engine.zones.push({ id: `miko-${Date.now()}`, weaponId: "antenna_ofuda", x: engine.x, y: engine.y, radius: 128, damage: 5, tickEvery: 0.5, tickTimer: 0, life: 5, color: "#ffe66d", pulse: false });
  } else if (job.id === "pixel_nekomata") {
    engine.speed *= 1.12;
    engine.pickupRange *= 1.2;
  } else if (job.id === "quantum_tuner") {
    engine.cooldownMs *= 0.9;
    engine.primaryWeapon = { ...engine.primaryWeapon, kind: "zone", range: Math.max(engine.primaryWeapon.range, 180) };
  } else if (job.id === "barrage_knight") {
    engine.maxHp += 18;
    engine.hp += 18;
    engine.shield = Math.min(5, engine.shield + 2);
  } else if (job.id === "scrap_engineer") {
    engine.primaryWeapon = { ...engine.primaryWeapon, kind: "turret" };
    engine.projectileCount += 1;
  } else if (job.id === "moon_courier") {
    engine.speed *= 1.1;
    engine.supplyTimer = 8;
  } else if (job.id === "dream_director") {
    engine.director.dropMultiplier = clamp(engine.director.dropMultiplier * 1.1, 0.88, 1.42);
    engine.specialEventTimer = 4;
  }
  if (tags.has("luck")) engine.xpMultiplier *= 1.04;
}

function pickUpgradeChoices(upgrades: PixelGameUpgradeOption[], engine: EngineState, run: PixelGamePublicRun) {
  const rng = makeRng(`${run.seed}:${engine.level}:${engine.kills}:${engine.upgradeIds.length}`);
  const candidates = upgrades.filter((upgrade) => {
    const rank = engine.upgradeRanks.get(upgrade.id) || 0;
    return rank < Number(upgrade.maxRank || 1) && (!upgrade.jobId || upgrade.jobId === engine.classId || upgrade.jobId === engine.specializationId);
  });
  const weighted = candidates.length ? candidates : upgrades;
  const picked: PixelGameUpgradeOption[] = [];
  while (picked.length < 3 && picked.length < weighted.length) {
    const index = weightedPickIndex(weighted, rng, engine);
    const item = weighted[index];
    if (!picked.some((existing) => existing.id === item.id)) picked.push(item);
  }
  return picked;
}

function pickClassChoices(jobs: PixelGameJob[], engine: EngineState) {
  const rng = makeRng(`${engine.classId}:${engine.level}:${engine.kills}:class`);
  const candidates = jobs.filter((job) => job.id !== engine.classId);
  const picked: PixelGameJob[] = [];
  while (picked.length < 3 && picked.length < candidates.length) {
    const item = candidates[Math.floor(rng() * candidates.length)];
    if (item && !picked.some((existing) => existing.id === item.id)) picked.push(item);
  }
  return picked.length ? picked : jobs.slice(0, 3);
}

function weightedPickIndex(upgrades: PixelGameUpgradeOption[], rng: () => number, engine: EngineState) {
  const total = upgrades.reduce((sum, item) => sum + upgradeWeight(item, engine), 0) || 1;
  let cursor = rng() * total;
  for (let index = 0; index < upgrades.length; index += 1) {
    cursor -= upgradeWeight(upgrades[index], engine);
    if (cursor <= 0) return index;
  }
  return 0;
}

function upgradeWeight(upgrade: PixelGameUpgradeOption, engine: EngineState) {
  let weight = rarityWeight(upgrade.rarity);
  const tags = upgrade.tags || [];
  const classTags = engine.classJob?.upgradeTags || [];
  const specializationTags = engine.specializationJob?.upgradeTags || [];
  if (tags.some((tag) => classTags.includes(tag))) weight *= 1.22;
  if (tags.some((tag) => specializationTags.includes(tag))) weight *= 1.32;
  if (tags.some((tag) => engine.director.pickupBias.includes(tag))) weight *= 1.28;
  if (tags.some((tag) => engine.director.preferredEventTags.includes(tag))) weight *= 1.12;
  if (engine.hp / Math.max(1, engine.maxHp) < 0.35 && tags.some((tag) => ["shield", "recovery", "survival", "dash"].includes(tag))) weight *= 1.8;
  if (engine.specializationId === "dream_director" && tags.some((tag) => engine.director.pickupBias.includes(tag))) weight *= 1.22;
  return weight;
}

function rarityWeight(rarity: string | undefined) {
  if (rarity === "signal") return 1;
  if (rarity === "epic") return 5;
  if (rarity === "rare") return 18;
  return 58;
}

function currentWave(waves: PixelGameWaveRule[], elapsed: number) {
  const minute = elapsed / 60;
  let current = waves[0] || { minute: 0, spawn_rate: 1 };
  for (const wave of waves) {
    if (minute >= wave.minute) current = wave;
  }
  return current;
}

function difficultyBonus(engine: EngineState) {
  const paletteHot = engine.biomePalette.includes("#ff4fd8") || engine.biomePalette.includes("#ff3d6e") ? 0.08 : 0;
  return paletteHot;
}

function resolveWeapon(data: PixelGameDataBundle, job: PixelGameJob | undefined): PixelGameWeaponTuning {
  const startingId = job?.startingWeapon?.id || "";
  const damageType = job?.startingWeapon?.damageType || "";
  const byId = findWeapon(data, startingId);
  if (byId) return byId;
  const byType = data.weapons.find((weapon) => weapon.tags?.includes(damageType) || weapon.kind === damageType);
  if (byType) return byType;
  return data.weapons[0] || {
    id: "sparkle_mic",
    name: "星屑麦克风",
    kind: "projectile",
    damage: 14,
    cooldown_ms: 620,
    range: 300,
    color: "#44f5ff",
    tags: ["sound"],
    aliases: []
  };
}

function findWeapon(data: PixelGameDataBundle, weaponId: string) {
  const id = cleanId(weaponId);
  if (!id) return undefined;
  return data.weapons.find((weapon) => weapon.id === id || weapon.aliases?.includes(id));
}

function enemySpawnWeight(enemy: PixelGameEnemyTuning, engine: EngineState) {
  let weight = Number(enemy.spawn_weight ?? enemy.spawnWeight ?? 1);
  if (engine.director.preferredFamilies.includes(enemy.family || "")) weight *= 1.35;
  if (enemy.archetype === "elite") weight *= clamp(engine.director.eliteRate, 0.65, 1.8);
  if (engine.director.preferredEventTags.includes("playful_swarm") && enemy.archetype !== "elite") weight *= 1.18;
  if (engine.director.preferredEventTags.includes("target_mark") && enemy.archetype === "elite") weight *= 1.22;
  return Math.max(0.1, weight);
}

function nearestEnemy(engine: EngineState, range: number) {
  return nearestEnemyFrom(engine, engine.x, engine.y, range);
}

function nearestEnemyFrom(engine: EngineState, x: number, y: number, range: number, excluded: Set<string> = new Set()) {
  let best: Enemy | null = null;
  let bestDistance = range;
  for (const enemy of engine.enemies) {
    if (excluded.has(enemy.id)) continue;
    const dist = distance(x, y, enemy.x, enemy.y);
    if (dist < bestDistance) {
      best = enemy;
      bestDistance = dist;
    }
  }
  return best;
}

function shouldCrit(engine: EngineState, enemy: Enemy) {
  let chance = 0.04;
  if (engine.upgradeIds.includes("blade_afterimage")) chance += 0.07;
  if (engine.upgradeIds.includes("frequency_lock")) chance += enemy.boss ? 0.05 : 0.08;
  if (engine.specializationId === "neon_samurai") chance += distance(engine.x, engine.y, enemy.x, enemy.y) < 130 ? 0.18 : 0.05;
  if (engine.specializationId === "stream_hacker" && (enemy.typeId.includes("glitch") || enemy.score >= 80)) chance += 0.1;
  return engine.rng() < chance;
}

function dropBonusGem(engine: EngineState, x: number, y: number, xp: number, color: string) {
  engine.gems.push({
    id: `gem-${Date.now()}-${Math.floor(engine.rng() * 999999)}`,
    x: clamp(x, 20, engine.worldWidth - 20),
    y: clamp(y, 20, engine.worldHeight - 20),
    xp: Math.max(1, Math.round(xp)),
    color
  });
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.map(cleanId).filter(Boolean))];
}

function cleanId(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 48);
}

function angleDelta(a: number, b: number) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

function lerpAngle(a: number, b: number, t: number) {
  return a + angleDelta(a, b) * clamp(t, 0, 1);
}

function movementVector(controls: Controls) {
  let x = controls.stickX;
  let y = controls.stickY;
  if (controls.keyboard.left) x -= 1;
  if (controls.keyboard.right) x += 1;
  if (controls.keyboard.up) y -= 1;
  if (controls.keyboard.down) y += 1;
  const length = Math.hypot(x, y);
  if (!length) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

function snapshotFromEngine(engine: EngineState): PixelGameSnapshot {
  return {
    status: engine.finished ? "finished" : engine.awaitingClass ? "class_select" : engine.awaitingUpgrade ? "upgrade" : "running",
    hp: Math.max(0, Math.ceil(engine.hp)),
    maxHp: Math.ceil(engine.maxHp),
    level: engine.level,
    xp: Math.floor(engine.xp),
    xpToNext: Math.floor(engine.xpToNext),
    score: Math.floor(engine.score),
    kills: engine.kills,
    elapsedSeconds: Math.floor(engine.elapsed),
    remainingSeconds: Math.max(0, maxRunSeconds - Math.floor(engine.elapsed)),
    wavesCleared: engine.bossResult === "defeated" || engine.elapsed >= maxRunSeconds ? 15 : Math.min(15, Math.floor(engine.elapsed / 60)),
    enemies: engine.enemies.length,
    projectiles: engine.projectiles.length + engine.zones.length + engine.turrets.length,
    chosenClassId: engine.classId,
    specializationId: engine.specializationId,
    upgradeIds: [...engine.upgradeIds],
    shield: engine.shield,
    bossResult: engine.bossResult
  };
}

function drawEngine(
  PIXI: PixiModule,
  app: PixiApplication,
  graphics: { bg: PixiGraphics; actors: PixiGraphics; fx: PixiGraphics },
  visualRenderer: PixelGameVisualRenderer | null,
  engine: EngineState
) {
  const width = app.renderer.width / app.renderer.resolution;
  const height = app.renderer.height / app.renderer.resolution;
  const palette = engine.biomePalette;
  const bg = graphics.bg;
  const actors = graphics.actors;
  const fx = graphics.fx;
  bg.clear();
  actors.clear();
  fx.clear();

  bg.beginFill(PIXI.utils.string2hex(palette[0] || "#071226"), 1);
  bg.drawRect(0, 0, width, height);
  bg.endFill();

  const camX = engine.x - width / 2;
  const camY = engine.y - height / 2;
  const visualResult = visualRenderer?.render(engine, { x: camX, y: camY }) || null;
  const grid = 42;
  bg.lineStyle(1, PIXI.utils.string2hex(palette[1] || "#44f5ff"), 0.14);
  for (let x = -((camX % grid) + grid); x < width + grid; x += grid) bg.moveTo(x, 0).lineTo(x, height);
  for (let y = -((camY % grid) + grid); y < height + grid; y += grid) bg.moveTo(0, y).lineTo(width, y);
  bg.lineStyle(2, PIXI.utils.string2hex(palette[2] || "#ff4fd8"), 0.26);
  bg.drawRect(-camX, -camY, engine.worldWidth, engine.worldHeight);

  for (const gem of engine.gems) {
    if (visualResult?.gems.has(gem.id)) continue;
    const x = gem.x - camX;
    const y = gem.y - camY;
    actors.beginFill(PIXI.utils.string2hex(gem.color), 0.9);
    actors.drawPolygon([x, y - 5, x + 5, y, x, y + 5, x - 5, y]);
    actors.endFill();
  }

  for (const projectile of engine.projectiles) {
    if (visualResult?.projectiles.has(projectile.id)) continue;
    actors.beginFill(PIXI.utils.string2hex(projectile.color), 1);
    actors.drawRect(projectile.x - camX - 3, projectile.y - camY - 3, 6, 6);
    actors.endFill();
  }

  for (const enemy of engine.enemies) {
    const x = enemy.x - camX;
    const y = enemy.y - camY;
    const enemyRendered = visualResult?.enemies.has(enemy.id) || false;
    if (!enemyRendered) {
      actors.beginFill(PIXI.utils.string2hex(enemy.color), enemy.boss ? 0.98 : 0.86);
      if (enemy.boss) {
        actors.drawRoundedRect(x - enemy.size, y - enemy.size, enemy.size * 2, enemy.size * 2, 6);
        actors.endFill();
      } else {
        actors.drawRect(x - enemy.size / 2, y - enemy.size / 2, enemy.size, enemy.size);
        actors.endFill();
      }
    }
    if (enemy.boss) {
      actors.lineStyle(3, PIXI.utils.string2hex(palette[3] || "#ffe66d"), 0.8);
      actors.drawCircle(x, y, enemy.size + 7 + Math.sin(engine.elapsed * 4) * 2);
      actors.lineStyle(0);
    }
    const hpRatio = clamp(enemy.hp / enemy.maxHp, 0, 1);
    actors.beginFill(0x111827, 0.72);
    actors.drawRect(x - enemy.size, y - enemy.size - 9, enemy.size * 2, 3);
    actors.endFill();
    actors.beginFill(PIXI.utils.string2hex(palette[3] || "#ffe66d"), 0.95);
    actors.drawRect(x - enemy.size, y - enemy.size - 9, enemy.size * 2 * hpRatio, 3);
    actors.endFill();
  }

  const px = engine.x - camX;
  const py = engine.y - camY;
  fx.beginFill(PIXI.utils.string2hex(palette[1] || "#44f5ff"), 0.14);
  fx.drawCircle(px, py, engine.pickupRange);
  fx.endFill();
  if (engine.shield > 0) {
    fx.lineStyle(3, PIXI.utils.string2hex(palette[3] || "#ffe66d"), 0.72);
    fx.drawCircle(px, py, 28 + Math.sin(engine.elapsed * 8) * 2);
    fx.lineStyle(0);
  }
  for (const zone of engine.zones) {
    const x = zone.x - camX;
    const y = zone.y - camY;
    const alpha = clamp(zone.life / 3.6, 0.12, 0.5);
    const color = PIXI.utils.string2hex(zone.color);
    fx.beginFill(color, alpha * 0.14);
    fx.drawCircle(x, y, zone.radius);
    fx.endFill();
    fx.lineStyle(zone.pulse ? 2 : 3, color, alpha);
    fx.drawCircle(x, y, zone.radius * (0.92 + Math.sin(engine.elapsed * 7) * 0.04));
    fx.lineStyle(0);
  }
  for (const turret of engine.turrets) {
    const x = turret.x - camX;
    const y = turret.y - camY;
    actors.beginFill(PIXI.utils.string2hex(turret.color), 0.92);
    actors.drawRect(x - 8, y - 8, 16, 16);
    actors.endFill();
    actors.lineStyle(1, PIXI.utils.string2hex(palette[1] || "#44f5ff"), 0.4);
    actors.drawCircle(x, y, 18 + Math.sin(engine.elapsed * 5) * 2);
    actors.lineStyle(0);
  }
  for (const effect of engine.effects) {
    const x = effect.x - camX;
    const y = effect.y - camY;
    const progress = clamp(effect.age / Math.max(0.001, effect.duration), 0, 1);
    const alpha = (1 - progress) * (effect.kind === "kill" ? 0.78 : 0.55);
    const color = PIXI.utils.string2hex(effect.color);
    const radius = effect.size * (0.3 + progress * (effect.kind === "kill" ? 1.15 : 0.75));
    fx.beginFill(color, alpha * 0.12);
    fx.drawCircle(x, y, radius);
    fx.endFill();
    fx.lineStyle(Math.max(1, 4 * (1 - progress)), color, alpha);
    fx.drawCircle(x, y, radius);
    if (effect.kind === "kill") {
      const line = radius * 0.72;
      fx.moveTo(x - line, y).lineTo(x + line, y);
      fx.moveTo(x, y - line).lineTo(x, y + line);
    }
    fx.lineStyle(0);
  }
  if (!visualResult?.hoshia) drawPixelHoshia(actors, PIXI, px, py, palette, engine.hurtCooldown > 0);
}

function drawPixelHoshia(g: PixiGraphics, PIXI: PixiModule, x: number, y: number, palette: string[], hurt: boolean) {
  const outline = hurt ? 0xffffff : 0x101827;
  g.beginFill(outline, 0.95);
  g.drawRect(x - 13, y - 19, 26, 36);
  g.endFill();
  g.beginFill(PIXI.utils.string2hex(palette[2] || "#ff4fd8"), 1);
  g.drawRect(x - 10, y - 16, 20, 9);
  g.drawRect(x - 12, y - 7, 24, 16);
  g.endFill();
  g.beginFill(0xffe6ef, 1);
  g.drawRect(x - 7, y - 10, 14, 13);
  g.endFill();
  g.beginFill(0x172033, 1);
  g.drawRect(x - 5, y - 5, 3, 3);
  g.drawRect(x + 3, y - 5, 3, 3);
  g.endFill();
  g.beginFill(PIXI.utils.string2hex(palette[1] || "#44f5ff"), 1);
  g.drawRect(x - 16, y - 24, 9, 9);
  g.drawRect(x + 7, y - 24, 9, 9);
  g.drawRect(x - 4, y + 9, 8, 12);
  g.endFill();
  g.beginFill(PIXI.utils.string2hex(palette[3] || "#ffe66d"), 0.95);
  g.drawRect(x - 2, y + 2, 4, 2);
  g.endFill();
}

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}

function normalizeKey(key: string) {
  const lowered = key.toLowerCase();
  if (lowered === "w" || key === "ArrowUp") return "up";
  if (lowered === "s" || key === "ArrowDown") return "down";
  if (lowered === "a" || key === "ArrowLeft") return "left";
  if (lowered === "d" || key === "ArrowRight") return "right";
  return "";
}

function makeRng(seedText: string) {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}
