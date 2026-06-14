import assert from "node:assert/strict";
import test from "node:test";
import {
  createProactiveReplyState,
  markUserActivityForProactive,
  nextProactiveDelayMs,
  normalizeProactiveLiveConfig,
  normalizeProactiveReplyConfig,
  rememberProactiveReply,
  shouldRunHoshiaClawProactiveLive,
  shouldRunProactiveReply,
  stablePercentBucket
} from "../src/proactive-reply.js";

test("HoshiaClaw proactive shadow is disabled by default", async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
  const { config } = await import(`../src/config.js?proactive_shadow_default=${Date.now()}`);
  assert.equal(config.hoshiaClawProactiveShadowEnabled, false);
  assert.equal(config.hoshiaClawProactiveLiveEnabled, false);
  assert.equal(config.hoshiaClawProactiveLivePercent, 0);
});

test("HoshiaClaw remaining shadow rollouts are conservative by default", async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
  const { config } = await import(`../src/config.js?remaining_shadow_defaults=${Date.now()}`);
  assert.equal(config.hoshiaClawDailyPostShadowEnabled, false);
  assert.equal(config.hoshiaClawNewsTopicGenerateShadowEnabled, false);
  assert.equal(config.hoshiaCommentReplyRolloutMode, "off");
  assert.equal(config.hoshiaCommentReplyGreyPercent, 100);
});

test("proactive reply config is disabled by default and clamps idle window", () => {
  assert.equal(normalizeProactiveReplyConfig({}).enabled, false);
  assert.deepEqual(normalizeProactiveReplyConfig({
    PROACTIVE_REPLY_ENABLED: "true",
    PROACTIVE_REPLY_MIN_IDLE_SECONDS: "300",
    PROACTIVE_REPLY_MAX_IDLE_SECONDS: "900",
    PROACTIVE_REPLY_MAX_UNANSWERED: "3",
    PROACTIVE_REPLY_CONTEXT_MESSAGES: "24"
  }), {
    enabled: true,
    minIdleSeconds: 300,
    maxIdleSeconds: 900,
    maxUnanswered: 3,
    contextMessages: 24
  });

  const clamped = normalizeProactiveReplyConfig({
    PROACTIVE_REPLY_MIN_IDLE_SECONDS: "900",
    PROACTIVE_REPLY_MAX_IDLE_SECONDS: "300"
  });
  assert.equal(clamped.maxIdleSeconds, 900);
});

test("proactive live config defaults closed and clamps rollout percent", () => {
  assert.deepEqual(normalizeProactiveLiveConfig({}), {
    enabled: false,
    percent: 0
  });
  assert.deepEqual(normalizeProactiveLiveConfig({
    HOSHIACLAW_PROACTIVE_LIVE_ENABLED: "true",
    HOSHIACLAW_PROACTIVE_LIVE_PERCENT: "150"
  }), {
    enabled: true,
    percent: 100
  });
});

test("proactive live rollout requires HoshiaClaw mode flag and stable bucket hit", () => {
  const session = { user_id: "viewer-1", nickname: "Viewer" };
  assert.equal(shouldRunHoshiaClawProactiveLive({
    config: { aiMode: "astrbot", hoshiaClawProactiveLiveEnabled: true, hoshiaClawProactiveLivePercent: 100 },
    session
  }).reason, "ai_mode_not_hoshiaclaw");
  assert.equal(shouldRunHoshiaClawProactiveLive({
    config: { aiMode: "hoshiaclaw", hoshiaClawProactiveLiveEnabled: false, hoshiaClawProactiveLivePercent: 100 },
    session
  }).reason, "proactive_live_disabled");
  assert.equal(shouldRunHoshiaClawProactiveLive({
    config: { aiMode: "hoshiaclaw", hoshiaClawProactiveLiveEnabled: true, hoshiaClawProactiveLivePercent: 0 },
    session
  }).reason, "proactive_live_percent_zero");
  assert.equal(shouldRunHoshiaClawProactiveLive({
    config: { aiMode: "hoshiaclaw", hoshiaClawProactiveLiveEnabled: true, hoshiaClawProactiveLivePercent: 100 },
    session
  }).ok, true);

  const first = shouldRunHoshiaClawProactiveLive({
    config: { aiMode: "hoshiaclaw", roomId: "room", hoshiaClawProactiveLiveEnabled: true, hoshiaClawProactiveLivePercent: 50 },
    session
  });
  const second = shouldRunHoshiaClawProactiveLive({
    config: { aiMode: "hoshiaclaw", roomId: "room", hoshiaClawProactiveLiveEnabled: true, hoshiaClawProactiveLivePercent: 50 },
    session
  });
  assert.equal(first.reason, second.reason);
  assert.equal(first.bucket, second.bucket);
});

test("proactive delay is selected inside configured idle window", () => {
  const settings = normalizeProactiveReplyConfig({
    PROACTIVE_REPLY_MIN_IDLE_SECONDS: "300",
    PROACTIVE_REPLY_MAX_IDLE_SECONDS: "900"
  });

  assert.equal(nextProactiveDelayMs(settings, () => 0), 300000);
  assert.equal(nextProactiveDelayMs(settings, () => 0.5), 600000);
});

test("proactive reply only runs when online idle and below unanswered cap", () => {
  const settings = normalizeProactiveReplyConfig({
    PROACTIVE_REPLY_ENABLED: "true",
    PROACTIVE_REPLY_MIN_IDLE_SECONDS: "300",
    PROACTIVE_REPLY_MAX_IDLE_SECONDS: "900",
    PROACTIVE_REPLY_MAX_UNANSWERED: "3"
  });
  const state = createProactiveReplyState(1_000_000);
  state.nextDueAtMs = 1_300_000;

  assert.equal(shouldRunProactiveReply({
    settings,
    state,
    now: 1_300_000,
    onlineCount: 0
  }).reason, "no_online_users");

  assert.equal(shouldRunProactiveReply({
    settings,
    state,
    now: 1_300_000,
    onlineCount: 1,
    pendingReplyCount: 1
  }).reason, "pending_user_messages");

  assert.equal(shouldRunProactiveReply({
    settings,
    state,
    now: 1_300_000,
    onlineCount: 1
  }).ok, true);

  state.unansweredCount = 3;
  assert.equal(shouldRunProactiveReply({
    settings,
    state,
    now: 1_900_000,
    onlineCount: 1
  }).reason, "max_unanswered");
});

test("user activity resets unanswered count while proactive replies increment it", () => {
  const state = createProactiveReplyState(1_000);
  rememberProactiveReply(state, "聊一个 AI 游戏 NPC 的话题", 2_000);
  rememberProactiveReply(state, "换一个音乐话题", 3_000);

  assert.equal(state.unansweredCount, 2);
  assert.deepEqual(state.recentTexts, ["换一个音乐话题", "聊一个 AI 游戏 NPC 的话题"]);

  markUserActivityForProactive(state, 4_000);
  assert.equal(state.unansweredCount, 0);
  assert.equal(state.lastUserMessageAtMs, 4_000);
});


test("proactive live low percent rollout hits and misses stable buckets", () => {
  assert.equal(stablePercentBucket("key-3"), 0);
  assert.equal(stablePercentBucket("key-10"), 98);

  const baseConfig = {
    aiMode: "hoshiaclaw",
    roomId: "room",
    hoshiaClawProactiveLiveEnabled: true,
    hoshiaClawProactiveLivePercent: 1
  };
  const hit = shouldRunHoshiaClawProactiveLive({
    config: baseConfig,
    bucketKey: "key-3"
  });
  assert.deepEqual(hit, {
    ok: true,
    reason: "proactive_live_enabled",
    bucket: 0
  });

  const miss = shouldRunHoshiaClawProactiveLive({
    config: baseConfig,
    bucketKey: "key-10"
  });
  assert.deepEqual(miss, {
    ok: false,
    reason: "proactive_live_bucket_miss",
    bucket: 98
  });
});
