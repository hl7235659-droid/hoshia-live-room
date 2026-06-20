import { recognizeMusicIntent } from "./ai-adapter.js";
import { isLikelyMusicRequestText, parseLocalMusicControlText } from "./music-service.js";

export function createMusicDanmakuController({
  config,
  musicService,
  moduleEventStore,
  moduleProviders,
  createMusicSongRequestedEvent,
  createMusicControlEvent,
  normalizeStoredAiProfile,
  appendMusicSongRequestedCharacterEvent,
  appendMusicControlCharacterEvent,
  broadcastSystemText,
  sendToSession,
  broadcastMusicState,
  friendlyMusicError,
  buildModuleContext,
  buildHostLifeContext,
  roomInfo,
  audiencePayload,
  activeUserConnections,
  hoshiaPersonaPrompt,
  generateAiReply,
  roomAiSession,
  messageEvent,
  storeMessage,
  broadcast,
  setCharacterState,
  isValidState,
  fetchImpl = globalThis.fetch
}) {
async function handleMusicRequestFromDanmaku(session, query, originalText = "") {
  const result = await musicService.requestSong(query, session);
  if (result.ok) {
    moduleEventStore.append(createMusicSongRequestedEvent(result.track, session, {
      roomId: config.roomId,
      memoryEligible: normalizeStoredAiProfile(session.ai_profile)?.memory_enabled === true,
      retentionDays: 30
    }));
    appendMusicSongRequestedCharacterEvent(result.track, session);
    await broadcastSystemText(`♪ ${session.nickname} 点歌《${result.track.title}》已加入播放。`);
    queueMusicAcknowledgementReply(session, [result.track], originalText || `song request ${query}`);
  } else {
    await broadcastSystemText(`♪ 点歌失败：${friendlyMusicError(result.error)}`);
    sendToSession(session.user_id, { type: "music_error", error: result.error });
  }
  broadcastMusicState(session);
}

async function handleNaturalMusicIntentFromDanmaku(session, text) {
  if (!config.musicEnabled) return false;
  const musicState = musicService.publicState(session);
  const localIntent = parseLocalMusicControlText(text);
  if (isActionableMusicIntent(localIntent)) {
    await handleActionableMusicIntent(session, localIntent, musicState, text);
    return true;
  }
  if (!["astrbot", "hoshiaclaw"].includes(config.aiMode)) return false;
  const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 });
  const intent = await recognizeMusicIntent(session, text, config, globalThis.fetch, {
    musicState,
    moduleEvents
  });
  if (!isActionableMusicIntent(intent)) {
    if (isLikelyMusicRequestText(text)) {
      await broadcastSystemText("♪ 没有成功点歌，请用 /song 歌名 再试一次。");
      return true;
    }
    return false;
  }

  await handleActionableMusicIntent(session, intent, musicState, text);
  return true;
}

async function handleActionableMusicIntent(session, intent, musicState, originalText = "") {
  if (intent.intent === "request") {
    await handleMusicRequestFromDanmaku(session, intent.query, originalText);
    return true;
  }

  if (intent.intent === "request_many") {
    await handleBulkMusicRequestFromDanmaku(session, intent, originalText || intent.query || "bulk song request");
    return true;
  }

  if (intent.intent === "status") {
    await broadcastSystemText(formatMusicStatusText(musicState));
    return true;
  }

  const payload = musicControlPayloadFromIntent(intent);
  const result = musicService.control(intentToMusicControl(intent.intent), session, payload, {
    naturalLanguage: true
  });
  broadcastMusicState(session);
  if (result.ok) {
    moduleEventStore.append(createMusicControlEvent(intentToMusicControl(intent.intent), session, {
      roomId: config.roomId,
      status: "done",
      sourceKind: "natural_language"
    }));
    appendMusicControlCharacterEvent(intentToMusicControl(intent.intent), session, { sourceKind: "natural_language" });
    await broadcastSystemText(intent.reply_hint || formatMusicControlSuccess(session, intent));
  } else {
    await broadcastSystemText(`♪ 音乐操作失败：${friendlyMusicError(result.error)}`);
    sendToSession(session.user_id, { type: "music_error", error: result.error });
  }
  return true;
}

function isActionableMusicIntent(intent) {
  if (!intent || intent.intent === "none") return false;
  if (Number(intent.confidence || 0) < 0.72) return false;
  if (intent.intent === "request") return Boolean(String(intent.query || "").trim());
  if (intent.intent === "request_many") {
    return Boolean(String(intent.query || "").trim() || (Array.isArray(intent.queries) && intent.queries.length));
  }
  return ["pause", "resume", "next", "previous", "remove", "status"].includes(intent.intent);
}

async function handleBulkMusicRequestFromDanmaku(session, intent, originalText = "") {
  const result = await musicService.requestSongs({
    query: intent.query,
    queries: intent.queries,
    count: intent.count
  }, session);

  if (result.ok) {
    for (const track of result.tracks || []) {
      moduleEventStore.append(createMusicSongRequestedEvent(track, session, {
        roomId: config.roomId,
        memoryEligible: normalizeStoredAiProfile(session.ai_profile)?.memory_enabled === true,
        retentionDays: 30
      }));
      appendMusicSongRequestedCharacterEvent(track, session);
    }
    await broadcastSystemText(formatBulkMusicRequestSuccess(intent, result));
    queueMusicAcknowledgementReply(session, result.tracks || [], originalText || intent.query || "bulk song request");
  } else {
    await broadcastSystemText(`♪ 批量点歌失败：${friendlyMusicError(result.error)}`);
    sendToSession(session.user_id, { type: "music_error", error: result.error });
  }
  broadcastMusicState(session);
}

function formatBulkMusicRequestSuccess(intent, result) {
  const label = String(intent.query || intent.queries?.[0] || "歌单").trim();
  const titles = (result.tracks || []).slice(0, 5).map((track) => track.title).filter(Boolean);
  const suffix = titles.length ? `：${titles.join("、")}` : "";
  return `♪ 已加入 ${result.added_count || titles.length} 首${label}${suffix}`;
}

function intentToMusicControl(intent) {
  if (intent === "pause") return "pause";
  if (intent === "resume") return "resume";
  if (intent === "next") return "next";
  if (intent === "previous") return "previous";
  if (intent === "remove") return "remove";
  return "";
}

function musicControlPayloadFromIntent(intent) {
  const target = intent?.target || {};
  if (target.kind === "queue_index") return { queueIndex: target.index };
  if (target.kind === "requested_by_self") return { requestedBySelf: true };
  return {};
}

function formatMusicControlSuccess(session, intent) {
  if (intent.intent === "pause") return `♪ Hoshia 已帮 ${session.nickname} 暂停播放。`;
  if (intent.intent === "resume") return `♪ Hoshia 已帮 ${session.nickname} 继续播放。`;
  if (intent.intent === "next") return `♪ Hoshia 已帮 ${session.nickname} 切到下一首。`;
  if (intent.intent === "previous") return `♪ Hoshia 已帮 ${session.nickname} 切回上一首。`;
  if (intent.intent === "remove") return `♪ Hoshia 已帮 ${session.nickname} 删除待播歌曲。`;
  return `♪ Hoshia 已处理音乐操作。`;
}

function formatMusicStatusText(state) {
  const current = state.current ? trackSummary(state.current) : "暂无正在播放";
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const queueText = queue.length
    ? queue.slice(0, 3).map((track, index) => `${index + 1}. ${trackSummary(track)}`).join("；")
    : "待播为空";
  return `♪ 当前：${current}。待播 ${queue.length} 首：${queueText}`;
}

function trackSummary(track) {
  if (!track) return "";
  const title = String(track.title || "未知歌曲");
  const artist = String(track.artist || "");
  return artist ? `${title} - ${artist}` : title;
}

function queueMusicAcknowledgementReply(session, tracks, originalText = "") {
  void sendMusicAcknowledgementReply(session, tracks, originalText).catch((error) => {
    console.warn("music_ack_reply_failed", {
      type: error?.name || "Error",
      message: error?.message || String(error)
    });
  });
}

async function sendMusicAcknowledgementReply(session, tracks, originalText = "") {
  if (!config.musicEnabled || config.aiMode !== "astrbot") return;
  const safeTracks = (Array.isArray(tracks) ? tracks : []).filter(Boolean).slice(0, 5);
  if (!safeTracks.length) return;

  const trackLines = safeTracks.map((track, index) => `${index + 1}. ${trackSummary(track)}`).join("\n");
  const countText = safeTracks.length > 1 ? `${safeTracks.length} songs are queued` : `the song ${trackSummary(safeTracks[0])} is queued`;
  const moduleContext = buildModuleContext({ providers: moduleProviders, session });
  const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 });
  const hostLifeContextLines = buildHostLifeContext({
    config,
    room: roomInfo(),
    batch: [{
      session,
      text: originalText || `song request ${trackSummary(safeTracks[0])}`,
      mentioned: true,
      timestamp: new Date().toISOString()
    }],
    audienceUsers: audiencePayload().users,
    activeConnections: activeUserConnections,
    moduleContext,
    moduleEvents
  });
  const prompt = [
    hoshiaPersonaPrompt,
    "刚才有人成功点了一首歌。前面的确认已经发出，现在只补一句自然的回应。",
    ...(hostLifeContextLines.length ? [
      "当前状态参考：",
      ...hostLifeContextLines
    ] : []),
    `留言昵称：${session.nickname}`,
    `原始留言：${String(originalText || "").slice(0, 120)}`,
    `队列中的歌：\n${trackLines}`,
    "要求：",
    `- 清楚带出“${countText}”，但不要机械重复前面的确认语。`,
    "- 可以轻轻猜一下对方为什么现在想听这首歌，但要用也许、像是、可能是之类的不确定说法，不要装成很确定。",
    "- 保持 Hoshia 的一点自我感：像熟人回话，不要像工单。",
    "- 不要提内部接口、网址、队列编号、cookie、QQ 凭据或提供方细节。",
    "- 用中文回复，恰好一句，最多 80 个汉字，温暖自然。"
  ].join("\n");

  const reply = await generateAiReply(roomAiSession([{ session }]), prompt, config, globalThis.fetch, {
    roomSession: true,
    forceReply: true,
    replyMode: "music_ack",
    replyTargets: [session.nickname].filter(Boolean),
    moduleContext,
    moduleEvents,
    messages: [{
      user_id: session.user_id,
      nickname: session.nickname,
      text: originalText || `song request ${trackSummary(safeTracks[0])}`,
      mentioned: true,
      memory_enabled: normalizeStoredAiProfile(session.ai_profile)?.memory_enabled === true,
      timestamp: new Date().toISOString()
    }]
  });

  if (reply?.skipped || !reply?.text || reply.source !== "astrbot") return;

  const aiMessage = messageEvent("ai_reply", "ai", String(reply.text).slice(0, 220), {
    user_id: "ai-host",
    nickname: "Hoshia"
  }, {
    source: reply.source,
    latency_ms: reply.latency_ms,
    music_ack: true
  });
  await storeMessage(aiMessage);
  broadcast(aiMessage);
  await setCharacterState(isValidState(reply.state) ? reply.state : "SPEAKING");
  setTimeout(() => void setCharacterState("IDLE"), 1400);
}


  return {
    handleMusicRequestFromDanmaku,
    handleNaturalMusicIntentFromDanmaku
  };
}
