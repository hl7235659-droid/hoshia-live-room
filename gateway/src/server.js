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
import { generateAiReply } from "./ai-adapter.js";
import { isValidState, nextCharacterState } from "./state-machine.js";

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
const sockets = new Map();
let characterState = "IDLE";
const replyBatchWindowMs = 3200;
const mentionReplyWindowMs = 1200;
const maxReplyBatchSize = 8;
const maxReplyTargets = 3;
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
      online: sockets.size,
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

  if (!isValidNickname(nickname)) {
    return res.status(400).json({ error: "nickname_invalid" });
  }
  if (!isValidAvatarUrl(avatarUrl)) {
    return res.status(400).json({ error: "avatar_url_invalid" });
  }

  const user = db.updateUserProfile(req.session.user_id, { nickname, avatarUrl });
  if (!user) return res.status(404).json({ error: "user_not_found" });

  const nextSession = {
    ...req.session,
    username: user.username,
    nickname: user.nickname,
    avatar_url: user.avatar_url || ""
  };
  await saveSession(req.sessionId, nextSession);
  refreshSocketSessions(nextSession);

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

const wss = new WebSocketServer({ noServer: true });

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
  sockets.set(ws, session);
  broadcast(systemEvent("presence", `${session.nickname} joined`, { online: sockets.size }));
  ws.send(JSON.stringify({ type: "room_state", room: roomInfo(), state: characterState }));

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
    broadcast(systemEvent("presence", `${session.nickname} left`, { online: sockets.size }));
  });
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

  enqueueAiReply(session, text);
}

function enqueueAiReply(session, text) {
  pendingReplyBatch.push({
    session,
    text,
    mentioned: mentionsHoshia(text),
    timestamp: new Date().toISOString()
  });

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
  if (replyBatchRunning) return;
  const batch = pendingReplyBatch.splice(0, maxReplyBatchSize);
  if (!batch.length) return;

  replyBatchRunning = true;
  try {
    await handleAiReplyBatch(batch);
  } finally {
    replyBatchRunning = false;
    if (pendingReplyBatch.length) {
      scheduleAiReplyBatch(mentionReplyWindowMs);
    }
  }
}

async function handleAiReplyBatch(batch) {
  const batchText = batch.map((item) => item.text).join("\n");
  await setCharacterState(nextCharacterState("ai_thinking", batchText));
  await sleep(450);
  const prompt = formatLiveRoomBatchPrompt(batch);
  const reply = await generateAiReply(roomAiSession(batch), prompt, config, globalThis.fetch, {
    roomSession: true,
    replyTargets: replyTargets(batch),
    messages: batch.map((item) => ({
      user_id: item.session.user_id,
      nickname: item.session.nickname,
      text: item.text,
      mentioned: item.mentioned,
      timestamp: item.timestamp
    }))
  });

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

function formatLiveRoomBatchPrompt(batch) {
  const targets = replyTargets(batch);
  const lines = batch.map((item, index) => {
    const mentionMark = item.mentioned ? " @Hoshia" : "";
    return `[${index + 1}] ${item.session.nickname}${mentionMark}: ${item.text}`;
  });

  const targetInstruction = targets.length
    ? `本轮有人明确 @ 你：${targets.map((name) => `@${name}`).join(" ")}。请优先回应这些人，并在回复开头带上对应 @昵称。`
    : "本轮没有人明确 @ 你。请像主播读弹幕一样自然挑重点回应；如果只回应某个具体观众，请在开头 @昵称，否则不用 @。";

  return [
    "你正在朋友限定的 Hoshia AI 直播间里读一小批最近弹幕。",
    targetInstruction,
    "不要逐条机械回答；请合并语境，回复 1 段即可，尽量简短、亲切、有直播感。",
    "最近弹幕：",
    ...lines
  ].join("\n");
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

async function setCharacterState(state) {
  characterState = state;
  broadcast({ type: "character_state", room_id: config.roomId, state, timestamp: new Date().toISOString() });
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of sockets.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendToSession(userId, payload) {
  for (const [ws, session] of sockets.entries()) {
    if (session.user_id === userId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}

function messageEvent(type, role, text, session, extra = {}) {
  return {
    type,
    id: nanoid(12),
    room_id: config.roomId,
    user_id: session.user_id,
    nickname: session.nickname,
    role,
    text,
    timestamp: new Date().toISOString(),
    ...extra
  };
}

function systemEvent(type, text, extra = {}) {
  return {
    type,
    id: nanoid(12),
    room_id: config.roomId,
    role: "system",
    text,
    timestamp: new Date().toISOString(),
    ...extra
  };
}

function publicSession(session) {
  return {
    user_id: session.user_id,
    username: session.username,
    nickname: session.nickname,
    avatar_url: session.avatar_url || "",
    room_id: session.room_id
  };
}

function roomInfo() {
  return {
    room_id: config.roomId,
    online: sockets.size,
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
  const session = {
    user_id: user.id,
    username: user.username,
    nickname: user.nickname,
    avatar_url: user.avatar_url || "",
    room_id: config.roomId,
    created_at: new Date().toISOString()
  };
  await saveSession(sessionId, session);
  return { sessionId, user: session };
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
