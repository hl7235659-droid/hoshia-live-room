import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("proactive live classifier only accepts openai compatible text", () => {
  const unsupported = classifyProactiveLiveReply({
    text: "mock text",
    source: "mock",
    route: "proactive_idle_live"
  });
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.reason, "unsupported_source");
});
