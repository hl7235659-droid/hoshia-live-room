export function prepareHoshiaCenterContext({
  batch = [],
  roomId = "",
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
  buildCharacterSnapshot
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
  const characterSnapshot = buildCharacterSnapshot(batch[0]?.session);
  const lifeMemoryPacket = contextPolicy.includeLifeMemory
    ? hoshiaLifeMemoryService.buildMemoryPacket({ batch, limit: contextPolicy.livingMemoryK || 3 })
    : [];

  return {
    moduleContext,
    moduleEvents,
    activeContext,
    characterSnapshot,
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
  return (Array.isArray(batch) ? batch : []).some((item) => /(闊充箰|姝寍姝屾洸|鐐规瓕|鎾斁|鏆傚仠|涓嬩竴棣東涓婁竴棣東闃熷垪|music|song|playlist|play|pause|queue)/i.test(String(item?.text || "")));
}
