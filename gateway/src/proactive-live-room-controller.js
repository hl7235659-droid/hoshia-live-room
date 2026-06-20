export function createProactiveLiveRoomController(deps) {
  const {
    activeUserConnections,
    appendCharacterEvent,
    broadcast,
    broadcastAiReplyDone,
    buildCurrentCharacterSnapshot,
    buildHostLifeContext,
    buildModuleContext,
    buildProactiveLiveMetadata,
    buildProactiveLivePrompt,
    config,
    db,
    fetchImpl,
    generateAiReply,
    hoshiaPersonaPrompt,
    isValidState,
    markUserActivityForProactive,
    messageEvent,
    moduleEventStore,
    moduleProviders,
    nextCharacterState,
    nextProactiveDelayMs,
    normalizeHoshiaPresentation,
    presentationFromClawEnvelope,
    proactiveReplyState,
    recordAiProviderObservation,
    recordEventLogSnapshotFallback,
    recordProactiveLiveMetric,
    recordProactiveShadowMetric,
    rememberProactiveReply,
    roomAiSession,
    runHoshiaClawProactiveLive,
    runHoshiaClawProactiveShadow,
    safeMetricReason,
    setCharacterState,
    shouldRunHoshiaClawProactiveLive,
    shouldRunProactiveReply,
    sleep,
    sockets,
    storeMessage,
    summarizeCharacterSnapshotForPrompt,
    summarizeLiveRoomContext,
    webSocketOpen
  } = deps;

  function scheduleProactiveReplyCheck(delayMs = null) {
    if (proactiveReplyState.timer) {
      clearTimeout(proactiveReplyState.timer);
      proactiveReplyState.timer = null;
    }
    if (!config.proactiveReply.enabled) return;
    if (!uniqueOnlineCount()) {
      proactiveReplyState.nextDueAtMs = 0;
      proactiveReplyState.nextDelayMs = 0;
      return;
    }
    if (proactiveReplyState.unansweredCount >= config.proactiveReply.maxUnanswered) {
      proactiveReplyState.nextDueAtMs = 0;
      proactiveReplyState.nextDelayMs = 0;
      return;
    }

    const delay = delayMs ?? nextProactiveDelayMs(config.proactiveReply);
    proactiveReplyState.nextDelayMs = delay;
    proactiveReplyState.nextDueAtMs = Date.now() + delay;
    proactiveReplyState.timer = setTimeout(() => {
      proactiveReplyState.timer = null;
      void handleProactiveReplyCheck();
    }, delay);
  }

  async function handleProactiveReplyCheck() {
    const decision = shouldRunProactiveReply({
      settings: config.proactiveReply,
      state: proactiveReplyState,
      onlineCount: uniqueOnlineCount(),
      pendingReplyCount: pendingReplyBatch.length,
      replyBatchRunning
    });

    if (!decision.ok) {
      if (["reply_batch_running", "pending_user_messages", "already_generating"].includes(decision.reason)) {
        scheduleProactiveReplyCheck(15000);
      } else if (decision.reason === "not_due") {
        scheduleProactiveReplyCheck(Math.max(1000, proactiveReplyState.nextDueAtMs - Date.now()));
      }
      return;
    }

    const liveDecision = shouldRunHoshiaClawProactiveLive({ config, session: firstActiveSession() });
    if (!liveDecision.ok) await runProactiveReplyShadow(decision.idleMs || 0);
    await sendProactiveIdleReply(decision.idleMs || 0, liveDecision);
  }

  async function runProactiveReplyShadow(idleMs) {
    if (!config.hoshiaClawProactiveShadowEnabled) return;
    const session = firstActiveSession();
    if (!session) return;

    try {
      const context = await buildProactiveReplyContext({ session, idleMs });
      await runHoshiaClawProactiveShadow({
        enabled: true,
        session,
        prompt: context.prompt,
        roomSession: roomAiSession([{ session }]),
        config,
        generateAiReply,
        fetchImpl: globalThis.fetch,
        metadata: {
          roomSession: true,
          forceReply: true,
          replyMode: "proactive_idle_shadow",
          recentContext: context.shortTermContext.recentContext,
          contextSummary: context.shortTermContext.contextSummary,
          characterSnapshotContext: context.characterSnapshotContext,
          moduleContext: context.moduleContext,
          moduleEvents: context.moduleEvents,
          messages: context.recentMessages
        },
        recordMetric: recordProactiveShadowMetric,
        logger: console
      });
    } catch (error) {
      recordProactiveShadowMetric({
        eventType: "hoshiaclaw.proactive_shadow.failed",
        status: "failed",
        reason: error?.message || "shadow_context_failed",
        source: "gateway"
      });
      console.warn("hoshiaclaw_proactive_shadow_context_failed", {
        type: error?.name || "Error",
        message: error?.message || String(error)
      });
    }
  }

  async function sendProactiveIdleReply(idleMs, liveDecision = null) {
    liveDecision = liveDecision || shouldRunHoshiaClawProactiveLive({ config, session: firstActiveSession() });
    if (liveDecision.ok) {
      await sendHoshiaClawProactiveLiveReply(idleMs, liveDecision);
      return;
    }

    if (config.aiMode !== "astrbot") {
      scheduleProactiveReplyCheck();
      return;
    }

    const session = firstActiveSession();
    if (!session) {
      scheduleProactiveReplyCheck();
      return;
    }

    const startedAfterUserMessageAt = proactiveReplyState.lastUserMessageAtMs;
    proactiveReplyState.generating = true;
    try {
      await setCharacterState("THINKING");
      const {
        shortTermContext,
        moduleContext,
        moduleEvents,
        recentMessages,
        prompt
      } = await buildProactiveReplyContext({ session, idleMs });

      const reply = await generateAiReply(roomAiSession([{ session }]), prompt, config, globalThis.fetch, {
        roomSession: true,
        forceReply: true,
        replyMode: "proactive_idle",
        recentContext: shortTermContext.recentContext,
        contextSummary: shortTermContext.contextSummary,
        moduleContext,
        moduleEvents,
        messages: recentMessages
      });

      if (proactiveReplyState.lastUserMessageAtMs !== startedAfterUserMessageAt) {
        await setCharacterState("IDLE");
        return;
      }
      if (reply?.skipped || !reply?.text || reply.source !== "astrbot") {
        await setCharacterState("IDLE");
        return;
      }

      const aiMessage = messageEvent("ai_reply", "ai", String(reply.text).slice(0, 220), {
        user_id: "ai-host",
        nickname: "Hoshia"
      }, {
        source: reply.source,
        latency_ms: reply.latency_ms,
        proactive_idle: true
      });
      await storeMessage(aiMessage);
      broadcast(aiMessage);
      rememberProactiveReply(proactiveReplyState, aiMessage.text);
      await setCharacterState(isValidState(reply.state) ? reply.state : "SPEAKING");
      setTimeout(() => void setCharacterState("IDLE"), 1400);
    } catch (error) {
      console.warn("proactive_reply_failed", {
        type: error.name || "Error",
        message: error.message
      });
      await setCharacterState("IDLE");
    } finally {
      proactiveReplyState.generating = false;
      scheduleProactiveReplyCheck();
    }
  }

  async function sendHoshiaClawProactiveLiveReply(idleMs, liveDecision = {}) {
    const session = firstActiveSession();
    if (!session) {
      scheduleProactiveReplyCheck();
      return;
    }

    const startedAfterUserMessageAt = proactiveReplyState.lastUserMessageAtMs;
    proactiveReplyState.generating = true;
    try {
      await setCharacterState("THINKING");
      const {
        shortTermContext,
        moduleContext,
        moduleEvents,
        recentMessages,
        characterSnapshotContext
      } = await buildProactiveReplyContext({ session, idleMs });

      const latencyTraceId = nanoid(10);
      const prompt = buildProactiveLivePrompt({
        idleMs,
        onlineCount: roomInfo().online,
        unansweredCount: proactiveReplyState.unansweredCount,
        topicHooks: proactiveTopicHooks({ moduleContext, moduleEvents, recentMessages }),
        recentMessages,
        characterSnapshotContext
      });
      const liveMetadata = buildProactiveLiveMetadata({
        latencyTraceId,
        characterSnapshotContext
      });
      const reply = await runHoshiaClawProactiveLive({
        enabled: true,
        session,
        prompt,
        roomSession: roomAiSession([{ session }]),
        config,
        generateAiReply,
        fetchImpl: globalThis.fetch,
        metadata: {
          ...liveMetadata,
          proactiveContextReady: Boolean(shortTermContext)
        },
        logger: console
      });

      if (proactiveReplyState.lastUserMessageAtMs !== startedAfterUserMessageAt) {
        recordProactiveLiveMetric({
          eventType: "hoshiaclaw.proactive_live.skip",
          status: "skip",
          reason: "user_activity_changed",
          source: "gateway"
        });
        await setCharacterState("IDLE");
        return;
      }

      recordProactiveLiveMetric(reply);
      if (reply?.status !== "success" || !reply.text || reply.source !== "openai_compatible") {
        await setCharacterState("IDLE");
        return;
      }

      const route = reply.route || "proactive_idle_live";
      const aiMessage = messageEvent("ai_reply", "ai", reply.text, {
        user_id: "ai-host",
        nickname: "Hoshia"
      }, {
        source: reply.source,
        latency_ms: reply.latencyMs,
        proactive_idle: true,
        route,
        rollout_bucket: liveDecision.bucket ?? null
      });
      await storeMessage(aiMessage);
      appendCharacterEvent({
        event_type: "ai.reply_sent",
        actor_type: "ai",
        source_kind: "ai_reply",
        source_id: aiMessage.id,
        public_hint: "Hoshia sent a proactive live room reply",
        private_hint: "Hoshia sent a proactive live room reply",
        reason: route,
        data: {
          route,
          source_type: reply.source || "unknown",
          status: "sent"
        }
      });
      broadcast(aiMessage);
      broadcastHoshiaPresentation(presentationFromClawEnvelope(reply, {
        traceId: latencyTraceId,
        state: isValidState(reply.state) ? reply.state : "SPEAKING",
        reason: route
      }));
      broadcastAiReplyDone({ traceId: latencyTraceId, route });
      rememberProactiveReply(proactiveReplyState, aiMessage.text);
      await setCharacterState(isValidState(reply.state) ? reply.state : "SPEAKING");
      setTimeout(() => void setCharacterState("IDLE"), 1400);
    } catch (error) {
      recordProactiveLiveMetric({
        eventType: "hoshiaclaw.proactive_live.failed",
        status: "failed",
        reason: error?.message || "proactive_live_failed",
        source: "gateway"
      });
      console.warn("hoshiaclaw_proactive_live_failed", {
        type: error.name || "Error",
        message: error.message
      });
      await setCharacterState("IDLE");
    } finally {
      proactiveReplyState.generating = false;
      scheduleProactiveReplyCheck();
    }
  }

  async function buildProactiveReplyContext({ session, idleMs } = {}) {
    const shortTermContext = await buildProactiveShortTermContext();
    const moduleContext = buildModuleContext({ providers: moduleProviders, session });
    const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 });
    const recentMessages = db
      .listRecentContextMessages(config.roomId, config.proactiveReply.contextMessages)
      .map(contextPayloadMessage);
    const characterSnapshot = config.characterStateAuthority === "event_log"
      ? buildEventLogCharacterSnapshot({ roomId: config.roomId, characterId: "hoshia" }) || recordEventLogSnapshotFallback(buildCurrentCharacterSnapshot(session))
      : buildCurrentCharacterSnapshot(session);
    const prompt = formatProactiveIdlePrompt({
      session,
      idleMs,
      recentMessages,
      moduleContext,
      moduleEvents
    });
    return {
      shortTermContext,
      moduleContext,
      moduleEvents,
      recentMessages,
      characterSnapshotContext: summarizeCharacterSnapshotForPrompt(characterSnapshot),
      prompt
    };
  }

  async function buildProactiveShortTermContext() {
    return buildShortTermAiContext({
      batch: [],
      contextPolicy: {
        includeContextSummary: true,
        refreshSummarySync: true,
        recentContextLimit: config.proactiveReply.contextMessages
      },
      roomId: config.roomId,
      db,
      config,
      summarizeLiveRoomContext,
      fetchImpl: globalThis.fetch,
      logger: console
    });
  }

  function formatProactiveIdlePrompt({ session, idleMs, recentMessages, moduleContext, moduleEvents }) {
    const idleMinutes = Math.max(1, Math.round(Number(idleMs || 0) / 60000));
    const room = roomInfo();
    const realityContextLines = buildRealityContext({
      config,
      room,
      batch: [{
        session,
        text: "联系窗口安静了一会儿",
        mentioned: false,
        timestamp: new Date().toISOString()
      }],
      audienceUsers: audiencePayload().users,
      activeConnections: activeUserConnections
    });
    const hostLifeContextLines = buildHostLifeContext({
      config,
      room,
      batch: [{
        session,
        text: "联系窗口安静了一会儿",
        mentioned: false,
        timestamp: new Date().toISOString()
      }],
      audienceUsers: audiencePayload().users,
      activeConnections: activeUserConnections,
      moduleContext,
      moduleEvents
    });
    const recentLines = recentMessages.slice(-config.proactiveReply.contextMessages).map((item, index) => {
      const speaker = item.role === "ai" ? "Hoshia" : (item.nickname || "网友");
      return `[${index + 1}] ${speaker}: ${item.text}`;
    });
    const previousLines = proactiveReplyState.recentTexts.map((text, index) => `${index + 1}. ${text}`);
    const topicHooks = proactiveTopicHooks({ moduleContext, moduleEvents, recentMessages });
    const safeLine = (value, limit = 180) => cleanProactiveText(value, limit);

    return [
      hoshiaPersonaPrompt,
      "Hoshia is preparing one proactive line because at least one special online friend is reachable and their contact window has been quiet for a while.",
      `Idle time: about ${idleMinutes} minutes.`,
      `Reachable special friends: ${Number(room.online || 0)}.`,
      `Unanswered proactive count: ${Number(proactiveReplyState.unansweredCount || 0)}.`,
      "Use only the safe public context below. Do not mention system detection, internal routing, logs, secrets, tokens, URLs, file paths, or private configuration.",
      ...(realityContextLines.length ? ["Reality context:", ...realityContextLines.map((line) => safeLine(line, 220))] : []),
      ...(hostLifeContextLines.length ? ["Host life context:", ...hostLifeContextLines.map((line) => safeLine(line, 220))] : []),
      ...(previousLines.length ? [
        "Previous proactive lines. Do not repeat their topic or structure:",
        ...previousLines.map((line) => safeLine(line, 180))
      ] : []),
      ...(recentLines.length ? [
        "Recent room messages:",
        ...recentLines.map((line) => safeLine(line, 180))
      ] : ["Recent room messages: none."]),
      ...(topicHooks.length ? [
        "Available concrete topic hooks, ordered by priority:",
        ...topicHooks.map((hook, index) => `${index + 1}. ${safeLine(hook, 180)}`)
      ] : [
        "Available concrete topic hooks: none. If there is no concrete diary, chat, music, time-of-day, or safe module hook, choose skip instead of filling silence."
      ]),
      "Task:",
      "- Write one natural proactive opening line in Chinese.",
      "- Prefer a concrete diary, safe news, or module hook; otherwise use recent chat, music, or current time context.",
      "- Add one Hoshia-side detail: a tiny diary object, a personal reaction to a safe topic, a game/music/course preference, or a safe current state such as music, timeline, or a small game.",
      "- Include a clear conversational handle that a viewer can respond to.",
      "- Keep Hoshia's tone: light, familiar, slightly playful, and tied to her current state.",
      "- Do not use status labels like busy, tired, studying, or quiet as the whole content. Turn the label into a concrete object or action.",
      "- Do not only say the contact window is quiet, do not scold the other person, and do not ask a generic customer-service question.",
      "- Output only Hoshia's spoken line, 1 to 2 short sentences, at most 90 Chinese characters."
    ].join("\n");

    return [
      hoshiaPersonaPrompt,
      "Hoshia 正准备主动说一句，因为那个总能联系上的特殊网友在线，而联系窗口已经安静了一会儿。",
      `安静时长大约 ${idleMinutes} 分钟。`,
      `在线人数：${room.online}。`,
      `连续没有得到回应的主动发言次数：${proactiveReplyState.unansweredCount}。`,
      ...(realityContextLines.length ? realityContextLines : []),
      ...(hostLifeContextLines.length ? hostLifeContextLines : []),
      ...(previousLines.length ? [
        "Hoshia 之前的主动发言：不要重复它们的话题或结构：",
        ...previousLines
      ] : []),
      ...(recentLines.length ? [
        "最近的小房间消息：",
        ...recentLines
      ] : ["最近的联系窗口消息：无"]),
      ...(topicHooks.length ? [
        "可用的主动话题钩子，按优先级排序：",
        ...topicHooks.map((hook, index) => `${index + 1}. ${hook}`)
      ] : [
        "可用的主动话题钩子：无。如果没有具体的日记、消息、音乐或近期聊天钩子，就不要用空泛的安静感句子填满联系窗口。"
      ]),
      "任务：",
      "- 写一句自然的主动开口。",
      "- 优先用日记钩子；如果没有合适日记，再看消息、音乐或当前时段。",
      "- 一定要带一个清楚、容易接话的具体点，比如训练后的小感受、复盘一个决定、循环的一首歌、学习里的一个细节，或者某个兴趣话题。",
      "- Hoshia 可以把日常事件轻轻扩成自己的小记，但不要说成外出旅行、外部新闻、私人浏览或真实成就。",
      "- 带一点 Hoshia 的味道：星港画面、猫耳尾巴动作、轻微吐槽，或者对当前状态的反应。",
      "- 可以轻轻问对方在做什么，但不能只问这个；一定要挂一个具体话题钩子。",
      "- 不要只说联系窗口很安静，不要只说自己在这里，不要没有具体事件点就开口。",
      "- 如果用到消息，就把它说成熟人之间的自然问句。不要像播报，也不要碰重话题。",
      "- 不要说自己检测到了安静，不要训人，不要用客服口吻提问。",
      "- 用中文回复，1 到 2 句，最多 90 个汉字。只输出 Hoshia 的话。"
    ].join("\n");
  }

  function proactiveTopicHooks({ moduleContext = [], moduleEvents = [], recentMessages = [] } = {}) {
    const hooks = [];
    const modules = Array.isArray(moduleContext) ? moduleContext : [];
    const events = Array.isArray(moduleEvents) ? moduleEvents : [];
    const life = modules.find((item) => item?.module_id === "hoshia_life_system" && item.enabled);
    if (life) {
      const lifeLines = cleanProactiveHookLines(life.current_state)
        .filter((line) => /Current event|Recent event|Focus hooks|Diary summary|Concrete diary talk hook/i.test(line));
      for (const line of lifeLines.slice(0, 4)) hooks.push(`Daily diary: ${line}`);
    }

    const news = modules.find((item) => item?.module_id === "hoshia_news" && item.enabled);
    if (news) {
      const newsLines = cleanProactiveHookLines(news.current_state)
        .filter((line) => /Recent topic|Safe news summary|Recent news signal|Concrete news talk hook/i.test(line));
      for (const line of newsLines.slice(0, 2)) hooks.push(`Safe news: ${line}`);
    }

    const music = modules.find((item) => item?.module_id === "music" && item.enabled);
    if (music) {
      for (const line of cleanProactiveHookLines(music.current_state).slice(0, 2)) hooks.push(`Music: ${line}`);
    }

    for (const event of events.slice(0, 4)) {
      const hint = cleanProactiveText(event?.summary_hint, 160);
      if (hint) hooks.push(`Recent module event: ${hint}`);
    }

    for (const message of (Array.isArray(recentMessages) ? recentMessages : []).slice(-3)) {
      if (message?.role === "ai") continue;
      const text = cleanProactiveText(message?.text, 120);
      if (text) hooks.push(`Recent chat: ${text}`);
    }

    return uniqueProactiveHooks(hooks).slice(0, 8);
  }

  function cleanProactiveHookLines(value) {
    return (Array.isArray(value) ? value : [])
      .map((line) => cleanProactiveText(line, 180))
      .filter(Boolean);
  }

  function cleanProactiveText(value, maxLength = 180) {
    return String(value ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function uniqueProactiveHooks(hooks = []) {
    const seen = new Set();
    return hooks.filter((hook) => {
      const key = hook.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function firstActiveSession() {
    for (const [ws, session] of sockets.entries()) {
      if (ws.readyState === WEB_SOCKET_OPEN && activeUserConnections.has(session.user_id)) return session;
    }
    return null;
  }

  return {
    scheduleProactiveReplyCheck,
    handleProactiveReplyCheck
  };
}
