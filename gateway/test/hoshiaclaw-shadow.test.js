import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyPostShadowPrompt,
  buildNewsTopicGenerateShadowPrompt,
  classifyHoshiaClawShadowReply,
  runDailyPostShadow,
  runHoshiaClawShadow,
  runNewsTopicGenerateShadow
} from "../src/hoshiaclaw-shadow.js";

test("generic shadow forces HoshiaClaw non-streaming options and strips reply text from metrics", async () => {
  const metrics = [];
  const result = await runHoshiaClawShadow({
    enabled: true,
    eventPrefix: "hoshiaclaw.daily_post_shadow",
    replyMode: "daily_post_shadow",
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "raw prompt should only be sent to provider",
    config: {
      roomId: "room",
      aiMode: "astrbot",
      hoshiaClawBridgeUrl: "http://hoshiaclaw:8080/live-room/generate",
      hoshiaClawBridgeToken: "secret-token"
    },
    async generateAiReply(session, prompt, options, _fetchImpl, metadata) {
      assert.equal(session.user_id, "room");
      assert.equal(prompt, "raw prompt should only be sent to provider");
      assert.equal(options.aiMode, "hoshiaclaw");
      assert.equal(options.fallbackToMock, false);
      assert.equal(options.hoshiaClawFallbackToMock, false);
      assert.equal(options.hoshiaclawFallbackToMock, false);
      assert.equal(options.streamingEnabled, false);
      assert.equal(options.hoshiaClawStreamingEnabled, false);
      assert.equal(options.hoshiaclawStreamingEnabled, false);
      assert.equal(metadata.replyMode, "daily_post_shadow");
      assert.equal(metadata.onDelta, null);
      return {
        text: "candidate body must not be stored",
        source: "openai_compatible",
        route: "daily_post_shadow",
        latency_ms: 41
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.eventType, "hoshiaclaw.daily_post_shadow.success");
  assert.equal(result.status, "success");
  assert.equal(result.reason, "daily_post_shadow");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.daily_post_shadow.success",
    status: "success",
    reason: "daily_post_shadow",
    source: "openai_compatible",
    latencyMs: 41
  }]);
  assert.equal(JSON.stringify({ result, metrics }).includes("candidate body"), false);
  assert.equal(JSON.stringify({ result, metrics }).includes("raw prompt"), false);
  assert.equal(JSON.stringify({ result, metrics }).includes("secret-token"), false);
  assert.equal(JSON.stringify({ result, metrics }).includes("http://"), false);
});

test("daily post shadow is pure and never ticks or creates posts", async () => {
  const metrics = [];
  const forbiddenService = {
    tick() {
      throw new Error("tick should not be called");
    },
    db: {
      createHoshiaPost() {
        throw new Error("createHoshiaPost should not be called");
      }
    }
  };

  const result = await runDailyPostShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    dailyPostService: forbiddenService,
    postInput: {
      content: "planned post content must not appear in metric",
      source_type: "daily_state",
      activity: "thinking",
      mood: "focused"
    },
    async generateAiReply(_session, prompt, _options, _fetchImpl, metadata) {
      assert.equal(prompt.includes("planned post content"), true);
      assert.equal(metadata.replyMode, "daily_post_shadow");
      return {
        text: "shadow candidate",
        source: "hoshiaclaw",
        route: "daily_post_shadow",
        latency_ms: 8
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.eventType, "hoshiaclaw.daily_post_shadow.success");
  assert.equal(metrics[0].eventType, "hoshiaclaw.daily_post_shadow.success");
  assert.equal(JSON.stringify(metrics).includes("planned post content"), false);
});

test("daily post shadow skips without a safe post candidate", async () => {
  const metrics = [];
  let called = false;

  const result = await runDailyPostShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    postInput: null,
    async generateAiReply() {
      called = true;
      return { text: "should not be called" };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(called, false);
  assert.equal(result.eventType, "hoshiaclaw.daily_post_shadow.skip");
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "daily_post_shadow_no_candidate");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.daily_post_shadow.skip",
    status: "skip",
    reason: "daily_post_shadow_no_candidate",
    source: "gateway"
  }]);
});

test("daily post shadow records skip when daily posting is disabled", async () => {
  const metrics = [];
  let called = false;

  const result = await runDailyPostShadow({
    enabled: true,
    dailyPostEnabled: false,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    postInput: {
      content: "disabled candidate body must not reach provider"
    },
    async generateAiReply() {
      called = true;
      return { text: "should not be called" };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(called, false);
  assert.equal(result.eventType, "hoshiaclaw.daily_post_shadow.skip");
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "daily_post_disabled");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.daily_post_shadow.skip",
    status: "skip",
    reason: "daily_post_disabled",
    source: "gateway"
  }]);
  assert.equal(JSON.stringify({ result, metrics }).includes("disabled candidate body"), false);
});

test("daily post shadow plans a safe candidate without ticking or creating posts", async () => {
  const metrics = [];
  const calls = [];
  const forbiddenService = {
    planDailyPost(options) {
      calls.push(options);
      return {
        postInput: {
          content: "planned safe candidate must only appear in prompt",
          source_type: "daily_state",
          activity: "thinking",
          mood: "focused"
        },
        state: {
          activity: "thinking",
          mood: "focused"
        }
      };
    },
    tick() {
      throw new Error("tick should not be called");
    },
    db: {
      createHoshiaPost() {
        throw new Error("createHoshiaPost should not be called");
      }
    }
  };

  const result = await runDailyPostShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    dailyPostService: forbiddenService,
    planOptions: {
      sourceType: "daily_state",
      sequence: 1
    },
    async generateAiReply(_session, prompt, _options, _fetchImpl, metadata) {
      assert.equal(prompt.includes("planned safe candidate"), true);
      assert.equal(metadata.replyMode, "daily_post_shadow");
      return {
        text: "provider candidate body must not be stored",
        source: "hoshiaclaw",
        route: "daily_post_shadow",
        latency_ms: 15
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.deepEqual(calls, [{ sourceType: "daily_state", sequence: 1 }]);
  assert.equal(result.eventType, "hoshiaclaw.daily_post_shadow.success");
  assert.equal(result.status, "success");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.daily_post_shadow.success",
    status: "success",
    reason: "daily_post_shadow",
    source: "hoshiaclaw",
    latencyMs: 15
  }]);
  assert.equal(JSON.stringify({ result, metrics }).includes("planned safe candidate"), false);
  assert.equal(JSON.stringify({ result, metrics }).includes("provider candidate body"), false);
});

test("daily post shadow records plan skips without calling provider", async () => {
  const metrics = [];
  let called = false;

  const result = await runDailyPostShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    dailyPostPlan: {
      ok: false,
      postInput: null,
      reason: "daily_max_reached"
    },
    async generateAiReply() {
      called = true;
      return { text: "should not be called" };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(called, false);
  assert.equal(result.eventType, "hoshiaclaw.daily_post_shadow.skip");
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "daily_max_reached");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.daily_post_shadow.skip",
    status: "skip",
    reason: "daily_max_reached",
    source: "gateway"
  }]);
});

test("news topic generate shadow only reads the provided topic", async () => {
  const metrics = [];
  const forbiddenNewsService = {
    async refresh() {
      throw new Error("refresh should not be called");
    },
    async fetch() {
      throw new Error("fetch should not be called");
    },
    async topics() {
      throw new Error("topics should not be called");
    },
    async listTopics() {
      throw new Error("listTopics should not be called");
    }
  };

  const result = await runNewsTopicGenerateShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    newsService: forbiddenNewsService,
    topic: {
      title: "Light topic",
      post_seed: "provided topic seed",
      reaction_style: "playful",
      category: "light_trends",
      meme_hooks: ["hook one"]
    },
    async generateAiReply(_session, prompt, _options, _fetchImpl, metadata) {
      assert.equal(prompt.includes("provided topic seed"), true);
      assert.equal(metadata.replyMode, "news_topic_generate_shadow");
      return {
        text: "topic candidate",
        source: "hoshiaclaw",
        route: "news_topic_generate_shadow",
        latency_ms: 12
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.eventType, "hoshiaclaw.news_topic_generate_shadow.success");
  assert.equal(result.status, "success");
  assert.equal(metrics[0].eventType, "hoshiaclaw.news_topic_generate_shadow.success");
  assert.equal(JSON.stringify(metrics).includes("provided topic seed"), false);
});

test("news topic generate shadow skips without a topic", async () => {
  const metrics = [];
  let called = false;
  const forbiddenNewsService = {
    async refresh() {
      throw new Error("refresh should not be called");
    },
    async fetch() {
      throw new Error("fetch should not be called");
    },
    async listTopics() {
      throw new Error("listTopics should not be called");
    }
  };

  const result = await runNewsTopicGenerateShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    newsService: forbiddenNewsService,
    topic: null,
    prompt: "prompt override should not run without a topic",
    async generateAiReply() {
      called = true;
      return { text: "should not be called" };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(called, false);
  assert.equal(result.eventType, "hoshiaclaw.news_topic_generate_shadow.skip");
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "news_topic_shadow_no_topic");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.news_topic_generate_shadow.skip",
    status: "skip",
    reason: "news_topic_shadow_no_topic",
    source: "gateway"
  }]);
});

test("news topic generate shadow skips without a safe topic", async () => {
  const metrics = [];
  let called = false;

  const result = await runNewsTopicGenerateShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "prompt override should not run with an unsafe topic",
    topic: {
      title: "http://127.0.0.1/.env",
      post_seed: "token=secret"
    },
    async generateAiReply() {
      called = true;
      return { text: "should not be called" };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(called, false);
  assert.equal(result.eventType, "hoshiaclaw.news_topic_generate_shadow.skip");
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "news_topic_shadow_unsafe_topic");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.news_topic_generate_shadow.skip",
    status: "skip",
    reason: "news_topic_shadow_unsafe_topic",
    source: "gateway"
  }]);
  assert.equal(JSON.stringify({ result, metrics }).includes("prompt override"), false);
  assert.equal(JSON.stringify({ result, metrics }).includes("token=secret"), false);
  assert.equal(JSON.stringify({ result, metrics }).includes("127.0.0.1"), false);
});

test("shadow metrics reject raw response text, token, url, and path-shaped reasons", () => {
  const rawResponse = classifyHoshiaClawShadowReply({
    text: "candidate text",
    source: "hoshiaclaw",
    route: "candidate body with spaces"
  }, {
    eventPrefix: "hoshiaclaw.daily_post_shadow",
    fallbackReason: "daily_post_shadow"
  });
  assert.equal(rawResponse.reason, "daily_post_shadow");

  const unsafeSkip = classifyHoshiaClawShadowReply({
    skipped: true,
    source: "hoshiaclaw",
    error: "token=abc http://127.0.0.1/C:/secret/path",
    latency_ms: 5
  }, {
    eventPrefix: "hoshiaclaw.news_topic_generate_shadow",
    fallbackReason: "news_topic_generate_shadow"
  });
  assert.equal(unsafeSkip.eventType, "hoshiaclaw.news_topic_generate_shadow.skip");
  assert.equal(unsafeSkip.reason, "skipped");
  assert.equal(JSON.stringify(unsafeSkip).includes("token"), false);
  assert.equal(JSON.stringify(unsafeSkip).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(unsafeSkip).includes("C:"), false);

  const unsafeSource = classifyHoshiaClawShadowReply({
    text: "candidate text",
    source: "C:\\secret\\provider",
    route: "news_topic_generate_shadow",
    latency_ms: 2
  }, {
    eventPrefix: "hoshiaclaw.news_topic_generate_shadow",
    fallbackReason: "news_topic_generate_shadow"
  });
  assert.equal(unsafeSource.eventType, "hoshiaclaw.news_topic_generate_shadow.success");
  assert.equal(unsafeSource.source, "hoshiaclaw");
  assert.equal(JSON.stringify(unsafeSource).includes("C:"), false);
});

test("shadow prompt builders sanitize topic and post prompt inputs", () => {
  const dailyPrompt = buildDailyPostShadowPrompt({
    postInput: {
      content: "read http://127.0.0.1/.env token=abc",
      source_type: "daily_state",
      activity: "happy",
      mood: "playful"
    }
  });
  assert.equal(dailyPrompt.includes("candidate_post:"), false);
  assert.equal(dailyPrompt.includes("token"), false);
  assert.equal(dailyPrompt.includes("http://"), false);

  const newsPrompt = buildNewsTopicGenerateShadowPrompt({
    topic: {
      title: "Safe title",
      post_seed: "safe seed",
      conversation_starter: "read C:\\secret\\file",
      reaction_style: "light"
    }
  });
  assert.equal(newsPrompt.includes("Safe title"), true);
  assert.equal(newsPrompt.includes("safe seed"), true);
  assert.equal(newsPrompt.includes("C:\\secret"), false);
});
