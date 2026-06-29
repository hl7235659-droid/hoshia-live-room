"use strict";

const axios = require("axios");

const resolverBase = (typeof process !== "undefined" && process.env.QQMUSIC_RESOLVER_URL) || "http://qqmusic-resolver:8190";
const pageSize = 20;

function toMusicItem(item) {
  return {
    id: item.id || item.songmid,
    songmid: item.songmid,
    mediaMid: item.mediaMid,
    file: item._raw && item._raw.file ? item._raw.file : item.file || {},
    title: item.title,
    artist: item.artist,
    album: item.album,
    artwork: item.artwork,
    duration: item.duration,
    platform: "QQMusicVIP"
  };
}

module.exports = {
  platform: "QQMusicVIP",
  version: "0.1.0",
  author: "Hoshia Live Room",
  primaryKey: ["songmid", "mediaMid"],
  cacheControl: "no-cache",
  supportedSearchType: ["music"],

  async search(query, page = 1, type = "music") {
    if (type !== "music") return { isEnd: true, data: [] };
    const response = await axios.get(`${resolverBase}/search`, {
      params: { q: query, page, limit: pageSize },
      timeout: 12000
    });
    const payload = response.data || {};
    if (!payload.success) throw new Error(payload.error || "qqmusic_search_failed");
    const data = (payload.data || []).map(toMusicItem);
    return { isEnd: data.length < pageSize, data };
  },

  async getMediaSource(musicItem, quality = "standard") {
    const response = await axios.post(`${resolverBase}/resolve`, {
      item: musicItem,
      quality
    }, {
      timeout: 12000
    });
    const payload = response.data || {};
    if (!payload.success || !payload.url) throw new Error(payload.error || "qqmusic_unplayable");
    return {
      url: payload.url,
      headers: payload.headers || {}
    };
  }
};
