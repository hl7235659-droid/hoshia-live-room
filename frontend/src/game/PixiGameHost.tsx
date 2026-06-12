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
  PixelGameWaveRule
} from "../types";
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
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  life: number;
  size: number;
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
  attackTimer: number;
  spawnTimer: number;
  shieldTimer: number;
  hurtCooldown: number;
  rng: () => number;
  biomePalette: string[];
  biomeFamilies: string[];
  bossId: string;
  bossSpawnSecond: number;
  enemies: Enemy[];
  projectiles: Projectile[];
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
    applySpecialization(engine, pick.job);
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
    attackTimer: 0,
    spawnTimer: 0,
    shieldTimer: 0,
    hurtCooldown: 0,
    rng: makeRng(`${run.seed || run.run_id}:${run.class_id}`),
    biomePalette: biome?.palette || ["#071226", "#21f3ff", "#ff4fd8", "#ffe66d"],
    biomeFamilies: biome?.enemy_families || [],
    bossId,
    bossSpawnSecond: bossSpawnSecond(data, bossId),
    enemies: [],
    projectiles: [],
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

  if (engine.shieldTimer >= 28 && engine.shield < 3) {
    engine.shieldTimer = 0;
    if (engine.upgradeIds.includes("crt_guard") || engine.upgradeIds.includes("repair_drone")) engine.shield += 1;
  }

  const input = movementVector(controls);
  engine.x = clamp(engine.x + input.x * engine.speed * dt, 40, engine.worldWidth - 40);
  engine.y = clamp(engine.y + input.y * engine.speed * dt, 40, engine.worldHeight - 40);

  spawnEnemies(engine, props.data, dt);
  autoAttack(engine);
  updateProjectiles(engine, dt);
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
  const interval = clamp(0.72 / (wave.spawn_rate || 1) / difficulty, 0.16, 0.9);
  const maxAlive = Math.floor(34 + engine.elapsed / 18);
  if (engine.enemies.length >= maxAlive) return;
  if (engine.spawnTimer > 0) return;
  engine.spawnTimer = interval;
  const batch = engine.elapsed > 420 ? 2 : engine.elapsed > 180 ? 1 + (engine.rng() > 0.55 ? 1 : 0) : 1;
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
  engine.enemies.push({
    id: `boss-${Date.now()}`,
    typeId: boss.id,
    x: clamp(engine.x + Math.cos(angle) * 430, 70, engine.worldWidth - 70),
    y: clamp(engine.y + Math.sin(angle) * 320, 70, engine.worldHeight - 70),
    hp: boss.hp,
    maxHp: boss.hp,
    speed: boss.speed,
    damage: boss.damage,
    xp: 70,
    score: 2600,
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
  const families = wave.families?.length ? wave.families : engine.biomeFamilies;
  const pool = enemies.filter((enemy) => !families.length || families.includes(enemy.family || ""));
  const candidates = pool.length ? pool : enemies;
  const total = candidates.reduce((sum, enemy) => sum + Number(enemy.spawn_weight ?? enemy.spawnWeight ?? 1), 0) || 1;
  let cursor = engine.rng() * total;
  for (const enemy of candidates) {
    cursor -= Number(enemy.spawn_weight ?? enemy.spawnWeight ?? 1);
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
  const hpScale = 0.8 + difficulty * 0.48;
  return {
    id: `enemy-${Date.now()}-${Math.floor(engine.rng() * 100000)}`,
    typeId: template.id,
    x: clamp(x, 24, engine.worldWidth - 24),
    y: clamp(y, 24, engine.worldHeight - 24),
    hp: Math.max(4, template.hp * hpScale),
    maxHp: Math.max(4, template.hp * hpScale),
    speed: template.speed * (0.88 + difficulty * 0.08),
    damage: template.damage * (0.86 + difficulty * 0.08),
    xp: template.xp,
    score: template.score,
    size: template.size || 12,
    color: template.color || "#44f5ff",
    phase: engine.rng() * 10
  };
}

function autoAttack(engine: EngineState) {
  if (engine.attackTimer > 0) return;
  const target = nearestEnemy(engine, 360);
  if (!target) return;
  engine.attackTimer = Math.max(140, engine.cooldownMs);
  const baseAngle = Math.atan2(target.y - engine.y, target.x - engine.x);
  const count = Math.max(1, Math.min(6, Math.floor(engine.projectileCount)));
  for (let index = 0; index < count; index += 1) {
    const spread = (index - (count - 1) / 2) * 0.16;
    const angle = baseAngle + spread;
    engine.projectiles.push({
      id: `shot-${Date.now()}-${index}-${Math.floor(engine.rng() * 9999)}`,
      x: engine.x,
      y: engine.y,
      vx: Math.cos(angle) * engine.projectileSpeed,
      vy: Math.sin(angle) * engine.projectileSpeed,
      damage: 18 * engine.damageMultiplier,
      life: 1.15,
      size: 5,
      color: engine.biomePalette[1] || "#44f5ff"
    });
  }
}

function updateProjectiles(engine: EngineState, dt: number) {
  for (const projectile of engine.projectiles) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.life -= dt;
  }
  for (const projectile of engine.projectiles) {
    if (projectile.life <= 0) continue;
    for (const enemy of engine.enemies) {
      if (enemy.hp <= 0) continue;
      if (distance(projectile.x, projectile.y, enemy.x, enemy.y) > enemy.size + projectile.size) continue;
      const willKill = enemy.hp - projectile.damage <= 0;
      enemy.hp -= projectile.damage;
      projectile.life = 0;
      pushNeonEffect(engine, {
        kind: "hit",
        x: projectile.x,
        y: projectile.y,
        duration: willKill ? 0.16 : 0.22,
        color: projectile.color || enemy.color,
        size: Math.max(18, enemy.size * (enemy.boss ? 1.2 : 1.8)),
        targetTypeId: enemy.typeId,
        boss: Boolean(enemy.boss)
      });
      if (enemy.hp <= 0) killEnemy(engine, enemy);
      break;
    }
  }
  engine.projectiles = engine.projectiles.filter((projectile) => projectile.life > 0 && projectile.x > -80 && projectile.x < engine.worldWidth + 80 && projectile.y > -80 && projectile.y < engine.worldHeight + 80);
  engine.enemies = engine.enemies.filter((enemy) => enemy.hp > 0);
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
  const gems = enemy.boss ? 12 : enemy.xp >= 6 ? 3 : 1;
  for (let index = 0; index < gems; index += 1) {
    engine.gems.push({
      id: `gem-${Date.now()}-${index}-${Math.floor(engine.rng() * 999)}`,
      x: enemy.x + (engine.rng() - 0.5) * enemy.size * 2,
      y: enemy.y + (engine.rng() - 0.5) * enemy.size * 2,
      xp: Math.max(1, Math.ceil(enemy.xp / gems)),
      color: enemy.boss ? "#ffe66d" : "#7cffc4"
    });
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
}

function applySpecialization(engine: EngineState, job: PixelGameJob) {
  engine.specializationId = job.id;
  const stats = job.baseStats || {};
  engine.damageMultiplier *= 1 + (Number(stats.attack || 1) - 1) * 0.7;
  engine.speed *= 1 + (Number(stats.speed || 1) - 1) * 0.55;
  engine.cooldownMs *= 1 + (Number(stats.cooldown || 1) - 1) * 0.55;
  engine.pickupRange *= 1 + (Number(stats.pickup || 1) - 1) * 0.55;
  engine.maxHp += Math.max(0, Math.floor((Number(stats.maxHp || 96) - 96) * 0.35));
  engine.hp = Math.min(engine.maxHp, engine.hp + 30);
  engine.score += 250;
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
    const index = weightedPickIndex(weighted, rng);
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

function weightedPickIndex(upgrades: PixelGameUpgradeOption[], rng: () => number) {
  const total = upgrades.reduce((sum, item) => sum + rarityWeight(item.rarity), 0) || 1;
  let cursor = rng() * total;
  for (let index = 0; index < upgrades.length; index += 1) {
    cursor -= rarityWeight(upgrades[index].rarity);
    if (cursor <= 0) return index;
  }
  return 0;
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

function nearestEnemy(engine: EngineState, range: number) {
  let best: Enemy | null = null;
  let bestDistance = range;
  for (const enemy of engine.enemies) {
    const dist = distance(engine.x, engine.y, enemy.x, enemy.y);
    if (dist < bestDistance) {
      best = enemy;
      bestDistance = dist;
    }
  }
  return best;
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
    projectiles: engine.projectiles.length,
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
