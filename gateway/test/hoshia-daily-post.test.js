import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLiveRoomDatabase } from "../src/database.js";
import {
  buildDailyPostContent,
  buildNewsTopicPostContent,
  createHoshiaDailyPostCharacterEvent,
  createHoshiaDailyPostCreatedEvent,
  createHoshiaDailyPostService,
  dayKeyFor,
  normalizeDailyPostLimit,
  runDailyPostLive,
  runDailyPostShadow,
  runNewsTopicLive,
  runNewsTopicGenerateShadow
} from "../src/hoshia-daily-post.js";

test("daily post service plans an internal state post from visual state", () => {
  const service = createHoshiaDailyPostService({
    visualStateService: visualState({
      activity: "gaming",
      mood: "annoyed",
      energy: 82,
      social_need: 30
    }),
    clock: () => new Date("2026-06-10T13:00:00.000Z")
  });

  const plan = service.planDailyPost();

  assert.equal(plan.ok, true);
  assert.equal(plan.postInput.character_id, "hoshia");
  assert.equal(plan.postInput.source_type, "daily_state");
  assert.equal(plan.postInput.id, "daily_20260610_1_gaming_annoyed");
  assert.equal(plan.postInput.activity, "gaming");
  assert.equal(plan.postInput.mood, "annoyed");
  assert.equal(plan.postInput.image_url, "");
  assert.match(plan.postInput.content, /排位|键盘|游戏/);
  assert.doesNotMatch(plan.postInput.content, /小红书|微博|B站|http/i);
});

test("daily tick is disabled by default unless forced by the caller", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      visualStateService: visualState({ activity: "idle", mood: "calm" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const skipped = service.tick();
    assert.equal(skipped.created, false);
    assert.equal(skipped.reason, "daily_post_disabled");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 0);

    const created = service.tick({ force: true });
    assert.equal(created.created, true);
    assert.equal(created.post.source_type, "daily_state");
    assert.equal(created.daily_count, 1);
    assert.equal(created.daily_min, 1);
    assert.equal(created.daily_max, 5);
    assert.equal(created.moduleEvent.module_id, "hoshia_daily_post");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 1);
  } finally {
    cleanup();
  }
});

test("daily post shadow returns success without creating a real post", async () => {
  let createCalled = false;
  let providerPayload = null;
  const service = createHoshiaDailyPostService({
    db: {
      createHoshiaPost() {
        createCalled = true;
        throw new Error("createHoshiaPost should not be called");
      },
      listHoshiaPosts() {
        throw new Error("listHoshiaPosts should not be called");
      }
    },
    visualStateService: visualState({ activity: "thinking", mood: "focused" }),
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  });

  const result = await runDailyPostShadow({
    enabled: true,
    service,
    provider: {
      async generateDailyPostShadow(payload) {
        providerPayload = payload;
        return { text: "safe candidate" };
      }
    },
    now: new Date("2026-06-10T12:00:00.000Z")
  });

  assert.equal(createCalled, false);
  assert.equal(providerPayload.postInput.source_type, "daily_state");
  assert.equal(result.status, "success");
  assert.equal(result.source_type, "daily_state");
  assert.equal(result.route, "daily_post_shadow");
  assert.equal(result.reason, "provider_success");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(providerPayload.postInput.content), false);
  assert.equal(serialized.includes("safe candidate"), false);
});

test("daily post shadow skips disabled/no service/no post input and fails empty or throwing provider", async () => {
  const service = createHoshiaDailyPostService({
    visualStateService: visualState({ activity: "idle", mood: "calm" }),
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  });
  const noPostInputService = {
    planDailyPost() {
      return { ok: false, postInput: null, source_type: "daily_state" };
    }
  };

  assert.deepEqual(await runDailyPostShadow({ service }), {
    status: "skip",
    source_type: "daily_state",
    route: "daily_post_shadow",
    reason: "disabled"
  });
  assert.deepEqual(await runDailyPostShadow({ enabled: true }), {
    status: "skip",
    source_type: "daily_state",
    route: "daily_post_shadow",
    reason: "no_service"
  });
  assert.deepEqual(await runDailyPostShadow({ enabled: true, service: noPostInputService }), {
    status: "skip",
    source_type: "daily_state",
    route: "daily_post_shadow",
    reason: "no_post_input"
  });

  const empty = await runDailyPostShadow({ enabled: true, service, provider: () => "" });
  assert.equal(empty.status, "failed");
  assert.equal(empty.reason, "provider_empty");

  const thrown = await runDailyPostShadow({
    enabled: true,
    service,
    provider: () => {
      throw new Error("token=secret http://127.0.0.1/internal");
    }
  });
  assert.equal(thrown.status, "failed");
  assert.equal(thrown.reason, "provider_error");
  assert.equal(JSON.stringify(thrown).includes("secret"), false);
});

test("daily post live creates one real post and safe event only on provider success", async () => {
  const { db, cleanup } = openTempDb();
  try {
    const metrics = [];
    const service = createHoshiaDailyPostService({
      db,
      visualStateService: visualState({ activity: "thinking", mood: "focused" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const result = await runDailyPostLive({
      enabled: true,
      service,
      now: new Date("2026-06-10T12:00:00.000Z"),
      provider: {
        async generateDailyPostCandidate(payload) {
          assert.equal(payload.postInput.source_type, "daily_state");
          return { text: "今天先把桌面和思路都整理一下，晚点再慢慢和大家聊。" };
        }
      },
      roomId: "test-room",
      recordMetric(metric) {
        metrics.push(metric);
      }
    });

    assert.equal(result.status, "success");
    assert.equal(result.created, true);
    assert.equal(result.reason, "created");
    assert.equal(result.post.content, "今天先把桌面和思路都整理一下，晚点再慢慢和大家聊。");
    assert.equal(result.moduleEvent.module_id, "hoshia_daily_post");
    assert.equal(result.moduleEvent.event_type, "hoshia_daily_post.created");
    assert.equal(result.moduleEvent.data.source, "daily_state");
    assert.equal(result.characterEvent.event_type, "hoshia_timeline.post_created");
    assert.equal(result.characterEvent.data.status, "created");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 1);
    assert.deepEqual(metrics, [{
      route: "daily_post_live",
      status: "success",
      reason: "created",
      source_type: "daily_state"
    }]);
  } finally {
    cleanup();
  }
});

test("daily post live skip/fail paths do not store posts or raw candidates", async () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      visualStateService: visualState({ activity: "happy", mood: "playful" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const skipped = await runDailyPostLive({ enabled: false, service });
    const failed = await runDailyPostLive({
      enabled: true,
      service,
      provider: () => "token=secret http://127.0.0.1/.env"
    });

    assert.equal(skipped.status, "skip");
    assert.equal(skipped.reason, "disabled");
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "sensitive_candidate");
    assert.equal(failed.created, false);
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 0);
    assert.equal(JSON.stringify({ skipped, failed }).includes("secret"), false);
    assert.equal(JSON.stringify({ skipped, failed }).includes("127.0.0.1"), false);
  } finally {
    cleanup();
  }
});

test("daily tick creates at least one daily_state and caps each day at five posts", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({
        activity: "sleepy",
        mood: "sleepy",
        energy: 22,
        social_need: 80
      }),
      clock: () => new Date("2026-06-10T15:30:00.000Z")
    });

    const results = Array.from({ length: 6 }, () => service.tick());

    assert.equal(results[0].created, true);
    assert.equal(results[0].post.source_type, "daily_state");
    assert.equal(results[0].post.id, "daily_20260610_1_sleepy_sleepy");
    assert.equal(results[0].daily_count, 1);
    assert.equal(results[4].created, true);
    assert.equal(results[4].post.source_type, "state_pulse");
    assert.equal(results[4].post.id, "pulse_20260610_5_sleepy_sleepy");
    assert.equal(results[4].daily_count, 5);
    assert.equal(results[5].created, false);
    assert.equal(results[5].reason, "daily_max_reached");
    assert.equal(results[5].daily_count, 5);
    assert.equal(results[5].daily_min, 1);
    assert.equal(results[5].daily_max, 5);
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 5);
  } finally {
    cleanup();
  }
});

test("news_topic counts toward daily max and is limited to one per day", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      dailyMax: 2,
      visualStateService: visualState({ activity: "happy", mood: "playful", energy: 84, social_need: 28 }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const first = service.tick({ newsTopic: lightNewsTopic("大家都在接同一个梗") });
    const second = service.tick({ newsTopic: lightNewsTopic("另一个轻松话题") });
    const third = service.tick();

    assert.equal(first.created, true);
    assert.equal(first.post.source_type, "news_topic");
    assert.equal(first.post.id, "news_20260610_1_happy_playful");
    assert.equal(first.daily_count, 1);
    assert.match(first.post.content, /大家都在接同一个梗/);
    assert.doesNotMatch(first.post.content, /新闻播报|报道称|http/i);
    assert.equal(first.moduleEvent.data.reason, "internal_news_topic_post");

    assert.equal(second.created, false);
    assert.equal(second.reason, "news_topic_daily_max_reached");
    assert.equal(second.daily_count, 1);

    assert.equal(third.created, true);
    assert.equal(third.post.source_type, "state_pulse");
    assert.equal(third.daily_count, 2);
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 2);
  } finally {
    cleanup();
  }
});

test("news topic generate shadow skips when no topic is available", async () => {
  const dailyPostService = createHoshiaDailyPostService({
    visualStateService: visualState({ activity: "happy", mood: "playful" }),
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  });
  const newsService = {
    featuredTopic() {
      return null;
    }
  };

  const result = await runNewsTopicGenerateShadow({
    enabled: true,
    service: newsService,
    dailyPostService,
    now: new Date("2026-06-10T12:00:00.000Z")
  });

  assert.deepEqual(result, {
    status: "skip",
    source_type: "news_topic",
    route: "news_topic_generate_shadow",
    reason: "no_topic"
  });
});

test("news topic generate shadow uses safe featured topic without refresh fetch or listTopics", async () => {
  const calls = [];
  const dailyPostService = createHoshiaDailyPostService({
    db: {
      createHoshiaPost() {
        throw new Error("createHoshiaPost should not be called");
      },
      listHoshiaPosts() {
        throw new Error("listHoshiaPosts should not be called");
      }
    },
    visualStateService: visualState({ activity: "happy", mood: "playful" }),
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  });
  const newsService = {
    featuredTopic() {
      calls.push("featuredTopic");
      return { ...lightNewsTopic("杞绘澗鐑偣璇濋"), category: "culture" };
    },
    refresh() {
      calls.push("refresh");
      throw new Error("refresh should not be called");
    },
    fetch() {
      calls.push("fetch");
      throw new Error("fetch should not be called");
    },
    listTopics() {
      calls.push("listTopics");
      throw new Error("listTopics should not be called");
    }
  };

  const result = await runNewsTopicGenerateShadow({
    enabled: true,
    service: newsService,
    dailyPostService,
    now: new Date("2026-06-10T12:00:00.000Z"),
    provider: {
      async generateNewsTopicShadow(payload) {
        assert.equal(payload.source_type, "news_topic");
        assert.equal(payload.topic.post_seed, "杞绘澗鐑偣璇濋");
        return "safe generated topic candidate";
      }
    }
  });

  assert.deepEqual(calls, ["featuredTopic"]);
  assert.equal(result.status, "success");
  assert.equal(result.source_type, "news_topic");
  assert.equal(result.route, "news_topic_generate_shadow");
  assert.equal(result.topic_category, "culture");
  assert.equal(result.reason, "provider_success");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("safe generated topic candidate"), false);
  assert.equal(serialized.includes("杞绘澗鐑偣璇濋"), false);
});

test("news topic generate shadow skips unsafe topic and redacts result fields", async () => {
  const dailyPostService = createHoshiaDailyPostService({
    visualStateService: visualState({ activity: "thinking", mood: "focused" }),
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  });
  let providerCalled = false;

  const result = await runNewsTopicGenerateShadow({
    enabled: true,
    service: {
      featuredTopic() {
        return null;
      }
    },
    dailyPostService,
    now: new Date("2026-06-10T12:00:00.000Z"),
    topic: {
      post_seed: "unsafe topic should not appear",
      reaction_style: "reply",
      category: "token=secret http://127.0.0.1/private",
      risk_level: "high"
    },
    provider: () => {
      providerCalled = true;
      return "candidate should not be generated";
    }
  });

  assert.equal(providerCalled, false);
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "unsafe_topic");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("unsafe topic should not appear"), false);
  assert.equal(serialized.includes("candidate should not be generated"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("127.0.0.1"), false);
  assert.equal(serialized.includes("private"), false);
});

test("news topic live creates a news_topic post without storing shadow/planned candidate text", async () => {
  const { db, cleanup } = openTempDb();
  try {
    const dailyPostService = createHoshiaDailyPostService({
      db,
      visualStateService: visualState({ activity: "otaku", mood: "excited" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });
    const result = await runNewsTopicLive({
      enabled: true,
      dailyPostService,
      now: new Date("2026-06-10T12:00:00.000Z"),
      topic: { ...lightNewsTopic("这个话题像把梗图递到嘴边"), category: "culture" },
      provider: {
        async generateNewsTopicCandidate(payload) {
          assert.equal(payload.source_type, "news_topic");
          assert.equal(payload.topic.post_seed, "这个话题像把梗图递到嘴边");
          return "看到这个轻松话题，第一反应是想把弹幕接龙开起来。";
        }
      },
      roomId: "test-room"
    });

    assert.equal(result.status, "success");
    assert.equal(result.created, true);
    assert.equal(result.source_type, "news_topic");
    assert.equal(result.topic_category, "culture");
    assert.equal(result.post.source_type, "news_topic");
    assert.equal(result.post.content, "看到这个轻松话题，第一反应是想把弹幕接龙开起来。");
    assert.equal(result.moduleEvent.data.reason, "internal_news_topic_post");
    assert.equal(result.characterEvent.data.source_type, "news_topic");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 1);
    assert.equal(JSON.stringify(result).includes("这个话题像把梗图递到嘴边"), false);
  } finally {
    cleanup();
  }
});

test("news topic live skips unsafe topic and fails sensitive candidate without posts", async () => {
  const { db, cleanup } = openTempDb();
  try {
    const dailyPostService = createHoshiaDailyPostService({
      db,
      visualStateService: visualState({ activity: "thinking", mood: "focused" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const unsafeTopic = await runNewsTopicLive({
      enabled: true,
      dailyPostService,
      topic: {
        post_seed: "unsafe topic should not appear",
        reaction_style: "reply",
        risk_level: "high"
      },
      provider: () => "should not run"
    });
    const sensitiveCandidate = await runNewsTopicLive({
      enabled: true,
      dailyPostService,
      now: new Date("2026-06-10T12:00:00.000Z"),
      topic: lightNewsTopic("轻松话题"),
      provider: {
        generateNewsTopicCandidate: () => "please read C:\\secret\\file token=abc"
      }
    });

    assert.equal(unsafeTopic.status, "skip");
    assert.equal(unsafeTopic.reason, "unsafe_topic");
    assert.equal(sensitiveCandidate.status, "failed");
    assert.equal(sensitiveCandidate.reason, "sensitive_candidate");
    assert.equal(db.listHoshiaPosts({ characterId: "hoshia" }).length, 0);
    const serialized = JSON.stringify({ unsafeTopic, sensitiveCandidate });
    assert.equal(serialized.includes("unsafe topic should not appear"), false);
    assert.equal(serialized.includes("token=abc"), false);
    assert.equal(serialized.includes("C:\\secret"), false);
  } finally {
    cleanup();
  }
});

test("news_topic respects total daily max, min interval, and invalid topic skips", () => {
  const { db, cleanup } = openTempDb();
  try {
    let now = new Date("2026-06-10T12:00:00.000Z");
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      dailyMax: 2,
      minIntervalMinutes: 60,
      visualStateService: visualState({ activity: "thinking", mood: "focused" }),
      clock: () => now
    });

    const first = service.tick({ newsTopic: lightNewsTopic("轻松话题种子") });
    now = new Date("2026-06-10T12:30:00.000Z");
    const intervalSkipped = service.tick({ newsTopic: lightNewsTopic("还没到间隔") });
    now = new Date("2026-06-10T13:30:00.000Z");
    const maxSkipped = service.tick({ newsTopic: lightNewsTopic("超过总上限") });

    assert.equal(first.created, true);
    assert.equal(first.post.source_type, "news_topic");
    assert.equal(intervalSkipped.created, false);
    assert.equal(intervalSkipped.reason, "daily_post_min_interval");
    assert.equal(maxSkipped.created, false);
    assert.equal(maxSkipped.reason, "news_topic_daily_max_reached");
  } finally {
    cleanup();
  }

  const skipped = createHoshiaDailyPostService({
    db: fakePostDb(),
    enabled: true,
    visualStateService: visualState({ activity: "idle", mood: "calm" }),
    clock: () => new Date("2026-06-10T12:00:00.000Z")
  }).tick({
    newsTopic: {
      post_seed: "高风险话题",
      reaction_style: "吐槽",
      risk_level: "high"
    }
  });
  assert.equal(skipped.created, false);
  assert.equal(skipped.reason, "news_topic_invalid");
});

test("news_topic content uses topic hooks with current visual state", () => {
  const content = buildNewsTopicPostContent(lightNewsTopic("这个话题像把梗图递到嘴边"), {
    activity: "otaku",
    mood: "excited",
    energy: 76,
    social_need: 42
  }, new Date("2026-06-10T12:00:00.000Z"));

  assert.match(content, /二次元雷达|这个话题像把梗图递到嘴边|弹幕接龙/);
  assert.doesNotMatch(content, /报道称|新闻播报|http/i);
});

test("dailyMin controls daily_state quota before state_pulse posts", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      dailyMin: 2,
      dailyMax: 5,
      visualStateService: visualState({ activity: "thinking", mood: "focused" }),
      clock: () => new Date("2026-06-10T12:00:00.000Z")
    });

    const first = service.tick();
    const second = service.tick();
    const third = service.tick();

    assert.equal(first.post.source_type, "daily_state");
    assert.equal(second.post.source_type, "daily_state");
    assert.equal(third.post.source_type, "state_pulse");
    assert.equal(first.post.id, "daily_20260610_1_thinking_focused");
    assert.equal(second.post.id, "daily_20260610_2_thinking_focused");
    assert.equal(third.post.id, "pulse_20260610_3_thinking_focused");
  } finally {
    cleanup();
  }
});

test("daily tick respects minimum interval unless forced", () => {
  const { db, cleanup } = openTempDb();
  try {
    let now = new Date("2026-06-10T12:00:00.000Z");
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      minIntervalMinutes: 60,
      visualStateService: visualState({ activity: "happy", mood: "playful" }),
      clock: () => now
    });

    const first = service.tick();
    now = new Date("2026-06-10T12:30:00.000Z");
    const skipped = service.tick();
    const forced = service.tick({ force: true });

    assert.equal(first.created, true);
    assert.equal(skipped.created, false);
    assert.equal(skipped.reason, "daily_post_min_interval");
    assert.equal(skipped.daily_count, 1);
    assert.equal(forced.created, true);
    assert.equal(forced.post.source_type, "state_pulse");
    assert.equal(forced.daily_count, 2);
  } finally {
    cleanup();
  }
});

test("repeated identical state creates non-conflicting sequence ids", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({ activity: "otaku", mood: "curious" }),
      clock: () => new Date("2026-06-10T10:00:00.000Z")
    });

    const ids = Array.from({ length: 5 }, () => service.tick().post.id);

    assert.deepEqual(ids, [
      "daily_20260610_1_otaku_curious",
      "pulse_20260610_2_otaku_curious",
      "pulse_20260610_3_otaku_curious",
      "pulse_20260610_4_otaku_curious",
      "pulse_20260610_5_otaku_curious"
    ]);
    assert.equal(new Set(ids).size, 5);
  } finally {
    cleanup();
  }
});

test("repeated identical state uses diary detail instead of duplicating content", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({
        activity: "sleepy",
        mood: "sleepy",
        energy: 18,
        social_need: 70
      }),
      clock: () => new Date("2026-06-10T16:00:00.000Z")
    });
    const diaryEvent = {
      type: "room_activity",
      title: "Stage notes",
      summary: "She checked the room setup and prepared a few topic notes.",
      detail_seed: "The notes were half useful and half excuses to keep the room feeling alive.",
      chat_hooks: ["Mention having one thing she wanted to say."]
    };

    const first = service.tick({ diaryEvent });
    const second = service.tick({ diaryEvent });

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(second.post.content, first.post.content);
    assert.match(second.post.content, /直播间|小东西|椅子|回血|便签|桌面|话题/);
    assert.doesNotMatch(second.post.content, /Stage notes|room setup|topic notes|wanted to say/);
    assert.doesNotMatch(second.post.content, /这条和今天的小日记有关|单纯报状态|状态还是|能量条|小标签|近况/);
    assert.doesNotMatch(second.post.content, /token=|\/home\/ubuntu|\.env/i);
  } finally {
    cleanup();
  }
});

test("force bypasses disabled and active window checks but not daily max", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: false,
      activeWindow: { startHour: 9, endHour: 17 },
      visualStateService: visualState({ activity: "sports", mood: "energetic" }),
      clock: () => new Date("2026-06-10T18:00:00.000Z")
    });

    const results = Array.from({ length: 6 }, () => service.tick({ force: true }));

    assert.equal(results.filter((result) => result.created).length, 5);
    assert.equal(results[5].created, false);
    assert.equal(results[5].reason, "daily_max_reached");
    assert.equal(results[5].daily_count, 5);
  } finally {
    cleanup();
  }
});

test("ignoreLimit is available only for tests that need to bypass daily max", () => {
  const { db, cleanup } = openTempDb();
  try {
    const service = createHoshiaDailyPostService({
      db,
      enabled: true,
      visualStateService: visualState({ activity: "gaming", mood: "competitive" }),
      clock: () => new Date("2026-06-10T09:00:00.000Z")
    });

    const results = Array.from({ length: 6 }, () => service.tick({ ignoreLimit: true }));

    assert.equal(results[5].created, true);
    assert.equal(results[5].daily_count, 6);
    assert.equal(results[5].post.id, "pulse_20260610_6_gaming_competitive");
  } finally {
    cleanup();
  }
});

test("daily limit uses Asia Shanghai calendar days", () => {
  assert.equal(dayKeyFor("2026-06-09T16:30:00.000Z"), "20260610");
  assert.equal(dayKeyFor("2026-06-10T15:59:59.000Z"), "20260610");
  assert.equal(dayKeyFor("2026-06-10T16:00:00.000Z"), "20260611");
});

test("daily post event exposes only safe short module data", () => {
  const event = createHoshiaDailyPostCreatedEvent(
    {
      id: "post-1",
      created_at: "2026-06-10T12:00:00.000Z"
    },
    {
      activity: "thinking",
      mood: "focused",
      state_reason: "token=secret"
    },
    { roomId: "live-room-dev" }
  );

  assert.equal(event.module_id, "hoshia_daily_post");
  assert.equal(event.event_type, "hoshia_daily_post.created");
  assert.equal(event.memory_eligible, true);
  assert.deepEqual(event.data, {
    activity: "thinking",
    mood: "focused",
    source: "daily_state",
    reason: "internal_state_daily_post"
  });
});

test("daily post character event exposes safe timeline-created data", () => {
  const event = createHoshiaDailyPostCharacterEvent(
    {
      id: "post-1",
      created_at: "2026-06-10T12:00:00.000Z",
      activity: "thinking",
      mood: "focused",
      source_type: "news_topic",
      content: "must not be copied into event"
    },
    { user_id: "user-1", nickname: "viewer" }
  );

  assert.equal(event.event_type, "hoshia_timeline.post_created");
  assert.equal(event.source_kind, "hoshia_timeline");
  assert.equal(event.reason, "news_topic");
  assert.deepEqual(event.data, {
    activity: "thinking",
    mood: "focused",
    source_type: "news_topic",
    post_id: "post-1",
    status: "created"
  });
  assert.equal(JSON.stringify(event).includes("must not be copied"), false);
});

test("daily content reflects energy and social need without external topics", () => {
  const content = buildDailyPostContent({
    activity: "emo",
    mood: "lonely",
    energy: 12,
    social_need: 90
  }, new Date("2026-06-10T18:00:00.000Z"));

  assert.match(content, /低电量|有人来|灯|台灯/);
  assert.doesNotMatch(content, /这条和今天的小日记有关|单纯报状态|状态还是|能量条|小标签|近况/);
  assert.doesNotMatch(content, /小红书|微博|B站|新闻|http/i);
  assert.equal(normalizeDailyPostLimit(0), 1);
  assert.equal(normalizeDailyPostLimit(20), 10);
});

function visualState(state) {
  return {
    publicState() {
      return {
        character_id: "hoshia",
        energy: 72,
        social_need: 48,
        current_png: "",
        state_reason: "test",
        updated_at: "2026-06-10T12:00:00.000Z",
        ...state
      };
    }
  };
}

function lightNewsTopic(seed) {
  return {
    post_seed: seed,
    reaction_style: "吐槽接梗",
    meme_hooks: ["弹幕接龙"],
    reply_hooks: ["这句我先记下"],
    expires_at: "2026-06-10T18:00:00.000Z",
    risk_level: "low"
  };
}

function fakePostDb() {
  const posts = [];
  return {
    createHoshiaPost(post) {
      posts.unshift(post);
      return post;
    },
    listHoshiaPosts() {
      return posts;
    }
  };
}

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "live-room-daily-post-"));
  const db = openLiveRoomDatabase(path.join(dir, "live-room.sqlite"));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
