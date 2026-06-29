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
import { createLiveReplyBroadcaster } from "./live-reply-broadcast.js";
import {
  normalizeOnboardingProfile,
  normalizeStoredAiProfile,
  parseAiProfileJson
} from "./ai-profile.js";
import { createProactiveLiveRoomController } from "./proactive-live-room-controller.js";
import { createHoshiaInteractionController } from "./hoshia-interaction-controller.js";
import { createRuntimeHealthReporter } from "./runtime-health-reporter.js";
import {
  createLiveAiReplyController,
  replyTargetsForBatch,
  roomAiSessionForBatch
} from "./live-ai-reply-controller.js";
import { createHoshiaDailyOpsController } from "./hoshia-daily-ops-controller.js";

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
// Lightweight accessor for the current visual state {mood, energy, activity}.
// Used by controllers that only need the visual snapshot (not the full character
// snapshot). Declared as a function so it always reads live state.
function currentCharacterState() {
  return hoshiaVisualStateService.publicState();
}
const hoshiaLifeMemoryService = createHoshiaLifeMemoryService({ db });
const hoshiaNewsService = createHoshiaNewsService(config, { fetchImpl: globalThis.fetch });
const hoshiaInterestSystem = createHoshiaInterestSystem({
  lifeMemoryService: hoshiaLifeMemoryService,
  timeZone: config.realityContextTimezone || "Asia/Shanghai"
});
const hoshiaInterestKnowledgeService = createHoshiaInterestKnowledgeService();
let hoshiaDailyOpsController = null;
let hoshiaInteractionController = null;
async function generateDailyCanonPlanLive(options = {}) {
  return hoshiaDailyOpsController?.generateDailyCanonPlanLive(options) ?? null;
}
async function generateActualDiaryLive(options = {}) {
  return hoshiaDailyOpsController?.generateActualDiaryLive(options) ?? null;
}
async function generatePostCommentReply(options = {}) {
  return hoshiaInteractionController?.generatePostCommentReply(options) ?? null;
}
async function generatePostCommentReplyShadow(options = {}) {
  return hoshiaInteractionController?.generatePostCommentReplyShadow(options) ?? null;
}
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
const replyTargets = (batch) => replyTargetsForBatch(batch, maxReplyTargets);
const roomAiSession = (batch) => roomAiSessionForBatch(batch, config.roomId);
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
  recordShadowMetricEvent,
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
const proactiveReplyState = createProactiveReplyState();
const proactiveLiveRoomController = createProactiveLiveRoomController({
  activeUserConnections,
  appendCharacterEvent,
  audiencePayload,
  broadcast,
  broadcastAiReplyDone,
  buildCurrentCharacterSnapshot,
  currentCharacterState,
  buildHostLifeContext,
  buildModuleContext,
  buildProactiveLiveMetadata,
  buildProactiveLivePrompt,
  config,
  db,
  fetchImpl: globalThis.fetch,
  generateAiReply,
  // Lazy: liveAiReplyController is constructed below (line ~463), but this
  // closure only runs when the proactive timer fires (async, well after
  // module init), so the const is initialized by then.
  getPendingReplyCount: () => liveAiReplyController.getPendingReplyCount(),
  getReplyBatchRunning: () => liveAiReplyController.getReplyBatchRunning(),
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
  uniqueOnlineCount,
  webSocketOpen: WEB_SOCKET_OPEN
  });
  const { scheduleProactiveReplyCheck } = proactiveLiveRoomController;

const liveAiReplyController = createLiveAiReplyController({
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
  hoshiaNewsService,
  hoshiaVisualStateService,
  maxReplyBatchSize,
  maxReplyTargets,
  mentionReplyWindowMs,
  messageEvent,
  moduleEventStore,
  moduleProviders,
  observabilityCounters,
  recordAiProviderObservation,
  recordModuleMemoryEventsSafely,
  replyBatchWindowMs,
  roomInfo,
  scheduleProactiveReplyCheck,
  setCharacterState,
  singleUserReplyDelayMs,
  fastReplyBatchWindowMs,
  quickReplyLeadDelayMs,
  storeMessage,
  summarizeLiveRoomContext,
  sleep,
  uniqueOnlineCount
});
const { enqueueAiReply, getPendingReplyCount } = liveAiReplyController;

hoshiaInteractionController = createHoshiaInteractionController({
  activeUserConnections,
  appendCharacterEvent,
  appendTimelineCommentReplyCharacterEvent,
  appendVisualStateChangedCharacterEvent,
  audiencePayload,
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
  fetchImpl: globalThis.fetch,
  generateAiReply,
  hoshiaCommentReplyService,
  hoshiaDailyCanonService,
  hoshiaInterestSystem,
  newsService: hoshiaNewsService,
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
  roomInfo,
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
  runCommentReplyTick,
  scheduleCommentReplyTick,
  scheduleWelcomeGreeting
} = hoshiaInteractionController;
const hoshiaVisualTickWindow = normalizeHoshiaTickWindow(
  config.hoshiaStateTickMinMinutes,
  config.hoshiaStateTickMaxMinutes
);
hoshiaDailyOpsController = createHoshiaDailyOpsController({
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
  updateHoshiaVisualState
});
const {
  clearDailyOpsTimers,
  getHoshiaOpsSummary,
  runDailyPostTick,
  scheduleHoshiaNewsTopicSync,
  scheduleNextHoshiaVisualTick
} = hoshiaDailyOpsController;
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
    clearDailyOpsTimers();
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
