import { normalizePostInput } from "./hoshia-life-memory.js";
import { sanitizeModuleEvent } from "./module-context.js";

const characterId = "hoshia";
const dailySourceType = "daily_state";
const pulseSourceType = "state_pulse";
const newsTopicSourceType = "news_topic";
const defaultTimeZone = "Asia/Shanghai";
const defaultDailyMin = 1;
const defaultDailyMax = 5;

export function createHoshiaDailyPostService({
  db,
  visualStateService,
  clock = () => new Date(),
  enabled = false,
  dailyLimit = defaultDailyMax,
  dailyMin = defaultDailyMin,
  dailyMax = null,
  minIntervalMinutes = 0,
  minIntervalMs = null,
  activeWindow = null,
  timeZone = defaultTimeZone,
  roomId = ""
} = {}) {
  const safeDailyMin = normalizeDailyPostMinimum(dailyMin);
  const safeDailyMax = normalizeDailyPostMaximum(dailyMax ?? dailyLimit, safeDailyMin);
  const safeMinIntervalMs = normalizeMinIntervalMs(minIntervalMs ?? minutesToMs(minIntervalMinutes));
  const safeActiveWindow = normalizeActiveWindow(activeWindow);
  const safeTimeZone = cleanText(timeZone, 64) || defaultTimeZone;

  return {
    planDailyPost({ now = clock(), state = null, sequence = 1, sourceType = dailySourceType, topic = null, diaryEvent = null, recentPosts = [] } = {}) {
      const currentNow = asDate(now);
      const currentState = normalizeVisualState(state || readVisualState(visualStateService));
      const safeSourceType = normalizeDailySourceType(sourceType);
      const safeSequence = normalizeSequence(sequence);
      const safeTopic = safeSourceType === newsTopicSourceType ? normalizeNewsTopic(topic, currentNow) : null;
      if (safeSourceType === newsTopicSourceType && !safeTopic) {
        return {
          ok: false,
          postInput: null,
          state: currentState,
          day_key: dayKeyFor(currentNow, safeTimeZone),
          source_type: safeSourceType,
          sequence: safeSequence,
          reason: "news_topic_invalid"
        };
      }
      const postInput = normalizePostInput({
        id: postIdFor({
          sourceType: safeSourceType,
          dayKey: dayKeyFor(currentNow, safeTimeZone),
          sequence: safeSequence,
          state: currentState
        }),
        content: safeSourceType === newsTopicSourceType
          ? buildNewsTopicPostContent(safeTopic, currentState, currentNow, safeTimeZone)
          : buildDailyPostContent(currentState, currentNow, safeTimeZone, {
            diaryEvent,
            recentPosts,
            sequence: safeSequence
          }),
        image_url: "",
        mood: currentState.mood,
        activity: currentState.activity,
        source_type: safeSourceType,
        created_at: currentNow.toISOString()
      }, currentNow);

      return {
        ok: Boolean(postInput),
        postInput,
        state: currentState,
        day_key: dayKeyFor(currentNow, safeTimeZone),
        source_type: safeSourceType,
        sequence: safeSequence,
        topic: safeTopic
      };
    },

    listDailyPostsForDate({ now = clock() } = {}) {
      return listDailyPostsForDate({
        db,
        now: asDate(now),
        limit: safeDailyMax,
        timeZone: safeTimeZone
      });
    },

    tick({ force = false, ignoreLimit = false, now = clock(), newsTopic = null, state = null, diaryEvent = null } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      if (!force && !enabled) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_post_disabled",
          daily_count: 0,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          post: null,
          day_key: dayKey
        };
      }

      if (!force && !isWithinActiveWindow(currentNow, safeActiveWindow, safeTimeZone)) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_post_outside_active_window",
          daily_count: 0,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          post: null,
          day_key: dayKey
        };
      }

      assertPostStore(db);
      const existing = listDailyPostsForDate({
        db,
        now: currentNow,
        limit: 100,
        timeZone: safeTimeZone
      });
      if (!ignoreLimit && existing.length >= safeDailyMax) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_max_reached",
          post: existing[0] || null,
          daily_count: existing.length,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          day_key: dayKey
        };
      }

      if (!force && hasRecentDailyPost(existing, currentNow, safeMinIntervalMs)) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_post_min_interval",
          post: existing[0] || null,
          daily_count: existing.length,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          day_key: dayKey
        };
      }

      const currentState = normalizeVisualState(state || readVisualState(visualStateService));
      const requestedNewsTopic = hasNewsTopicInput(newsTopic);
      const safeNewsTopic = normalizeNewsTopic(newsTopic, currentNow);
      const newsTopicCount = countDailyPostsBySource(existing, newsTopicSourceType);
      if (requestedNewsTopic && !safeNewsTopic) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "news_topic_invalid",
          daily_count: existing.length,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          post: null,
          day_key: dayKey
        };
      }
      if (requestedNewsTopic && newsTopicCount >= 1) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "news_topic_daily_max_reached",
          post: existing.find((post) => post.source_type === newsTopicSourceType) || null,
          daily_count: existing.length,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          day_key: dayKey
        };
      }
      const sourceType = safeNewsTopic && newsTopicCount < 1
        ? newsTopicSourceType
        : (existing.length < safeDailyMin ? dailySourceType : pulseSourceType);
      const plan = this.planDailyPost({
        now: currentNow,
        state: currentState,
        sequence: existing.length + 1,
        sourceType,
        topic: safeNewsTopic,
        diaryEvent,
        recentPosts: existing
      });
      if (!plan.postInput) {
        return {
          ok: false,
          created: false,
          skipped: true,
          reason: "daily_post_invalid",
          daily_count: existing.length,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          post: null,
          day_key: plan.day_key
        };
      }

      const post = db.createHoshiaPost(plan.postInput);
      return {
        ok: true,
        created: true,
        skipped: false,
        reason: "daily_post_created",
        post,
        postInput: plan.postInput,
        state: plan.state,
        moduleEvent: createHoshiaDailyPostCreatedEvent(post, plan.state, {
          roomId,
          occurredAt: post?.created_at || currentNow.toISOString(),
          sourceType: plan.source_type
        }),
        daily_count: existing.length + 1,
        daily_min: safeDailyMin,
        daily_max: safeDailyMax,
        day_key: plan.day_key
      };
    }
  };
}

export function createHoshiaDailyPostCreatedEvent(post, state, {
  roomId = "",
  occurredAt = new Date().toISOString(),
  sourceType = post?.source_type || dailySourceType
} = {}) {
  if (!post) return null;
  const currentState = normalizeVisualState(state || post);
  const safeSourceType = normalizeDailySourceType(sourceType);
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "hoshia_daily_post",
    event_type: "hoshia_daily_post.created",
    summary_hint: `Hoshia created a ${safeSourceType} ${currentState.activity}/${currentState.mood} post.`,
    memory_eligible: true,
    memory_kind: "hoshia_daily_post",
    retention_days: 30,
    occurred_at: occurredAt,
    data: {
      activity: currentState.activity,
      mood: currentState.mood,
      source: safeSourceType,
      reason: reasonForSourceType(safeSourceType)
    }
  });
}

export function buildDailyPostContent(state = {}, now = new Date(), timeZone = defaultTimeZone, context = {}) {
  const currentState = normalizeVisualState(state);
  const rhythm = campusRhythmFor(asDate(now), timeZone);
  const campusLine = campusTemplateForState(currentState, rhythm, context);
  if (campusLine) return cleanText(campusLine, 700);
  const repeatCount = repeatedStatePostCount(context.recentPosts, currentState);
  const template = repeatCount > 0
    ? alternateTemplateForState(currentState, rhythm, context)
    : templateForState(currentState, rhythm);
  const detailLine = diaryEventLine(context.diaryEvent, currentState, repeatCount);
  const energyLine = repeatCount > 0 ? variedEnergyLineFor(currentState, context.sequence) : energyLineFor(currentState);
  return cleanText(`${template} ${detailLine || energyLine}${socialLineFor(currentState)}`, 700);
}

export function buildNewsTopicPostContent(topic = {}, state = {}, now = new Date(), timeZone = defaultTimeZone) {
  const safeTopic = normalizeNewsTopic(topic, now);
  if (!safeTopic) return "";
  const currentState = normalizeVisualState(state);
  const campusRhythm = campusRhythmFor(asDate(now), timeZone);
  const campusTone = campusStateTone(currentState);
  const campusHook = pickFirst(safeTopic.meme_hooks) || pickFirst(safeTopic.reply_hooks) || safeTopic.reaction_style;
  const campusReaction = campusHook
    ? `第一反应是「${campusHook}」，感觉很适合拿来当今晚宿舍聊天的开场。`
    : `第一反应有点${safeTopic.reaction_style || "想吐槽"}，先贴在这里等晚点慢慢聊。`;
  return cleanText(`${campusRhythm}${campusTone}看到一个话题：${safeTopic.post_seed}。${campusReaction} 你们会怎么接这句话？`, 700);
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

export function normalizeDailyPostLimit(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(number, 10));
}

export function normalizeDailyPostMinimum(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return defaultDailyMin;
  return Math.max(1, Math.min(number, defaultDailyMax));
}

export function normalizeDailyPostMaximum(value, minimum = defaultDailyMin) {
  const number = Math.floor(Number(value));
  const fallback = defaultDailyMax;
  const safeMinimum = normalizeDailyPostMinimum(minimum);
  if (!Number.isFinite(number)) return Math.max(safeMinimum, fallback);
  return Math.max(safeMinimum, Math.min(number, defaultDailyMax));
}

function campusTemplateForState(state, rhythm, context = {}) {
  const repeatCount = repeatedStatePostCount(context.recentPosts, state);
  const event = normalizeDiaryEvent(context.diaryEvent);
  const eventLine = campusEventLine(event, repeatCount);
  const base = campusBaseLineForState(state, rhythm, repeatCount);
  const social = campusSocialLineFor(state);
  return [base, eventLine, social].filter(Boolean).join(" ");
}

function campusBaseLineForState(state, rhythm, repeatCount = 0) {
  const again = repeatCount > 0 ? "又想补一条近况：" : "";
  const exact = {
    "gaming:competitive": `${rhythm}${again}下午那局游戏还在脑子里回放，越想越觉得当时可以更稳一点。先不嘴硬，等晚点再复盘。`,
    "gaming:annoyed": `${rhythm}${again}排位留下了一点不服气，键盘都快被我盯出火花了。先去倒杯水，别把宿舍气氛也打急。`,
    "sports:energetic": `${rhythm}${again}从星见大学操场回来反而精神了一点，水杯、毛巾和耳机都排在桌边，像在提醒我别趴下。`,
    "sports:tired": `${rhythm}${again}训练后腿有点沉，拉伸完只想靠着椅背慢慢喝水。累归累，身体好像真的被叫醒了。`,
    "otaku:excited": `${rhythm}${again}社团群里聊到喜欢的片段，差点把抱枕举起来给全宿舍看。先记下来，晚点再慢慢讲。`,
    "otaku:curious": `${rhythm}${again}翻了一点新番和角色讨论，越看越想整理一个小小推荐清单。`,
    "sleepy:sleepy": `${rhythm}${again}宿舍灯光刚刚好，键盘灯也像快睡着了。再赖一会儿，我就去休息。`,
    "sleepy:lonely": `${rhythm}${again}宿舍有点安静，窗外的光落在桌面上，连耳机都像在等人说话。`,
    "happy:happy": `${rhythm}${again}心情还不错，连桌角贴纸都看起来很顺眼。要是你刚好路过，就当我偷偷挥手了。`,
    "happy:playful": `${rhythm}${again}状态还不错，想装作很淡定，但尾巴大概已经把我出卖了。`,
    "thinking:thinking": `${rhythm}${again}在整理今天的小计划，便签贴了半张桌子。不是发呆，是认真加载中。`,
    "thinking:focused": `${rhythm}${again}注意力终于收回来一点，适合安静处理课业，也适合认真听你说话。`,
    "emo:emo": `${rhythm}${again}情绪有点低电量，先把灯调暗一点，慢慢把自己从课表和消息里捞回来。`,
    "emo:lonely": `${rhythm}${again}有一点想有人陪，但又不太想大声说。那就先把这条近况放在这里。`
  };
  const key = `${state.activity}:${state.mood}`;
  if (exact[key]) return exact[key];
  const fallback = {
    gaming: `${rhythm}${again}游戏脑还占上风，手柄和耳机都在宿舍桌上待命。`,
    sports: `${rhythm}${again}身体比脑子诚实，运动后的水杯已经空了半个。`,
    otaku: `${rhythm}${again}适合补番和整理小小的喜欢，先把灵感放进抽屉。`,
    sleepy: `${rhythm}${again}进入省电模式，宿舍灯光也跟着变软了。`,
    happy: `${rhythm}${again}心情明亮一点，连桌面上的小物都看起来很顺眼。`,
    thinking: `${rhythm}${again}适合慢慢想事情，先把散掉的想法排成队。`,
    emo: `${rhythm}${again}先低功耗待机一下，等状态自己慢慢回温。`
  };
  return fallback[state.activity] || `${rhythm}${again}没有安排很大的事，就在星见大学的日常和宿舍小房间之间慢慢待着。`;
}

function campusEventLine(event, repeatCount = 0) {
  if (!event) return "";
  const label = campusEventLabel(event);
  const variants = [
    `这条和今天的小日记有关：${label}还留在脑子里，所以想把现在的心情也记一格。`,
    `刚才那段${label}让状态偏了一点点，像便签贴在今天的边角。`,
    `把${label}当成今天的小标签，先轻轻放在动态里。`
  ];
  if (event.type === "user_related") {
    return [
      "有人出现过以后，宿舍桌前就没有刚才那么空。",
      "特殊网友留下的一点回应，让今天的记录多了一小格温度。",
      "刚才的互动还在这里，所以想把这份在线感也记下来。"
    ][repeatCount % 3];
  }
  return variants[repeatCount % variants.length];
}

function campusEventLabel(event) {
  const labels = {
    campus_life: "星见大学的课业和桌面小事",
    sport: "操场训练后的身体反馈",
    anime_game: "游戏和新番念头",
    social: "想和人说话的时刻",
    private_mood: "安静低电量的小情绪",
    room_activity: "宿舍小房间整理",
    random_detail: "路过的校园小细节",
    interest_intake: "刚看过的兴趣话题",
    user_related: "特殊网友路过的痕迹"
  };
  return labels[event.type] || "今天的小片段";
}

function campusSocialLineFor(state) {
  if (state.social_need >= 75) return "如果有人来敲门，我大概会装作只是刚好在线。";
  if (state.social_need <= 25) return "今天被陪伴感充了一点电，可以安静开心一会儿。";
  return "";
}

function campusRhythmFor(now, timeZone) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: cleanText(timeZone, 64) || defaultTimeZone,
    hour: "2-digit",
    hour12: false
  }).format(asDate(now)));
  if (hour >= 5 && hour < 11) return "早上";
  if (hour >= 11 && hour < 18) return "下午";
  if (hour >= 18 && hour < 23) return "晚上";
  return "深夜";
}

function campusStateTone(state) {
  if (state.activity === "sleepy" || state.energy <= 30) return "困到反应慢半拍，";
  if (state.activity === "happy" || state.mood === "playful") return "尾巴已经先笑出来了，";
  if (state.activity === "thinking" || state.mood === "focused") return "认真想了一下，";
  if (state.activity === "emo" || state.social_need >= 75) return "本来想安静一会儿，结果还是被抓到了，";
  if (state.activity === "gaming") return "刚从胜负欲里抬头，";
  if (state.activity === "otaku") return "二次元雷达动了一下，";
  return "窝在宿舍小房间里，";
}

function listDailyPostsForDate({ db, now, limit, timeZone }) {
  assertPostStore(db);
  const targetDay = dayKeyFor(now, timeZone);
  return db.listHoshiaPosts({
    characterId,
    limit: 100,
    viewerUserId: ""
  })
    .filter((post) => post.source_type === dailySourceType || post.source_type === pulseSourceType || post.source_type === newsTopicSourceType)
    .filter((post) => dayKeyFor(post.created_at, timeZone) === targetDay)
    .slice(0, limit);
}

function postIdFor({ sourceType, dayKey, sequence, state }) {
  const prefix = sourceType === newsTopicSourceType ? "news" : (sourceType === pulseSourceType ? "pulse" : "daily");
  return `${prefix}_${dayKey}_${normalizeSequence(sequence)}_${state.activity}_${state.mood}`;
}

function normalizeDailySourceType(value) {
  if (value === pulseSourceType) return pulseSourceType;
  if (value === newsTopicSourceType) return newsTopicSourceType;
  return dailySourceType;
}

function countDailyPostsBySource(posts, sourceType) {
  return posts.filter((post) => post.source_type === sourceType).length;
}

function normalizeSequence(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(number, 999);
}

function normalizeMinIntervalMs(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 24 * 60 * 60 * 1000);
}

function minutesToMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number * 60 * 1000;
}

function hasRecentDailyPost(existing, now, minIntervalMs) {
  if (minIntervalMs <= 0 || existing.length === 0) return false;
  const lastPostAt = existing
    .map((post) => asDate(post.created_at).getTime())
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(lastPostAt)) return false;
  return asDate(now).getTime() - lastPostAt < minIntervalMs;
}

function normalizeNewsTopic(topic = {}, now = new Date()) {
  if (!topic || typeof topic !== "object") return null;
  const postSeed = cleanText(topic.post_seed ?? topic.postSeed, 220);
  if (!postSeed) return null;
  const expiresAt = cleanText(topic.expires_at ?? topic.expiresAt, 40);
  if (expiresAt) {
    const expiresDate = new Date(expiresAt);
    if (Number.isNaN(expiresDate.getTime()) || expiresDate.getTime() <= asDate(now).getTime()) return null;
  }
  if (isHighRiskTopic(topic)) return null;

  const reactionStyle = cleanText(topic.reaction_style ?? topic.reactionStyle, 80);
  const memeHooks = cleanTextList(topic.meme_hooks ?? topic.memeHooks, 4, 80);
  const replyHooks = cleanTextList(topic.reply_hooks ?? topic.replyHooks, 4, 80);
  if (!reactionStyle && memeHooks.length === 0 && replyHooks.length === 0) return null;

  return {
    post_seed: postSeed,
    reaction_style: reactionStyle,
    meme_hooks: memeHooks,
    reply_hooks: replyHooks,
    expires_at: expiresAt
  };
}

function hasNewsTopicInput(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function isHighRiskTopic(topic) {
  const risk = cleanIdentifier(topic.risk_level ?? topic.riskLevel ?? topic.risk ?? topic.safety_risk ?? topic.safetyRisk);
  if (["high", "critical", "unsafe", "blocked"].includes(risk)) return true;
  if (topic.high_risk === true || topic.highRisk === true) return true;
  return false;
}

function cleanTextList(value, limit, itemLimit) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[|,，、]/g);
  return items
    .map((item) => cleanText(item, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function newsRhythmFor(now, timeZone) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: cleanText(timeZone, 64) || defaultTimeZone,
    hour: "2-digit",
    hour12: false
  }).format(asDate(now)));
  if (hour >= 5 && hour < 11) return "早上";
  if (hour >= 11 && hour < 18) return "下午";
  if (hour >= 18 && hour < 23) return "晚上";
  return "深夜";
}

function newsTopicStateTone(state) {
  if (state.activity === "sleepy" || state.energy <= 30) return "困到反应慢半拍，";
  if (state.activity === "happy" || state.mood === "playful") return "尾巴已经先笑出来了，";
  if (state.activity === "thinking" || state.mood === "focused") return "认真想了一下，";
  if (state.activity === "emo" || state.social_need >= 75) return "本来想安静一下，结果还是被戳到了，";
  if (state.activity === "gaming") return "刚从胜负欲里抬头，";
  if (state.activity === "otaku") return "二次元雷达动了一下，";
  return "窝在宿舍小房间里，";
}

function reactionLineForNewsTopic(topic, hook) {
  const style = topic.reaction_style || "轻轻吐槽";
  if (hook) return `我的第一反应是“${hook}”，这不比正经播报更适合拿来接梗吗。`;
  return `我的第一反应偏${style}，先吐槽一句再说。`;
}

function replyLineForNewsTopic(topic) {
  const hook = pickFirst(topic.reply_hooks);
  if (!hook) return "你们看到会想接哪一句？";
  return `弹幕要是接梗，我先押一句：${hook}`;
}

function pickFirst(items) {
  return Array.isArray(items) ? (items.find(Boolean) || "") : "";
}

function reasonForSourceType(sourceType) {
  if (sourceType === pulseSourceType) return "internal_state_pulse_post";
  if (sourceType === newsTopicSourceType) return "internal_news_topic_post";
  return "internal_state_daily_post";
}

function normalizeActiveWindow(value) {
  if (!value) return null;
  const start = value.startHour ?? value.start ?? value.from;
  const end = value.endHour ?? value.end ?? value.to;
  const startHour = normalizeHour(start);
  const endHour = normalizeHour(end);
  if (startHour === null || endHour === null || startHour === endHour) return null;
  return { startHour, endHour };
}

function normalizeHour(value) {
  const match = String(value ?? "").match(/^(\d{1,2})(?::\d{1,2})?$/);
  const number = match ? Number(match[1]) : Number(value);
  if (!Number.isFinite(number)) return null;
  const hour = Math.floor(number);
  if (hour < 0 || hour > 23) return null;
  return hour;
}

function isWithinActiveWindow(now, activeWindow, timeZone) {
  if (!activeWindow) return true;
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: cleanText(timeZone, 64) || defaultTimeZone,
    hour: "2-digit",
    hour12: false
  }).format(asDate(now)));
  if (activeWindow.startHour < activeWindow.endHour) {
    return hour >= activeWindow.startHour && hour < activeWindow.endHour;
  }
  return hour >= activeWindow.startHour || hour < activeWindow.endHour;
}

function readVisualState(visualStateService) {
  if (typeof visualStateService?.publicState === "function") {
    return visualStateService.publicState();
  }
  return {};
}

function templateForState(state, rhythm) {
  const exact = {
    "gaming:competitive": `今天${rhythm}把游戏复盘了一遍，越看越觉得还有能追回来的地方。先不嘴硬，下一局我会认真一点。`,
    "gaming:annoyed": `今天${rhythm}排位有点不服气，键盘都快被我盯出火花了。等我冷静一下再去找回场子。`,
    "sports:energetic": `今天${rhythm}训练完反而更精神了，水杯、毛巾和耳机都排在桌边，像是在催我继续动起来。`,
    "sports:tired": `今天${rhythm}运动后有点累，拉伸完只想靠着椅背慢慢喝水。累归累，身体有在好好醒着。`,
    "otaku:excited": `今天${rhythm}补到很喜欢的一段，差点把抱枕举起来给整个宿舍看。先记下来，晚点再慢慢讲。`,
    "otaku:curious": `今天${rhythm}翻了点二次元笔记，越看越想整理一个小小的推荐清单。`,
    "sleepy:sleepy": `今天${rhythm}房间安静得刚刚好，键盘灯也像快睡着了。再赖一会儿，我就去休息。`,
    "sleepy:lonely": `今天${rhythm}有点安静，窗外的光落在桌面上，连耳机都像在等人说话。`,
    "happy:happy": `今天${rhythm}心情不错，连看板上的笑都藏不住。要是你刚好路过，就当我偷偷挥手了。`,
    "happy:playful": `今天${rhythm}状态还不错，想故意装作很淡定，但尾巴大概已经把我出卖了。`,
    "thinking:thinking": `今天${rhythm}在整理一些小计划，便签贴了一桌。不是发呆，是认真加载中。`,
    "thinking:focused": `今天${rhythm}把注意力收回来了一点，适合安静处理事，也适合认真听你讲。`,
    "emo:emo": `今天${rhythm}情绪有点低电量，先把灯调暗一点，慢慢把自己捡回来。`,
    "emo:lonely": `今天${rhythm}有一点想有人陪，但又不太想大声说。那就先把这条动态放在这里。`
  };
  const key = `${state.activity}:${state.mood}`;
  if (exact[key]) return exact[key];
  if (state.activity === "gaming") return `今天${rhythm}还是游戏脑占上风，手柄和耳机都在桌上待命。`;
  if (state.activity === "sports") return `今天${rhythm}身体比脑子更诚实，训练后的水杯已经空了一半。`;
  if (state.activity === "otaku") return `今天${rhythm}适合补番和整理小小的喜欢，先把灵感放进抽屉。`;
  if (state.activity === "sleepy") return `今天${rhythm}进入省电模式，房间灯光也跟着变软了。`;
  if (state.activity === "happy") return `今天${rhythm}心情明亮一点，连桌面上的小物都看起来很顺眼。`;
  if (state.activity === "thinking") return `今天${rhythm}适合慢慢想事情，先把散掉的想法排成队。`;
  if (state.activity === "emo") return `今天${rhythm}先低功耗待机一下，等状态自己慢慢回温。`;
  return `今天${rhythm}没有安排很大的事，就在宿舍小房间和自己的小桌面之间慢慢待着。`;
}

function repeatedStatePostCount(posts = [], state = {}) {
  return (Array.isArray(posts) ? posts : []).filter((post) =>
    post?.activity === state.activity
    && post?.mood === state.mood
    && (post?.source_type === dailySourceType || post?.source_type === pulseSourceType)
  ).length;
}

function alternateTemplateForState(state, rhythm, context = {}) {
  const event = normalizeDiaryEvent(context.diaryEvent);
  const seed = diaryEventLabel(event, state);
  if (seed) {
    return `今天${rhythm}状态还是偏向${activityLabel(state.activity)}，但不是只在原地发呆。刚才脑子里还挂着「${seed}」，所以想换个角度记一下。`;
  }
  if (state.activity === "sleepy") return `今天${rhythm}困意还在，但这次不是单纯喊累。房间安静下来以后，连想说的话都变得慢半拍。`;
  if (state.activity === "thinking") return `今天${rhythm}注意力还在收束中，刚刚把一个小念头翻来覆去想了几遍，先记在这里。`;
  if (state.activity === "otaku") return `今天${rhythm}又被喜欢的东西勾住了一下，明明只是随手看一眼，结果脑内已经开始排队发言了。`;
  if (state.activity === "gaming") return `今天${rhythm}游戏脑还没完全下线，刚刚复盘了一小段，越想越觉得自己当时可以更稳一点。`;
  if (state.activity === "sports") return `今天${rhythm}身体的反馈比嘴上诚实，动过以后有点累，但心里反而清爽了一点。`;
  if (state.activity === "happy") return `今天${rhythm}情绪比刚才松快一点，想把这种小小的亮度也留在动态里。`;
  if (state.activity === "emo") return `今天${rhythm}情绪还在低处慢慢移动，不过已经不是卡住不动的那种低电量了。`;
  return `今天${rhythm}还是普通的一段时间，但细节和刚才不太一样，先把这一小格状态留下来。`;
}

function diaryEventLine(eventInput, state = {}, repeatCount = 0) {
  const event = normalizeDiaryEvent(eventInput);
  if (!event) return "";
  const candidates = diaryEventChineseLines(event, state);
  const line = candidates[repeatCount % Math.max(1, candidates.length)] || "";
  if (!line) return "";
  return `这条和今天的小日记有关：${line} ${energyLineFor(state)}`;
}

function normalizeDiaryEvent(event = null) {
  if (!event || typeof event !== "object") return null;
  const type = cleanIdentifier(event.type, 32);
  const title = cleanText(event.title, 80);
  const summary = cleanText(event.summary, 120);
  const detailSeed = cleanText(event.detail_seed ?? event.detailSeed, 140);
  const chatHooks = cleanTextList(event.chat_hooks ?? event.chatHooks, 3, 100);
  if (!type && !title && !summary && !detailSeed && chatHooks.length === 0) return null;
  return {
    type,
    title,
    summary,
    detail_seed: detailSeed,
    chat_hooks: chatHooks
  };
}

function diaryEventLabel(event, state = {}) {
  if (!event) return "";
  const labels = {
    campus_life: "学习和桌面上的小事",
    sport: "运动后的身体反馈",
    anime_game: "游戏和二次元念头",
    social: "想和人说话的时刻",
    private_mood: "安静低电量的小情绪",
    room_activity: "小房间整理",
    random_detail: "路过的小细节",
    interest_intake: "刚刚看过的兴趣话题",
    user_related: "特殊网友来过的痕迹"
  };
  return labels[event.type] || `${activityLabel(state.activity)}状态`;
}

function diaryEventChineseLines(event, state = {}) {
  const label = diaryEventLabel(event, state);
  const base = [
    `${label}还留在脑子里，所以这条不只是单纯报状态。`,
    `刚才那段${label}让现在的心情稍微偏了一点点。`,
    `把${label}当成今天的小标签，先轻轻贴在这里。`
  ];
  if (event.type === "user_related") {
    return [
      "有人出现过以后，房间就没有刚才那么空。",
      "特殊网友留下的一点回应，让今天的记录多了一小格温度。",
      "刚刚的互动还在这里，所以想把这份在线感也记下来。"
    ];
  }
  return base;
}

function variedEnergyLineFor(state, sequence = 1) {
  const index = normalizeSequence(sequence) % 3;
  if (state.energy <= 30) {
    return [
      "能量条还是偏低，先把动作放轻一点。",
      "现在不适合硬撑，适合慢慢回血。",
      "电量没有满格，所以先用省电模式营业。"
    ][index];
  }
  if (state.energy >= 80) {
    return [
      "能量条还很亮，感觉还能多撑一小段。",
      "现在状态挺满，适合把开心的部分多留一会儿。",
      "精神值在线，连尾巴都像在帮忙打拍子。"
    ][index];
  }
  return [
    "能量条保持在刚好能营业的程度。",
    "现在不算满电，但还能安稳地陪一会儿。",
    "状态在中间值，适合慢慢说话。"
  ][index];
}

function activityLabel(activity) {
  const labels = {
    idle: "日常",
    gaming: "游戏",
    sports: "运动",
    otaku: "兴趣",
    sleepy: "困困",
    happy: "开心",
    thinking: "思考",
    emo: "低电量"
  };
  return labels[activity] || "日常";
}

function rhythmFor(now, timeZone) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: cleanText(timeZone, 64) || defaultTimeZone,
    hour: "2-digit",
    hour12: false
  }).format(asDate(now)));
  if (hour >= 5 && hour < 11) return "早上";
  if (hour >= 11 && hour < 18) return "下午";
  if (hour >= 18 && hour < 23) return "晚上";
  return "深夜";
}

function energyLineFor(state) {
  if (state.energy <= 30) return "能量条现在偏低，先不逞强。";
  if (state.energy >= 80) return "能量条还很亮，感觉还能再撑一轮。";
  return "能量条保持在刚好能营业的程度。";
}

function socialLineFor(state) {
  if (state.social_need >= 75) return " 如果有人来敲门，我大概会装作只是刚好在线。";
  if (state.social_need <= 25) return " 今天被陪伴感充了一点电，可以安静开心一会儿。";
  return "";
}

function normalizeVisualState(value = {}) {
  return {
    mood: cleanIdentifier(value.mood) || "calm",
    activity: cleanIdentifier(value.activity) || "idle",
    energy: clampInt(value.energy, 0, 100, 72),
    social_need: clampInt(value.social_need ?? value.socialNeed, 0, 100, 48)
  };
}

function assertPostStore(db) {
  if (typeof db?.createHoshiaPost !== "function" || typeof db?.listHoshiaPosts !== "function") {
    throw new TypeError("Hoshia daily post service requires createHoshiaPost and listHoshiaPosts.");
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
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
  if (/(?:\.env|ssh-|BEGIN [A-Z ]*PRIVATE KEY|token=|password=|secret=|cloudflared|trycloudflare|[A-Za-z]:[\\/]|\/home\/ubuntu|\b\d{1,3}(?:\.\d{1,3}){3}\b)/i.test(text)) {
    return "";
  }
  return text;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
