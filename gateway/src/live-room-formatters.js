export function createLiveRoomEventFormatter({ roomId, createId }) {
  return {
    messageEvent(type, role, text, session, extra = {}) {
      const id = createId();
      const event = {
        type,
        id,
        room_id: roomId,
        user_id: session.user_id,
        nickname: session.nickname,
        role,
        text,
        timestamp: new Date().toISOString(),
        danmaku_lane: stableDanmakuLane(id),
        danmaku_speed: 90,
        ...extra
      };
      const danmakuColor = normalizeDanmakuColor(session.danmaku_color || "");
      if (role === "user" && danmakuColor) event.color = danmakuColor;
      return event;
    },

    systemEvent(type, text, extra = {}) {
      const id = createId();
      return {
        type,
        id,
        room_id: roomId,
        role: "system",
        text,
        timestamp: new Date().toISOString(),
        danmaku_lane: stableDanmakuLane(id),
        danmaku_speed: 90,
        ...extra
      };
    }
  };
}

export function musicStatusCode(error) {
  if (error === "music_forbidden") return 403;
  if (error === "music_disabled") return 404;
  if (error === "music_target_not_found") return 404;
  if (error === "music_query_required" || error === "music_control_invalid") return 400;
  if (error === "music_rate_limited") return 429;
  if (error === "music_queue_full") return 409;
  return 502;
}

export function friendlyMusicError(error) {
  if (error === "music_disabled") return "音乐房间还没开启";
  if (error === "music_provider_unavailable") return "音乐服务还没准备好";
  if (error === "music_provider_timeout") return "音乐服务响应超时";
  if (error === "music_not_found") return "没有找到这首歌";
  if (error === "music_unplayable") return "这首歌暂时不能播放";
  if (error === "music_rate_limited") return "点歌太快啦，稍等一下";
  if (error === "music_queue_full") return "队列已经满啦";
  return "音乐服务暂时不可用";
}

function stableDanmakuLane(id) {
  let hash = 0;
  for (const char of String(id || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}

function normalizeDanmakuColor(color) {
  const value = String(color || "").trim();
  if (!value) return "";
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toUpperCase();
}
