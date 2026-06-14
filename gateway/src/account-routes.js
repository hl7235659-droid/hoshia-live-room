import cookie from "cookie";
import { createHash, randomInt } from "node:crypto";
import { nanoid } from "nanoid";
import nodemailer from "nodemailer";
import { DatabaseError } from "./database.js";
import {
  cookieName,
  encodeSessionCookie,
  hashPassword,
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
    uniqueOnlineCount,
    mailTransporter
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

  app.get("/api/auth/gate", (_req, res) => {
    res.json({ ok: true, passed: true });
  });

  app.post("/api/auth/gate", (_req, res) => {
    res.json({ ok: true, passed: true });
  });

  app.post("/api/auth/register-code/send", async (req, res) => {
    const email = normalizeQqEmail(req.body?.email || req.body?.username || "");
    if (!isValidQqEmail(email)) {
      return res.status(400).json({ error: "qq_email_invalid" });
    }
    if (db.findUserByUsername(email)) {
      return res.status(409).json({ error: "username_taken" });
    }

    const nowMs = Date.now();
    const previous = db.getLatestEmailVerificationCode({ email, purpose: "register" });
    const cooldownMs = Math.max(0, Number(config.registerCodeCooldownSeconds || 60)) * 1000;
    if (previous?.created_at && nowMs - Date.parse(previous.created_at) < cooldownMs) {
      return res.status(429).json({ error: "email_code_rate_limited" });
    }

    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + Math.max(60, Number(config.registerCodeTtlSeconds || 600)) * 1000).toISOString();
    db.insertEmailVerificationCode({
      id: nanoid(12),
      email,
      purpose: "register",
      codeHash: hashEmailCode(email, code, config.sessionSecret),
      createdAt,
      expiresAt
    });

    try {
      await sendRegisterCodeEmail(config, email, code, mailTransporter);
    } catch (error) {
      console.warn("register_code_email_failed", {
        type: error?.name || "Error",
        message: error?.message || String(error)
      });
      return res.status(503).json({ error: "email_send_failed" });
    }

    res.json({
      ok: true,
      expires_at: expiresAt,
      cooldown_seconds: Math.max(0, Number(config.registerCodeCooldownSeconds || 60))
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    const email = normalizeQqEmail(req.body?.username || req.body?.email || "");
    const nickname = nicknameFromEmail(email);
    const password = String(req.body?.password || "");
    const verificationCode = String(req.body?.verificationCode || req.body?.code || "");

    if (!isValidQqEmail(email)) {
      return res.status(400).json({ error: "qq_email_invalid" });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: "password_invalid" });
    }
    if (!isValidEmailCode(verificationCode)) {
      return res.status(400).json({ error: "email_code_invalid" });
    }
    if (config.allowedNicknames.length && !config.allowedNicknames.includes(nickname)) {
      return res.status(403).json({ error: "nickname_not_allowed" });
    }
    if (db.findUserByUsername(email)) {
      return res.status(409).json({ error: "username_taken" });
    }

    let user;
    try {
      db.consumeEmailVerificationCode({
        email,
        purpose: "register",
        codeHash: hashEmailCode(email, verificationCode, config.sessionSecret)
      });
      user = db.createUser({
        user: {
          id: nanoid(12),
          username: email,
          passwordHash: hashPassword(password),
          nickname
        }
      });
    } catch (error) {
      if (error instanceof DatabaseError) {
        const status = error.code === "username_taken" ? 409 : 403;
        return res.status(status).json({ error: error.code });
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
    const username = String(req.body?.username || req.body?.email || "").trim();
    const password = String(req.body?.password || "");

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

function sessionKey(id) {
  return `live-room:session:${id}`;
}

function normalizeQqEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidQqEmail(value) {
  const email = normalizeQqEmail(value);
  return /^[1-9]\d{4,11}@qq\.com$/.test(email);
}

function nicknameFromEmail(email) {
  return normalizeQqEmail(email).split("@")[0].slice(0, 24) || "QQ用户";
}

function isValidEmailCode(code) {
  return /^\d{6}$/.test(String(code || "").trim());
}

function hashEmailCode(email, code, secret) {
  return createHash("sha256")
    .update(`${normalizeQqEmail(email)}:${String(code || "").trim()}:${secret}`, "utf8")
    .digest("hex");
}

async function sendRegisterCodeEmail(config, email, code, mailTransporter) {
  if (!config.smtp?.host || !config.smtp?.from) {
    throw new Error("smtp_not_configured");
  }
  const transporter = mailTransporter || nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user || config.smtp.pass ? {
      user: config.smtp.user,
      pass: config.smtp.pass
    } : undefined
  });
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: "Hoshia Live Room 注册验证码",
    text: `你的 Hoshia Live Room 注册验证码是：${code}。验证码将在 ${Math.floor(Number(config.registerCodeTtlSeconds || 600) / 60)} 分钟后过期。`,
    html: `<p>你的 Hoshia Live Room 注册验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>验证码将在 ${Math.floor(Number(config.registerCodeTtlSeconds || 600) / 60)} 分钟后过期。</p>`
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
