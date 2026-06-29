import type {
  PixelGameDataBundle,
  PixelGameDirectorActivityRule,
  PixelGameDirectorEventCard,
  PixelGameDirectorMoodRule,
  PixelGameJob,
  PixelGamePublicRun
} from "../types";

export type PixelGameDirectorProfile = {
  moodId: string;
  moodName: string;
  activityId: string;
  activityName: string;
  energy: number;
  socialNeed: number;
  spawnTempo: number;
  eliteRate: number;
  enemyHpMultiplier: number;
  enemySpeedMultiplier: number;
  dropMultiplier: number;
  pickupBias: string[];
  preferredFamilies: string[];
  preferredEventTags: string[];
  eventCard: PixelGameDirectorEventCard | null;
  impactLines: string[];
  reasonLines: string[];
};

export function buildDirectorProfile(
  data: PixelGameDataBundle,
  run: PixelGamePublicRun,
  job?: PixelGameJob
): PixelGameDirectorProfile {
  const moodId = cleanId(run.locked_mood) || "calm";
  const activityId = cleanId(run.locked_activity) || "idle";
  const moodRule = data.directorRules?.hoshiaMoodMap?.find((rule) => cleanId(rule.mood) === moodId) || null;
  const activityRule = data.directorRules?.hoshiaActivityMap?.find((rule) => cleanId(rule.activity) === activityId) || null;
  const biome = data.biomes.find((item) => item.id === run.stage_id) || data.biomes[0];
  const energy = clamp(Number(run.locked_energy ?? 50), 0, 100);
  const socialNeed = clamp(Number(run.locked_social_need ?? 50), 0, 100);
  const energyPressure = (energy - 50) / 100;
  const lonelyPressure = Math.max(0, socialNeed - 58) / 100;
  const moodModifiers = moodRule?.directorModifiers || {};
  const jobTags = job?.hoshiaMapping?.directorTags || [];
  const pickupBias = unique([
    ...(moodModifiers.pickupBias || []),
    ...(job?.upgradeTags || []).filter((tag) => ["pickup", "shield", "recovery", "supply", "summon", "damage", "dash", "chain", "crit"].includes(tag))
  ]);
  const preferredEventTags = unique([
    ...(activityRule?.preferredEventTags || []),
    ...jobTags
  ]);
  const preferredFamilies = unique([
    ...(biome?.enemy_families || []),
    ...familiesForMood(moodId),
    ...familiesForActivity(activityId)
  ]);
  const eventCard = pickEventCard(data, preferredEventTags);
  const spawnTempo = clamp(Number(moodModifiers.spawnTempo || 1) * (1 + energyPressure * 0.18) * (activityId === "game_focus" ? 1.08 : 1), 0.72, 1.42);
  const eliteRate = clamp(Number(moodModifiers.eliteRate || 1) * (1 + Math.max(0, energyPressure) * 0.16) * (activityId === "reading_news" ? 1.08 : 1), 0.68, 1.5);
  const enemyHpMultiplier = clamp(1 + energyPressure * 0.12 + (activityId === "game_focus" ? 0.08 : 0) - (moodId === "sleepy" ? 0.06 : 0), 0.82, 1.34);
  const enemySpeedMultiplier = clamp(1 + energyPressure * 0.10 - (moodId === "sleepy" ? 0.12 : 0) + (moodId === "excited" ? 0.06 : 0), 0.78, 1.28);
  const dropMultiplier = clamp(
    1 +
      (moodId === "cheerful" ? 0.12 : 0) +
      (activityId === "receiving_gift" ? 0.18 : 0) +
      lonelyPressure * 0.2 +
      (socialNeed < 28 ? 0.06 : 0),
    0.88,
    1.42
  );

  return {
    moodId,
    moodName: moodRule?.displayName || labelForMood(moodId),
    activityId,
    activityName: activityRule?.displayName || labelForActivity(activityId),
    energy,
    socialNeed,
    spawnTempo,
    eliteRate,
    enemyHpMultiplier,
    enemySpeedMultiplier,
    dropMultiplier,
    pickupBias,
    preferredFamilies,
    preferredEventTags,
    eventCard,
    impactLines: buildImpactLines(moodRule, activityRule, {
      spawnTempo,
      eliteRate,
      enemyHpMultiplier,
      enemySpeedMultiplier,
      dropMultiplier,
      energy,
      socialNeed,
      eventCard,
      pickupBias
    }),
    reasonLines: buildReasonLines({
      run,
      biomeName: biome?.name || humanizeId(run.stage_id),
      moodName: moodRule?.displayName || labelForMood(moodId),
      activityName: activityRule?.displayName || labelForActivity(activityId),
      eventCard,
      preferredFamilies,
      job
    })
  };
}

function pickEventCard(data: PixelGameDataBundle, preferredTags: string[]) {
  const cards = data.directorRules?.eventCards || [];
  if (!cards.length) return null;
  const preferred = cards.find((card) => card.tags?.some((tag) => preferredTags.includes(tag)));
  return preferred || cards[0];
}

function buildImpactLines(
  moodRule: PixelGameDirectorMoodRule | null,
  activityRule: PixelGameDirectorActivityRule | null,
  stats: {
    spawnTempo: number;
    eliteRate: number;
    enemyHpMultiplier: number;
    enemySpeedMultiplier: number;
    dropMultiplier: number;
    energy: number;
    socialNeed: number;
    eventCard: PixelGameDirectorEventCard | null;
    pickupBias: string[];
  }
) {
  const lines = [
    `Mood channel ${moodRule?.displayName || "默认频道"}: spawn tempo x${stats.spawnTempo.toFixed(2)}, elite pressure x${stats.eliteRate.toFixed(2)}.`,
    `Energy ${Math.round(stats.energy)}: enemy HP x${stats.enemyHpMultiplier.toFixed(2)} and speed x${stats.enemySpeedMultiplier.toFixed(2)}.`,
    `Social need ${Math.round(stats.socialNeed)}: drop flow x${stats.dropMultiplier.toFixed(2)}${stats.pickupBias.length ? `, bias ${stats.pickupBias.slice(0, 3).join("/")}` : ""}.`
  ];
  if (activityRule?.directorShift) lines.push(`Activity ${activityRule.displayName || activityRule.activity}: ${activityRule.directorShift}`);
  if (stats.eventCard) lines.push(`Special event tendency: ${stats.eventCard.name || stats.eventCard.id} - ${stats.eventCard.effect || "changes wave rhythm."}`);
  return lines;
}

function buildReasonLines(input: {
  run: PixelGamePublicRun;
  biomeName: string;
  moodName: string;
  activityName: string;
  eventCard: PixelGameDirectorEventCard | null;
  preferredFamilies: string[];
  job?: PixelGameJob;
}) {
  const lines = [
    `${input.biomeName} was selected by the locked activity/mood signal.`,
    `The run used ${input.moodName} + ${input.activityName}, so enemy families leaned toward ${input.preferredFamilies.slice(0, 4).join("/") || "the biome default"}.`
  ];
  if (input.job?.startingWeapon?.name) lines.push(`${input.job.name} entered with ${input.job.startingWeapon.name}; weapon behavior comes from weapons.v1.json.`);
  if (input.eventCard) lines.push(`Director event seed favored ${input.eventCard.name || input.eventCard.id}.`);
  return lines;
}

function familiesForMood(mood: string) {
  if (mood === "mischievous") return ["glitch", "shadow"];
  if (mood === "worried") return ["noise", "drone"];
  if (mood === "excited") return ["glitch", "drone"];
  if (mood === "sleepy" || mood === "lonely") return ["shadow", "noise"];
  if (mood === "focused") return ["drone", "glitch"];
  if (mood === "cheerful") return ["noise", "fan_signal"];
  return ["noise"];
}

function familiesForActivity(activity: string) {
  if (activity === "reading_news" || activity === "game_focus") return ["glitch", "drone"];
  if (activity === "receiving_gift" || activity === "chatting") return ["fan_signal", "noise"];
  if (activity === "singing" || activity === "listening_music") return ["noise", "drone"];
  if (activity === "live2d_pose" || activity === "tts_active") return ["shadow", "noise"];
  return [];
}

function labelForMood(mood: string) {
  const labels: Record<string, string> = {
    calm: "平静电台",
    cheerful: "元气应援",
    excited: "高能过载",
    sleepy: "梦游频道",
    focused: "专注锁频",
    worried: "护航警报",
    mischievous: "坏笑乱码",
    lonely: "月面回声"
  };
  return labels[mood] || humanizeId(mood);
}

function labelForActivity(activity: string) {
  const labels: Record<string, string> = {
    idle: "待机巡房",
    chatting: "聊天互动",
    singing: "唱歌中",
    listening_music: "听歌中",
    reading_news: "读新闻",
    receiving_gift: "收到礼物",
    live2d_pose: "Live2D 表演",
    tts_active: "语音播报",
    game_focus: "专心游玩"
  };
  return labels[activity] || humanizeId(activity);
}

function unique(items: string[]) {
  return [...new Set(items.map(cleanId).filter(Boolean))];
}

function cleanId(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 48);
}

function humanizeId(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
