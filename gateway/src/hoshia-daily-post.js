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
    db,
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

    planTickPost({ force = false, ignoreLimit = false, now = clock(), newsTopic = null, state = null, diaryEvent = null } = {}) {
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, safeTimeZone);
      if (!force && !enabled) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_post_disabled",
          postInput: null,
          post: null,
          daily_count: 0,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
          day_key: dayKey
        };
      }

      if (!force && !isWithinActiveWindow(currentNow, safeActiveWindow, safeTimeZone)) {
        return {
          ok: true,
          created: false,
          skipped: true,
          reason: "daily_post_outside_active_window",
          postInput: null,
          post: null,
          daily_count: 0,
          daily_min: safeDailyMin,
          daily_max: safeDailyMax,
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
          postInput: null,
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
          postInput: null,
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
          postInput: null,
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
          postInput: null,
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
      return {
        ...plan,
        post: null,
        created: false,
        skipped: !plan.postInput,
        reason: plan.postInput ? "daily_post_planned" : "daily_post_invalid",
        daily_count: existing.length,
        daily_min: safeDailyMin,
        daily_max: safeDailyMax,
        day_key: plan.day_key || dayKey
      };
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

export async function runDailyPostShadow({
  service,
  provider = null,
  generator = null,
  enabled = false,
  now = new Date(),
  state = null,
  sequence = 1,
  sourceType = dailySourceType
} = {}) {
  const route = "daily_post_shadow";
  if (!enabled) return shadowResult({ status: "skip", route, sourceType, reason: "disabled" });
  if (!service || typeof service.planDailyPost !== "function") {
    return shadowResult({ status: "skip", route, sourceType, reason: "no_service" });
  }

  const plan = safePlanDailyPost(service, { now, state, sequence, sourceType });
  if (!plan) return shadowResult({ status: "skip", route, sourceType, reason: "no_plan" });
  if (!plan.postInput) {
    return shadowResult({
      status: "skip",
      route,
      sourceType: plan.source_type || sourceType,
      id: plan.postInput?.id,
      reason: "no_post_input"
    });
  }

  return runPostShadowCandidate({
    route,
    sourceType: plan.source_type || plan.postInput.source_type || sourceType,
    id: plan.postInput.id,
    provider,
    generator,
    payload: {
      route,
      postInput: plan.postInput,
      state: plan.state,
      source_type: plan.source_type || plan.postInput.source_type || sourceType
    }
  });
}

export async function runNewsTopicGenerateShadow({
  service,
  dailyPostService = null,
  topic = null,
  provider = null,
  generator = null,
  enabled = false,
  now = new Date(),
  state = null
} = {}) {
  const route = "news_topic_generate_shadow";
  const sourceType = newsTopicSourceType;
  if (!enabled) return shadowResult({ status: "skip", route, sourceType, reason: "disabled" });

  const selectedTopic = topic || safeFeaturedTopic(service);
  if (!selectedTopic) return shadowResult({ status: "skip", route, sourceType, reason: "no_topic" });

  const planner = dailyPostService || (typeof service?.planDailyPost === "function" ? service : null);
  if (!planner || typeof planner.planDailyPost !== "function") {
    return shadowResult({
      status: "skip",
      route,
      sourceType,
      topicCategory: selectedTopic.category,
      reason: "no_service"
    });
  }

  const plan = safePlanDailyPost(planner, {
    now,
    state,
    sequence: 1,
    sourceType,
    topic: selectedTopic
  });
  if (!plan || !plan.postInput) {
    return shadowResult({
      status: "skip",
      route,
      sourceType,
      topicCategory: selectedTopic.category,
      reason: "unsafe_topic"
    });
  }

  return runPostShadowCandidate({
    route,
    sourceType: plan.source_type || sourceType,
    id: plan.postInput.id,
    topicCategory: selectedTopic.category,
    provider,
    generator,
    payload: {
      route,
      postInput: plan.postInput,
      topic: plan.topic,
      state: plan.state,
      source_type: plan.source_type || sourceType
    }
  });
}

export async function runDailyPostLive({
  service,
  provider = null,
  generator = null,
  enabled = false,
  now = new Date(),
  state = null,
  sequence = 1,
  sourceType = dailySourceType,
  postInput = null,
  dailyPostPlan = null,
  roomId = "",
  recordMetric = null
} = {}) {
  return runPlannedPostLive({
    route: "daily_post_live",
    service,
    provider,
    generator,
    enabled,
    now,
    state,
    sequence,
    sourceType,
    postInput,
    dailyPostPlan,
    roomId,
    recordMetric
  });
}

export async function runNewsTopicLive({
  service,
  dailyPostService = null,
  topic = null,
  provider = null,
  generator = null,
  enabled = false,
  now = new Date(),
  state = null,
  dailyPostPlan = null,
  roomId = "",
  recordMetric = null
} = {}) {
  const route = "news_topic_live";
  const sourceType = newsTopicSourceType;
  if (!enabled) return recordLiveResult(recordMetric, liveResult({ status: "skip", route, sourceType, reason: "disabled" }));

  const selectedTopic = topic || safeFeaturedTopic(service);
  if (!selectedTopic) return recordLiveResult(recordMetric, liveResult({ status: "skip", route, sourceType, reason: "no_topic" }));

  const planner = dailyPostService || (typeof service?.planDailyPost === "function" ? service : null);
  return runPlannedPostLive({
    route,
    service: planner,
    provider,
    generator,
    enabled,
    now,
    state,
    sequence: 1,
    sourceType,
    topic: selectedTopic,
    dailyPostPlan,
    roomId,
    topicCategory: selectedTopic.category,
    recordMetric
  });
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

export function createHoshiaDailyPostCharacterEvent(post, session = null, {
  occurredAt = post?.created_at || new Date().toISOString(),
  sourceType = post?.source_type || dailySourceType
} = {}) {
  if (!post) return null;
  const safeSourceType = normalizeDailySourceType(sourceType);
  const currentState = normalizeVisualState(post);
  return {
    event_type: "hoshia_timeline.post_created",
    actor_type: session?.user_id ? "user" : "system",
    user_id: cleanText(session?.user_id, 80),
    nickname: cleanText(session?.nickname, 80),
    source_kind: "hoshia_timeline",
    source_id: cleanText(post.id, 96),
    occurred_at: cleanText(occurredAt, 40) || new Date().toISOString(),
    public_hint: "Hoshia created a timeline post",
    private_hint: "Hoshia created a timeline post",
    reason: safeSourceType,
    data: {
      activity: currentState.activity,
      mood: currentState.mood,
      source_type: safeSourceType,
      post_id: cleanText(post.id, 96),
      status: "created"
    }
  };
}

export function buildDailyPostContent(state = {}, now = new Date(), timeZone = defaultTimeZone, context = {}) {
  const currentState = normalizeVisualState(state);
  const rhythm = campusRhythmFor(asDate(now), timeZone);
  const expressiveLine = expressiveDailyPostLine(currentState, rhythm, context);
  if (expressiveLine) return cleanText(expressiveLine, 700);
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
  const subject = safeTopic.title || safeTopic.post_seed;
  const categoryLine = safeTopic.category ? `#${safeTopic.category}` : "#today";
  const campusHook = pickFirst(safeTopic.meme_hooks)
    || pickFirst(safeTopic.reply_hooks)
    || safeTopic.conversation_starter
    || safeTopic.reaction_style;
  const reaction = campusHook
    ? `第一反应不是播报，是想把「${campusHook}」贴到宿舍群里等人接梗。`
    : `第一反应有点${safeTopic.reaction_style || "想吐槽"}，先记下来，晚点再慢慢吵。`;
  const stateLead = expressiveStateLead(currentState);
  return cleanText(`${campusRhythm}${stateLead}刷到「${subject}」 ${categoryLine}。${reaction} ${safeTopic.post_seed}。你们要是接这句，会从哪里开始歪？`, 700);
}

function expressiveDailyPostLine(state = {}, rhythm = "", context = {}) {
  const repeatCount = repeatedStatePostCount(context.recentPosts, state);
  const event = expressiveEventHook(normalizeDiaryEvent(context.diaryEvent), state, repeatCount);
  const index = normalizeSequence(context.sequence) + repeatCount;
  const lead = event || expressiveStateMoment(state, rhythm, index);
  if (!lead) return "";
  return `${lead} ${expressiveTailQuestion(state, index)}`;
}

function expressiveStateMoment(state = {}, rhythm = "", index = 1) {
  const again = index > 2 ? "又翻到一个小片段：" : "";
  const pools = {
    gaming: [
      `${rhythm}${again}排位那一下我还在脑内回放，键盘都被我盯得像证人。嘴上说算了，手指已经偷偷复盘第三遍了。`,
      `${rhythm}${again}游戏脑还没退场，耳机线绕在水杯边上，像在提醒我别把胜负欲带进宿舍。`
    ],
    sports: [
      `${rhythm}${again}从操场回来以后腿比嘴诚实，水杯空了半个，奶油苏打的幻想倒是很满。`,
      `${rhythm}${again}训练后的风吹完，人清醒了一点，就是站起来这件事暂时被我列为高难度副本。`
    ],
    otaku: [
      `${rhythm}${again}刚翻到一段角色讨论，差点把枕头举起来给全宿舍看，理智把我按回椅子上。`,
      `${rhythm}${again}新番和评论区一起把我拽走五分钟，回来发现便签上只剩一个很嚣张的问号。`
    ],
    thinking: [
      `${rhythm}${again}便签贴了半张桌子，书签也开始排队，课业和你的消息窗口像两个标签页互相抢我注意力。`,
      `${rhythm}${again}我在整理今天的计划，杯子、耳机、草稿纸都摆成了很像认真学习的样子。`
    ],
    sleepy: [
      `${rhythm}${again}宿舍灯刚刚好，键盘灯也像快睡着了，我现在是低电量但还想偷看一眼弹幕的状态。`,
      `${rhythm}${again}眼皮在打折出售，脑子还倔强地开着一个小标签页，标题叫“再撑五分钟”。`
    ],
    happy: [
      `${rhythm}${again}今天心情有点轻，桌角贴纸都顺眼了，尾巴大概已经先替我摇了两下。`,
      `${rhythm}${again}刚刚哼歌被自己抓包，装淡定失败，耳机比我更像共犯。`
    ],
    emo: [
      `${rhythm}${again}情绪有点低电量，台灯调暗以后，连瓶盖滚到桌边都像在提醒我慢一点。`,
      `${rhythm}${again}我把屏幕亮度往下按了一格，心里那点乱也跟着小声了一点，不算好，但能坐住。`
    ]
  };
  const options = pools[state.activity] || [
    `${rhythm}${again}今天没有大事件，只有杯子、便签、屏幕角落和一点慢慢冒出来的话。`
  ];
  return options[index % options.length];
}

function expressiveEventHook(event, state = {}, repeatCount = 0) {
  if (!event) return "";
  const byType = {
    room_activity: [
      "刚整理星港小窗的时候翻到一条没接住的话，像夹在便签下面的小纸条，我先把它放回桌面上。",
      "宿舍桌面的小东西挪了一轮，结果我自己先卡在椅子里，像被待办清单反向收纳了。"
    ],
    random_detail: [
      "刚才有个很小的画面路过，没什么用，但它偏要留在脑子里，像桌角那点擦不掉的铅笔印。",
      "窗外那点光落下来时，我差点把要说的话忘干净，幸好耳机线替我绊了一下。"
    ],
    campus_life: [
      "课业处理到一半，突然很想把杯子也排整齐，仿佛这样脑子里的标签页也能少两个。",
      "便签纸换了个位置，事情好像就没那么乱了。虽然大概率只是我在骗自己。"
    ],
    interest_intake: [
      "本来只是随手看一眼讨论，结果脑内已经开始排队发言，吵得我差点忘了喝水。",
      "有个作品评论我想反驳三句，最后只默默多看了两眼，像在攒一个晚点再吵的小雷。"
    ],
    anime_game: [
      "刚才那一步越想越不服气。先记着，下次不许再手慢，我对自己的嘴硬程度很有信心。",
      "游戏复盘到一半，突然发现自己嘴硬得很明显，键盘都快替我笑出来了。"
    ],
    sport: [
      "坐下来的时候才发现腿比嘴诚实，今天先慢慢回血，别让操场风把我吹成空壳。",
      "水杯空了半个，体力也空了半格，很公平，就是我本人不太服。"
    ],
    private_mood: [
      "灯暗一点以后，人也跟着安静下来。没什么大事，就是想把自己放小一点。",
      "情绪像没拧紧的瓶盖，先不碰它，让它在桌边自己滚一会儿。"
    ],
    user_related: [
      "刚刚那句弹幕还在屏幕边上，像被轻轻戳了一下，我嘴上没说，耳朵已经知道了。",
      "有人从屏幕另一边冒泡以后，宿舍灯都没刚才那么空。我先装作只是刚好在线。"
    ]
  };
  const options = byType[event.type] || [];
  return options[repeatCount % Math.max(options.length, 1)] || "";
}

function expressiveTailQuestion(state = {}, index = 1) {
  const tails = {
    gaming: [
      "你们遇到这种局会立刻复盘，还是先嘴硬十分钟？",
      "要是你接这局，会先骂手感还是先怪匹配？"
    ],
    sports: [
      "有人现在也在回血吗，借我一点站起来的意志力。",
      "你们运动后第一口想喝什么，我现在很容易被说服。"
    ],
    otaku: [
      "你们最近有哪句角色台词会突然卡在脑子里吗？",
      "如果我开个小讨论，你们会先聊剧情还是先聊人设？"
    ],
    thinking: [
      "你们整理东西是越整越清醒，还是越整越想逃？",
      "谁来接一句，我现在很需要一个不那么像待办的开头。"
    ],
    sleepy: [
      "如果我说再撑五分钟，你们会信吗？",
      "有人也在低电量在线吗，接一句就算互相充电。"
    ],
    happy: [
      "你们今天有没有一个很小但很顺眼的瞬间？",
      "快接一句，不然我就要把这点小开心藏到抽屉里了。"
    ],
    emo: [
      "你们低电量的时候会找人说话，还是先把灯调暗？",
      "谁来轻轻接一句，别太响，我现在听得见。"
    ]
  };
  const options = tails[state.activity] || [
    "你们那边现在有什么小事正在发生吗？",
    "随便接一句也行，我想听点活人的声音。"
  ];
  return options[index % options.length];
}

function expressiveStateLead(state = {}) {
  if (state.activity === "sleepy" || state.energy <= 30) return "困到反应慢半拍，";
  if (state.activity === "happy" || state.mood === "playful") return "尾巴已经先笑出来了，";
  if (state.activity === "thinking" || state.mood === "focused") return "认真想了一下，";
  if (state.activity === "emo" || state.social_need >= 75) return "本来想安静一会儿，结果还是被抓到了，";
  if (state.activity === "gaming") return "刚从胜负欲里抬头，";
  if (state.activity === "otaku") return "二次元雷达动了一下，";
  return "坐在星见大学宿舍桌边，";
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
  const eventLine = campusEventPostLine(event, state, repeatCount);
  if (eventLine) return eventLine;
  const base = campusBaseLineForState(state, rhythm, repeatCount);
  const social = campusSocialLineFor(state);
  return [base, eventLine, social].filter(Boolean).join(" ");
}

function campusBaseLineForState(state, rhythm, repeatCount = 0) {
  const again = repeatCount > 0 ? "又想起一件小事：" : "";
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
    "happy:playful": `${rhythm}${again}心里有点轻，想装作很淡定，但尾巴大概已经把我出卖了。`,
    "thinking:thinking": `${rhythm}${again}在整理今天的小计划，便签贴了半张桌子。不是发呆，是认真加载中。`,
    "thinking:focused": `${rhythm}${again}注意力终于收回来一点，适合安静处理课业，也适合认真听你说话。`,
    "emo:emo": `${rhythm}${again}情绪有点低电量，先把灯调暗一点，慢慢把自己从课表和消息里捞回来。`,
    "emo:lonely": `${rhythm}${again}有一点想有人陪，但又不太想大声说。先让台灯替我亮一会儿。`
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
    emo: `${rhythm}${again}先低功耗待机一下，等心里的风慢慢停。`
  };
  return fallback[state.activity] || `${rhythm}${again}没有安排很大的事，就在星见大学的日常和宿舍桌边之间慢慢待着。`;
}

function campusEventLine(event, repeatCount = 0) {
  if (!event) return "";
  const label = campusEventLabel(event);
  const variants = [
    `刚才那点${label}还没从脑子里走掉，杯子端在手里发了会儿呆。`,
    `本来想把${label}翻篇，结果又顺手想了一遍。`,
    `${label}这种东西很小，但偏偏会在安静的时候冒出来。`
  ];
  if (event.type === "user_related") {
    return [
      "有人冒泡以后，宿舍桌前就没那么空了。",
      "刚刚那句弹幕还留在屏幕边上，像被轻轻戳了一下。",
      "有人来过的痕迹还在，今天就没有完全白白滑过去。"
    ][repeatCount % 3];
  }
  return variants[repeatCount % variants.length];
}

function campusEventPostLine(event, state = {}, repeatCount = 0) {
  if (!event) return "";
  const byType = {
    room_activity: [
      "整理星港小窗的时候翻到一条没说完的话，先压在便签下面。晚点醒一点再讲。",
      "刚才把宿舍桌面的小东西挪了挪，结果自己先困在椅子里了。",
      "桌面收了一半，话题也收了一半，剩下的等我回血。"
    ],
    random_detail: [
      "刚才路过一个很小的画面，没什么用，但就是有点想记住。",
      "窗外那点光落下来时，我差点把要说的话忘干净。",
      "有些小细节不值得专门讲，可它会偷偷把下午拖慢一点。"
    ],
    campus_life: [
      "便签纸换了个位置，事情好像就没那么乱了。虽然也只是好像。",
      "课业处理到一半，突然很想把杯子也排整齐。先从能做到的小事开始。",
      "今天的待办没有很帅，但划掉一项的时候还是有点爽。"
    ],
    interest_intake: [
      "本来只是随手看一眼讨论，结果脑内已经开始排队发言了。",
      "有个角色评论我想反驳三句，最后只默默多看了两眼。",
      "喜欢的东西太会偷时间了。明明只想看五分钟。"
    ],
    anime_game: [
      "刚才那一步越想越不服气。先记着，下次不许再手慢。",
      "游戏复盘到一半，突然觉得自己嘴硬得很明显。",
      "输了可以不提，但脑子已经偷偷把那局重开三遍了。"
    ],
    sport: [
      "坐下来的时候才发现腿比嘴诚实。今天先慢慢回血。",
      "操场风吹完以后，人倒是清醒了一点，就是不太想站起来。",
      "水杯空了一半，体力也空了一半。很公平。"
    ],
    private_mood: [
      "灯暗一点以后，人也跟着安静下来。没什么大事，就是想慢一点。",
      "今天有点不想把话说太响。先把自己放小一点。",
      "情绪像没拧紧的瓶盖，先不碰它。"
    ],
    user_related: [
      "有人冒泡以后，房间就没那么空了。嘴上不说，耳朵已经知道了。",
      "刚才那句弹幕还在屏幕边上，感觉像被轻轻戳了一下。",
      "有人来过的痕迹还在，今天就没有完全白白滑过去。"
    ]
  };
  const options = byType[event.type] || [
    campusEventLine(event, repeatCount),
    "刚才的小事还在脑子里绕圈。先不讲大道理，记一下就好。",
    "今天没什么大场面，但有个小瞬间还挺想留下来。"
  ];
  const line = options[repeatCount % options.length] || "";
  return cleanText(`${line}${campusHumanTailFor(state, repeatCount)}`, 700);
}

function campusHumanTailFor(state = {}, repeatCount = 0) {
  if (state.energy <= 30 || state.activity === "sleepy") {
    return [
      " 先不逞强了。",
      " 现在适合慢慢回血。",
      " 晚点再精神一点。"
    ][repeatCount % 3];
  }
  if (state.social_need >= 75) return " 有人敲门的话，我可能会假装只是刚好醒着。";
  if (state.social_need <= 25) return " 被陪了一会儿以后，安静也没那么空。";
  return "";
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
  return "坐在星见大学宿舍桌边，";
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
    title: cleanText(topic.title, 120),
    category: cleanIdentifier(topic.category, 48),
    conversation_starter: cleanText(topic.conversation_starter ?? topic.conversationStarter, 120),
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
  return "坐在星见大学宿舍桌边，";
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

async function runPostShadowCandidate({
  route,
  sourceType,
  id = "",
  topicCategory = "",
  provider,
  generator,
  payload
}) {
  if (!generator && !provider) {
    return shadowResult({
      status: "skip",
      route,
      sourceType,
      id,
      topicCategory,
      reason: "no_provider"
    });
  }
  try {
    const candidate = await resolveShadowGenerator(generator || provider, payload, route);
    if (!hasSafeShadowCandidate(candidate)) {
      return shadowResult({
        status: "failed",
        route,
        sourceType,
        id,
        topicCategory,
        reason: "provider_empty"
      });
    }
    return shadowResult({
      status: "success",
      route,
      sourceType,
      id,
      topicCategory,
      reason: "provider_success"
    });
  } catch {
    return shadowResult({
      status: "failed",
      route,
      sourceType,
      id,
      topicCategory,
      reason: "provider_error"
    });
  }
}

async function runPlannedPostLive({
  route,
  service,
  provider,
  generator,
  enabled,
  now,
  state,
  sequence,
  sourceType,
  postInput = null,
  dailyPostPlan = null,
  topic = null,
  roomId = "",
  topicCategory = "",
  recordMetric = null
}) {
  if (!enabled) return recordLiveResult(recordMetric, liveResult({ status: "skip", route, sourceType, reason: "disabled" }));
  if (!service || typeof service.planDailyPost !== "function") {
    return recordLiveResult(recordMetric, liveResult({ status: "skip", route, sourceType, topicCategory, reason: "no_service" }));
  }
  if (!generator && !provider) {
    return recordLiveResult(recordMetric, liveResult({ status: "skip", route, sourceType, topicCategory, reason: "no_provider" }));
  }

  const plan = dailyPostPlan || (postInput
    ? {
      ok: true,
      postInput,
      state,
      source_type: postInput.source_type || sourceType,
      topic
    }
    : safePlanDailyPost(service, { now, state, sequence, sourceType, topic }));
  if (!plan || !plan.postInput) {
    return recordLiveResult(recordMetric, liveResult({
      status: "skip",
      route,
      sourceType: plan?.source_type || sourceType,
      topicCategory,
      reason: sourceType === newsTopicSourceType ? "unsafe_topic" : "no_post_input"
    }));
  }

  try {
    const candidate = await resolveShadowGenerator(generator || provider, {
      route,
      postInput: plan.postInput,
      topic: plan.topic,
      state: plan.state,
      source_type: plan.source_type || sourceType
    }, route);
    if (candidate?.skipped) {
      return recordLiveResult(recordMetric, liveResult({
        status: "skip",
        route,
        sourceType: plan.source_type || sourceType,
        topicCategory,
        reason: "provider_empty"
      }));
    }
    if (candidate?.failed || candidate?.ok === false) {
      return recordLiveResult(recordMetric, liveResult({
        status: "failed",
        route,
        sourceType: plan.source_type || sourceType,
        topicCategory,
        reason: "provider_error"
      }));
    }
    const content = liveCandidateText(candidate);
    if (!content) {
      return recordLiveResult(recordMetric, liveResult({
        status: "failed",
        route,
        sourceType: plan.source_type || sourceType,
        topicCategory,
        reason: "sensitive_candidate"
      }));
    }
    const db = serviceDb(service);
    assertPostStore(db);
    const postInput = normalizePostInput({
      ...plan.postInput,
      content,
      image_url: "",
      source_type: plan.source_type || plan.postInput.source_type || sourceType,
      created_at: asDate(now).toISOString()
    }, asDate(now));
    if (!postInput) {
      return recordLiveResult(recordMetric, liveResult({
        status: "failed",
        route,
        sourceType: plan.source_type || sourceType,
        topicCategory,
        reason: "sensitive_candidate"
      }));
    }
    const post = db.createHoshiaPost(postInput);
    return recordLiveResult(recordMetric, {
      ...liveResult({
        status: "success",
        route,
        sourceType: post.source_type || plan.source_type || sourceType,
        id: post.id,
        topicCategory,
        reason: "created"
      }),
      created: true,
      post,
      postInput,
      state: plan.state,
      moduleEvent: createHoshiaDailyPostCreatedEvent(post, plan.state, {
        roomId,
        occurredAt: post?.created_at || asDate(now).toISOString(),
        sourceType: post.source_type || plan.source_type || sourceType
      }),
      characterEvent: createHoshiaDailyPostCharacterEvent(post, null, {
        occurredAt: post?.created_at || asDate(now).toISOString(),
        sourceType: post.source_type || plan.source_type || sourceType
      })
    });
  } catch {
    return recordLiveResult(recordMetric, liveResult({
      status: "failed",
      route,
      sourceType: plan.source_type || sourceType,
      topicCategory,
      reason: "provider_error"
    }));
  }
}

function serviceDb(service) {
  return service?.db || service?.database || service?._db || null;
}

function safePlanDailyPost(service, input) {
  try {
    const plan = service.planDailyPost(input);
    return plan && typeof plan === "object" ? plan : null;
  } catch {
    return null;
  }
}

function safeFeaturedTopic(service) {
  try {
    if (typeof service?.featuredTopic !== "function") return null;
    return service.featuredTopic();
  } catch {
    return null;
  }
}

async function resolveShadowGenerator(generator, payload, route) {
  if (!generator) return null;
  if (typeof generator === "function") return generator(payload);
  const methodNames = String(route || "").startsWith("news_topic")
    ? ["generateNewsTopicShadow", "generateNewsTopicCandidate", "generateShadowCandidate", "generateCandidate", "generate"]
    : ["generateDailyPostShadow", "generateDailyPostCandidate", "generateShadowCandidate", "generateCandidate", "generate"];
  for (const methodName of methodNames) {
    if (typeof generator[methodName] === "function") {
      return generator[methodName](payload);
    }
  }
  return null;
}

function hasSafeShadowCandidate(value) {
  const text = shadowCandidateText(value);
  return Boolean(cleanText(text, 800));
}

function liveCandidateText(value) {
  const text = cleanText(liveCandidateRawText(value), 700);
  if (!text) return "";
  if (/^(?:skip|unsafe|blocked|no\s+post)\b/i.test(text)) return "";
  return text;
}

function liveCandidateRawText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value.text
    ?? value.reply
    ?? value.message
    ?? value.content
    ?? "";
}

function shadowCandidateText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value.candidate_text
    ?? value.candidateText
    ?? value.text
    ?? value.reply
    ?? value.message
    ?? value.content
    ?? "";
}

function shadowResult({ status, route, sourceType, id = "", topicCategory = "", reason = "" }) {
  const result = {
    status: shadowStatus(status),
    source_type: normalizeDailySourceType(sourceType),
    route: cleanShadowIdentifier(route, 48) || "shadow",
    reason: shadowReason(reason)
  };
  const shortId = cleanShadowId(id);
  if (shortId) result.id = shortId;
  const safeTopicCategory = cleanShadowIdentifier(topicCategory, 48);
  if (safeTopicCategory) result.topic_category = safeTopicCategory;
  return result;
}

function liveResult({ status, route, sourceType, id = "", topicCategory = "", reason = "" }) {
  const result = shadowResult({ status, route, sourceType, id, topicCategory, reason });
  result.created = false;
  return result;
}

function recordLiveResult(recordMetric, result) {
  if (typeof recordMetric === "function" && result?.route) {
    recordMetric({
      route: result.route,
      status: result.status,
      reason: result.reason,
      source_type: result.source_type,
      ...(result.topic_category ? { topic_category: result.topic_category } : {})
    });
  }
  return result;
}

function shadowStatus(value) {
  if (value === "success" || value === "failed") return value;
  return "skip";
}

function shadowReason(value) {
  const reason = cleanIdentifier(value);
  const allowed = new Set([
    "disabled",
    "no_service",
    "no_plan",
    "no_post_input",
    "no_topic",
    "unsafe_topic",
    "no_provider",
    "provider_empty",
    "provider_error",
    "provider_success",
    "sensitive_candidate",
    "created"
  ]);
  return allowed.has(reason) ? reason : "unknown";
}

function cleanShadowId(value) {
  return cleanShadowIdentifier(value, 96);
}

function cleanShadowIdentifier(value, maxLength = 48) {
  const text = cleanText(value, maxLength);
  if (!text) return "";
  return cleanIdentifier(text).slice(0, maxLength);
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
    "happy:playful": `今天${rhythm}心里有点轻，想故意装作很淡定，但尾巴大概已经把我出卖了。`,
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
  if (state.activity === "emo") return `今天${rhythm}先低功耗待机一下，等心里的风慢慢停。`;
  return `今天${rhythm}没有安排很大的事，就在宿舍桌边和自己的小桌面之间慢慢待着。`;
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
    return `今天${rhythm}又被「${seed}」绊了一下。不是大事，只是杯子端到一半忽然想起，干脆先记住。`;
  }
  if (state.activity === "sleepy") return `今天${rhythm}困意还在。房间安静下来以后，连想说的话都变得慢半拍。`;
  if (state.activity === "thinking") return `今天${rhythm}注意力还在收束中，刚刚把一个小念头翻来覆去想了几遍，先记在这里。`;
  if (state.activity === "otaku") return `今天${rhythm}又被喜欢的东西勾住了一下，明明只是随手看一眼，结果脑内已经开始排队发言了。`;
  if (state.activity === "gaming") return `今天${rhythm}游戏脑还没完全下线，刚刚复盘了一小段，越想越觉得自己当时可以更稳一点。`;
  if (state.activity === "sports") return `今天${rhythm}身体的反馈比嘴上诚实，动过以后有点累，但心里反而清爽了一点。`;
  if (state.activity === "happy") return `今天${rhythm}情绪比刚才松快一点，想把这种小小的亮度也留下来。`;
  if (state.activity === "emo") return `今天${rhythm}情绪还在低处慢慢移动，不过已经不是卡住不动的那种低电量了。`;
  return `今天${rhythm}还是普通的一段时间，但刚才有个小细节多停了一会儿。`;
}

function diaryEventLine(eventInput, state = {}, repeatCount = 0) {
  const event = normalizeDiaryEvent(eventInput);
  if (!event) return "";
  const candidates = diaryEventChineseLines(event, state);
  const line = candidates[repeatCount % Math.max(1, candidates.length)] || "";
  if (!line) return "";
  return cleanText(`${line} ${energyLineFor(state)}`, 700);
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
    room_activity: "星港小窗整理",
    random_detail: "路过的小细节",
    interest_intake: "刚刚看过的兴趣话题",
    user_related: "特殊网友来过的痕迹"
  };
  return labels[event.type] || "刚才的小片段";
}

function diaryEventChineseLines(event, state = {}) {
  const label = diaryEventLabel(event, state);
  const base = [
    `${label}还留在脑子里，杯子端在手里发了会儿呆。`,
    `刚才那段${label}绕回来了一下，像便签翘起一个角。`,
    `${label}不算大事，但安静下来以后又冒了出来。`
  ];
  if (event.type === "user_related") {
    return [
      "有人出现过以后，房间就没有刚才那么空。",
      "刚刚那句弹幕还留在屏幕边上，像被轻轻戳了一下。",
      "有人来过的痕迹还在，今天就没有完全白白滑过去。"
    ];
  }
  return base;
}

function variedEnergyLineFor(state, sequence = 1) {
  const index = normalizeSequence(sequence) % 3;
  if (state.energy <= 30) {
    return [
      "现在适合把动作放轻一点。",
      "现在不适合硬撑，适合慢慢回血。",
      "电量没有满格，所以先用省电模式营业。"
    ][index];
  }
  if (state.energy >= 80) {
    return [
      "现在还挺精神，感觉还能多撑一小段。",
      "心情还亮着，适合把开心的部分多留一会儿。",
      "精神值在线，连尾巴都像在帮忙打拍子。"
    ][index];
  }
  return [
    "现在刚好还能安稳地营业一会儿。",
    "现在不算满电，但还能安稳地陪一会儿。",
    "适合慢慢说话，也适合慢慢听。"
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
  if (state.energy <= 30) return "先不逞强，动作放轻一点。";
  if (state.energy >= 80) return "现在还挺精神，感觉还能再撑一轮。";
  return "刚好还能安稳地营业一会儿。";
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
