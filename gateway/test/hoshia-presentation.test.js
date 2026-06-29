import assert from "node:assert/strict";
import test from "node:test";
import {
  collectPresentationObservabilityCounts,
  normalizeHoshiaPresentation,
  presentationFromCharacterState,
  presentationFromClawEnvelope,
  presentationFromVisualState
} from "../src/hoshia-presentation.js";

test("presentation normalizer falls back unknown actions and strips sensitive fields", () => {
  const presentation = normalizeHoshiaPresentation({
    action: "open_shell",
    fallback_state: "THINKING",
    expression: "Bearer secret-token",
    motion: "C:\\Users\\me\\motion.json",
    fallback_png: "https://example.invalid/secret.png",
    reason: ".env leaked"
  });

  assert.equal(presentation.action, "think");
  assert.equal(presentation.fallback_state, "THINKING");
  assert.equal(presentation.expression, undefined);
  assert.equal(presentation.motion, undefined);
  assert.equal(presentation.fallback_png, undefined);
  assert.equal(presentation.reason, undefined);
});

test("presentation envelope clamps unsafe action duration reason and preserves trace", () => {
  const presentation = presentationFromClawEnvelope({
    state: "SPEAKING",
    latency_trace_id: "trace_envelope_01",
    route: "Bearer token from .env",
    presentation: {
      action: "open_shell",
      duration_ms: 999999,
      fallback_png: "/assets/hoshia/stage-png/speaking_calm_01.png",
      expression: "calm"
    }
  }, { now: "2026-06-12T00:00:00.000Z" });

  assert.equal(presentation.action, "speak");
  assert.equal(presentation.duration_ms, 15000);
  assert.equal(presentation.reason, undefined);
  assert.equal(presentation.trace_id, "trace_envelope_01");
  assert.equal(presentation.fallback_png, "/assets/hoshia/stage-png/speaking_calm_01.png");
  assert.equal(presentation.timestamp, "2026-06-12T00:00:00.000Z");
});

test("presentation fallback png only allows whitelisted stage png assets", () => {
  const safe = normalizeHoshiaPresentation({
    fallback_png: "/assets/hoshia/stage-png/idle_calm_01.png"
  });
  const wrongFolder = normalizeHoshiaPresentation({
    fallback_png: "/assets/hoshia/private/idle_calm_01.png"
  });
  const wrongExtension = normalizeHoshiaPresentation({
    fallback_png: "/assets/hoshia/stage-png/idle_calm_01.svg"
  });
  const traversal = normalizeHoshiaPresentation({
    fallback_png: "/assets/hoshia/stage-png/../private/idle_calm_01.png"
  });

  assert.equal(safe.fallback_png, "/assets/hoshia/stage-png/idle_calm_01.png");
  assert.equal(wrongFolder.fallback_png, undefined);
  assert.equal(wrongExtension.fallback_png, undefined);
  assert.equal(traversal.fallback_png, undefined);
});

test("presentation observability helper returns read-only counts without raw sensitive data", () => {
  const counts = collectPresentationObservabilityCounts({
    state: "THINKING",
    latency_trace_id: "trace_obs_01",
    route: "https://internal.example.invalid/.env?token=secret",
    raw_prompt: "raw prompt with token",
    raw_response: "raw response with /home/ubuntu/private/model.json",
    presentation: {
      action: "launch_browser",
      duration_ms: 999999,
      fallback_png: "C:\\Users\\me\\secret.png",
      reason: "do not expose"
    }
  });

  assert.equal(Object.isFrozen(counts), true);
  assert.equal(counts.presentation_count, 1);
  assert.equal(counts.action_fallback_count, 1);
  assert.equal(counts.duration_clamped_count, 1);
  assert.equal(counts.fallback_png_rejected_count, 1);
  assert.equal(counts.trace_passthrough_count, 1);
  assert.equal(counts.prompt_omitted_count, 1);
  assert.equal(counts.response_omitted_count, 1);
  assert.equal(Object.values(counts).every((value) => typeof value === "number"), true);

  const payload = JSON.stringify(counts);
  assert.equal(payload.includes("internal.example.invalid"), false);
  assert.equal(payload.includes("token"), false);
  assert.equal(payload.includes("/home/ubuntu"), false);
  assert.equal(payload.includes("C:\\Users"), false);
  assert.equal(payload.includes("raw prompt"), false);
  assert.equal(payload.includes("raw response"), false);
  assert.equal(payload.includes("raw_prompt"), false);
  assert.equal(payload.includes("raw_response"), false);
});

test("presentation helpers map legacy character and visual states", () => {
  assert.equal(presentationFromCharacterState("SPEAKING").action, "speak");
  const visual = presentationFromVisualState({
    mood: "calm",
    activity: "idle",
    current_png: "/assets/hoshia/stage-png/idle_calm_01.png",
    state_reason: "scheduled tick"
  });
  assert.equal(visual.action, "idle");
  assert.equal(visual.fallback_png, "/assets/hoshia/stage-png/idle_calm_01.png");
  assert.equal(visual.expression, "calm");
});
