import assert from "node:assert/strict";
import test from "node:test";
import { isValidState, nextCharacterState } from "../src/state-machine.js";

test("MVP state machine exposes required states", () => {
  for (const state of ["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"]) {
    assert.equal(isValidState(state), true);
  }
});

test("MVP state machine transitions by event type", () => {
  assert.equal(nextCharacterState("user_message"), "LISTENING");
  assert.equal(nextCharacterState("ai_thinking"), "THINKING");
  assert.equal(nextCharacterState("ai_reply"), "SPEAKING");
  assert.equal(nextCharacterState("error"), "ERROR");
  assert.equal(nextCharacterState("unknown"), "IDLE");
});

