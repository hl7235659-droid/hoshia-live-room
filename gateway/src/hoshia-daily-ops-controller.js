export function createHoshiaDailyOpsController({
  appendHoshiaNewsEvent,
  appendTimelinePostCreatedCharacterEvent,
  appendVisualStateChangedCharacterEvent,
  applyNewsSignalFromTopic,
  broadcast,
  broadcastHoshiaState,
  buildActualDiaryLivePrompt,
  buildDailyCanonPlanLivePrompt,
  buildDailyPostShadowPrompt,
  buildModuleContext,
  buildNewsTopicGenerateShadowPrompt,
  config,
  createHoshiaPostCreatedEvent,
  createHoshiaVisualStateChangedEvent,
  dailyPostShadowPreflightSkipReason,
  generateAiReply,
  hoshiaDailyCanonService,
  hoshiaDailyPostService,
  hoshiaInterestSystem,
  hoshiaLifeMemoryService,
  hoshiaNewsService,
  hoshiaVisualStateService,
  hoshiaVisualTickWindow,
  isFreshNewsTopic,
  isSafeNewsTopicForPost,
  moduleEventStore,
  moduleProviders,
  observabilityCounters,
  parseActualDiaryReply,
  parseDailyCanonPlanReply,
  randomHoshiaTickDelayMs,
  recordDailyPostLiveMetric,
  recordRouteObservation,
  recordShadowMetricEvent,
  runDailyPostLive,
  runDailyPostShadow,
  runNewsTopicGenerateShadow,
  runNewsTopicLive,
  safeMetricIdentifier,
  safeMetricReason,
  selectCachedNewsTopicForPost,
  shadowSession,
  stateForNewsTopicPost,
  stateReasonForPostSource,
  statusFromDailyPostTick,
  tickHoshiaVisualState,
  updateHoshiaVisualState
}) {
  let hoshiaVisualTickTimer = null;
  let hoshiaNewsTopicSyncTimer = null;
  async function runScheduledHoshiaVisualTick() {
    hoshiaVisualTickTimer = null;
    try {
      await hoshiaDailyCanonService.ensureTodayPlanLive();
      await hoshiaDailyCanonService.ensureActualDiaryLive();
      const result = tickHoshiaVisualState({
        reason: "scheduled visual state refresh"
      });
      if (result.changed) {
        moduleEventStore.append(createHoshiaVisualStateChangedEvent(result.state, null, {
          roomId: config.roomId,
          reason: result.reason,
          source: "scheduled_tick"
        }));
        appendVisualStateChangedCharacterEvent(result.state, null, {
          reason: result.reason,
          source: "scheduled_tick"
        });
        broadcastHoshiaState(result.state);
      }
      void runDailyPostTick({
        force: false,
        session: null,
        source: "scheduled_visual_tick"
      }).catch((error) => {
        console.warn("hoshia_daily_post_tick_failed", {
          type: safeMetricIdentifier(error?.name || "Error", 48) || "Error",
          message: safeMetricReason(error?.message) || "daily_post_tick_failed"
        });
      });
    } catch (error) {
      console.warn("hoshia_visual_tick_failed", {
        type: safeMetricIdentifier(error?.name || "Error", 48) || "Error",
        message: safeMetricReason(error?.message) || "visual_tick_failed"
      });
    } finally {
      scheduleNextHoshiaVisualTick();
    }
  }

  async function runDailyPostTick({ force = false, ignoreLimit = false, session = null, source = "scheduled", newsTopic = null } = {}) {
    await hoshiaDailyCanonService.ensureTodayPlanLive({ session });
    const diaryEvent = hoshiaDailyCanonService.getActiveEvent({ now: new Date(), create: true });
    const selectedNewsTopic = newsTopic || selectCachedNewsTopicForPost();
    const newsState = selectedNewsTopic
      ? stateForNewsTopicPost(hoshiaVisualStateService.publicState(), selectedNewsTopic)
      : null;
    const shadowChecks = [
      runDailyPostShadowCheck({ force, session, diaryEvent, newsTopic: selectedNewsTopic, state: newsState, source }),
      runNewsTopicGenerateShadowCheck({ session, topic: selectedNewsTopic, state: newsState, source })
    ];
    let result = await runDailyPostLiveTakeover({
      force,
      ignoreLimit,
      session,
      source,
      newsTopic: selectedNewsTopic,
      state: newsState,
      diaryEvent
    });
    if (!result) {
      result = hoshiaDailyPostService.tick({
        force,
        ignoreLimit,
        newsTopic: selectedNewsTopic,
        state: newsState,
        diaryEvent
      });
      if (selectedNewsTopic && ["news_topic_invalid", "news_topic_daily_max_reached"].includes(result.reason)) {
        recordRouteObservation(observabilityCounters, "news_topic_live", statusFromDailyPostTick(result));
        result = hoshiaDailyPostService.tick({ force, ignoreLimit, diaryEvent });
      }
      recordRouteObservation(
        observabilityCounters,
        result?.post?.source_type === "news_topic" || (selectedNewsTopic && !result?.post) ? "news_topic_live" : "daily_post_live",
        statusFromDailyPostTick(result)
      );
    }
    if (result.post && result.created) {
      hoshiaLifeMemoryService.recordPost(result.post);
      hoshiaInterestSystem.recordDailyPost(result.post, {
        session,
        now: result.post.created_at || new Date()
      });
      moduleEventStore.append(result.moduleEvent || createHoshiaPostCreatedEvent(result.post, session, {
        roomId: config.roomId,
        reason: result.post.source_type || "daily_state"
      }));
      appendTimelinePostCreatedCharacterEvent(result.post, session, {
        reason: result.post.source_type || "daily_state"
      });
      if (result.post.source_type === "news_topic") {
        appendHoshiaNewsEvent({
          eventType: "hoshia_news.topic_post_created",
          session,
          summaryHint: "Hoshia created a timeline post from a safe news topic",
          data: {
            source_type: "news_topic",
            post_id: result.post.id,
            reason: "news_topic_post"
          }
        });
        applyNewsSignalFromTopic(selectedNewsTopic, session, "news_topic_post");
      }
      if (result.post.source_type !== "news_topic") {
        await hoshiaDailyCanonService.ensureActualDiaryLive({ session });
        const visualUpdate = updateHoshiaVisualState({
          body: {
            mood: result.post.mood,
            activity: result.post.activity,
            state_reason: stateReasonForPostSource(result.post.source_type)
          },
          session,
          reason: "daily timeline post"
        });
        if (visualUpdate.changed) {
          moduleEventStore.append(createHoshiaVisualStateChangedEvent(visualUpdate.state, session, {
            roomId: config.roomId,
            reason: visualUpdate.reason,
            source: source === "manual" ? "daily_post" : source
          }));
          appendVisualStateChangedCharacterEvent(visualUpdate.state, session, {
            reason: visualUpdate.reason,
            source: source === "manual" ? "daily_post" : source
          });
          broadcastHoshiaState(visualUpdate.state);
        }
      }
      broadcast({
        type: "hoshia_posts_changed",
        room_id: config.roomId,
        reason: result.post.source_type || "daily_post",
        timestamp: new Date().toISOString()
      });
    }
    await Promise.allSettled(shadowChecks);
    return result;
  }

  async function runDailyPostLiveTakeover({ force = false, ignoreLimit = false, session = null, source = "scheduled", newsTopic = null, state = null, diaryEvent = null } = {}) {
    const newsLiveEnabled = Boolean(newsTopic && config.hoshiaClawNewsTopicLiveEnabled);
    const dailyLiveEnabled = Boolean(!newsTopic && config.hoshiaClawDailyPostLiveEnabled);
    if (!newsLiveEnabled && !dailyLiveEnabled) return null;
    const now = new Date();
    const plan = hoshiaDailyPostService.planTickPost({
      force,
      ignoreLimit,
      now,
      newsTopic,
      state,
      diaryEvent
    });
    if (!plan?.postInput) {
      const route = newsLiveEnabled ? "news_topic_live" : "daily_post_live";
      recordRouteObservation(observabilityCounters, route, "skip");
      return {
        ok: plan?.ok !== false,
        created: false,
        skipped: true,
        reason: plan?.reason || "daily_post_live_no_candidate",
        post: null,
        daily_count: plan?.daily_count || 0,
        daily_min: plan?.daily_min || 0,
        daily_max: plan?.daily_max || 0,
        day_key: plan?.day_key || ""
      };
    }
    const liveProvider = {
      generateDailyPostCandidate(payload) {
        return generateDailyPostLiveCandidate({ payload, session, source, route: "daily_post_live" });
      },
      generateNewsTopicCandidate(payload) {
        return generateDailyPostLiveCandidate({ payload, session, source, route: "news_topic_live" });
      }
    };
    const result = newsLiveEnabled
      ? await runNewsTopicLive({
        enabled: true,
        dailyPostService: hoshiaDailyPostService,
        topic: newsTopic,
        provider: liveProvider,
        now,
        state,
        dailyPostPlan: plan,
        roomId: config.roomId,
        recordMetric: recordDailyPostLiveMetric
      })
      : await runDailyPostLive({
        enabled: true,
        service: hoshiaDailyPostService,
        provider: liveProvider,
        now,
        state,
        postInput: plan.postInput,
        dailyPostPlan: plan,
        roomId: config.roomId,
        recordMetric: recordDailyPostLiveMetric
      });
    return {
      ...plan,
      ...result,
      ok: result.status === "success",
      skipped: result.status !== "success",
      reason: result.reason || (result.status === "success" ? "created" : "live_skipped"),
      daily_count: result.status === "success" ? Number(plan.daily_count || 0) + 1 : Number(plan.daily_count || 0),
      daily_min: plan.daily_min,
      daily_max: plan.daily_max,
      day_key: plan.day_key
    };
  }

  async function generateDailyPostLiveCandidate({ payload, session = null, source = "scheduled", route = "daily_post_live" } = {}) {
    const postInput = payload?.postInput || {};
    const topic = payload?.topic || null;
    const state = payload?.state || hoshiaVisualStateService.publicState();
    const prompt = route === "news_topic_live"
      ? buildNewsTopicGenerateShadowPrompt({ topic, state, reason: source })
      : buildDailyPostShadowPrompt({ postInput, state, reason: source });
    if (!prompt) return { skipped: true, source: "gateway", error: "missing_prompt" };
    const reply = await generateAiReply(shadowSession(session), prompt, {
      ...config,
      aiMode: "hoshiaclaw",
      hoshiaClawFallbackToMock: false,
      hoshiaclawFallbackToMock: false,
      hoshiaClawStreamingEnabled: false,
      hoshiaclawStreamingEnabled: false
    }, globalThis.fetch, {
      roomSession: true,
      forceReply: true,
      replyMode: route,
      moduleContext: buildModuleContext({ providers: moduleProviders, session }),
      moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 }),
      messages: [{
        user_id: session?.user_id || "room",
        nickname: session?.nickname || "Live room",
        text: route === "news_topic_live" ? "news topic live candidate" : "daily post live candidate",
        mentioned: true,
        memory_enabled: false,
        timestamp: new Date().toISOString()
      }]
    });
    if (reply?.skipped) return { skipped: true, source: reply.source || "hoshiaclaw", error: reply.error || "skipped" };
    if (!reply?.text || reply.source !== "openai_compatible") {
      return { failed: true, source: reply?.source || "hoshiaclaw", error: "empty_or_error_reply" };
    }
    return {
      text: reply.text,
      source: reply.source,
      latency_ms: reply.latency_ms
    };
  }

  async function generateDailyCanonPlanLive({ now = new Date(), timeZone = "Asia/Shanghai", dayKey = "", fallbackPlan = null, session = null } = {}) {
    const prompt = buildDailyCanonPlanLivePrompt({ now, timeZone, fallbackPlan });
    const reply = await generateAiReply(shadowSession(session), prompt, {
      ...config,
      aiMode: "hoshiaclaw",
      hoshiaClawFallbackToMock: false,
      hoshiaclawFallbackToMock: false,
      hoshiaClawStreamingEnabled: false,
      hoshiaclawStreamingEnabled: false
    }, globalThis.fetch, {
      roomSession: true,
      forceReply: true,
      replyMode: "daily_canon_plan_live",
      moduleContext: buildModuleContext({ providers: moduleProviders, session }),
      moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 }),
      messages: [{
        user_id: session?.user_id || "room",
        nickname: session?.nickname || "Live room",
        text: "daily canon plan live generation",
        mentioned: true,
        memory_enabled: false,
        timestamp: now.toISOString()
      }]
    });
    if (reply?.skipped || !reply?.text || reply.source !== "openai_compatible") {
      recordRouteObservation(observabilityCounters, "daily_canon_plan_live", "skip");
      return null;
    }
    const plan = parseDailyCanonPlanReply(reply, fallbackPlan, dayKey);
    recordRouteObservation(observabilityCounters, "daily_canon_plan_live", plan ? "success" : "failed");
    return plan;
  }

  async function generateActualDiaryLive({ now = new Date(), timeZone = "Asia/Shanghai", plan = null, fallbackDiary = null, session = null } = {}) {
    const prompt = buildActualDiaryLivePrompt({ plan, now, timeZone });
    const reply = await generateAiReply(shadowSession(session), prompt, {
      ...config,
      aiMode: "hoshiaclaw",
      hoshiaClawFallbackToMock: false,
      hoshiaclawFallbackToMock: false,
      hoshiaClawStreamingEnabled: false,
      hoshiaclawStreamingEnabled: false
    }, globalThis.fetch, {
      roomSession: true,
      forceReply: true,
      replyMode: "daily_actual_diary_live",
      moduleContext: buildModuleContext({ providers: moduleProviders, session }),
      moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 }),
      messages: [{
        user_id: session?.user_id || "room",
        nickname: session?.nickname || "Live room",
        text: "daily actual diary live generation",
        mentioned: true,
        memory_enabled: false,
        timestamp: now.toISOString()
      }]
    });
    if (reply?.skipped || !reply?.text || reply.source !== "openai_compatible") {
      recordRouteObservation(observabilityCounters, "daily_actual_diary_live", "skip");
      return null;
    }
    const diary = parseActualDiaryReply(reply, fallbackDiary, plan, now);
    recordRouteObservation(observabilityCounters, "daily_actual_diary_live", diary ? "success" : "failed");
    return diary;
  }

  async function runDailyPostShadowCheck({ force = false, session = null, diaryEvent = null, newsTopic = null, state = null, source = "scheduled" } = {}) {
    const preflightSkipReason = dailyPostShadowPreflightSkipReason({
      shadowEnabled: config.hoshiaClawDailyPostShadowEnabled,
      dailyPostEnabled: config.hoshiaDailyPostEnabled,
      force
    });
    if (preflightSkipReason === "daily_post_shadow_disabled") return null;
    if (preflightSkipReason) {
      return recordShadowMetricEvent({
        eventType: "hoshiaclaw.daily_post_shadow.skip",
        status: "skip",
        reason: preflightSkipReason,
        source: "gateway",
        route: "daily_post_shadow"
      });
    }
    let plan = null;
    let shadowMetadata = null;
    try {
      plan = hoshiaDailyPostService.planDailyPost({
        now: new Date(),
        state: state || hoshiaVisualStateService.publicState(),
        sourceType: newsTopic ? "news_topic" : "daily_state",
        topic: newsTopic,
        diaryEvent
      });
      shadowMetadata = {
        moduleContext: buildModuleContext({ providers: moduleProviders, session }),
        moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 })
      };
    } catch {
      return recordShadowMetricEvent({
        eventType: "hoshiaclaw.daily_post_shadow.skip",
        status: "skip",
        reason: "daily_post_shadow_no_candidate",
        source: "gateway",
        route: "daily_post_shadow"
      });
    }
    if (!plan?.postInput) {
      return recordShadowMetricEvent({
        eventType: "hoshiaclaw.daily_post_shadow.skip",
        status: "skip",
        reason: plan?.reason || "daily_post_shadow_no_candidate",
        source: "gateway",
        route: "daily_post_shadow"
      });
    }
    try {
      return await runDailyPostShadow({
        enabled: true,
        session: shadowSession(session),
        postInput: plan.postInput,
        state: state || hoshiaVisualStateService.publicState(),
        reason: source,
        dailyPostEnabled: Boolean(force || config.hoshiaDailyPostEnabled),
        config,
        generateAiReply,
        fetchImpl: globalThis.fetch,
        metadata: shadowMetadata,
        recordMetric: (metric) => recordShadowMetricEvent({ ...metric, route: "daily_post_shadow" }),
        logger: console
      });
    } catch (error) {
      return recordShadowMetricEvent({
        eventType: "hoshiaclaw.daily_post_shadow.failed",
        status: "failed",
        reason: safeMetricReason(error?.message) || "shadow_failed",
        source: "gateway",
        route: "daily_post_shadow"
      });
    }
  }

  async function runNewsTopicGenerateShadowCheck({ session = null, topic = null, state = null, source = "scheduled" } = {}) {
    if (!config.hoshiaClawNewsTopicGenerateShadowEnabled) return null;
    const safeTopic = topic || hoshiaNewsService.featuredTopic?.() || null;
    if (!safeTopic) {
      return recordShadowMetricEvent({
        eventType: "hoshiaclaw.news_topic_generate_shadow.skip",
        status: "skip",
        reason: "news_topic_shadow_no_topic",
        source: "gateway",
        route: "news_topic_generate_shadow"
      });
    }
    try {
      return runNewsTopicGenerateShadow({
        enabled: true,
        session: shadowSession(session),
        topic: safeTopic,
        state: state || hoshiaVisualStateService.publicState(),
        reason: source,
        config,
        generateAiReply,
        fetchImpl: globalThis.fetch,
        metadata: {
          moduleContext: buildModuleContext({ providers: moduleProviders, session }),
          moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 12 })
        },
        recordMetric: (metric) => recordShadowMetricEvent({ ...metric, route: "news_topic_generate_shadow" }),
        logger: console
      });
    } catch (error) {
      return recordShadowMetricEvent({
        eventType: "hoshiaclaw.news_topic_generate_shadow.failed",
        status: "failed",
        reason: safeMetricReason(error?.message) || "shadow_failed",
        source: "gateway",
        route: "news_topic_generate_shadow"
      });
    }
  }
  function getHoshiaOpsSummary(now = new Date()) {
    return buildHoshiaOpsSummary({
      db,
      visualState: hoshiaVisualStateService.publicState(),
      newsStatus: hoshiaNewsService.getStatus(),
      config,
      now,
      timeZone: config.realityContextTimezone || "Asia/Shanghai"
    });
  }

  function scheduleHoshiaNewsTopicSync(delayMs = 15 * 60 * 1000) {
    if (hoshiaNewsTopicSyncTimer) clearTimeout(hoshiaNewsTopicSyncTimer);
    if (!config.hoshiaNewsEnabled) return;
    hoshiaNewsTopicSyncTimer = setTimeout(() => {
      void syncHoshiaNewsTopics().finally(() => scheduleHoshiaNewsTopicSync());
    }, Math.max(5000, Number(delayMs) || 15 * 60 * 1000));
    hoshiaNewsTopicSyncTimer.unref?.();
  }

  async function syncHoshiaNewsTopics() {
    if (!config.hoshiaNewsEnabled) return;
    try {
      const result = await hoshiaNewsService.topics({ limit: 8, query: "daily news topics" });
      if (!result.ok) {
        console.warn("hoshia_news_topic_sync_skipped", {
          reason: safeMetricReason(result.reason || "news_topics_unavailable")
        });
      }
    } catch (error) {
      console.warn("hoshia_news_topic_sync_failed", {
        type: safeMetricIdentifier(error?.name || "Error", 48) || "Error",
        message: safeMetricReason(error?.message) || "news_topic_sync_failed"
      });
    }
  }

  function scheduleNextHoshiaVisualTick() {
    if (hoshiaVisualTickTimer) clearTimeout(hoshiaVisualTickTimer);
    hoshiaVisualTickTimer = setTimeout(
      runScheduledHoshiaVisualTick,
      randomHoshiaTickDelayMs(hoshiaVisualTickWindow)
    );
    hoshiaVisualTickTimer.unref?.();
  }

  function clearDailyOpsTimers() {
    if (hoshiaVisualTickTimer) clearTimeout(hoshiaVisualTickTimer);
    if (hoshiaNewsTopicSyncTimer) clearTimeout(hoshiaNewsTopicSyncTimer);
    hoshiaVisualTickTimer = null;
    hoshiaNewsTopicSyncTimer = null;
  }

  return {
    clearDailyOpsTimers,
    generateActualDiaryLive,
    generateDailyCanonPlanLive,
    generateDailyPostLiveCandidate,
    runDailyPostShadowCheck,
    runDailyPostTick,
    runNewsTopicGenerateShadowCheck,
    runScheduledHoshiaVisualTick,
    scheduleHoshiaNewsTopicSync,
    scheduleNextHoshiaVisualTick,
    syncHoshiaNewsTopics
  };
}
