import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActiveContext,
  buildContextPolicy,
  classifyMessageRoute,
  formatActiveContextLines,
  pendingReplyNotice
} from "../src/message-router.js";

const session = {
  user_id: "user-1",
  nickname: "Alice",
  ai_profile: {
    memory_enabled: true,
    preferred_name: "Alice",
    reply_style_text: "cozy and direct",
    interests: "anime, running"
  }
};

function batch(text, extra = {}) {
  return [{ session, text, mentioned: false, timestamp: "2026-06-11T00:00:00.000Z", ...extra }];
}

test("message router classifies low-latency and heavy reply routes", () => {
  assert.equal(classifyMessageRoute(batch("hello")), "smalltalk");
  assert.equal(classifyMessageRoute(batch("I feel tired and stressed today")), "emotional");
  assert.equal(classifyMessageRoute(batch("Can you review the gateway latency code?")), "project_discussion");
  assert.equal(classifyMessageRoute(batch("What is the capital of France?")), "factual_question");
  assert.equal(classifyMessageRoute(batch("Do you remember what I liked last time?")), "memory_related");
  assert.equal(classifyMessageRoute(batch("What did you do today, any diary update?")), "diary_related");
  assert.equal(classifyMessageRoute(batch("/refresh music state")), "command");
});

test("smalltalk context policy avoids heavy context and memory events", () => {
  const policy = buildContextPolicy("smalltalk", batch("hello"));
  assert.equal(policy.fastLane, true);
  assert.equal(policy.includeContextSummary, false);
  assert.equal(policy.refreshSummarySync, false);
  assert.equal(policy.includeLifeMemory, false);
  assert.equal(policy.includeLivingMemory, false);
  assert.equal(policy.consumeModuleMemoryEvents, false);
  assert.equal(policy.recentContextLimit, 6);
});

test("heavy routes keep memory and summary context available", () => {
  const policy = buildContextPolicy("memory_related", batch("remember this"));
  assert.equal(policy.includeContextSummary, true);
  assert.equal(policy.refreshSummarySync, true);
  assert.equal(policy.includeLifeMemory, true);
  assert.equal(policy.includeLivingMemory, true);
  assert.equal(policy.consumeModuleMemoryEvents, true);
  assert.ok(policy.livingMemoryK >= 1);
});

test("active context is compact and safe for prompt insertion", () => {
  const activeContext = buildActiveContext({
    visualState: {
      mood: "calm",
      activity: "chatting",
      energy: 68,
      social_need: 55,
      state_reason: "Hoshia is watching chat"
    },
    audienceUsers: [{ online: true }],
    moduleContext: [
      {
        module_id: "music",
        enabled: true,
        current_state: ["Now playing: StellaNet Night Drive"]
      }
    ],
    moduleEvents: [
      {
        module_id: "music",
        summary_hint: "Alice requested a night-drive song"
      }
    ],
    batch: batch("hello")
  });

  assert.match(activeContext.current_state, /mood=calm/);
  assert.match(activeContext.recent_user_memory, /cozy and direct/);
  assert.ok(activeContext.chat_hooks.length >= 1);
  assert.ok(formatActiveContextLines(activeContext).some((line) => line.includes("active_context")));
});

test("pending reply notices are route-specific text", () => {
  assert.notEqual(pendingReplyNotice("smalltalk"), pendingReplyNotice("emotional"));
  assert.ok(pendingReplyNotice("diary_related").length > 0);
});
