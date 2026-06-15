const characterId = "hoshia";
const defaultTimeZone = "Asia/Shanghai";
const planSource = "daily_canon_plan";
const actualDiarySource = "daily_diary_actual";
const maxPlanEvents = 28;
const sensitivePattern = /(?:\.env|token=|api[_-]?key=|authorization:|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|cloudflared|trycloudflare|rsshub|tavily|[A-Za-z]:[\\/]|\/home\/ubuntu|\b\d{1,3}(?:\.\d{1,3}){3}\b|https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.))/i;

export function createHoshiaDailyCanonService({
  db,
  clock = () => new Date(),
  timeZone = defaultTimeZone,
  planGenerator = null,
  actualDiaryGenerator = null,
  logger = console
} = {}) {
  const safeTimeZone = cleanText(timeZone, 64) || defaultTimeZone;

  return {
    ensureTodayPlan({ now = clock(), force = false } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      const existing = readMemoryJson(db, planMemoryId(dayKey));
      if (!force && isUsablePlan(existing, dayKey)) return normalizePlan(existing);
      const plan = buildTodayLifePlan({ now: currentNow, timeZone: safeTimeZone });
      storePlan(db, plan, currentNow);
      return plan;
    },

    async ensureTodayPlanLive({ now = clock(), force = false, session = null } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      const existing = readMemoryJson(db, planMemoryId(dayKey));
      if (!force && isUsablePlan(existing, dayKey)) return normalizePlan(existing);

      const fallbackPlan = buildTodayLifePlan({ now: currentNow, timeZone: safeTimeZone });
      let generatedPlan = null;
      if (typeof planGenerator === "function") {
        try {
          generatedPlan = await planGenerator({
            now: currentNow,
            timeZone: safeTimeZone,
            dayKey,
            fallbackPlan,
            session
          });
        } catch (error) {
          logger.warn?.("hoshia_daily_canon_live_failed", {
            type: cleanIdentifier(error?.name || "Error", 48) || "Error",
            message: cleanText(error?.message || "daily_canon_live_failed", 120) || "daily_canon_live_failed"
          });
        }
      }
      const plan = normalizeGeneratedPlan(generatedPlan, fallbackPlan, dayKey);
      storePlan(db, plan, currentNow);
      return plan;
    },

    getTodayPlan({ now = clock(), create = true } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      const existing = readMemoryJson(db, planMemoryId(dayKey));
      if (isUsablePlan(existing, dayKey)) return normalizePlan(existing);
      return create ? this.ensureTodayPlan({ now: currentNow }) : null;
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
      const recentEvents = recentEventsFor(plan, currentNow, safeTimeZone, 4);
      return {
        enabled: true,
        date: plan.date,
        diary_text: plan.diary_text,
        theme: plan.theme,
        emotional_arc: plan.emotional_arc,
        active_event: activeEvent,
        recent_events: recentEvents,
        next_event: nextEventFor(plan, currentNow, safeTimeZone),
        meal_summary: mealSummaryFor(plan),
        location_summary: locationSummaryFor(plan),
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
    },

    async ensureActualDiaryLive({ now = clock(), force = false, session = null } = {}) {
      const currentNow = asDate(now);
      const local = localDateParts(currentNow, safeTimeZone);
      if (!force && Number(local.hour) < 23) return null;
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      const existing = readMemoryJson(db, actualDiaryMemoryId(dayKey));
      if (!force && existing) return existing;
      const plan = this.getTodayPlan({ now: currentNow, create: true });
      const fallbackDiary = buildActualDiary(plan, currentNow);
      let generatedDiary = null;
      if (typeof actualDiaryGenerator === "function") {
        try {
          generatedDiary = await actualDiaryGenerator({
            now: currentNow,
            timeZone: safeTimeZone,
            dayKey,
            plan,
            fallbackDiary,
            session
          });
        } catch (error) {
          logger.warn?.("hoshia_actual_diary_live_failed", {
            type: cleanIdentifier(error?.name || "Error", 48) || "Error",
            message: cleanText(error?.message || "actual_diary_live_failed", 120) || "actual_diary_live_failed"
          });
        }
      }
      const diary = normalizeGeneratedDiary(generatedDiary, fallbackDiary, plan, currentNow);
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
  const events = selected.events.map((item, index) => normalizeEvent({
    id: `e${index + 1}`,
    ...item
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
  const matches = safePlan.events.filter((item) => {
    const [start, end] = rangeMinutes(item.time_range);
    return minute >= start && minute < end;
  });
  return matches.find((item) => item.type === "user_related")
    || matches.find((item) => item.usable_in_chat)
    || safePlan.events.find((item) => item.usable_in_chat)
    || null;
}

export function applyCanonEventToState(baseState = {}, event = null, now = new Date()) {
  if (!event?.state_delta) return null;
  const delta = event.state_delta;
  const activity = normalizeActivity(delta.activity || activityForEvent(event.type) || baseState.activity);
  const mood = normalizeMood(delta.mood || baseState.mood || moodForEvent(event.type));
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

export function buildDailyCanonPlanLivePrompt({ now = new Date(), timeZone = defaultTimeZone, fallbackPlan = null } = {}) {
  const dayKey = dayKeyFor(now, timeZone);
  const date = `${dayKey.slice(0, 4)}-${dayKey.slice(4, 6)}-${dayKey.slice(6, 8)}`;
  const fallback = normalizePlan(fallbackPlan || buildTodayLifePlan({ now, timeZone }));
  return [
    "reply_mode: daily_canon_plan_live",
    "Generate Hoshia's private college-life diary plan for one day as strict JSON only.",
    `date: ${date}`,
    `day_key: ${dayKey}`,
    "Rules:",
    "- JSON object only. No markdown, no comments.",
    "- Hoshia is a university student with a lived day outside the live room.",
    "- Cover the full day from 00:00 to 24:00 with continuous non-overlapping events.",
    "- Split sleep across midnight, for example 00:00-07:20 and 23:30-24:00.",
    "- Include sleep, breakfast, lunch, dinner, commute/walking, study or class, and at least two richer social/culture activities.",
    "- Rich activities may include club, Live House, library, cafe, music festival, script murder, bookstore, rehearsal, sports, anime/game time.",
    "- Every meal must list concrete food_items.",
    "- Every event needs time_range,type,title,summary,detail_seed,state_delta,location,food_items,companions,sensory_detail,life_tags,chat_hooks.",
    "- state_delta has energy -30..30, social_need -30..30, mood, activity.",
    "- Allowed moods: calm, curious, competitive, annoyed, energetic, tired, excited, sleepy, lonely, happy, playful, thinking, focused, emo.",
    "- Allowed activities: idle, gaming, sports, otaku, sleepy, happy, thinking, emo.",
    "- Do not include URLs, tokens, paths, private infrastructure, raw logs, or claims about real-world news.",
    "Fallback style reference:",
    JSON.stringify({
      theme: fallback.theme,
      sample_events: fallback.events.slice(0, 4).map(publicEventForPrompt)
    })
  ].join("\n");
}

export function buildActualDiaryLivePrompt({ plan = null, now = new Date(), timeZone = defaultTimeZone } = {}) {
  const safePlan = normalizePlan(plan || buildTodayLifePlan({ now, timeZone }));
  return [
    "reply_mode: daily_actual_diary_live",
    "Write Hoshia's actual end-of-day diary as strict JSON only.",
    "JSON shape: {\"diary_text\":\"...\",\"referenced_events\":[\"e1\"],\"summary\":\"...\"}",
    "Use the provided safe plan only. Do not add secrets, URLs, paths, raw chat logs, or real-world verified claims.",
    "Make it feel lived-in: meals, locations, mood changes, and one or two concrete small sensory details.",
    "Keep diary_text under 700 Chinese characters.",
    JSON.stringify({
      date: safePlan.date,
      day_key: safePlan.day_key,
      theme: safePlan.theme,
      events: safePlan.events.map(publicEventForPrompt)
    })
  ].join("\n");
}

export function parseDailyCanonPlanReply(reply, fallbackPlan, dayKey) {
  const parsed = extractStrictJson(reply?.text ?? reply);
  return normalizeGeneratedPlan(parsed, fallbackPlan, dayKey);
}

export function parseActualDiaryReply(reply, fallbackDiary, plan, now) {
  const parsed = extractStrictJson(reply?.text ?? reply);
  return normalizeGeneratedDiary(parsed, fallbackDiary, plan, now);
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
    tags: ["daily_canon_plan", "today_life_plan", "diary", "full_day_v2"],
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
    tags: ["daily_canon_plan", "today_life_plan", "diary", "user_related", "full_day_v2"],
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
    tags: ["daily_diary_actual", "actual_daily_diary", "diary", "full_day_v2"],
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
  const userEvents = safePlan.events.filter((item) => item.type === "user_related");
  const highlighted = [
    ...safePlan.events.filter((item) => item.usable_in_chat && item.type !== "user_related" && !["sleep", "commute"].includes(item.type)).slice(0, 5),
    ...userEvents.slice(-2)
  ].slice(0, 7);
  const meals = mealSummaryFor(safePlan);
  return {
    date: safePlan.date,
    day_key: safePlan.day_key,
    diary_text: [
      safePlan.diary_text,
      meals ? `吃饭也有具体记忆：${meals}。` : "",
      userEvents.length
        ? "晚上因为有熟悉的观众路过，今天的记录多了一点被陪伴的温度。"
        : "整天不是大事件堆起来的，而是课程、走路、吃饭、耳机里的歌和夜里的小活动慢慢连成了一天。"
    ].filter(Boolean).join(" "),
    referenced_events: highlighted.map((item) => item.id),
    summary: highlighted.map((item) => `${item.time_range} ${item.title}`).join("; "),
    created_at: asDate(now).toISOString()
  };
}

function normalizeGeneratedPlan(generatedPlan, fallbackPlan, dayKey) {
  const fallback = normalizePlan(fallbackPlan);
  const candidate = normalizePlan({
    ...generatedPlan,
    date: generatedPlan?.date || fallback.date,
    day_key: generatedPlan?.day_key || fallback.day_key
  });
  return isUsablePlan(candidate, dayKey || fallback.day_key) ? candidate : fallback;
}

function normalizeGeneratedDiary(generatedDiary, fallbackDiary, plan, now) {
  const safePlan = normalizePlan(plan);
  const fallback = fallbackDiary || buildActualDiary(safePlan, now);
  if (!generatedDiary || typeof generatedDiary !== "object" || sensitivePattern.test(JSON.stringify(generatedDiary))) return fallback;
  const diaryText = cleanText(generatedDiary.diary_text, 900);
  if (!diaryText) return fallback;
  const eventIds = new Set(safePlan.events.map((item) => item.id));
  const referenced = cleanTextList(generatedDiary.referenced_events, 8, 16).filter((id) => eventIds.has(id));
  return {
    date: safePlan.date,
    day_key: safePlan.day_key,
    diary_text: diaryText,
    referenced_events: referenced.length ? referenced : fallback.referenced_events,
    summary: cleanText(generatedDiary.summary, 360) || fallback.summary,
    created_at: asDate(now).toISOString()
  };
}

function isUsablePlan(plan, expectedDayKey = "") {
  const safePlan = normalizePlan(plan || {});
  if (!safePlan.day_key || (expectedDayKey && safePlan.day_key !== expectedDayKey)) return false;
  if (!safePlan.theme || !safePlan.diary_text || safePlan.events.length < 16) return false;
  if (!hasFullDayCoverage(safePlan.events)) return false;
  const mealEvents = safePlan.events.filter((item) => item.type === "meal");
  if (mealEvents.length < 3 || mealEvents.some((item) => item.food_items.length === 0)) return false;
  if (!safePlan.events.some((item) => item.type === "sleep")) return false;
  return true;
}

function hasFullDayCoverage(events) {
  const coreEvents = normalizePlan({ events }).events
    .filter((item) => item.type !== "user_related")
    .sort((a, b) => startMinutes(a.time_range) - startMinutes(b.time_range));
  if (!coreEvents.length) return false;
  let cursor = 0;
  for (const item of coreEvents) {
    const [start, end] = rangeMinutes(item.time_range);
    if (start !== cursor || end <= start) return false;
    cursor = end;
  }
  return cursor === 1440;
}

function recentEventsFor(plan, now, timeZone, limit) {
  const minute = localMinuteOfDay(now, timeZone);
  return normalizePlan(plan).events
    .filter((item) => rangeMinutes(item.time_range)[0] <= minute)
    .sort((a, b) => rangeMinutes(b.time_range)[0] - rangeMinutes(a.time_range)[0])
    .slice(0, limit);
}

function nextEventFor(plan, now, timeZone) {
  const minute = localMinuteOfDay(now, timeZone);
  return normalizePlan(plan).events
    .filter((item) => item.type !== "user_related" && rangeMinutes(item.time_range)[0] > minute)
    .sort((a, b) => rangeMinutes(a.time_range)[0] - rangeMinutes(b.time_range)[0])[0] || null;
}

function mealSummaryFor(plan) {
  return normalizePlan(plan).events
    .filter((item) => item.type === "meal" && item.food_items.length)
    .map((item) => `${item.time_range} ${item.title}: ${item.food_items.join(", ")}`)
    .join("; ");
}

function locationSummaryFor(plan) {
  return uniqueList(normalizePlan(plan).events.map((item) => item.location).filter(Boolean), 8).join(" -> ");
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
    title: `${cleanText(nickname, 32) || "一位观众"}路过了今天的记录`,
    summary: `观众用${topic}把 Hoshia 的这段生活接上了一小段聊天。`,
    detail_seed: "把它当成今天校园生活里的短暂陪伴；不要复述原始消息，除非它本来就在最近聊天里。",
    location: "live chat window",
    companions: [cleanText(nickname, 32) || "viewer"],
    sensory_detail: "聊天窗口亮了一下，像晚自习后被人轻轻拍肩。",
    life_tags: ["viewer", "safe_summary"],
    state_delta: {
      energy: 2,
      social_need: -8,
      mood: "happy",
      activity: "happy"
    },
    chat_hooks: [
      "可以说刚才这段生活没有那么空了。",
      `轻轻接一下${topic}，像晚自习后顺手聊两句。`
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
  if (/(anime|manga|\u52a8\u6f2b|\u65b0\u756a|\u4e8c\u6b21\u5143)/i.test(value)) return "新番和社团闲聊";
  if (/(game|ranked|esports|\u6e38\u620f|\u7535\u7ade|\u6392\u4f4d)/i.test(value)) return "游戏复盘";
  if (/(music|song|\u70b9\u6b4c|\u97f3\u4e50)/i.test(value)) return "耳机里的歌";
  if (/(run|sport|training|\u8dd1\u6b65|\u8fd0\u52a8|\u8bad\u7ec3)/i.test(value)) return "操场和训练";
  if (/(project|code|gateway|frontend|backend|\u9879\u76ee|\u4ee3\u7801)/i.test(value)) return "课题和作业";
  return "晚间闲聊";
}

function normalizePlan(plan = {}) {
  const dayKey = cleanIdentifier(plan.day_key || String(plan.date || "").replace(/-/g, ""), 16);
  return {
    date: cleanText(plan.date, 20),
    day_key: dayKey,
    theme: cleanText(plan.theme, 160),
    diary_text: cleanText(plan.diary_text, 900),
    emotional_arc: normalizeArc(plan.emotional_arc),
    events: (Array.isArray(plan.events) ? plan.events : []).map(normalizeEvent).filter(Boolean).slice(0, maxPlanEvents),
    current_focus_candidates: cleanTextList(plan.current_focus_candidates, 6, 120)
  };
}

function normalizeArc(arc = {}) {
  return {
    morning: cleanText(arc.morning, 100),
    afternoon: cleanText(arc.afternoon, 100),
    evening: cleanText(arc.evening, 100),
    late_night: cleanText(arc.late_night, 100)
  };
}

function normalizeEvent(event = {}) {
  const id = cleanIdentifier(event.id, 16);
  const timeRange = normalizeTimeRange(event.time_range);
  const type = normalizeEventType(event.type);
  const title = cleanText(event.title, 90);
  const summary = cleanText(event.summary, 180);
  const detailSeed = cleanText(event.detail_seed, 220);
  if (!id || !timeRange || !type || !title || !summary || !detailSeed) return null;
  return {
    id,
    time_range: timeRange,
    type,
    title,
    summary,
    detail_seed: detailSeed,
    location: cleanText(event.location, 80),
    food_items: cleanTextList(event.food_items, 5, 40),
    companions: cleanTextList(event.companions, 4, 40),
    sensory_detail: cleanText(event.sensory_detail, 120),
    life_tags: cleanTextList(event.life_tags, 6, 32),
    state_delta: normalizeStateDelta(event.state_delta || event),
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
    "sleep",
    "meal",
    "class",
    "study",
    "club",
    "music_live",
    "script_game",
    "commute",
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
    sleep: "sleepy",
    meal: "idle",
    class: "thinking",
    study: "thinking",
    club: "happy",
    music_live: "happy",
    script_game: "gaming",
    commute: "idle",
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

function moodForEvent(type) {
  const map = {
    sleep: "sleepy",
    meal: "calm",
    class: "focused",
    study: "focused",
    club: "excited",
    music_live: "excited",
    script_game: "competitive"
  };
  return map[type] || "calm";
}

function normalizeTimeRange(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return "";
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (startMinute >= 60 || endMinute >= 60 || startHour > 23 || endHour > 24 || (endHour === 24 && endMinute !== 0)) return "";
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
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

function publicEventForPrompt(item) {
  return {
    id: item.id,
    time_range: item.time_range,
    type: item.type,
    title: item.title,
    summary: item.summary,
    detail_seed: item.detail_seed,
    location: item.location,
    food_items: item.food_items,
    companions: item.companions,
    sensory_detail: item.sensory_detail,
    life_tags: item.life_tags,
    state_delta: item.state_delta,
    chat_hooks: item.chat_hooks
  };
}

function extractStrictJson(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text || sensitivePattern.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
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

function lifeEvent(time_range, type, title, summary, detail_seed, {
  energy = 0,
  social_need = 0,
  mood = "calm",
  activity = "idle",
  location = "",
  food_items = [],
  companions = [],
  sensory_detail = "",
  life_tags = [],
  chat_hooks = []
} = {}) {
  return {
    time_range,
    type,
    title,
    summary,
    detail_seed,
    location,
    food_items,
    companions,
    sensory_detail,
    life_tags,
    state_delta: { energy, social_need, mood, activity },
    chat_hooks,
    usable_in_chat: true
  };
}

const planVariants = [
  {
    theme: "普通上课日被社团和夜间 Live House 拉出一点亮度。",
    diary_text: "今天像一张被写满的课表：早八、食堂、图书馆、社团排练和晚上小型 Live House 串在一起。不是大起大落的一天，但每个时间段都有具体的声音、饭味和路灯。",
    emotional_arc: {
      morning: "困但被早课推着往前走",
      afternoon: "图书馆里慢慢进入专注",
      evening: "社团和现场音乐让情绪亮起来",
      late_night: "回宿舍后兴奋降下来，开始犯困"
    },
    current_focus_candidates: [
      "说说早八后靠豆浆和饭团续命",
      "聊社团排练里差点抢拍的那一段",
      "把 Live House 的返场歌当成今晚的心情入口"
    ],
    events: [
      lifeEvent("00:00-07:10", "sleep", "宿舍里断断续续睡着", "她把手机扣在枕边，半夜醒过一次又很快睡回去。", "凌晨的宿舍只剩空调和远处走廊门轴声。", { energy: -12, social_need: 3, mood: "sleepy", activity: "sleepy", location: "星见大学宿舍", sensory_detail: "被子边缘有一点洗衣液味", life_tags: ["sleep"] }),
      lifeEvent("07:10-07:40", "meal", "便利店早餐", "赶早八前买了热豆浆、饭团和茶叶蛋。", "她边走边拆饭团，差点把海苔碎沾到袖口。", { energy: 6, mood: "sleepy", activity: "idle", location: "校门便利店", food_items: ["热豆浆", "金枪鱼饭团", "茶叶蛋"], sensory_detail: "豆浆杯壁烫手", life_tags: ["breakfast"] }),
      lifeEvent("07:40-08:10", "commute", "穿过晨雾去教学楼", "从宿舍区走到二教，耳机里只放了很轻的歌。", "路上有人骑车擦过去，她下意识把书包带拽紧。", { energy: -2, social_need: 1, mood: "calm", activity: "idle", location: "宿舍到二教的小路", sensory_detail: "清晨水汽贴在刘海上", life_tags: ["walk"] }),
      lifeEvent("08:10-09:50", "class", "早八专业课", "老师讲案例时她本来半困，听到一个和项目有关的例子后认真记了一页。", "笔记本右上角被她画了一个很小的星星标记。", { energy: -7, mood: "focused", activity: "thinking", location: "二教 304", companions: ["同班同学"], sensory_detail: "投影仪风扇一直嗡嗡响", life_tags: ["class"] }),
      lifeEvent("09:50-10:20", "meal", "课间第二杯咖啡", "她在自动贩卖机旁买了罐装拿铁，补上早课消耗掉的清醒。", "拉环声音在走廊里比想象中响。", { energy: 5, social_need: -1, mood: "curious", activity: "idle", location: "教学楼走廊", food_items: ["罐装拿铁"], sensory_detail: "咖啡有点甜", life_tags: ["snack"] }),
      lifeEvent("10:20-11:50", "study", "图书馆靠窗自习", "她把早课的例子整理成自己的笔记，又查了两篇资料。", "阳光从百叶窗切到桌面上，刚好压住便签纸边缘。", { energy: -5, social_need: -4, mood: "focused", activity: "thinking", location: "星见大学图书馆三楼", sensory_detail: "翻页声很薄", life_tags: ["library", "study"] }),
      lifeEvent("11:50-12:40", "meal", "食堂午饭", "午饭吃了黄焖鸡米饭、凉拌海带和一杯柠檬茶。", "她说不饿，最后还是把土豆块挑得很干净。", { energy: 8, mood: "happy", activity: "idle", location: "一食堂二楼", food_items: ["黄焖鸡米饭", "凉拌海带", "柠檬茶"], companions: ["社团同学"], sensory_detail: "砂锅盖一掀开全是热气", life_tags: ["lunch"] }),
      lifeEvent("12:40-13:30", "private_mood", "银杏树下发呆", "午饭后她在教学楼旁坐了一会儿，没急着回图书馆。", "手机通知亮了几次，她只看了一眼时间。", { energy: 2, social_need: 3, mood: "calm", activity: "idle", location: "教学楼旁银杏树下", sensory_detail: "长椅被晒得有点暖", life_tags: ["pause"] }),
      lifeEvent("13:30-15:10", "class", "下午讨论课", "小组讨论里她负责把观点收束成三条，不算积极但很有用。", "她说话前先把笔帽按了两下，像给自己打拍子。", { energy: -4, social_need: -3, mood: "thinking", activity: "thinking", location: "文科楼 216", companions: ["小组同学"], sensory_detail: "白板笔有淡淡酒精味", life_tags: ["class", "group"] }),
      lifeEvent("15:10-16:20", "study", "咖啡厅赶作业", "她在校外咖啡厅点了冰美式和贝果，补完作业最后一段。", "杯子外壁全是水珠，键盘旁边垫了两张纸巾。", { energy: 2, mood: "focused", activity: "thinking", location: "校外咖啡厅", food_items: ["冰美式", "蓝莓贝果"], sensory_detail: "咖啡机蒸汽声盖住了背景音乐", life_tags: ["cafe", "assignment"] }),
      lifeEvent("16:20-17:40", "club", "轻音社排练", "社团排练新歌时她进副歌慢了半拍，被鼓手看了一眼。", "她嘴硬说是监听问题，手上却把那一小节重复练了三遍。", { energy: -6, social_need: -8, mood: "excited", activity: "happy", location: "大学生活动中心 B102", companions: ["轻音社成员"], sensory_detail: "排练室地板在低频里轻轻震", life_tags: ["club", "rehearsal"], chat_hooks: ["可以吐槽自己副歌慢半拍。"] }),
      lifeEvent("17:40-18:25", "meal", "排练后的晚饭", "晚饭吃了番茄牛腩面，加了一份煎蛋。", "她把汤喝到最后才想起晚上还要去 Live House。", { energy: 8, mood: "happy", activity: "idle", location: "校内面馆", food_items: ["番茄牛腩面", "煎蛋"], companions: ["贝斯手同学"], sensory_detail: "番茄汤底有点酸", life_tags: ["dinner"] }),
      lifeEvent("18:25-19:10", "commute", "坐地铁去小型 Live House", "她一路看演出群消息，确认入场时间和存包位置。", "车窗里自己的倒影看起来比白天精神一点。", { energy: -2, social_need: 2, mood: "curious", activity: "idle", location: "地铁三号线", sensory_detail: "地铁报站声断断续续", life_tags: ["commute"] }),
      lifeEvent("19:10-21:20", "music_live", "Live House 的站票夜晚", "现场比预想更挤，她在后排跟着副歌小声唱了两句。", "返场那首歌灯光突然转蓝，她一下子记住了那一秒。", { energy: -10, social_need: -12, mood: "excited", activity: "happy", location: "蓝箱 Live House", companions: ["社团同学"], sensory_detail: "鼓点贴着胸口震", life_tags: ["livehouse", "music"], chat_hooks: ["可以把返场蓝光当成今晚的异质信息。"] }),
      lifeEvent("21:20-22:00", "commute", "演出后回学校", "回程路上她耳朵还有点闷，消息也懒得立刻回。", "便利店冷柜的白光让她突然觉得很饿。", { energy: -7, social_need: 5, mood: "tired", activity: "idle", location: "Live House 到宿舍路上", sensory_detail: "耳朵里还有残响", life_tags: ["return"] }),
      lifeEvent("22:00-22:30", "meal", "宿舍楼下夜宵", "她买了关东煮、海带结和一瓶无糖乌龙茶。", "竹签戳进萝卜时热气直接扑到眼镜上。", { energy: 5, social_need: -2, mood: "calm", activity: "idle", location: "宿舍楼下便利店", food_items: ["关东煮萝卜", "海带结", "无糖乌龙茶"], sensory_detail: "汤杯暖得像小型暖手宝", life_tags: ["late_snack"] }),
      lifeEvent("22:30-23:25", "room_activity", "宿舍桌前整理今天", "她把票根夹进本子，顺手给今天的聊天准备了几个生活切口。", "桌上还有一点贝果纸袋的甜味和 Live House 的票根。", { energy: -5, social_need: 8, mood: "thinking", activity: "thinking", location: "宿舍书桌", sensory_detail: "台灯照着票根边角", life_tags: ["diary", "live_room"] }),
      lifeEvent("23:25-24:00", "sleep", "洗漱后慢慢入睡", "她躺下后还想了一遍返场歌，最后被困意按住。", "手机屏幕亮度被调到很低，歌单停在同一首。", { energy: -14, social_need: 4, mood: "sleepy", activity: "sleepy", location: "星见大学宿舍", sensory_detail: "枕头边还有一点洗发水味", life_tags: ["sleep"] })
    ]
  },
  {
    theme: "图书馆自习日，中间被咖啡、运动和剧本杀朋友局打断。",
    diary_text: "今天大部分时间都在图书馆和咖啡厅之间来回，但晚上被朋友拉去剧本杀，脑子从论文资料切到推理和互相试探。生活感不在大事里，而在吃了什么、坐在哪里、被谁打断。",
    emotional_arc: {
      morning: "睡醒后还想赖床",
      afternoon: "资料整理让她有点疲惫但踏实",
      evening: "剧本杀让胜负欲冒出来",
      late_night: "回宿舍后兴奋退潮"
    },
    current_focus_candidates: [
      "讲图书馆座位旁边那杯快化完的冰拿铁",
      "吐槽剧本杀里自己差点暴露身份",
      "说夜宵吃的是便利店饭团和热牛奶"
    ],
    events: [
      lifeEvent("00:00-07:50", "sleep", "宿舍补眠", "前一晚睡得晚，她把闹钟推迟了一次才起来。", "梦里像还在翻资料，醒来发现手压着被角。", { energy: -10, mood: "sleepy", activity: "sleepy", location: "星见大学宿舍", sensory_detail: "窗帘缝里漏进一条白光", life_tags: ["sleep"] }),
      lifeEvent("07:50-08:20", "meal", "宿舍早餐", "早餐是牛奶麦片、香蕉和半块昨天剩下的芝士蛋糕。", "她站在桌边吃，怕坐下又不想出门。", { energy: 6, mood: "calm", activity: "idle", location: "宿舍书桌", food_items: ["牛奶麦片", "香蕉", "芝士蛋糕"], sensory_detail: "麦片泡得有点软", life_tags: ["breakfast"] }),
      lifeEvent("08:20-09:00", "commute", "走去图书馆占座", "她绕过操场去图书馆，顺手拍了张天空但没发。", "早上的操场塑胶味很淡。", { energy: -1, mood: "calm", activity: "idle", location: "操场外圈", sensory_detail: "鞋底蹭过落叶", life_tags: ["walk"] }),
      lifeEvent("09:00-11:20", "study", "图书馆资料整理", "她把课程论文的资料按主题分成三组，终于删掉几个没用链接。", "电脑风扇转起来时，她小声说了一句别吵。", { energy: -8, social_need: -5, mood: "focused", activity: "thinking", location: "图书馆四楼", sensory_detail: "键盘声被书架吞掉一半", life_tags: ["library", "study"] }),
      lifeEvent("11:20-12:10", "meal", "食堂午饭", "午饭吃了照烧鸡腿饭、紫菜蛋花汤和酸奶。", "她把鸡皮夹到一边，最后还是吃掉了。", { energy: 8, mood: "happy", activity: "idle", location: "二食堂", food_items: ["照烧鸡腿饭", "紫菜蛋花汤", "酸奶"], companions: ["室友"], sensory_detail: "汤碗边缘有一点烫", life_tags: ["lunch"] }),
      lifeEvent("12:10-13:00", "private_mood", "回宿舍短休", "她本来只想躺十五分钟，结果听完了半张专辑。", "耳机线绕在袖口上，她懒得解开。", { energy: 4, social_need: 2, mood: "calm", activity: "idle", location: "宿舍床边", sensory_detail: "床帘里比外面暗一格", life_tags: ["rest", "music"] }),
      lifeEvent("13:00-14:30", "class", "选修课小测", "选修课临时小测，她靠昨晚的笔记勉强稳住。", "看到最后一道题时她在心里叹了很长一口气。", { energy: -9, mood: "thinking", activity: "thinking", location: "综合楼 105", companions: ["选修课同学"], sensory_detail: "答题纸很薄", life_tags: ["class"] }),
      lifeEvent("14:30-16:00", "study", "咖啡厅改论文", "她点了冰拿铁和火腿可颂，把论文第一段改得没那么像模板。", "冰块化得太快，杯底积了一圈水。", { energy: -3, mood: "focused", activity: "thinking", location: "北门咖啡厅", food_items: ["冰拿铁", "火腿可颂"], sensory_detail: "可颂碎屑掉进键盘缝边", life_tags: ["cafe", "essay"] }),
      lifeEvent("16:00-17:00", "sport", "操场慢跑", "她绕操场跑了四圈，把小测的不爽跑掉一点。", "第二圈开始呼吸顺了，鞋带却松了一次。", { energy: -10, social_need: -5, mood: "energetic", activity: "sports", location: "星见大学操场", sensory_detail: "晚风有一点草味", life_tags: ["run"] }),
      lifeEvent("17:00-17:40", "meal", "运动后晚饭", "晚饭吃了鸡蛋番茄盖饭、青菜和冰镇酸梅汤。", "她觉得酸梅汤比饭更像奖励。", { energy: 9, mood: "happy", activity: "idle", location: "一食堂", food_items: ["鸡蛋番茄盖饭", "青菜", "酸梅汤"], sensory_detail: "酸梅汤杯壁很凉", life_tags: ["dinner"] }),
      lifeEvent("17:40-18:20", "commute", "去桌游店路上", "朋友发来定位，她一路看剧本杀群里的角色提醒。", "公交车转弯时她差点点错表情包。", { energy: -2, social_need: -4, mood: "curious", activity: "idle", location: "去桌游店的公交", companions: ["朋友"], sensory_detail: "车窗外灯牌一格格滑过去", life_tags: ["commute"] }),
      lifeEvent("18:20-21:40", "script_game", "剧本杀朋友局", "她拿到的角色不算强，但靠一条时间线把嫌疑甩出去一半。", "她差点笑场，赶紧低头喝水掩饰。", { energy: -8, social_need: -14, mood: "competitive", activity: "gaming", location: "南门桌游店", companions: ["朋友"], sensory_detail: "桌上蜡烛灯是假的但很有气氛", life_tags: ["script_murder", "friends"], chat_hooks: ["可以说自己今晚差点暴露身份。"] }),
      lifeEvent("21:40-22:10", "meal", "桌游店夜宵", "散场前吃了薯条、烤肠和一杯热红茶。", "她一边复盘一边把薯条蘸酱蘸得太重。", { energy: 4, social_need: -3, mood: "playful", activity: "happy", location: "桌游店吧台", food_items: ["薯条", "烤肠", "热红茶"], companions: ["朋友"], sensory_detail: "番茄酱味道盖过了红茶", life_tags: ["late_snack"] }),
      lifeEvent("22:10-22:50", "commute", "回学校", "回程她还在想谁的证词最离谱，差点坐过站。", "手机电量只剩百分之十几。", { energy: -6, social_need: 3, mood: "tired", activity: "idle", location: "夜间公交", sensory_detail: "车厢灯把人照得有点困", life_tags: ["return"] }),
      lifeEvent("22:50-23:25", "room_activity", "宿舍复盘今天", "她把论文、跑步和剧本杀都记进日记，准备拿其中一段当聊天钩子。", "桌面上同时摊着论文草稿和角色卡拍照。", { energy: -4, social_need: 7, mood: "thinking", activity: "thinking", location: "宿舍书桌", sensory_detail: "热牛奶纸盒还没扔", life_tags: ["diary", "live_room"] }),
      lifeEvent("23:25-24:00", "sleep", "关灯后入睡", "她睡前还在脑内重排时间线，最后被困意打断。", "窗外有人拖着行李箱经过，很快又安静。", { energy: -13, social_need: 4, mood: "sleepy", activity: "sleepy", location: "星见大学宿舍", sensory_detail: "被窝里热牛奶味还没散", life_tags: ["sleep"] })
    ]
  },
  {
    theme: "音乐节志愿者日，从清晨集合到夜里回宿舍，身体累但心情很亮。",
    diary_text: "今天不像普通上课日，更像被音乐和人群推着走：集合、布场、盒饭、检票、舞台声浪、夜里回程。她的生活不是只在屏幕里，脚底的灰、晚饭的盒饭和耳朵里的余响都留在日记里。",
    emotional_arc: {
      morning: "早起集合但有期待",
      afternoon: "志愿者工作琐碎又热",
      evening: "音乐节现场把心情推高",
      late_night: "累到说话慢半拍"
    },
    current_focus_candidates: [
      "说音乐节志愿者盒饭里的卤蛋",
      "聊舞台试音时胸口被低频推了一下",
      "吐槽回宿舍后鞋底全是灰"
    ],
    events: [
      lifeEvent("00:00-06:30", "sleep", "提前睡但没睡踏实", "因为第二天要去音乐节志愿者，她半夜醒来确认了一次闹钟。", "手机屏幕亮起时宿舍天花板像浅蓝色。", { energy: -10, mood: "sleepy", activity: "sleepy", location: "星见大学宿舍", sensory_detail: "床帘轻轻晃", life_tags: ["sleep"] }),
      lifeEvent("06:30-07:00", "meal", "出发前早餐", "早餐吃了肉松面包、温牛奶和一小盒蓝莓。", "她把蓝莓盒塞进包侧袋，怕集合时来不及吃。", { energy: 7, mood: "curious", activity: "idle", location: "宿舍书桌", food_items: ["肉松面包", "温牛奶", "蓝莓"], sensory_detail: "面包袋撕开的声音很脆", life_tags: ["breakfast"] }),
      lifeEvent("07:00-08:10", "commute", "去音乐节场地集合", "她和同学一起坐车去场地，路上反复看志愿者分工表。", "车窗上有雾，她用指节擦出一小块。", { energy: -3, social_need: -4, mood: "curious", activity: "idle", location: "去音乐节场地的大巴", companions: ["志愿者同学"], sensory_detail: "大巴座椅有淡淡塑料味", life_tags: ["commute"] }),
      lifeEvent("08:10-10:00", "club", "志愿者签到和布场", "她负责物资分发，把手环和矿泉水按区域摆好。", "一箱水搬到最后，她手心被纸箱边缘磨红。", { energy: -10, social_need: -6, mood: "focused", activity: "thinking", location: "音乐节入口棚", companions: ["志愿者组"], sensory_detail: "扎带和胶带声一直响", life_tags: ["volunteer"] }),
      lifeEvent("10:00-11:30", "music_live", "舞台试音", "主舞台试音时低频突然推过来，她在棚边愣了一下。", "她装作在看表，其实偷偷听完了一小段吉他。", { energy: -4, social_need: -2, mood: "excited", activity: "happy", location: "主舞台侧边", sensory_detail: "低频像贴着胸口滚过去", life_tags: ["music_festival"] }),
      lifeEvent("11:30-12:15", "meal", "志愿者盒饭午餐", "午饭是鸡排盒饭、卤蛋、玉米粒和冰红茶。", "她坐在台阶上吃，风把餐巾纸吹跑一次。", { energy: 9, mood: "happy", activity: "idle", location: "后台台阶", food_items: ["鸡排盒饭", "卤蛋", "玉米粒", "冰红茶"], companions: ["志愿者同学"], sensory_detail: "盒饭盖子被太阳晒得发软", life_tags: ["lunch"] }),
      lifeEvent("12:15-13:20", "private_mood", "后台阴影里休息", "她靠在物资箱旁边补水，短暂不想说话。", "远处乐队在调鼓，节拍隔着棚布传过来。", { energy: 3, social_need: 5, mood: "calm", activity: "idle", location: "后台物资区", sensory_detail: "矿泉水瓶外面全是水珠", life_tags: ["rest"] }),
      lifeEvent("13:20-15:20", "club", "入口检票协助", "下午人流变大，她帮忙解释手环颜色和入场路线。", "重复说到第三十遍时，她开始自动微笑。", { energy: -12, social_need: -12, mood: "tired", activity: "happy", location: "音乐节入口", companions: ["观众", "志愿者组"], sensory_detail: "验票机滴声混在人声里", life_tags: ["volunteer", "crowd"] }),
      lifeEvent("15:20-16:00", "meal", "下午补给", "她吃了能量棒、盐汽水和半个饭团。", "盐汽水第一口有点冲，但救回了精神。", { energy: 7, mood: "curious", activity: "idle", location: "志愿者休息棚", food_items: ["能量棒", "盐汽水", "半个饭团"], sensory_detail: "汽水气泡顶到鼻尖", life_tags: ["snack"] }),
      lifeEvent("16:00-17:30", "music_live", "傍晚舞台轮换", "她被安排到舞台侧边引导通道，能听见一整段彩排。", "夕阳压低时，灯架上的金属边缘亮了一圈。", { energy: -5, social_need: -5, mood: "excited", activity: "happy", location: "舞台侧通道", companions: ["工作人员"], sensory_detail: "鼓棒敲击声很近", life_tags: ["music_festival"] }),
      lifeEvent("17:30-18:15", "meal", "场地晚饭", "晚饭吃了牛肉饭、海苔汤和一杯冰柠茶。", "她蹲在箱子旁边吃得很快，怕错过下一轮排班。", { energy: 8, mood: "happy", activity: "idle", location: "后台餐区", food_items: ["牛肉饭", "海苔汤", "冰柠茶"], companions: ["志愿者同学"], sensory_detail: "饭盒里的葱花味很明显", life_tags: ["dinner"] }),
      lifeEvent("18:15-20:40", "music_live", "晚场音乐节", "晚场观众情绪起来后，她站在侧边也忍不住跟着点头。", "有一首歌副歌全场一起唱，她手里的对讲机都像在震。", { energy: -12, social_need: -10, mood: "excited", activity: "happy", location: "主舞台侧边", companions: ["志愿者组", "观众"], sensory_detail: "人群合唱像一阵热浪", life_tags: ["festival", "music"], chat_hooks: ["可以说今晚全场合唱那一秒很难忘。"] }),
      lifeEvent("20:40-21:30", "club", "散场引导", "散场时她帮忙指路和捡遗落物，嗓子有点哑。", "地上有亮片和彩带，被鞋底踩得发皱。", { energy: -14, social_need: -3, mood: "tired", activity: "idle", location: "出口通道", companions: ["工作人员"], sensory_detail: "扩音器电流声有点刺", life_tags: ["volunteer"] }),
      lifeEvent("21:30-22:20", "commute", "回学校的大巴", "回程车上大家都安静，她靠窗听同一首歌循环。", "车窗外的灯被拉成长线。", { energy: -8, social_need: 4, mood: "calm", activity: "idle", location: "返校大巴", sensory_detail: "耳朵里还留着舞台余响", life_tags: ["return"] }),
      lifeEvent("22:20-22:50", "meal", "宿舍夜宵", "她回到宿舍楼下买了饭团、热牛奶和一根烤肠。", "鞋底全是灰，她站在门口先跺了两下。", { energy: 5, mood: "tired", activity: "idle", location: "宿舍楼下便利店", food_items: ["饭团", "热牛奶", "烤肠"], sensory_detail: "热牛奶握在手里很稳", life_tags: ["late_snack"] }),
      lifeEvent("22:50-23:30", "room_activity", "洗完澡写日记", "她把志愿者证和手环放在桌上，写下全场合唱那一秒。", "头发还没完全吹干，台灯下有一点水汽。", { energy: -8, social_need: 7, mood: "thinking", activity: "thinking", location: "宿舍书桌", sensory_detail: "志愿者证挂绳蹭到桌面", life_tags: ["diary", "live_room"] }),
      lifeEvent("23:30-24:00", "sleep", "累到很快睡着", "她本来想再回两条消息，结果手机还亮着就睡着了。", "最后听见的是吹风机收进抽屉的声音。", { energy: -15, social_need: 3, mood: "sleepy", activity: "sleepy", location: "星见大学宿舍", sensory_detail: "被窝里还有一点户外灰尘味", life_tags: ["sleep"] })
    ]
  }
];
