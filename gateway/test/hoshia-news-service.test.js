import assert from "node:assert/strict";
import test from "node:test";
import {
  HoshiaNewsService,
  normalizeHoshiaNewsConfig,
  sanitizeNewsStatus,
  sanitizeNewsTopic,
  sanitizeNewsTopics
} from "../src/hoshia-news-service.js";

const baseConfig = {
  hoshiaNewsEnabled: true,
  hoshiaNewsDailyLimit: 2,
  hoshiaNewsMaxAgeMinutes: 60,
  roomId: "live-room-dev",
  astrbotBridgeUrl: "http://astrbot:18081/live-room/generate",
  astrbotBridgeToken: "secret-token",
  astrbotTimeoutMs: 100
};

test("news service refresh status and topics use adapter successfully", async () => {
  const calls = [];
  const service = new HoshiaNewsService(baseConfig, {
    adapter: {
      async refreshNewsTopics(options, payload) {
        calls.push(["refresh", options.roomId, payload]);
        return { ok: true, stage: "queued", running: true, topic_count: 0 };
      },
      async getNewsRefreshStatus() {
        calls.push(["status"]);
        return {
          ok: true,
          capability: "news_topics",
          stage: "done",
          running: false,
          finished_at: new Date().toISOString(),
          topic_count: 2,
          stored_count: 2,
          recent_titles: ["AI tool update", "Space launch"]
        };
      },
      async listNewsTopics() {
        calls.push(["topics"]);
        return {
          ok: true,
          topics: [
            {
              title: "AI tool update",
              what_happened: "A new model feature was released.",
              hoshia_take: "This could make small projects easier.",
              conversation_starter: "你会想试这种新工具吗？",
              category: "tech",
              created_at: new Date().toISOString()
            }
          ]
        };
      }
    }
  });

  const refresh = await service.refresh({ reason: "manual" });
  const status = await service.status();
  const topics = await service.topics();

  assert.equal(refresh.ok, true);
  assert.equal(refresh.status.stage, "queued");
  assert.equal(status.ok, true);
  assert.equal(status.status.stale, false);
  assert.equal(topics.ok, true);
  assert.equal(topics.topics[0].title, "AI tool update");
  assert.equal(service.refreshCountForDay(), 1);
  assert.deepEqual(calls[0], ["refresh", "live-room-dev", { force: false, reason: "manual" }]);
});

test("news service disabled mode avoids bridge calls", async () => {
  const service = new HoshiaNewsService({ ...baseConfig, hoshiaNewsEnabled: false }, {
    adapter: {
      async refreshNewsTopics() {
        throw new Error("adapter should not be called");
      },
      async getNewsRefreshStatus() {
        throw new Error("adapter should not be called");
      },
      async listNewsTopics() {
        throw new Error("adapter should not be called");
      }
    }
  });

  assert.equal((await service.refresh()).reason, "news_disabled");
  assert.equal((await service.status()).enabled, false);
  assert.deepEqual((await service.topics()).topics, []);
});

test("news bridge mode can target AstrBot while main AI mode uses HoshiaClaw", () => {
  const config = normalizeHoshiaNewsConfig({
    hoshiaNewsEnabled: true,
    aiMode: "hoshiaclaw",
    hoshiaNewsBridgeMode: "astrbot",
    roomId: "live-room-dev",
    astrbotBridgeUrl: "http://astrbot:18081/live-room/generate",
    astrbotBridgeToken: "secret-token",
    hoshiaClawBridgeUrl: "http://live-room-hoshiaclaw:8080/live-room/generate",
    hoshiaClawBridgeToken: "other-token"
  });

  assert.equal(config.bridgeOptions.aiMode, "astrbot");
  assert.equal(config.bridgeOptions.roomId, "live-room-dev");
  assert.equal(config.bridgeOptions.astrbotBridgeUrl, "http://astrbot:18081/live-room/generate");
});

test("news service returns safe bridge unavailable result", async () => {
  const service = new HoshiaNewsService(baseConfig, {
    adapter: {
      async refreshNewsTopics() {
        throw new Error("connect ECONNREFUSED http://127.0.0.1:18081 token=secret");
      },
      async getNewsRefreshStatus() {
        throw new Error("http://internal/.env failed");
      },
      async listNewsTopics() {
        throw new Error("C:\\secret\\bridge.log failed");
      }
    }
  });

  const refresh = await service.refresh();
  const status = await service.status();
  const topics = await service.topics();

  assert.equal(refresh.reason, "news_bridge_unavailable");
  assert.equal(status.reason, "news_bridge_unavailable");
  assert.equal(topics.reason, "news_bridge_unavailable");
  assert.equal(JSON.stringify({ refresh, status, topics }).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify({ refresh, status, topics }).includes("token"), false);
  assert.equal(JSON.stringify({ refresh, status, topics }).includes(".env"), false);
});

test("news service enforces daily refresh limit", async () => {
  const service = new HoshiaNewsService({ ...baseConfig, hoshiaNewsDailyLimit: 1 }, {
    adapter: {
      async refreshNewsTopics() {
        return { ok: true, stage: "queued", running: true };
      }
    }
  });

  assert.equal((await service.refresh()).ok, true);
  const second = await service.refresh();
  assert.equal(second.ok, false);
  assert.equal(second.reason, "news_daily_limit_reached");
});

test("news safety cleaning strips urls tokens paths internal addresses and stale topics", () => {
  const now = new Date().toISOString();
  const unsafeTopic = sanitizeNewsTopic({
    title: "secret token=abc",
    what_happened: "read http://127.0.0.1:18081/.env",
    hoshia_take: "C:\\Users\\host\\file",
    conversation_starter: "正常聊聊这个变化？",
    category: "tech",
    created_at: now
  });
  assert.equal(unsafeTopic.title, "");
  assert.equal(unsafeTopic.what_happened, "");
  assert.equal(unsafeTopic.hoshia_take, "");
  assert.equal(unsafeTopic.conversation_starter, "正常聊聊这个变化？");

  const stale = sanitizeNewsTopics([
    { title: "Old topic", created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    { title: "Fresh topic", created_at: now }
  ], { maxAgeMs: 60 * 60 * 1000 });
  assert.deepEqual(stale.map((topic) => topic.title), ["Fresh topic"]);

  const status = sanitizeNewsStatus({
    ok: true,
    stage: "done",
    finished_at: now,
    failed_sources: ["http://internal/rss"],
    recent_titles: ["Safe title", "http://internal/rss token=abc"],
    last_error: "C:\\secret\\.env"
  });
  assert.equal(status.failed_sources, undefined);
  assert.equal(status.last_error, undefined);
  assert.deepEqual(status.recent_titles, ["Safe title"]);
});

test("news topics preserve interest frontier categories", () => {
  const now = new Date().toISOString();
  const topics = sanitizeNewsTopics([
    { title: "New anime game discussion", category: "anime_game", post_seed: "聊聊这个角色热度", created_at: now },
    { title: "Classic rock clip returns", category: "music_movie", post_seed: "老摇滚又被翻出来", created_at: now },
    { title: "Campus running trend", category: "sports_campus", post_seed: "操场跑步话题", created_at: now },
    { title: "AI tool workflow", category: "tech_tools", post_seed: "小工具更新", created_at: now },
    { title: "B站热梗", category: "light_trends", post_seed: "这个梗怎么接", created_at: now },
    { title: "Unknown category", category: "finance", post_seed: "泛话题", created_at: now }
  ]);

  assert.deepEqual(topics.map((topic) => topic.category), [
    "anime_game",
    "music_movie",
    "sports_campus",
    "tech_tools",
    "light_trends",
    "general"
  ]);
});

test("news service featured topic prefers Hoshia interest categories", () => {
  const service = new HoshiaNewsService(baseConfig);
  service.setCachedTopics(sanitizeNewsTopics([
    {
      title: "General topic",
      category: "general",
      post_seed: "泛热点",
      reaction_style: "轻轻接",
      created_at: new Date().toISOString()
    },
    {
      title: "Anime game topic",
      category: "anime_game",
      post_seed: "角色讨论",
      reaction_style: "二次元雷达动了一下",
      created_at: new Date().toISOString()
    }
  ]));

  assert.equal(service.featuredTopic().category, "anime_game");
});
