import type {
  PixelGameBiome,
  PixelGameBossTuning,
  PixelGameDataBundle,
  PixelGameEnemyTuning,
  PixelGameJob,
  PixelGameUpgradeOption,
  PixelGameVisualManifest,
  PixelGameWaveRule
} from "../types";

const baseUrl = import.meta.env.BASE_URL || "/";

export function gameAssetPath(path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(gameAssetPath(`assets/game/${path}`), { cache: "no-cache" });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function loadPixelGameData(): Promise<PixelGameDataBundle> {
  const [jobsRaw, upgradesRaw, enemiesRaw, bossesRaw, biomesRaw, wavesRaw, visualsRaw] = await Promise.all([
    loadJson<{ jobs?: PixelGameJob[] }>("data/jobs.v1.json"),
    loadJson<{ upgradePool?: PixelGameUpgradeOption[]; jobExclusiveUpgrades?: PixelGameUpgradeOption[] }>("data/upgrades.v1.json"),
    loadJson<{ enemies?: PixelGameEnemyTuning[] }>("data/enemies.v1.json"),
    loadJson<{ bosses?: PixelGameBossTuning[] }>("data/bosses.v1.json"),
    loadJson<{ biomes?: PixelGameBiome[] }>("data/biomes.v1.json"),
    loadJson<{ waves?: PixelGameWaveRule[] }>("data/waves.v1.json"),
    loadJson<PixelGameVisualManifest>("visuals.v1.json")
  ]);

  const jobs = normalizeJobs(jobsRaw?.jobs);
  const upgrades = normalizeUpgrades([
    ...(upgradesRaw?.upgradePool || []),
    ...(upgradesRaw?.jobExclusiveUpgrades || [])
  ]);
  const enemies = normalizeEnemies(enemiesRaw?.enemies);
  const bosses = normalizeBosses(bossesRaw?.bosses);
  const biomes = normalizeBiomes(biomesRaw?.biomes);
  const waves = normalizeWaves(wavesRaw?.waves);
  const loadedCount = [jobsRaw, upgradesRaw, enemiesRaw, bossesRaw, biomesRaw, wavesRaw].filter(Boolean).length;

  return {
    jobs,
    upgrades,
    enemies,
    bosses,
    biomes,
    waves,
    visuals: normalizeVisuals(visualsRaw),
    source: loadedCount === 6 ? "assets" : loadedCount === 0 ? "fallback" : "mixed"
  };
}

function normalizeVisuals(item: PixelGameVisualManifest | null): PixelGameVisualManifest | null {
  if (!item || item.schemaVersion !== 1 || item.kind !== "visuals") return null;
  if (!Array.isArray(item.atlases) || !item.atlases.length || !item.entities) return null;
  return {
    ...item,
    assetBase: item.assetBase || "assets/game/",
    atlases: item.atlases.filter((atlas) => atlas?.id && atlas.image && atlas.data),
    entities: {
      ...item.entities,
      jobs: item.entities.jobs || {},
      starterWeapons: item.entities.starterWeapons || {},
      weapons: item.entities.weapons || {},
      enemies: item.entities.enemies || {},
      bosses: item.entities.bosses || {},
      biomes: item.entities.biomes || {},
      drops: item.entities.drops || {},
      effects: item.entities.effects || {}
    }
  };
}

function normalizeJobs(items: PixelGameJob[] | undefined): PixelGameJob[] {
  const jobs = Array.isArray(items) && items.length ? items : fallbackJobs;
  return jobs.map((job) => ({
    ...job,
    id: cleanId(job.id) || "star_idol",
    name: String(job.name || job.id || "Pixel option"),
    baseStats: {
      maxHp: Number(job.baseStats?.maxHp || 96),
      speed: Number(job.baseStats?.speed || 1),
      attack: Number(job.baseStats?.attack || 1),
      cooldown: Number(job.baseStats?.cooldown || 1),
      pickup: Number(job.baseStats?.pickup || 1),
      luck: Number(job.baseStats?.luck || 1)
    },
    upgradeTags: Array.isArray(job.upgradeTags) ? job.upgradeTags.map(cleanId).filter(Boolean) : []
  }));
}

function normalizeUpgrades(items: PixelGameUpgradeOption[] | undefined): PixelGameUpgradeOption[] {
  const upgrades = Array.isArray(items) && items.length ? items : fallbackUpgrades;
  return upgrades.map((upgrade) => ({
    ...upgrade,
    id: cleanId(upgrade.id) || `upgrade_${Math.random().toString(36).slice(2, 8)}`,
    name: String(upgrade.name || upgrade.title || upgrade.id || "Pixel option"),
    title: upgrade.title || upgrade.name,
    description: upgrade.description || upgrade.effect || upgrade.flavor || "Upgrade the Hoshia pixel avatar.",
    rarity: upgrade.rarity || "common",
    maxRank: Number(upgrade.maxRank || 1),
    tags: Array.isArray(upgrade.tags) ? upgrade.tags.map(cleanId).filter(Boolean) : []
  }));
}

function normalizeEnemies(items: PixelGameEnemyTuning[] | undefined): PixelGameEnemyTuning[] {
  const enemies = Array.isArray(items) && items.length ? items : fallbackEnemies;
  return enemies.map((enemy) => ({
    ...enemy,
    id: cleanId(enemy.id) || "noise_slime",
    hp: Number(enemy.hp || 12),
    speed: Number(enemy.speed || 54),
    damage: Number(enemy.damage || 8),
    xp: Number(enemy.xp || 1),
    score: Number(enemy.score || 8),
    spawn_weight: Number(enemy.spawn_weight ?? enemy.spawnWeight ?? 3),
    color: enemy.color || "#44f5ff",
    size: Number(enemy.size || 12)
  }));
}

function normalizeBosses(items: PixelGameBossTuning[] | undefined): PixelGameBossTuning[] {
  const bosses = Array.isArray(items) && items.length ? items : fallbackBosses;
  return bosses.map((boss) => ({
    ...boss,
    id: cleanId(boss.id) || "boss_signal_hydra",
    hp: Number(boss.hp || 1800),
    speed: Number(boss.speed || 35),
    damage: Number(boss.damage || 20),
    spawn_minute: Number(boss.spawn_minute || 15),
    color: boss.color || "#ff4fd8"
  }));
}

function normalizeBiomes(items: PixelGameBiome[] | undefined): PixelGameBiome[] {
  const biomes = Array.isArray(items) && items.length ? items : fallbackBiomes;
  return biomes.map((biome) => ({
    ...biome,
    id: cleanId(biome.id) || "neon_radio_rooftop",
    palette: Array.isArray(biome.palette) && biome.palette.length >= 2 ? biome.palette : ["#071226", "#21f3ff", "#ff4fd8", "#ffe66d"],
    enemy_families: Array.isArray(biome.enemy_families) ? biome.enemy_families.map(cleanId).filter(Boolean) : [],
    boss_id: cleanId(biome.boss_id) || "boss_signal_hydra"
  }));
}

function normalizeWaves(items: PixelGameWaveRule[] | undefined): PixelGameWaveRule[] {
  const waves = Array.isArray(items) && items.length ? items : fallbackWaves;
  return waves.map((wave) => ({
    minute: Math.max(0, Number(wave.minute || 0)),
    spawn_rate: Math.max(0.4, Number(wave.spawn_rate || 1)),
    families: Array.isArray(wave.families) ? wave.families.map(cleanId).filter(Boolean) : [],
    boss: Boolean(wave.boss)
  })).sort((a, b) => a.minute - b.minute);
}

function cleanId(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 48);
}

const fallbackJobs: PixelGameJob[] = [
  { id: "star_idol", name: "Star Idol", role: "mid-range tempo", tagline: "Clear noise with radio sparks.", baseStats: { maxHp: 90, speed: 1.05, attack: 1, cooldown: 0.95, pickup: 1.15, luck: 1.08 }, upgradeTags: ["sound", "pickup"] },
  { id: "neon_samurai", name: "Neon Samurai", role: "melee burst", tagline: "Slice glitches into pixel rain.", baseStats: { maxHp: 115, speed: 1.08, attack: 1.12, cooldown: 1.02, pickup: 0.92, luck: 0.98 }, upgradeTags: ["blade", "crit"] },
  { id: "stream_hacker", name: "Stream Hacker", role: "ranged chain", tagline: "Rewrite enemy waves into XP.", baseStats: { maxHp: 86, speed: 1.02, attack: 1.08, cooldown: 0.9, pickup: 1.05, luck: 1.02 }, upgradeTags: ["data", "chain"] }
];

const fallbackUpgrades: PixelGameUpgradeOption[] = [
  { id: "spark_amp", name: "Spark Amp", rarity: "common", maxRank: 5, tags: ["damage"], effect: "Increase weapon damage." },
  { id: "neon_step", name: "Neon Step", rarity: "common", maxRank: 4, tags: ["mobility"], effect: "Increase move speed." },
  { id: "pixel_heart", name: "Pixel Heart", rarity: "common", maxRank: 4, tags: ["survival", "recovery"], effect: "Increase max HP and heal." },
  { id: "magnet_tape", name: "Magnet Tape", rarity: "common", maxRank: 5, tags: ["pickup"], effect: "Increase pickup range." },
  { id: "cooldown_dial", name: "Cooldown Dial", rarity: "common", maxRank: 5, tags: ["tempo"], effect: "Reduce attack cooldown." },
  { id: "crt_guard", name: "CRT Guard", rarity: "common", maxRank: 3, tags: ["shield"], effect: "Gain a shield." }
];

const fallbackEnemies: PixelGameEnemyTuning[] = [
  { id: "noise_slime", name: "Noise Slime", family: "noise", hp: 16, speed: 54, damage: 8, xp: 1, score: 8, spawn_weight: 7, color: "#2af7ff", size: 13 },
  { id: "pixel_bat", name: "Pixel Bat", family: "shadow", hp: 10, speed: 88, damage: 7, xp: 1, score: 10, spawn_weight: 4, color: "#a574ff", size: 10 },
  { id: "adware_bug", name: "Adware Bug", family: "glitch", hp: 20, speed: 62, damage: 9, xp: 2, score: 14, spawn_weight: 4, color: "#ff62d0", size: 12 }
];

const fallbackBosses: PixelGameBossTuning[] = [
  { id: "boss_signal_hydra", name: "Signal Hydra", spawn_minute: 15, hp: 2200, damage: 24, speed: 36, color: "#ff4fd8" }
];

const fallbackBiomes: PixelGameBiome[] = [
  { id: "neon_radio_rooftop", name: "Neon Radio Rooftop", activity: "idle", palette: ["#071226", "#21f3ff", "#ff4fd8", "#ffe66d"], enemy_families: ["noise", "drone"], boss_id: "boss_signal_hydra" },
  { id: "ranked_arcade_matrix", name: "Ranked Arcade Matrix", activity: "gaming", palette: ["#100820", "#ff4fd8", "#44f5ff", "#ff8a4c"], enemy_families: ["glitch", "drone"], boss_id: "boss_signal_hydra" }
];

const fallbackWaves: PixelGameWaveRule[] = [
  { minute: 0, spawn_rate: 1, families: ["noise"] },
  { minute: 3, spawn_rate: 1.2, families: ["noise", "shadow"] },
  { minute: 6, spawn_rate: 1.45, families: ["noise", "glitch", "drone"] },
  { minute: 10, spawn_rate: 1.75, families: ["glitch", "drone", "shadow"] },
  { minute: 15, spawn_rate: 2, boss: true }
];
