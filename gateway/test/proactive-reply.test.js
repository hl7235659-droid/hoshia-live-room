import assert from "node:assert/strict";
import test from "node:test";
import {
  createProactiveReplyState,
  markUserActivityForProactive,
  nextProactiveDelayMs,
  normalizeProactiveReplyConfig,
  rememberProactiveReply,
  shouldRunProactiveReply
} from "../src/proactive-reply.js";

test("HoshiaClaw proactive shadow is disabled by default", async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
  const { config } = await import(`../src/config.js?proactive_shadow_default=${Date.now()}`);
  assert.equal(config.hoshiaClawProactiveShadowEnabled, false);
});

test("HoshiaClaw remaining shadow rollouts are conservative by default", async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
  const { config } = await import(`../src/config.js?remaining_shadow_defaults=${Date.now()}`);
  assert.equal(config.hoshiaClawDailyPostShadowEnabled, false);
  assert.equal(config.hoshiaClawNewsTopicGenerateShadowEnabled, false);
  assert.equal(config.hoshiaCommentReplyRolloutMode, "live");
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
