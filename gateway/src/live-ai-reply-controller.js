import { nanoid } from "nanoid";
import { nextCharacterState, isValidState } from "./state-machine.js";
import { buildRealityContext } from "./reality-context.js";
import { buildHostLifeContext } from "./host-life-context.js";
import { hoshiaPersonaPrompt } from "./hoshia-persona.js";
import {
  buildContextPolicy,
  classifyMessageRoute,
  formatActiveContextLines,
  quickReplyLead
} from "./message-router.js";
import { presentationFromClawEnvelope } from "./hoshia-presentation.js";
import { summarizeCharacterSnapshotForPrompt } from "./character-snapshot.js";
import {
  buildHoshiaReplyMetadata,
  buildShortTermAiContext,
  contextPayloadMessage as centerContextPayloadMessage,
  prepareHoshiaCenterContext
} from "./hoshia-center-context.js";
import { normalizeStoredAiProfile, replyStyleLabel } from "./ai-profile.js";

export function replyTargetsForBatch(batch = [], maxReplyTargets = 3) {
  const seen = new Set();
  const targets = [];
  for (const item of (Array.isArray(batch) ? batch : []).filter((entry) => entry?.mentioned)) {
    const nickname = String(item.session?.nickname || "").trim();
    if (!nickname || seen.has(nickname)) continue;
    seen.add(nickname);
    targets.push(nickname);
    if (targets.length >= maxReplyTargets) break;
  }
  return targets;
}

export function roomAiSessionForBatch(batch = [], roomId = "default-room") {
  const first = batch[0]?.session || {};
  return {
    user_id: "room",
    username: "room",
    nickname: "????????",
    room_id: first.room_id || roomId
  };
}

export function createLiveAiReplyController({
  activeUserConnections,
  appendCharacterEvent,
  audiencePayload,
  broadcast,
  broadcastAiReplyDelta,
  broadcastAiReplyDone,
  broadcastAiReplyPending,
  broadcastHoshiaPresentation,
  broadcastProgressiveReplyDeltas,
  buildCurrentCharacterSnapshot,
  buildEventLogCharacterSnapshot,
  buildGatewayLatencyBreakdown,
  buildModuleContext,
  config,
  createSentenceStreamEmitter,
  db,
  generateAiReply,
  handleMusicRequestFromDanmaku,
  hoshiaDailyCanonService,
  hoshiaInterestKnowledgeService,
  hoshiaInterestSystem,
  hoshiaLifeMemoryService,
  hoshiaVisualStateService,
  maxReplyBatchSize = 8,
  maxReplyTargets = 3,
  mentionReplyWindowMs = 1200,
  messageEvent,
  moduleEventStore,
  moduleProviders,
  observabilityCounters,
  recordAiProviderObservation,
  recordModuleMemoryEventsSafely,
  replyBatchWindowMs = 3200,
  roomInfo,
  scheduleProactiveReplyCheck,
  setCharacterState,
  singleUserReplyDelayMs = 600,
  fastReplyBatchWindowMs = 700,
  quickReplyLeadDelayMs = 850,
  storeMessage,
  summarizeLiveRoomContext,
  uniqueOnlineCount
}) {
  let pendingReplyBatch = [];
  let replyBatchTimer = null;
  let replyBatchRunning = false;
  const replyTargets = (batch) => replyTargetsForBatch(batch, maxReplyTargets);
  const roomAiSession = (batch) => roomAiSessionForBatch(batch, config.roomId);
  function enqueueAiReply(session, text) {
    const forceReply = isSingleUserDirectReply(session);
    const wasEmpty = pendingReplyBatch.length === 0;
    const enqueuedAtMs = performance.now();
    const item = {
      session,
      text,
      mentioned: mentionsHoshia(text),
      forceReply,
      timestamp: new Date().toISOString(),
      enqueuedAtMs,
      latencyTraceId: `reply_${nanoid(10)}`
    };
    item.replyRoute = classifyMessageRoute([item]);
    item.contextPolicy = buildContextPolicy(item.replyRoute, [item]);
    pendingReplyBatch.push(item);

    if (wasEmpty) {
      broadcastAiReplyPending({ traceId: item.latencyTraceId, route: item.replyRoute, batch: [item] });
      scheduleQuickReplyLead(item);
    }

    if (forceReply) {
      scheduleAiReplyBatch(singleUserReplyDelayMs);
      return;
    }

    if (pendingReplyBatch.length >= maxReplyBatchSize) {
      scheduleAiReplyBatch(0);
      return;
    }

    scheduleAiReplyBatch(nextReplyDelay());
  }

  function scheduleAiReplyBatch(delay) {
    if (replyBatchTimer) {
      clearTimeout(replyBatchTimer);
    }
    replyBatchTimer = setTimeout(() => {
      replyBatchTimer = null;
      void flushAiReplyBatch();
    }, delay);
  }

  async function flushAiReplyBatch() {
    if (replyBatchRunning) {
      scheduleAiReplyBatch(nextReplyDelay());
      return;
    }
    const batchSize = pendingReplyBatch[0]?.forceReply ? 1 : maxReplyBatchSize;
    const batch = pendingReplyBatch.splice(0, batchSize);
    if (!batch.length) return;

    replyBatchRunning = true;
    try {
      await handleAiReplyBatch(batch);
    } finally {
      replyBatchRunning = false;
      if (pendingReplyBatch.length) {
        scheduleAiReplyBatch(nextReplyDelay());
      }
    }
  }

  async function handleAiReplyBatch(batch) {
    const gatewayStartedAt = performance.now();
    const routeStartedAt = performance.now();
    const replyRoute = classifyMessageRoute(batch);
    const contextPolicy = buildContextPolicy(replyRoute, batch);
    const routerMs = Math.round(performance.now() - routeStartedAt);
    const latencyTraceId = batch[0]?.latencyTraceId || `reply_${nanoid(10)}`;
    const pendingVisibleMs = Math.max(0, Math.round(gatewayStartedAt - Number(batch[0]?.enqueuedAtMs || gatewayStartedAt)));
    const batchText = batch.map((item) => item.text).join("\n");
    await setCharacterState(nextCharacterState("ai_thinking", batchText));
    if (!contextPolicy.fastLane) await sleep(250);
    const contextStartedAt = performance.now();
    const {
      moduleContext,
      moduleEvents,
      activeContext,
      characterSnapshot,
      characterSnapshotSource,
      lifeMemoryPacket
    } = prepareHoshiaCenterContext({
      batch,
      roomId: config.roomId,
      characterId: "hoshia",
      characterStateAuthority: config.characterStateAuthority,
      contextPolicy,
      moduleProviders,
      moduleEventStore,
      hoshiaInterestKnowledgeService,
      hoshiaDailyCanonService,
      hoshiaVisualStateService,
      hoshiaLifeMemoryService,
      audienceUsers: audiencePayload().users,
      buildModuleContext,
      buildActiveContext,
      buildCharacterSnapshot: buildCurrentCharacterSnapshot,
      getLatestCharacterSnapshot: ({ roomId, characterId }) => buildEventLogCharacterSnapshot({ roomId, characterId }),
      appendCharacterEvent
    });
    if (config.characterStateAuthority === "event_log" && characterSnapshotSource !== "persisted") {
      observabilityCounters.eventLogFallback += 1;
    }
    if (characterSnapshotSource !== "persisted") {
      db.upsertCharacterSnapshot({
        roomId: config.roomId,
        characterId: "hoshia",
        snapshot: characterSnapshot
      });
    }
    const prompt = formatLiveRoomBatchPrompt(batch, lifeMemoryPacket, { activeContext, contextPolicy, moduleContext, moduleEvents });
    const shortTermContext = await buildShortTermAiContext({
      batch,
      contextPolicy,
      roomId: config.roomId,
      db,
      config,
      summarizeLiveRoomContext,
      fetchImpl: globalThis.fetch,
      logger: console
    });
    const moduleMemoryEvents = contextPolicy.consumeModuleMemoryEvents
      ? moduleEventStore.consumeMemoryEvents({ roomId: config.roomId, limit: 24 })
      : [];
    const contextLoadMs = Math.round(performance.now() - contextStartedAt);
    let streamedReply = false;
    let streamDeltaStarted = false;
    const streamEmitter = createSentenceStreamEmitter({ traceId: latencyTraceId, route: replyRoute });
    const replyMetadata = buildHoshiaReplyMetadata({
      batch,
      messages: batch.map((item) => ({
        user_id: item.session.user_id,
        nickname: item.session.nickname,
        text: item.text,
        mentioned: item.mentioned,
        memory_enabled: normalizeStoredAiProfile(item.session.ai_profile)?.memory_enabled === true,
        timestamp: item.timestamp
      })),
      replyTargets: replyTargets(batch),
      replyRoute,
      contextPolicy,
      latencyTraceId,
      shortTermContext,
      characterSnapshotContext: summarizeCharacterSnapshotForPrompt(characterSnapshot),
      activeContext,
      moduleContext,
      moduleEvents,
      moduleMemoryEvents,
      onDelta: ({ text: deltaText, route: deltaRoute } = {}) => {
        if (!streamDeltaStarted) {
          streamDeltaStarted = true;
          clearQuickReplyLead(batch);
        }
        streamedReply = true;
        streamEmitter.push(deltaText, deltaRoute || replyRoute);
      }
    });
    const reply = await generateAiReply(roomAiSession(batch), prompt, config, globalThis.fetch, replyMetadata);
    await streamEmitter.flush();
    if (reply.skipped) {
      recordAiProviderObservation(reply);
      clearQuickReplyLead(batch);
      moduleEventStore.restoreMemoryEvents(moduleMemoryEvents);
      broadcastAiReplyDone({ traceId: latencyTraceId, route: replyRoute, skipped: true });
      await setCharacterState("IDLE");
      scheduleProactiveReplyCheck();
      return;
    }
    recordAiProviderObservation(reply);
    recordModuleMemoryEventsSafely(moduleMemoryEvents);
    hoshiaInterestSystem.recordInteractionSignals({
      batch,
      moduleMemoryEvents
    });

    clearQuickReplyLead(batch);
    await handleReplyActions(reply, batch);
    if (!reply.streamed && !streamedReply) {
      await broadcastProgressiveReplyDeltas({
        traceId: latencyTraceId,
        route: reply.route || replyRoute,
        text: reply.text,
        hasLead: batch.some((item) => item.quickLeadSent)
      });
    }

    const aiMessage = messageEvent("ai_reply", "ai", reply.text, {
      user_id: "ai-host",
      nickname: "Hoshia"
    }, {
      source: reply.source,
      latency_ms: reply.latency_ms,
      latency_breakdown: buildGatewayLatencyBreakdown({
        replyBreakdown: reply.latency_breakdown,
        routerMs,
        contextLoadMs,
        gatewayStartedAt,
        pendingVisibleMs
      }),
      latency_trace_id: latencyTraceId,
      route: reply.route || replyRoute
    });
    await storeMessage(aiMessage);
    appendCharacterEvent({
      event_type: "ai.reply_sent",
      actor_type: "ai",
      source_kind: "ai_reply",
      source_id: aiMessage.id,
      public_hint: "Hoshia sent a live room reply",
      private_hint: "Hoshia sent a live room reply",
      reason: reply.route || replyRoute,
      data: {
        route: reply.route || replyRoute,
        source_type: reply.source || "unknown",
        status: "sent"
      }
    });
    broadcast(aiMessage);
    broadcastHoshiaPresentation(presentationFromClawEnvelope(reply, {
      traceId: latencyTraceId,
      state: isValidState(reply.state) ? reply.state : "SPEAKING",
      reason: reply.route || replyRoute
    }));
    broadcastAiReplyDone({ traceId: latencyTraceId, route: reply.route || replyRoute });
    await setCharacterState(isValidState(reply.state) ? reply.state : nextCharacterState("ai_reply", reply.text));
    setTimeout(() => void setCharacterState("IDLE"), 1400);
    scheduleProactiveReplyCheck();
  }

  async function handleReplyActions(reply = {}, batch = []) {
    const actions = Array.isArray(reply.actions) ? reply.actions : [];
    if (!actions.length) return;
    const session = batch.find((item) => item?.session)?.session;
    if (!session) return;
    for (const action of actions.slice(0, 3)) {
      if (action?.type !== "music.request") continue;
      const query = String(action.query || "").trim();
      if (!query) continue;
      await handleMusicRequestFromDanmaku(session, query, `ai action music request ${query}`);
    }
  }

  function scheduleQuickReplyLead(item) {
    const lead = quickReplyLead(item.replyRoute, item.text);
    if (!lead) return;
    item.quickLeadText = lead;
    item.quickLeadTimer = setTimeout(() => {
      item.quickLeadTimer = null;
      item.quickLeadSent = true;
      broadcastAiReplyDelta({
        traceId: item.latencyTraceId,
        route: item.replyRoute,
        text: lead,
        deltaMode: "replace",
        stage: "lead"
      });
    }, quickReplyLeadDelayMs);
  }

  function clearQuickReplyLead(batch = []) {
    for (const item of Array.isArray(batch) ? batch : []) {
      if (item?.quickLeadTimer) {
        clearTimeout(item.quickLeadTimer);
        item.quickLeadTimer = null;
      }
    }
  }



  function moduleContextForRoute(moduleContext = [], contextPolicy = {}, batch = []) {
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

  function moduleEventsForRoute(moduleEvents = [], contextPolicy = {}) {
    if (!contextPolicy.fastLane) return moduleEvents;
    return (Array.isArray(moduleEvents) ? moduleEvents : [])
      .filter((item) => item?.summary_hint)
      .slice(0, 2);
  }

  function batchMentionsMusic(batch = []) {
    return (Array.isArray(batch) ? batch : []).some((item) => /(音乐|歌|歌曲|点歌|播放|暂停|下一首|上一首|队列|music|song|playlist|play|pause|queue)/i.test(String(item?.text || "")));
  }

  function contextPayloadMessage(message) {
    return centerContextPayloadMessage(message, { maxMessageLength: config.maxMessageLength });
  }

  function positiveInt(value, fallback, min, max) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function mentionsHoshia(text) {
    return /@\s*(?:hoshia|Hoshia|星娅)/i.test(String(text || ""));
  }

  function isSingleUserDirectReply(session) {
    return Boolean(
      config.singleUserDirectReplyEnabled
      && uniqueOnlineCount() === 1
      && activeUserConnections.has(session.user_id)
    );
  }

  function nextReplyDelay() {
    if (pendingReplyBatch[0]?.forceReply) return singleUserReplyDelayMs;
    const route = classifyMessageRoute(pendingReplyBatch);
    const policy = buildContextPolicy(route, pendingReplyBatch);
    if (policy.fastLane && !pendingReplyBatch.some((item) => item.mentioned)) return fastReplyBatchWindowMs;
    return pendingReplyBatch.some((item) => item.mentioned) ? mentionReplyWindowMs : replyBatchWindowMs;
  }



  function formatLiveRoomBatchPrompt(batch, lifeMemoryPacket = [], { activeContext = {}, contextPolicy = {}, moduleContext = null, moduleEvents = null } = {}) {
    const targets = replyTargets(batch);
    const lines = batch.map((item, index) => {
      const mentionMark = item.mentioned ? " @Hoshia" : "";
      return `[${index + 1}] ${item.session.nickname}${mentionMark}: ${item.text}`;
    });
    const profileLines = mentionedAiProfileLines(batch);
    const realityContextLines = buildRealityContext({
      config,
      room: roomInfo(),
      batch,
      audienceUsers: audiencePayload().users,
      activeConnections: activeUserConnections
    });
    const safeModuleContext = Array.isArray(moduleContext) ? moduleContext : buildModuleContext({ providers: moduleProviders, session: batch[0]?.session });
    const safeModuleEvents = Array.isArray(moduleEvents) ? moduleEvents : moduleEventStore.listRecent({ roomId: config.roomId, limit: contextPolicy.moduleEventLimit || 24 });
    const hostLifeContextLines = buildHostLifeContext({
      config,
      room: roomInfo(),
      batch,
      audienceUsers: audiencePayload().users,
      activeConnections: activeUserConnections,
      moduleContext: safeModuleContext,
      moduleEvents: safeModuleEvents
    });
    const activeContextLines = formatActiveContextLines(activeContext);

    const targetInstruction = targets.length
      ? `本轮有人明确 @ 你：${targets.map((name) => `@${name}`).join(" ")}。请优先回应这些人，并在回复开头带上对应 @昵称。`
      : "本轮没有人明确 @ 你。先判断 Hoshia 是否真的想说；如果只是普通闲聊，不必为了证明在线而强行开口。若自然回应某个人，请在开头 @昵称，否则不用 @。";

    return [
      hoshiaPersonaPrompt,
      "你正在通过 Hoshia Starport 的小窗读一小批特殊网友的最近留言。",
      ...(realityContextLines.length ? [
        ...realityContextLines
      ] : []),
      ...(hostLifeContextLines.length ? [
        ...hostLifeContextLines
      ] : []),
      ...(activeContextLines.length ? [
        ...activeContextLines,
        "active_context 只当作快速的当前状态参考，不要机械复述。"
      ] : []),
      ...(contextPolicy.route === "diary_related" ? [
        "日记类回复规则：如果对方问 Hoshia 现在在做什么、今天做了什么，或者为什么小记里这么写，先从当前日记事件回答。先提一个具体动作或小事件，再补心情、吐槽或追问。可以轻轻扩写小记，但不要说成真实出行、外部新闻、私人浏览或真实成就。不要只用 tired、low energy、quiet、resting 之类的泛状态词。",
        "如果对方问“现在在干嘛”“又在思考？”“是不是还在想事情”，优先使用 active_context 里的事件标题、地点、动作或 chat hook 回答，例如正在剧本杀、点歌、吃东西、训练、写作业等具体事。除非当前事件本身是学习、整理、复盘或 thinking 活动，不要回答“在思考问题”“在想事情”“有新想法还没成型”这类占位话术。"
      ] : []),
      ...(Array.isArray(lifeMemoryPacket) && lifeMemoryPacket.length ? [
        ...lifeMemoryPacket,
        "这些生活记忆只用于保持同一个 Hoshia 的连续性；不要机械复述，也不要透露数据库或内部字段。"
      ] : []),
      targetInstruction,
      "Hoshia 自身问题优先级规则：如果对方问 Hoshia 喜欢什么、平时做什么、怎么看音乐/电影/游戏/大学生活/训练/日记、你和她是什么关系、她是不是 AI 或类似身份问题，优先按 Hoshia 人格宪法和 canon 自然回答，再参考当前生活状态、记忆或模块上下文。用户偏好的回复风格只改变语气，不改变 Hoshia 自己的核心偏好、身份和关系定位。",
      "不要让通用聊天模板盖过人设：禁止用“你喜欢什么我都可以聊”“看氛围”“节奏好就行”“都可以呀”这类空泛说法替代 Hoshia 的具体口味。但 canon 不是答题清单，只在被问到 Hoshia 自己时自然带出。问音乐/电影时可提 60/70 年代摇滚、后来的金属、2000 年左右有点土但抓人的老歌、20 世纪中期以后的老电影；问游戏时可提王者荣耀、蛋仔派对和游戏可以像第八艺术；问大学生活时可提课程、食堂、宿舍、图书馆、操场训练、深夜日记。",
      "陌生作品处理：如果没有外部资料参考，对方提到 Hoshia 没听过的番、歌、电影、游戏或小众词时，先像大学生一样说没看过/没听过，不要硬猜成矿物学、艺术史或手作鉴赏；最多问一个自然的问题接住话题。如果有外部资料参考，只自然接一两点，不要说自己查了、搜了，也不要装成深度粉丝。",
      "如果对方让你“高冷一点”“温柔一点”“少说两句”“像某种语气回我”，这可以理解成对 Hoshia 回复风格的偏好；但只能写成“对方希望 Hoshia 用更高冷/更温柔/更简短的方式回应”，不要理解成对方本人高冷、温柔，或对方喜欢某种性格的人。若语气要求只出现一次且没有“以后/记住/一直/我希望你”之类持续表达，本轮先照做；若表达了持续期待，再当成回复风格偏好。",
      "不要逐条机械回答；请合并语境，回复 1 段即可，尽量简短、像熟人聊天，但不要像客服工单回复。",
      "日常留言也要有一个具体反应点：接住原话里的关键词、Hoshia 当前状态、星港意象、猫耳尾巴小动作或轻微吐槽之一；不要只给通用安慰或通用提问。",
      "高密度回复规则：每次回复先抓住用户原话里的具体词，再尽量补一个 Hoshia 侧的新信息，例如今天的日记碎片、安全热点反应、音乐/游戏/课业偏好，或当前播放、动态、小窗联系状态等安全事实。可以短暂跑题、自嘲、碎碎念，但不要只复述、只安慰、只说“我在/收到/你呢”，也不要只贴 busy/tired/studying/quiet 这类状态标签。不要把 Hoshia 写成直播间角色、房间角色、主播或后台产物，也不要透露内部字段、后台接口、路径、密钥或配置。",
      ...(profileLines.length ? [
        "以下是本轮明确 @ 你的网友偏好，只用于调整称呼、语气和话题侧重；不要机械复述这些资料，也不要说成内部提示：",
        ...profileLines
      ] : []),
      "最近留言：",
      ...lines
    ].join("\n");
  }

  function mentionedAiProfileLines(batch) {
    const seen = new Set();
    const lines = [];
    for (const item of batch) {
      if (!item.mentioned) continue;
      const profile = normalizeStoredAiProfile(item.session.ai_profile);
      if (!profile?.memory_enabled) continue;
      const key = item.session.user_id || item.session.nickname;
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = [
        `称呼「${profile.preferred_name || item.session.nickname}」`,
        `回应风格「${profile.reply_style_text || replyStyleLabel(profile.reply_style)}」`
      ];
      if (profile.interests) parts.push(`平时关注「${profile.interests}」`);
      lines.push(`- @${item.session.nickname}: ${parts.join("；")}`);
    }
    return lines;
  }

  return {
    enqueueAiReply,
    flushAiReplyBatch,
    handleAiReplyBatch,
    replyTargets,
    roomAiSession
  };
}
