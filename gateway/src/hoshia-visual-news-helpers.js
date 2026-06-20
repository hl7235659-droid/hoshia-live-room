import { publicPost } from "./hoshia-life-memory.js";

export function createHoshiaVisualNewsHelpers({
  config,
  db,
  hoshiaVisualStateService,
  moduleEventStore,
  createHoshiaVisualStateChangedEvent,
  appendVisualStateChangedCharacterEvent,
  hoshiaNewsService
}) {
  function statusFromDailyPostTick(result = {}) {
    if (result?.post && result?.created) return "success";
    if (String(result?.status || "") === "failed") return "failed";
    if (String(result?.reason || "").includes("failed")) return "failed";
    return "skip";
  }
  function updateHoshiaVisualState({ body = {}, session = null, reason = "" } = {}) {
    if (typeof body.text === "string") {
      return hoshiaVisualStateService.applyUserInteraction({
        text: body.text,
        session
      });
    }
    const payload = {
      mood: body.mood,
      activity: body.activity,
      energy: body.energy,
      social_need: body.social_need ?? body.socialNeed,
      state_reason: body.state_reason ?? body.stateReason ?? reason
    };
    return hoshiaVisualStateService.update(payload, session);
  }

  function appendHoshiaNewsEvent({ eventType, session = null, summaryHint = "", data = {} } = {}) {
    if (!eventType || !summaryHint) return null;
    const occurredAt = new Date().toISOString();
    const moduleEvent = moduleEventStore.append({
      room_id: config.roomId,
      module_id: "hoshia_news",
      event_type: eventType,
      user_id: session?.user_id || "",
      nickname: session?.nickname || "",
      summary_hint: summaryHint,
      memory_eligible: false,
      memory_kind: "hoshia_news_event",
      retention_days: 7,
      occurred_at: occurredAt,
      data
    });
    appendCharacterEvent({
      event_type: eventType,
      actor_type: session?.user_id ? "user" : "system",
      user_id: session?.user_id || "",
      nickname: session?.nickname || "",
      source_kind: "hoshia_news",
      source_id: moduleEvent?.id || `${eventType}:${occurredAt}`,
      occurred_at: occurredAt,
      public_hint: summaryHint,
      private_hint: summaryHint,
      reason: data?.reason || eventType,
      data: {
        status: data?.status || "observed",
        source_type: data?.source_type || "hoshia_news",
        topic: data?.topic || data?.category || "",
        category: data?.category || ""
      }
    });
    return moduleEvent;
  }

  function selectCachedNewsTopicForPost() {
    if (!config.hoshiaNewsEnabled || !config.hoshiaNewsPostEnabled) return null;
    const limit = Math.max(1, Number(config.hoshiaNewsPostDailyLimit || 1));
    const summary = getHoshiaOpsSummary();
    if (Number(summary.news?.news_post_count_today || 0) >= limit) return null;
    const topic = hoshiaNewsService.featuredTopic?.()
      || hoshiaNewsService.getTopics().find((item) => item?.post_seed && item?.title && isSafeNewsTopicForPost(item))
      || null;
    if (!topic) return null;
    if (!isFreshNewsTopic(topic)) return null;
    return topic;
  }

  function applyNewsSignalFromTopic(topic, session = null, reason = "news_topic") {
    const signal = deriveNewsSignalFromTopic(topic, reason);
    if (!signal) return { accepted: false, reason: "news_signal_invalid", state: hoshiaVisualStateService.publicState() };
    const result = hoshiaVisualStateService.applyNewsSignal(signal);
    if (result.accepted) {
      appendHoshiaNewsEvent({
        eventType: "hoshia_news.signal_applied",
        session,
        summaryHint: `News signal nudged Hoshia toward ${signal.activity_hint || "current"} / ${signal.mood_hint || "current"}`,
        data: {
          status: "applied",
          reason: signal.reason || reason
        }
      });
    }
    return result;
  }

  function deriveNewsSignalFromTopic(topic, reason = "news_topic") {
    if (!topic || typeof topic !== "object") return null;
    const seed = [
      topic.title,
      topic.state_signal,
      topic.reaction_style,
      Array.isArray(topic.meme_hooks) ? topic.meme_hooks.join(" ") : "",
      Array.isArray(topic.reply_hooks) ? topic.reply_hooks.join(" ") : "",
      topic.post_seed,
      topic.category
    ].filter(Boolean).join(" ").toLowerCase();
    const activity = inferNewsActivity(seed, topic.category);
    const mood = inferNewsMood(seed, activity);
    const signal = {
      activity_hint: activity,
      mood_hint: mood,
      energy_delta: inferNewsEnergyDelta(seed, activity),
      social_need_delta: inferNewsSocialDelta(seed, activity),
      expires_at: new Date(Date.now() + Math.max(1, Number(config.hoshiaNewsSignalTtlHours || 6)) * 60 * 60 * 1000).toISOString(),
      reason: String(topic.state_signal || topic.reaction_style || reason || topic.title || "news topic").slice(0, 160)
    };
    if (!signal.activity_hint && !signal.mood_hint && signal.energy_delta === 0 && signal.social_need_delta === 0) {
      return null;
    }
    return signal;
  }

  function inferNewsActivity(seed, category) {
    const safeCategory = String(category || "").toLowerCase();
    if (safeCategory === "anime_game" || safeCategory === "light_trends") return "otaku";
    if (safeCategory === "music_movie" || safeCategory === "tech_tools") return "thinking";
    if (safeCategory === "sports_campus") return "sports";
    if (/(游戏|电竞|排位|rank|开黑|队友|fps|moba|手游)/i.test(seed) || /game|esport/i.test(category || "")) return "gaming";
    if (/(二次元|番剧|动漫|漫画|meme|梗图|接梗|玩梗|联动)/i.test(seed)) return "otaku";
    if (/(运动|健身|跑步|训练|锻炼|体测)/i.test(seed)) return "sports";
    if (/(ai|模型|工具|开源|代码|科技|产品|开发)/i.test(seed) || /tech|ai|product/i.test(category || "")) return "thinking";
    if (/(睡|困|晚|夜|熬夜|深夜|凌晨)/i.test(seed)) return "sleepy";
    if (/(emo|难过|低落|崩|烦|破防|压力|吵)/i.test(seed)) return "emo";
    if (/(开心|乐|搞笑|热梗|爆笑|离谱|好玩)/i.test(seed)) return "happy";
    return "";
  }

  function inferNewsMood(seed, activity) {
    if (/(破防|生气|烦|吵|骂|离谱)/i.test(seed)) return "annoyed";
    if (/(困|晚|夜|熬夜|累)/i.test(seed)) return "sleepy";
    if (/(emo|难过|低落|孤独)/i.test(seed)) return "lonely";
    if (/(梗|笑|乐|搞笑|有趣|离谱)/i.test(seed)) return activity === "otaku" ? "excited" : "playful";
    if (/(ai|工具|代码|模型|开源|计划)/i.test(seed)) return "focused";
    if (activity === "gaming") return /(破防|逆风|上分失败|输)/i.test(seed) ? "annoyed" : "competitive";
    if (activity === "sports") return /(累|疲|喘|恢复)/i.test(seed) ? "tired" : "energetic";
    if (activity === "sleepy") return "sleepy";
    if (activity === "emo") return "emo";
    if (activity === "thinking") return "thinking";
    return "";
  }

  function inferNewsEnergyDelta(seed, activity) {
    if (/(困|晚|夜|熬夜|累|疲)/i.test(seed)) return -6;
    if (/(热梗|好笑|开心|爽|破防)/i.test(seed)) return 3;
    if (activity === "thinking") return -2;
    if (activity === "gaming") return 1;
    if (activity === "sports") return 2;
    return 0;
  }

  function inferNewsSocialDelta(seed, activity) {
    if (/(梗|接话|弹幕|评论|群聊|互动)/i.test(seed)) return 4;
    if (/(孤独|emo|低落|安静|没人)/i.test(seed)) return 6;
    if (activity === "sleepy") return 2;
    if (activity === "thinking") return -1;
    return 1;
  }

  function stateForNewsTopicPost(baseState, topic) {
    const signal = deriveNewsSignalFromTopic(topic, "news_topic_post");
    if (!signal) return baseState;
    return {
      ...baseState,
      energy: clampInt(Number(baseState?.energy || 0) + signal.energy_delta, 0, 100, 70),
      social_need: clampInt(Number(baseState?.social_need || 0) + signal.social_need_delta, 0, 100, 50),
      activity: signal.activity_hint || baseState?.activity || "idle",
      mood: signal.mood_hint || baseState?.mood || "calm"
    };
  }

  function isFreshNewsTopic(topic) {
    if (!topic) return false;
    const createdAt = Date.parse(topic.created_at || topic.date || "");
    if (!Number.isFinite(createdAt)) return true;
    const maxAgeHours = Math.max(1, Number(config.hoshiaNewsTopicMaxAgeHours || 36));
    return Date.now() - createdAt <= maxAgeHours * 60 * 60 * 1000;
  }

  function isSafeNewsTopicForPost(topic) {
    const risk = String(topic?.risk_level || topic?.riskLevel || topic?.risk || "").toLowerCase();
    return topic?.high_risk !== true && !["high", "critical", "unsafe", "blocked", "danger"].includes(risk);
  }

  function clampInt(value, min, max, fallback) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(number, max));
  }

  function tickHoshiaVisualState({ reason = "scheduled visual refresh" } = {}) {
    const now = new Date();
    const canonEvent = hoshiaDailyCanonService.getActiveEvent({ now, create: true });
    return hoshiaVisualStateService.tick({ reason, now, canonEvent });
  }

  function stateReasonForPostSource(sourceType) {
    if (sourceType === "state_pulse") return "Hoshia wrote a state pulse timeline update";
    if (sourceType === "news_topic") return "Hoshia wrote a news topic timeline update";
    return "Hoshia wrote a daily timeline update";
  }

  function publicPostForViewer(postId, viewerUserId) {
    return publicPost(db.listHoshiaPosts({
      characterId: "hoshia",
      limit: 100,
      viewerUserId
    }).find((item) => item.id === postId) || {
      ...db.getHoshiaPost(postId),
      like_count: 0,
      comment_count: 0,
      liked_by_viewer: false,
      interactions: db.listHoshiaPostInteractions(postId)
    });
  }

  return {
    appendHoshiaNewsEvent,
    applyNewsSignalFromTopic,
    publicPostForViewer,
    selectCachedNewsTopicForPost,
    stateForNewsTopicPost,
    statusFromDailyPostTick,
    tickHoshiaVisualState,
    updateHoshiaVisualState,
    isFreshNewsTopic,
    isSafeNewsTopicForPost,
    stateReasonForPostSource
  };
}
