import express from "express";
import http from "node:http";
import cookie from "cookie";
import Redis from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import {
  cookieName,
  decodeSessionCookie,
  encodeSessionCookie,
  newSessionId,
  verifyInvite
} from "./security.js";
import { generateAiReply } from "./ai-adapter.js";
import { isValidState, nextCharacterState } from "./state-machine.js";

const app = express();
const server = http.createServer(app);
const redis = new Redis(config.redisUrl, { lazyConnect: true });
const sockets = new Map();
let characterState = "IDLE";

await redis.connect();

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

app.post("/api/auth/login", async (req, res) => {
  const invite = String(req.body?.invite || "");
  const nickname = String(req.body?.nickname || "").trim().slice(0, 32);

  if (!nickname || nickname.length < 2) {
    return res.status(400).json({ error: "nickname_required" });
  }
  if (config.allowedNicknames.length && !config.allowedNicknames.includes(nickname)) {
    return res.status(403).json({ error: "nickname_not_allowed" });
  }
  if (!verifyInvite(invite, config.inviteCodeHashes)) {
    return res.status(403).json({ error: "invalid_invite" });
  }

  const sessionId = newSessionId();
  const session = {
    user_id: nanoid(12),
    nickname,
    room_id: config.roomId,
    created_at: new Date().toISOString()
  };
  await redis.setex(sessionKey(sessionId), config.sessionTtlSeconds, JSON.stringify(session));

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
  res.json({ ok: true, user: publicSession(session) });
});

app.post("/api/auth/logout", async (req, res) => {
  const sessionId = getSessionIdFromReq(req);
  if (sessionId) await redis.del(sessionKey(sessionId));
  res.setHeader("Set-Cookie", cookie.serialize(cookieName, "", { path: "/", maxAge: 0 }));
  res.json({ ok: true });
});

app.get("/api/auth/me", requireSession, (req, res) => {
  res.json({ ok: true, user: publicSession(req.session), room: roomInfo() });
});

app.get("/api/room/state", requireSession, async (_req, res) => {
  const recent = await redis.lrange(messagesKey(), 0, 49);
  res.json({
    room: roomInfo(),
    state: characterState,
    messages: recent.map((item) => JSON.parse(item)).reverse()
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

  queueMicrotask(() => void handleAiReply(session, text));
}

async function handleAiReply(session, text) {
  await setCharacterState(nextCharacterState("ai_thinking", text));
  await sleep(450);
  const reply = await generateAiReply(session, text, config);

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
  const session = await loadSessionFromReq(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.session = session;
  next();
}

async function loadSessionFromReq(req) {
  const sessionId = getSessionIdFromReq(req);
  if (!sessionId) return null;
  const raw = await redis.get(sessionKey(sessionId));
  return raw ? JSON.parse(raw) : null;
}

function getSessionIdFromReq(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  return decodeSessionCookie(cookies[cookieName], config.sessionSecret);
}

async function consumeRateLimit(userId) {
  const key = `live-room:rate:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, config.rateWindowSeconds);
  return count <= config.rateLimitCount;
}

async function storeMessage(event) {
  await redis.lpush(messagesKey(), JSON.stringify(event));
  await redis.ltrim(messagesKey(), 0, 199);
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
    nickname: session.nickname,
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

function messagesKey() {
  return `live-room:messages:${config.roomId}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

server.listen(config.port, () => {
  console.log(`live-room-gateway listening on ${config.port}`);
});
