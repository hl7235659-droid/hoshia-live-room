import express from "express";
import http from "node:http";
import Redis from "ioredis";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { openLiveRoomDatabase } from "./database.js";
import { attachLiveRoomWebSocket, WEB_SOCKET_OPEN } from "./live-room-websocket.js";
import { registerAccountRoutes } from "./account-routes.js";
import { registerPixelGameRoutes } from "./game-routes.js";
import { createHoshiaPixelGameService } from "./game-service.js";
import { generateAiReply, summarizeLiveRoomContext } from "./ai-adapter.js";
import { isValidState, nextCharacterState } from "./state-machine.js";
import { buildRealityContext } from "./reality-context.js";
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
import { createHoshiaLifeMemoryService } from "./hoshia-life-memory.js";
import { createHoshiaNewsService } from "./hoshia-news-service.js";
import { createHoshiaCommentReplyService } from "./hoshia-comment-reply.js";
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
import { MusicService, parseMusicRequestText } from "./music-service.js";
import { createLiveRoomEventFormatter, friendlyMusicError } from "./live-room-formatters.js";
import { createMusicDanmakuController } from "./music-danmaku-controller.js";
import { registerMusicRoutes } from "./music-routes.js";
import { registerHoshiaRoutes } from "./hoshia-routes.js";
import { createSessionAudienceController } from "./session-audience.js";
import {
  createCharacterEventWriter,
  safeMetricIdentifier,
  safeMetricReason
} from "./character-event-writer.js";
import { createHoshiaVisualNewsHelpers } from "./hoshia-visual-news-helpers.js";
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
  createRuntimeObservabilityCounters,
  recordAiProviderObservation as recordAiProviderObservationCounter,
  recordRouteObservation,
  routeStatusFromCounts
} from "./hoshia-runtime-observability.js";
import {
  buildCharacterSnapshot,
  summarizeCharacterSnapshotForPrompt
} from "./character-snapshot.js";
import { projectCharacterEvent } from "./character-event-projector.js";
import {
  buildHoshiaReplyMetadata,
  buildShortTermAiContext,
  contextPayloadMessage as centerContextPayloadMessage,
  prepareHoshiaCenterContext
} from "./hoshia-center-context.js";
import { createLiveReplyBroadcaster } from "./live-reply-broadcast.js";
import {
  normalizeOnboardingProfile,
  normalizeStoredAiProfile,
  parseAiProfileJson,
  replyStyleLabel
} from "./ai-profile.js";
import { createProactiveLiveRoomController } from "./proactive-live-room-controller.js";
import { createHoshiaInteractionController } from "./hoshia-interaction-controller.js";
import { createRuntimeHealthReporter } from "./runtime-health-reporter.js";

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
const sessionAudienceController = createSessionAudienceController({
  config,
  db,
  store,
  sockets,
  activeUserConnections,
  webSocketOpen: WEB_SOCKET_OPEN,
  broadcast,
  normalizeStoredAiProfile,
  parseAiProfileJson
});
const {
  audiencePayload,
  broadcastAudienceChanged,
  createSessionForUser,
  getSessionIdFromReq,
  loadSessionFromReq,
  markUserOffline,
  markUserOnline,
  publicSession,
  refreshSocketSessions,
  requireSession,
  roomInfo,
  saveSession,
  sendToSession,
  sessionFromUser,
  uniqueOnlineCount
} = sessionAudienceController;
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
const observabilityCounters = createRuntimeObservabilityCounters();
const characterEventWriter = createCharacterEventWriter({
  config,
  db,
  hoshiaLifeMemoryService,
  observabilityCounters,
  recordRouteObservation
});
const {
  appendCharacterEvent,
  appendMusicControlCharacterEvent,
  appendMusicSongRequestedCharacterEvent,
  appendTimelineCommentReplyCharacterEvent,
  appendTimelinePostCreatedCharacterEvent,
  appendVisualStateChangedCharacterEvent,
  recordCommentReplyShadowMetric,
  recordDailyPostLiveMetric,
  recordModuleMemoryEventsSafely,
  recordProactiveLiveMetric,
  recordProactiveShadowMetric
} = characterEventWriter;
const hoshiaVisualNewsHelpers = createHoshiaVisualNewsHelpers({
  config,
  db,
  hoshiaVisualStateService,
  moduleEventStore,
  createHoshiaVisualStateChangedEvent,
  appendVisualStateChangedCharacterEvent,
  hoshiaNewsService
});
const {
  appendHoshiaNewsEvent,
  applyNewsSignalFromTopic,
  publicPostForViewer,
  selectCachedNewsTopicForPost,
  stateForNewsTopicPost,
  statusFromDailyPostTick,
  tickHoshiaVisualState,
  updateHoshiaVisualState,
  isFreshNewsTopic,
  isSafeNewsTopicForPost,
  stateReasonForPostSource
} = hoshiaVisualNewsHelpers;


const liveReplyBroadcaster = createLiveReplyBroadcaster({
  roomId: config.roomId,
  createId: () => nanoid(8),
  broadcast,
  broadcastHoshiaPresentation,
  normalizeHoshiaPresentation,
  replyTargets,
  sleep,
  now: () => new Date(),
  performanceNow: () => performance.now()
});
const {
  broadcastAiReplyPending,
  broadcastAiReplyDelta,
  createSentenceStreamEmitter,
  broadcastProgressiveReplyDeltas,
  broadcastAiReplyDone,
  buildGatewayLatencyBreakdown
} = liveReplyBroadcaster;
const musicDanmakuController = createMusicDanmakuController({
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
  fetchImpl: globalThis.fetch
});
const { handleMusicRequestFromDanmaku, handleNaturalMusicIntentFromDanmaku } = musicDanmakuController;
let replyBatchTimer = null;
let replyBatchRunning = false;
const proactiveReplyState = createProactiveReplyState();
const proactiveLiveRoomController = createProactiveLiveRoomController({
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
  fetchImpl: globalThis.fetch,
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
  webSocketOpen: WEB_SOCKET_OPEN
});
const { scheduleProactiveReplyCheck } = proactiveLiveRoomController;

const hoshiaInteractionController = createHoshiaInteractionController({
  appendCharacterEvent,
  appendTimelineCommentReplyCharacterEvent,
  appendVisualStateChangedCharacterEvent,
  broadcast,
  broadcastHoshiaState,
  buildModuleContext,
  buildWelcomeGreetingPrompt,
  config,
  createHoshiaVisualStateChangedEvent,
  db,
  fallbackWelcomeGreeting,
  fetchImpl: globalThis.fetch,
  generateAiReply,
  hoshiaCommentReplyService,
  hoshiaPersonaPrompt,
  hoshiaVisualStateService,
  isValidState,
  messageEvent,
  moduleEventStore,
  moduleProviders,
  normalizeHoshiaPresentation,
  normalizeStoredAiProfile,
  presentationFromClawEnvelope,
  quickReplyLead,
  recordAiProviderObservation,
  recordCommentReplyShadowMetric,
  recordRouteObservation,
  roomAiSession,
  routeStatusFromCounts,
  scheduleProactiveReplyCheck,
  setCharacterState,
  shouldScheduleWelcomeGreeting,
  store,
  storeMessage,
  welcomeCooldownKey,
  welcomeInflightKey
});
const {
  clearCommentReplyTimer,
  generateGameReport,
  generatePostCommentReply,
  generatePostCommentReplyShadow,
  runCommentReplyTick,
  scheduleCommentReplyTick,
  scheduleWelcomeGreeting
} = hoshiaInteractionController;
const hoshiaVisualTickWindow = normalizeHoshiaTickWindow(
  config.hoshiaStateTickMinMinutes,
  config.hoshiaStateTickMaxMinutes
);
let hoshiaVisualTickTimer = null;
let hoshiaNewsTopicSyncTimer = null;
let currentHoshiaPresentation = null;


const runtimeHealthReporter = createRuntimeHealthReporter({
  config,
  db,
  moduleEventStore,
  observabilityCounters
});
const { buildRuntimeObservability, safeRevision, safeRuntimeModes } = runtimeHealthReporter;
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

registerHoshiaRoutes(app, {
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
});

registerMusicRoutes(app, {
  config,
  musicService,
  moduleEventStore,
  requireSession,
  createMusicSongRequestedEvent,
  createMusicControlEvent,
  normalizeStoredAiProfile,
  appendMusicSongRequestedCharacterEvent,
  appendMusicControlCharacterEvent,
  broadcastMusicState,
  broadcastSystemText
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
    clearCommentReplyTimer();
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

function recordAiProviderObservation(reply = {}) {
  recordAiProviderObservationCounter(observabilityCounters, reply);
}

function recordEventLogSnapshotFallback(snapshot) {
  observabilityCounters.eventLogFallback += 1;
  return snapshot;
}

function shadowSession(session = null) {
  return session || {
    user_id: "room",
    username: "room",
    nickname: "Live room",
    room_id: config.roomId
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
