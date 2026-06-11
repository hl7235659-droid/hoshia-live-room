import cookie from "cookie";
import { nanoid } from "nanoid";
import { DatabaseError, normalizeUsername } from "./database.js";
import {
  cookieName,
  encodeSessionCookie,
  gateCookieName,
  decodeSessionCookie,
  hashAccessCode,
  hashPassword,
  verifyAccessCode,
  verifyPassword
} from "./security.js";

export function registerAccountRoutes(app, deps) {
  const {
    activeUserConnections,
    broadcastAudienceChanged,
    config,
    createSessionForUser,
    db,
    getSessionIdFromReq,
    normalizeOnboardingProfile,
    publicSession,
    refreshSocketSessions,
    requireSession,
    audiencePayload,
    roomInfo,
    saveSession,
    scheduleWelcomeGreeting,
    sessionFromUser,
    shouldScheduleWelcomeGreeting,
    store,
    uniqueOnlineCount
  } = deps;

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
    res.json({ ok: true, passed: hasGateAccess(req, config) });
  });

  app.post("/api/auth/gate", (req, res) => {
    const roomToken = String(req.body?.roomToken || "");
    if (!config.roomTokenHashes.length || !verifyAccessCode(roomToken, config.roomTokenHashes)) {
      return res.status(403).json({ error: "invalid_room_token" });
    }

    setGateCookie(res, config);
    res.json({ ok: true, passed: true });
  });

  app.post("/api/auth/register", async (req, res) => {
    const username = String(req.body?.username || "").trim().slice(0, 48);
    const nickname = username.slice(0, 32);
    const password = String(req.body?.password || "");
    const registrationCode = String(req.body?.registrationCode || "");

    if (!hasGateAccess(req, config)) {
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

    if (!hasGateAccess(req, config)) {
      return res.status(403).json({ error: "gate_required" });
    }

    const user = db.findUserByUsername(username);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(403).json({ error: "invalid_credentials" });
    }

    db.updateLastLogin(user.id);
    const session = await createSessionForUser(user);
    setSessionCookie(res, session.sessionId, config);
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

  app.get("/api/room/audience", requireSession, async (_req, res) => {
    res.json(audiencePayload());
  });
}

function hasGateAccess(req, config) {
  const cookies = cookie.parse(req.headers.cookie || "");
  return decodeSessionCookie(cookies[gateCookieName], config.sessionSecret) === "passed";
}

function setSessionCookie(res, sessionId, config) {
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

function setGateCookie(res, config) {
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

function sessionKey(id) {
  return `live-room:session:${id}`;
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
