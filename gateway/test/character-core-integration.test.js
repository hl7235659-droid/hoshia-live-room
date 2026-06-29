import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = [
  readFileSync(new URL("../src/server.js", import.meta.url), "utf8"),
  readFileSync(new URL("../src/hoshia-interaction-controller.js", import.meta.url), "utf8"),
  readFileSync(new URL("../src/live-ai-reply-controller.js", import.meta.url), "utf8")
].join("\n");

test("character core routes comment live through HoshiaClaw while preserving AstrBot rollback", () => {
  assert.match(serverSource, /if \(!\["astrbot", "hoshiaclaw"\]\.includes\(config\.aiMode\)\) return "";/);
  assert.match(serverSource, /replyMode: "post_comment_reply"/);
  assert.match(serverSource, /aiMode: "hoshiaclaw"/);
  assert.match(serverSource, /reply\.source !== "openai_compatible"/);
  assert.match(serverSource, /source: reply\.source \|\| config\.aiMode/);
});

test("character core keeps gateway as context wrapper and presentation normalizer", () => {
  assert.match(serverSource, /characterSnapshotContext: summarizeCharacterSnapshotForPrompt\(characterSnapshot\)/);
  assert.match(serverSource, /moduleMemoryEvents/);
  assert.match(serverSource, /recordModuleMemoryEventsSafely\(moduleMemoryEvents\)/);
  assert.match(serverSource, /presentationFromClawEnvelope\(reply/);
  assert.doesNotMatch(serverSource, /candidate_text\s*:/i);
});
