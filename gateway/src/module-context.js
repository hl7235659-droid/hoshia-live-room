const DEFAULT_MAX_EVENTS = 80;
const DEFAULT_RECENT_LIMIT = 24;

export function createModuleEventStore({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  const events = [];
  const safeMax = Math.max(1, Math.min(Number(maxEvents) || DEFAULT_MAX_EVENTS, 500));

  return {
    append(event) {
      const normalized = sanitizeModuleEvent(event);
      if (!normalized) return null;
      events.unshift(normalized);
      events.splice(safeMax);
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
    consumeRecent(options = {}) {
      return this.listRecent(options);
    },
    clear() {
      events.splice(0);
    },
    size() {
      return events.length;
    }
  };
}

export function buildModuleContext({ providers = [], musicService, session } = {}) {
  const contexts = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (typeof provider?.getCapabilityContext !== "function") continue;
    contexts.push(sanitizeModuleContext(provider.getCapabilityContext(session)));
  }
  if (musicService) {
    contexts.push(buildMusicModuleContext(musicService, session));
  }
  return contexts.filter(Boolean);
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
      "观众可通过弹幕点歌。",
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

export function createMusicSongRequestedEvent(track, session, {
  roomId = "",
  memoryEligible = false,
  retentionDays = 30
} = {}) {
  if (!track) return null;
  const title = cleanText(track.title, 120) || "未知歌曲";
  const artist = cleanText(track.artist, 120);
  const requester = cleanText(session?.nickname || track.requested_by, 32) || "观众";
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
  for (const key of ["title", "artist", "source"]) {
    const value = cleanText(data[key], key === "source" ? 40 : 120);
    if (value) allowed[key] = value;
  }
  return allowed;
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
  if (/(?:\.env|ssh-|BEGIN [A-Z ]*PRIVATE KEY|token=|password=|secret=)/i.test(text)) return "";
  return text;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
