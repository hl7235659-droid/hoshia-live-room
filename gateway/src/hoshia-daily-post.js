import { normalizePostInput } from "./hoshia-life-memory.js";
import {
  asDate,
  buildDailyPostContent,
  buildNewsTopicPostContent,
  cleanIdentifier,
  cleanText,
  clampInt,
  createHoshiaDailyPostCharacterEvent,
  createHoshiaDailyPostCreatedEvent,
  dayKeyFor,
  hasNewsTopicInput,
  normalizeDailyPostLimit,
  normalizeDailyPostMaximum,
  normalizeDailyPostMinimum,
  normalizeDailySourceType,
  normalizeNewsTopic,
  normalizeVisualState,
  reasonForSourceType
} from "./hoshia-daily-post-content.js";
export {
  buildDailyPostContent,
  buildNewsTopicPostContent,
  createHoshiaDailyPostCharacterEvent,
  createHoshiaDailyPostCreatedEvent,
  dayKeyFor,
  hasNewsTopicInput,
  normalizeDailyPostLimit,
  normalizeDailyPostMaximum,
  normalizeDailyPostMinimum
} from "./hoshia-daily-post-content.js";

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

function assertPostStore(db) {
  if (typeof db?.createHoshiaPost !== "function" || typeof db?.listHoshiaPosts !== "function") {
    throw new TypeError("Hoshia daily post service requires createHoshiaPost and listHoshiaPosts.");
  }
}
