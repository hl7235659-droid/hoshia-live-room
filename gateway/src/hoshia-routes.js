import { commentReplyRolloutForInteraction } from "./hoshia-comment-reply.js";
import {
  likeInteractionInput,
  normalizeCommentInput,
  normalizePostInput,
  publicPost
} from "./hoshia-life-memory.js";

export function registerHoshiaRoutes(app, {
  config,
  db,
  requireSession,
  hoshiaVisualStateService,
  buildCurrentCharacterSnapshot,
  getHoshiaOpsSummary,
  safeRevision,
  safeRuntimeModes,
  buildRuntimeObservability,
  hoshiaNewsService,
  applyNewsSignalFromTopic,
  appendHoshiaNewsEvent,
  hoshiaLifeMemoryService,
  moduleEventStore,
  createHoshiaPostCreatedEvent,
  createHoshiaCommentReplyEvent,
  createHoshiaVisualStateChangedEvent,
  updateHoshiaVisualState,
  tickHoshiaVisualState,
  appendTimelinePostCreatedCharacterEvent,
  appendTimelineCommentReplyCharacterEvent,
  appendVisualStateChangedCharacterEvent,
  broadcastHoshiaState,
  publicPostForViewer,
  hoshiaCommentReplyService,
  scheduleCommentReplyTick,
  runCommentReplyTick,
  runDailyPostTick,
  scheduleNextHoshiaVisualTick
}) {
  app.get("/api/hoshia/state", requireSession, async (_req, res) => {
    res.json({
      ok: true,
      state: hoshiaVisualStateService.publicState()
    });
  });

  app.get("/api/hoshia/snapshot", requireSession, async (req, res) => {
    const snapshot = buildCurrentCharacterSnapshot(req.session);
    db.upsertCharacterSnapshot({
      roomId: config.roomId,
      characterId: "hoshia",
      snapshot
    });
    res.json({
      ok: true,
      snapshot
    });
  });

  app.get("/api/hoshia/ops/summary", requireSession, async (_req, res) => {
    res.json({
      ok: true,
      summary: {
        ...getHoshiaOpsSummary(),
        runtime: {
          revision: safeRevision(),
          modes: safeRuntimeModes(),
          observability: buildRuntimeObservability()
        }
      }
    });
  });

  app.post("/api/hoshia/news/refresh", requireSession, async (req, res) => {
    const result = await hoshiaNewsService.refresh({
      force: req.body?.force === true,
      reason: req.body?.reason || "manual"
    });
    const topics = Array.isArray(result.topics) ? result.topics : hoshiaNewsService.getTopics();
    const signalResult = result.ok ? applyNewsSignalFromTopic(topics[0], req.session, "news_refresh") : null;
    appendHoshiaNewsEvent({
      eventType: "hoshia_news.refresh_requested",
      session: req.session,
      summaryHint: result.ok
        ? `Hoshia news refresh completed with ${Number(result.status?.topic_count || topics.length || 0)} safe topics`
        : `Hoshia news refresh skipped: ${result.reason || "unavailable"}`,
      data: {
        status: result.ok ? "ok" : "skipped",
        reason: result.reason || result.status?.stage || "refresh"
      }
    });
    res.json({
      ok: Boolean(result.ok),
      enabled: Boolean(result.enabled),
      reason: result.reason || "",
      status: result.status || hoshiaNewsService.getStatus().status || hoshiaNewsService.getStatus(),
      topics: topics.slice(0, 5),
      signal: signalResult?.accepted ? signalResult.signal : null,
      summary: getHoshiaOpsSummary().news
    });
  });

  app.get("/api/hoshia/news/status", requireSession, async (_req, res) => {
    const result = await hoshiaNewsService.status();
    res.json({
      ok: Boolean(result.ok),
      enabled: Boolean(result.enabled),
      reason: result.reason || "",
      status: result.status || hoshiaNewsService.getStatus().status || hoshiaNewsService.getStatus(),
      summary: getHoshiaOpsSummary().news
    });
  });

  app.get("/api/hoshia/news/topics", requireSession, async (req, res) => {
    const result = await hoshiaNewsService.topics({
      limit: req.query?.limit,
      query: req.query?.query
    });
    res.json({
      ok: Boolean(result.ok),
      enabled: Boolean(result.enabled),
      reason: result.reason || "",
      topics: Array.isArray(result.topics) ? result.topics : []
    });
  });

  app.get("/api/hoshia/posts", requireSession, async (req, res) => {
    res.json({
      ok: true,
      posts: db.listHoshiaPosts({
        characterId: "hoshia",
        limit: req.query?.limit,
        viewerUserId: req.session.user_id
      }).map(publicPost)
    });
  });

  app.post("/api/hoshia/posts", requireSession, async (req, res) => {
    const now = new Date();
    const input = normalizePostInput(req.body, now);
    if (!input) return res.status(400).json({ error: "post_invalid" });
    const post = db.createHoshiaPost(input);
    hoshiaLifeMemoryService.recordPost(post);
    moduleEventStore.append(createHoshiaPostCreatedEvent(post, req.session, {
      roomId: config.roomId,
      reason: post.source_type || "manual"
    }));
    appendTimelinePostCreatedCharacterEvent(post, req.session, { reason: post.source_type || "manual" });
    const result = updateHoshiaVisualState({
      body: {
        mood: post.mood,
        activity: post.activity,
        state_reason: `Hoshia posted a ${post.activity || "daily"} update`
      },
      session: req.session,
      reason: "Hoshia posted an update"
    });
    if (result.changed) {
      moduleEventStore.append(createHoshiaVisualStateChangedEvent(result.state, req.session, {
        roomId: config.roomId,
        reason: result.reason,
        source: "manual_post"
      }));
      appendVisualStateChangedCharacterEvent(result.state, req.session, {
        reason: result.reason,
        source: "manual_post"
      });
      broadcastHoshiaState(result.state);
    }
    res.status(201).json({
      ok: true,
      post: publicPost({
        ...post,
        like_count: 0,
        comment_count: 0,
        liked_by_viewer: false,
        interactions: []
      })
    });
  });

  app.post("/api/hoshia/posts/:id/like", requireSession, async (req, res) => {
    const post = db.getHoshiaPost(req.params.id);
    if (!post) return res.status(404).json({ error: "post_not_found" });
    const alreadyLiked = db.listHoshiaPostInteractions(post.id)
      .some((item) => item.type === "like" && item.user_id === req.session.user_id);
    const interaction = db.addHoshiaPostInteraction({
      ...likeInteractionInput({
        postId: post.id,
        session: req.session,
        now: new Date()
      }),
      post_id: post.id
    });
    if (!alreadyLiked) {
      hoshiaLifeMemoryService.recordInteraction({ post, interaction });
      const visualUpdate = hoshiaVisualStateService.applyUserInteraction({
        text: "nice",
        session: req.session
      });
      if (visualUpdate.changed) {
        moduleEventStore.append(createHoshiaVisualStateChangedEvent(visualUpdate.state, req.session, {
          roomId: config.roomId,
          reason: "timeline post like",
          source: "post_like"
        }));
        appendVisualStateChangedCharacterEvent(visualUpdate.state, req.session, {
          reason: "timeline post like",
          source: "post_like"
        });
        broadcastHoshiaState(visualUpdate.state);
      }
    }
    res.json({
      ok: true,
      post: publicPostForViewer(post.id, req.session.user_id)
    });
  });

  app.post("/api/hoshia/posts/:id/comment", requireSession, async (req, res) => {
    const post = db.getHoshiaPost(req.params.id);
    if (!post) return res.status(404).json({ error: "post_not_found" });
    const input = normalizeCommentInput(req.body, req.session, new Date());
    if (!input) return res.status(400).json({ error: "comment_invalid" });
    const commentRollout = commentReplyRolloutForInteraction(input, {
      asyncEnabled: config.hoshiaAsyncCommentReplyEnabled,
      mode: config.hoshiaCommentReplyRolloutMode,
      greyPercent: config.hoshiaCommentReplyGreyPercent
    });
    const replyFields = commentRollout.shouldSchedule
      ? hoshiaCommentReplyService.pendingFields({
        minDelayMinutes: config.hoshiaCommentReplyMinDelayMinutes,
        maxDelayMinutes: config.hoshiaCommentReplyMaxDelayMinutes
      })
      : { reply_status: "none" };
    const interaction = db.addHoshiaPostInteraction({
      ...input,
      ...replyFields,
      post_id: post.id
    });
    hoshiaLifeMemoryService.recordInteraction({ post, interaction });
    if (interaction?.reply_status === "pending") {
      moduleEventStore.append(createHoshiaCommentReplyEvent({
        post,
        comment: interaction,
        status: "pending"
      }, {
        roomId: config.roomId
      }));
      appendTimelineCommentReplyCharacterEvent({ post, comment: interaction, status: "pending" });
      scheduleCommentReplyTick();
    }
    const visualUpdate = hoshiaVisualStateService.applyUserInteraction({
      text: input.content,
      session: req.session
    });
    if (visualUpdate.changed) {
      moduleEventStore.append(createHoshiaVisualStateChangedEvent(visualUpdate.state, req.session, {
        roomId: config.roomId,
        reason: "timeline comment",
        source: "post_comment"
      }));
      appendVisualStateChangedCharacterEvent(visualUpdate.state, req.session, {
        reason: "timeline comment",
        source: "post_comment"
      });
      broadcastHoshiaState(visualUpdate.state);
    }
    res.status(201).json({
      ok: true,
      interaction,
      post: publicPostForViewer(post.id, req.session.user_id)
    });
  });

  app.post("/api/hoshia/comments/reply-tick", requireSession, async (req, res) => {
    if (!config.hoshiaAsyncCommentReplyEnabled && req.body?.force !== true) {
      const summary = getHoshiaOpsSummary();
      return res.json({
        ok: true,
        processed_count: 0,
        failed_count: 0,
        items: [],
        reason: "async_comment_reply_disabled",
        reply_processed_today: summary.reply_processed_today,
        reply_daily_limit: summary.limits.comment_reply_daily_limit,
        pending_comment_count: summary.pending_comment_count
      });
    }
    const result = await runCommentReplyTick({
      limit: req.body?.limit,
      force: req.body?.force === true,
      shadowOnly: config.hoshiaCommentReplyRolloutMode === "shadow"
    });
    const summary = getHoshiaOpsSummary();
    res.json({
      ...result,
      reason: result.reason || "",
      reply_processed_today: summary.reply_processed_today,
      reply_daily_limit: summary.limits.comment_reply_daily_limit,
      pending_comment_count: summary.pending_comment_count
    });
  });

  app.post("/api/hoshia/posts/daily/tick", requireSession, async (req, res) => {
    const result = await runDailyPostTick({
      force: req.body?.force === true,
      ignoreLimit: req.body?.ignoreLimit === true,
      session: req.session,
      source: "manual"
    });
    const summary = getHoshiaOpsSummary();
    res.json({
      ...result,
      reply_processed_today: summary.reply_processed_today,
      reply_daily_limit: summary.limits.comment_reply_daily_limit,
      pending_comment_count: summary.pending_comment_count,
      post: result.post ? publicPostForViewer(result.post.id, req.session.user_id) : null
    });
  });

  app.post("/api/hoshia/state/update", requireSession, async (req, res) => {
    const result = updateHoshiaVisualState({
      body: req.body,
      session: req.session,
      reason: "manual visual state update"
    });
    if (result.changed) {
      moduleEventStore.append(createHoshiaVisualStateChangedEvent(result.state, req.session, {
        roomId: config.roomId,
        reason: result.reason,
        source: "manual"
      }));
      appendVisualStateChangedCharacterEvent(result.state, req.session, {
        reason: result.reason,
        source: "manual"
      });
      broadcastHoshiaState(result.state);
    }
    scheduleNextHoshiaVisualTick();
    const summary = getHoshiaOpsSummary();
    res.json({
      ok: true,
      changed: result.changed,
      state: result.state,
      reason: result.reason || "",
      daily_count: summary.generated_post_count,
      daily_min: summary.limits.daily_min,
      daily_max: summary.limits.daily_max,
      reply_processed_today: summary.reply_processed_today,
      reply_daily_limit: summary.limits.comment_reply_daily_limit,
      pending_comment_count: summary.pending_comment_count
    });
  });

  app.post("/api/hoshia/state/tick", requireSession, async (req, res) => {
    const result = tickHoshiaVisualState({
      reason: String(req.body?.reason || "manual visual tick").slice(0, 80),
      session: req.session
    });
    if (result.changed) {
      moduleEventStore.append(createHoshiaVisualStateChangedEvent(result.state, req.session, {
        roomId: config.roomId,
        reason: result.reason,
        source: "manual_tick"
      }));
      appendVisualStateChangedCharacterEvent(result.state, req.session, {
        reason: result.reason,
        source: "manual_tick"
      });
      broadcastHoshiaState(result.state);
    }
    scheduleNextHoshiaVisualTick();
    const summary = getHoshiaOpsSummary();
    res.json({
      ok: true,
      changed: result.changed,
      state: result.state,
      reason: result.reason || "",
      daily_count: summary.generated_post_count,
      daily_min: summary.limits.daily_min,
      daily_max: summary.limits.daily_max,
      reply_processed_today: summary.reply_processed_today,
      reply_daily_limit: summary.limits.comment_reply_daily_limit,
      pending_comment_count: summary.pending_comment_count
    });
  });
}
