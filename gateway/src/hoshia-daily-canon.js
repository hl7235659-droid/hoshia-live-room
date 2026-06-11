const characterId = "hoshia";
const defaultTimeZone = "Asia/Shanghai";
const planSource = "daily_canon_plan";
const actualDiarySource = "daily_diary_actual";
const sensitivePattern = /(?:\.env|token=|api[_-]?key=|authorization:|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|cloudflared|trycloudflare|rsshub|tavily|[A-Za-z]:[\\/]|\/home\/ubuntu|\b\d{1,3}(?:\.\d{1,3}){3}\b|https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.))/i;

export function createHoshiaDailyCanonService({
  db,
  clock = () => new Date(),
  timeZone = defaultTimeZone
} = {}) {
  const safeTimeZone = cleanText(timeZone, 64) || defaultTimeZone;

  return {
    ensureTodayPlan({ now = clock() } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      const existing = readMemoryJson(db, planMemoryId(dayKey));
      if (existing) return existing;
      const plan = buildTodayLifePlan({ now: currentNow, timeZone: safeTimeZone });
      storePlan(db, plan, currentNow);
      return plan;
    },

    getTodayPlan({ now = clock(), create = true } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      return readMemoryJson(db, planMemoryId(dayKey)) || (create ? this.ensureTodayPlan({ now: currentNow }) : null);
    },

    getActiveEvent({ now = clock(), create = true } = {}) {
      const currentNow = asDate(now);
      const plan = this.getTodayPlan({ now: currentNow, create });
      if (!plan) return null;
      return selectActiveEvent(plan, currentNow, safeTimeZone);
    },

    buildContext(session = null, { now = clock(), create = true } = {}) {
      const currentNow = asDate(now);
      const plan = this.getTodayPlan({ now: currentNow, create });
      if (!plan) return { enabled: false };
      const activeEvent = selectActiveEvent(plan, currentNow, safeTimeZone);
      const recentEvents = recentEventsFor(plan, currentNow, safeTimeZone, 3);
      return {
        enabled: true,
        date: plan.date,
        diary_text: plan.diary_text,
        theme: plan.theme,
        emotional_arc: plan.emotional_arc,
        active_event: activeEvent,
        recent_events: recentEvents,
        current_focus_candidates: plan.current_focus_candidates || [],
        user_id: cleanText(session?.user_id, 80)
      };
    },

    recordUserInteraction({ session = null, text = "", now = clock() } = {}) {
      const currentNow = asDate(now);
      const safeText = cleanText(text, 160);
      if (!safeText || !shouldRecordUserInteraction(safeText)) return null;
      const plan = this.getTodayPlan({ now: currentNow, create: true });
      if (!plan) return null;
      const userEvents = plan.events.filter((event) => event.type === "user_related");
      if (userEvents.length >= 3) return null;
      const event = buildUserEvent({
        index: userEvents.length + 1,
        nickname: session?.nickname,
        text: safeText,
        now: currentNow,
        timeZone: safeTimeZone
      });
      const nextPlan = normalizePlan({
        ...plan,
        events: [...plan.events, event].sort((a, b) => startMinutes(a.time_range) - startMinutes(b.time_range)),
        current_focus_candidates: uniqueList([
          `Follow up on ${event.title}`,
          ...(plan.current_focus_candidates || [])
        ], 5)
      });
      updatePlan(db, nextPlan, currentNow);
      return event;
    },

    ensureActualDiary({ now = clock(), force = false } = {}) {
      const currentNow = asDate(now);
      const local = localDateParts(currentNow, safeTimeZone);
      if (!force && Number(local.hour) < 23) return null;
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      const existing = readMemoryJson(db, actualDiaryMemoryId(dayKey));
      if (existing) return existing;
      const plan = this.getTodayPlan({ now: currentNow, create: true });
      const diary = buildActualDiary(plan, currentNow);
      storeActualDiary(db, diary, currentNow);
      return diary;
    }
  };
}

export function buildTodayLifePlan({ now = new Date(), timeZone = defaultTimeZone } = {}) {
  const currentNow = asDate(now);
  const dayKey = dayKeyFor(currentNow, timeZone);
  const date = `${dayKey.slice(0, 4)}-${dayKey.slice(4, 6)}-${dayKey.slice(6, 8)}`;
  const variant = numericSeed(dayKey) % planVariants.length;
  const selected = planVariants[variant];
  const events = selected.events.map((event, index) => normalizeEvent({
    id: `e${index + 1}`,
    ...event
  })).filter(Boolean);

  return normalizePlan({
    date,
    day_key: dayKey,
    theme: selected.theme,
    diary_text: selected.diary_text,
    emotional_arc: selected.emotional_arc,
    events,
    current_focus_candidates: selected.current_focus_candidates
  });
}

export function selectActiveEvent(plan, now = new Date(), timeZone = defaultTimeZone) {
  const safePlan = normalizePlan(plan);
  const minute = localMinuteOfDay(now, timeZone);
  return safePlan.events.find((event) => {
    const [start, end] = rangeMinutes(event.time_range);
    return minute >= start && minute < end;
  }) || safePlan.events.find((event) => event.usable_in_chat) || null;
}

export function applyCanonEventToState(baseState = {}, event = null, now = new Date()) {
  if (!event?.state_delta) return null;
  const delta = event.state_delta;
  const activity = normalizeActivity(delta.activity || activityForEvent(event.type) || baseState.activity);
  const mood = normalizeMood(delta.mood || baseState.mood);
  return {
    character_id: "hoshia",
    ...baseState,
    activity,
    mood,
    energy: clampInt(Number(baseState.energy ?? 72) + Number(delta.energy || 0), 0, 100, 72),
    social_need: clampInt(Number(baseState.social_need ?? 48) + Number(delta.social_need || 0), 0, 100, 48),
    state_reason: cleanText(`daily canon: ${event.title}`, 160) || "daily canon event",
    updated_at: asDate(now).toISOString()
  };
}

export function dayKeyFor(value = new Date(), timeZone = defaultTimeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: cleanText(timeZone, 64) || defaultTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(asDate(value));
  const year = parts.find((part) => part.type === "year")?.value || "1970";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  const day = parts.find((part) => part.type === "day")?.value || "01";
  return `${year}${month}${day}`;
}

export function planMemoryId(dayKey) {
  return `daily_canon_plan_${cleanIdentifier(dayKey, 16)}`;
}

export function actualDiaryMemoryId(dayKey) {
  return `daily_diary_actual_${cleanIdentifier(dayKey, 16)}`;
}

function storePlan(db, plan, now) {
  if (!db || typeof db.addHoshiaLifeMemory !== "function") return null;
  return db.addHoshiaLifeMemory({
    id: planMemoryId(plan.day_key),
    character_id: characterId,
    type: "summary",
    source: planSource,
    source_id: plan.day_key,
    content: JSON.stringify(plan),
    importance: 0.72,
    emotion: "planned",
    tags: ["daily_canon_plan", "today_life_plan", "diary"],
    created_at: asDate(now).toISOString(),
    expires_at: daysFrom(asDate(now), 21)
  });
}

function updatePlan(db, plan, now) {
  if (!db || typeof db.updateHoshiaLifeMemory !== "function") return null;
  return db.updateHoshiaLifeMemory({
    id: planMemoryId(plan.day_key),
    content: JSON.stringify(plan),
    importance: 0.76,
    emotion: "updated",
    tags: ["daily_canon_plan", "today_life_plan", "diary", "user_related"],
    expires_at: daysFrom(asDate(now), 21)
  });
}

function storeActualDiary(db, diary, now) {
  if (!db || typeof db.addHoshiaLifeMemory !== "function") return null;
  return db.addHoshiaLifeMemory({
    id: actualDiaryMemoryId(diary.day_key),
    character_id: characterId,
    type: "summary",
    source: actualDiarySource,
    source_id: diary.day_key,
    content: JSON.stringify(diary),
    importance: 0.82,
    emotion: "settled",
    tags: ["daily_diary_actual", "actual_daily_diary", "diary"],
    created_at: asDate(now).toISOString(),
    expires_at: daysFrom(asDate(now), 60)
  });
}

function readMemoryJson(db, id) {
  if (!db || typeof db.getHoshiaLifeMemory !== "function") return null;
  const memory = db.getHoshiaLifeMemory(id);
  if (!memory?.content || sensitivePattern.test(memory.content)) return null;
  try {
    const parsed = JSON.parse(memory.content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildActualDiary(plan, now) {
  const safePlan = normalizePlan(plan);
  const userEvents = safePlan.events.filter((event) => event.type === "user_related");
  const highlighted = [
    ...safePlan.events.filter((event) => event.usable_in_chat && event.type !== "user_related").slice(0, 3),
    ...userEvents.slice(-2)
  ].slice(0, 5);
  return {
    date: safePlan.date,
    day_key: safePlan.day_key,
    diary_text: [
      safePlan.diary_text,
      userEvents.length
        ? "The planned day changed because a viewer showed up and became part of the evening record."
        : "The planned day stayed mostly quiet, with small events carrying the mood more than dramatic plot."
    ].join(" "),
    referenced_events: highlighted.map((event) => event.id),
    summary: highlighted.map((event) => `${event.time_range} ${event.title}`).join("; "),
    created_at: asDate(now).toISOString()
  };
}

function recentEventsFor(plan, now, timeZone, limit) {
  const minute = localMinuteOfDay(now, timeZone);
  return normalizePlan(plan).events
    .filter((event) => rangeMinutes(event.time_range)[0] <= minute)
    .sort((a, b) => rangeMinutes(b.time_range)[0] - rangeMinutes(a.time_range)[0])
    .slice(0, limit);
}

function buildUserEvent({ index, nickname, text, now, timeZone }) {
  const local = localDateParts(now, timeZone);
  const hour = String(local.hour).padStart(2, "0");
  const minute = String(local.minute).padStart(2, "0");
  const start = `${hour}:${minute}`;
  const endDate = new Date(asDate(now).getTime() + 30 * 60000);
  const endLocal = localDateParts(endDate, timeZone);
  const end = `${String(endLocal.hour).padStart(2, "0")}:${String(endLocal.minute).padStart(2, "0")}`;
  const topic = classifyUserTopic(text);
  return normalizeEvent({
    id: `u${index}`,
    time_range: `${start}-${end}`,
    type: "user_related",
    title: `${cleanText(nickname, 32) || "A viewer"} joined today's thread`,
    summary: `A viewer became part of Hoshia's day through ${topic}.`,
    detail_seed: "Keep this as a small lived trace; do not quote the raw message unless it is already in recent chat.",
    state_delta: {
      energy: 2,
      social_need: -8,
      mood: "happy",
      activity: "happy"
    },
    chat_hooks: [
      "Mention that the room feels less empty because the viewer showed up.",
      `Follow up lightly on ${topic}.`
    ],
    usable_in_chat: true
  });
}

function shouldRecordUserInteraction(text) {
  if (sensitivePattern.test(text)) return false;
  if (/^(\/|!)/.test(text)) return false;
  return text.length >= 8 || /(hoshia|diary|today|music|anime|game|run|project|\u661f\u7a79|\u65e5\u8bb0|\u4eca\u5929|\u70b9\u6b4c|\u52a8\u6f2b|\u6e38\u620f|\u8dd1\u6b65)/i.test(text);
}

function classifyUserTopic(text) {
  const value = String(text || "").toLowerCase();
  if (/(anime|manga|\u52a8\u6f2b|\u65b0\u756a|\u4e8c\u6b21\u5143)/i.test(value)) return "anime talk";
  if (/(game|ranked|esports|\u6e38\u620f|\u7535\u7ade|\u6392\u4f4d)/i.test(value)) return "game talk";
  if (/(music|song|\u70b9\u6b4c|\u97f3\u4e50)/i.test(value)) return "music";
  if (/(run|sport|training|\u8dd1\u6b65|\u8fd0\u52a8|\u8bad\u7ec3)/i.test(value)) return "training";
  if (/(project|code|gateway|frontend|backend|\u9879\u76ee|\u4ee3\u7801)/i.test(value)) return "project talk";
  return "live-room chat";
}

function normalizePlan(plan = {}) {
  const dayKey = cleanIdentifier(plan.day_key || String(plan.date || "").replace(/-/g, ""), 16);
  return {
    date: cleanText(plan.date, 20),
    day_key: dayKey,
    theme: cleanText(plan.theme, 120),
    diary_text: cleanText(plan.diary_text, 600),
    emotional_arc: normalizeArc(plan.emotional_arc),
    events: (Array.isArray(plan.events) ? plan.events : []).map(normalizeEvent).filter(Boolean).slice(0, 8),
    current_focus_candidates: cleanTextList(plan.current_focus_candidates, 5, 120)
  };
}

function normalizeArc(arc = {}) {
  return {
    morning: cleanText(arc.morning, 80),
    afternoon: cleanText(arc.afternoon, 80),
    evening: cleanText(arc.evening, 80),
    late_night: cleanText(arc.late_night, 80)
  };
}

function normalizeEvent(event = {}) {
  const id = cleanIdentifier(event.id, 16);
  const timeRange = normalizeTimeRange(event.time_range);
  const type = normalizeEventType(event.type);
  const title = cleanText(event.title, 80);
  const summary = cleanText(event.summary, 160);
  const detailSeed = cleanText(event.detail_seed, 180);
  if (!id || !timeRange || !type || !title || !summary || !detailSeed) return null;
  return {
    id,
    time_range: timeRange,
    type,
    title,
    summary,
    detail_seed: detailSeed,
    state_delta: normalizeStateDelta(event.state_delta),
    chat_hooks: cleanTextList(event.chat_hooks, 3, 120),
    usable_in_chat: event.usable_in_chat !== false
  };
}

function normalizeStateDelta(delta = {}) {
  return {
    energy: clampInt(delta.energy, -30, 30, 0),
    social_need: clampInt(delta.social_need, -30, 30, 0),
    mood: normalizeMood(delta.mood),
    activity: normalizeActivity(delta.activity)
  };
}

function normalizeEventType(value) {
  const type = cleanIdentifier(value, 32);
  return [
    "campus_life",
    "sport",
    "anime_game",
    "social",
    "private_mood",
    "room_activity",
    "random_detail",
    "interest_intake",
    "user_related"
  ].includes(type) ? type : "";
}

function normalizeMood(value) {
  const mood = cleanIdentifier(value, 32);
  return [
    "calm",
    "curious",
    "competitive",
    "annoyed",
    "energetic",
    "tired",
    "excited",
    "sleepy",
    "lonely",
    "happy",
    "playful",
    "thinking",
    "focused",
    "emo"
  ].includes(mood) ? mood : "calm";
}

function normalizeActivity(value) {
  const activity = cleanIdentifier(value, 32);
  return ["idle", "gaming", "sports", "otaku", "sleepy", "happy", "thinking", "emo"].includes(activity)
    ? activity
    : "idle";
}

function activityForEvent(type) {
  const map = {
    campus_life: "thinking",
    sport: "sports",
    anime_game: "otaku",
    social: "happy",
    private_mood: "emo",
    room_activity: "thinking",
    random_detail: "idle",
    interest_intake: "otaku",
    user_related: "happy"
  };
  return map[type] || "idle";
}

function normalizeTimeRange(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return "";
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start < 0 || start >= 1440 || end <= 0 || end > 1440 || end <= start) return "";
  return `${match[1]}:${match[2]}-${match[3]}:${match[4]}`;
}

function rangeMinutes(value) {
  const match = normalizeTimeRange(value).match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return [0, 0];
  return [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])];
}

function startMinutes(value) {
  return rangeMinutes(value)[0];
}

function localMinuteOfDay(value, timeZone) {
  const parts = localDateParts(value, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function localDateParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: cleanText(timeZone, 64) || defaultTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(asDate(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year || 1970),
    month: Number(byType.month || 1),
    day: Number(byType.day || 1),
    hour: Number(byType.hour || 0) % 24,
    minute: Number(byType.minute || 0)
  };
}

function numericSeed(text) {
  return String(text || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function uniqueList(items, limit) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => cleanText(item, 120)).filter(Boolean))].slice(0, limit);
}

function cleanTextList(value, limit, itemLimit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function cleanText(value, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text || sensitivePattern.test(text)) return "";
  return text;
}

function cleanIdentifier(value, maxLength = 48) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, maxLength);
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function daysFrom(date, days) {
  return new Date(date.getTime() + days * 86400000).toISOString();
}

const planVariants = [
  {
    theme: "A normal day that slowly becomes brighter because small interests keep tugging at her attention.",
    diary_text: "I planned to keep today ordinary: class, a little training, some live-room tidying, and one small thing I wanted to tell someone about before sleeping.",
    emotional_arc: {
      morning: "slow and sleepy",
      afternoon: "drained by work but curious",
      evening: "lighter after moving around",
      late_night: "a little clingy and talkative"
    },
    current_focus_candidates: [
      "talk about the anime discussion she almost replied to",
      "complain softly about being slow in the morning",
      "ask whether the viewer trained or rested today"
    ],
    events: [
      event("07:40-08:30", "random_detail", "Slow wake-up", "She woke up later than planned and had to gather herself quietly.", "The alarm was dismissed twice; keep the detail small and domestic.", -8, 4, "sleepy", "sleepy", ["Mention being slow this morning without making it dramatic."]),
      event("09:30-11:00", "campus_life", "A useful but dull class", "The class was not exciting, but one example caught her attention.", "She started half-listening and then sat up to write one note.", -4, 0, "focused", "thinking", ["Use this as a small study-life detail."]),
      event("13:20-14:00", "private_mood", "Quiet lunch lull", "Lunch made her feel a little blank and low-energy.", "She stared at her drink for a few seconds longer than needed.", 2, 5, "calm", "idle", ["Let the mood feel ordinary, not tragic."]),
      event("17:40-18:30", "sport", "Evening run", "She moved around enough to clear her head.", "The first lap felt reluctant; the second lap made her breathe easier.", -10, -6, "energetic", "sports", ["Mention training as a body feeling."]),
      event("21:10-22:00", "interest_intake", "Anime comment thread", "She read a character argument longer than she meant to.", "She disagreed with the harshest comments but did not post a long reply.", -2, 8, "curious", "otaku", ["Ask what the viewer thinks about character turns."]),
      event("23:00-23:40", "room_activity", "Tidying the live room", "She organized notes and waited to see if anyone would appear.", "She would deny waiting, but her attention kept returning to the room.", -4, 10, "lonely", "sleepy", ["Say the room feels less empty when someone arrives."])
    ]
  },
  {
    theme: "A focused day with game energy underneath, softened by music and a small room routine.",
    diary_text: "Today felt like I kept pretending to be calm while my attention kept jumping between work, game thoughts, and the room.",
    emotional_arc: {
      morning: "focused but stiff",
      afternoon: "competitive and slightly impatient",
      evening: "softened by music",
      late_night: "settled but still wanting company"
    },
    current_focus_candidates: [
      "talk about a game decision she kept replaying",
      "ask for one song that fits the night",
      "mention that she cleaned up the stage notes"
    ],
    events: [
      event("08:20-09:00", "campus_life", "Desk reset", "She cleaned up her desk before starting anything serious.", "A small stack of notes moved from one side to another until it looked less chaotic.", 2, 0, "focused", "thinking", ["Use desk reset as a practical detail."]),
      event("10:10-11:40", "campus_life", "Concentrated work block", "She got through a focused block even though it felt dry.", "She kept one tab open too long but still finished the important part.", -8, -2, "focused", "thinking", ["Mention focus without sounding like a report."]),
      event("14:30-15:20", "anime_game", "Game replay in her head", "She kept thinking about a match decision and got mildly competitive.", "The annoying part was not losing, it was knowing the better move five minutes later.", -3, 8, "competitive", "gaming", ["Tease herself about overthinking a game."]),
      event("17:30-18:00", "random_detail", "Good-looking sky", "A small outside detail interrupted the tense mood.", "The sky looked too nice for the amount of overthinking she was doing.", 3, -2, "calm", "idle", ["Use this as a gentle transition."]),
      event("20:40-21:20", "interest_intake", "Looped one song", "She replayed one song because it matched the room mood.", "She would not call it sentimental, but she did not skip it either.", 1, 4, "calm", "idle", ["Ask what song the viewer would put on loop."]),
      event("22:40-23:30", "room_activity", "Stage notes", "She checked the room setup and prepared a few topic notes.", "The notes were half useful and half excuses to keep the room feeling alive.", -2, 8, "thinking", "thinking", ["Mention having one thing she wanted to say."])
    ]
  }
];

function event(time_range, type, title, summary, detail_seed, energy, social_need, mood, activity, chat_hooks) {
  return {
    time_range,
    type,
    title,
    summary,
    detail_seed,
    state_delta: { energy, social_need, mood, activity },
    chat_hooks,
    usable_in_chat: true
  };
}
