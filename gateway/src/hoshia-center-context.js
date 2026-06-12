export function prepareHoshiaCenterContext({
  batch = [],
  roomId = "",
  characterId = "hoshia",
  characterStateAuthority = "legacy",
  contextPolicy = {},
  moduleProviders = [],
  moduleEventStore,
  hoshiaInterestKnowledgeService,
  hoshiaDailyCanonService,
  hoshiaVisualStateService,
  hoshiaLifeMemoryService,
  audienceUsers = [],
  buildModuleContext,
  buildActiveContext,
  buildCharacterSnapshot,
  getLatestCharacterSnapshot = null
} = {}) {
  for (const event of hoshiaInterestKnowledgeService.observeBatch(batch, { roomId })) {
    moduleEventStore.append(event);
  }

  const fullModuleContext = buildModuleContext({ providers: moduleProviders, session: batch[0]?.session });
  const fullModuleEvents = moduleEventStore.listRecent({ roomId, limit: contextPolicy.moduleEventLimit });
  const moduleContext = moduleContextForRoute(fullModuleContext, contextPolicy, batch);
  const moduleEvents = moduleEventsForRoute(fullModuleEvents, contextPolicy);
  const diaryEvent = hoshiaDailyCanonService.getActiveEvent({ now: new Date(), create: true });
  const activeContext = buildActiveContext({
    visualState: hoshiaVisualStateService.publicState(),
    audienceUsers,
    moduleContext,
    moduleEvents,
    batch,
    diaryEvent
  });
  const persistedCharacterSnapshot = characterStateAuthority === "event_log"
    ? getLatestCharacterSnapshot?.({ roomId, characterId, session: batch[0]?.session }) || null
    : null;
  const characterSnapshot = persistedCharacterSnapshot || buildCharacterSnapshot(batch[0]?.session);
  const characterSnapshotSource = persistedCharacterSnapshot ? "persisted" : "legacy";
  const lifeMemoryPacket = contextPolicy.includeLifeMemory
    ? hoshiaLifeMemoryService.buildMemoryPacket({ batch, limit: contextPolicy.livingMemoryK || 3 })
    : [];

  return {
    moduleContext,
    moduleEvents,
    activeContext,
    characterSnapshot,
    characterSnapshotSource,
    lifeMemoryPacket
  };
}

export function buildHoshiaReplyMetadata({
  batch = [],
  messages = null,
  replyRoute = "",
  contextPolicy = {},
  latencyTraceId = "",
  shortTermContext = {},
  characterSnapshotContext = null,
  activeContext = null,
  moduleContext = [],
  moduleEvents = [],
  moduleMemoryEvents = [],
  onDelta = null,
  replyTargets = []
} = {}) {
  return {
    roomSession: true,
    replyTargets,
    forceReply: batch.some((item) => item.forceReply),
    replyMode: batch.some((item) => item.forceReply) ? "single_user_direct" : "",
    replyRoute,
    activeContext,
    contextPolicy,
    latencyTraceId,
    recentContext: shortTermContext.recentContext,
    contextSummary: shortTermContext.contextSummary,
    characterSnapshotContext,
    moduleContext,
    moduleEvents,
    moduleMemoryEvents,
    onDelta,
    messages: Array.isArray(messages) ? messages : batch.map((item) => ({
      user_id: item.session.user_id,
      nickname: item.session.nickname,
      text: item.text,
      mentioned: item.mentioned,
      memory_enabled: false,
      timestamp: item.timestamp
    }))
  };
}

export async function buildShortTermAiContext({
  batch = [],
  contextPolicy = {},
  roomId = "",
  db,
  config = {},
  summarizeLiveRoomContext,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  if (contextPolicy.refreshSummarySync) {
    await refreshRoomContextSummary({ roomId, db, config, summarizeLiveRoomContext, fetchImpl, logger });
  } else if (contextPolicy.includeContextSummary) {
    void refreshRoomContextSummary({ roomId, db, config, summarizeLiveRoomContext, fetchImpl, logger });
  }
  const maxMessages = positiveInt(contextPolicy.recentContextLimit || config.shortTermContextMaxMessages, 100, 1, 500);
  const fetchLimit = Math.min(Math.max(maxMessages * 2, maxMessages), 1000);
  const messages = db.listRecentContextMessages(roomId, fetchLimit);
  const focusedMessages = selectContextMessagesForBatch(messages, batch, maxMessages);
  const summary = db.getRoomContextSummary(roomId);
  return {
    recentContext: focusedMessages.map((message) => contextPayloadMessage(message, {
      maxMessageLength: config.maxMessageLength
    })),
    contextSummary: contextPolicy.includeContextSummary ? summary?.summary_text || "" : ""
  };
}

export async function refreshRoomContextSummary({
  roomId = "",
  db,
  config = {},
  summarizeLiveRoomContext,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  if (config.aiMode !== "astrbot") return;
  const maxMessages = positiveInt(config.shortTermContextMaxMessages, 100, 20, 500);
  const lookbackMessages = positiveInt(config.contextSummaryLookbackMessages, 600, maxMessages + 20, 2000);
  const compressMessages = positiveInt(config.contextSummaryCompressMessages, 20, 1, 200);
  try {
    const existing = db.getRoomContextSummary(roomId);
    const messages = db.listContextMessagesAfter(
      roomId,
      existing?.summarized_until_created_at || "",
      existing?.summarized_until_id || "",
      lookbackMessages
    );
    if (messages.length <= maxMessages) return;

    const overflowCount = messages.length - maxMessages;
    const toSummarize = messages.slice(0, Math.min(compressMessages, overflowCount));
    if (!toSummarize.length) return;

    const summaryText = await summarizeLiveRoomContext(config, {
      previousSummary: existing?.summary_text || "",
      messages: toSummarize.map((message) => contextPayloadMessage(message, {
        maxMessageLength: config.maxMessageLength
      }))
    }, fetchImpl);
    if (!summaryText) return;

    const first = toSummarize[0];
    const last = toSummarize[toSummarize.length - 1];
    db.upsertRoomContextSummary({
      roomId,
      summaryText,
      summarizedUntilCreatedAt: last.created_at,
      summarizedUntilId: last.id,
      coverageStartTimestamp: existing?.coverage_start_timestamp || first.timestamp || first.created_at,
      coverageEndTimestamp: last.timestamp || last.created_at
    });
  } catch (error) {
    logger.warn?.("context_summary_refresh_failed", {
      type: error.name || "Error",
      message: error.message
    });
  }
}

export function selectContextMessagesForBatch(messages = [], batch = [], limit = 100) {
  if (!batch.some((item) => item.forceReply)) {
    return messages.slice(-limit);
  }
  const userId = String(batch[0]?.session?.user_id || "");
  const focused = messages.filter((message) => message.role === "ai" || message.user_id === userId);
  return focused.slice(-limit);
}

export function contextPayloadMessage(message = {}, { maxMessageLength = 500 } = {}) {
  return {
    role: message.role,
    user_id: message.user_id || "",
    nickname: message.nickname || "",
    text: String(message.text || "").slice(0, maxMessageLength),
    timestamp: message.timestamp || message.created_at || ""
  };
}

function positiveInt(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function moduleContextForRoute(moduleContext = [], contextPolicy = {}, batch = []) {
  if (!contextPolicy.fastLane) return moduleContext;
  const allowed = new Set(["hoshia_visual_state", "hoshia_visual", "hoshia_interest_system", "hoshia_interest_knowledge"]);
  if (batchMentionsMusic(batch)) allowed.add("music");
  return (Array.isArray(moduleContext) ? moduleContext : [])
    .filter((item) => allowed.has(item?.module_id))
    .map((item) => ({
      module_id: item.module_id,
      enabled: Boolean(item.enabled),
      current_state: (Array.isArray(item.current_state) ? item.current_state : []).slice(0, 2),
      capabilities: [],
      limits: []
    }))
    .filter((item) => item.enabled && item.current_state.length);
}

export function moduleEventsForRoute(moduleEvents = [], contextPolicy = {}) {
  if (!contextPolicy.fastLane) return moduleEvents;
  return (Array.isArray(moduleEvents) ? moduleEvents : [])
    .filter((item) => item?.summary_hint)
    .slice(0, 2);
}

function batchMentionsMusic(batch = []) {
  return (Array.isArray(batch) ? batch : []).some((item) => /(音乐|歌曲|点歌|播放|暂停|下一首|上一首|队列|music|song|playlist|play|pause|queue)/i.test(String(item?.text || "")));
}
