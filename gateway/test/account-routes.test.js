import assert from "node:assert/strict";
import test from "node:test";
import { registerAccountRoutes } from "../src/account-routes.js";

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
      roomId: "live-room-dev",
      roomTokenHashes: [],
      sessionSecret: "test-secret",
      sessionTtlSeconds: 3600
    },
    createSessionForUser: async () => ({ sessionId: "session-1", user: {} }),
    db: {
      completeUserOnboarding: () => null,
      countUsers: () => 2,
      createUserWithRegistrationCode: () => ({}),
      findUserById: () => null,
      findUserByUsername: () => null,
      updateLastLogin: () => {},
      updateUserPassword: () => {},
      updateUserProfile: () => null
    },
    getSessionIdFromReq: () => "",
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
