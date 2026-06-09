import { createHash } from "node:crypto";

const SEARCH_ENDPOINT = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const MUSICU_ENDPOINT = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export function parseCookieMap(cookie) {
  const result = new Map();
  String(cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return;
      result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    });
  return result;
}

export function cookieStatus(cookie) {
  const value = String(cookie || "").trim();
  const map = parseCookieMap(value);
  const rawUin = map.get("uin") || map.get("qqmusic_uin") || map.get("p_uin") || "";
  const uin = normalizeUin(rawUin);
  return {
    configured: Boolean(value),
    qq: uin ? maskUin(uin) : "",
    has_qm_keyst: map.has("qm_keyst"),
    has_skey: map.has("skey") || map.has("p_skey"),
    fingerprint: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : ""
  };
}

export function validateCookie(cookie) {
  const value = String(cookie || "").trim();
  if (!value) return { ok: false, error: "cookie_required" };
  if (value.length > 30000) return { ok: false, error: "cookie_too_large" };
  if (!value.includes("=") || !value.includes(";")) return { ok: false, error: "cookie_format_invalid" };
  return { ok: true, cookie: value };
}

export function normalizeSearchResponse(payload) {
  const list = payload?.data?.song?.list || payload?.data?.list || payload?.list || [];
  return list
    .filter((song) => song && typeof song === "object")
    .map((song) => {
      const albumMid = song.album?.mid || song.album?.pmid || song.albummid || "";
      const mediaMid = song.file?.media_mid || song.file?.strMediaMid || song.strMediaMid || song.mid || "";
      const singers = Array.isArray(song.singer)
        ? song.singer.map((item) => item?.name || item).filter(Boolean).join(" / ")
        : song.singer || song.artist || "";
      return {
        id: song.id || song.songid || song.mid,
        songmid: song.mid || song.songmid || "",
        mediaMid,
        title: song.name || song.title || "",
        artist: singers,
        album: song.album?.name || song.albumname || "",
        artwork: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : "",
        duration: Number(song.interval || song.duration || 0) || 0,
        platform: "QQMusicVIP",
        _raw: song
      };
    })
    .filter((item) => item.songmid && item.title);
}

export async function searchQqMusic({ query, page = 1, limit = 20, cookie = "", fetchImpl = fetch, timeoutMs = 12000 }) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return { success: false, error: "query_required", data: [] };

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("ct", "24");
  url.searchParams.set("qqmusic_ver", "1298");
  url.searchParams.set("new_json", "1");
  url.searchParams.set("remoteplace", "txt.yqq.song");
  url.searchParams.set("searchid", String(Date.now()).slice(-10));
  url.searchParams.set("t", "0");
  url.searchParams.set("aggr", "1");
  url.searchParams.set("cr", "1");
  url.searchParams.set("catZhida", "1");
  url.searchParams.set("lossless", "0");
  url.searchParams.set("p", String(Math.max(1, Number(page) || 1)));
  url.searchParams.set("n", String(Math.max(1, Math.min(Number(limit) || 20, 50))));
  url.searchParams.set("w", cleanQuery);
  url.searchParams.set("format", "json");
  url.searchParams.set("g_tk", "5381");

  const payload = await fetchJson(url, {
    fetchImpl,
    timeoutMs,
    headers: qqHeaders(cookie)
  });
  if (payload?.code && payload.code !== 0) return { success: false, error: `qq_search_${payload.code}`, data: [] };
  const data = normalizeSearchResponse(payload);
  return { success: true, data, total: Number(payload?.data?.song?.totalnum || data.length) || data.length };
}

export async function resolveQqMusic({ item, cookie = "", quality = "vip", fetchImpl = fetch, timeoutMs = 12000 }) {
  const music = normalizeResolveItem(item);
  if (!music.songmid || !music.mediaMid) return { success: false, error: "song_id_missing" };

  const uin = normalizeUin(parseCookieMap(cookie).get("uin") || parseCookieMap(cookie).get("qqmusic_uin") || "0") || "0";
  const candidates = buildFilenameCandidates(music, quality);
  if (!candidates.length) return { success: false, error: "media_id_missing" };

  for (const filename of candidates) {
    const payload = await fetchJson(musicuUrl(music.songmid, filename, uin), {
      fetchImpl,
      timeoutMs,
      headers: qqHeaders(cookie)
    }).catch((error) => ({ __error: error }));
    if (payload?.__error || payload?.code) continue;
    const data = payload?.req_0?.data;
    const info = data?.midurlinfo?.[0];
    const purl = info?.purl || "";
    const sip = payload?.req?.data?.sip || data?.sip || [];
    if (purl && sip.length) {
      return {
        success: true,
        url: new URL(purl, sip[0]).toString(),
        quality: qualityFromFilename(filename),
        filename,
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          referer: "https://y.qq.com/"
        }
      };
    }
  }

  return { success: false, error: "qqmusic_unplayable" };
}

export function normalizeResolveItem(item) {
  const raw = item?._raw || item?.raw || item || {};
  const file = raw.file || item?.file || {};
  return {
    songmid: item?.songmid || raw.mid || raw.songmid || "",
    mediaMid: item?.mediaMid || file.media_mid || file.strMediaMid || raw.strMediaMid || raw.mid || "",
    file
  };
}

function musicuUrl(songmid, filename, uin) {
  const data = {
    req: {
      module: "CDN.SrfCdnDispatchServer",
      method: "GetCdnDispatch",
      param: { guid: "10000", calltype: 0, userip: "" }
    },
    req_0: {
      module: "vkey.GetVkeyServer",
      method: "CgiGetVkey",
      param: {
        guid: "10000",
        songmid: [songmid],
        filename: [filename],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: "20"
      }
    },
    comm: { uin, format: "json", ct: 24, cv: 0 }
  };
  return `${MUSICU_ENDPOINT}?data=${encodeURIComponent(JSON.stringify(data))}`;
}

function buildFilenameCandidates(music, quality) {
  const mediaMid = music.mediaMid;
  const file = music.file || {};
  const highFirst = [
    file.size_flac ? `F000${mediaMid}.flac` : "",
    file.size_320 || file.size_320mp3 ? `M800${mediaMid}.mp3` : "",
    file.size_192aac ? `C600${mediaMid}.m4a` : "",
    file.size_128 || file.size_128mp3 ? `M500${mediaMid}.mp3` : "",
    `C400${mediaMid}.m4a`
  ].filter(Boolean);
  const standardFirst = [`C400${mediaMid}.m4a`, `M500${mediaMid}.mp3`, ...highFirst].filter(Boolean);
  const selected = String(quality || "").toLowerCase() === "standard" ? standardFirst : highFirst;
  return [...new Set(selected)];
}

function qualityFromFilename(filename) {
  if (filename.startsWith("F000")) return "flac";
  if (filename.startsWith("M800")) return "320mp3";
  if (filename.startsWith("C600")) return "192aac";
  if (filename.startsWith("M500")) return "128mp3";
  if (filename.startsWith("C400")) return "m4a";
  return "unknown";
}

function qqHeaders(cookie) {
  const headers = {
    "user-agent": DEFAULT_USER_AGENT,
    referer: "https://y.qq.com/",
    origin: "https://y.qq.com"
  };
  const cleanCookie = String(cookie || "").trim();
  if (cleanCookie) headers.cookie = cleanCookie;
  return headers;
}

async function fetchJson(url, { fetchImpl, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUin(value) {
  return String(value || "").replace(/^o/, "").replace(/\D/g, "");
}

function maskUin(value) {
  const clean = normalizeUin(value);
  if (clean.length <= 4) return clean ? "****" : "";
  return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
}
