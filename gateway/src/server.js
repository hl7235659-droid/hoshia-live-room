import express from "express";
import http from "node:http";
import { readFileSync } from "node:fs";
import cookie from "cookie";
import Redis from "ioredis";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { openLiveRoomDatabase } from "./database.js";
import { attachLiveRoomWebSocket, WEB_SOCKET_OPEN } from "./live-room-websocket.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerPixelGameRoutes } from "./game-routes.js";
import { createHoshiaPixelGameService } from "./game-service.js";
import {
  cookieName,
  decodeSessionCookie,
  newSessionId
} from "./security.js";
import { generateAiReply, recognizeMusicIntent, summarizeLiveRoomContext } from "./ai-adapter.js";
import { isValidState, nextCharacterState } from "./state-machine.js";
import { buildRealityContext } from "./reality-context.js";
import { pickRuntimeRevision } from "./revision-utils.js";
import { buildHostLifeContext } from "./host-life-context.js";
import { hoshiaPersonaPrompt } from "./hoshia-persona.js";
import {
  buildModuleContext,
  createHoshiaCommentReplyEvent,
  createHoshiaInterestKnowledgeModuleProvider,
  createHoshiaInterestModuleProvider,
  createHoshiaLifeModuleProvider,
  createHoshiaPostCreatedEvent,
  createHoshiaNewsModuleProvider,
  createHoshiaPixelGameModuleProvider,
  createHoshiaVisualModuleProvider,
  createHoshiaVisualStateChangedEvent,
  createMusicModuleProvider,
  createModuleEventStore,
  createMusicControlEvent,
  createMusicSongRequestedEvent
} from "./module-context.js";
import {
  createHoshiaVisualStateService,
  normalizeHoshiaTickWindow,
  randomHoshiaTickDelayMs
} from "./hoshia-visual-state.js";
import {
  createHoshiaLifeMemoryService,
  likeInteractionInput,
  normalizeCommentInput,
  normalizePostInput,
  publicPost
} from "./hoshia-life-memory.js";
import { createHoshiaNewsService } from "./hoshia-news-service.js";
import {
  commentReplyRolloutForInteraction,
  createHoshiaCommentReplyService
} from "./hoshia-comment-reply.js";
import {
  createHoshiaDailyPostService,
  runDailyPostLive,
  runNewsTopicLive
} from "./hoshia-daily-post.js";
import { createHoshiaInterestSystem } from "./hoshia-interest-system.js";
import { createHoshiaInterestKnowledgeService } from "./interest-knowledge.js";
import {
  buildActualDiaryLivePrompt,
  buildDailyCanonPlanLivePrompt,
  createHoshiaDailyCanonService,
  parseActualDiaryReply,
  parseDailyCanonPlanReply
} from "./hoshia-daily-canon.js";
import { buildHoshiaOpsSummary } from "./hoshia-ops-summary.js";
import {
  createProactiveReplyState,
  markUserActivityForProactive,
  nextProactiveDelayMs,
  rememberProactiveReply,
  shouldRunHoshiaClawProactiveLive,
  shouldRunProactiveReply
} from "./proactive-reply.js";
import { runHoshiaClawProactiveShadow } from "./proactive-shadow.js";
import {
  buildProactiveLiveMetadata,
  buildProactiveLivePrompt,
  runHoshiaClawProactiveLive
} from "./proactive-live.js";
import {
  buildDailyPostShadowPrompt,
  buildNewsTopicGenerateShadowPrompt,
  runDailyPostShadow,
  dailyPostShadowPreflightSkipReason,
  runNewsTopicGenerateShadow
} from "./hoshiaclaw-shadow.js";
import { MusicService, isLikelyMusicRequestText, parseLocalMusicControlText, parseMusicRequestText } from "./music-service.js";
import { createLiveRoomEventFormatter, friendlyMusicError, musicStatusCode } from "./live-room-formatters.js";
import {
  buildWelcomeGreetingPrompt,
  fallbackWelcomeGreeting,
  shouldScheduleWelcomeGreeting,
  welcomeCooldownKey,
  welcomeInflightKey
} from "./welcome-greeting.js";
import {
  buildActiveContext,
  buildContextPolicy,
  classifyMessageRoute,
  formatActiveContextLines,
  pendingReplyNotice,
  quickReplyLead
} from "./message-router.js";
import {
  normalizeHoshiaPresentation,
  collectPresentationObservabilityCounts,
  presentationFromCharacterState,
  presentationFromClawEnvelope,
  presentationFromVisualState
} from "./hoshia-presentation.js";
import {
  buildRuntimeObservabilitySnapshot,
  createRuntimeObservabilityCounters,
  recordAiProviderObservation as recordAiProviderObservationCounter,
  recordRouteObservation,
  routeStatusFromCounts
} from "./hoshia-runtime-observability.js";
import {
  buildCharacterSnapshot,
  normalizeCharacterEvent,
  summarizeCharacterSnapshotForPrompt
} from "./character-snapshot.js";
import { projectCharacterEvent } from "./character-event-projector.js";
import {
  buildHoshiaReplyMetadata,
  buildShortTermAiContext,
  contextPayloadMessage as centerContextPayloadMessage,
  prepareHoshiaCenterContext
} from "./hoshia-center-context.js";

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.expiresAt = new Map();
  }

  async setex(key, ttlSeconds, value) {
    this.values.set(key, value);
    this.expiresAt.set(key, Date.now() + ttlSeconds * 1000);
  }

  async get(key) {
    this.prune(key);
    return this.values.get(key) ?? null;
  }

  async del(key) {
    this.values.delete(key);
    this.expiresAt.delete(key);
  }

  async lrange(key, start, stop) {
    this.prune(key);
    const list = this.values.get(key) || [];
    const end = stop < 0 ? undefined : stop + 1;
    return list.slice(start, end);
  }

  async lpush(key, value) {
    this.prune(key);
    const list = this.values.get(key) || [];
    list.unshift(value);
    this.values.set(key, list);
  }

  async ltrim(key, start, stop) {
    this.prune(key);
    const list = this.values.get(key) || [];
    const end = stop < 0 ? undefined : stop + 1;
    this.values.set(key, list.slice(start, end));
  }

  async incr(key) {
    this.prune(key);
    const next = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire(key, ttlSeconds) {
    this.expiresAt.set(key, Date.now() + ttlSeconds * 1000);
  }

  prune(key) {
    const expiresAt = this.expiresAt.get(key);
    if (expiresAt && Date.now() > expiresAt) {
      this.values.delete(key);
      this.expiresAt.delete(key);
    }
  }
}

const { messageEvent, systemEvent } = createLiveRoomEventFormatter({
  roomId: config.roomId,
  createId: () => nanoid(12)
});

const app = express();
const server = http.createServer(app);
const store = await createStore();
const db = openLiveRoomDatabase(config.sqliteDbPath);
const musicService = new MusicService(config, { store });
const hoshiaVisualStateService = createHoshiaVisualStateService({ db });
const hoshiaLifeMemoryService = createHoshiaLifeMemoryService({ db });
const hoshiaNewsService = createHoshiaNewsService(config, { fetchImpl: globalThis.fetch });
const hoshiaInterestSystem = createHoshiaInterestSystem({
  lifeMemoryService: hoshiaLifeMemoryService,
  timeZone: config.realityContextTimezone || "Asia/Shanghai"
});
const hoshiaInterestKnowledgeService = createHoshiaInterestKnowledgeService();
const hoshiaDailyCanonService = createHoshiaDailyCanonService({
  db,
  timeZone: config.realityContextTimezone || "Asia/Shanghai",
  planGenerator: config.hoshiaClawDailyCanonLiveEnabled ? generateDailyCanonPlanLive : null,
  actualDiaryGenerator: config.hoshiaClawDailyActualDiaryLiveEnabled ? generateActualDiaryLive : null
});
const hoshiaPixelGameService = createHoshiaPixelGameService({
  db,
  roomId: config.roomId,
  hoshiaVisualStateProvider: () => hoshiaVisualStateService.publicState()
});
const moduleEventStore = createModuleEventStore({ maxEvents: 120 });
const hoshiaCommentReplyService = createHoshiaCommentReplyService({
  db,
  lifeMemoryService: hoshiaLifeMemoryService,
  moduleEventStore,
  aiReplyGenerator: generatePostCommentReply,
  shadowGenerator: generatePostCommentReplyShadow,
  visualStateProvider: () => hoshiaVisualStateService.publicState(),
  moduleContextProvider: ({ session }) => buildModuleContext({ providers: moduleProviders, session }),
  moduleEventsProvider: () => moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 }),
  config,
  rolloutMode: config.hoshiaCommentReplyRolloutMode,
  greyPercent: config.hoshiaCommentReplyGreyPercent,
  dailyReplyLimit: config.hoshiaCommentReplyDailyLimit,
  minDelayMinutes: config.hoshiaCommentReplyMinDelayMinutes,
  maxDelayMinutes: config.hoshiaCommentReplyMaxDelayMinutes,
  defaultLimit: config.hoshiaCommentReplyTickLimit,
  maxRepliesPerTick: config.hoshiaCommentReplyTickLimit
});
const hoshiaDailyPostService = createHoshiaDailyPostService({
  db,
  visualStateService: hoshiaVisualStateService,
  enabled: config.hoshiaDailyPostEnabled,
  dailyMin: config.hoshiaDailyPostMin,
  dailyMax: config.hoshiaDailyPostMax,
  minIntervalMinutes: config.hoshiaStatePostMinIntervalMinutes,
  activeWindow: {
    start: config.hoshiaStatePostActiveWindowStart,
    end: config.hoshiaStatePostActiveWindowEnd
  },
  roomId: config.roomId
});
const moduleProviders = [
  createMusicModuleProvider(musicService),
  createHoshiaVisualModuleProvider(hoshiaVisualStateService),
  createHoshiaLifeModuleProvider(hoshiaDailyCanonService),
  createHoshiaInterestModuleProvider(hoshiaInterestSystem),
  createHoshiaInterestKnowledgeModuleProvider(hoshiaInterestKnowledgeService),
  createHoshiaNewsModuleProvider(hoshiaNewsService),
  createHoshiaPixelGameModuleProvider(hoshiaPixelGameService)
];
const sockets = new Map();
const activeUserConnections = new Map();
let characterState = "IDLE";
const replyBatchWindowMs = 3200;
const mentionReplyWindowMs = 1200;
const fastReplyBatchWindowMs = 700;
const quickReplyLeadDelayMs = 850;
const maxReplyBatchSize = 8;
const maxReplyTargets = 3;
const singleUserReplyDelayMs = Math.max(0, Math.min(Number(config.singleUserReplyDelayMs || 600), 3000));
const musicIntentIdleDelayMs = 1000;
let pendingReplyBatch = [];
let replyBatchTimer = null;
let replyBatchRunning = false;
const proactiveReplyState = createProactiveReplyState();
const hoshiaVisualTickWindow = normalizeHoshiaTickWindow(
  config.hoshiaStateTickMinMinutes,
  config.hoshiaStateTickMaxMinutes
);
let hoshiaVisualTickTimer = null;
let hoshiaCommentReplyTimer = null;
let hoshiaNewsTopicSyncTimer = null;
let currentHoshiaPresentation = null;
const observabilityCounters = createRuntimeObservabilityCounters();

app.use(express.json({ limit: "32kb" }));
registerAccountRoutes(app, {
  activeUserConnections,
  audiencePayload,
  broadcastAudienceChanged,
  config,
  createSessionForUser,
  db,
  getSessionIdFromReq,
  normalizeOnboardingProfile,
  publicSession,
  refreshSocketSessions,
  requireSession,
  roomInfo,
  saveSession,
  scheduleWelcomeGreeting,
  sessionFromUser,
  shouldScheduleWelcomeGreeting,
  store,
  uniqueOnlineCount
});

registerPixelGameRoutes(app, {
  config,
  gameService: hoshiaPixelGameService,
  moduleEventStore,
  requireSession,
  generateGameReport,
  normalizeStoredAiProfile,
  appendCharacterEvent
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "live-room-dev",
    room_id: config.roomId,
    state: characterState,
    revision: safeRevision(),
    modes: safeRuntimeModes(),
    observability: buildRuntimeObservability()
  });
});

app.get("/api/room/state", requireSession, async (_req, res) => {
  const recent = db.listRecentRoomMessages(config.roomId, 100);
  res.json({
    room: roomInfo(),
    state: characterState,
    hoshia_state: hoshiaVisualStateService.publicState(),
    hoshia_presentation: currentHoshiaPresentation || presentationFromCharacterState(characterState),
    messages: recent
  });
});

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

app.get("/api/music/state", requireSession, async (req, res) => {
  res.json(musicService.publicState(req.session));
});

app.post("/api/music/request", requireSession, async (req, res) => {
  const result = await musicService.requestSong(req.body?.query, req.session);
  if (!result.ok) {
    broadcastMusicState(req.session);
    return res.status(musicStatusCode(result.error)).json(result);
  }
  moduleEventStore.append(createMusicSongRequestedEvent(result.track, req.session, {
    roomId: config.roomId,
    memoryEligible: normalizeStoredAiProfile(req.session.ai_profile)?.memory_enabled === true,
    retentionDays: 30
  }));
  appendMusicSongRequestedCharacterEvent(result.track, req.session);
  await broadcastSystemText(`♪ ${req.session.nickname} 点歌《${result.track.title}》已加入播放。`);
  broadcastMusicState(req.session);
  res.json(result);
});

app.post("/api/music/control", requireSession, async (req, res) => {
  const result = musicService.control(req.body?.action, req.session, req.body || {});
  broadcastMusicState(req.session);
  if (!result.ok) return res.status(musicStatusCode(result.error)).json(result);
  moduleEventStore.append(createMusicControlEvent(req.body?.action, req.session, {
    roomId: config.roomId,
    status: "done",
    sourceKind: "manual"
  }));
  appendMusicControlCharacterEvent(req.body?.action, req.session, { sourceKind: "manual" });
  res.json(result);
});

app.post("/api/music/playback", requireSession, async (req, res) => {
  const result = musicService.completeCurrentTrack(req.body?.track_id ?? req.body?.trackId, req.session);
  broadcastMusicState(req.session);
  if (!result.ok) return res.status(musicStatusCode(result.error)).json(result);
  res.json(result);
});

app.get("/api/music/stream/:trackId", requireSession, async (req, res) => {
  try {
    await musicService.streamTrack(req.params.trackId, req, res);
  } catch (error) {
    res.status(502).json({ error: "music_stream_failed" });
  }
});

attachLiveRoomWebSocket(server, {
  activeUserConnections,
  broadcast,
  broadcastAudienceChanged,
  characterState: () => characterState,
  config,
  db,
  handleDanmaku,
  hoshiaVisualStateService,
  hoshiaPresentation: () => currentHoshiaPresentation || presentationFromCharacterState(characterState),
  loadSessionFromReq,
  markUserOffline,
  markUserOnline,
  musicService,
  onClose: () => {
    if (hoshiaVisualTickTimer) clearTimeout(hoshiaVisualTickTimer);
    if (hoshiaCommentReplyTimer) clearTimeout(hoshiaCommentReplyTimer);
  },
  roomInfo,
  scheduleProactiveReplyCheck,
  scheduleWelcomeGreeting,
  shouldScheduleWelcomeGreeting,
  sockets,
  systemEvent,
  uniqueOnlineCount
});

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

scheduleNextHoshiaVisualTick();
scheduleCommentReplyTick();
scheduleHoshiaNewsTopicSync(10000);

async function handleDanmaku(session, payload) {
  const text = String(payload.text || "").trim();
  if (!text || text.length > config.maxMessageLength) {
    return sendToSession(session.user_id, { type: "error", error: "message_invalid" });
  }

  const allowed = await consumeRateLimit(session.user_id);
  if (!allowed) {
    return sendToSession(session.user_id, { type: "error", error: "rate_limited" });
  }

  const userMessage = messageEvent("danmaku", "user", text, session);
  await storeMessage(userMessage);
  appendCharacterEvent({
    event_type: "user.message_received",
    source_kind: "chat",
    source_id: userMessage.id,
    user_id: session.user_id,
    nickname: session.nickname,
    public_hint: `${session.nickname} sent a live room message`,
    private_hint: `${session.nickname}: ${text}`,
    reason: "viewer message",
    data: { status: "received" }
  });
  hoshiaLifeMemoryService.recordChatInteraction({
    session,
    text,
    messageId: userMessage.id
  });
  hoshiaDailyCanonService.recordUserInteraction({
    session,
    text,
    now: new Date()
  });
  broadcast(userMessage);
  markUserActivityForProactive(proactiveReplyState);
  scheduleProactiveReplyCheck();
  const visualUpdate = updateHoshiaVisualState({
    body: { text, session },
    session,
    reason: `chat interaction from ${session.nickname}`
  });
  if (visualUpdate.changed) {
    moduleEventStore.append(createHoshiaVisualStateChangedEvent(visualUpdate.state, session, {
      roomId: config.roomId,
      reason: visualUpdate.reason,
      source: "chat"
    }));
    appendVisualStateChangedCharacterEvent(visualUpdate.state, session, {
      reason: visualUpdate.reason,
      source: "chat"
    });
    broadcastHoshiaState(visualUpdate.state);
  }
  await setCharacterState(nextCharacterState("user_message", text));

  const musicQuery = parseMusicRequestText(text);
  if (musicQuery) {
    await handleMusicRequestFromDanmaku(session, musicQuery, text);
    scheduleCharacterIdleFromListening();
    return;
  }

  const musicIntentHandled = await handleNaturalMusicIntentFromDanmaku(session, text);
  if (musicIntentHandled) {
    scheduleCharacterIdleFromListening();
    return;
  }

  enqueueAiReply(session, text);
}

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
        text: "\u8fdb\u5165\u76f4\u64ad\u95f4",
        mentioned: true,
        timestamp: new Date().toISOString()
      }],
      audienceUsers: audiencePayload().users,
      activeConnections: activeUserConnections,
      moduleContext,
      moduleEvents
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

async function requireSession(req, res, next) {
  const sessionId = getSessionIdFromReq(req);
  const session = sessionId ? await loadSessionById(sessionId) : null;
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.sessionId = sessionId;
  req.session = session;
  next();
}

async function loadSessionFromReq(req) {
  const sessionId = getSessionIdFromReq(req);
  if (!sessionId) return null;
  return loadSessionById(sessionId);
}

async function loadSessionById(sessionId) {
  const raw = await store.get(sessionKey(sessionId));
  return raw ? JSON.parse(raw) : null;
}

function getSessionIdFromReq(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  return decodeSessionCookie(cookies[cookieName], config.sessionSecret);
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

function replyTargets(batch) {
  const seen = new Set();
  const targets = [];
  for (const item of batch.filter((entry) => entry.mentioned)) {
    const nickname = String(item.session.nickname || "").trim();
    if (!nickname || seen.has(nickname)) continue;
    seen.add(nickname);
    targets.push(nickname);
    if (targets.length >= maxReplyTargets) break;
  }
  return targets;
}

function roomAiSession(batch) {
  const first = batch[0]?.session || {};
  return {
    user_id: "room",
    username: "room",
    nickname: "小房间留言",
    room_id: first.room_id || config.roomId
  };
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

function normalizeOnboardingProfile(body, session) {
  const memoryEnabled = Boolean(body?.memoryEnabled ?? body?.memory_enabled);
  if (!memoryEnabled) {
    return { memory_enabled: false };
  }

  const replyStyle = normalizeReplyStyle(body?.replyStyle ?? body?.reply_style);
  const preferredName = String((body?.preferredName ?? body?.preferred_name ?? session.nickname) || "").trim().slice(0, 32);
  const replyStyleText = String(body?.replyStyleText ?? body?.reply_style_text ?? replyStyleLabel(replyStyle)).trim().slice(0, 60);
  const interests = String(body?.interests ?? "").trim().slice(0, 160);

  if (!preferredName || !replyStyle) return null;
  return {
    preferred_name: preferredName,
    reply_style: replyStyle,
    reply_style_text: replyStyleText || replyStyleLabel(replyStyle),
    interests,
    memory_enabled: true
  };
}

function normalizeReplyStyle(value) {
  const style = String(value || "").trim();
  return ["friend", "teasing_friend", "cool", "custom"].includes(style) ? style : null;
}

function replyStyleLabel(style) {
  if (style === "teasing_friend") return "像损友一样";
  if (style === "cool") return "高冷一点";
  if (style === "custom") return "自定义风格";
  return "像朋友一样";
}

function parseAiProfileJson(value) {
  if (!value) return null;
  try {
    return normalizeStoredAiProfile(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeStoredAiProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const replyStyle = normalizeReplyStyle(profile.reply_style) || "friend";
  return {
    preferred_name: String(profile.preferred_name || "").trim().slice(0, 32),
    reply_style: replyStyle,
    reply_style_text: String(profile.reply_style_text || replyStyleLabel(replyStyle)).trim().slice(0, 60),
    interests: String(profile.interests || "").trim().slice(0, 160),
    memory_enabled: profile.memory_enabled !== false
  };
}

async function consumeRateLimit(userId) {
  const key = `live-room:rate:${userId}`;
  const count = await store.incr(key);
  if (count === 1) await store.expire(key, config.rateWindowSeconds);
  return count <= config.rateLimitCount;
}

async function storeMessage(event) {
  db.insertRoomMessage(event);
  db.pruneRoomMessages(event.room_id, 500);
}

async function broadcastSystemText(text) {
  const event = systemEvent("system", text);
  await storeMessage(event);
  broadcast(event);
}

async function setCharacterState(state) {
  characterState = state;
  const timestamp = new Date().toISOString();
  broadcast({ type: "character_state", room_id: config.roomId, state, timestamp });
  broadcastHoshiaPresentation(presentationFromCharacterState(state, { now: timestamp }));
}

function scheduleCharacterIdleFromListening() {
  setTimeout(() => {
    if (characterState === "LISTENING") void setCharacterState("IDLE");
  }, musicIntentIdleDelayMs);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of sockets.keys()) {
    if (ws.readyState === WEB_SOCKET_OPEN) ws.send(data);
  }
}

function broadcastAiReplyPending({ traceId, route, batch = [] } = {}) {
  const latest = Array.isArray(batch) ? batch[batch.length - 1] : null;
  broadcast({
    type: "ai_reply_pending",
    id: `pending_${traceId || nanoid(8)}`,
    room_id: config.roomId,
    role: "system",
    user_id: "system",
    nickname: "sys",
    text: pendingReplyNotice(route),
    timestamp: new Date().toISOString(),
    latency_trace_id: traceId || "",
    route: route || "smalltalk",
    reply_targets: replyTargets(batch),
    source_message_id: latest?.id || ""
  });
  broadcastHoshiaPresentation(normalizeHoshiaPresentation({
    action: "think",
    fallback_state: "THINKING",
    source: "system",
    trace_id: traceId,
    reason: route || "reply_pending"
  }));
}

function broadcastAiReplyDelta({ traceId, route, text = "", deltaMode = "append", stage = "" } = {}) {
  const value = String(text || "");
  if (!traceId || !value) return;
  broadcast({
    type: "ai_reply_delta",
    room_id: config.roomId,
    role: "ai",
    user_id: "ai-host",
    nickname: "Hoshia",
    text: value,
    timestamp: new Date().toISOString(),
    latency_trace_id: traceId,
    route: route || "smalltalk",
    delta_mode: deltaMode,
    stage
  });
}

function createSentenceStreamEmitter({ traceId, route } = {}) {
  let buffer = "";
  let pending = Promise.resolve();
  let chunkIndex = 0;

  function enqueue(chunk, nextRoute) {
    const text = String(chunk || "");
    if (!text) return;
    const stage = `stream_${chunkIndex + 1}`;
    const delay = chunkIndex === 0 ? 0 : progressiveReplyDelayMs(nextRoute || route, chunkIndex);
    chunkIndex += 1;
    pending = pending.then(async () => {
      if (delay > 0) await sleep(Math.min(delay, 700));
      broadcastAiReplyDelta({
        traceId,
        route: nextRoute || route,
        text,
        deltaMode: "append",
        stage
      });
    });
  }

  function drain({ flush = false, nextRoute = route } = {}) {
    while (buffer) {
      const chunk = takeNextSentenceStreamChunk(buffer, flush);
      if (!chunk) break;
      buffer = buffer.slice(chunk.length);
      enqueue(chunk, nextRoute);
    }
  }

  return {
    push(text = "", nextRoute = route) {
      buffer += String(text || "");
      drain({ flush: false, nextRoute });
    },
    async flush() {
      drain({ flush: true, nextRoute: route });
      await pending;
    }
  };
}

function takeNextSentenceStreamChunk(text = "", flush = false) {
  const value = String(text || "");
  if (!value) return "";
  const sentenceMatch = value.match(/^[\s\S]{1,90}?[。！？!?…~～]+(?:["'”’』」）)]*)?/);
  if (sentenceMatch?.[0]) return sentenceMatch[0];
  if (!flush && value.length < 42) return "";
  if (flush) return value;
  const softBreak = value.slice(0, 42).lastIndexOf("，");
  const end = softBreak >= 16 ? softBreak + 1 : 42;
  return value.slice(0, end);
}

async function broadcastProgressiveReplyDeltas({ traceId, route, text = "", hasLead = false } = {}) {
  const chunks = splitReplyForProgressiveDisplay(text);
  if (!traceId || chunks.length <= 1) return;
  let displayed = hasLead ? String(chunks[0] || "") : "";
  for (const [index, chunk] of chunks.entries()) {
    if (!chunk) continue;
    if (index === 0) {
      if (!hasLead) {
        displayed = chunk;
        broadcastAiReplyDelta({ traceId, route, text: displayed, deltaMode: "replace", stage: "reply_1" });
      }
      continue;
    }
    await sleep(progressiveReplyDelayMs(route, index));
    displayed = displayed ? `${displayed}${chunk}` : chunk;
    broadcastAiReplyDelta({ traceId, route, text: displayed, deltaMode: "replace", stage: `reply_${index + 1}` });
  }
}

function splitReplyForProgressiveDisplay(text = "") {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length < 34) return [clean].filter(Boolean);
  const parts = clean.match(/[^。！？!?…]+[。！？!?…]+|[^。！？!?…]+$/g)
    ?.map((item) => item.trim())
    .filter(Boolean) || [clean];
  const chunks = [];
  for (const part of parts) {
    if (!chunks.length || chunks.length >= 3) {
      chunks.push(part);
    } else if (chunks[chunks.length - 1].length < 24) {
      chunks[chunks.length - 1] += part;
    } else {
      chunks.push(part);
    }
  }
  if (chunks.length > 3) {
    return [chunks[0], chunks[1], chunks.slice(2).join("")];
  }
  return chunks;
}

function progressiveReplyDelayMs(route, index) {
  if (route === "diary_related") return index === 1 ? 900 : 1700;
  if (route === "emotional") return index === 1 ? 800 : 1400;
  return index === 1 ? 550 : 900;
}

function broadcastAiReplyDone({ traceId, route, skipped = false } = {}) {
  broadcast({
    type: "ai_reply_done",
    room_id: config.roomId,
    timestamp: new Date().toISOString(),
    latency_trace_id: traceId || "",
    route: route || "smalltalk",
    skipped: Boolean(skipped)
  });
}

function buildGatewayLatencyBreakdown({ replyBreakdown = {}, routerMs = 0, contextLoadMs = 0, gatewayStartedAt = performance.now(), pendingVisibleMs = 0 } = {}) {
  const bridgeContextLoadMs = Number(replyBreakdown?.context_load_ms);
  const gatewayContextLoadMs = Math.max(0, Math.round(Number(contextLoadMs) || 0));
  const gatewayTotalMs = Math.max(0, Math.round(performance.now() - gatewayStartedAt));
  const batchWaitMs = Math.max(0, Math.round(Number(pendingVisibleMs) || 0));
  return {
    ...(replyBreakdown || {}),
    router_ms: Math.max(0, Math.round(Number(routerMs) || 0)),
    batch_wait_ms: batchWaitMs,
    pending_visible_ms: batchWaitMs,
    gateway_context_load_ms: gatewayContextLoadMs,
    ...(Number.isFinite(bridgeContextLoadMs) ? { bridge_context_load_ms: Math.max(0, Math.round(bridgeContextLoadMs)) } : {}),
    context_load_ms: gatewayContextLoadMs + (Number.isFinite(bridgeContextLoadMs) ? Math.max(0, Math.round(bridgeContextLoadMs)) : 0),
    gateway_total_ms: gatewayTotalMs,
    total_ms: gatewayTotalMs
  };
}

function broadcastMusicState() {
  for (const [ws, session] of sockets.entries()) {
    if (ws.readyState === WEB_SOCKET_OPEN) {
      ws.send(JSON.stringify({ type: "music_state", ...musicService.publicState(session) }));
    }
  }
}

function broadcastHoshiaState(state = hoshiaVisualStateService.publicState()) {
  broadcast({
    type: "hoshia_state",
    room_id: config.roomId,
    state,
    timestamp: new Date().toISOString()
  });
  broadcastHoshiaPresentation(presentationFromVisualState(state, { characterState }));
}

function broadcastHoshiaPresentation(presentation) {
  const counts = collectPresentationObservabilityCounts(presentation, {
    state: characterState,
    source: presentation?.source || "system"
  });
  currentHoshiaPresentation = normalizeHoshiaPresentation(presentation, {
    state: characterState,
    source: presentation?.source || "system"
  });
  observabilityCounters.presentationEmitted += 1;
  observabilityCounters.presentationSanitized += Number(counts.action_fallback_count || 0)
    + Number(counts.duration_clamped_count || 0)
    + Number(counts.fallback_png_rejected_count || 0)
    + Number(counts.sensitive_field_rejected_count || 0);
  broadcast({
    type: "hoshia_presentation",
    room_id: config.roomId,
    presentation: currentHoshiaPresentation,
    timestamp: currentHoshiaPresentation.timestamp
  });
}

function buildCurrentCharacterSnapshot(session = null) {
  const visualState = hoshiaVisualStateService.publicState();
  const dailyContext = hoshiaDailyCanonService.buildContext(session, { now: new Date(), create: true });
  const roomSummary = db.getRoomContextSummary(config.roomId);
  const userProfile = session?.user_id ? db.getUserCharacterProfile(session.user_id, "hoshia") : null;
  const lifeMemories = session?.user_id
    ? db.searchHoshiaLifeMemories({
        characterId: "hoshia",
        userId: session.user_id,
        query: `${session.nickname || ""} ${visualState.mood || ""} ${visualState.activity || ""}`,
        limit: 6
      })
    : [];
  return buildCharacterSnapshot({
    roomId: config.roomId,
    characterId: "hoshia",
    characterState,
    visualState,
    dailyContext,
    userProfile,
    roomSummary,
    lifeMemories,
    moduleEvents: moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 })
  });
}

function buildEventLogCharacterSnapshot({ roomId, characterId = "hoshia" } = {}) {
  const current = db.getLatestCharacterSnapshot({ roomId, characterId });
  if (!current) return null;

  const events = db.listRecentCharacterEvents({ roomId, characterId, limit: 100 }).slice().reverse();
  let projected = current;
  for (const event of events) {
    projected = projectCharacterEvent(projected, event);
  }

  if (JSON.stringify(projected) !== JSON.stringify(current)) {
    db.upsertCharacterSnapshot({ roomId, characterId, snapshot: projected });
  }
  return projected;
}

function appendCharacterEvent(event = {}) {
  try {
    return db.insertCharacterEvent(normalizeCharacterEvent({
      ...event,
      room_id: config.roomId,
      character_id: "hoshia"
    }));
  } catch (error) {
    console.warn("character_event_append_failed", {
      type: error?.name || "Error",
      message: error?.message || String(error)
    });
    return null;
  }
}

function appendMusicSongRequestedCharacterEvent(track, session) {
  if (!track) return null;
  return appendCharacterEvent({
    event_type: "module.music.song_requested",
    actor_type: "user",
    user_id: session?.user_id || track.requested_by_id || "",
    nickname: session?.nickname || track.requested_by || "",
    source_kind: "music",
    source_id: track.id || "",
    occurred_at: track.requested_at || new Date().toISOString(),
    public_hint: "Viewer requested a song",
    private_hint: "Viewer requested a song",
    reason: "music song request",
    data: {
      title: track.title || "",
      artist: track.artist || "",
      source_type: track.source || "",
      status: "requested"
    }
  });
}

function appendMusicControlCharacterEvent(action, session, { sourceKind = "manual" } = {}) {
  const safeAction = String(action || "").slice(0, 40);
  if (!safeAction) return null;
  return appendCharacterEvent({
    event_type: "module.music.control",
    actor_type: "user",
    user_id: session?.user_id || "",
    nickname: session?.nickname || "",
    source_kind: "music",
    source_id: safeAction,
    public_hint: "Viewer used a music control",
    private_hint: "Viewer used a music control",
    reason: safeAction,
    data: {
      action: safeAction,
      status: "done",
      source: sourceKind
    }
  });
}

function appendVisualStateChangedCharacterEvent(state, session, { reason = "", source = "interaction" } = {}) {
  if (!state) return null;
  return appendCharacterEvent({
    event_type: "hoshia_visual_state.changed",
    actor_type: session?.user_id ? "user" : "system",
    user_id: session?.user_id || "",
    nickname: session?.nickname || "",
    source_kind: "hoshia_visual_state",
    source_id: source,
    occurred_at: state.updated_at || new Date().toISOString(),
    public_hint: "Hoshia visual state changed",
    private_hint: "Hoshia visual state changed",
    reason: reason || source,
    data: {
      activity: state.activity || "",
      mood: state.mood || "",
      source,
      status: "changed"
    }
  });
}

function appendTimelinePostCreatedCharacterEvent(post, session, { reason = "daily_post" } = {}) {
  if (!post) return null;
  return appendCharacterEvent({
    event_type: "hoshia_timeline.post_created",
    actor_type: session?.user_id ? "user" : "system",
    user_id: session?.user_id || "",
    nickname: session?.nickname || "",
    source_kind: "hoshia_timeline",
    source_id: post.id || "",
    occurred_at: post.created_at || new Date().toISOString(),
    public_hint: "Hoshia created a timeline post",
    private_hint: "Hoshia created a timeline post",
    reason,
    data: {
      activity: post.activity || "",
      mood: post.mood || "",
      source_type: post.source_type || reason,
      post_id: post.id || "",
      status: "created"
    }
  });
}

function appendTimelineCommentReplyCharacterEvent({ post, comment, reply, status = "replied" } = {}) {
  return appendCharacterEvent({
    event_type: status === "pending" ? "hoshia_timeline.comment_reply_pending" : "hoshia_timeline.comment_replied",
    actor_type: status === "pending" ? "user" : "ai",
    user_id: comment?.user_id || "",
    nickname: comment?.nickname || "",
    source_kind: "hoshia_timeline",
    source_id: comment?.id || reply?.id || "",
    occurred_at: reply?.created_at || comment?.created_at || new Date().toISOString(),
    public_hint: status === "pending" ? "Viewer left a timeline comment" : "Hoshia replied to a timeline comment",
    private_hint: status === "pending" ? "Viewer left a timeline comment" : "Hoshia replied to a timeline comment",
    reason: `timeline comment ${status}`,
    data: {
      activity: post?.activity || "",
      mood: post?.mood || "",
      post_id: post?.id || "",
      comment_id: comment?.id || "",
      status
    }
  });
}

function recordModuleMemoryEventsSafely(moduleMemoryEvents = []) {
  if (!Array.isArray(moduleMemoryEvents) || !moduleMemoryEvents.length) return [];
  try {
    const memories = typeof hoshiaLifeMemoryService.recordModuleMemoryEvents === "function"
      ? hoshiaLifeMemoryService.recordModuleMemoryEvents(moduleMemoryEvents)
      : moduleMemoryEvents.map((event) => hoshiaLifeMemoryService.recordModuleMemoryEvent?.(event)).filter(Boolean);
    for (const memory of memories) {
      appendCharacterEvent({
        event_type: "module.memory.recorded",
        actor_type: memory.user_id ? "user" : "system",
        user_id: memory.user_id || "",
        nickname: "",
        source_kind: "module_memory",
        source_id: memory.id || "",
        occurred_at: memory.created_at || new Date().toISOString(),
        public_hint: "A safe module memory was recorded",
        private_hint: "A safe module memory was recorded",
        reason: memory.source || "module_memory",
        data: {
          status: "recorded",
          memory_kind: memory.tags?.find?.((tag) => tag && tag !== "module_memory") || memory.source || "",
          memory_type: memory.type || "",
          source_module: memory.source || "module_memory"
        }
      });
    }
    return memories;
  } catch (error) {
    console.warn("module_memory_record_failed", {
      type: error?.name || "Error",
      message: safeMetricReason(error?.message || "module_memory_record_failed")
    });
    return [];
  }
}

function recordProactiveShadowMetric(metric = {}) {
  if (!String(metric?.eventType || "").startsWith("hoshiaclaw.proactive_shadow.")) return null;
  return recordShadowMetricEvent({ ...metric, route: "proactive_idle_shadow" });
}

function recordProactiveLiveMetric(metric = {}) {
  if (!String(metric?.eventType || "").startsWith("hoshiaclaw.proactive_live.")) return null;
  return recordShadowMetricEvent({ ...metric, route: "proactive_idle_live" });
}

function recordCommentReplyShadowMetric(metric = {}) {
  if (!String(metric?.eventType || "").startsWith("hoshiaclaw.comment_reply_shadow.")) return null;
  return recordShadowMetricEvent({ ...metric, route: "post_comment_reply_shadow" });
}

function recordDailyPostLiveMetric(metric = {}) {
  const route = metric?.route === "news_topic_live" ? "news_topic_live" : "daily_post_live";
  recordRouteObservation(observabilityCounters, route, metric?.status);
  return null;
}

function recordShadowMetricEvent({ eventType = "", status = "", reason = "", source = "", route = "", commentId = "", postId = "" } = {}) {
  if (!String(eventType || "").startsWith("hoshiaclaw.")) return null;
  const safeStatus = ["success", "skip", "failed"].includes(String(status || "")) ? String(status) : statusFromShadowEvent(eventType);
  const safeRoute = safeMetricIdentifier(route || routeFromShadowEvent(eventType), 80);
  const safeSource = safeMetricIdentifier(source || "hoshiaclaw", 80) || "hoshiaclaw";
  const safeReason = safeMetricReason(reason || safeStatus || "shadow_metric");
  const metricEventId = `shadow_${safeRoute || "shadow"}_${nanoid(10)}`;
  observabilityCounters.shadow[safeStatus] = Number(observabilityCounters.shadow[safeStatus] || 0) + 1;
  recordRouteObservation(observabilityCounters, safeRoute, safeStatus);
  return appendCharacterEvent({
    id: metricEventId,
    idempotency_key: `${config.roomId}:${eventType}:${metricEventId}`,
    event_type: eventType,
    actor_type: "system",
    source_kind: "hoshiaclaw",
    source_id: metricEventId,
    public_hint: `HoshiaClaw ${safeRoute || "shadow"} ${safeStatus}`,
    private_hint: `HoshiaClaw ${safeRoute || "shadow"} ${safeStatus}`,
    reason: safeReason,
    data: {
      status: safeStatus,
      source_type: safeSource,
      route: safeRoute,
      ...(postId ? { post_id: safeMetricIdentifier(postId, 80) } : {}),
      ...(commentId ? { comment_id: safeMetricIdentifier(commentId, 80) } : {})
    }
  });
}

function recordAiProviderObservation(reply = {}) {
  recordAiProviderObservationCounter(observabilityCounters, reply);
}

function recordEventLogSnapshotFallback(snapshot) {
  observabilityCounters.eventLogFallback += 1;
  return snapshot;
}

function statusFromShadowEvent(eventType = "") {
  if (String(eventType).endsWith(".success")) return "success";
  if (String(eventType).endsWith(".skip")) return "skip";
  return "failed";
}

function routeFromShadowEvent(eventType = "") {
  const text = String(eventType || "");
  if (text.includes(".proactive_shadow.")) return "proactive_idle_shadow";
  if (text.includes(".proactive_live.")) return "proactive_idle_live";
  if (text.includes(".comment_reply_shadow.")) return "post_comment_reply_shadow";
  if (text.includes(".daily_post_shadow.")) return "daily_post_shadow";
  if (text.includes(".news_topic_generate_shadow.")) return "news_topic_generate_shadow";
  return "shadow";
}

function shadowSession(session = null) {
  return session || {
    user_id: "room",
    username: "room",
    nickname: "Live room",
    room_id: config.roomId
  };
}

function safeMetricIdentifier(value, maxLength = 80) {
  const text = String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLength);
  if (!text || hasSensitiveMetricMarker(text)) return "";
  return text;
}

function safeMetricReason(value, fallback = "shadow_metric") {
  const text = safeMetricIdentifier(value, 80);
  return text || fallback;
}

function hasSensitiveMetricMarker(value) {
  return /(?:token|secret|bearer|\.env|ssh|cloudflared|trycloudflare|https?:\/\/|localhost|127\.0\.0\.1|0\.0\.0\.0|[A-Za-z]:[\\/]|\/home\/|\/root\/|\/users\/|\/var\/|\/etc\/|internal|raw[_-]?(?:prompt|response)|candidate[_-]?text)/i.test(String(value || ""));
}

function safeRevision() {
  return pickRuntimeRevision([
    process.env.SOURCE_REVISION,
    readRevisionFile(),
    process.env.REVISION
  ], (value) => safeMetricIdentifier(value, 40));
}

let cachedRevisionFileValue = null;
function readRevisionFile() {
  if (cachedRevisionFileValue !== null) return cachedRevisionFileValue;
  try {
    cachedRevisionFileValue = readFileSync(new URL("../REVISION", import.meta.url), "utf8").trim();
  } catch {
    cachedRevisionFileValue = "";
  }
  return cachedRevisionFileValue;
}

function safeRuntimeModes() {
  return {
    ai_mode: ["mock", "astrbot", "hoshiaclaw"].includes(config.aiMode) ? config.aiMode : "unknown",
    character_state_authority: ["legacy", "event_log"].includes(config.characterStateAuthority) ? config.characterStateAuthority : "legacy",
    comment_reply_rollout_mode: ["live", "shadow", "off"].includes(config.hoshiaCommentReplyRolloutMode) ? config.hoshiaCommentReplyRolloutMode : "live",
    proactive_shadow_enabled: Boolean(config.hoshiaClawProactiveShadowEnabled),
    proactive_live_enabled: Boolean(config.hoshiaClawProactiveLiveEnabled),
    proactive_live_percent: Math.max(0, Math.min(100, Number(config.hoshiaClawProactiveLivePercent || 0))),
    daily_post_shadow_enabled: Boolean(config.hoshiaClawDailyPostShadowEnabled),
    news_topic_shadow_enabled: Boolean(config.hoshiaClawNewsTopicGenerateShadowEnabled),
    daily_post_live_enabled: Boolean(config.hoshiaClawDailyPostLiveEnabled),
    news_topic_live_enabled: Boolean(config.hoshiaClawNewsTopicLiveEnabled),
    daily_canon_live_enabled: Boolean(config.hoshiaClawDailyCanonLiveEnabled),
    daily_actual_diary_live_enabled: Boolean(config.hoshiaClawDailyActualDiaryLiveEnabled)
  };
}

function buildRuntimeObservability() {
  const snapshot = db.getLatestCharacterSnapshot?.({ roomId: config.roomId, characterId: "hoshia" });
  const ageMs = snapshot?.generated_at ? Math.max(0, Date.now() - Date.parse(snapshot.generated_at)) : null;
  return buildRuntimeObservabilitySnapshot({
    counters: observabilityCounters,
    moduleMemoryPending: typeof moduleEventStore.pendingMemorySize === "function" ? moduleEventStore.pendingMemorySize() : 0,
    characterSnapshotAgeMs: Number.isFinite(ageMs) ? ageMs : null
  });
}

function statusFromDailyPostTick(result = {}) {
  if (result?.post && result?.created) return "success";
  if (String(result?.status || "") === "failed") return "failed";
  if (String(result?.reason || "").includes("failed")) return "failed";
  return "skip";
}
function updateHoshiaVisualState({ body = {}, session = null, reason = "" } = {}) {
  if (typeof body.text === "string") {
    return hoshiaVisualStateService.applyUserInteraction({
      text: body.text,
      session
    });
  }
  const payload = {
    mood: body.mood,
    activity: body.activity,
    energy: body.energy,
    social_need: body.social_need ?? body.socialNeed,
    state_reason: body.state_reason ?? body.stateReason ?? reason
  };
  return hoshiaVisualStateService.update(payload, session);
}

function appendHoshiaNewsEvent({ eventType, session = null, summaryHint = "", data = {} } = {}) {
  if (!eventType || !summaryHint) return null;
  const occurredAt = new Date().toISOString();
  const moduleEvent = moduleEventStore.append({
    room_id: config.roomId,
    module_id: "hoshia_news",
    event_type: eventType,
    user_id: session?.user_id || "",
    nickname: session?.nickname || "",
    summary_hint: summaryHint,
    memory_eligible: false,
    memory_kind: "hoshia_news_event",
    retention_days: 7,
    occurred_at: occurredAt,
    data
  });
  appendCharacterEvent({
    event_type: eventType,
    actor_type: session?.user_id ? "user" : "system",
    user_id: session?.user_id || "",
    nickname: session?.nickname || "",
    source_kind: "hoshia_news",
    source_id: moduleEvent?.id || `${eventType}:${occurredAt}`,
    occurred_at: occurredAt,
    public_hint: summaryHint,
    private_hint: summaryHint,
    reason: data?.reason || eventType,
    data: {
      status: data?.status || "observed",
      source_type: data?.source_type || "hoshia_news",
      topic: data?.topic || data?.category || "",
      category: data?.category || ""
    }
  });
  return moduleEvent;
}

function selectCachedNewsTopicForPost() {
  if (!config.hoshiaNewsEnabled || !config.hoshiaNewsPostEnabled) return null;
  const limit = Math.max(1, Number(config.hoshiaNewsPostDailyLimit || 1));
  const summary = getHoshiaOpsSummary();
  if (Number(summary.news?.news_post_count_today || 0) >= limit) return null;
  const topic = hoshiaNewsService.featuredTopic?.()
    || hoshiaNewsService.getTopics().find((item) => item?.post_seed && item?.title && isSafeNewsTopicForPost(item))
    || null;
  if (!topic) return null;
  if (!isFreshNewsTopic(topic)) return null;
  return topic;
}

function applyNewsSignalFromTopic(topic, session = null, reason = "news_topic") {
  const signal = deriveNewsSignalFromTopic(topic, reason);
  if (!signal) return { accepted: false, reason: "news_signal_invalid", state: hoshiaVisualStateService.publicState() };
  const result = hoshiaVisualStateService.applyNewsSignal(signal);
  if (result.accepted) {
    appendHoshiaNewsEvent({
      eventType: "hoshia_news.signal_applied",
      session,
      summaryHint: `News signal nudged Hoshia toward ${signal.activity_hint || "current"} / ${signal.mood_hint || "current"}`,
      data: {
        status: "applied",
        reason: signal.reason || reason
      }
    });
  }
  return result;
}

function deriveNewsSignalFromTopic(topic, reason = "news_topic") {
  if (!topic || typeof topic !== "object") return null;
  const seed = [
    topic.title,
    topic.state_signal,
    topic.reaction_style,
    Array.isArray(topic.meme_hooks) ? topic.meme_hooks.join(" ") : "",
    Array.isArray(topic.reply_hooks) ? topic.reply_hooks.join(" ") : "",
    topic.post_seed,
    topic.category
  ].filter(Boolean).join(" ").toLowerCase();
  const activity = inferNewsActivity(seed, topic.category);
  const mood = inferNewsMood(seed, activity);
  const signal = {
    activity_hint: activity,
    mood_hint: mood,
    energy_delta: inferNewsEnergyDelta(seed, activity),
    social_need_delta: inferNewsSocialDelta(seed, activity),
    expires_at: new Date(Date.now() + Math.max(1, Number(config.hoshiaNewsSignalTtlHours || 6)) * 60 * 60 * 1000).toISOString(),
    reason: String(topic.state_signal || topic.reaction_style || reason || topic.title || "news topic").slice(0, 160)
  };
  if (!signal.activity_hint && !signal.mood_hint && signal.energy_delta === 0 && signal.social_need_delta === 0) {
    return null;
  }
  return signal;
}

function inferNewsActivity(seed, category) {
  const safeCategory = String(category || "").toLowerCase();
  if (safeCategory === "anime_game" || safeCategory === "light_trends") return "otaku";
  if (safeCategory === "music_movie" || safeCategory === "tech_tools") return "thinking";
  if (safeCategory === "sports_campus") return "sports";
  if (/(游戏|电竞|排位|rank|开黑|队友|fps|moba|手游)/i.test(seed) || /game|esport/i.test(category || "")) return "gaming";
  if (/(二次元|番剧|动漫|漫画|meme|梗图|接梗|玩梗|联动)/i.test(seed)) return "otaku";
  if (/(运动|健身|跑步|训练|锻炼|体测)/i.test(seed)) return "sports";
  if (/(ai|模型|工具|开源|代码|科技|产品|开发)/i.test(seed) || /tech|ai|product/i.test(category || "")) return "thinking";
  if (/(睡|困|晚|夜|熬夜|深夜|凌晨)/i.test(seed)) return "sleepy";
  if (/(emo|难过|低落|崩|烦|破防|压力|吵)/i.test(seed)) return "emo";
  if (/(开心|乐|搞笑|热梗|爆笑|离谱|好玩)/i.test(seed)) return "happy";
  return "";
}

function inferNewsMood(seed, activity) {
  if (/(破防|生气|烦|吵|骂|离谱)/i.test(seed)) return "annoyed";
  if (/(困|晚|夜|熬夜|累)/i.test(seed)) return "sleepy";
  if (/(emo|难过|低落|孤独)/i.test(seed)) return "lonely";
  if (/(梗|笑|乐|搞笑|有趣|离谱)/i.test(seed)) return activity === "otaku" ? "excited" : "playful";
  if (/(ai|工具|代码|模型|开源|计划)/i.test(seed)) return "focused";
  if (activity === "gaming") return /(破防|逆风|上分失败|输)/i.test(seed) ? "annoyed" : "competitive";
  if (activity === "sports") return /(累|疲|喘|恢复)/i.test(seed) ? "tired" : "energetic";
  if (activity === "sleepy") return "sleepy";
  if (activity === "emo") return "emo";
  if (activity === "thinking") return "thinking";
  return "";
}

function inferNewsEnergyDelta(seed, activity) {
  if (/(困|晚|夜|熬夜|累|疲)/i.test(seed)) return -6;
  if (/(热梗|好笑|开心|爽|破防)/i.test(seed)) return 3;
  if (activity === "thinking") return -2;
  if (activity === "gaming") return 1;
  if (activity === "sports") return 2;
  return 0;
}

function inferNewsSocialDelta(seed, activity) {
  if (/(梗|接话|弹幕|评论|群聊|互动)/i.test(seed)) return 4;
  if (/(孤独|emo|低落|安静|没人)/i.test(seed)) return 6;
  if (activity === "sleepy") return 2;
  if (activity === "thinking") return -1;
  return 1;
}

function stateForNewsTopicPost(baseState, topic) {
  const signal = deriveNewsSignalFromTopic(topic, "news_topic_post");
  if (!signal) return baseState;
  return {
    ...baseState,
    energy: clampInt(Number(baseState?.energy || 0) + signal.energy_delta, 0, 100, 70),
    social_need: clampInt(Number(baseState?.social_need || 0) + signal.social_need_delta, 0, 100, 50),
    activity: signal.activity_hint || baseState?.activity || "idle",
    mood: signal.mood_hint || baseState?.mood || "calm"
  };
}

function isFreshNewsTopic(topic) {
  if (!topic) return false;
  const createdAt = Date.parse(topic.created_at || topic.date || "");
  if (!Number.isFinite(createdAt)) return true;
  const maxAgeHours = Math.max(1, Number(config.hoshiaNewsTopicMaxAgeHours || 36));
  return Date.now() - createdAt <= maxAgeHours * 60 * 60 * 1000;
}

function isSafeNewsTopicForPost(topic) {
  const risk = String(topic?.risk_level || topic?.riskLevel || topic?.risk || "").toLowerCase();
  return topic?.high_risk !== true && !["high", "critical", "unsafe", "blocked", "danger"].includes(risk);
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function tickHoshiaVisualState({ reason = "scheduled visual refresh" } = {}) {
  const now = new Date();
  const canonEvent = hoshiaDailyCanonService.getActiveEvent({ now, create: true });
  return hoshiaVisualStateService.tick({ reason, now, canonEvent });
}

function stateReasonForPostSource(sourceType) {
  if (sourceType === "state_pulse") return "Hoshia wrote a state pulse timeline update";
  if (sourceType === "news_topic") return "Hoshia wrote a news topic timeline update";
  return "Hoshia wrote a daily timeline update";
}

function publicPostForViewer(postId, viewerUserId) {
  return publicPost(db.listHoshiaPosts({
    characterId: "hoshia",
    limit: 100,
    viewerUserId
  }).find((item) => item.id === postId) || {
    ...db.getHoshiaPost(postId),
    like_count: 0,
    comment_count: 0,
    liked_by_viewer: false,
    interactions: db.listHoshiaPostInteractions(postId)
  });
}

function sendToSession(userId, payload) {
  for (const [ws, session] of sockets.entries()) {
    if (session.user_id === userId && ws.readyState === WEB_SOCKET_OPEN) ws.send(JSON.stringify(payload));
  }
}

function markUserOnline(session) {
  const userId = session?.user_id;
  if (!userId) return;
  const current = activeUserConnections.get(userId);
  if (current) {
    current.count += 1;
    return;
  }
  activeUserConnections.set(userId, {
    count: 1,
    connectedAtMs: Date.now()
  });
}

function markUserOffline(session) {
  const userId = session?.user_id;
  if (!userId) return;
  const current = activeUserConnections.get(userId);
  if (!current) return;
  current.count -= 1;
  if (current.count > 0) return;

  activeUserConnections.delete(userId);
  const onlineSeconds = Math.floor((Date.now() - current.connectedAtMs) / 1000);
  db.addUserOnlineSeconds(userId, onlineSeconds);
}

function uniqueOnlineCount() {
  return activeUserConnections.size;
}

function audienceSummary() {
  return {
    online_count: uniqueOnlineCount(),
    registered_count: db.countUsers()
  };
}

function audiencePayload() {
  const now = Date.now();
  const users = db.listAudienceUsers().map((user) => {
    const active = activeUserConnections.get(user.id);
    const currentOnlineSeconds = active ? Math.max(0, Math.floor((now - active.connectedAtMs) / 1000)) : 0;
    return {
      user_id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar_url: user.avatar_url || "",
      danmaku_color: user.danmaku_color || "",
      online: Boolean(active),
      registered_at: user.created_at,
      last_login_at: user.last_login_at,
      total_online_seconds: Number(user.total_online_seconds || 0),
      current_online_seconds: currentOnlineSeconds
    };
  }).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const aRecent = Date.parse(a.last_login_at || a.registered_at || "") || 0;
    const bRecent = Date.parse(b.last_login_at || b.registered_at || "") || 0;
    if (aRecent !== bRecent) return bRecent - aRecent;
    return a.nickname.localeCompare(b.nickname);
  });

  return {
    ok: true,
    ...audienceSummary(),
    users
  };
}

function broadcastAudienceChanged() {
  broadcast({
    type: "audience_changed",
    room_id: config.roomId,
    ...audienceSummary(),
    timestamp: new Date().toISOString()
  });
}

function publicSession(session) {
  return {
    user_id: session.user_id,
    username: session.username,
    nickname: session.nickname,
    avatar_url: session.avatar_url || "",
    danmaku_color: session.danmaku_color || "",
    room_id: session.room_id,
    onboarding_completed: session.onboarding_completed !== false,
    ai_profile: normalizeStoredAiProfile(session.ai_profile)
  };
}

function roomInfo() {
  return {
    room_id: config.roomId,
    online: uniqueOnlineCount(),
    registered: db.countUsers(),
    private: true,
    websocket_auth: true
  };
}

function sessionKey(id) {
  return `live-room:session:${id}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSessionForUser(user) {
  const sessionId = newSessionId();
  const session = sessionFromUser(user);
  await saveSession(sessionId, session);
  return { sessionId, user: session };
}

function sessionFromUser(user, createdAt = new Date().toISOString()) {
  return {
    user_id: user.id,
    username: user.username,
    nickname: user.nickname,
    avatar_url: user.avatar_url || "",
    danmaku_color: user.danmaku_color || "",
    last_login_at: user.last_login_at || "",
    total_online_seconds: Number(user.total_online_seconds || 0),
    room_id: config.roomId,
    onboarding_completed: Boolean(user.onboarding_completed),
    ai_profile: parseAiProfileJson(user.ai_profile_json),
    created_at: createdAt
  };
}

async function saveSession(sessionId, session) {
  await store.setex(sessionKey(sessionId), config.sessionTtlSeconds, JSON.stringify(session));
}

function refreshSocketSessions(nextSession) {
  for (const [ws, session] of sockets.entries()) {
    if (session.user_id === nextSession.user_id) {
      sockets.set(ws, { ...session, ...nextSession });
    }
  }
}

async function createStore() {
  const redis = new Redis(config.redisUrl, { lazyConnect: true });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    return redis;
  } catch (error) {
    console.warn("redis_unavailable_using_memory_store", {
      url: config.redisUrl,
      message: error.message
    });
    redis.disconnect();
    return new MemoryStore();
  }
}

server.listen(config.port, () => {
  console.log(`live-room-gateway listening on ${config.port}`);
});
