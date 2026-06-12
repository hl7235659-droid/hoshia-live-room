import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHoshiaReplyMetadata,
  moduleContextForRoute,
  moduleEventsForRoute,
  prepareHoshiaCenterContext
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

test("fast-lane module events keep only short summary hints", () => {
  const result = moduleEventsForRoute([
    { summary_hint: "first" },
    { summary_hint: "" },
    { summary_hint: "second" },
    { summary_hint: "third" }
  ], { fastLane: true });

  assert.deepEqual(result, [{ summary_hint: "first" }, { summary_hint: "second" }]);
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
