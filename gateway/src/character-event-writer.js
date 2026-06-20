import { nanoid } from "nanoid";
import { normalizeCharacterEvent } from "./character-snapshot.js";

export function createCharacterEventWriter({
  config,
  db,
  hoshiaLifeMemoryService,
  observabilityCounters,
  recordRouteObservation
}) {
  function appendCharacterEvent(event = {}) {
    try {
      return db.insertCharacterEvent(normalizeCharacterEvent({
        ...event,
        room_id: config.roomId,
        character_id: "hoshia"
      }));
    } catch (error) {
      console.warn("character_event_append_failed", {
        type: error?.name || "Error",
        message: error?.message || String(error)
      });
      return null;
    }
  }

  function appendMusicSongRequestedCharacterEvent(track, session) {
    if (!track) return null;
    return appendCharacterEvent({
      event_type: "module.music.song_requested",
      actor_type: "user",
      user_id: session?.user_id || track.requested_by_id || "",
      nickname: session?.nickname || track.requested_by || "",
      source_kind: "music",
      source_id: track.id || "",
      occurred_at: track.requested_at || new Date().toISOString(),
      public_hint: "Viewer requested a song",
      private_hint: "Viewer requested a song",
      reason: "music song request",
      data: {
        title: track.title || "",
        artist: track.artist || "",
        source_type: track.source || "",
        status: "requested"
      }
    });
  }

  function appendMusicControlCharacterEvent(action, session, { sourceKind = "manual" } = {}) {
    const safeAction = String(action || "").slice(0, 40);
    if (!safeAction) return null;
    return appendCharacterEvent({
      event_type: "module.music.control",
      actor_type: "user",
      user_id: session?.user_id || "",
      nickname: session?.nickname || "",
      source_kind: "music",
      source_id: safeAction,
      public_hint: "Viewer used a music control",
      private_hint: "Viewer used a music control",
      reason: safeAction,
      data: {
        action: safeAction,
        status: "done",
        source: sourceKind
      }
    });
  }

  function appendVisualStateChangedCharacterEvent(state, session, { reason = "", source = "interaction" } = {}) {
    if (!state) return null;
    return appendCharacterEvent({
      event_type: "hoshia_visual_state.changed",
      actor_type: session?.user_id ? "user" : "system",
      user_id: session?.user_id || "",
      nickname: session?.nickname || "",
      source_kind: "hoshia_visual_state",
      source_id: source,
      occurred_at: state.updated_at || new Date().toISOString(),
      public_hint: "Hoshia visual state changed",
      private_hint: "Hoshia visual state changed",
      reason: reason || source,
      data: {
        activity: state.activity || "",
        mood: state.mood || "",
        source,
        status: "changed"
      }
    });
  }

  function appendTimelinePostCreatedCharacterEvent(post, session, { reason = "daily_post" } = {}) {
    if (!post) return null;
    return appendCharacterEvent({
      event_type: "hoshia_timeline.post_created",
      actor_type: session?.user_id ? "user" : "system",
      user_id: session?.user_id || "",
      nickname: session?.nickname || "",
      source_kind: "hoshia_timeline",
      source_id: post.id || "",
      occurred_at: post.created_at || new Date().toISOString(),
      public_hint: "Hoshia created a timeline post",
      private_hint: "Hoshia created a timeline post",
      reason,
      data: {
        activity: post.activity || "",
        mood: post.mood || "",
        source_type: post.source_type || reason,
        post_id: post.id || "",
        status: "created"
      }
    });
  }

  function appendTimelineCommentReplyCharacterEvent({ post, comment, reply, status = "replied" } = {}) {
    return appendCharacterEvent({
      event_type: status === "pending" ? "hoshia_timeline.comment_reply_pending" : "hoshia_timeline.comment_replied",
      actor_type: status === "pending" ? "user" : "ai",
      user_id: comment?.user_id || "",
      nickname: comment?.nickname || "",
      source_kind: "hoshia_timeline",
      source_id: comment?.id || reply?.id || "",
      occurred_at: reply?.created_at || comment?.created_at || new Date().toISOString(),
      public_hint: status === "pending" ? "Viewer left a timeline comment" : "Hoshia replied to a timeline comment",
      private_hint: status === "pending" ? "Viewer left a timeline comment" : "Hoshia replied to a timeline comment",
      reason: `timeline comment ${status}`,
      data: {
        activity: post?.activity || "",
        mood: post?.mood || "",
        post_id: post?.id || "",
        comment_id: comment?.id || "",
        status
      }
    });
  }

  function recordModuleMemoryEventsSafely(moduleMemoryEvents = []) {
    if (!Array.isArray(moduleMemoryEvents) || !moduleMemoryEvents.length) return [];
    try {
      const memories = typeof hoshiaLifeMemoryService.recordModuleMemoryEvents === "function"
        ? hoshiaLifeMemoryService.recordModuleMemoryEvents(moduleMemoryEvents)
        : moduleMemoryEvents.map((event) => hoshiaLifeMemoryService.recordModuleMemoryEvent?.(event)).filter(Boolean);
      for (const memory of memories) {
        appendCharacterEvent({
          event_type: "module.memory.recorded",
          actor_type: memory.user_id ? "user" : "system",
          user_id: memory.user_id || "",
          nickname: "",
          source_kind: "module_memory",
          source_id: memory.id || "",
          occurred_at: memory.created_at || new Date().toISOString(),
          public_hint: "A safe module memory was recorded",
          private_hint: "A safe module memory was recorded",
          reason: memory.source || "module_memory",
          data: {
            status: "recorded",
            memory_kind: memory.tags?.find?.((tag) => tag && tag !== "module_memory") || memory.source || "",
            memory_type: memory.type || "",
            source_module: memory.source || "module_memory"
          }
        });
      }
      return memories;
    } catch (error) {
      console.warn("module_memory_record_failed", {
        type: error?.name || "Error",
        message: safeMetricReason(error?.message || "module_memory_record_failed")
      });
      return [];
    }
  }

  function recordProactiveShadowMetric(metric = {}) {
    if (!String(metric?.eventType || "").startsWith("hoshiaclaw.proactive_shadow.")) return null;
    return recordShadowMetricEvent({ ...metric, route: "proactive_idle_shadow" });
  }

  function recordProactiveLiveMetric(metric = {}) {
    if (!String(metric?.eventType || "").startsWith("hoshiaclaw.proactive_live.")) return null;
    return recordShadowMetricEvent({ ...metric, route: "proactive_idle_live" });
  }

  function recordCommentReplyShadowMetric(metric = {}) {
    if (!String(metric?.eventType || "").startsWith("hoshiaclaw.comment_reply_shadow.")) return null;
    return recordShadowMetricEvent({ ...metric, route: "post_comment_reply_shadow" });
  }

  function recordDailyPostLiveMetric(metric = {}) {
    const route = metric?.route === "news_topic_live" ? "news_topic_live" : "daily_post_live";
    recordRouteObservation(observabilityCounters, route, metric?.status);
    return null;
  }

  function recordShadowMetricEvent({ eventType = "", status = "", reason = "", source = "", route = "", commentId = "", postId = "" } = {}) {
    if (!String(eventType || "").startsWith("hoshiaclaw.")) return null;
    const safeStatus = ["success", "skip", "failed"].includes(String(status || "")) ? String(status) : statusFromShadowEvent(eventType);
    const safeRoute = safeMetricIdentifier(route || routeFromShadowEvent(eventType), 80);
    const safeSource = safeMetricIdentifier(source || "hoshiaclaw", 80) || "hoshiaclaw";
    const safeReason = safeMetricReason(reason || safeStatus || "shadow_metric");
    const metricEventId = `shadow_${safeRoute || "shadow"}_${nanoid(10)}`;
    observabilityCounters.shadow[safeStatus] = Number(observabilityCounters.shadow[safeStatus] || 0) + 1;
    recordRouteObservation(observabilityCounters, safeRoute, safeStatus);
    return appendCharacterEvent({
      id: metricEventId,
      idempotency_key: `${config.roomId}:${eventType}:${metricEventId}`,
      event_type: eventType,
      actor_type: "system",
      source_kind: "hoshiaclaw",
      source_id: metricEventId,
      public_hint: `HoshiaClaw ${safeRoute || "shadow"} ${safeStatus}`,
      private_hint: `HoshiaClaw ${safeRoute || "shadow"} ${safeStatus}`,
      reason: safeReason,
      data: {
        status: safeStatus,
        source_type: safeSource,
        route: safeRoute,
        ...(postId ? { post_id: safeMetricIdentifier(postId, 80) } : {}),
        ...(commentId ? { comment_id: safeMetricIdentifier(commentId, 80) } : {})
      }
    });
  }

  return {
    appendCharacterEvent,
    appendMusicControlCharacterEvent,
    appendMusicSongRequestedCharacterEvent,
    appendTimelineCommentReplyCharacterEvent,
    appendTimelinePostCreatedCharacterEvent,
    appendVisualStateChangedCharacterEvent,
    recordCommentReplyShadowMetric,
    recordDailyPostLiveMetric,
    recordModuleMemoryEventsSafely,
    recordProactiveLiveMetric,
    recordProactiveShadowMetric
  };
}

function statusFromShadowEvent(eventType = "") {
  if (String(eventType).endsWith(".success")) return "success";
  if (String(eventType).endsWith(".skip")) return "skip";
  return "failed";
}

function routeFromShadowEvent(eventType = "") {
  const text = String(eventType || "");
  if (text.includes(".proactive_shadow.")) return "proactive_idle_shadow";
  if (text.includes(".proactive_live.")) return "proactive_idle_live";
  if (text.includes(".comment_reply_shadow.")) return "post_comment_reply_shadow";
  if (text.includes(".daily_post_shadow.")) return "daily_post_shadow";
  if (text.includes(".news_topic_generate_shadow.")) return "news_topic_generate_shadow";
  return "shadow";
}

export function safeMetricIdentifier(value, maxLength = 80) {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLength);
  if (!text || hasSensitiveMetricMarker(text)) return "";
  return text;
}

export function safeMetricReason(value, fallback = "shadow_metric") {
  const text = safeMetricIdentifier(value, 80);
  return text || fallback;
}

function hasSensitiveMetricMarker(value) {
  return /(?:token|secret|bearer|\.env|ssh|cloudflared|trycloudflare|https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|[A-Za-z]:[\\/]|\/home\/|\/root\/|\/users\/|\/var\/|\/etc\/|internal|raw[_-]?(?:prompt|response)|candidate[_-]?text)/i.test(String(value || ""));
}
