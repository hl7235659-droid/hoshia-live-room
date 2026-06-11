import assert from "node:assert/strict";
import test from "node:test";
import { MusicService, parseLocalMusicControlText, parseMusicRequestText } from "../src/music-service.js";

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

test("local music control parser recognizes common playback commands", () => {
  assert.equal(parseLocalMusicControlText("@Hoshia 切歌")?.intent, "next");
  assert.equal(parseLocalMusicControlText("下一首")?.intent, "next");
  assert.equal(parseLocalMusicControlText("暂停音乐")?.intent, "pause");
  assert.equal(parseLocalMusicControlText("继续播放")?.intent, "resume");
  assert.equal(parseLocalMusicControlText("现在放什么歌")?.intent, "status");
  assert.equal(parseLocalMusicControlText("今天吃什么"), null);
});

test("music service rejects disabled mode and non-admin controls", async () => {
  const service = new MusicService({ ...baseConfig, musicEnabled: false }, { store: new TestStore() });
  assert.equal((await service.requestSong("晴天", { user_id: "u1" })).error, "music_disabled");

  const enabled = new MusicService(baseConfig, { store: new TestStore() });
  assert.equal(enabled.control("pause", { username: "friend" }).error, "music_forbidden");
});

test("music playback completion advances only when current track id matches", () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.current = { id: "track-1", title: "Current", requested_by_id: "u1" };
  service.queue = [{ id: "track-2", title: "Next", requested_by_id: "u2" }];
  service.status = "playing";

  assert.equal(service.completeCurrentTrack("wrong-track", { username: "friend" }).error, "music_target_not_found");
  assert.equal(service.current.title, "Current");
  assert.equal(service.completeCurrentTrack("track-1", { username: "friend" }).ok, true);
  assert.equal(service.current.title, "Next");
  assert.equal(service.status, "playing");
});

test("music playback completion idles when queue is empty", () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.current = { id: "track-1", title: "Current", requested_by_id: "u1" };
  service.queue = [];
  service.status = "playing";

  assert.equal(service.completeCurrentTrack("track-1", { username: "friend" }).ok, true);
  assert.equal(service.current, null);
  assert.equal(service.status, "idle");
});

test("music service allows natural-language playback controls for viewers", async () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.current = {
    id: "track-1",
    title: "Current",
    artist: "Artist",
    requested_by_id: "u1"
  };
  service.queue = [
    { id: "track-2", title: "Next", requested_by_id: "u2" }
  ];
  service.status = "playing";

  assert.equal(service.control("pause", { username: "friend" }, {}, { naturalLanguage: true }).ok, true);
  assert.equal(service.status, "paused");
  assert.equal(service.control("resume", { username: "friend" }, {}, { naturalLanguage: true }).ok, true);
  assert.equal(service.status, "playing");
  assert.equal(service.control("next", { username: "friend" }, {}, { naturalLanguage: true }).ok, true);
  assert.equal(service.current.title, "Next");
});

test("music service removes queued tracks by queue index or requester for natural-language controls", async () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.current = { id: "track-1", title: "Current", requested_by_id: "u-owner" };
  service.queue = [
    { id: "track-2", title: "First", requested_by_id: "u-a" },
    { id: "track-3", title: "Second", requested_by_id: "u-b" },
    { id: "track-4", title: "Third", requested_by_id: "u-a" }
  ];

  const viewer = { user_id: "u-a", username: "friend" };
  assert.equal(service.control("remove", viewer, { queueIndex: 2 }, { naturalLanguage: true }).ok, true);
  assert.deepEqual(service.queue.map((track) => track.title), ["First", "Third"]);
  assert.equal(service.control("remove", viewer, { requestedBySelf: true }, { naturalLanguage: true }).ok, true);
  assert.deepEqual(service.queue.map((track) => track.title), []);
  assert.equal(service.current.title, "Current");
});

test("music service rejects unsafe natural-language remove targets", async () => {
  const service = new MusicService(baseConfig, { store: new TestStore() });
  service.queue = [{ id: "track-1", title: "Queued", requested_by_id: "u1" }];

  assert.equal(service.control("remove", { user_id: "u1", username: "friend" }, { id: "track-1" }, { naturalLanguage: true }).error, "music_forbidden");
  assert.equal(service.control("clear", { user_id: "u1", username: "friend" }, {}, { naturalLanguage: true }).error, "music_forbidden");
  assert.equal(service.control("remove", { user_id: "u1", username: "friend" }, { queueIndex: 3 }, { naturalLanguage: true }).error, "music_target_not_found");
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
  assert.equal(result.track.requested_by, "Friend");
  assert.equal(result.track.requested_by_id, "u1");
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

test("music service skips unplayable search candidates", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const playedTitles = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/api/search/online")) {
      return jsonResponse({
        success: true,
        data: [
          { title: "Broken Candidate", artist: "Plugin", platform: "bilibili" },
          { title: "Playable Candidate", artist: "Plugin", platform: "bilibili" }
        ]
      });
    }
    if (href.includes("/api/play/getMediaSource")) {
      const song = JSON.parse(options.body);
      playedTitles.push(song.title);
      if (song.title === "Broken Candidate") {
        return jsonResponse({ success: false, error: "plugin failed" });
      }
      return jsonResponse({ success: true, data: { url: "/music/playable.mp3" } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const service = new MusicService(baseConfig, { store: new TestStore() });
  const result = await service.requestSong("candidate", { user_id: "u-candidate", username: "friend" });

  assert.equal(result.ok, true);
  assert.deepEqual(playedTitles, ["Broken Candidate", "Playable Candidate"]);
  assert.equal(result.track.title, "Playable Candidate");
});

test("music service bulk requests clamp to five and skip duplicates or unplayable candidates", async (t) => {
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
        plugin: parsed.searchParams.get("plugin"),
        limit: parsed.searchParams.get("limit")
      });
      return jsonResponse({
        success: true,
        data: [
          { title: "Existing Song", artist: "Jay", platform: "QQMusicVIP" },
          { title: "Song 1", artist: "Jay", platform: "QQMusicVIP" },
          { title: "Broken Song", artist: "Jay", platform: "QQMusicVIP" },
          { title: "Song 2", artist: "Jay", platform: "QQMusicVIP" },
          { title: "Song 3", artist: "Jay", platform: "QQMusicVIP" },
          { title: "Song 4", artist: "Jay", platform: "QQMusicVIP" },
          { title: "Song 5", artist: "Jay", platform: "QQMusicVIP" }
        ]
      });
    }
    if (href.includes("/api/play/getMediaSource")) {
      const song = JSON.parse(options.body);
      if (song.title === "Broken Song") {
        return jsonResponse({ success: false, error: "unplayable" });
      }
      return jsonResponse({ success: true, data: { url: `/music/${encodeURIComponent(song.title)}.mp3` } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const service = new MusicService(
    { ...baseConfig, musicQueueMax: 10, musicXiaomusicSearchChain: "musicfree:QQMusicVIP,musicfree:all" },
    { store: new TestStore() }
  );
  service.current = { id: "existing", title: "Existing Song", artist: "Jay", requested_by_id: "u-old" };
  const result = await service.requestSongs({ query: "Jay hot", count: 10 }, {
    user_id: "u-bulk",
    username: "friend",
    nickname: "Friend"
  });

  assert.equal(result.ok, true);
  assert.equal(result.added_count, 5);
  assert.deepEqual(result.tracks.map((track) => track.title), ["Song 1", "Song 2", "Song 3", "Song 4", "Song 5"]);
  assert.deepEqual(searchCalls[0], { plugin: "QQMusicVIP", limit: "12" });
  assert.equal(service.queue.length, 5);
});

test("music service bulk requests use style queries and respect remaining queue space", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const keywords = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/api/search/online")) {
      const parsed = new URL(href);
      const keyword = parsed.searchParams.get("keyword");
      keywords.push(keyword);
      return jsonResponse({
        success: true,
        data: [{ title: `${keyword} Track`, artist: "Style", platform: "QQMusicVIP" }]
      });
    }
    if (href.includes("/api/play/getMediaSource")) {
      const song = JSON.parse(options.body);
      return jsonResponse({ success: true, data: { url: `/music/${encodeURIComponent(song.title)}.mp3` } });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const service = new MusicService(
    { ...baseConfig, musicQueueMax: 5, musicXiaomusicSearchChain: "musicfree:QQMusicVIP" },
    { store: new TestStore() }
  );
  service.current = { id: "current", title: "Current", artist: "Host" };
  service.queue = [
    { id: "q1", title: "Queued 1" },
    { id: "q2", title: "Queued 2" },
    { id: "q3", title: "Queued 3" },
    { id: "q4", title: "Queued 4" }
  ];

  const result = await service.requestSongs({
    query: "deep night R&B",
    queries: ["Chinese R&B", "slow R&B"],
    count: 5
  }, { user_id: "u-style", username: "friend" });

  assert.equal(result.ok, true);
  assert.equal(result.added_count, 1);
  assert.deepEqual(keywords, ["deep night R&B"]);
  assert.equal(service.queue.length, 5);
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
