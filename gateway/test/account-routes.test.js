import assert from "node:assert/strict";
import test from "node:test";
import { registerAccountRoutes } from "../src/account-routes.js";
import { DatabaseError } from "../src/database.js";
import { hashPassword } from "../src/security.js";

function createMockApp() {
  const routes = [];
  const app = {
    routes,
    get(path, ...handlers) {
      routes.push({ method: "GET", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "POST", path, handlers });
    },
    patch(path, ...handlers) {
      routes.push({ method: "PATCH", path, handlers });
    }
  };
  return app;
}

function createMockDeps() {
  return {
    activeUserConnections: new Map(),
    audiencePayload: () => ({ ok: true, online_count: 1, registered_count: 2, users: [] }),
    broadcastAudienceChanged: () => {},
    config: {
      allowedNicknames: [],
      cookieSecure: false,
      registerCodeCooldownSeconds: 60,
      registerCodeTtlSeconds: 600,
      roomId: "live-room-dev",
      roomTokenHashes: [],
      sessionSecret: "test-secret",
      sessionTtlSeconds: 3600,
      smtp: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        user: "sender@example.test",
        pass: "secret",
        from: "sender@example.test"
      }
    },
    createSessionForUser: async () => ({ sessionId: "session-1", user: {} }),
    db: {
      completeUserOnboarding: () => null,
      countUsers: () => 2,
      createUser: () => ({ id: "user-1", username: "123456@qq.com", nickname: "123456" }),
      createUserWithRegistrationCode: () => ({}),
      findUserById: () => null,
      findUserByUsername: () => null,
      getLatestEmailVerificationCode: () => null,
      insertEmailVerificationCode: () => ({}),
      consumeEmailVerificationCode: () => ({}),
      updateLastLogin: () => {},
      updateUserPassword: () => {},
      updateUserProfile: () => null
    },
    getSessionIdFromReq: () => "",
    mailTransporter: { sendMail: async () => ({ messageId: "test-message" }) },
    normalizeOnboardingProfile: () => null,
    publicSession: (session) => session,
    refreshSocketSessions: () => {},
    requireSession: (_req, _res, next) => next?.(),
    roomInfo: () => ({ room_id: "live-room-dev", online: 1, registered: 2, private: true }),
    saveSession: async () => {},
    scheduleWelcomeGreeting: () => {},
    sessionFromUser: () => ({}),
    shouldScheduleWelcomeGreeting: () => false,
    store: { del: async () => {} },
    uniqueOnlineCount: () => 1
  };
}

function createRes() {
  return {
    body: null,
    statusCode: 200,
    headers: {},
    json(value) {
      this.body = value;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    }
  };
}

test("account routes register auth account and room endpoints", () => {
  const app = createMockApp();
  registerAccountRoutes(app, createMockDeps());

  const routeKeys = app.routes.map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(routeKeys, [
    "GET /api/auth/gate",
    "GET /api/auth/me",
    "GET /api/room/audience",
    "GET /api/room/preview",
    "PATCH /api/account/profile",
    "POST /api/account/onboarding",
    "POST /api/account/password",
    "POST /api/auth/gate",
    "POST /api/auth/login",
    "POST /api/auth/logout",
    "POST /api/auth/register-code/send",
    "POST /api/auth/register"
  ].sort());
});

test("room preview route keeps public room summary shape", () => {
  const app = createMockApp();
  registerAccountRoutes(app, createMockDeps());
  const route = app.routes.find((item) => item.method === "GET" && item.path === "/api/room/preview");
  const res = createRes();

  route.handlers[0]({}, res);

  assert.deepEqual(res.body, {
    ok: true,
    room: {
      room_id: "live-room-dev",
      online: 1,
      registered: 2,
      private: true
    }
  });
});


test("register accepts QQ email with verification code", async () => {
  const app = createMockApp();
  const deps = createMockDeps();
  let created = null;
  deps.db.createUser = (payload) => {
    created = payload.user;
    return { id: payload.user.id, username: payload.user.username, nickname: payload.user.nickname };
  };
  registerAccountRoutes(app, deps);
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/register");
  const res = createRes();

  await route.handlers[0]({ body: { username: "123456@qq.com", password: "password123", verificationCode: "123456" }, headers: {} }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(created.username, "123456@qq.com");
  assert.equal(created.nickname, "123456");
});

test("register rejects missing email verification code", async () => {
  const app = createMockApp();
  registerAccountRoutes(app, createMockDeps());
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/register");
  const res = createRes();

  await route.handlers[0]({ body: { username: "123456@qq.com", password: "password123" }, headers: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "email_code_invalid" });
});

test("register rejects non QQ email", async () => {
  const app = createMockApp();
  registerAccountRoutes(app, createMockDeps());
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/register");
  const res = createRes();

  await route.handlers[0]({ body: { username: "friend@example.com", password: "password123" }, headers: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "qq_email_invalid" });
});

test("send register code accepts QQ email and stores hashed code", async () => {
  const app = createMockApp();
  const deps = createMockDeps();
  let inserted = null;
  let sent = null;
  deps.db.insertEmailVerificationCode = (payload) => {
    inserted = payload;
    return payload;
  };
  deps.mailTransporter = {
    sendMail: async (payload) => {
      sent = payload;
      return { messageId: "sent" };
    }
  };
  registerAccountRoutes(app, deps);
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/register-code/send");
  const res = createRes();

  await route.handlers[0]({ body: { email: "123456@qq.com" }, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(inserted.email, "123456@qq.com");
  assert.equal(inserted.purpose, "register");
  assert.match(inserted.codeHash, /^[a-f0-9]{64}$/);
  assert.equal(sent.to, "123456@qq.com");
});

test("send register code rejects non QQ email", async () => {
  const app = createMockApp();
  registerAccountRoutes(app, createMockDeps());
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/register-code/send");
  const res = createRes();

  await route.handlers[0]({ body: { email: "friend@example.com" }, headers: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "qq_email_invalid" });
});


test("register rejects wrong expired and used email verification codes", async () => {
  for (const code of ["email_code_invalid", "email_code_expired", "email_code_used"]) {
    const app = createMockApp();
    const deps = createMockDeps();
    deps.db.consumeEmailVerificationCode = () => {
      throw new DatabaseError(code);
    };
    registerAccountRoutes(app, deps);
    const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/register");
    const res = createRes();

    await route.handlers[0]({ body: { username: "123456@qq.com", password: "password123", verificationCode: "123456" }, headers: {} }, res);

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: code });
  }
});

test("login no longer requires gate cookie", async () => {
  const app = createMockApp();
  const deps = createMockDeps();
  deps.db.findUserByUsername = () => ({
    id: "user-1",
    username: "123456@qq.com",
    password_hash: hashPassword("password123"),
    nickname: "123456"
  });
  deps.createSessionForUser = async (user) => ({ sessionId: "session-1", user });
  registerAccountRoutes(app, deps);
  const route = app.routes.find((item) => item.method === "POST" && item.path === "/api/auth/login");
  const res = createRes();

  await route.handlers[0]({ body: { username: "123456@qq.com", password: "password123" }, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.headers["Set-Cookie"], /live_room_session=/);
});
