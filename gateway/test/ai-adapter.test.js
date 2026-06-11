import assert from "node:assert/strict";
import test from "node:test";
import {
  generateAiReply,
  getNewsRefreshStatus,
  listNewsTopics,
  recognizeMusicIntent,
  refreshNewsTopics,
  summarizeLiveRoomContext
} from "../src/ai-adapter.js";

const session = {
  user_id: "user-1",
  nickname: "Tester"
};

const baseConfig = {
  aiMode: "astrbot",
  astrbotBridgeUrl: "http://astrbot:18081/live-room/generate",
  astrbotBridgeToken: "secret-token",
  astrbotTimeoutMs: 100,
  astrbotFallbackToMock: true,
  roomId: "live-room-dev"
};

test("mock mode returns local reply without bridge fetch", async () => {
  const reply = await generateAiReply(
    session,
    "hello",
    { ...baseConfig, aiMode: "mock" },
    async () => {
      throw new Error("fetch should not be called");
    }
  );

  assert.equal(reply.source, "mock");
  assert.equal(reply.state, "SPEAKING");
  assert.match(reply.text, /Tester|mock AI/);
});

test("astrbot mode sends authenticated bridge request", async () => {
  const reply = await generateAiReply(session, "ping", baseConfig, async (url, options) => {
    assert.equal(url, baseConfig.astrbotBridgeUrl);
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), {
      session_id: "live-room-dev:user-1",
      room_id: "live-room-dev",
      user_id: "user-1",
      nickname: "Tester",
      text: "ping",
      prompt: "ping",
      reply_targets: [],
      messages: []
    });
    return responseJson(200, { ok: true, text: "AstrBot says hi", state: "SPEAKING", source: "astrbot", latency_ms: 12 });
  });

  assert.deepEqual(reply, {
    text: "AstrBot says hi",
    state: "SPEAKING",
    source: "astrbot",
    latency_ms: 12
  });
});

test("astrbot room batch uses shared room session and reply targets", async () => {
  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "直播间弹幕" },
    "最近弹幕：\n[1] Alice @Hoshia: hi",
    baseConfig,
    async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        session_id: "live-room-dev:room",
        room_id: "live-room-dev",
        user_id: "room",
        nickname: "直播间弹幕",
        text: "最近弹幕：\n[1] Alice @Hoshia: hi",
        prompt: "最近弹幕：\n[1] Alice @Hoshia: hi",
        reply_targets: ["Alice"],
        messages: [
          {
            user_id: "user-a",
            nickname: "Alice",
            text: "@Hoshia hi",
            mentioned: true,
            timestamp: "2026-06-07T00:00:00.000Z"
          }
        ]
      });
      return responseJson(200, { ok: true, text: "@Alice 我在呀。", state: "SPEAKING", source: "astrbot" });
    },
    {
      roomSession: true,
      replyTargets: ["Alice"],
      messages: [
        {
          user_id: "user-a",
          nickname: "Alice",
          text: "@Hoshia hi",
          mentioned: true,
          timestamp: "2026-06-07T00:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(reply.text, "@Alice 我在呀。");
  assert.equal(reply.source, "astrbot");
});

test("astrbot room batch can force single-viewer direct replies", async () => {
  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "直播间弹幕" },
    "最近弹幕：\n[1] Alice: 今天好累",
    baseConfig,
    async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        session_id: "live-room-dev:room",
        room_id: "live-room-dev",
        user_id: "room",
        nickname: "直播间弹幕",
        text: "最近弹幕：\n[1] Alice: 今天好累",
        prompt: "最近弹幕：\n[1] Alice: 今天好累",
        reply_targets: [],
        messages: [
          {
            user_id: "user-a",
            nickname: "Alice",
            text: "今天好累",
            mentioned: false,
            timestamp: "2026-06-09T00:00:00.000Z"
          }
        ],
        force_reply: true,
        reply_mode: "single_user_direct"
      });
      return responseJson(200, { ok: true, text: "@Alice 辛苦啦。", state: "SPEAKING", source: "astrbot" });
    },
    {
      roomSession: true,
      forceReply: true,
      replyMode: "single_user_direct",
      messages: [
        {
          user_id: "user-a",
          nickname: "Alice",
          text: "今天好累",
          mentioned: false,
          timestamp: "2026-06-09T00:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(reply.text, "@Alice 辛苦啦。");
  assert.equal(reply.source, "astrbot");
});

test("astrbot room batch can include short-term context", async () => {
  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "Live room" },
    "Recent danmaku:\n[1] Alice: do you remember?",
    baseConfig,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.context_summary, "Alice said she is preparing a demo.");
      assert.deepEqual(body.recent_context, [
        {
          role: "user",
          user_id: "user-a",
          nickname: "Alice",
          text: "I am preparing a demo this week",
          timestamp: "2026-06-09T00:00:00.000Z"
        }
      ]);
      return responseJson(200, { ok: true, text: "@Alice 我记得，你这周在准备 demo。", state: "SPEAKING", source: "astrbot" });
    },
    {
      roomSession: true,
      contextSummary: "Alice said she is preparing a demo.",
      recentContext: [
        {
          role: "user",
          user_id: "user-a",
          nickname: "Alice",
          text: "I am preparing a demo this week",
          timestamp: "2026-06-09T00:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(reply.source, "astrbot");
});

test("astrbot room batch can include module context and module events", async () => {
  const moduleContext = [
    {
      module_id: "music",
      enabled: true,
      current_state: ["当前播放：Purple Rain - Prince。", "待播 1 首。"],
      capabilities: ["观众可通过弹幕点歌。"],
      limits: ["只能基于当前队列回答。"]
    }
  ];
  const moduleEvents = [
    {
      module_id: "music",
      event_type: "music.song_requested",
      user_id: "user-a",
      nickname: "Alice",
      summary_hint: "Alice 点了 Purple Rain - Prince",
      memory_eligible: true,
      memory_kind: "music_preference_candidate",
      retention_days: 30
    }
  ];

  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "Live room" },
    "Recent danmaku:\n[1] Alice: 评价一下现在的歌单",
    baseConfig,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.module_context, moduleContext);
      assert.deepEqual(body.module_events, moduleEvents);
      return responseJson(200, { ok: true, text: "现在的歌单有复古流行感。", state: "SPEAKING", source: "astrbot" });
    },
    {
      roomSession: true,
      moduleContext,
      moduleEvents
    }
  );

  assert.equal(reply.source, "astrbot");
});

test("astrbot room batch forwards low-latency routing metadata", async () => {
  const activeContext = {
    current_state: "mood=calm; activity=chatting",
    active_event: "Alice: hello",
    chat_hooks: ["Now playing: demo song"],
    tone_bias: "short reply"
  };
  const contextPolicy = {
    route: "smalltalk",
    recentContextLimit: 6,
    includeLivingMemory: false,
    consumeModuleMemoryEvents: false
  };

  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "Live room" },
    "Recent danmaku:\n[1] Alice: hello",
    baseConfig,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reply_route, "smalltalk");
      assert.equal(body.latency_trace_id, "reply_test");
      assert.deepEqual(body.active_context, activeContext);
      assert.deepEqual(body.context_policy, contextPolicy);
      return responseJson(200, {
        ok: true,
        text: "hello back",
        state: "SPEAKING",
        source: "astrbot",
        route: "smalltalk",
        latency_breakdown: {
          memory_recall_ms: 0,
          llm_total_ms: 42,
          total_ms: 50
        }
      });
    },
    {
      roomSession: true,
      replyRoute: "smalltalk",
      latencyTraceId: "reply_test",
      activeContext,
      contextPolicy
    }
  );

  assert.equal(reply.route, "smalltalk");
  assert.deepEqual(reply.latency_breakdown, {
    memory_recall_ms: 0,
    llm_total_ms: 42,
    total_ms: 50
  });
});

test("proactive idle reply mode is forwarded to astrbot bridge", async () => {
  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "Live room" },
    "Proactive idle prompt",
    baseConfig,
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reply_mode, "proactive_idle");
      assert.equal(body.force_reply, true);
      return responseJson(200, { ok: true, text: "今天可以聊聊游戏和 AI 结合的趣事。", state: "SPEAKING", source: "astrbot" });
    },
    {
      roomSession: true,
      forceReply: true,
      replyMode: "proactive_idle",
      messages: [
        {
          user_id: "user-a",
          nickname: "Alice",
          text: "现在有点安静",
          mentioned: false,
          timestamp: "2026-06-09T12:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(reply.source, "astrbot");
});

test("context summary uses dedicated bridge endpoint", async () => {
  const summary = await summarizeLiveRoomContext(
    baseConfig,
    {
      previousSummary: "Alice likes cozy replies.",
      messages: [
        {
          role: "user",
          user_id: "user-a",
          nickname: "Alice",
          text: "I am preparing a demo this week",
          timestamp: "2026-06-09T00:00:00.000Z"
        }
      ]
    },
    async (url, options) => {
      assert.equal(url, "http://astrbot:18081/live-room/context/summarize");
      assert.equal(options.headers.Authorization, "Bearer secret-token");
      assert.deepEqual(JSON.parse(options.body), {
        room_id: "live-room-dev",
        previous_summary: "Alice likes cozy replies.",
        messages: [
          {
            role: "user",
            user_id: "user-a",
            nickname: "Alice",
            text: "I am preparing a demo this week",
            timestamp: "2026-06-09T00:00:00.000Z"
          }
        ]
      });
      return responseJson(200, { ok: true, summary: "Alice is preparing a demo this week." });
    }
  );

  assert.equal(summary, "Alice is preparing a demo this week.");
});

test("news adapter refresh uses dedicated bridge endpoint", async () => {
  const result = await refreshNewsTopics(
    baseConfig,
    { force: true, reason: "manual_test" },
    async (url, options) => {
      assert.equal(url, "http://astrbot:18081/live-room/capabilities/news/refresh");
      assert.equal(options.headers.Authorization, "Bearer secret-token");
      assert.deepEqual(JSON.parse(options.body), {
        room_id: "live-room-dev",
        force: true,
        reason: "manual_test"
      });
      return responseJson(202, { ok: true, running: true, stage: "queued", topic_count: 0 });
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.stage, "queued");
});

test("news adapter status uses dedicated bridge endpoint", async () => {
  const result = await getNewsRefreshStatus(baseConfig, {}, async (url, options) => {
    assert.equal(url, "http://astrbot:18081/live-room/capabilities/news/status");
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    assert.deepEqual(JSON.parse(options.body), {
      room_id: "live-room-dev",
      include_recent: true
    });
    return responseJson(200, { ok: false, capability: "news_topics", stage: "idle", running: false });
  });

  assert.equal(result.capability, "news_topics");
  assert.equal(result.stage, "idle");
});

test("news adapter topics uses dedicated bridge endpoint", async () => {
  const result = await listNewsTopics(
    baseConfig,
    { query: "AI", limit: 4 },
    async (url, options) => {
      assert.equal(url, "http://astrbot:18081/live-room/capabilities/news/topics");
      assert.equal(options.headers.Authorization, "Bearer secret-token");
      assert.deepEqual(JSON.parse(options.body), {
        room_id: "live-room-dev",
        query: "AI",
        limit: 4
      });
      return responseJson(200, {
        ok: true,
        topics: [{ title: "AI tool update", conversation_starter: "聊聊工具变化？" }]
      });
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.topics.length, 1);
});

test("music intent recognition uses dedicated bridge endpoint and strips stream URLs", async () => {
  const intent = await recognizeMusicIntent(
    { ...session, username: "tester" },
    "Hoshia 帮我点周杰伦晴天",
    baseConfig,
    async (url, options) => {
      assert.equal(url, "http://astrbot:18081/live-room/music/intent");
      assert.equal(options.headers.Authorization, "Bearer secret-token");
      const body = JSON.parse(options.body);
      assert.equal(body.text, "Hoshia 帮我点周杰伦晴天");
      assert.equal(body.music_state.current.title, "Old Song");
      assert.equal(body.music_state.current.stream_url, undefined);
      assert.equal(body.music_state.queue[0].stream_url, undefined);
      return responseJson(200, {
        ok: true,
        intent: {
          intent: "request",
          confidence: 0.93,
          query: "周杰伦 晴天",
          target: { kind: "" },
          reply_hint: "好，帮你点晴天。"
        }
      });
    },
    {
      musicState: {
        enabled: true,
        status: "playing",
        current: { title: "Old Song", artist: "Singer", source: "qqmusic", requested_by: "Alice", stream_url: "/api/music/stream/secret" },
        queue: [{ title: "Queued Song", artist: "Band", source: "qqmusic", requested_by: "Bob", stream_url: "/api/music/stream/secret2" }]
      }
    }
  );

  assert.deepEqual(intent, {
    intent: "request",
    confidence: 0.93,
    query: "周杰伦 晴天",
    queries: [],
    count: 1,
    target: { kind: "" },
    reply_hint: "好，帮你点晴天。",
    source: "astrbot_music_intent"
  });
});

test("music intent recognition normalizes bulk requests", async () => {
  const intent = await recognizeMusicIntent(
    { ...session, username: "tester" },
    "来点 city pop",
    baseConfig,
    async () => responseJson(200, {
      ok: true,
      intent: {
        intent: "request_many",
        confidence: 0.91,
        query: "city pop",
        queries: ["city pop", "日系 city pop", "city pop", "山下达郎", "竹内玛莉亚", "复古都市流行", "extra"],
        count: 10,
        target: { kind: "" },
        reply_hint: "给你排几首 city pop。"
      }
    })
  );

  assert.equal(intent.intent, "request_many");
  assert.equal(intent.count, 5);
  assert.deepEqual(intent.queries, ["city pop", "日系 city pop", "山下达郎", "竹内玛莉亚", "复古都市流行"]);
});

test("music intent recognition safely returns none on bridge failure", async () => {
  const intent = await recognizeMusicIntent(session, "普通聊天", baseConfig, async () => responseJson(502, { ok: false }));
  assert.equal(intent.intent, "none");
  assert.equal(intent.confidence, 0);
  assert.deepEqual(intent.queries, []);
  assert.equal(intent.count, 0);
});

test("astrbot judge skip is returned without fallback", async () => {
  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "直播间弹幕" },
    "最近弹幕：\n[1] Bob: 哈哈",
    baseConfig,
    async () => responseJson(200, {
      ok: true,
      skipped: true,
      source: "heartflow_judge",
      judge: { overall_score: 0.21, should_reply: false },
      latency_ms: 45
    }),
    { roomSession: true, replyTargets: [], messages: [] }
  );

  assert.equal(reply.skipped, true);
  assert.equal(reply.source, "heartflow_judge");
  assert.equal(reply.latency_ms, 45);
  assert.deepEqual(reply.judge, { overall_score: 0.21, should_reply: false });
});

test("astrbot errors fall back to mock when enabled", async () => {
  const reply = await generateAiReply(session, "tts please", baseConfig, async () => responseJson(500, { ok: false }));

  assert.equal(reply.source, "mock_fallback");
  assert.equal(reply.state, "SPEAKING");
  assert.match(reply.text, /TTS|VoxCPM2/);
});

test("astrbot errors return safe gateway error when fallback is disabled", async () => {
  const reply = await generateAiReply(
    session,
    "hello",
    { ...baseConfig, astrbotFallbackToMock: false, astrbotBridgeToken: "" },
    async () => responseJson(200, { ok: true })
  );

  assert.equal(reply.source, "gateway_error");
  assert.equal(reply.state, "ERROR");
  assert.equal(reply.text, "AstrBot bridge is temporarily unavailable.");
});

function responseJson(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}
