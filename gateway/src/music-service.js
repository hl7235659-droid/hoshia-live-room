import { Readable } from "node:stream";
import { nanoid } from "nanoid";

const xiaomusicSupportedSchemes = new Set(["http:", "https:"]);

export function parseMusicRequestText(text) {
  const value = String(text || "").trim();
  if (!value) return "";

  const slash = value.match(/^\/song\s+(.{1,160})$/i);
  if (slash) return slash[1].trim();

  const direct = value.match(/^点歌\s*[：: ]?\s*(.{1,160})$/i);
  if (direct) return direct[1].trim();

  const mentionCleaned = value
    .replace(/@(?:Hoshia|hoshia|星娅|主播)\s*/gi, "")
    .trim();
  const mentioned = mentionCleaned.match(/^点歌\s*[：: ]?\s*(.{1,160})$/i);
  return mentioned ? mentioned[1].trim() : "";
}

export class MusicService {
  constructor(config, { store }) {
    this.config = config;
    this.store = store;
    this.status = "idle";
    this.current = null;
    this.queue = [];
    this.lastError = "";
    this.tracks = new Map();
  }

  isAdmin(session) {
    const username = String(session?.username || "").trim().toLowerCase();
    return Boolean(username && this.config.musicAdminUsernames.includes(username));
  }

  publicState(session) {
    return {
      ok: true,
      enabled: Boolean(this.config.musicEnabled),
      provider: this.config.musicProvider,
      status: this.status,
      current: this.publicTrack(this.current),
      queue: this.queue.map((track) => this.publicTrack(track)),
      last_error: this.lastError,
      can_control: this.isAdmin(session),
      timestamp: new Date().toISOString()
    };
  }

  async requestSong(query, session) {
    const cleanQuery = String(query || "").trim().slice(0, 160);
    if (!this.config.musicEnabled) return this.fail("music_disabled");
    if (!cleanQuery) return this.fail("music_query_required");
    if (this.queue.length >= this.queueMax()) return this.fail("music_queue_full");
    if (!(await this.consumeRequestLimit(session?.user_id || "anonymous"))) {
      return this.fail("music_rate_limited");
    }

    this.status = this.current ? this.status : "loading";
    try {
      const song = await this.resolveSong(cleanQuery);
      const track = {
        id: nanoid(12),
        title: song.title || cleanQuery,
        artist: song.artist || "",
        album: song.album || "",
        cover: song.cover || "",
        duration: Number(song.duration || 0) || 0,
        source: song.source || this.config.musicProvider,
        streamUrl: song.streamUrl,
        streamHeaders: song.streamHeaders || {},
        requested_by: session?.nickname || "",
        requested_by_id: session?.user_id || "",
        requested_at: new Date().toISOString()
      };
      this.tracks.set(track.id, track);
      if (!this.current) {
        this.current = track;
        this.status = "playing";
      } else {
        this.queue.push(track);
        if (this.status === "loading") this.status = "playing";
      }
      this.lastError = "";
      return { ok: true, track: this.publicTrack(track), state: this.publicState(session) };
    } catch (error) {
      this.status = this.current ? "error" : "idle";
      return this.fail(safeMusicError(error));
    }
  }

  control(action, session, payload = {}) {
    if (!this.config.musicEnabled) return this.fail("music_disabled");
    if (!this.isAdmin(session)) return this.fail("music_forbidden");

    const value = String(action || "").trim().toLowerCase();
    if (value === "play" || value === "resume") {
      if (!this.current) this.current = this.queue.shift() || null;
      this.status = this.current ? "playing" : "idle";
    } else if (value === "pause") {
      if (this.current) this.status = "paused";
    } else if (value === "next") {
      this.current = this.queue.shift() || null;
      this.status = this.current ? "playing" : "idle";
    } else if (value === "remove") {
      const id = String(payload.id || "");
      this.queue = this.queue.filter((track) => track.id !== id);
      if (this.current?.id === id) {
        this.current = this.queue.shift() || null;
        this.status = this.current ? "playing" : "idle";
      }
    } else if (value === "clear") {
      this.queue = [];
    } else {
      return this.fail("music_control_invalid");
    }

    this.lastError = "";
    return { ok: true, state: this.publicState(session) };
  }

  async streamTrack(trackId, req, res) {
    if (!this.config.musicEnabled) {
      res.status(404).json({ error: "music_disabled" });
      return;
    }
    const track = this.tracks.get(String(trackId || ""));
    if (!track?.streamUrl) {
      res.status(404).json({ error: "music_track_not_found" });
      return;
    }

    const target = this.resolveProviderUrl(track.streamUrl);
    const headers = {
      "user-agent": track.streamHeaders.userAgent || track.streamHeaders["user-agent"] || "HoshiaLiveRoom/1.0",
      ...track.streamHeaders
    };
    if (req.headers.range) headers.range = req.headers.range;

    const response = await fetch(target, { headers, redirect: "follow" });
    if (!response.ok || !response.body) {
      res.status(502).json({ error: "music_stream_failed" });
      return;
    }

    res.status(response.status);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(response.body).pipe(res);
  }

  async resolveSong(query) {
    if (this.config.musicProvider !== "xiaomusic") throw new Error("music_provider_unsupported");
    const baseUrl = normalizedBaseUrl(this.config.musicProviderBaseUrl);
    if (!baseUrl) throw new Error("music_provider_unavailable");

    if (isHttpUrl(query)) {
      return await this.resolveXiaomusicUrlSong(baseUrl, query);
    }

    const attempts = parseXiaomusicSearchChain(this.config.musicXiaomusicSearchChain);
    const errors = [];
    for (const attempt of attempts) {
      try {
        return await this.resolveXiaomusicSong(baseUrl, query, attempt);
      } catch (error) {
        errors.push(`${attempt.label}:${safeMusicError(error)}`);
      }
    }

    const hasUnplayable = errors.some((item) => item.includes("music_unplayable"));
    const hasNotFound = errors.length > 0 && errors.every((item) => item.includes("music_not_found"));
    throw new Error(hasUnplayable ? "music_unplayable" : hasNotFound ? "music_not_found" : "music_provider_unavailable");
  }

  async resolveXiaomusicSong(baseUrl, query, attempt) {
    const searchUrl = new URL("/api/search/online", baseUrl);
    searchUrl.searchParams.set("keyword", query);
    searchUrl.searchParams.set("plugin", attempt.plugin);
    searchUrl.searchParams.set("page", "1");
    searchUrl.searchParams.set("limit", "8");
    searchUrl.searchParams.set("api_type", String(attempt.apiType));

    const search = await fetchJson(searchUrl, { timeoutMs: this.config.musicProviderTimeoutMs });
    if (search && search.success === false) throw new Error(search.error || "music_provider_unavailable");
    const song = findFirstSong(search);
    if (!song) throw new Error("music_not_found");

    const media = await fetchJson(new URL("/api/play/getMediaSource", baseUrl), {
      method: "POST",
      body: JSON.stringify(song),
      headers: { "content-type": "application/json" },
      timeoutMs: this.config.musicProviderTimeoutMs
    });
    if (media && media.success === false) throw new Error(media.error || "music_unplayable");

    const streamUrl = extractMediaUrl(media) || song.url;
    if (!streamUrl) throw new Error("music_unplayable");

    return {
      title: song.title || song.name || query,
      artist: artistText(song),
      album: song.album || song.albumName || "",
      cover: song.cover || song.artwork || song.albumPic || "",
      duration: song.duration || song.interval || 0,
      source: normalizeSource(song.platform || song.source || attempt.label),
      streamUrl,
      streamHeaders: media?.headers || media?.data?.headers || {}
    };
  }

  async resolveXiaomusicUrlSong(baseUrl, url) {
    const cleanUrl = String(url || "").trim();
    const proxyUrl = new URL("/api/proxy/real-url", baseUrl);
    proxyUrl.searchParams.set("url", cleanUrl);

    const response = await fetch(proxyUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(this.config.musicProviderTimeoutMs)
    });
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`music_provider_http_${response.status}`);
    }

    const location = response.headers.get("location");
    const streamUrl = location ? new URL(location, baseUrl).toString() : cleanUrl;
    if (!isHttpUrl(streamUrl)) throw new Error("music_unplayable");

    return {
      title: urlTitle(cleanUrl),
      artist: urlHost(cleanUrl),
      album: "",
      cover: "",
      duration: 0,
      source: "xiaomusic-url",
      streamUrl,
      streamHeaders: {}
    };
  }

  resolveProviderUrl(value) {
    const url = new URL(String(value || ""), normalizedBaseUrl(this.config.musicProviderBaseUrl));
    if (!xiaomusicSupportedSchemes.has(url.protocol)) throw new Error("music_url_invalid");
    return url;
  }

  publicTrack(track) {
    if (!track) return null;
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      cover: track.cover,
      duration: track.duration,
      source: track.source,
      requested_by: track.requested_by,
      requested_by_id: track.requested_by_id,
      requested_at: track.requested_at,
      stream_url: `/api/music/stream/${encodeURIComponent(track.id)}`
    };
  }

  fail(error) {
    this.lastError = error;
    return { ok: false, error, state: this.publicState(null) };
  }

  queueMax() {
    return Math.max(1, Math.min(Number(this.config.musicQueueMax || 20), 100));
  }

  async consumeRequestLimit(userId) {
    const limit = Math.max(1, Number(this.config.musicRequestLimitCount || 3));
    const windowSeconds = Math.max(5, Number(this.config.musicRequestWindowSeconds || 60));
    const key = `live-room:music-rate:${userId}`;
    const count = await this.store.incr(key);
    if (count === 1) await this.store.expire(key, windowSeconds);
    return count <= limit;
  }
}

function parseXiaomusicSearchChain(value) {
  const raw = String(value || "lx:tx,musicfree:all")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const attempts = raw
    .map((item) => {
      const [kindRaw, pluginRaw] = item.split(":");
      const kind = String(kindRaw || "").trim().toLowerCase();
      const plugin = String(pluginRaw || "all").trim() || "all";
      if (kind === "lx" || kind === "lxserver" || kind === "qq" || kind === "qqmusic" || kind === "tx") {
        return { label: plugin === "tx" ? "qqmusic" : `lx:${plugin}`, apiType: 2, plugin };
      }
      if (kind === "musicfree" || kind === "freemusic" || kind === "mf") {
        return { label: "musicfree", apiType: 1, plugin };
      }
      return null;
    })
    .filter(Boolean);
  return attempts.length ? attempts : [
    { label: "qqmusic", apiType: 2, plugin: "tx" },
    { label: "musicfree", apiType: 1, plugin: "all" }
  ];
}

function normalizeSource(value) {
  const source = String(value || "").trim();
  if (source === "tx") return "qqmusic";
  return source || "xiaomusic";
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function urlHost(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function urlTitle(value) {
  try {
    const url = new URL(String(value || ""));
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return last || url.hostname.replace(/^www\./, "") || "URL 点歌";
  } catch {
    return "URL 点歌";
  }
}

async function fetchJson(url, { timeoutMs = 12000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`music_provider_http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizedBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

function findFirstSong(payload) {
  const arrays = [];
  collectArrays(payload, arrays);
  for (const array of arrays) {
    const song = array.find((item) => item && typeof item === "object" && (item.title || item.name) && !item.data);
    if (song) return song;
  }
  return null;
}

function collectArrays(value, arrays) {
  if (Array.isArray(value)) {
    arrays.push(value);
    for (const item of value) collectArrays(item, arrays);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value)) collectArrays(item, arrays);
}

function extractMediaUrl(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.url === "string" && value.url) return value.url;
  if (typeof value.data?.url === "string" && value.data.url) return value.data.url;
  if (typeof value.mediaSource?.url === "string" && value.mediaSource.url) return value.mediaSource.url;
  if (typeof value.data?.mediaSource?.url === "string" && value.data.mediaSource.url) return value.data.mediaSource.url;
  return "";
}

function artistText(song) {
  if (typeof song.artist === "string") return song.artist;
  if (song.artist?.name) return song.artist.name;
  if (Array.isArray(song.artists)) return song.artists.map((item) => item?.name || item).filter(Boolean).join(", ");
  return song.singer || song.author || "";
}

function safeMusicError(error) {
  const message = String(error?.message || error || "");
  if (message.includes("not_found")) return "music_not_found";
  if (message.includes("unplayable")) return "music_unplayable";
  if (message.includes("provider")) return "music_provider_unavailable";
  if (message.includes("abort")) return "music_provider_timeout";
  return "music_request_failed";
}
