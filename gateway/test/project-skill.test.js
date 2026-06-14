import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const skillPath = "../.codex/skills/hoshia-module-integration/SKILL.md";

test("project Hoshia module integration skill exists and has valid frontmatter", () => {
  assert.equal(existsSync(skillPath), true);
  const content = readFileSync(skillPath, "utf8");

  assert.match(content, /^---\r?\nname: hoshia-module-integration\r?\n/m);
  assert.match(content, /\r?\ndescription: .+module_context.+module_events.+module_memory_events.+\r?\n---\r?\n/s);
  assert.match(content, /Provider contract/);
  assert.match(content, /Module events/);
  assert.match(content, /Memory rules/);
  assert.doesNotMatch(content, /BEGIN [A-Z ]*PRIVATE KEY|ssh -i|token=|password=|secret=|43\.\d+\.\d+\.\d+/i);
});
