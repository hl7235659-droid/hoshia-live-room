import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModuleContext,
  buildHoshiaInterestModuleContext,
  buildHoshiaLifeModuleContext,
  buildHoshiaNewsModuleContext,
  buildHoshiaVisualModuleContext,
  buildMusicModuleContext,
  createHoshiaInterestModuleProvider,
  createHoshiaLifeModuleProvider,
  createHoshiaNewsModuleProvider,
  createHoshiaVisualModuleProvider,
  createHoshiaVisualStateChangedEvent,
  createModuleEventStore,
  createMusicModuleProvider,
  createMusicSongRequestedEvent,
  sanitizeModuleEvent
} from "../src/module-context.js";
import { MusicService } from "../src/music-service.js";

class TestStore {
  async incr() {
    return 1;
  }

  async expire() {}
}

const baseConfig = {
  musicEnabled: true,
  musicProvider: "xiaomusic",
  musicProviderBaseUrl: "http://xiaomusic.local",
  musicAdminUsernames: ["owner"],
  musicQueueMax: 5,
  musicRequestWindowSeconds: 60,
  musicRequestLimitCount: 3,
  musicProviderTimeoutMs: 500
};

test("music song requested module event keeps requester attribution and memory candidate metadata", () => {
  const event = createMusicSongRequestedEvent(
    {
      title: "Purple Rain",
      artist: "Prince",
      source: "musicfree",
      requested_by: "003",
      requested_by_id: "user-003",
      requested_at: "2026-06-09T12:00:00.000Z"
    },
    { user_id: "user-003", nickname: "003" },
    { roomId: "live-room-dev", memoryEligible: true }
  );

  assert.equal(event.module_id, "music");
  assert.equal(event.event_type, "music.song_requested");
  assert.equal(event.user_id, "user-003");
  assert.equal(event.nickname, "003");
  assert.equal(event.summary_hint, "003 点了 Purple Rain - Prince");
  assert.equal(event.memory_eligible, true);
  assert.equal(event.memory_kind, "music_preference_candidate");
  assert.equal(event.retention_days, 30);
  assert.deepEqual(event.data, { title: "Purple Rain", artist: "Prince", source: "musicfree" });
});

test("music module context describes current playback queue requester and limits", () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.current = {
    id: "track-1",
    title: "Purple Rain",
    artist: "Prince",
    source: "musicfree",
    requested_by: "003",
    requested_by_id: "user-003",
    requested_at: "2026-06-09T12:00:00.000Z"
  };
  service.queue = [
    {
      id: "track-2",
      title: "Baba O'Riley",
      artist: "The Who",
      source: "musicfree",
      requested_by: "Alice",
      requested_by_id: "user-a",
      requested_at: "2026-06-09T12:05:00.000Z"
    }
  ];
  service.status = "playing";

  const context = buildMusicModuleContext(service, { username: "viewer" });

  assert.equal(context.module_id, "music");
  assert.equal(context.enabled, true);
  assert.equal(context.current_state.some((line) => line.includes("Purple Rain - Prince") && line.includes("003")), true);
  assert.equal(context.current_state.some((line) => line.includes("Baba O'Riley - The Who") && line.includes("Alice")), true);
  assert.equal(context.capabilities.some((line) => line.includes("评价歌单风格")), true);
  assert.equal(context.limits.some((line) => line.includes("完整曲库")), true);
});

test("disabled music module returns safe disabled context", () => {
  const service = new MusicService({ ...baseConfig, musicEnabled: false }, { store: new TestStore() });
  const context = buildMusicModuleContext(service, {});

  assert.equal(context.module_id, "music");
  assert.equal(context.enabled, false);
  assert.equal(context.current_state.includes("音乐模块未启用。"), true);
  assert.deepEqual(context.capabilities, []);
});

test("generic module providers can contribute future capability contexts", () => {
  const contexts = buildModuleContext({
    providers: [
      {
        getCapabilityContext() {
          return {
            module_id: "gift",
            enabled: true,
            current_state: ["最近有人送出星星。"],
            capabilities: ["可基于公开礼物事件互动。"],
            limits: ["不读取支付凭据。"]
          };
        }
      }
    ]
  });

  assert.deepEqual(contexts, [
    {
      module_id: "gift",
      enabled: true,
      current_state: ["最近有人送出星星。"],
      capabilities: ["可基于公开礼物事件互动。"],
      limits: ["不读取支付凭据。"]
    }
  ]);
});

test("music module can be registered through provider registry", () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.current = {
    id: "track-provider",
    title: "Billie Jean",
    artist: "Michael Jackson",
    source: "musicfree",
    requested_by: "003",
    requested_by_id: "user-003",
    requested_at: "2026-06-09T12:00:00.000Z"
  };

  const contexts = buildModuleContext({
    providers: [createMusicModuleProvider(service)],
    session: { username: "viewer" }
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].module_id, "music");
  assert.equal(contexts[0].current_state.some((line) => line.includes("Billie Jean - Michael Jackson")), true);
});

test("hoshia visual module context exposes public state without raw paths", () => {
  const service = {
    publicState() {
      return {
        character_id: "hoshia",
        mood: "competitive",
        activity: "gaming",
        energy: 80,
        social_need: 30,
        current_png: "/assets/hoshia/stage-png/gaming_competitive_01.png",
        state_reason: "viewer talked about gaming",
        updated_at: "2026-06-10T00:00:00.000Z"
      };
    }
  };

  const context = buildHoshiaVisualModuleContext(service, {});
  assert.equal(context.module_id, "hoshia_visual_state");
  assert.equal(context.enabled, true);
  assert.equal(context.current_state.some((line) => line.includes("gaming")), true);
  assert.equal(context.current_state.some((line) => line.includes("controller")), true);
  assert.equal(context.current_state.some((line) => line.includes("/assets/")), false);

  const contexts = buildModuleContext({
    providers: [createHoshiaVisualModuleProvider(service)]
  });
  assert.equal(contexts[0].module_id, "hoshia_visual_state");
});

test("hoshia visual state events keep only short safe fields", () => {
  const event = createHoshiaVisualStateChangedEvent(
    {
      activity: "gaming",
      mood: "competitive",
      current_png: "/assets/hoshia/stage-png/gaming_competitive_01.png",
      updated_at: "2026-06-10T00:00:00.000Z"
    },
    { user_id: "user-1", nickname: "viewer" },
    { roomId: "room-1", reason: "viewer talked about gaming" }
  );

  assert.equal(event.module_id, "hoshia_visual_state");
  assert.equal(event.event_type, "hoshia_visual_state.changed");
  assert.deepEqual(event.data, {
    activity: "gaming",
    mood: "competitive",
    reason: "viewer talked about gaming"
  });
});

test("hoshia news module context exposes only safe topic summary fields", () => {
  const newsService = {
    publicState() {
      return {
        enabled: true,
        running: true,
        stage: "llm_editing",
        topic_count: 7,
        safe_summary: "Tech and creator topics are ready for casual chat",
        recent_signal: "Several light tech topics are fresh",
        recent_titles: [
          "Open source tool gains a friendly desktop workflow",
          "https://rsshub.example/private/feed?token=secret",
          "RSSHub route with Tavily api_key=secret",
          "loaded from E:\\secret\\.env",
          "internal source 10.0.0.5"
        ]
      };
    }
  };

  const context = buildHoshiaNewsModuleContext(newsService, {});
  const serialized = JSON.stringify(context);

  assert.equal(context.module_id, "hoshia_news");
  assert.equal(context.enabled, true);
  assert.equal(context.current_state.some((line) => line.includes("topic count: 7")), true);
  assert.equal(context.current_state.some((line) => line.includes("Open source tool")), true);
  assert.equal(context.capabilities.some((line) => line.includes("conversation hooks")), true);
  assert.equal(context.limits.some((line) => line.includes("source citation")), true);
  assert.doesNotMatch(serialized, /https?:\/\/|token|\.env|E:\\\\|10\.0\.0\.5|rsshub|tavily/i);

  const contexts = buildModuleContext({
    providers: [createHoshiaNewsModuleProvider(newsService)]
  });
  assert.equal(contexts[0].module_id, "hoshia_news");
});

test("hoshia interest module context exposes daily canon and shared topic hooks safely", () => {
  const interestSystem = {
    buildContext(session) {
      return {
        enabled: true,
        current_state: [
          "Today canon: Hoshia had a quiet but slightly competitive day.",
          `Top active interests: anime (1.20), esports (1.10).`,
          "Shared viewer topic: Alice mentioned a new episode and a match."
        ],
        ranked_interests: [],
        daily_canon: { source: "daily_canon", content: "Today canon summary" },
        shared_topics: [{ source: "interest_system", content: "Shared topic" }],
        session
      };
    }
  };

  const context = buildHoshiaInterestModuleContext(interestSystem, { user_id: "user-1" });
  const serialized = JSON.stringify(context);

  assert.equal(context.module_id, "hoshia_interest_system");
  assert.equal(context.enabled, true);
  assert.equal(context.current_state.some((line) => line.includes("Today canon")), true);
  assert.equal(context.capabilities.some((line) => line.includes("daily canon")), true);
  assert.equal(context.limits.some((line) => line.includes("raw chat logs")), true);
  assert.doesNotMatch(serialized, /https?:\/\/|\.env|E:\\\\|10\.0\.0\.5|rsshub|tavily/i);

  const contexts = buildModuleContext({
    providers: [createHoshiaInterestModuleProvider(interestSystem)]
  });
  assert.equal(contexts[0].module_id, "hoshia_interest_system");
});

test("hoshia life module context exposes only safe daily canon summaries", () => {
  const lifeSystem = {
    buildContext(session) {
      return {
        enabled: true,
        date: "2026-06-11",
        theme: "A quiet day that gets warmer at night.",
        diary_text: "She keeps the day ordinary on purpose.",
        emotional_arc: {
          morning: "sleepy",
          afternoon: "curious",
          evening: "lighter",
          late_night: "talkative"
        },
        active_event: {
          time_range: "20:40-21:20",
          title: "Looped one song",
          summary: "She replayed one song because it matched the room mood."
        },
        recent_events: [
          {
            time_range: "17:40-18:30",
            title: "Evening run",
            summary: "She moved around enough to clear her head."
          }
        ],
        current_focus_candidates: [
          "ask what song the viewer would put on loop"
        ],
        session
      };
    }
  };

  const context = buildHoshiaLifeModuleContext(lifeSystem, { user_id: "user-1" });
  const serialized = JSON.stringify(context);

  assert.equal(context.module_id, "hoshia_life_system");
  assert.equal(context.enabled, true);
  assert.equal(context.current_state.some((line) => line.includes("今天的日期")), true);
  assert.equal(context.current_state.some((line) => line.includes("此刻正在经历的片段")), true);
  assert.equal(context.capabilities.some((line) => line.includes("当前片段")), true);
  assert.equal(context.capabilities.some((line) => line.includes("校园日常细节")), true);
  assert.equal(context.limits.some((line) => line.includes("原始记忆 JSON")), true);
  assert.equal(context.limits.some((line) => line.includes("真实世界已验证事实")), true);
  assert.doesNotMatch(serialized, /https?:\/\/|\.env|E:\\\\|10\.0\.0\.5|rsshub|tavily/i);

  const contexts = buildModuleContext({
    providers: [createHoshiaLifeModuleProvider(lifeSystem)]
  });
  assert.equal(contexts[0].module_id, "hoshia_life_system");
});

test("disabled hoshia news module context keeps capability surface closed", () => {
  const context = buildHoshiaNewsModuleContext({ enabled: false }, {});

  assert.equal(context.module_id, "hoshia_news");
  assert.equal(context.enabled, false);
  assert.deepEqual(context.capabilities, []);
  assert.equal(context.limits.some((line) => line.includes("private feeds")), true);
});

test("module event store keeps recent events and sanitizes sensitive text", () => {
  const store = createModuleEventStore({ maxEvents: 2 });
  store.append({
    room_id: "room-a",
    module_id: "music",
    event_type: "music.song_requested",
    user_id: "u1",
    nickname: "A",
    summary_hint: "A 点了 Song 1",
    memory_eligible: true
  });
  store.append({
    room_id: "room-a",
    module_id: "music",
    event_type: "music.song_requested",
    user_id: "u2",
    nickname: "B",
    summary_hint: "B 点了 Song 2",
    memory_eligible: true
  });
  store.append({
    room_id: "room-b",
    module_id: "music",
    event_type: "music.song_requested",
    user_id: "u3",
    nickname: "C",
    summary_hint: "C 点了 Song 3",
    memory_eligible: true
  });

  assert.equal(store.size(), 2);
  assert.deepEqual(store.listRecent({ roomId: "room-a" }).map((event) => event.user_id), ["u2"]);
  assert.equal(sanitizeModuleEvent({
    module_id: "music",
    event_type: "music.song_requested",
    summary_hint: "token=secret should be hidden"
  }), null);
});

test("module memory events are consumed once while recent events remain available", () => {
  const store = createModuleEventStore({ maxEvents: 5 });
  store.append({
    room_id: "room-a",
    module_id: "music",
    event_type: "music.song_requested",
    user_id: "u1",
    nickname: "A",
    summary_hint: "A 点了 Purple Rain - Prince",
    memory_eligible: true,
    data: {
      title: "Purple Rain",
      artist: "Prince",
      source: "musicfree",
      secret: "should not pass"
    }
  });
  store.append({
    room_id: "room-a",
    module_id: "music",
    event_type: "music.song_requested",
    user_id: "u2",
    nickname: "B",
    summary_hint: "B 点了普通歌",
    memory_eligible: false
  });

  const first = store.consumeMemoryEvents({ roomId: "room-a" });
  const second = store.consumeMemoryEvents({ roomId: "room-a" });
  const recent = store.listRecent({ roomId: "room-a" });

  assert.equal(first.length, 1);
  assert.equal(first[0].user_id, "u1");
  assert.deepEqual(first[0].data, { title: "Purple Rain", artist: "Prince", source: "musicfree" });
  assert.deepEqual(second, []);
  assert.equal(recent.length, 2);
});

test("consumed module memory events can be restored after skipped AI replies", () => {
  const store = createModuleEventStore({ maxEvents: 5 });
  store.append({
    room_id: "room-a",
    module_id: "music",
    event_type: "music.song_requested",
    user_id: "u1",
    nickname: "A",
    summary_hint: "A 点了 Baba O'Riley - The Who",
    memory_eligible: true
  });

  const consumed = store.consumeMemoryEvents({ roomId: "room-a" });
  assert.equal(store.pendingMemorySize(), 0);
  store.restoreMemoryEvents(consumed);
  assert.equal(store.pendingMemorySize(), 1);
  assert.equal(store.consumeMemoryEvents({ roomId: "room-a" })[0].summary_hint, "A 点了 Baba O'Riley - The Who");
});
