import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeObservabilitySnapshot,
  createRuntimeObservabilityCounters,
  recordAiProviderObservation
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
    } else {
      assert.equal(typeof value, "number");
    }
  }
});
