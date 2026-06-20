import cookie from "cookie";
import {
  cookieName,
  decodeSessionCookie,
  newSessionId
} from "./security.js";

export function createSessionAudienceController({
  config,
  db,
  store,
  sockets,
  activeUserConnections,
  webSocketOpen,
  broadcast,
  normalizeStoredAiProfile,
  parseAiProfileJson
}) {
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

  function sendToSession(userId, payload) {
    for (const [ws, session] of sockets.entries()) {
      if (session.user_id === userId && ws.readyState === webSocketOpen) ws.send(JSON.stringify(payload));
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

  return {
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
  };
}

function sessionKey(id) {
  return `live-room:session:${id}`;
}
