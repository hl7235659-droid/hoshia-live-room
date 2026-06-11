import express from "express";
import http from "node:http";
import cookie from "cookie";
import Redis from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { DatabaseError, openLiveRoomDatabase, normalizeUsername } from "./database.js";
import {
  cookieName,
  decodeSessionCookie,
  encodeSessionCookie,
  gateCookieName,
  hashAccessCode,
  hashPassword,
  newSessionId,
  verifyAccessCode,
  verifyPassword
} from "./security.js";
import { generateAiReply, recognizeMusicIntent, summarizeLiveRoomContext } from "./ai-adapter.js";
import { isValidState, nextCharacterState } from "./state-machine.js";
import { buildRealityContext } from "./reality-context.js";
import { buildHostLifeContext } from "./host-life-context.js";
import { hoshiaPersonaPrompt } from "./hoshia-persona.js";
import {
  buildModuleContext,
  createHoshiaCommentReplyEvent,
  createHoshiaInterestModuleProvider,
  createHoshiaLifeModuleProvider,
  createHoshiaPostCreatedEvent,
  createHoshiaNewsModuleProvider,
  createHoshiaVisualModuleProvider,
  createHoshiaVisualStateChangedEvent,
  createMusicModuleProvider,
  createModuleEventStore,
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
import { createHoshiaCommentReplyService } from "./hoshia-comment-reply.js";
import { createHoshiaDailyPostService } from "./hoshia-daily-post.js";
import { createHoshiaInterestSystem } from "./hoshia-interest-system.js";
import { createHoshiaDailyCanonService } from "./hoshia-daily-canon.js";
import { buildHoshiaOpsSummary } from "./hoshia-ops-summary.js";
import {
  createProactiveReplyState,
  markUserActivityForProactive,
  nextProactiveDelayMs,
  rememberProactiveReply,
  shouldRunProactiveReply
} from "./proactive-reply.js";
import { MusicService, parseLocalMusicControlText, parseMusicRequestText } from "./music-service.js";
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
const hoshiaDailyCanonService = createHoshiaDailyCanonService({
  db,
  timeZone: config.realityContextTimezone || "Asia/Shanghai"
});
const moduleEventStore = createModuleEventStore({ maxEvents: 120 });
const hoshiaCommentReplyService = createHoshiaCommentReplyService({
  db,
  lifeMemoryService: hoshiaLifeMemoryService,
  moduleEventStore,
  aiReplyGenerator: generatePostCommentReply,
  visualStateProvider: () => hoshiaVisualStateService.publicState(),
  moduleContextProvider: ({ session }) => buildModuleContext({ providers: moduleProviders, session }),
  moduleEventsProvider: () => moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 }),
  config,
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
  createHoshiaNewsModuleProvider(hoshiaNewsService)
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

app.use(express.json({ limit: "32kb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "live-room-dev", room_id: config.roomId, state: characterState });
});

app.get("/api/room/preview", (_req, res) => {
  res.json({
    ok: true,
    room: {
      room_id: config.roomId,
      online: uniqueOnlineCount(),
      registered: db.countUsers(),
      private: true
    }
  });
});

app.get("/api/auth/gate", (req, res) => {
  res.json({ ok: true, passed: hasGateAccess(req) });
});

app.post("/api/auth/gate", (req, res) => {
  const roomToken = String(req.body?.roomToken || "");
  if (!config.roomTokenHashes.length || !verifyAccessCode(roomToken, config.roomTokenHashes)) {
    return res.status(403).json({ error: "invalid_room_token" });
  }

  setGateCookie(res);
  res.json({ ok: true, passed: true });
});

app.post("/api/auth/register", async (req, res) => {
  const username = String(req.body?.username || "").trim().slice(0, 48);
  const nickname = username.slice(0, 32);
  const password = String(req.body?.password || "");
  const registrationCode = String(req.body?.registrationCode || "");

  if (!hasGateAccess(req)) {
    return res.status(403).json({ error: "gate_required" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "username_invalid" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "password_invalid" });
  }
  if (config.allowedNicknames.length && !config.allowedNicknames.includes(nickname)) {
    return res.status(403).json({ error: "nickname_not_allowed" });
  }

  let user;
  try {
    user = db.createUserWithRegistrationCode({
      registrationCodeHash: hashAccessCode(registrationCode),
      user: {
        id: nanoid(12),
        username,
        passwordHash: hashPassword(password),
        nickname
      }
    });
  } catch (error) {
    if (error instanceof DatabaseError) {
      return res.status(error.code === "username_taken" ? 409 : 403).json({ error: error.code });
    }
    throw error;
  }

  res.status(201).json({
    ok: true,
    user: {
      user_id: user.id,
      nickname: user.nickname,
      room_id: config.roomId
    }
  });
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!hasGateAccess(req)) {
    return res.status(403).json({ error: "gate_required" });
  }

  const user = db.findUserByUsername(username);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(403).json({ error: "invalid_credentials" });
  }

  db.updateLastLogin(user.id);
  const session = await createSessionForUser(user);
  setSessionCookie(res, session.sessionId);
  res.json({ ok: true, user: publicSession(session.user) });
});

app.post("/api/auth/logout", async (req, res) => {
  const sessionId = getSessionIdFromReq(req);
  if (sessionId) await store.del(sessionKey(sessionId));
  res.setHeader("Set-Cookie", cookie.serialize(cookieName, "", { path: "/", maxAge: 0 }));
  res.json({ ok: true });
});

app.get("/api/auth/me", requireSession, (req, res) => {
  res.json({ ok: true, user: publicSession(req.session), room: roomInfo() });
});

app.patch("/api/account/profile", requireSession, async (req, res) => {
  const nickname = String(req.body?.nickname || "").trim().slice(0, 32);
  const avatarUrl = String(req.body?.avatarUrl ?? req.body?.avatar_url ?? "").trim();
  const danmakuColor = normalizeDanmakuColor(req.body?.danmakuColor ?? req.body?.danmaku_color ?? "");

  if (!isValidNickname(nickname)) {
    return res.status(400).json({ error: "nickname_invalid" });
  }
  if (!isValidAvatarUrl(avatarUrl)) {
    return res.status(400).json({ error: "avatar_url_invalid" });
  }
  if (danmakuColor === null) {
    return res.status(400).json({ error: "danmaku_color_invalid" });
  }

  const user = db.updateUserProfile(req.session.user_id, { nickname, avatarUrl, danmakuColor });
  if (!user) return res.status(404).json({ error: "user_not_found" });

  const nextSession = {
    ...req.session,
    username: user.username,
    nickname: user.nickname,
    avatar_url: user.avatar_url || "",
    danmaku_color: user.danmaku_color || ""
  };
  await saveSession(req.sessionId, nextSession);
  refreshSocketSessions(nextSession);
  broadcastAudienceChanged();

  res.json({ ok: true, user: publicSession(nextSession) });
});

app.post("/api/account/onboarding", requireSession, async (req, res) => {
  const profile = normalizeOnboardingProfile(req.body, req.session);
  if (profile === null) {
    return res.status(400).json({ error: "onboarding_invalid" });
  }

  const user = db.completeUserOnboarding(req.session.user_id, profile.memory_enabled ? profile : null);
  if (!user) return res.status(404).json({ error: "user_not_found" });

  const nextSession = sessionFromUser(user, req.session.created_at);
  await saveSession(req.sessionId, nextSession);
  refreshSocketSessions(nextSession);
  if (shouldScheduleWelcomeGreeting(nextSession, false) && activeUserConnections.has(nextSession.user_id)) {
    scheduleWelcomeGreeting(nextSession);
  }

  res.json({ ok: true, user: publicSession(nextSession) });
});

app.post("/api/account/password", requireSession, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const nextPassword = String(req.body?.nextPassword || "");
  const user = db.findUserById(req.session.user_id);

  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return res.status(403).json({ error: "current_password_invalid" });
  }
  if (!isValidPassword(nextPassword)) {
    return res.status(400).json({ error: "password_invalid" });
  }

  db.updateUserPassword(user.id, hashPassword(nextPassword));
  res.json({ ok: true });
});

app.get("/api/room/state", requireSession, async (_req, res) => {
  const recent = db.listRecentRoomMessages(config.roomId, 100);
  res.json({
    room: roomInfo(),
    state: characterState,
    hoshia_state: hoshiaVisualStateService.publicState(),
    messages: recent
  });
});

app.get("/api/hoshia/state", requireSession, async (_req, res) => {
  res.json({
    ok: true,
    state: hoshiaVisualStateService.publicState()
  });
});

app.get("/api/hoshia/ops/summary", requireSession, async (_req, res) => {
  res.json({
    ok: true,
    summary: getHoshiaOpsSummary()
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
  const result = updateHoshiaVisualState({
    body: {
      mood: post.mood,
      activity: post.activity,
      state_reason: `Hoshia posted a ${post.activity || "daily"} update`
    },
    session: req.session,
    reason: "Hoshia posted an update"
  });
  if (result.changed) broadcastHoshiaState(result.state);
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
    if (visualUpdate.changed) broadcastHoshiaState(visualUpdate.state);
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
  const replyFields = config.hoshiaAsyncCommentReplyEnabled
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
    scheduleCommentReplyTick();
  }
  const visualUpdate = hoshiaVisualStateService.applyUserInteraction({
    text: input.content,
    session: req.session
  });
  if (visualUpdate.changed) broadcastHoshiaState(visualUpdate.state);
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
    force: req.body?.force === true
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
  const result = runDailyPostTick({
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

app.get("/api/room/audience", requireSession, async (_req, res) => {
  res.json(audiencePayload());
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
  await broadcastSystemText(`♪ ${req.session.nickname} 点歌《${result.track.title}》已加入播放。`);
  broadcastMusicState(req.session);
  res.json(result);
});

app.post("/api/music/control", requireSession, async (req, res) => {
  const result = musicService.control(req.body?.action, req.session, req.body || {});
  broadcastMusicState(req.session);
  if (!result.ok) return res.status(musicStatusCode(result.error)).json(result);
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

const wss = new WebSocketServer({ noServer: true });
const websocketHeartbeatIntervalMs = 25000;

server.on("upgrade", async (req, socket, head) => {
  if (new URL(req.url, "http://localhost").pathname !== "/ws/live") {
    socket.destroy();
    return;
  }

  const session = await loadSessionFromReq(req);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, session);
  });
});

wss.on("connection", (ws, _req, session) => {
  ws.isAlive = true;
  sockets.set(ws, session);
  const alreadyOnline = activeUserConnections.has(session.user_id);
  markUserOnline(session);
  broadcast(systemEvent("presence", `${session.nickname} joined`, { online: uniqueOnlineCount() }));
  broadcastAudienceChanged();
  ws.send(JSON.stringify({
    type: "room_state",
    room: roomInfo(),
    state: characterState,
    hoshia_state: hoshiaVisualStateService.publicState(),
    messages: db.listRecentRoomMessages(config.roomId, 100)
  }));
  ws.send(JSON.stringify({ type: "music_state", ...musicService.publicState(session) }));
  ws.send(JSON.stringify({
    type: "hoshia_state",
    room_id: config.roomId,
    state: hoshiaVisualStateService.publicState(),
    timestamp: new Date().toISOString()
  }));
  if (shouldScheduleWelcomeGreeting(session, alreadyOnline)) scheduleWelcomeGreeting(session);
  scheduleProactiveReplyCheck();

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    try {
      const payload = JSON.parse(raw.toString("utf8"));
      if (payload.type !== "danmaku") return;
      await handleDanmaku(session, payload);
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
    }
  });

  ws.on("close", () => {
    sockets.delete(ws);
    markUserOffline(session);
    broadcast(systemEvent("presence", `${session.nickname} left`, { online: uniqueOnlineCount() }));
    broadcastAudienceChanged();
    scheduleProactiveReplyCheck();
  });
});

const websocketHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, websocketHeartbeatIntervalMs);

function runScheduledHoshiaVisualTick() {
  hoshiaVisualTickTimer = null;
  hoshiaDailyCanonService.ensureTodayPlan();
  hoshiaDailyCanonService.ensureActualDiary();
  const result = tickHoshiaVisualState({
    reason: "scheduled visual state refresh"
  });
  if (result.changed) {
    moduleEventStore.append(createHoshiaVisualStateChangedEvent(result.state, null, {
      roomId: config.roomId,
      reason: result.reason,
      source: "scheduled_tick"
    }));
    broadcastHoshiaState(result.state);
  }
  runDailyPostTick({
    force: false,
    session: null,
    source: "scheduled_visual_tick"
  });
  scheduleNextHoshiaVisualTick();
}

function runDailyPostTick({ force = false, ignoreLimit = false, session = null, source = "scheduled", newsTopic = null } = {}) {
  hoshiaDailyCanonService.ensureTodayPlan();
  const selectedNewsTopic = newsTopic || selectCachedNewsTopicForPost();
  const newsState = selectedNewsTopic
    ? stateForNewsTopicPost(hoshiaVisualStateService.publicState(), selectedNewsTopic)
    : null;
  let result = hoshiaDailyPostService.tick({
    force,
    ignoreLimit,
    newsTopic: selectedNewsTopic,
    state: newsState
  });
  if (selectedNewsTopic && ["news_topic_invalid", "news_topic_daily_max_reached"].includes(result.reason)) {
    result = hoshiaDailyPostService.tick({ force, ignoreLimit });
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
      hoshiaDailyCanonService.ensureActualDiary();
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
  return result;
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

async function runCommentReplyTick({ limit = config.hoshiaCommentReplyTickLimit, force = false } = {}) {
  const result = await hoshiaCommentReplyService.processDueComments({ limit, force });
  if (result.processed_count > 0) {
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

async function generatePostCommentReply({
  post,
  comment,
  memoryPacket = [],
  visualState = null,
  moduleContext = [],
  moduleEvents = []
} = {}) {
  if (config.aiMode !== "astrbot") return "";
  const prompt = formatPostCommentReplyPrompt({ post, comment, memoryPacket, visualState });
  const reply = await generateAiReply({
    user_id: comment?.user_id || "post-comment-viewer",
    username: comment?.nickname || "viewer",
    nickname: comment?.nickname || "viewer",
    room_id: config.roomId
  }, prompt, config, globalThis.fetch, {
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
  return {
    content: String(reply.text).slice(0, 500),
    source: reply.source || "astrbot"
  };
}

function formatPostCommentReplyPrompt({ post, comment, memoryPacket = [], visualState = null } = {}) {
  const state = visualState || {};
  return [
    hoshiaPersonaPrompt,
    "You are Hoshia replying asynchronously under one of your own timeline posts.",
    "Write only one short natural reply from Hoshia. Do not include labels, JSON, system notes, file paths, tokens, internal URLs, or logs.",
    "Do not sound like customer support. Keep continuity with the post, the comment, and Hoshia's current mood.",
    `Post: ${String(post?.content || "").slice(0, 700)}`,
    `Post state: activity=${String(post?.activity || "")}; mood=${String(post?.mood || "")}`,
    `Viewer ${String(comment?.nickname || "viewer").slice(0, 32)} commented: ${String(comment?.content || "").slice(0, 500)}`,
    `Current Hoshia state: activity=${String(state.activity || "")}; mood=${String(state.mood || "")}; energy=${Number(state.energy || 0)}; social_need=${Number(state.social_need || 0)}; visual=${String(state.visual_description || "").slice(0, 220)}`,
    ...(Array.isArray(memoryPacket) && memoryPacket.length ? [
      ...memoryPacket,
      "Use these memories only for continuity. Do not reveal internal field names."
    ] : [])
  ].filter(Boolean).join("\n");
}

function scheduleCommentReplyTick(delayMs = 60000) {
  if (hoshiaCommentReplyTimer) clearTimeout(hoshiaCommentReplyTimer);
  if (!config.hoshiaAsyncCommentReplyEnabled) return;
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

wss.on("close", () => {
  clearInterval(websocketHeartbeat);
  if (hoshiaVisualTickTimer) clearTimeout(hoshiaVisualTickTimer);
  if (hoshiaCommentReplyTimer) clearTimeout(hoshiaCommentReplyTimer);
});

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
  if (config.aiMode !== "astrbot") return false;
  const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 });
  const intent = await recognizeMusicIntent(session, text, config, globalThis.fetch, {
    musicState,
    moduleEvents
  });
  if (!isActionableMusicIntent(intent)) return false;

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
    "A viewer has just successfully requested music. The gateway has already sent a system confirmation; now add one natural host reply.",
    ...(hostLifeContextLines.length ? [
      "Current Hoshia state context:",
      ...hostLifeContextLines
    ] : []),
    `Viewer nickname: ${session.nickname}`,
    `Viewer original message: ${String(originalText || "").slice(0, 120)}`,
    `Queued track(s):\n${trackLines}`,
    "Requirements:",
    `- Clearly convey that ${countText}, but do not mechanically repeat the system confirmation.`,
    "- Gently guess why they may want to hear it now, using uncertain wording such as maybe, feels like, or is it because; never claim certainty.",
    "- Keep Hoshia's slight selfhood: warm host reply, not a customer-service ticket response.",
    "- Do not mention internal APIs, URLs, queue IDs, cookies, QQ credentials, or provider details.",
    "- Reply in Chinese, exactly one sentence, at most 80 Chinese characters, warm and natural."
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
  const fullModuleContext = buildModuleContext({ providers: moduleProviders, session: batch[0]?.session });
  const fullModuleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: contextPolicy.moduleEventLimit });
  const moduleContext = moduleContextForRoute(fullModuleContext, contextPolicy, batch);
  const moduleEvents = moduleEventsForRoute(fullModuleEvents, contextPolicy);
  const activeContext = buildActiveContext({
    visualState: hoshiaVisualStateService.publicState(),
    audienceUsers: audiencePayload().users,
    moduleContext,
    moduleEvents,
    batch
  });
  const lifeMemoryPacket = contextPolicy.includeLifeMemory
    ? hoshiaLifeMemoryService.buildMemoryPacket({ batch, limit: contextPolicy.livingMemoryK || 3 })
    : [];
  const prompt = formatLiveRoomBatchPrompt(batch, lifeMemoryPacket, { activeContext, contextPolicy, moduleContext, moduleEvents });
  const shortTermContext = await buildShortTermAiContext(batch, contextPolicy);
  const moduleMemoryEvents = contextPolicy.consumeModuleMemoryEvents
    ? moduleEventStore.consumeMemoryEvents({ roomId: config.roomId, limit: 24 })
    : [];
  const contextLoadMs = Math.round(performance.now() - contextStartedAt);
  let streamedReply = false;
  let streamDeltaStarted = false;
  const reply = await generateAiReply(roomAiSession(batch), prompt, config, globalThis.fetch, {
    roomSession: true,
    replyTargets: replyTargets(batch),
    forceReply: batch.some((item) => item.forceReply),
    replyMode: batch.some((item) => item.forceReply) ? "single_user_direct" : "",
    replyRoute,
    activeContext,
    contextPolicy,
    latencyTraceId,
    recentContext: shortTermContext.recentContext,
    contextSummary: shortTermContext.contextSummary,
    moduleContext,
    moduleEvents,
    moduleMemoryEvents,
    onDelta: ({ text: deltaText, route: deltaRoute } = {}) => {
      if (!streamDeltaStarted) {
        streamDeltaStarted = true;
        clearQuickReplyLead(batch);
      }
      streamedReply = true;
      broadcastAiReplyDelta({
        traceId: latencyTraceId,
        route: deltaRoute || replyRoute,
        text: deltaText,
        deltaMode: "append",
        stage: "stream"
      });
    },
    messages: batch.map((item) => ({
      user_id: item.session.user_id,
      nickname: item.session.nickname,
      text: item.text,
      mentioned: item.mentioned,
      memory_enabled: normalizeStoredAiProfile(item.session.ai_profile)?.memory_enabled === true,
      timestamp: item.timestamp
    }))
  });
  if (reply.skipped) {
    clearQuickReplyLead(batch);
    moduleEventStore.restoreMemoryEvents(moduleMemoryEvents);
    broadcastAiReplyDone({ traceId: latencyTraceId, route: replyRoute, skipped: true });
    await setCharacterState("IDLE");
    scheduleProactiveReplyCheck();
    return;
  }
  if (moduleMemoryEvents.length && reply.source !== "astrbot") {
    moduleEventStore.restoreMemoryEvents(moduleMemoryEvents);
  }
  hoshiaInterestSystem.recordInteractionSignals({
    batch,
    moduleMemoryEvents: reply.source === "astrbot" ? moduleMemoryEvents : []
  });

  clearQuickReplyLead(batch);
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
  broadcast(aiMessage);
  broadcastAiReplyDone({ traceId: latencyTraceId, route: reply.route || replyRoute });
  await setCharacterState(isValidState(reply.state) ? reply.state : nextCharacterState("ai_reply", reply.text));
  setTimeout(() => void setCharacterState("IDLE"), 1400);
  scheduleProactiveReplyCheck();
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

  await sendProactiveIdleReply(decision.idleMs || 0);
}

async function sendProactiveIdleReply(idleMs) {
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
    const shortTermContext = await buildProactiveShortTermContext();
    const moduleContext = buildModuleContext({ providers: moduleProviders, session });
    const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 });
    const recentMessages = db
      .listRecentContextMessages(config.roomId, config.proactiveReply.contextMessages)
      .map(contextPayloadMessage);
    const prompt = formatProactiveIdlePrompt({
      session,
      idleMs,
      recentMessages,
      moduleContext,
      moduleEvents
    });

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

async function buildProactiveShortTermContext() {
  await refreshRoomContextSummary(config.roomId);
  const messages = db.listRecentContextMessages(config.roomId, config.proactiveReply.contextMessages);
  const summary = db.getRoomContextSummary(config.roomId);
  return {
    recentContext: messages.map(contextPayloadMessage),
    contextSummary: summary?.summary_text || ""
  };
}

function formatProactiveIdlePrompt({ session, idleMs, recentMessages, moduleContext, moduleEvents }) {
  const idleMinutes = Math.max(1, Math.round(Number(idleMs || 0) / 60000));
  const room = roomInfo();
  const realityContextLines = buildRealityContext({
    config,
    room,
    batch: [{
      session,
      text: "房间安静了一会儿",
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
      text: "房间安静了一会儿",
      mentioned: false,
      timestamp: new Date().toISOString()
    }],
    audienceUsers: audiencePayload().users,
    activeConnections: activeUserConnections,
    moduleContext,
    moduleEvents
  });
  const recentLines = recentMessages.slice(-config.proactiveReply.contextMessages).map((item, index) => {
    const speaker = item.role === "ai" ? "Hoshia" : (item.nickname || "viewer");
    return `[${index + 1}] ${speaker}: ${item.text}`;
  });
  const previousLines = proactiveReplyState.recentTexts.map((text, index) => `${index + 1}. ${text}`);

  return [
    hoshiaPersonaPrompt,
    "You are about to speak proactively in Hoshia Live Room because at least one viewer is online and the room has been quiet.",
    `The room has been quiet for about ${idleMinutes} minute(s).`,
    `Online viewers: ${room.online}.`,
    `Consecutive proactive messages without viewer response: ${proactiveReplyState.unansweredCount}.`,
    ...(realityContextLines.length ? realityContextLines : []),
    ...(hostLifeContextLines.length ? hostLifeContextLines : []),
    ...(previousLines.length ? [
      "Recent proactive messages from Hoshia; do not repeat their topic or structure:",
      ...previousLines
    ] : []),
    ...(recentLines.length ? [
      "Recent real room messages:",
      ...recentLines
    ] : ["Recent real room messages: none"]),
    "Task:",
    "- Write one natural proactive Hoshia line for the live room.",
    "- It must include one clear, easy-to-answer topic point.",
    "- You may softly ask what the viewer is doing, but never only ask that; attach a concrete topic hook.",
    "- Treat recent chat, music state, daily news topics, viewer memory, and current time atmosphere as equal candidate materials; choose the one most likely to invite a reply now.",
    "- If using news, turn it into a casual friend-room question. Do not sound like a news broadcast, do not repeat headlines, and avoid heavy or high-risk topics.",
    "- Do not say you detected silence, do not scold viewers, do not ask customer-service style questions.",
    "- Reply in Chinese, 1-2 short sentences, at most 90 Chinese characters. Output only Hoshia's line."
  ].join("\n");
}

function firstActiveSession() {
  for (const [ws, session] of sockets.entries()) {
    if (ws.readyState === WebSocket.OPEN && activeUserConnections.has(session.user_id)) return session;
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

async function buildShortTermAiContext(batch, contextPolicy = {}) {
  if (contextPolicy.refreshSummarySync) {
    await refreshRoomContextSummary(config.roomId);
  } else if (contextPolicy.includeContextSummary) {
    void refreshRoomContextSummary(config.roomId);
  }
  const maxMessages = positiveInt(contextPolicy.recentContextLimit || config.shortTermContextMaxMessages, 100, 1, 500);
  const fetchLimit = Math.min(Math.max(maxMessages * 2, maxMessages), 1000);
  const messages = db.listRecentContextMessages(config.roomId, fetchLimit);
  const focusedMessages = selectContextMessagesForBatch(messages, batch, maxMessages);
  const summary = db.getRoomContextSummary(config.roomId);
  return {
    recentContext: focusedMessages.map(contextPayloadMessage),
    contextSummary: contextPolicy.includeContextSummary ? summary?.summary_text || "" : ""
  };
}

function moduleContextForRoute(moduleContext = [], contextPolicy = {}, batch = []) {
  if (!contextPolicy.fastLane) return moduleContext;
  const allowed = new Set(["hoshia_visual_state", "hoshia_visual", "hoshia_interest_system"]);
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

async function refreshRoomContextSummary(roomId) {
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
      messages: toSummarize.map(contextPayloadMessage)
    }, globalThis.fetch);
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
    console.warn("context_summary_refresh_failed", {
      type: error.name || "Error",
      message: error.message
    });
  }
}

function selectContextMessagesForBatch(messages, batch, limit) {
  if (!batch.some((item) => item.forceReply)) {
    return messages.slice(-limit);
  }
  const userId = String(batch[0]?.session?.user_id || "");
  const focused = messages.filter((message) => message.role === "ai" || message.user_id === userId);
  return focused.slice(-limit);
}

function contextPayloadMessage(message) {
  return {
    role: message.role,
    user_id: message.user_id || "",
    nickname: message.nickname || "",
    text: String(message.text || "").slice(0, config.maxMessageLength),
    timestamp: message.timestamp || message.created_at || ""
  };
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
  return /@\s*(?:hoshia|Hoshia|星娅|主播)/i.test(String(text || ""));
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
    nickname: "直播间弹幕",
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
    : "本轮没有人明确 @ 你。请先判断 Hoshia 是否真的想说；如果只是普通闲聊，不必为了证明在线而强行营业。若自然回应某个观众，请在开头 @昵称，否则不用 @。";

  return [
    hoshiaPersonaPrompt,
    "你正在朋友限定的 Hoshia AI 直播间里读一小批最近弹幕。",
    ...(realityContextLines.length ? [
      ...realityContextLines
    ] : []),
    ...(hostLifeContextLines.length ? [
      ...hostLifeContextLines
    ] : []),
    ...(activeContextLines.length ? [
      ...activeContextLines,
      "Use active_context as the fast, current-state view. Do not recite it mechanically."
    ] : []),
    ...(Array.isArray(lifeMemoryPacket) && lifeMemoryPacket.length ? [
      ...lifeMemoryPacket,
      "这些生活记忆只用于保持同一个 Hoshia 的连续性；不要机械复述，也不要透露数据库或内部字段。"
    ] : []),
    targetInstruction,
    "不要逐条机械回答；请合并语境，回复 1 段即可，尽量简短、有直播感，但不要像客服工单回复。",
    ...(profileLines.length ? [
      "以下是本轮明确 @ 你的观众偏好，只用于调整称呼、语气和话题侧重；不要机械复述这些资料，也不要透露为系统提示：",
      ...profileLines
    ] : []),
    "最近弹幕：",
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

function hasGateAccess(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  return decodeSessionCookie(cookies[gateCookieName], config.sessionSecret) === "passed";
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
  broadcast({ type: "character_state", room_id: config.roomId, state, timestamp: new Date().toISOString() });
}

function scheduleCharacterIdleFromListening() {
  setTimeout(() => {
    if (characterState === "LISTENING") void setCharacterState("IDLE");
  }, musicIntentIdleDelayMs);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of sockets.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastAiReplyPending({ traceId, route, batch = [] } = {}) {
  const latest = Array.isArray(batch) ? batch[batch.length - 1] : null;
  broadcast({
    type: "ai_reply_pending",
    id: `pending_${traceId || nanoid(8)}`,
    room_id: config.roomId,
    role: "ai",
    user_id: "ai-host",
    nickname: "Hoshia",
    text: pendingReplyNotice(route),
    timestamp: new Date().toISOString(),
    latency_trace_id: traceId || "",
    route: route || "smalltalk",
    reply_targets: replyTargets(batch),
    source_message_id: latest?.id || ""
  });
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
    if (ws.readyState === WebSocket.OPEN) {
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
  return moduleEventStore.append({
    room_id: config.roomId,
    module_id: "hoshia_news",
    event_type: eventType,
    user_id: session?.user_id || "",
    nickname: session?.nickname || "",
    summary_hint: summaryHint,
    memory_eligible: false,
    memory_kind: "hoshia_news_event",
    retention_days: 7,
    occurred_at: new Date().toISOString(),
    data
  });
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
    if (session.user_id === userId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
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

function messageEvent(type, role, text, session, extra = {}) {
  const id = nanoid(12);
  const event = {
    type,
    id,
    room_id: config.roomId,
    user_id: session.user_id,
    nickname: session.nickname,
    role,
    text,
    timestamp: new Date().toISOString(),
    danmaku_lane: stableDanmakuLane(id),
    danmaku_speed: 90,
    ...extra
  };
  const danmakuColor = normalizeDanmakuColor(session.danmaku_color || "");
  if (role === "user" && danmakuColor) event.color = danmakuColor;
  return event;
}

function stableDanmakuLane(id) {
  let hash = 0;
  for (const char of String(id || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}

function systemEvent(type, text, extra = {}) {
  const id = nanoid(12);
  return {
    type,
    id,
    room_id: config.roomId,
    role: "system",
    text,
    timestamp: new Date().toISOString(),
    danmaku_lane: stableDanmakuLane(id),
    danmaku_speed: 90,
    ...extra
  };
}

function musicStatusCode(error) {
  if (error === "music_forbidden") return 403;
  if (error === "music_disabled") return 404;
  if (error === "music_target_not_found") return 404;
  if (error === "music_query_required" || error === "music_control_invalid") return 400;
  if (error === "music_rate_limited") return 429;
  if (error === "music_queue_full") return 409;
  return 502;
}

function friendlyMusicError(error) {
  if (error === "music_disabled") return "音乐房间还没开启";
  if (error === "music_provider_unavailable") return "音乐服务还没准备好";
  if (error === "music_provider_timeout") return "音乐服务响应超时";
  if (error === "music_not_found") return "没有找到这首歌";
  if (error === "music_unplayable") return "这首歌暂时不能播放";
  if (error === "music_rate_limited") return "点歌太快啦，稍等一下";
  if (error === "music_queue_full") return "队列已经满啦";
  return "音乐服务暂时不可用";
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

function setSessionCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(cookieName, encodeSessionCookie(sessionId, config.sessionSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: config.sessionTtlSeconds
    })
  );
}

function setGateCookie(res) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(gateCookieName, encodeSessionCookie("passed", config.sessionSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: config.sessionTtlSeconds
    })
  );
}

function isValidUsername(username) {
  const normalized = normalizeUsername(username);
  return normalized.length >= 3 && normalized.length <= 32 && /^[a-z0-9_.-]+$/.test(normalized);
}

function isValidPassword(password) {
  return password.length >= 8 && password.length <= 128;
}

function isValidNickname(nickname) {
  return nickname.length >= 2 && nickname.length <= 24;
}

function isValidAvatarUrl(avatarUrl) {
  if (!avatarUrl) return true;
  if (avatarUrl.length > 500 || /\s/.test(avatarUrl)) return false;
  if (avatarUrl.startsWith("/")) return true;
  if (avatarUrl.startsWith("data:image/") && avatarUrl.length <= 2000) return true;
  try {
    const url = new URL(avatarUrl);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function normalizeDanmakuColor(color) {
  const value = String(color || "").trim();
  if (!value) return "";
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toUpperCase();
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
