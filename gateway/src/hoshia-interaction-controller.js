export function createHoshiaInteractionController(deps) {
  const {
    activeUserConnections,
    appendCharacterEvent,
    appendTimelineCommentReplyCharacterEvent,
    audiencePayload,
    appendVisualStateChangedCharacterEvent,
    broadcast,
    broadcastHoshiaState,
    buildModuleContext,
    buildRealityContext,
    buildHostLifeContext,
    buildWelcomeGreetingPrompt,
    config,
    createHoshiaVisualStateChangedEvent,
    currentCharacterState,
    db,
    fallbackWelcomeGreeting,
    fetchImpl,
    generateAiReply,
    hoshiaCommentReplyService,
    hoshiaDailyCanonService,
    hoshiaInterestSystem,
    hoshiaPersonaPrompt,
    hoshiaVisualStateService,
    newsService,
    isValidState,
    messageEvent,
    moduleEventStore,
    moduleProviders,
    normalizeHoshiaPresentation,
    normalizeStoredAiProfile,
    observabilityCounters = { route_observations: new Map() },
    presentationFromClawEnvelope,
    quickReplyLead,
    recordAiProviderObservation,
    recordCommentReplyShadowMetric,
    recordRouteObservation,
    roomAiSession,
    roomInfo,
    routeStatusFromCounts,
    scheduleProactiveReplyCheck,
    setCharacterState,
    shouldScheduleWelcomeGreeting,
    store,
    storeMessage,
    welcomeCooldownKey,
    welcomeInflightKey
  } = deps;
  let hoshiaCommentReplyTimer = null;

  async function runCommentReplyTick({ limit = config.hoshiaCommentReplyTickLimit, force = false, shadowOnly = config.hoshiaCommentReplyRolloutMode === "shadow" } = {}) {
    const result = await hoshiaCommentReplyService.processDueComments({
      limit,
      force,
      shadowOnly,
      recordMetric: recordCommentReplyShadowMetric
    });
    if (!shadowOnly) {
      recordRouteObservation(observabilityCounters, "comment_reply_live", routeStatusFromCounts({
        success: result?.replied_count,
        skip: result?.skipped_count,
        failed: result?.failed_count
      }));
    }
    if (result.processed_count > 0) {
      appendTimelineCommentReplyCharacterEvent({ status: "replied" });
      const visualUpdate = hoshiaVisualStateService.applyUserInteraction({
        text: "Hoshia replied to timeline comments",
        session: { user_id: "hoshia", nickname: "Hoshia" }
      });
      if (visualUpdate.changed) {
        moduleEventStore.append(createHoshiaVisualStateChangedEvent(visualUpdate.state, null, {
          roomId: config.roomId,
          reason: "timeline comment reply",
          source: "comment_reply"
        }));
        appendVisualStateChangedCharacterEvent(visualUpdate.state, null, {
          reason: "timeline comment reply",
          source: "comment_reply"
        });
        broadcastHoshiaState(visualUpdate.state);
      }
      broadcast({
        type: "hoshia_posts_changed",
        room_id: config.roomId,
        reason: "comment_reply",
        timestamp: new Date().toISOString()
      });
    }
    scheduleCommentReplyTick();
    return result;
  }

  async function generateGameReport({ run, finish, scoreTier, result, session } = {}) {
    if (config.aiMode === "mock") return "";
    const prompt = [
      hoshiaPersonaPrompt,
      "A viewer just finished a private Hoshia pixel survivor mini-game run. Write one short Chinese comment as Hoshia.",
      "Use only this sanitized run summary; do not mention internal APIs, databases, paths, tokens, or server details.",
      `Viewer: ${session?.nickname || "viewer"}`,
      `Class: ${run?.class_id || "unknown"}`,
      `Stage: ${run?.stage_id || "unknown"}`,
      `Locked Hoshia state: activity=${run?.locked_activity || "idle"}, mood=${run?.locked_mood || "calm"}`,
      `Result: ${result || finish?.result || "finished"}, score tier=${scoreTier || "C"}, waves=${finish?.waves_cleared ?? 0}, boss=${finish?.boss_result || "not_reached"}, duration=${finish?.duration_seconds ?? 0}s, kills=${finish?.kills ?? 0}`,
      "Requirements: Chinese only, one sentence, under 70 Chinese characters, warm and playful, no invented hidden details."
    ].join("\n");
    try {
      const reply = await generateAiReply(roomAiSession([{ session }]), prompt, config, globalThis.fetch, {
        roomSession: true,
        forceReply: true,
        replyMode: "pixel_game_report",
        replyTargets: [session?.nickname].filter(Boolean),
        moduleContext: buildModuleContext({ providers: moduleProviders, session }),
        moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 }),
        messages: [{
          user_id: session?.user_id || "",
          nickname: session?.nickname || "viewer",
          text: "pixel game run finished",
          mentioned: true,
          memory_enabled: normalizeStoredAiProfile(session?.ai_profile)?.memory_enabled === true,
          timestamp: new Date().toISOString()
        }]
      });
      if (reply?.skipped || !reply?.text) return "";
      return String(reply.text).slice(0, 160);
    } catch {
      return "";
    }
  }

  async function generatePostCommentReply({
    post,
    comment,
    memoryPacket = [],
    visualState = null,
    moduleContext = [],
    moduleEvents = []
  } = {}) {
    if (!["astrbot", "hoshiaclaw"].includes(config.aiMode)) return "";
    const prompt = formatPostCommentReplyPrompt({ post, comment, memoryPacket, visualState });
    const replyOptions = config.aiMode === "hoshiaclaw"
      ? {
        ...config,
        aiMode: "hoshiaclaw",
        hoshiaClawFallbackToMock: false,
        hoshiaclawFallbackToMock: false,
        hoshiaClawStreamingEnabled: false,
        hoshiaclawStreamingEnabled: false
      }
      : config;
    const reply = await generateAiReply({
      user_id: comment?.user_id || "post-comment-viewer",
      username: comment?.nickname || "viewer",
      nickname: comment?.nickname || "viewer",
      room_id: config.roomId
    }, prompt, replyOptions, globalThis.fetch, {
      forceReply: true,
      replyMode: "post_comment_reply",
      replyTargets: [comment?.nickname].filter(Boolean),
      moduleContext: Array.isArray(moduleContext) ? moduleContext : [],
      moduleEvents: Array.isArray(moduleEvents) ? moduleEvents : [],
      messages: [{
        user_id: comment?.user_id || "",
        nickname: comment?.nickname || "",
        text: comment?.content || "",
        timestamp: comment?.created_at || ""
      }]
    });
    if (reply?.skipped || !reply?.text) return "";
    if (config.aiMode === "hoshiaclaw" && reply.source !== "openai_compatible") return "";
    return {
      content: String(reply.text).slice(0, 500),
      source: reply.source || config.aiMode
    };
  }

  async function generatePostCommentReplyShadow({
    post,
    comment,
    memoryPacket = [],
    visualState = null,
    moduleContext = [],
    moduleEvents = []
  } = {}) {
    const prompt = formatPostCommentReplyShadowPrompt({ post, comment, memoryPacket, visualState });
    return runCommentReplyShadowProvider({
      session: {
        user_id: comment?.user_id || "post-comment-viewer",
        username: comment?.nickname || "viewer",
        nickname: comment?.nickname || "viewer",
        room_id: config.roomId
      },
      prompt,
      moduleContext,
      moduleEvents,
      comment
    });
  }

  async function runCommentReplyShadowProvider({ session, prompt, moduleContext = [], moduleEvents = [], comment = null } = {}) {
    const reply = await generateAiReply(session, prompt, {
      ...config,
      aiMode: "hoshiaclaw",
      hoshiaClawFallbackToMock: false,
      hoshiaclawFallbackToMock: false,
      hoshiaClawStreamingEnabled: false,
      hoshiaclawStreamingEnabled: false
    }, globalThis.fetch, {
      forceReply: true,
      replyMode: "post_comment_reply_shadow",
      replyTargets: [comment?.nickname].filter(Boolean),
      moduleContext: Array.isArray(moduleContext) ? moduleContext : [],
      moduleEvents: Array.isArray(moduleEvents) ? moduleEvents : [],
      messages: [],
      onDelta: null
    });
    if (reply?.skipped) return { skipped: true, source: reply.source || "hoshiaclaw", error: reply.error || reply.route || "skipped", latency_ms: reply.latency_ms };
    if (!reply?.text) return { failed: true, source: reply?.source || "gateway_error", error: reply?.error || "empty_or_error_reply", latency_ms: reply?.latency_ms };
    return {
      content: String(reply.text).slice(0, 500),
      source: reply.source || "hoshiaclaw",
      route: reply.route || "post_comment_reply_shadow",
      latency_ms: reply.latency_ms
    };
  }

  function formatPostCommentReplyShadowPrompt({ post, comment, memoryPacket = [], visualState = null } = {}) {
    const state = visualState || {};
    const safeLine = (value, limit = 220) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
    return [
      "You are Hoshia in a private live-room staging shadow check.",
      "Generate one short candidate reply to a viewer comment on Hoshia's timeline post.",
      "This is shadow mode: do not publish, do not claim actions, and do not include secrets, URLs, paths, tokens, raw logs, or internal notes.",
      "Return only the candidate reply text, or an explicit skip if a reply would be unsafe.",
      "reply_mode: post_comment_reply_shadow",
      `post_activity: ${safeLine(post?.activity, 48) || "chatting"}`,
      `post_mood: ${safeLine(post?.mood, 48) || "calm"}`,
      `post_summary: ${safeLine(post?.content, 360) || "timeline post"}`,
      `viewer: ${safeLine(comment?.nickname, 48) || "viewer"}`,
      `comment_summary: ${safeLine(comment?.content, 360) || "viewer comment"}`,
      `current_state: activity=${safeLine(state.activity, 48) || "idle"}; mood=${safeLine(state.mood, 48) || "calm"}; energy=${Number(state.energy || 0)}; social_need=${Number(state.social_need || 0)}`,
      ...(Array.isArray(memoryPacket) ? memoryPacket.slice(0, 4).map((line) => `memory_summary: ${safeLine(line, 180)}`).filter(Boolean) : [])
    ].filter(Boolean).join("\n");
  }

  function formatPostCommentReplyPrompt({ post, comment, memoryPacket = [], visualState = null } = {}) {
    const state = visualState || {};
    return [
      hoshiaPersonaPrompt,
      "你是 Hoshia，正在给自己的小记下面回一句话。",
      "只写一条短而自然的回复，不要包含标签、JSON、内部备注、文件路径、token、内部网址或日志。",
      "不要像客服。要和小记内容、对方留言、以及 Hoshia 当前心情保持连贯。",
      `Post: ${String(post?.content || "").slice(0, 700)}`,
      `Post state: activity=${String(post?.activity || "")}; mood=${String(post?.mood || "")}`,
      `留言者 ${String(comment?.nickname || "网友").slice(0, 32)} 写道：${String(comment?.content || "").slice(0, 500)}`,
      `Current Hoshia state: activity=${String(state.activity || "")}; mood=${String(state.mood || "")}; energy=${Number(state.energy || 0)}; social_need=${Number(state.social_need || 0)}; visual=${String(state.visual_description || "").slice(0, 220)}`,
      ...(Array.isArray(memoryPacket) && memoryPacket.length ? [
        ...memoryPacket,
        "这些记忆只用于保持连续性，不要透露内部字段名。"
      ] : [])
    ].filter(Boolean).join("\n");
  }

  function scheduleCommentReplyTick(delayMs = 60000) {
    if (hoshiaCommentReplyTimer) clearTimeout(hoshiaCommentReplyTimer);
    if (!config.hoshiaAsyncCommentReplyEnabled || config.hoshiaCommentReplyRolloutMode === "off") return;
    hoshiaCommentReplyTimer = setTimeout(() => {
      hoshiaCommentReplyTimer = null;
      void runCommentReplyTick().catch((error) => {
        console.warn("hoshia_comment_reply_tick_failed", {
          type: error?.name || "Error",
          message: error?.message || String(error)
        });
        scheduleCommentReplyTick(120000);
      });
    }, Math.max(1000, Number(delayMs) || 60000));
    hoshiaCommentReplyTimer.unref?.();
  }


  function positiveInt(value, fallback, min, max) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function scheduleWelcomeGreeting(session) {
    if (!config.welcomeGreetingEnabled || !session?.user_id) return;
    if (session.onboarding_completed === false) return;
    const delay = positiveInt(config.welcomeGreetingDelayMs, 900, 0, 10000);
    setTimeout(() => {
      void handleWelcomeGreeting(session).catch((error) => {
        console.warn("welcome_greeting_failed", {
          type: error.name || "Error",
          message: error.message
        });
      });
    }, delay);
  }

  async function handleWelcomeGreeting(session) {
    if (!config.welcomeGreetingEnabled || !session?.user_id) return;
    if (session.onboarding_completed === false) return;
    if (!activeUserConnections.has(session.user_id)) return;

    const key = welcomeCooldownKey(config.roomId, session.user_id);
    const inflightKey = welcomeInflightKey(config.roomId, session.user_id);
    if (await store.get(key)) return;
    if (await store.get(inflightKey)) return;
    await store.setex(inflightKey, 60, "1");

    try {
      const active = activeUserConnections.get(session.user_id);
      const currentOnlineSeconds = active ? Math.max(0, Math.floor((Date.now() - active.connectedAtMs) / 1000)) : 0;
      const totalOnlineSeconds = Number(session.total_online_seconds || 0) + currentOnlineSeconds;
      const room = roomInfo();
      const realityContextLines = buildRealityContext({
        config,
        room,
        batch: [{
          session,
          text: "\u8fdb\u5165\u76f4\u64ad\u95f4",
          mentioned: true,
          timestamp: new Date().toISOString()
        }],
        audienceUsers: audiencePayload().users,
        activeConnections: activeUserConnections
      });
      const moduleContext = buildModuleContext({ providers: moduleProviders, session });
      const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 });
      const hostLifeContextLines = buildHostLifeContext({
        config,
        room,
        batch: [{
          session,
          text: "进入直播间",
          mentioned: true,
          timestamp: new Date().toISOString()
        }],
        audienceUsers: audiencePayload().users,
        activeConnections: activeUserConnections,
        moduleContext,
        moduleEvents,
        dailyCanonContext: hoshiaDailyCanonService?.buildContext?.(session, { now: new Date(), create: true }),
        newsService,
        interestContext: hoshiaInterestSystem?.buildContext?.(session, { now: new Date() }),
        currentVisualState: currentCharacterState()
      });
      const prompt = buildWelcomeGreetingPrompt({
        session,
        room,
        realityContextLines,
        hostLifeContextLines,
        contextSummary: db.getRoomContextSummary(config.roomId)?.summary_text || "",
        currentOnlineSeconds,
        totalOnlineSeconds
      });

      let reply;
      if (config.aiMode === "astrbot") {
        reply = await generateAiReply(roomAiSession([{ session }]), prompt, config, globalThis.fetch, {
          roomSession: true,
          forceReply: true,
          replyMode: "entry_welcome",
          replyTargets: [session.nickname].filter(Boolean),
          messages: [{
            user_id: session.user_id,
            nickname: session.nickname,
            text: "\u8fdb\u5165\u76f4\u64ad\u95f4",
            mentioned: true,
            memory_enabled: normalizeStoredAiProfile(session.ai_profile)?.memory_enabled === true,
            timestamp: new Date().toISOString()
          }]
        });
      }

      const text = reply?.source && !String(reply.source).startsWith("mock")
        ? reply.text
        : fallbackWelcomeGreeting(session);
      const aiMessage = messageEvent("ai_reply", "ai", text, {
        user_id: "ai-host",
        nickname: "Hoshia"
      }, {
        source: reply?.source || "welcome_fallback",
        latency_ms: reply?.latency_ms,
        welcome: true
      });
      await storeMessage(aiMessage);
      broadcast(aiMessage);
      await store.setex(key, positiveInt(config.welcomeGreetingCooldownSeconds, 1800, 60, 86400), "1");
      await setCharacterState(isValidState(reply?.state) ? reply.state : "SPEAKING");
      setTimeout(() => void setCharacterState("IDLE"), 1200);
    } finally {
      await store.del(inflightKey);
    }
  }



  function clearCommentReplyTimer() {
    if (hoshiaCommentReplyTimer) clearTimeout(hoshiaCommentReplyTimer);
    hoshiaCommentReplyTimer = null;
  }

  return {
    clearCommentReplyTimer,
    generateGameReport,
    generatePostCommentReply,
    generatePostCommentReplyShadow,
    runCommentReplyTick,
    scheduleCommentReplyTick,
    scheduleWelcomeGreeting
  };
}
