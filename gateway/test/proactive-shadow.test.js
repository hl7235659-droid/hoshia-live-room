import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyShadowReply,
  runHoshiaClawProactiveShadow
} from "../src/proactive-shadow.js";

test("proactive shadow does not call provider when disabled", async () => {
  let called = false;
  const result = await runHoshiaClawProactiveShadow({
    enabled: false,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    generateAiReply() {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.deepEqual(result, { status: "disabled", called: false });
});

test("proactive shadow calls HoshiaClaw without broadcasting or storing reply text", async () => {
  const metrics = [];
  const result = await runHoshiaClawProactiveShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    prompt: "shadow prompt",
    config: {
      roomId: "room",
      aiMode: "astrbot",
      hoshiaClawBridgeUrl: "http://hoshiaclaw:8080/live-room/generate",
      hoshiaClawBridgeToken: "test-token"
    },
    async generateAiReply(session, prompt, options, _fetchImpl, metadata) {
      assert.equal(session.user_id, "room");
      assert.equal(prompt, "shadow prompt");
      assert.equal(options.aiMode, "hoshiaclaw");
      assert.equal(options.hoshiaClawFallbackToMock, false);
      assert.equal(options.hoshiaClawStreamingEnabled, false);
      assert.equal(metadata.replyMode, "proactive_idle_shadow");
      assert.equal(metadata.onDelta, null);
      return {
        text: "candidate text must not be stored in metric",
        source: "openai_compatible",
        route: "proactive_idle_shadow",
        latency_ms: 123
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.eventType, "hoshiaclaw.proactive_shadow.success");
  assert.equal(result.status, "success");
  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0], {
    eventType: "hoshiaclaw.proactive_shadow.success",
    status: "success",
    reason: "proactive_idle_shadow",
    source: "openai_compatible",
    latencyMs: 123
  });
  assert.equal(JSON.stringify(metrics).includes("candidate text"), false);
});

test("proactive shadow records skip without affecting caller", async () => {
  const metrics = [];
  const result = await runHoshiaClawProactiveShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    async generateAiReply() {
      return {
        skipped: true,
        source: "hoshiaclaw",
        error: "judge_skip",
        latency_ms: 9
      };
    },
    recordMetric(metric) {
      metrics.push(metric);
    }
  });

  assert.equal(result.eventType, "hoshiaclaw.proactive_shadow.skip");
  assert.equal(result.status, "skip");
  assert.equal(metrics[0].reason, "judge_skip");
});

test("proactive shadow records failed provider result and strips sensitive reason", async () => {
  const metrics = [];
  const result = await runHoshiaClawProactiveShadow({
    enabled: true,
    session: { user_id: "u1", nickname: "viewer", room_id: "room" },
    async generateAiReply() {
      throw new Error("token leaked at http://internal.example");
    },
    recordMetric(metric) {
      metrics.push(metric);
    },
    logger: { warn() {} }
  });

  assert.equal(result.eventType, "hoshiaclaw.proactive_shadow.failed");
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "shadow_failed");
  assert.equal(metrics[0].reason, "shadow_failed");
});

test("shadow reply classifier treats gateway errors as failed", () => {
  const result = classifyShadowReply({
    text: "AstrBot bridge is temporarily unavailable.",
    source: "gateway_error",
    route: "provider_failed"
  });

  assert.equal(result.eventType, "hoshiaclaw.proactive_shadow.failed");
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "provider_failed");
});
