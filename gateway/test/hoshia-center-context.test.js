import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHoshiaReplyMetadata,
  buildShortTermAiContext,
  contextPayloadMessage,
  moduleContextForRoute,
  moduleEventsForRoute,
  prepareHoshiaCenterContext,
  refreshRoomContextSummary,
  selectContextMessagesForBatch
} from "../src/hoshia-center-context.js";

test("fast-lane module context keeps only safe compact modules", () => {
  const result = moduleContextForRoute([
    { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle", "calm"], capabilities: ["x"], limits: ["y"] },
    { module_id: "music", enabled: true, current_state: ["queue 2"], capabilities: ["play"], limits: ["3"] },
    { module_id: "hoshia_news", enabled: true, current_state: ["topic"], capabilities: ["news"], limits: ["1"] }
  ], { fastLane: true }, [{ text: "play some music" }]);

  assert.deepEqual(result, [
    { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle", "calm"], capabilities: [], limits: [] },
    { module_id: "music", enabled: true, current_state: ["queue 2"], capabilities: [], limits: [] }
  ]);
});

test("fast-lane module context keeps music for Chinese music mentions", () => {
  const modules = [
    { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle"] },
    { module_id: "music", enabled: true, current_state: ["queue 2"] },
    { module_id: "hoshia_news", enabled: true, current_state: ["topic"] }
  ];
  const result = moduleContextForRoute(modules, { fastLane: true }, [{ text: "Hoshia 帮我看一下播放队列" }]);

  assert.deepEqual(result, [
    { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle"], capabilities: [], limits: [] },
    { module_id: "music", enabled: true, current_state: ["queue 2"], capabilities: [], limits: [] }
  ]);
});

test("fast-lane module context omits music for non-music Chinese messages", () => {
  const modules = [
    { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle"] },
    { module_id: "music", enabled: true, current_state: ["queue 2"] }
  ];
  const result = moduleContextForRoute(modules, { fastLane: true }, [{ text: "Hoshia 今天精神怎么样" }]);

  assert.deepEqual(result, [
    { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle"], capabilities: [], limits: [] }
  ]);
});

test("fast-lane module events keep only short summary hints", () => {
  const result = moduleEventsForRoute([
    { summary_hint: "first" },
    { summary_hint: "" },
    { summary_hint: "second" },
    { summary_hint: "third" }
  ], { fastLane: true });

  assert.deepEqual(result, [{ summary_hint: "first" }, { summary_hint: "second" }]);
});

test("short-term context keeps recent messages for normal batches", async () => {
  const db = {
    listRecentContextMessages() {
      return [
        { role: "user", user_id: "u1", nickname: "A", text: "one", timestamp: "t1" },
        { role: "ai", user_id: "ai", nickname: "Hoshia", text: "two", timestamp: "t2" },
        { role: "user", user_id: "u2", nickname: "B", text: "three", timestamp: "t3" }
      ];
    },
    getRoomContextSummary() {
      return { summary_text: "safe summary" };
    }
  };

  const result = await buildShortTermAiContext({
    batch: [{ session: { user_id: "u1" }, text: "hello" }],
    contextPolicy: { includeContextSummary: true, recentContextLimit: 2 },
    roomId: "room",
    db,
    config: { aiMode: "mock", maxMessageLength: 10 },
    summarizeLiveRoomContext() {
      throw new Error("should not summarize in mock mode");
    }
  });

  assert.deepEqual(result.recentContext.map((item) => item.text), ["two", "three"]);
  assert.equal(result.contextSummary, "safe summary");
});

test("short-term context focuses forced replies on target user and ai messages", () => {
  const messages = [
    { role: "user", user_id: "u1", text: "from u1" },
    { role: "user", user_id: "u2", text: "from u2" },
    { role: "ai", user_id: "ai", text: "from ai" }
  ];

  const result = selectContextMessagesForBatch(messages, [{ forceReply: true, session: { user_id: "u1" } }], 10);

  assert.deepEqual(result.map((item) => item.text), ["from u1", "from ai"]);
});

test("context payload message truncates text without adding raw fields", () => {
  const result = contextPayloadMessage({
    role: "user",
    user_id: "u1",
    nickname: "viewer",
    text: "abcdefghijklmnopqrstuvwxyz",
    raw_prompt: "hidden",
    timestamp: "2026-06-12T00:00:00.000Z"
  }, { maxMessageLength: 5 });

  assert.deepEqual(result, {
    role: "user",
    user_id: "u1",
    nickname: "viewer",
    text: "abcde",
    timestamp: "2026-06-12T00:00:00.000Z"
  });
});

test("room context summary refresh compresses overflow messages", async () => {
  const upserts = [];
  const db = {
    getRoomContextSummary() {
      return {
        summary_text: "previous",
        summarized_until_created_at: "c0",
        summarized_until_id: "m0",
        coverage_start_timestamp: "t0"
      };
    },
    listContextMessagesAfter() {
      return Array.from({ length: 25 }, (_, index) => ({
        id: `m${index + 1}`,
        role: index % 2 ? "ai" : "user",
        user_id: `u${index}`,
        nickname: `n${index}`,
        text: `message ${index}`,
        timestamp: `t${index + 1}`,
        created_at: `c${index + 1}`
      }));
    },
    upsertRoomContextSummary(payload) {
      upserts.push(payload);
    }
  };

  await refreshRoomContextSummary({
    roomId: "room",
    db,
    config: {
      aiMode: "astrbot",
      shortTermContextMaxMessages: 20,
      contextSummaryLookbackMessages: 25,
      contextSummaryCompressMessages: 2,
      maxMessageLength: 20
    },
    async summarizeLiveRoomContext(_config, payload) {
      assert.equal(payload.previousSummary, "previous");
      assert.deepEqual(payload.messages.map((item) => item.text), ["message 0", "message 1"]);
      return "new summary";
    },
    logger: { warn() {} }
  });

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].summaryText, "new summary");
  assert.equal(upserts[0].summarizedUntilId, "m2");
});

test("prepareHoshiaCenterContext aggregates route-scoped context", () => {
  const appended = [];
  const result = prepareHoshiaCenterContext({
    batch: [{ session: { user_id: "u1" }, text: "hello" }],
    roomId: "room",
    contextPolicy: { fastLane: true, includeLifeMemory: true, livingMemoryK: 2, moduleEventLimit: 8 },
    moduleProviders: [{ id: "unused" }],
    moduleEventStore: {
      append(event) { appended.push(event); },
      listRecent() {
        return [{ summary_hint: "recent" }, { summary_hint: "extra" }, { ignored: true }];
      }
    },
    hoshiaInterestKnowledgeService: {
      observeBatch() {
        return [{ module_id: "interest", summary_hint: "observed" }];
      }
    },
    hoshiaDailyCanonService: {
      getActiveEvent() {
        return { title: "study" };
      }
    },
    hoshiaVisualStateService: {
      publicState() {
        return { mood: "calm", activity: "idle" };
      }
    },
    hoshiaLifeMemoryService: {
      buildMemoryPacket() {
        return [{ id: "memory-1" }];
      }
    },
    audienceUsers: [{ nickname: "viewer" }],
    buildModuleContext() {
      return [
        { module_id: "hoshia_visual_state", enabled: true, current_state: ["idle"] },
        { module_id: "music", enabled: true, current_state: ["queue"] },
        { module_id: "hoshia_news", enabled: true, current_state: ["topic"] }
      ];
    },
    buildActiveContext(input) {
      return { diary: input.diaryEvent.title, module_count: input.moduleContext.length, event_count: input.moduleEvents.length };
    },
    buildCharacterSnapshot() {
      return { snapshot: true };
    }
  });

  assert.equal(appended.length, 1);
  assert.deepEqual(result.moduleContext, [{ module_id: "hoshia_visual_state", enabled: true, current_state: ["idle"], capabilities: [], limits: [] }]);
  assert.deepEqual(result.moduleEvents, [{ summary_hint: "recent" }, { summary_hint: "extra" }]);
  assert.deepEqual(result.activeContext, { diary: "study", module_count: 1, event_count: 2 });
  assert.deepEqual(result.characterSnapshot, { snapshot: true });
  assert.equal(result.characterSnapshotSource, "legacy");
  assert.deepEqual(result.lifeMemoryPacket, [{ id: "memory-1" }]);
});

test("prepareHoshiaCenterContext prefers persisted snapshot in event_log mode", () => {
  let builtSnapshot = false;
  const result = prepareHoshiaCenterContext({
    batch: [{ session: { user_id: "u1" }, text: "hello" }],
    roomId: "room",
    characterId: "hoshia",
    characterStateAuthority: "event_log",
    contextPolicy: { fastLane: false, includeLifeMemory: false, moduleEventLimit: 4 },
    moduleProviders: [],
    moduleEventStore: {
      append() {},
      listRecent() {
        return [];
      }
    },
    hoshiaInterestKnowledgeService: {
      observeBatch() {
        return [];
      }
    },
    hoshiaDailyCanonService: {
      getActiveEvent() {
        return null;
      }
    },
    hoshiaVisualStateService: {
      publicState() {
        return { mood: "calm", activity: "idle" };
      }
    },
    hoshiaLifeMemoryService: {
      buildMemoryPacket() {
        return [];
      }
    },
    audienceUsers: [],
    buildModuleContext() {
      return [];
    },
    buildActiveContext() {
      return { ok: true };
    },
    buildCharacterSnapshot() {
      builtSnapshot = true;
      return { snapshot: "legacy" };
    },
    getLatestCharacterSnapshot() {
      return { snapshot: "persisted" };
    }
  });

  assert.equal(builtSnapshot, false);
  assert.deepEqual(result.characterSnapshot, { snapshot: "persisted" });
  assert.equal(result.characterSnapshotSource, "persisted");
});

test("prepareHoshiaCenterContext falls back to legacy snapshot when persisted one is missing", () => {
  const result = prepareHoshiaCenterContext({
    batch: [{ session: { user_id: "u1" }, text: "hello" }],
    roomId: "room",
    characterId: "hoshia",
    characterStateAuthority: "event_log",
    contextPolicy: { fastLane: false, includeLifeMemory: false, moduleEventLimit: 4 },
    moduleProviders: [],
    moduleEventStore: {
      append() {},
      listRecent() {
        return [];
      }
    },
    hoshiaInterestKnowledgeService: {
      observeBatch() {
        return [];
      }
    },
    hoshiaDailyCanonService: {
      getActiveEvent() {
        return null;
      }
    },
    hoshiaVisualStateService: {
      publicState() {
        return { mood: "calm", activity: "idle" };
      }
    },
    hoshiaLifeMemoryService: {
      buildMemoryPacket() {
        return [];
      }
    },
    audienceUsers: [],
    buildModuleContext() {
      return [];
    },
    buildActiveContext() {
      return { ok: true };
    },
    buildCharacterSnapshot() {
      return { snapshot: "legacy" };
    },
    getLatestCharacterSnapshot() {
      return null;
    }
  });

  assert.deepEqual(result.characterSnapshot, { snapshot: "legacy" });
  assert.equal(result.characterSnapshotSource, "legacy");
});

test("buildHoshiaReplyMetadata keeps room reply envelope shape", () => {
  const metadata = buildHoshiaReplyMetadata({
    batch: [{ forceReply: true }],
    messages: [{ nickname: "shadow", text: "hi" }],
    replyTargets: ["shadow"],
    replyRoute: "smalltalk",
    contextPolicy: { fastLane: true },
    latencyTraceId: "trace_1",
    shortTermContext: { recentContext: [{ text: "recent" }], contextSummary: "summary" },
    characterSnapshotContext: { mood: "calm" },
    activeContext: { activity: "idle" },
    moduleContext: [{ module_id: "hoshia_visual_state" }],
    moduleEvents: [{ summary_hint: "event" }],
    moduleMemoryEvents: [{ id: "memory" }],
    onDelta() {}
  });

  assert.equal(metadata.roomSession, true);
  assert.equal(metadata.forceReply, true);
  assert.equal(metadata.replyMode, "single_user_direct");
  assert.equal(metadata.replyRoute, "smalltalk");
  assert.deepEqual(metadata.replyTargets, ["shadow"]);
  assert.deepEqual(metadata.recentContext, [{ text: "recent" }]);
  assert.equal(metadata.contextSummary, "summary");
});
