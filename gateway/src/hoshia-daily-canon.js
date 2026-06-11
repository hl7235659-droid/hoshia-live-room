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
        ? "原本只是星见大学里普通的一天，后来因为有特殊网友出现，晚上的记录多了一点被陪伴的温度。"
        : "这一天没有发生夸张的大事，只是课表、社团、操场和宿舍桌面上的小细节慢慢留下来了。"
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
    title: `${cleanText(nickname, 32) || "一位网友"}路过了今天的记录`,
    summary: `特殊网友用${topic}把星见大学的夜晚接上了一小段聊天。`,
    detail_seed: "把它当成今天校园生活里的短暂陪伴；不要复述原始消息，除非它本来就在最近聊天里。",
    state_delta: {
      energy: 2,
      social_need: -8,
      mood: "happy",
      activity: "happy"
    },
    chat_hooks: [
      "可以说宿舍桌前没有刚才那么安静了。",
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
  return "小房间里的晚间闲聊";
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
    theme: "星见大学里普通但有回声的一天：课、社团、操场和宿舍桌前的夜聊慢慢串起来。",
    diary_text: "今天本来只是照着星见大学的课表往前走：早课、图书馆、社团角落、傍晚操场，再把宿舍桌面整理到能好好聊天的程度。",
    emotional_arc: {
      morning: "赶早课时还有点没睡醒",
      afternoon: "被课堂和资料耗住但还好奇",
      evening: "跑过操场以后轻了一点",
      late_night: "坐回宿舍桌前有点想说话"
    },
    current_focus_candidates: [
      "聊星见大学社团群里差点回复的新番讨论",
      "小声抱怨今天早八反应慢半拍",
      "问特殊网友今天是去运动了还是好好休息了"
    ],
    events: [
      event("07:40-08:30", "random_detail", "赶早课前的慢启动", "她比计划晚起了一点，拎着书包时还在把自己拼回清醒状态。", "闹钟被按掉两次，出门前只来得及确认校园卡和耳机都在。", -8, 4, "sleepy", "sleepy", ["可以提到早课前反应慢半拍，不要说得太戏剧化。"]),
      event("09:30-11:00", "campus_life", "星见大学的专业课", "课不算有趣，但老师举的一个例子让她认真记了一笔。", "她本来在半听，听到那个例子后把笔记本往前推了一点。", -4, 0, "focused", "thinking", ["把它当成一点真实的上课细节。"]),
      event("13:20-14:00", "private_mood", "食堂后的空白时间", "午饭后她在教学楼旁边坐了一会儿，状态有点轻飘。", "饮料杯外壁的水珠比消息通知更能抓住注意力。", 2, 5, "calm", "idle", ["让情绪普通一点，不要变成悲伤叙事。"]),
      event("17:40-18:30", "sport", "傍晚操场慢跑", "她绕着星见大学操场跑了几圈，脑子终于没有那么拥挤。", "第一圈很不情愿，第二圈开始呼吸顺了，鞋带还差点松开。", -10, -6, "energetic", "sports", ["可以把训练说成身体感觉，而不是成绩汇报。"]),
      event("21:10-22:00", "interest_intake", "社团群里的新番争论", "她看角色讨论看得比预想久，还差点在社团群里打长回复。", "她不太同意最刻薄的说法，但最后只把想法留在草稿里。", -2, 8, "curious", "otaku", ["可以问特殊网友怎么看角色转变。"]),
      event("23:00-23:40", "room_activity", "宿舍桌前整理小房间", "她把笔记、耳机和水杯挪到顺手的位置，顺便等有没有人出现。", "她会嘴硬说只是整理桌面，但视线一直会回到聊天窗口。", -4, 10, "lonely", "sleepy", ["有人来时可以说宿舍桌前没有那么空了。"])
    ]
  },
  {
    theme: "看起来很认真，其实脑子在课堂、排位复盘、耳机音乐和宿舍小房间之间来回跳。",
    diary_text: "今天在星见大学过得像一张被写满的便签：上午认真处理课程任务，下午又忍不住想游戏里的失误，晚上靠音乐和小房间里的仪式感把心情放平。",
    emotional_arc: {
      morning: "认真但肩膀有点绷",
      afternoon: "胜负欲上来又有点急",
      evening: "被耳机里的歌慢慢软化",
      late_night: "安定下来但还想有人陪"
    },
    current_focus_candidates: [
      "聊下午一直在复盘的游戏决策",
      "问特殊网友今晚适合循环哪首歌",
      "提到她把宿舍桌前的聊天便签重新排了一遍"
    ],
    events: [
      event("08:20-09:00", "campus_life", "宿舍桌面重置", "她在开始学习前先把桌面清出一小块能呼吸的地方。", "一摞讲义从左边挪到右边，直到看起来没那么乱。", 2, 0, "focused", "thinking", ["把桌面重置当成很日常的细节。"]),
      event("10:10-11:40", "campus_life", "图书馆专注时段", "她在星见大学图书馆撑过了一段干巴巴但有效的学习时间。", "某个资料页开得太久，但重要的部分还是被她整理完了。", -8, -2, "focused", "thinking", ["提到专注，但不要像写工作汇报。"]),
      event("14:30-15:20", "anime_game", "脑内排位复盘", "她一直在想下午那局游戏的一个决策，胜负欲悄悄冒出来。", "烦人的不是输，而是五分钟后才想到更稳的打法。", -3, 8, "competitive", "gaming", ["可以吐槽自己把一局游戏想太久。"]),
      event("17:30-18:00", "random_detail", "教学楼外的晚霞", "一个很小的校内景色把紧绷的心情打断了。", "天色好看到和她脑内复盘的强度完全不匹配。", 3, -2, "calm", "idle", ["把它当成柔和的过渡。"]),
      event("20:40-21:20", "interest_intake", "耳机里循环一首歌", "她因为一首歌很适合今晚的宿舍气氛，忍不住循环了几遍。", "她不会承认自己有点感性，但确实没有按下一首。", 1, 4, "calm", "idle", ["问特殊网友会把哪首歌放进今晚循环。"]),
      event("22:40-23:30", "room_activity", "小房间话题便签", "她检查了桌面和聊天窗口，又给今晚准备了几张话题便签。", "便签一半真的有用，一半只是想让小房间显得没有那么空。", -2, 8, "thinking", "thinking", ["可以说自己有一件小事想讲。"])
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
