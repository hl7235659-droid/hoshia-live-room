import { normalizePostInput } from "./hoshia-life-memory.js";
import { sanitizeModuleEvent } from "./module-context.js";

const characterId = "hoshia";
const dailySourceType = "daily_state";
const defaultTimeZone = "Asia/Shanghai";

export function createHoshiaDailyPostService({
  db,
  visualStateService,
  clock = () => new Date(),
  enabled = false,
  dailyLimit = 1,
  timeZone = defaultTimeZone,
  roomId = ""
} = {}) {
  const safeLimit = normalizeDailyPostLimit(dailyLimit);
  const safeTimeZone = cleanText(timeZone, 64) || defaultTimeZone;

  return {
    planDailyPost({ now = clock(), state = null } = {}) {
      const currentNow = asDate(now);
      const currentState = normalizeVisualState(state || readVisualState(visualStateService));
      const postInput = normalizePostInput({
        id: `daily_${dayKeyFor(currentNow, safeTimeZone)}_${currentState.activity}_${currentState.mood}`,
        content: buildDailyPostContent(currentState, currentNow, safeTimeZone),
        image_url: "",
        mood: currentState.mood,
        activity: currentState.activity,
        source_type: dailySourceType,
        created_at: currentNow.toISOString()
      }, currentNow);

      return {
        ok: Boolean(postInput),
        postInput,
        state: currentState,
        day_key: dayKeyFor(currentNow, safeTimeZone),
        source_type: dailySourceType
      };
    },

    listDailyPostsForDate({ now = clock() } = {}) {
      return listDailyPostsForDate({
        db,
        now: asDate(now),
        limit: safeLimit,
        timeZone: safeTimeZone
      });
    },

    tick({ force = false, now = clock() } = {}) {
      const currentNow = asDate(now);
      if (!force && !enabled) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_post_disabled",
          daily_limit: safeLimit,
          day_key: dayKeyFor(currentNow, safeTimeZone)
        };
      }

      assertPostStore(db);
      const existing = listDailyPostsForDate({
        db,
        now: currentNow,
        limit: safeLimit,
        timeZone: safeTimeZone
      });
      if (existing.length >= safeLimit) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_limit_reached",
          post: existing[0],
          daily_count: existing.length,
          daily_limit: safeLimit,
          day_key: dayKeyFor(currentNow, safeTimeZone)
        };
      }

      const plan = this.planDailyPost({ now: currentNow });
      if (!plan.postInput) {
        return {
          ok: false,
          created: false,
          skipped: true,
          reason: "daily_post_invalid",
          daily_count: existing.length,
          daily_limit: safeLimit,
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
          occurredAt: post?.created_at || currentNow.toISOString()
        }),
        daily_count: existing.length + 1,
        daily_limit: safeLimit,
        day_key: plan.day_key
      };
    }
  };
}

export function createHoshiaDailyPostCreatedEvent(post, state, {
  roomId = "",
  occurredAt = new Date().toISOString()
} = {}) {
  if (!post) return null;
  const currentState = normalizeVisualState(state || post);
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "hoshia_daily_post",
    event_type: "hoshia_daily_post.created",
    summary_hint: `Hoshia created a daily ${currentState.activity}/${currentState.mood} post.`,
    memory_eligible: true,
    memory_kind: "hoshia_daily_post",
    retention_days: 30,
    occurred_at: occurredAt,
    data: {
      activity: currentState.activity,
      mood: currentState.mood,
      source: dailySourceType,
      reason: "internal_state_daily_post"
    }
  });
}

export function buildDailyPostContent(state = {}, now = new Date(), timeZone = defaultTimeZone) {
  const currentState = normalizeVisualState(state);
  const rhythm = rhythmFor(asDate(now), timeZone);
  const template = templateForState(currentState, rhythm);
  return cleanText(`${template} ${energyLineFor(currentState)}${socialLineFor(currentState)}`, 700);
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

function listDailyPostsForDate({ db, now, limit, timeZone }) {
  assertPostStore(db);
  const targetDay = dayKeyFor(now, timeZone);
  return db.listHoshiaPosts({
    characterId,
    limit: 100,
    viewerUserId: ""
  })
    .filter((post) => post.source_type === dailySourceType)
    .filter((post) => dayKeyFor(post.created_at, timeZone) === targetDay)
    .slice(0, limit);
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
    "otaku:excited": `今天${rhythm}补到很喜欢的一段，差点把抱枕举起来给全直播间看。先记下来，晚点再慢慢讲。`,
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
  return `今天${rhythm}没有安排很大的事，就在直播间和自己的小桌面之间慢慢待着。`;
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
