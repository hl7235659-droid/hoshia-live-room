import { visualDescriptionForStagePng } from "./hoshia-visual-state.js";

const DEFAULT_MAX_EVENTS = 80;
const DEFAULT_RECENT_LIMIT = 24;

export function createModuleEventStore({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  const events = [];
  const pendingMemoryEvents = [];
  const safeMax = Math.max(1, Math.min(Number(maxEvents) || DEFAULT_MAX_EVENTS, 500));

  return {
    append(event) {
      const normalized = sanitizeModuleEvent(event);
      if (!normalized) return null;
      events.unshift(normalized);
      events.splice(safeMax);
      if (normalized.memory_eligible) {
        pendingMemoryEvents.unshift(normalized);
        pendingMemoryEvents.splice(safeMax);
      }
      return normalized;
    },
    listRecent({ roomId = "", limit = DEFAULT_RECENT_LIMIT, userIds = [] } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RECENT_LIMIT, 100));
      const room = cleanText(roomId, 80);
      const userSet = new Set((Array.isArray(userIds) ? userIds : []).map((item) => cleanText(item, 80)).filter(Boolean));
      return events
        .filter((event) => !room || !event.room_id || event.room_id === room)
        .filter((event) => !userSet.size || userSet.has(event.user_id))
        .slice(0, safeLimit)
        .map((event) => ({ ...event }));
    },
    consumeMemoryEvents({ roomId = "", limit = DEFAULT_RECENT_LIMIT, userIds = [] } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RECENT_LIMIT, 100));
      const room = cleanText(roomId, 80);
      const userSet = new Set((Array.isArray(userIds) ? userIds : []).map((item) => cleanText(item, 80)).filter(Boolean));
      const consumed = [];
      for (let index = 0; index < pendingMemoryEvents.length && consumed.length < safeLimit;) {
        const event = pendingMemoryEvents[index];
        const roomMatches = !room || !event.room_id || event.room_id === room;
        const userMatches = !userSet.size || userSet.has(event.user_id);
        if (roomMatches && userMatches) {
          consumed.push(event);
          pendingMemoryEvents.splice(index, 1);
          continue;
        }
        index += 1;
      }
      return consumed.map((event) => ({ ...event }));
    },
    restoreMemoryEvents(restoredEvents = []) {
      for (const event of [...restoredEvents].reverse()) {
        const normalized = sanitizeModuleEvent(event);
        if (!normalized?.memory_eligible) continue;
        pendingMemoryEvents.unshift(normalized);
      }
      pendingMemoryEvents.splice(safeMax);
    },
    clear() {
      events.splice(0);
      pendingMemoryEvents.splice(0);
    },
    size() {
      return events.length;
    },
    pendingMemorySize() {
      return pendingMemoryEvents.length;
    }
  };
}

export function buildModuleContext({ providers = [], session } = {}) {
  const contexts = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (typeof provider?.getCapabilityContext !== "function") continue;
    contexts.push(sanitizeModuleContext(provider.getCapabilityContext(session)));
  }
  return contexts.filter(Boolean);
}

export function createMusicModuleProvider(musicService) {
  return {
    moduleId: "music",
    getCapabilityContext(session) {
      return buildMusicModuleContext(musicService, session);
    }
  };
}

export function createHoshiaVisualModuleProvider(visualStateService) {
  return {
    moduleId: "hoshia_visual_state",
    getCapabilityContext(session) {
      return buildHoshiaVisualModuleContext(visualStateService, session);
    }
  };
}

export function createHoshiaNewsModuleProvider(newsService) {
  return {
    moduleId: "hoshia_news",
    getCapabilityContext(session) {
      return buildHoshiaNewsModuleContext(newsService, session);
    }
  };
}

export function createHoshiaInterestModuleProvider(interestSystem) {
  return {
    moduleId: "hoshia_interest_system",
    getCapabilityContext(session) {
      return buildHoshiaInterestModuleContext(interestSystem, session);
    }
  };
}

export function createHoshiaLifeModuleProvider(lifeSystem) {
  return {
    moduleId: "hoshia_life_system",
    getCapabilityContext(session) {
      return buildHoshiaLifeModuleContext(lifeSystem, session);
    }
  };
}

export function buildMusicModuleContext(musicService, session) {
  const state = typeof musicService?.publicState === "function"
    ? musicService.publicState(session)
    : { enabled: false };

  if (!state.enabled) {
    return sanitizeModuleContext({
      module_id: "music",
      enabled: false,
      current_state: ["音乐模块未启用。"],
      capabilities: [],
      limits: ["当前不能点歌、控制播放或查看队列。"]
    });
  }

  const currentState = [`音乐模块状态：${cleanText(state.status || "idle", 32)}。`];
  if (state.current) {
    currentState.push(`当前播放：${formatTrackLine(state.current)}。`);
  } else {
    currentState.push("当前没有正在播放的歌曲。");
  }

  const queue = Array.isArray(state.queue) ? state.queue : [];
  currentState.push(`待播 ${queue.length} 首。`);
  for (const [index, track] of queue.slice(0, 5).entries()) {
    currentState.push(`待播 ${index + 1}：${formatTrackLine(track)}。`);
  }
  if (queue.length > 5) {
    currentState.push(`还有 ${queue.length - 5} 首未展开。`);
  }

  return sanitizeModuleContext({
    module_id: "music",
    enabled: true,
    current_state: currentState,
    capabilities: [
      "特殊网友可以通过留言点歌。",
      "可以查看当前播放、待播队列和点歌人。",
      "可以基于当前队列评价歌单风格与氛围。"
    ],
    limits: [
      "只能基于当前播放、待播队列和最近点歌事件回答。",
      "不能声称已经读取完整曲库、外部歌单或服务端文件。",
      "不要暴露音乐服务的内部地址、凭据或配置。"
    ]
  });
}

export function buildHoshiaVisualModuleContext(visualStateService, session) {
  const state = typeof visualStateService?.publicState === "function"
    ? visualStateService.publicState(session)
    : null;

  if (!state) {
    return sanitizeModuleContext({
      module_id: "hoshia_visual_state",
      enabled: false,
      current_state: ["Hoshia visual state is unavailable."],
      capabilities: [],
      limits: ["The stage PNG state could not be loaded."]
    });
  }

  return sanitizeModuleContext({
    module_id: "hoshia_visual_state",
    enabled: true,
    current_state: [
      `Hoshia visual activity: ${cleanText(state.activity, 32)}.`,
      `Hoshia visual mood: ${cleanText(state.mood, 32)}.`,
      `Current stage PNG: ${cleanText(assetLabelForPath(state.current_png), 64)}.`,
      `Self-view description: ${cleanText(state.visual_description || visualDescriptionForStagePng(state.current_png), 180)}.`
    ],
    capabilities: [
      "The room can show a state-driven Hoshia PNG when Live2D is unavailable.",
      "The visible stage can reflect mood, activity, energy, and social need.",
      "Hoshia can know her current outfit, pose, expression, props, and stage atmosphere from asset metadata.",
      "State changes are based on public room activity and scheduled ticks."
    ],
    limits: [
      "Only public-facing visual state is exposed.",
      "No filesystem paths, tokens, or internal storage details are revealed.",
      "The module only describes the current stage mood and asset label."
    ]
  });
}

export function buildHoshiaNewsModuleContext(newsService, session) {
  const state = publicNewsState(newsService, session);
  if (!state.enabled) {
    return sanitizeModuleContext({
      module_id: "hoshia_news",
      enabled: false,
      current_state: ["Hoshia news topics are disabled."],
      capabilities: [],
      limits: [
        "Do not claim access to live news, private feeds, source routes, search results, URLs, credentials, or raw source data."
      ]
    });
  }

  const currentState = [
    `News topic refresh: ${state.running ? "running" : "idle"}, stage ${state.stage}.`,
    `Safe topic count: ${state.topic_count}.`
  ];
  if (state.safe_summary) currentState.push(`Safe news summary: ${state.safe_summary}.`);
  if (state.recent_signal) currentState.push(`Recent news signal: ${state.recent_signal}.`);
  for (const [index, title] of state.recent_titles.slice(0, 5).entries()) {
    currentState.push(`Recent topic ${index + 1}: ${title}.`);
  }

  return sanitizeModuleContext({
    module_id: "hoshia_news",
    enabled: true,
    current_state: currentState,
    capabilities: [
      "Hoshia can use safe short news topic summaries as casual conversation hooks.",
      "Hoshia can notice the rough number of available topics and a few recent public titles.",
      "Hoshia can connect a topic to room chat only when it fits the current conversation."
    ],
    limits: [
      "Use news as light chat material, not as a news broadcast or source citation.",
      "Do not repeat raw feed text, URLs, provider names, private source routes, search queries, credentials, internal addresses, or file paths.",
      "Avoid heavy, risky, medical, legal, investment, or highly divisive topics unless the viewer explicitly asks."
    ]
  });
}

export function buildHoshiaInterestModuleContext(interestSystem, session) {
  const state = typeof interestSystem?.buildContext === "function"
    ? interestSystem.buildContext(session)
    : null;

  if (!state?.enabled) {
    return sanitizeModuleContext({
      module_id: "hoshia_interest_system",
      enabled: false,
      current_state: ["Hoshia interest and daily canon context is unavailable."],
      capabilities: [],
      limits: [
        "Do not invent private browsing, hidden data, or long-term preferences without safe context."
      ]
    });
  }

  const currentState = [
    ...(Array.isArray(state.current_state) ? state.current_state : [])
  ];

  return sanitizeModuleContext({
    module_id: "hoshia_interest_system",
    enabled: true,
    current_state: currentState,
    capabilities: [
      "Hoshia can use daily canon as lived context for mood, activity, timeline posts, and chat hooks.",
      "Hoshia can prefer high-priority interests while still answering low-interest topics when asked.",
      "Shared viewer interests may temporarily raise chat priority without storing raw event logs."
    ],
    limits: [
      "Use interest context as subjective reaction material, not as a news broadcast.",
      "Do not claim to have read real sources unless a safe topic summary is provided by another module.",
      "Do not expose internal field names, raw chat logs, URLs, credentials, paths, provider names, or configuration.",
      "Do not turn one isolated user action into a permanent preference unless memory context explicitly supports it."
    ]
  });
}

export function buildHoshiaLifeModuleContext(lifeSystem, session) {
  const state = typeof lifeSystem?.buildContext === "function"
    ? lifeSystem.buildContext(session)
    : null;

  if (!state?.enabled) {
    return sanitizeModuleContext({
      module_id: "hoshia_life_system",
      enabled: false,
      current_state: ["Hoshia 今天的星见大学日常片段暂时不可用。"],
      capabilities: [],
      limits: [
        "没有安全日常上下文时，不要编造完整校园日记。"
      ]
    });
  }

  const currentState = [
    state.date ? `今天的日期：${state.date}。` : "",
    state.theme ? `今天的生活底色：${state.theme}。` : "",
    state.diary_text ? `校园日记摘要：${state.diary_text}。` : "",
    state.emotional_arc ? `情绪节奏：${formatArcLine(state.emotional_arc)}。` : "",
    state.active_event ? `此刻正在经历的片段：${formatEventLine(state.active_event)}。` : ""
  ].filter(Boolean);
  const recentEvents = Array.isArray(state.recent_events) ? state.recent_events.slice(0, 3) : [];
  for (const [index, event] of recentEvents.entries()) {
    currentState.push(`刚留下的生活片段 ${index + 1}：${formatEventLine(event)}。`);
  }
  if (Array.isArray(state.current_focus_candidates) && state.current_focus_candidates.length) {
    currentState.push(`可以自然聊起的小话题：${state.current_focus_candidates.slice(0, 3).map((item) => cleanText(item, 80)).join("；")}。`);
  }

  return sanitizeModuleContext({
    module_id: "hoshia_life_system",
    enabled: true,
    current_state: currentState,
    capabilities: [
      "Hoshia 可以把今天的星见大学日程、当前片段和刚发生的小事当作生活背景。",
      "Hoshia 说话时可以轻轻展开校园日常细节，但必须基于标题、摘要、细节种子、聊天钩子或安全的用户参与。",
      "这些生活片段可以影响情绪、回复和聊天切入点，但不暴露原始日志。",
      "用户参与可以在相关时变成今天日记里的一小段安全陪伴。"
    ],
    limits: [
      "不要复述内部字段名或原始记忆 JSON。",
      "不要暴露私密日志、路径、token 或用户原始消息全文。",
      "不要把半虚构校园日记说成真实世界已验证事实、真实旅行、外部新闻、私下浏览或真实成就。",
      "把这些日记片段当作安全摘要，不要当成每件事的完整事实流水。"
    ]
  });
}

export function createMusicSongRequestedEvent(track, session, {
  roomId = "",
  memoryEligible = false,
  retentionDays = 30
} = {}) {
  if (!track) return null;
  const title = cleanText(track.title, 120) || "未知歌曲";
  const artist = cleanText(track.artist, 120);
  const requester = cleanText(session?.nickname || track.requested_by, 32) || "网友";
  const songText = artist ? `${title} - ${artist}` : title;
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "music",
    event_type: "music.song_requested",
    user_id: session?.user_id || track.requested_by_id || "",
    nickname: requester,
    summary_hint: `${requester} 点了 ${songText}`,
    memory_eligible: Boolean(memoryEligible),
    memory_kind: "music_preference_candidate",
    retention_days: retentionDays,
    occurred_at: track.requested_at || new Date().toISOString(),
    data: {
      title,
      artist,
      source: cleanText(track.source, 40)
    }
  });
}

export function createHoshiaVisualStateChangedEvent(state, session, {
  roomId = "",
  reason = "",
  source = "interaction"
} = {}) {
  if (!state) return null;
  const activity = cleanText(state.activity, 32);
  const mood = cleanText(state.mood, 32);
  const summary = cleanText(`Hoshia visual state changed to ${activity}/${mood}`, 240);
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "hoshia_visual_state",
    event_type: "hoshia_visual_state.changed",
    user_id: session?.user_id || "",
    nickname: cleanText(session?.nickname, 32),
    summary_hint: summary,
    memory_eligible: false,
    retention_days: 7,
    occurred_at: state.updated_at || new Date().toISOString(),
    data: {
      activity,
      mood,
      reason: cleanText(reason || source, 64)
    }
  });
}

export function createHoshiaPostCreatedEvent(post, session, {
  roomId = "",
  reason = "daily_post"
} = {}) {
  if (!post) return null;
  const activity = cleanText(post.activity, 32);
  const mood = cleanText(post.mood, 32);
  const sourceType = cleanText(post.source_type, 48);
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "hoshia_timeline",
    event_type: "hoshia_timeline.post_created",
    user_id: session?.user_id || "",
    nickname: cleanText(session?.nickname, 32),
    summary_hint: cleanText(`Hoshia posted a ${activity || "daily"} timeline update`, 240),
    memory_eligible: false,
    retention_days: 14,
    occurred_at: post.created_at || new Date().toISOString(),
    data: {
      activity,
      mood,
      source_type: sourceType,
      post_id: post.id,
      reason
    }
  });
}

export function createHoshiaCommentReplyEvent({ post, comment, reply, status = "replied" } = {}, {
  roomId = ""
} = {}) {
  const activity = cleanText(post?.activity, 32);
  const mood = cleanText(post?.mood, 32);
  const eventType = status === "pending"
    ? "hoshia_timeline.comment_reply_pending"
    : "hoshia_timeline.comment_replied";
  const viewer = cleanText(comment?.nickname, 32) || "viewer";
  return sanitizeModuleEvent({
    room_id: roomId,
    module_id: "hoshia_timeline",
    event_type: eventType,
    user_id: comment?.user_id || "",
    nickname: viewer,
    summary_hint: status === "pending"
      ? `${viewer} commented on Hoshia's timeline; a delayed reply is pending`
      : `Hoshia replied to ${viewer}'s timeline comment`,
    memory_eligible: false,
    retention_days: 14,
    occurred_at: reply?.created_at || comment?.created_at || new Date().toISOString(),
    data: {
      activity,
      mood,
      post_id: post?.id,
      comment_id: comment?.id,
      status
    }
  });
}

export function sanitizeModuleContext(context) {
  if (!context || typeof context !== "object") return null;
  const moduleId = cleanIdentifier(context.module_id, 48);
  if (!moduleId) return null;
  return {
    module_id: moduleId,
    enabled: Boolean(context.enabled),
    current_state: cleanList(context.current_state, 12, 180),
    capabilities: cleanList(context.capabilities, 12, 160),
    limits: cleanList(context.limits, 12, 180)
  };
}

export function sanitizeModuleEvent(event) {
  if (!event || typeof event !== "object") return null;
  const moduleId = cleanIdentifier(event.module_id, 48);
  const eventType = cleanIdentifier(event.event_type, 80);
  const userId = cleanText(event.user_id, 80);
  const summaryHint = cleanText(event.summary_hint, 240);
  if (!moduleId || !eventType || !summaryHint) return null;

  const normalized = {
    module_id: moduleId,
    event_type: eventType,
    user_id: userId,
    nickname: cleanText(event.nickname, 32),
    summary_hint: summaryHint,
    memory_eligible: Boolean(event.memory_eligible),
    memory_kind: cleanIdentifier(event.memory_kind || "module_event", 80),
    retention_days: clampInt(event.retention_days, 1, 365, 30),
    occurred_at: cleanText(event.occurred_at, 40) || new Date().toISOString()
  };
  const roomId = cleanText(event.room_id, 80);
  if (roomId) normalized.room_id = roomId;
  if (event.data && typeof event.data === "object") {
    normalized.data = sanitizeEventData(event.data);
  }
  return normalized;
}

function formatTrackLine(track) {
  const title = cleanText(track?.title, 120) || "未知歌曲";
  const artist = cleanText(track?.artist, 120);
  const requester = cleanText(track?.requested_by, 32);
  const song = artist ? `${title} - ${artist}` : title;
  return requester ? `${song}（${requester} 点的）` : song;
}

function sanitizeEventData(data) {
  const allowed = {};
  for (const key of ["title", "artist", "source", "activity", "mood", "reason", "source_type", "post_id", "comment_id", "status"]) {
    const value = cleanText(data[key], key === "source" ? 40 : 120);
    if (value) allowed[key] = value;
  }
  return allowed;
}

function publicNewsState(newsService, session) {
  const raw = typeof newsService?.getStatus === "function"
    ? newsService.getStatus(session)
    : typeof newsService?.publicState === "function"
      ? newsService.publicState(session)
      : newsService || {};
  if (raw && typeof raw.then === "function") {
    return {
      enabled: false,
      running: false,
      stage: "idle",
      topic_count: 0,
      recent_titles: [],
      recent_signal: "",
      safe_summary: ""
    };
  }
  const recentTitles = Array.isArray(raw.recent_titles)
    ? raw.recent_titles
    : Array.isArray(raw.recentTitles)
      ? raw.recentTitles
      : Array.isArray(raw.topics)
        ? raw.topics.map((topic) => topic?.title || topic)
        : [];
  return {
    enabled: Boolean(raw.enabled),
    running: Boolean(raw.running),
    stage: cleanIdentifier(raw.stage || "idle", 40) || "idle",
    topic_count: clampInt(raw.topic_count ?? raw.topicCount ?? recentTitles.length, 0, 100, 0),
    recent_titles: cleanList(recentTitles, 5, 100),
    recent_signal: cleanText(raw.recent_signal ?? raw.recentSignal, 140),
    safe_summary: cleanText(raw.safe_summary ?? raw.safeSummary ?? raw.summary, 160)
  };
}

function formatArcLine(arc = {}) {
  return [
    arc.morning ? `早上 ${cleanText(arc.morning, 36)}` : "",
    arc.afternoon ? `下午 ${cleanText(arc.afternoon, 36)}` : "",
    arc.evening ? `晚上 ${cleanText(arc.evening, 36)}` : "",
    arc.late_night ? `深夜 ${cleanText(arc.late_night, 36)}` : ""
  ].filter(Boolean).join("; ");
}

function formatEventLine(event = {}) {
  return [
    event.time_range ? cleanText(event.time_range, 16) : "",
    event.title ? cleanText(event.title, 40) : "",
    event.summary ? cleanText(event.summary, 90) : ""
  ].filter(Boolean).join(" - ");
}

function assetLabelForPath(path) {
  const value = cleanText(path, 120);
  if (!value) return "unknown asset";
  const match = value.match(/\/([^/]+)\.[a-z0-9]+$/i);
  return match ? match[1] : value;
}

function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanIdentifier(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, maxLength);
}

function cleanText(value, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (/(?:https?:\/\/|www\.|\.env\b|ssh-|BEGIN [A-Z ]*PRIVATE KEY|token\b|api[_-]?key|authorization:|bearer\s+|password=|secret=|rsshub|tavily|cloudflared|trycloudflare|localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|[A-Za-z]:[\\/]|\/home\/ubuntu|\/app\/data)/i.test(text)) return "";
  return text;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
