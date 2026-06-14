import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeObservabilitySnapshot,
  createRuntimeObservabilityCounters,
  recordAiProviderObservation,
  recordRouteObservation,
  routeStatusFromCounts
} from "../src/hoshia-runtime-observability.js";

test("runtime observability records HoshiaCore provider outcomes and AstrBot fallback counts", () => {
  const counters = createRuntimeObservabilityCounters();

  recordAiProviderObservation(counters, { source: "openai_compatible", text: "candidate text must not be stored" });
  recordAiProviderObservation(counters, { source: "openai_compatible", skipped: true, error: "raw_prompt token" });
  recordAiProviderObservation(counters, { source: "hoshiaclaw", text: "" });
  recordAiProviderObservation(counters, { source: "mock_fallback", text: "fallback body" });
  recordAiProviderObservation(counters, { source: "https://internal.invalid/token", text: "ignored" });

  const snapshot = buildRuntimeObservabilitySnapshot({
    counters,
    moduleMemoryPending: 2,
    characterSnapshotAgeMs: 1234
  });

  assert.equal(snapshot.hoshia_core_provider_success, 1);
  assert.equal(snapshot.hoshia_core_provider_skip, 1);
  assert.equal(snapshot.hoshia_core_provider_failed, 1);
  assert.equal(snapshot.astrbot_fallback_count, 1);
  assert.equal(snapshot.module_memory_pending, 2);
  assert.equal(snapshot.character_snapshot_age_ms, 1234);

  const payload = JSON.stringify(snapshot);
  assert.equal(payload.includes("candidate text"), false);
  assert.equal(payload.includes("raw_prompt"), false);
  assert.equal(payload.includes("token"), false);
  assert.equal(payload.includes("internal.invalid"), false);
});

test("runtime observability snapshot exposes only numeric counters and nullable age", () => {
  const snapshot = buildRuntimeObservabilitySnapshot({
    counters: createRuntimeObservabilityCounters(),
    moduleMemoryPending: 0,
    characterSnapshotAgeMs: Number.NaN
  });

  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "character_snapshot_age_ms") {
      assert.equal(value, null);
    } else if (key === "route_metrics") {
      assert.equal(typeof value, "object");
    } else {
      assert.equal(typeof value, "number");
    }
  }
});

test("runtime observability exposes route-level live and shadow outcome counters", () => {
  const counters = createRuntimeObservabilityCounters();

  recordRouteObservation(counters, "proactive_idle_live", "success");
  recordRouteObservation(counters, "post_comment_reply_live", "skip");
  recordRouteObservation(counters, "daily_post_live", "failed");
  recordRouteObservation(counters, "news_topic_generate_live", "success");
  recordRouteObservation(counters, "proactive_idle_shadow", "skip");
  recordRouteObservation(counters, "post_comment_reply_shadow", "failed");
  recordRouteObservation(counters, "daily_post_shadow", "success");
  recordRouteObservation(counters, "news_topic_generate_shadow", "skip");
  recordRouteObservation(counters, "https://internal.invalid/token", "success");
  recordRouteObservation(counters, "daily_post_live", "unknown");

  const snapshot = buildRuntimeObservabilitySnapshot({ counters });

  assert.equal(snapshot.proactive_live_success, 1);
  assert.equal(snapshot.comment_reply_live_skip, 1);
  assert.equal(snapshot.daily_post_live_failed, 1);
  assert.equal(snapshot.news_topic_live_success, 1);
  assert.equal(snapshot.proactive_shadow_skip, 1);
  assert.equal(snapshot.comment_reply_shadow_failed, 1);
  assert.equal(snapshot.daily_post_shadow_success, 1);
  assert.equal(snapshot.news_topic_shadow_skip, 1);
  assert.deepEqual(snapshot.route_metrics.daily_post_live, { success: 0, skip: 0, failed: 1 });

  const payload = JSON.stringify(snapshot);
  assert.equal(payload.includes("internal.invalid"), false);
  assert.equal(payload.includes("token"), false);
});

test("runtime observability route counters default closed and status rollup is safe", () => {
  const snapshot = buildRuntimeObservabilitySnapshot({
    counters: createRuntimeObservabilityCounters()
  });

  for (const route of ["proactive_live", "comment_reply_live", "daily_post_live", "news_topic_live"]) {
    assert.deepEqual(snapshot.route_metrics[route], { success: 0, skip: 0, failed: 0 });
  }
  assert.equal(snapshot.proactive_live_success, 0);
  assert.equal(snapshot.comment_reply_live_skip, 0);
  assert.equal(snapshot.daily_post_live_failed, 0);
  assert.equal(snapshot.news_topic_live_success, 0);
  assert.equal(routeStatusFromCounts({ success: 1, skip: 1, failed: 0 }), "success");
  assert.equal(routeStatusFromCounts({ success: 1, skip: 0, failed: 1 }), "failed");
  assert.equal(routeStatusFromCounts({ success: 0, skip: 2, failed: 0 }), "skip");
  assert.equal(routeStatusFromCounts({}), "");
});
