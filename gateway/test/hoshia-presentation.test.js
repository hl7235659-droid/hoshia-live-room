import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeHoshiaPresentation,
  presentationFromCharacterState,
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
