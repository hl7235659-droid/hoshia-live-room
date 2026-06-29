import assert from "node:assert/strict";
import test from "node:test";
import { pickRuntimeRevision } from "../src/revision-utils.js";

test("runtime revision skips Docker unknown default and falls back to real revision", () => {
  assert.equal(pickRuntimeRevision(["unknown", "abc123"]), "abc123");
  assert.equal(pickRuntimeRevision(["UNKNOWN", "def456"]), "def456");
  assert.equal(pickRuntimeRevision(["unknown", "file-revision", "stale-env"]), "file-revision");
});

test("runtime revision applies sanitizer before selecting candidates", () => {
  const sanitize = (value) => {
    const text = String(value || "");
    if (/token|secret|https?:\/\//i.test(text)) return "";
    return text.replace(/[^a-f0-9]/gi, "").slice(0, 8);
  };

  assert.equal(pickRuntimeRevision(["token://bad", "8079973ba8a62ea28cfb519945a09eb44afe7691"], sanitize), "8079973b");
  assert.equal(pickRuntimeRevision(["", null, undefined], sanitize), "unknown");
});
