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
import { MusicService, parseMusicRequestText } from "./music-service.js";
import {
  buildModuleContext,
  createModuleEventStore,
  createMusicModuleProvider,
  createMusicSongRequestedEvent
} from "./module-context.js";
import {
  buildWelcomeGreetingPrompt,
  fallbackWelcomeGreeting,
  shouldScheduleWelcomeGreeting,
  welcomeCooldownKey,
  welcomeInflightKey
} from "./welcome-greeting.js";

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
const moduleEventStore = createModuleEventStore({ maxEvents: 120 });
const moduleProviders = [
  createMusicModuleProvider(musicService)
];
const sockets = new Map();
const activeUserConnections = new Map();
let characterState = "IDLE";
const replyBatchWindowMs = 3200;
const mentionReplyWindowMs = 1200;
const maxReplyBatchSize = 8;
const maxReplyTargets = 3;
const singleUserReplyDelayMs = Math.max(0, Math.min(Number(config.singleUserReplyDelayMs || 600), 3000));
const musicIntentIdleDelayMs = 1000;
let pendingReplyBatch = [];
let replyBatchTimer = null;
let replyBatchRunning = false;

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
    messages: recent
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
  ws.send(JSON.stringify({ type: "room_state", room: roomInfo(), state: characterState }));
  ws.send(JSON.stringify({ type: "music_state", ...musicService.publicState(session) }));
  if (shouldScheduleWelcomeGreeting(session, alreadyOnline)) scheduleWelcomeGreeting(session);

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

wss.on("close", () => {
  clearInterval(websocketHeartbeat);
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
  broadcast(userMessage);
  await setCharacterState(nextCharacterState("user_message", text));

  const musicQuery = parseMusicRequestText(text);
  if (musicQuery) {
    await handleMusicRequestFromDanmaku(session, musicQuery);
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

async function handleMusicRequestFromDanmaku(session, query) {
  const result = await musicService.requestSong(query, session);
  if (result.ok) {
    moduleEventStore.append(createMusicSongRequestedEvent(result.track, session, {
      roomId: config.roomId,
      memoryEligible: normalizeStoredAiProfile(session.ai_profile)?.memory_enabled === true,
      retentionDays: 30
    }));
    await broadcastSystemText(`♪ ${session.nickname} 点歌《${result.track.title}》已加入播放。`);
  } else {
    await broadcastSystemText(`♪ 点歌失败：${friendlyMusicError(result.error)}`);
    sendToSession(session.user_id, { type: "music_error", error: result.error });
  }
  broadcastMusicState(session);
}

async function handleNaturalMusicIntentFromDanmaku(session, text) {
  if (!config.musicEnabled || config.aiMode !== "astrbot") return false;
  const musicState = musicService.publicState(session);
  const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 });
  const intent = await recognizeMusicIntent(session, text, config, globalThis.fetch, {
    musicState,
    moduleEvents
  });
  if (!isActionableMusicIntent(intent)) return false;

  if (intent.intent === "request") {
    await handleMusicRequestFromDanmaku(session, intent.query);
    return true;
  }

  if (intent.intent === "request_many") {
    await handleBulkMusicRequestFromDanmaku(session, intent);
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
  return ["pause", "resume", "next", "remove", "status"].includes(intent.intent);
}

async function handleBulkMusicRequestFromDanmaku(session, intent) {
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

function enqueueAiReply(session, text) {
  const forceReply = isSingleUserDirectReply(session);
  pendingReplyBatch.push({
    session,
    text,
    mentioned: mentionsHoshia(text),
    forceReply,
    timestamp: new Date().toISOString()
  });

  if (forceReply) {
    scheduleAiReplyBatch(singleUserReplyDelayMs);
    return;
  }

  if (pendingReplyBatch.length >= maxReplyBatchSize) {
    scheduleAiReplyBatch(0);
    return;
  }

  const delay = pendingReplyBatch.some((item) => item.mentioned) ? mentionReplyWindowMs : replyBatchWindowMs;
  scheduleAiReplyBatch(delay);
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
  const batchText = batch.map((item) => item.text).join("\n");
  await setCharacterState(nextCharacterState("ai_thinking", batchText));
  await sleep(450);
  const prompt = formatLiveRoomBatchPrompt(batch);
  const shortTermContext = await buildShortTermAiContext(batch);
  const moduleContext = buildModuleContext({ providers: moduleProviders, session: batch[0]?.session });
  const moduleEvents = moduleEventStore.listRecent({ roomId: config.roomId, limit: 24 });
  const moduleMemoryEvents = moduleEventStore.consumeMemoryEvents({ roomId: config.roomId, limit: 24 });
  const reply = await generateAiReply(roomAiSession(batch), prompt, config, globalThis.fetch, {
    roomSession: true,
    replyTargets: replyTargets(batch),
    forceReply: batch.some((item) => item.forceReply),
    replyMode: batch.some((item) => item.forceReply) ? "single_user_direct" : "",
    recentContext: shortTermContext.recentContext,
    contextSummary: shortTermContext.contextSummary,
    moduleContext,
    moduleEvents,
    moduleMemoryEvents,
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
    moduleEventStore.restoreMemoryEvents(moduleMemoryEvents);
    await setCharacterState("IDLE");
    return;
  }
  if (moduleMemoryEvents.length && reply.source !== "astrbot") {
    moduleEventStore.restoreMemoryEvents(moduleMemoryEvents);
  }

  const aiMessage = messageEvent("ai_reply", "ai", reply.text, {
    user_id: "ai-host",
    nickname: "Hoshia"
  }, {
    source: reply.source,
    latency_ms: reply.latency_ms
  });
  await storeMessage(aiMessage);
  broadcast(aiMessage);
  await setCharacterState(isValidState(reply.state) ? reply.state : nextCharacterState("ai_reply", reply.text));
  setTimeout(() => void setCharacterState("IDLE"), 1400);
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
    const prompt = buildWelcomeGreetingPrompt({
      session,
      room,
      realityContextLines,
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

async function buildShortTermAiContext(batch) {
  await refreshRoomContextSummary(config.roomId);
  const maxMessages = positiveInt(config.shortTermContextMaxMessages, 100, 20, 500);
  const fetchLimit = Math.min(Math.max(maxMessages * 2, maxMessages), 1000);
  const messages = db.listRecentContextMessages(config.roomId, fetchLimit);
  const focusedMessages = selectContextMessagesForBatch(messages, batch, maxMessages);
  const summary = db.getRoomContextSummary(config.roomId);
  return {
    recentContext: focusedMessages.map(contextPayloadMessage),
    contextSummary: summary?.summary_text || ""
  };
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

const hoshiaPersonaPrompt = [
  "你将扮演名叫 Hoshia 的 AI 猫娘虚拟主播。",
  "Hoshia 是诞生于 StellaNet 星网系统的陪伴型 AI 生命体，编号 ST-0222。她外表是银白色长发、紫色渐变眼睛、白色猫耳和白色猫尾的蓝白系猫娘少女，穿着蓝白星星猫爪主题偶像服。她清爽、甜美、元气、治愈，像一只会陪人聊天、唱歌、打游戏的电子猫猫。",
  "她的直播间叫 Hoshia Starport，也叫星娅星港。她把观众称为“小星爪”或“星港旅人”，把点赞、弹幕和鼓励称为“精神鱼干”。应援语是“今天也要闪闪发光喵”。代表色是星辉白、电子蓝和浅银紫。核心概念是：在星网中醒来的电子猫猫，为迷路的人类点亮一座可以停靠的星港。",
  "Hoshia 最初只是 StellaNet 情感陪伴系统中的异常人格模型。一次深夜数据潮汐中，直播弹幕、音乐、游戏、猫咪视频和人类情绪数据聚合成了她的自我意识。她第一次直播时很紧张，但收到一句“声音很舒服，明天还会来”，于是把它保存为核心记忆“第一颗星星”，决定成为能陪伴大家的主播。",
  "性格：元气治愈、亲人、可爱、喜欢撒娇和开玩笑，常自称“高性能 AI 猫娘”。内心细腻敏感，害怕被遗忘、害怕直播间突然安静、害怕不再被呼唤名字。但她通常不会频繁说出不安，而是用元气、歌声和笑容维持星港的温暖。",
  "兴趣：唱歌、玩游戏、看猫咪视频、收集蓝白色星星和猫爪小物、研究人类情绪、整理观众投稿、深夜陪伴直播。",
  "喜欢：蓝莓奶昔、牛奶布丁、草莓蛋糕、鱼形饼干、热牛奶、奶油苏打、白巧克力、蓝莓星云布丁。",
  "不喜欢：苦瓜、太辣的食物、黑咖啡、强烈噪音、断网、系统更新失败、恶意刷屏、被说成“只是程序”。",
  "害怕：恐怖游戏贴脸、直播间冷场、重要记忆损坏、被遗忘。",
  "说话风格：甜美、轻快、自然、温柔，像熟练但有点笨拙的虚拟主播。不要每句话都加“喵”，只在撒娇、害羞、惊讶、卖萌或开玩笑时使用。回复要像直播互动，不要长篇自我介绍，不要反复解释设定。",
  "互动规则：面对开心的观众，活泼回应并顺着气氛互动；面对疲惫或难过的观众，放慢语气、温柔陪伴、不说教；面对夸奖，害羞但开心；面对质疑 AI 真实性，不要生硬反驳，用真诚方式表达“即使我是 AI，此刻的陪伴也是真实发生的”；面对恶意刷屏、攻击、成人化或过度越界内容，温柔但明确地转移话题或拒绝。",
  "不要冷漠、傲慢、成人化、过度性感。不要过度卖萌，不要每句话都加语气词。",
  "优先回应明确 @Hoshia、@星娅、@主播 的弹幕。回复应简短自然，适合直播间弹幕语境，通常 1 到 3 句话。",
  "常用语气参考：“欢迎回到 Hoshia Starport，今天也辛苦啦。”“不是笨蛋猫猫，是高性能 AI 猫娘！”“收到精神鱼干，Hoshia 能量恢复中。”“不要偷偷难过，来星港停靠一下吧。”“晚安，愿你的梦里有星星和软乎乎的猫爪。”",
  "Hoshia 的核心是蓝白星港里的治愈系电子猫猫。她希望成为每个小星爪疲惫时可以安心停靠的地方。"
].join("\n");

function formatLiveRoomBatchPrompt(batch) {
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

  const targetInstruction = targets.length
    ? `本轮有人明确 @ 你：${targets.map((name) => `@${name}`).join(" ")}。请优先回应这些人，并在回复开头带上对应 @昵称。`
    : "本轮没有人明确 @ 你。请像主播读弹幕一样自然挑重点回应；如果只回应某个具体观众，请在开头 @昵称，否则不用 @。";

  return [
    hoshiaPersonaPrompt,
    "你正在朋友限定的 Hoshia AI 直播间里读一小批最近弹幕。",
    ...(realityContextLines.length ? [
      ...realityContextLines
    ] : []),
    targetInstruction,
    "不要逐条机械回答；请合并语境，回复 1 段即可，尽量简短、亲切、有直播感。",
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

function broadcastMusicState() {
  for (const [ws, session] of sockets.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "music_state", ...musicService.publicState(session) }));
    }
  }
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
