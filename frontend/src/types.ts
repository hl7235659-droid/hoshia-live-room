export type RoomInfo = {
  room_id: string;
  online: number;
  registered?: number;
  private: boolean;
  websocket_auth: boolean;
};

export type LiveMessage = {
  type: string;
  id: string;
  role: "user" | "ai" | "system";
  user_id?: string;
  nickname?: string;
  color?: string;
  danmaku_lane?: number;
  danmaku_speed?: number;
  text: string;
  timestamp: string;
  latency_trace_id?: string;
  route?: string;
  pending?: boolean;
  stream_started?: boolean;
  delta_mode?: "append" | "replace";
  stage?: string;
};

export type Session = {
  user_id: string;
  username?: string;
  nickname: string;
  avatar_url?: string;
  danmaku_color?: string;
  room_id: string;
  onboarding_completed?: boolean;
  ai_profile?: AiProfile | null;
};

export type MusicTrack = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  cover?: string;
  duration?: number;
  source?: string;
  requested_by?: string;
  requested_by_id?: string;
  requested_at?: string;
  stream_url: string;
};

export type MusicState = {
  ok: boolean;
  enabled: boolean;
  provider: string;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  current: MusicTrack | null;
  queue: MusicTrack[];
  last_error?: string;
  can_control: boolean;
  can_previous?: boolean;
  timestamp?: string;
};

export type HoshiaVisualState = {
  character_id: string;
  mood: string;
  activity: string;
  energy: number;
  social_need: number;
  current_png: string;
  visual_description?: string;
  state_reason: string;
  updated_at: string;
};

export type HoshiaPostInteraction = {
  id: string;
  post_id: string;
  user_id: string;
  nickname: string;
  type: "comment" | "reply" | "like";
  content: string;
  parent_interaction_id: string;
  reply_status?: string;
  reply_due_at?: string;
  replied_at?: string;
  created_at: string;
};

export type HoshiaPost = {
  id: string;
  character_id: string;
  content: string;
  image_url: string;
  mood: string;
  activity: string;
  source_type: string;
  created_at: string;
  updated_at: string;
  like_count: number;
  comment_count: number;
  liked_by_viewer: boolean;
  interactions: HoshiaPostInteraction[];
};

export type AiProfile = {
  preferred_name: string;
  reply_style: "friend" | "teasing_friend" | "cool" | "custom";
  reply_style_text: string;
  interests: string;
  memory_enabled: boolean;
};

export type AudienceUser = {
  user_id: string;
  username?: string;
  nickname: string;
  avatar_url?: string;
  danmaku_color?: string;
  online: boolean;
  registered_at: string;
  last_login_at?: string | null;
  total_online_seconds: number;
  current_online_seconds: number;
};

export type AudiencePayload = {
  ok: boolean;
  online_count: number;
  registered_count: number;
  users: AudienceUser[];
};

export const characterStates = ["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"] as const;

export type CharacterState = (typeof characterStates)[number];

export function toCharacterState(value: unknown): CharacterState {
  return characterStates.includes(value as CharacterState) ? (value as CharacterState) : "IDLE";
}

export const hoshiaPresentationActions = [
  "idle",
  "listen",
  "think",
  "speak",
  "react_positive",
  "react_negative",
  "react_surprised",
  "recover"
] as const;

export type HoshiaPresentationAction = (typeof hoshiaPresentationActions)[number];

export type HoshiaPresentation = {
  version?: 1;
  action: HoshiaPresentationAction;
  intensity?: "low" | "normal" | "high";
  duration_ms?: number;
  label?: string;
  expression?: string;
  motion?: string;
  fallback_state?: CharacterState;
  fallback_png?: string;
  cue?: string;
  current_png?: string;
  source?: "ai_reply" | "character_state" | "hoshia_state" | "system";
  trace_id?: string;
  reason?: string;
  timestamp?: string;
  updated_at?: string;
};

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown) {
  return value === undefined || typeof value === "number";
}

export function isHoshiaPresentation(value: unknown): value is HoshiaPresentation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return hoshiaPresentationActions.includes(candidate.action as HoshiaPresentationAction) &&
    optionalNumber(candidate.duration_ms) &&
    optionalString(candidate.label) &&
    optionalString(candidate.expression) &&
    optionalString(candidate.motion) &&
    optionalString(candidate.fallback_state) &&
    optionalString(candidate.fallback_png) &&
    optionalString(candidate.cue) &&
    optionalString(candidate.current_png) &&
    optionalString(candidate.source) &&
    optionalString(candidate.trace_id) &&
    optionalString(candidate.reason) &&
    optionalString(candidate.timestamp) &&
    optionalString(candidate.updated_at);
}

export type PixelGameRunStatus = "active" | "finished" | "abandoned" | "expired";
export type PixelGameRunResult = "active" | "cleared" | "defeated" | "timeout" | "abandoned" | "expired" | "finished";
export type PixelGameBossResult = "not_reached" | "failed" | "defeated";
export type PixelGameScoreTier = "" | "C" | "B" | "A" | "S";

export type PixelGameVector = {
  x: number;
  y: number;
};

export type PixelGameProfile = {
  total_runs: number;
  total_play_seconds: number;
  total_kills: number;
  best_score: number;
  best_level: number;
  best_wave: number;
  boss_defeated_count: number;
  selected_class_id?: string;
};

export type PixelGamePublicRun = {
  id: string;
  run_id: string;
  status: PixelGameRunStatus;
  accepted: boolean;
  class_id: string;
  seed: string;
  stage_id: string;
  difficulty_tier: string;
  locked_activity: string;
  locked_mood: string;
  locked_energy: number;
  locked_social_need: number;
  started_at: string;
  expires_at: string;
  finished_at?: string;
  duration_seconds: number;
  score: number;
  kills: number;
  level: number;
  waves_cleared: number;
  boss_result: PixelGameBossResult;
  result: PixelGameRunResult;
  score_tier: PixelGameScoreTier;
};

export type PixelGameLeaderboardEntry = {
  run_id: string;
  nickname: string;
  class_id: string;
  stage_id: string;
  difficulty_tier: string;
  score: number;
  kills: number;
  level: number;
  waves_cleared: number;
  boss_result: PixelGameBossResult;
  result: PixelGameRunResult;
  score_tier: PixelGameScoreTier;
  duration_seconds: number;
  finished_at: string;
};

export type PixelGameStatePayload = {
  ok: boolean;
  enabled: boolean;
  profile: PixelGameProfile | null;
  unlocked_classes: string[];
  active_run: PixelGamePublicRun | null;
  leaderboard: PixelGameLeaderboardEntry[];
  rules?: {
    duration_seconds?: number;
    class_ids?: string[];
  };
};

export type PixelGameRunStartResponse = {
  ok: boolean;
  resumed?: boolean;
  error?: string;
  run?: PixelGamePublicRun;
  visual_state?: {
    activity: string;
    mood: string;
    energy: number;
    social_need: number;
  };
};

export type PixelGameFinishPayload = {
  duration_seconds: number;
  score: number;
  kills: number;
  level: number;
  waves_cleared: number;
  boss_result: PixelGameBossResult;
  result: Exclude<PixelGameRunResult, "active" | "expired">;
  upgrade_ids?: string[];
  specialization_id?: string;
};

export type PixelGameFinishResponse = {
  ok: boolean;
  accepted?: boolean;
  suspicious?: boolean;
  reason?: string;
  already_finished?: boolean;
  run?: PixelGamePublicRun;
  report?: string;
  unlocked_classes?: string[];
  leaderboard?: PixelGameLeaderboardEntry[];
  error?: string;
};

export type PixelGameAbandonResponse = {
  ok: boolean;
  run?: PixelGamePublicRun;
  error?: string;
};

export type PixelGameUpgradeEffects = {
  maxHp?: number;
  heal?: number;
  speedMultiplier?: number;
  damageMultiplier?: number;
  attackRateMultiplier?: number;
  projectileCount?: number;
  projectileSpeedMultiplier?: number;
  pickupRange?: number;
  shield?: number;
  xpMultiplier?: number;
};

export type PixelGameUpgradeOption = {
  id: string;
  name: string;
  title?: string;
  description?: string;
  effect?: string;
  flavor?: string;
  rarity?: "common" | "rare" | "epic" | "signal" | string;
  tags?: string[];
  maxRank?: number;
  jobId?: string;
  effects?: PixelGameUpgradeEffects;
};

export type PixelGameWeaponTuning = {
  id: string;
  name?: string;
  kind?: string;
  damage: number;
  cooldown_ms: number;
  range: number;
  color?: string;
  tags?: string[];
  aliases?: string[];
};

export type PixelGameJob = {
  id: string;
  name: string;
  role?: string;
  tagline?: string;
  startingWeapon?: {
    id: string;
    name?: string;
    damageType?: string;
    pattern?: string;
  };
  baseStats?: {
    maxHp?: number;
    speed?: number;
    attack?: number;
    cooldown?: number;
    pickup?: number;
    luck?: number;
  };
  passive?: string;
  upgradeTags?: string[];
  hoshiaMapping?: {
    moodTags?: string[];
    activityTags?: string[];
    commentaryTone?: string;
    directorTags?: string[];
  };
};

export type PixelGameEnemyTuning = {
  id: string;
  name?: string;
  family?: string;
  archetype?: string;
  hp: number;
  speed: number;
  damage: number;
  xp: number;
  score: number;
  spawn_weight?: number;
  spawnWeight?: number;
  color?: string;
  size?: number;
};

export type PixelGameBossTuning = {
  id: string;
  name?: string;
  spawn_minute?: number;
  hp: number;
  damage: number;
  speed: number;
  patterns?: string[];
  color?: string;
};

export type PixelGameBiome = {
  id: string;
  name?: string;
  activity?: string;
  palette?: string[];
  enemy_families?: string[];
  boss_id?: string;
};

export type PixelGameWaveRule = {
  minute: number;
  spawn_rate: number;
  families?: string[];
  boss?: boolean;
};

export type PixelGameDirectorMoodRule = {
  mood: string;
  displayName?: string;
  directorModifiers?: {
    spawnTempo?: number;
    eliteRate?: number;
    pickupBias?: string[];
    palette?: string;
  };
  announcerHints?: string[];
};

export type PixelGameDirectorActivityRule = {
  activity: string;
  displayName?: string;
  directorShift?: string;
  preferredEventTags?: string[];
};

export type PixelGameDirectorEventCard = {
  id: string;
  name?: string;
  tags?: string[];
  effect?: string;
};

export type PixelGameDirectorRules = {
  schemaVersion: 1;
  kind: "directorRules";
  packId?: string;
  directorId?: string;
  hoshiaMoodMap?: PixelGameDirectorMoodRule[];
  hoshiaActivityMap?: PixelGameDirectorActivityRule[];
  eventCards?: PixelGameDirectorEventCard[];
};

export type PixelGameVisualAnimation = {
  atlas: string;
  frames: string[];
  fps?: number;
  loop?: boolean;
  anchor?: PixelGameVector;
  scale?: number;
};

export type PixelGameVisualSprite = {
  atlas?: string;
  frame?: string;
  prefix?: string;
  animations?: Record<string, PixelGameVisualAnimation>;
};

export type PixelGameVisualEntity = {
  icon?: string;
  portrait?: string;
  preview?: string;
  color?: string;
  sprite?: PixelGameVisualSprite;
  effects?: Record<string, string>;
};

export type PixelGameVisualAtlas = {
  id: string;
  image: string;
  data: string;
};

export type PixelGameVisualManifest = {
  schemaVersion: 1;
  kind: "visuals";
  packId: string;
  packVersion: string;
  assetBase?: string;
  pixelSpec?: {
    tileSize?: number;
    actorCell?: number;
    enemyCell?: number;
    bossCell?: number;
    iconSize?: number;
    filter?: "nearest" | string;
    defaultAnchor?: [number, number];
  };
  atlases: PixelGameVisualAtlas[];
  entities: {
    hoshia?: PixelGameVisualEntity;
    jobs?: Record<string, PixelGameVisualEntity>;
    starterWeapons?: Record<string, PixelGameVisualEntity>;
    weapons?: Record<string, PixelGameVisualEntity>;
    enemies?: Record<string, PixelGameVisualEntity>;
    bosses?: Record<string, PixelGameVisualEntity>;
    biomes?: Record<string, PixelGameVisualEntity>;
    drops?: Record<string, PixelGameVisualEntity>;
    effects?: Record<string, PixelGameVisualEntity>;
  };
  fallbacks?: {
    missingIcon?: string;
    missingActor?: string;
    missingEffect?: string;
  };
  creditsFile?: string;
};

export type PixelGameDataBundle = {
  jobs: PixelGameJob[];
  weapons: PixelGameWeaponTuning[];
  upgrades: PixelGameUpgradeOption[];
  enemies: PixelGameEnemyTuning[];
  bosses: PixelGameBossTuning[];
  biomes: PixelGameBiome[];
  waves: PixelGameWaveRule[];
  directorRules: PixelGameDirectorRules | null;
  visuals: PixelGameVisualManifest | null;
  source: "assets" | "fallback" | "mixed";
};

export type PixelGameSnapshot = {
  status: "idle" | "running" | "paused" | "upgrade" | "class_select" | "finished";
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpToNext: number;
  score: number;
  kills: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  wavesCleared: number;
  enemies: number;
  projectiles: number;
  chosenClassId?: string;
  specializationId?: string;
  upgradeIds: string[];
  shield: number;
  bossResult: PixelGameBossResult;
};
