import assert from "node:assert/strict";
import test from "node:test";
import { MusicService, parseMusicRequestText } from "../src/music-service.js";

class TestStore {
  constructor() {
    this.values = new Map();
  }

  async incr(key) {
    const next = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, next);
    return next;
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

test("music command parser accepts slash, direct, and Hoshia mention forms", () => {
  assert.equal(parseMusicRequestText("/song sparkle"), "sparkle");
  assert.equal(parseMusicRequestText("点歌 青花瓷"), "青花瓷");
  assert.equal(parseMusicRequestText("@Hoshia 点歌 晴天"), "晴天");
  assert.equal(parseMusicRequestText("hello 点歌 晴天"), "");
});

test("music service rejects disabled mode and non-admin controls", async () => {
  const service = new MusicService({ ...baseConfig, musicEnabled: false }, { store: new TestStore() });
  assert.equal((await service.requestSong("晴天", { user_id: "u1" })).error, "music_disabled");

  const enabled = new MusicService(baseConfig, { store: new TestStore() });
  assert.equal(enabled.control("pause", { username: "friend" }).error, "music_forbidden");
});

test("music service resolves xiaomusic result and normalizes playback state", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/api/search/online")) {
      return jsonResponse({
        success: true,
        data: {
          list: [{ title: "星间飞行", artist: "Hoshia", url: "/music/hoshia.mp3", duration: 180 }]
        }
      });
    }
    if (href.includes("/api/play/getMediaSource")) {
      return jsonResponse({ success: true, data: { url: "/music/hoshia.mp3" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const service = new MusicService(baseConfig, { store: new TestStore() });
  const result = await service.requestSong("星间飞行", {
    user_id: "u1",
    username: "friend",
    nickname: "Friend"
  });

  assert.equal(result.ok, true);
  assert.equal(result.track.title, "星间飞行");
  assert.equal(result.state.status, "playing");
  assert.equal(result.state.current.title, "星间飞行");
  assert.equal(result.state.current.stream_url.startsWith("/api/music/stream/"), true);
});

test("music service tries QQ/LX first and falls back to MusicFree", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const searchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/api/search/online")) {
      const parsed = new URL(href);
      searchCalls.push({
        apiType: parsed.searchParams.get("api_type"),
        plugin: parsed.searchParams.get("plugin")
      });
      if (parsed.searchParams.get("api_type") === "2") {
        return jsonResponse({ success: false, error: "LX Server接口未配置！" });
      }
      return jsonResponse({
        success: true,
        data: {
          list: [{ title: "Fallback Song", artist: "MusicFree", platform: "musicfree", url: "/music/fallback.mp3" }]
        }
      });
    }
    if (href.includes("/api/play/getMediaSource")) {
      assert.equal(options.method, "POST");
      return jsonResponse({ success: true, data: { url: "/music/fallback.mp3" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const service = new MusicService(
    { ...baseConfig, musicXiaomusicSearchChain: "lx:tx,musicfree:all" },
    { store: new TestStore() }
  );
  const result = await service.requestSong("Fallback Song", { user_id: "u1", username: "friend" });

  assert.equal(result.ok, true);
  assert.deepEqual(searchCalls, [
    { apiType: "2", plugin: "tx" },
    { apiType: "1", plugin: "all" }
  ]);
  assert.equal(result.track.title, "Fallback Song");
  assert.equal(result.track.source, "musicfree");
});

test("music service resolves URL requests through xiaomusic real-url proxy", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method, redirect: options.redirect });
    assert.equal(href.includes("/api/proxy/real-url"), true);
    return {
      ok: false,
      status: 307,
      url: href,
      headers: {
        get(name) {
          return name.toLowerCase() === "location" ? "https://cdn.example.test/audio.m4a" : null;
        }
      }
    };
  };

  const service = new MusicService(baseConfig, { store: new TestStore() });
  const result = await service.requestSong("https://www.bilibili.com/video/BVtest", {
    user_id: "u-url",
    username: "friend"
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].redirect, "manual");
  assert.equal(result.track.source, "xiaomusic-url");
  assert.equal(result.track.artist, "bilibili.com");
  assert.equal(result.state.current.stream_url.startsWith("/api/music/stream/"), true);
});

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    }
  };
}
