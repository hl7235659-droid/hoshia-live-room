const characterId = "hoshia";
const defaultTickMinMinutes = 20;
const defaultTickMaxMinutes = 60;

export const hoshiaStagePngAssets = [
  asset("idle_calm_01", "idle", "calm", 35, 100, ["daily", "waiting", "sports-bottle"], "Hoshia stands relaxed in a blue-and-white stage outfit with a small bottle, soft smile, white cat ears, tail, and clean sticker-like outline."),
  asset("idle_calm_02", "idle", "curious", 25, 95, ["daily", "tablet", "waiting"], "Hoshia sits on a round star cushion in a loose hoodie, holding a tablet with a quiet curious look, like she is checking the room between chats."),
  asset("gaming_competitive_01", "gaming", "competitive", 35, 100, ["gamepad", "headset", "ranked"], "Hoshia leans forward holding a game controller, wearing a sporty blue outfit and focused competitive expression for an active gaming moment."),
  asset("gaming_annoyed_02", "gaming", "annoyed", 20, 95, ["keyboard", "ranked", "tilted"], "Hoshia grips a bright keyboard prop with puffed-cheek frustration, still in her blue gamer outfit, as if recovering from a rough ranked match."),
  asset("sports_energetic_01", "sports", "energetic", 45, 100, ["stretching", "training", "active"], "Hoshia wears a cropped athletic top and shorts, lifting one leg in a cheerful training pose with bright, energetic body language."),
  asset("sports_tired_02", "sports", "tired", 20, 85, ["cooldown", "sweat-towel", "training"], "Hoshia stands in workout clothes holding a water bottle and towel, looking warm and slightly tired after exercise but still composed."),
  asset("otaku_excited_01", "otaku", "excited", 35, 100, ["anime", "manga", "recommendation"], "Hoshia hugs a plush and shows an anime magazine with sparkling excitement, dressed in her blue casual stage outfit like she found a favorite new episode."),
  asset("otaku_curious_02", "otaku", "curious", 25, 95, ["forum", "figure", "watching"], "Hoshia holds a tablet beside a small chibi cat figure, wearing a loose shirt and shorts while browsing anime notes with a curious expression."),
  asset("sleepy_sleepy_01", "sleepy", "sleepy", 0, 65, ["late-night", "yawn", "low-energy"], "Hoshia wears an oversized hoodie and paw slippers, rubbing one eye with a sleepy yawn, soft and ready to wind down for the night."),
  asset("sleepy_lonely_02", "sleepy", "lonely", 0, 60, ["late-night", "desk", "quiet"], "Hoshia sits curled on a chair under a star blanket, looking quiet and lonely in a late-night low-energy mood."),
  asset("happy_happy_01", "happy", "happy", 35, 100, ["heart", "wave", "high-social"], "Hoshia jumps forward in a bright blue skirt outfit, arm raised in a big friendly wave with an open happy smile."),
  asset("happy_playful_02", "happy", "playful", 35, 100, ["peace-sign", "teasing", "high-social"], "Hoshia poses with a playful peace sign in her blue stage outfit, smiling like she is teasing the audience in a good mood."),
  asset("thinking_thinking_01", "thinking", "thinking", 20, 90, ["typing", "planning", "focused"], "Hoshia sits at a laptop with sticky notes on the screen, wearing a blue hoodie and focused on planning or answering something carefully."),
  asset("thinking_focused_02", "thinking", "focused", 25, 95, ["notes", "keyboard", "focused"], "Hoshia stands with one hand near her mouth and arms tucked close, looking thoughtful and focused while working through an idea."),
  asset("emo_emo_01", "emo", "emo", 0, 70, ["rainy", "low-social", "quiet"], "Hoshia wears a dark oversized hoodie with her hands tucked in, standing quietly with a withdrawn, low-energy expression."),
  asset("emo_lonely_02", "emo", "lonely", 0, 70, ["hoodie", "low-social", "quiet"], "Hoshia sits curled inside a plush star chair, wrapped in a blanket with a guarded lonely look, as if she wants company but is too tired to ask.")
];

const assetsById = new Map(hoshiaStagePngAssets.map((item) => [item.id, item]));
const validActivities = new Set(hoshiaStagePngAssets.map((item) => item.activity));
const validMoods = new Set([
  ...hoshiaStagePngAssets.map((item) => item.mood),
  "calm",
  "tired",
  "annoyed"
]);

export function createHoshiaVisualStateService({ db, clock = () => new Date() }) {
  return {
    publicState() {
      return publicVisualState(ensureState(db, clock));
    },

    update(input = {}) {
      const current = ensureState(db, clock);
      const next = normalizeState({
        ...current,
        mood: input.mood ?? current.mood,
        activity: input.activity ?? current.activity,
        energy: input.energy ?? current.energy,
        social_need: input.social_need ?? input.socialNeed ?? current.social_need,
        state_reason: input.state_reason ?? input.stateReason ?? current.state_reason,
        updated_at: input.updated_at ?? clock().toISOString()
      });
      next.current_png = selectAssetForState(next, current.current_png).path;
      db.upsertHoshiaState(next);
      return {
        changed: hasVisualStateChanged(current, next),
        state: publicVisualState(next),
        reason: next.state_reason
      };
    },

    tick({ reason = "scheduled visual refresh", now = clock() } = {}) {
      const current = ensureState(db, () => now);
      const nextActivity = activityForRhythm(current, now);
      const nextMood = moodForActivity(nextActivity, current, now);
      const next = normalizeState({
        ...current,
        activity: nextActivity,
        mood: nextMood,
        energy: energyForRhythm(current, now),
        social_need: socialNeedForRhythm(current),
        state_reason: reason,
        updated_at: now.toISOString()
      });
      next.current_png = selectAssetForState(next, current.current_png).path;
      db.upsertHoshiaState(next);
      return {
        changed: hasVisualStateChanged(current, next),
        state: publicVisualState(next),
        reason
      };
    },

    applyUserInteraction({ text = "", session = null, now = clock() } = {}) {
      const current = ensureState(db, () => now);
      const interaction = classifyInteraction(text);
      const next = normalizeState({
        ...current,
        activity: current.activity,
        mood: current.mood,
        energy: clampInt(current.energy + interaction.energyDelta, 0, 100, 70),
        social_need: clampInt(current.social_need + interaction.socialNeedDelta, 0, 100, 50),
        current_png: current.current_png,
        state_reason: interaction.reason || `viewer ${cleanName(session?.nickname)} interacted`,
        updated_at: now.toISOString()
      });
      db.upsertHoshiaState(next);
      return {
        changed: hasVisualStateChanged(current, next),
        state: publicVisualState(next),
        reason: next.state_reason
      };
    }
  };
}

export function defaultHoshiaVisualState(now = new Date()) {
  const defaultAsset = assetsById.get("idle_calm_01") || hoshiaStagePngAssets[0];
  return {
    character_id: characterId,
    mood: "calm",
    activity: "idle",
    energy: 72,
    social_need: 48,
    current_png: defaultAsset.path,
    state_reason: "default idle stage state",
    updated_at: now.toISOString()
  };
}

export function publicVisualState(state) {
  const normalized = normalizeState(state);
  return {
    character_id: normalized.character_id,
    mood: normalized.mood,
    activity: normalized.activity,
    energy: normalized.energy,
    social_need: normalized.social_need,
    current_png: normalized.current_png,
    visual_description: visualDescriptionForStagePng(normalized.current_png),
    state_reason: normalized.state_reason,
    updated_at: normalized.updated_at
  };
}

export function selectAssetForState(state, currentPath = "") {
  const normalized = normalizeState(state);
  const pools = [
    hoshiaStagePngAssets.filter((item) =>
      item.activity === normalized.activity
      && item.mood === normalized.mood
      && normalized.energy >= item.energy_min
      && normalized.energy <= item.energy_max
    ),
    hoshiaStagePngAssets.filter((item) =>
      item.activity === normalized.activity
      && normalized.energy >= item.energy_min
      && normalized.energy <= item.energy_max
    ),
    hoshiaStagePngAssets.filter((item) => item.activity === normalized.activity),
    hoshiaStagePngAssets.filter((item) => item.activity === "idle"),
    hoshiaStagePngAssets
  ];

  for (const pool of pools) {
    if (!pool.length) continue;
    const currentIndex = pool.findIndex((item) => item.path === currentPath);
    if (currentIndex >= 0 && pool.length === 1) continue;
    if (currentIndex >= 0 && pool.length > 1) {
      return pool[(currentIndex + 1) % pool.length];
    }
    return pool[0];
  }
  return hoshiaStagePngAssets[0];
}

export function normalizeHoshiaVisualUpdate(body = {}) {
  return normalizeState({
    character_id: characterId,
    mood: body.mood,
    activity: body.activity,
    energy: body.energy,
    social_need: body.social_need ?? body.socialNeed,
    current_png: "",
    state_reason: body.state_reason ?? body.stateReason,
    updated_at: new Date().toISOString()
  });
}

export function normalizeHoshiaTickWindow(minValue, maxValue) {
  let minMinutes = clampInt(minValue, 5, 180, defaultTickMinMinutes);
  let maxMinutes = clampInt(maxValue, 5, 180, defaultTickMaxMinutes);
  if (minMinutes > maxMinutes) {
    [minMinutes, maxMinutes] = [maxMinutes, minMinutes];
  }
  return { minMinutes, maxMinutes };
}

export function randomHoshiaTickDelayMs(window = {}, random = Math.random) {
  const { minMinutes, maxMinutes } = normalizeHoshiaTickWindow(window.minMinutes, window.maxMinutes);
  const ratio = Math.max(0, Math.min(Number(random()) || 0, 0.999999));
  const minutes = minMinutes + Math.floor(ratio * (maxMinutes - minMinutes + 1));
  return minutes * 60 * 1000;
}

export function stagePngAssetForPath(path) {
  const value = cleanText(path, 160);
  return hoshiaStagePngAssets.find((item) => item.path === value)
    || hoshiaStagePngAssets.find((item) => item.id === value)
    || null;
}

export function visualDescriptionForStagePng(path) {
  const description = stagePngAssetForPath(path)?.visual_description
    || "Hoshia is shown in a clean blue-and-white stage cutout.";
  return `White-haired anime catgirl Hoshia: ${description}`;
}

function ensureState(db, clock) {
  const existing = db.getHoshiaState(characterId);
  if (existing) return normalizeState(existing);
  const created = defaultHoshiaVisualState(clock());
  db.upsertHoshiaState(created);
  return created;
}

function normalizeState(value = {}) {
  const activity = cleanIdentifier(value.activity);
  const mood = cleanIdentifier(value.mood);
  const normalizedActivity = validActivities.has(activity) ? activity : "idle";
  const normalizedMood = validMoods.has(mood) ? mood : moodForActivity(normalizedActivity, value);
  const currentAsset = hoshiaStagePngAssets.find((item) => item.path === value.current_png)
    || selectDefaultAsset(normalizedActivity);
  return {
    character_id: cleanIdentifier(value.character_id) || characterId,
    mood: normalizedMood,
    activity: normalizedActivity,
    energy: clampInt(value.energy, 0, 100, 72),
    social_need: clampInt(value.social_need, 0, 100, 48),
    current_png: currentAsset.path,
    state_reason: cleanText(value.state_reason, 160) || "visual state updated",
    updated_at: cleanText(value.updated_at, 40) || new Date().toISOString()
  };
}

function selectDefaultAsset(activity) {
  return hoshiaStagePngAssets.find((item) => item.activity === activity) || hoshiaStagePngAssets[0];
}

function classifyInteraction(text) {
  const value = String(text || "").toLowerCase();
  if (/(love|cute|happy|nice|thanks|great|喜欢|可爱|开心|谢谢|厉害|加油)/i.test(value)) {
    return {
      energyDelta: 4,
      socialNeedDelta: -8,
      reason: "viewer gave positive interaction"
    };
  }
  if (/(sad|lonely|emo|upset|难过|孤独|没人|低落|委屈)/i.test(value)) {
    return {
      energyDelta: -4,
      socialNeedDelta: 5,
      reason: "viewer shared a low mood topic"
    };
  }
  if (/(sleep|tired|night|困|累|晚安|睡觉|熬夜)/i.test(value)) {
    return {
      energyDelta: -5,
      socialNeedDelta: 1,
      reason: "viewer brought a quiet late-night tone"
    };
  }
  if (/[?？]|(plan|idea|why|how|think|想法|为什么|怎么|思考|计划)/i.test(value)) {
    return {
      energyDelta: -1,
      socialNeedDelta: -2,
      reason: "viewer asked Hoshia to think"
    };
  }
  return {
    energyDelta: 1,
    socialNeedDelta: -3,
    reason: "viewer interacted in chat"
  };
}

function activityForRhythm(current, now) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false
  }).format(now));
  if (hour >= 23 || hour < 6) return "sleepy";
  if (current.social_need >= 76 && current.energy <= 45) return "emo";
  if (current.energy >= 80 && current.social_need <= 35) return "happy";
  return current.activity || "idle";
}

function moodForActivity(activity, current = {}) {
  if (activity === "gaming") return current.mood === "annoyed" ? "annoyed" : "competitive";
  if (activity === "sports") return current.energy <= 45 ? "tired" : "energetic";
  if (activity === "otaku") return current.mood === "curious" ? "curious" : "excited";
  if (activity === "sleepy") return current.social_need >= 65 ? "lonely" : "sleepy";
  if (activity === "happy") return current.mood === "playful" ? "playful" : "happy";
  if (activity === "thinking") return current.mood === "focused" ? "focused" : "thinking";
  if (activity === "emo") return current.social_need >= 65 ? "lonely" : "emo";
  return current.mood && validMoods.has(current.mood) ? current.mood : "calm";
}

function energyForRhythm(current, now) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false
  }).format(now));
  const delta = hour >= 23 || hour < 6 ? -6 : -1;
  return clampInt(Number(current.energy) + delta, 0, 100, 70);
}

function socialNeedForRhythm(current) {
  return clampInt(Number(current.social_need) + 4, 0, 100, 50);
}

function hasVisualStateChanged(before, after) {
  return before.mood !== after.mood
    || before.activity !== after.activity
    || before.energy !== after.energy
    || before.social_need !== after.social_need
    || before.current_png !== after.current_png
    || before.state_reason !== after.state_reason;
}

function asset(id, activity, mood, energyMin, energyMax, tags, visualDescription) {
  return {
    id,
    path: `/assets/hoshia/stage-png/${id}.png`,
    activity,
    mood,
    energy_min: energyMin,
    energy_max: energyMax,
    tags,
    visual_description: cleanText(visualDescription, 220)
  };
}

function cleanIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, 48);
}

function cleanText(value, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (/(?:\.env|ssh-|BEGIN [A-Z ]*PRIVATE KEY|token=|password=|secret=)/i.test(text)) return "";
  return text;
}

function cleanName(value) {
  return cleanText(value, 32) || "viewer";
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
