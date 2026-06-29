import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProactiveLiveMetadata,
  buildProactiveLivePrompt,
  buildProactiveLiveInterruptionSkipMetric,
  classifyProactiveLiveReply,
  runHoshiaClawProactiveLive
} from "../src/proactive-live.js";

test("proactive live does not call provider when disabled", async () => {
  let called = false;
  const result = await runHoshiaClawProactiveLive({
    enabled: false,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    generateAiReply() {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.deepEqual(result, { status: "disabled", called: false });
});

test("proactive live calls HoshiaClaw with safe live metadata and strips metric text", async () => {
  const metrics = [];
  const result = await runHoshiaClawProactiveLive({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "live prompt",
    config: {
      roomId: "room",
      aiMode: "hoshiaclaw",
      hoshiaClawBridgeUrl: "http://hoshiaclaw:8080/live-room/generate",
      hoshiaClawBridgeToken: "test-token"
    },
    async generateAiReply(session, prompt, options, _fetchImpl, metadata) {
      assert.equal(session.user_id, "room");
      assert.equal(prompt, "live prompt");
      assert.equal(options.aiMode, "hoshiaclaw");
      assert.equal(options.hoshiaClawFallbackToMock, false);
      assert.equal(options.hoshiaClawStreamingEnabled, false);
      assert.equal(metadata.replyMode, "proactive_idle_live");
      assert.equal(metadata.onDelta, null);
      return {
        text: "candidate text may be broadcast by caller but must not be stored in metrics",
        source: "openai_compatible",
        route: "proactive_idle_live",
        latency_ms: 123,
        state: "SPEAKING"
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.eventType, "hoshiaclaw.proactive_live.success");
  assert.equal(result.status, "success");
  assert.equal(result.text, "candidate text may be broadcast by caller but must not be stored in metrics");
  assert.deepEqual(metrics[0], {
    eventType: "hoshiaclaw.proactive_live.success",
    status: "success",
    reason: "proactive_idle_live",
    source: "openai_compatible",
    latencyMs: 123
  });
  assert.equal(JSON.stringify(metrics).includes("candidate text"), false);
});

test("proactive live records skip and failed without fallback text", async () => {
  const skipped = await runHoshiaClawProactiveLive({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "prompt",
    async generateAiReply() {
      return { skipped: true, source: "openai_compatible", error: "judge_skip" };
    }
  });
  assert.equal(skipped.eventType, "hoshiaclaw.proactive_live.skip");
  assert.equal(skipped.status, "skip");
  assert.equal(skipped.reason, "judge_skip");

  const failed = await runHoshiaClawProactiveLive({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "prompt",
    async generateAiReply() {
      return { text: "", source: "gateway_error", error: "raw prompt at http://internal" };
    }
  });
  assert.equal(failed.eventType, "hoshiaclaw.proactive_live.failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "proactive_live_failed");
});

test("proactive live compact prompt and metadata strip unsafe context", () => {
  const prompt = buildProactiveLivePrompt({
    idleMs: 120000,
    onlineCount: 2,
    unansweredCount: 1,
    topicHooks: [
      "Music: current track is safe",
      "raw prompt http://internal should be removed",
      "Daily diary: training finished",
      "localhost debug note should be removed"
    ],
    recentMessages: [
      { role: "user", text: "hello from public chat" },
      { role: "user", text: "token secret should not pass" },
      { role: "ai", text: "safe previous line" }
    ],
    characterSnapshotContext: {
      public: {
        expression: {
          mood: "curious",
          activity: "idle",
          energy: 72
        },
        today: {
          active_event_title: "training recap",
          theme: "/home/secret should not pass"
        },
        relationship: {
          stage: "familiar"
        },
        recent: {
          interaction_source: "danmaku"
        },
        stage: {
          presentation_suggestion: { mood: "curious", activity: "idle" }
        }
      },
      private: { note: "do not expose" },
      internal: { path: "C:\\secret" }
    }
  });

  assert.equal(prompt.includes("Music: current track is safe"), true);
  assert.equal(prompt.includes("Daily diary: training finished"), true);
  assert.equal(prompt.includes("hello from public chat"), true);
  assert.equal(prompt.includes("safe previous line"), true);
  assert.equal(prompt.includes("Mood: curious"), true);
  assert.equal(prompt.includes("Relationship: familiar"), true);
  assert.equal(prompt.includes("Recent source: danmaku"), true);
  assert.equal(prompt.includes("Today: training recap"), true);
  assert.equal(prompt.includes("http://internal"), false);
  assert.equal(prompt.includes("localhost debug note"), false);
  assert.equal(prompt.includes("token secret should not pass"), false);
  assert.equal(prompt.includes("/home/secret"), false);
  assert.equal(prompt.includes("do not expose"), false);
  assert.equal(prompt.includes("C:\\secret"), false);

  const metadata = buildProactiveLiveMetadata({
    latencyTraceId: "trace-1",
    characterSnapshotContext: {
      public: {
        expression: {
          mood: "curious",
          activity: "idle"
        },
        today: {
          active_event_title: "training recap"
        },
        relationship: {
          stage: "familiar"
        },
        recent: {
          interaction_source: "danmaku"
        },
        stage: {
          presentation_suggestion: { mood: "curious", activity: "idle" }
        },
        presentation: { action: "wave", reason: "raw_prompt" }
      },
      private: { token: "hidden" },
      internal: { path: "/home/app" }
    }
  });

  assert.deepEqual(metadata, {
    roomSession: true,
    forceReply: true,
    replyMode: "proactive_idle_live",
    onDelta: null,
    latencyTraceId: "trace-1",
    characterSnapshotContext: {
      mood: "curious",
      activity: "idle",
      relationship_stage: "familiar",
      daily_canon: "training recap",
      recent_interaction_source: "danmaku",
      presentation: {
        action: "wave"
      }
    }
  });
  assert.equal("messages" in metadata, false);
  assert.equal("moduleContext" in metadata, false);
  assert.equal("moduleEvents" in metadata, false);
  assert.equal("recentContext" in metadata, false);
  assert.equal("contextSummary" in metadata, false);
});

test("proactive live classifier only accepts openai compatible text", () => {
  const unsupported = classifyProactiveLiveReply({
    text: "mock text",
    source: "mock",
    route: "proactive_idle_live"
  });
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.reason, "unsupported_source");

  const gatewayError = classifyProactiveLiveReply({
    text: "bridge unavailable",
    source: "gateway_error",
    route: "proactive_idle_live"
  });
  assert.equal(gatewayError.status, "failed");
  assert.equal(gatewayError.reason, "gateway_error");
});


test("proactive live provider failure records safe failed metric only", async () => {
  const metrics = [];
  const warnings = [];
  const result = await runHoshiaClawProactiveLive({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "prompt",
    async generateAiReply() {
      throw new Error("raw_prompt token at C:\\secret\\file.txt");
    },
    recordMetric(metric) {
      metrics.push(metric);
    },
    logger: {
      warn(event, payload) {
        warnings.push({ event, payload });
      }
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "proactive_live_failed");
  assert.deepEqual(metrics, [{
    eventType: "hoshiaclaw.proactive_live.failed",
    status: "failed",
    reason: "proactive_live_failed",
    source: "gateway"
  }]);
  assert.equal(JSON.stringify({ result, metrics, warnings }).includes("raw_prompt"), false);
  assert.equal(JSON.stringify({ result, metrics, warnings }).includes("token"), false);
  assert.equal(JSON.stringify({ result, metrics, warnings }).includes("C:\\secret"), false);
});

test("proactive live interruption skip metric is safe and contains no candidate text", () => {
  const noSkip = buildProactiveLiveInterruptionSkipMetric({
    startedAfterUserMessageAt: 1000,
    lastUserMessageAt: 1000
  });
  assert.equal(noSkip, null);

  const skip = buildProactiveLiveInterruptionSkipMetric({
    startedAfterUserMessageAt: 1000,
    lastUserMessageAt: 2000
  });
  assert.deepEqual(skip, {
    called: true,
    eventType: "hoshiaclaw.proactive_live.skip",
    status: "skip",
    reason: "user_activity_changed",
    source: "gateway"
  });
  assert.equal(JSON.stringify(skip).includes("candidate_text"), false);
});

test("proactive live success sanitizes result-only payloads and rejects unsafe candidate text", () => {
  const success = classifyProactiveLiveReply({
    text: "safe public live line",
    source: "openai_compatible",
    route: "proactive_idle_live",
    latency_ms: 42,
    presentation: { action: "wave", reason: "raw_response should be dropped" },
    latency_breakdown: { provider_ms: 40, raw_prompt: "token" }
  });
  assert.equal(success.status, "success");
  assert.equal(success.text, "safe public live line");
  assert.equal(success.presentation, null);
  assert.equal(success.latency_breakdown, undefined);

  const unsafe = classifyProactiveLiveReply({
    text: "candidate_text token http://internal",
    source: "openai_compatible",
    route: "proactive_idle_live"
  });
  assert.equal(unsafe.status, "failed");
  assert.equal(unsafe.reason, "unsafe_reply_text");
  assert.equal("text" in unsafe, false);
});
