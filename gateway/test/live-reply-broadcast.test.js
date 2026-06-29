import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveReplyBroadcaster,
  progressiveReplyDelayMs,
  splitReplyForProgressiveDisplay,
  takeNextSentenceStreamChunk
} from "../src/live-reply-broadcast.js";

test("live reply broadcaster preserves pending delta and done payload shapes", async () => {
  const events = [];
  const presentations = [];
  const broadcaster = createLiveReplyBroadcaster({
    roomId: "room-test",
    createId: () => "generated",
    broadcast: (event) => events.push(event),
    broadcastHoshiaPresentation: (presentation) => presentations.push(presentation),
    normalizeHoshiaPresentation: (presentation) => ({ ...presentation, normalized: true }),
    replyTargets: (batch) => batch.map((item) => item.session?.user_id).filter(Boolean),
    sleep: async () => {},
    now: () => new Date("2026-06-20T00:00:00.000Z"),
    performanceNow: () => 150
  });

  broadcaster.broadcastAiReplyPending({
    traceId: "trace-1",
    route: "smalltalk",
    batch: [{ id: "message-1", session: { user_id: "viewer-1" } }]
  });
  broadcaster.broadcastAiReplyDelta({
    traceId: "trace-1",
    route: "smalltalk",
    text: "你好呀",
    deltaMode: "replace",
    stage: "reply_1"
  });
  broadcaster.broadcastAiReplyDone({ traceId: "trace-1", route: "smalltalk" });

  assert.deepEqual(events.map((event) => event.type), [
    "ai_reply_pending",
    "ai_reply_delta",
    "ai_reply_done"
  ]);
  assert.equal(events[0].room_id, "room-test");
  assert.equal(events[0].source_message_id, "message-1");
  assert.deepEqual(events[0].reply_targets, ["viewer-1"]);
  assert.equal(events[1].delta_mode, "replace");
  assert.equal(events[1].stage, "reply_1");
  assert.equal(events[2].skipped, false);
  assert.equal(presentations[0].fallback_state, "THINKING");
  assert.equal(presentations[0].normalized, true);
});

test("progressive reply helpers keep chunking and latency behavior stable", () => {
  assert.equal(takeNextSentenceStreamChunk("第一句。第二句", false), "第一句。");
  assert.equal(takeNextSentenceStreamChunk("还不够长", false), "");
  assert.equal(takeNextSentenceStreamChunk("还不够长", true), "还不够长");
  assert.deepEqual(
    splitReplyForProgressiveDisplay("第一句够长一些，需要慢慢说完。第二句也够长一些，需要接着说！第三句继续补充一点内容。"),
    ["第一句够长一些，需要慢慢说完。第二句也够长一些，需要接着说！", "第三句继续补充一点内容。"]
  );
  assert.equal(progressiveReplyDelayMs("diary_related", 2), 1700);
  assert.equal(progressiveReplyDelayMs("emotional", 1), 800);
  assert.equal(progressiveReplyDelayMs("smalltalk", 1), 550);
});

test("gateway latency breakdown merges bridge and gateway timings", () => {
  const broadcaster = createLiveReplyBroadcaster({
    roomId: "room-test",
    createId: () => "generated",
    broadcast: () => {},
    broadcastHoshiaPresentation: () => {},
    normalizeHoshiaPresentation: (presentation) => presentation,
    replyTargets: () => [],
    sleep: async () => {},
    performanceNow: () => 250
  });

  assert.deepEqual(broadcaster.buildGatewayLatencyBreakdown({
    replyBreakdown: { context_load_ms: 30, provider_ms: 40 },
    routerMs: 12.2,
    contextLoadMs: 20.6,
    gatewayStartedAt: 100,
    pendingVisibleMs: 81.5
  }), {
    context_load_ms: 51,
    provider_ms: 40,
    router_ms: 12,
    batch_wait_ms: 82,
    pending_visible_ms: 82,
    gateway_context_load_ms: 21,
    bridge_context_load_ms: 30,
    gateway_total_ms: 150,
    total_ms: 150
  });
});
