import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInterestKnowledgeContext,
  createHoshiaInterestKnowledgeService,
  matchInterestKnowledge
} from "../src/interest-knowledge.js";
import { createModuleEventStore, sanitizeModuleEvent } from "../src/module-context.js";

const session = {
  user_id: "user-1",
  nickname: "Alice"
};

test("interest knowledge classifies Hoshia persona interest fields", () => {
  assert.equal(matchInterestKnowledge("最近在看芙莉莲，挺后劲的")?.category, "anime_game");
  assert.equal(matchInterestKnowledge("classic rock 有什么适合夜里听的")?.category, "music_movie");
  assert.equal(matchInterestKnowledge("今天操场跑步有点累")?.category, "sports_campus");
  assert.equal(matchInterestKnowledge("这个 AI 工具最近有什么变化")?.category, "tech_tools");
  assert.equal(matchInterestKnowledge("B站最近这个热梗是什么")?.category, "light_trends");
});

test("local knowledge match takes priority over broad search field signal", () => {
  const match = matchInterestKnowledge("芙莉莲这个新番讲什么");

  assert.equal(match.topic, "葬送的芙莉莲");
  assert.equal(match.source_kind, "local");
  assert.match(match.summary, /长寿精灵/);
});

test("interest knowledge provider exposes safe compact context", () => {
  const service = createHoshiaInterestKnowledgeService();
  const events = service.observeBatch([
    { text: "我喜欢芙莉莲，记住我最近会追这个", session }
  ], { roomId: "room-1" });
  const context = service.getCapabilityContext();
  const serialized = JSON.stringify(context);

  assert.equal(context.module_id, "hoshia_interest_knowledge");
  assert.equal(context.enabled, true);
  assert.equal(context.current_state.some((line) => line.includes("葬送的芙莉莲")), true);
  assert.equal(events.some((event) => event.memory_eligible), true);
  assert.doesNotMatch(serialized, /https?:\/\/|token|\.env|E:\\\\|\/home\/ubuntu|rsshub|tavily/i);
});

test("interest module events keep only whitelisted short data", () => {
  const event = sanitizeModuleEvent({
    module_id: "hoshia_interest_knowledge",
    event_type: "interest.topic_mentioned",
    user_id: "user-1",
    nickname: "Alice",
    summary_hint: "Alice mentioned AI tools",
    memory_eligible: true,
    data: {
      category: "tech_tools",
      topic: "AI 工具",
      matched_alias: "AI",
      source_kind: "local",
      raw_search_result: "should not pass",
      url: "https://example.com"
    }
  });

  assert.deepEqual(event.data, {
    category: "tech_tools",
    topic: "AI 工具",
    matched_alias: "AI",
    source_kind: "local"
  });
});

test("interest memory events are candidates only when viewer expresses preference", () => {
  const service = createHoshiaInterestKnowledgeService();
  const store = createModuleEventStore();

  for (const event of service.observeBatch([{ text: "芙莉莲是什么", session }], { roomId: "room-1" })) {
    store.append(event);
  }
  assert.equal(store.pendingMemorySize(), 0);

  for (const event of service.observeBatch([{ text: "我喜欢芙莉莲，记住一下", session }], { roomId: "room-1" })) {
    store.append(event);
  }
  assert.ok(store.pendingMemorySize() > 0);
});

test("disabled context is explicit when no interest was matched", () => {
  const context = buildInterestKnowledgeContext([]);

  assert.equal(context.enabled, false);
  assert.equal(context.module_id, "hoshia_interest_knowledge");
});
