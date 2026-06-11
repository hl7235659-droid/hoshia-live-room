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
    .replace(/@(?:Hoshia|hoshia|星娅)\s*/gi, "")
    .trim();
  const mentioned = mentionCleaned.match(/^点歌\s*[：: ]?\s*(.{1,160})$/i);
  return mentioned ? mentioned[1].trim() : "";
}

export function parseLocalMusicControlText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const value = raw
    .replace(/@(?:Hoshia|hoshia|星娅)\s*/gi, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (!value) return null;

  if (/(现在|当前|正在).*(放|播|唱|歌|队列)|歌单|队列|播放列表|什么歌/.test(value)) {
    return localMusicIntent("status", 0.96, "♪ Hoshia 看了一下当前播放和待播队列。");
  }
  if (/(下一首|下首|切歌|跳过|换歌|换一首|跳下一首)/.test(value)) {
    return localMusicIntent("next", 0.97, "♪ Hoshia 已切到下一首。");
  }
  if (/(上一首|上首|回上一首|返回上一首|前一首)/.test(value)) {
    return localMusicIntent("previous", 0.97, "♪ Hoshia 已切回上一首。");
  }
  if (/(暂停|停一下|先停|停止播放|别放了|关音乐|停音乐|暂停音乐)/.test(value)) {
    return localMusicIntent("pause", 0.97, "♪ Hoshia 已暂停播放。");
  }
  if (/(继续播放|继续放|恢复播放|接着放|播放音乐|放音乐|继续音乐)/.test(value)) {
    return localMusicIntent("resume", 0.97, "♪ Hoshia 已继续播放。");
  }
  return null;
}

export class MusicService {
  constructor(config, { store }) {
    this.config = config;
    this.store = store;
    this.status = "idle";
    this.current = null;
    this.queue = [];
    this.history = [];
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
      can_previous: this.history.length > 0,
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
      const track = this.createTrack(song, cleanQuery, session);
      this.addTrack(track);
      this.lastError = "";
      return { ok: true, track: this.publicTrack(track), state: this.publicState(session) };
    } catch (error) {
      this.status = this.current ? "error" : "idle";
      return this.fail(safeMusicError(error));
    }
  }

  async requestSongs(payload, session) {
    const cleanQueries = normalizeBulkQueries(payload);
    const count = clampBulkCount(payload?.count);
    if (!this.config.musicEnabled) return this.fail("music_disabled");
    if (!cleanQueries.length) return this.fail("music_query_required");
    if (this.queue.length >= this.queueMax()) return this.fail("music_queue_full");
    if (!(await this.consumeRequestLimit(session?.user_id || "anonymous"))) {
      return this.fail("music_rate_limited");
    }

    const available = Math.max(0, this.queueMax() - this.queue.length);
    const targetCount = Math.min(count, available);
    if (targetCount <= 0) return this.fail("music_queue_full");

    this.status = this.current ? this.status : "loading";
    try {
      const songs = await this.resolveSongs(cleanQueries, targetCount);
      const tracks = [];
      for (const song of songs.slice(0, targetCount)) {
        if (this.current && this.queue.length >= this.queueMax()) break;
        const track = this.createTrack(song, song.query || cleanQueries[0], session);
        this.addTrack(track);
        tracks.push(track);
      }
      if (!tracks.length) throw new Error("music_unplayable");

      this.lastError = "";
      return {
        ok: true,
        tracks: tracks.map((track) => this.publicTrack(track)),
        requested_count: count,
        added_count: tracks.length,
        state: this.publicState(session)
      };
    } catch (error) {
      this.status = this.current ? "error" : "idle";
      return this.fail(safeMusicError(error));
    }
  }

  createTrack(song, fallbackTitle, session) {
    return {
      id: nanoid(12),
      title: song.title || fallbackTitle,
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
  }

  addTrack(track) {
    this.tracks.set(track.id, track);
    if (!this.current) {
      this.current = track;
      this.status = "playing";
      return;
    }
    this.queue.push(track);
    if (this.status === "loading") this.status = "playing";
  }

  control(action, session, payload = {}, options = {}) {
    if (!this.config.musicEnabled) return this.fail("music_disabled");

    const value = String(action || "").trim().toLowerCase();
    const isAdmin = this.isAdmin(session);
    const naturalControl = Boolean(options.naturalLanguage === true);
    if (!isAdmin && !isAllowedViewerControl(value, payload, naturalControl)) {
      return this.fail("music_forbidden");
    }

    if (value === "play" || value === "resume") {
      if (!this.current) this.current = this.queue.shift() || null;
      this.status = this.current ? "playing" : "idle";
    } else if (value === "pause") {
      if (this.current) this.status = "paused";
    } else if (value === "next") {
      this.advanceToNext();
    } else if (value === "previous") {
      if (!this.playPrevious()) return this.fail("music_target_not_found");
    } else if (value === "remove") {
      const removed = this.removeTracks(session, payload, { allowCurrent: false });
      if (!removed) return this.fail("music_target_not_found");
    } else if (value === "clear") {
      if (!isAdmin) return this.fail("music_forbidden");
      this.queue = [];
    } else {
      return this.fail("music_control_invalid");
    }

    this.lastError = "";
    return { ok: true, state: this.publicState(session) };
  }

  completeCurrentTrack(trackId, session) {
    if (!this.config.musicEnabled) return this.fail("music_disabled");
    const id = String(trackId || "").trim();
    if (!this.current?.id || !id || this.current.id !== id) {
      return this.fail("music_target_not_found");
    }
    this.advanceToNext();
    this.lastError = "";
    return { ok: true, state: this.publicState(session) };
  }

  advanceToNext() {
    if (this.current) this.pushHistory(this.current);
    this.current = this.queue.shift() || null;
    this.status = this.current ? "playing" : "idle";
  }

  playPrevious() {
    const previous = this.history.pop() || null;
    if (!previous) return false;
    if (this.current) this.queue.unshift(this.current);
    this.current = previous;
    this.status = "playing";
    return true;
  }

  pushHistory(track) {
    if (!track?.id) return;
    this.history = this.history.filter((item) => item.id !== track.id);
    this.history.push(track);
    if (this.history.length > 20) this.history = this.history.slice(-20);
  }

  removeTracks(session, payload = {}, { allowCurrent = false } = {}) {
    const queueIndex = Math.floor(Number(payload.queueIndex ?? payload.queue_index ?? payload.index));
    if (Number.isFinite(queueIndex) && queueIndex >= 1) {
      if (queueIndex > this.queue.length) return 0;
      this.queue.splice(queueIndex - 1, 1);
      return 1;
    }

    const requestedBySelf = Boolean(payload.requestedBySelf ?? payload.requested_by_self);
    if (requestedBySelf) {
      const userId = String(session?.user_id || "");
      if (!userId) return 0;
      const before = this.queue.length;
      this.queue = this.queue.filter((track) => track.requested_by_id !== userId);
      return before - this.queue.length;
    }

    const id = String(payload.id || "");
    if (!id) return 0;
    const before = this.queue.length;
    this.queue = this.queue.filter((track) => track.id !== id);
    let removed = before - this.queue.length;
    if (allowCurrent && this.current?.id === id) {
      this.current = this.queue.shift() || null;
      this.status = this.current ? "playing" : "idle";
      removed += 1;
    }
    return removed;
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

  async resolveSongs(queries, count) {
    if (this.config.musicProvider !== "xiaomusic") throw new Error("music_provider_unsupported");
    const baseUrl = normalizedBaseUrl(this.config.musicProviderBaseUrl);
    if (!baseUrl) throw new Error("music_provider_unavailable");

    const attempts = parseXiaomusicSearchChain(this.config.musicXiaomusicSearchChain);
    const results = [];
    const seen = new Set([
      ...[this.current].filter(Boolean).map(trackSignature),
      ...this.queue.map(trackSignature)
    ].filter(Boolean));
    const errors = [];

    for (const query of queries) {
      if (results.length >= count) break;
      if (isHttpUrl(query)) {
        try {
          const song = await this.resolveXiaomusicUrlSong(baseUrl, query);
          addResolvedSong(results, seen, { ...song, query }, count);
        } catch (error) {
          errors.push(`url:${safeMusicError(error)}`);
        }
        continue;
      }

      for (const attempt of attempts) {
        if (results.length >= count) break;
        let candidates = [];
        try {
          candidates = await this.searchXiaomusicCandidates(baseUrl, query, attempt, 12);
        } catch (error) {
          errors.push(`${attempt.label}:${safeMusicError(error)}`);
          continue;
        }

        for (const candidate of candidates.slice(0, 12)) {
          if (results.length >= count) break;
          if (seen.has(songSignature(candidate))) continue;
          const song = await this.resolveXiaomusicCandidate(baseUrl, query, attempt, candidate).catch((error) => {
            errors.push(`${attempt.label}:${safeMusicError(error)}`);
            return null;
          });
          if (!song) continue;
          addResolvedSong(results, seen, { ...song, query }, count);
        }
      }
    }

    if (results.length) return results;
    const hasUnplayable = errors.some((item) => item.includes("music_unplayable"));
    const hasNotFound = errors.length > 0 && errors.every((item) => item.includes("music_not_found"));
    throw new Error(hasUnplayable ? "music_unplayable" : hasNotFound ? "music_not_found" : "music_provider_unavailable");
  }

  async resolveXiaomusicSong(baseUrl, query, attempt) {
    const candidates = await this.searchXiaomusicCandidates(baseUrl, query, attempt, 8);
    for (const song of candidates.slice(0, 8)) {
      const resolved = await this.resolveXiaomusicCandidate(baseUrl, query, attempt, song).catch(() => null);
      if (resolved) return resolved;
    }

    throw new Error("music_unplayable");
  }

  async searchXiaomusicCandidates(baseUrl, query, attempt, limit = 8) {
    const searchUrl = new URL("/api/search/online", baseUrl);
    searchUrl.searchParams.set("keyword", query);
    searchUrl.searchParams.set("plugin", attempt.plugin);
    searchUrl.searchParams.set("page", "1");
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("api_type", String(attempt.apiType));

    const search = await fetchJson(searchUrl, { timeoutMs: this.config.musicProviderTimeoutMs });
    if (search && search.success === false) throw new Error(search.error || "music_provider_unavailable");
    const candidates = findSongCandidates(search);
    if (!candidates.length) throw new Error("music_not_found");
    return candidates;
  }

  async resolveXiaomusicCandidate(baseUrl, query, attempt, song) {
    const media = await fetchJson(new URL("/api/play/getMediaSource", baseUrl), {
      method: "POST",
      body: JSON.stringify(song),
      headers: { "content-type": "application/json" },
      timeoutMs: this.config.musicProviderTimeoutMs
    });
    if (media && media.success === false) throw new Error("music_unplayable");

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

function normalizeBulkQueries(payload = {}) {
  const values = [
    payload?.query,
    ...(Array.isArray(payload?.queries) ? payload.queries : [])
  ];
  const seen = new Set();
  const queries = [];
  for (const value of values) {
    const query = String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= 5) break;
  }
  return queries;
}

function clampBulkCount(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return 5;
  return Math.max(1, Math.min(number, 5));
}

function addResolvedSong(results, seen, song, count) {
  const signature = trackSignature(song);
  if (!signature || seen.has(signature) || results.length >= count) return false;
  seen.add(signature);
  results.push(song);
  return true;
}

function trackSignature(track) {
  if (!track) return "";
  const title = normalizeSignaturePart(track.title);
  if (!title) return "";
  const artist = normalizeSignaturePart(track.artist);
  return `${title}:${artist}`;
}

function songSignature(song) {
  if (!song || typeof song !== "object") return "";
  const title = normalizeSignaturePart(song.title || song.name);
  if (!title) return "";
  const artist = normalizeSignaturePart(artistText(song));
  return `${title}:${artist}`;
}

function normalizeSignaturePart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[《》"'.,，。:：\-_\[\]()（）]/g, "")
    .trim();
}

function isAllowedViewerControl(action, payload, naturalControl) {
  if (action === "pause" || action === "resume" || action === "play" || action === "next" || action === "previous") return true;
  if (action !== "remove") return false;
  if (payload?.id) return true;
  if (!naturalControl) return false;
  return Boolean(
    payload?.requestedBySelf
    || payload?.requested_by_self
    || Number(payload?.queueIndex ?? payload?.queue_index ?? payload?.index) >= 1
  );
}

function localMusicIntent(intent, confidence, replyHint) {
  return {
    intent,
    confidence,
    query: "",
    queries: [],
    count: 1,
    target: { kind: "" },
    reply_hint: replyHint,
    source: "local_music_control"
  };
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
  return findSongCandidates(payload)[0] || null;
}

function findSongCandidates(payload) {
  const arrays = [];
  collectArrays(payload, arrays);
  const seen = new Set();
  const songs = [];
  for (const array of arrays) {
    for (const item of array) {
      if (!item || typeof item !== "object" || !(item.title || item.name) || item.data) continue;
      const key = `${item.platform || item.source || ""}:${item.id || item.mid || item.url || item.title || item.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(item);
    }
  }
  return songs;
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
