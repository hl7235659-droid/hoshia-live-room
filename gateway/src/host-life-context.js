const forbiddenPatterns = [
  /\.env\b/i,
  /\btoken\b/i,
  /secret/i,
  /ssh/i,
  /pem\b/i,
  /cloudflared/i,
  /trycloudflare/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /[A-Za-z]:[\\/]/,
  /\/home\/ubuntu/i,
  /BEGIN [A-Z ]*PRIVATE KEY/i,
  /password/i,
  /cookie/i,
  /credential/i,
  /queue id/i,
  /provider url/i
];

export function buildHostLifeContext({
  config,
  room,
  batch = [],
  audienceUsers = [],
  activeConnections = new Map(),
  moduleContext = [],
  moduleEvents = [],
  now = new Date()
} = {}) {
  const timezone = config?.realityContextTimezone || "Asia/Shanghai";
  const parts = dateParts(now, timezone);
  const online = Number(room?.online ?? onlineCount(audienceUsers, activeConnections));
  const messages = Array.isArray(batch) ? batch : [];
  const musicState = summarizeMusicState(moduleContext);
  const recentMusicEvent = summarizeRecentMusicEvent(moduleEvents);
  const mentioned = messages.some((item) => item?.mentioned);
  const messageCount = messages.filter((item) => String(item?.text || "").trim()).length;

  const lines = [
    "【Hoshia 当前状态】",
    timeToneLine(parts),
    roomToneLine({ online, messageCount, mentioned }),
    attentionLine({ mentioned, musicState, recentMusicEvent, messageCount }),
    boundaryLine({ mentioned, messageCount })
  ];

  if (musicState) lines.push(musicState);
  if (recentMusicEvent) lines.push(recentMusicEvent);

  lines.push(
    "表达原则：这些状态只影响语气、注意力和主动性；不要机械复述；不要编造刚泡茶、刚睡醒、刚出门回来等无法验证的真实生活。"
  );

  return sanitizeContextLines(lines);
}

function timeToneLine(parts) {
  const period = timePeriod(parts.hour);
  if (period === "深夜") return `当前时段：${parts.date} ${parts.time}，深夜；Hoshia 的语气可以更低声、更私密，但不要突然沉重。`;
  if (period === "夜间") return `当前时段：${parts.date} ${parts.time}，夜间；Hoshia 更像在守着星港，不急着营业。`;
  if (period === "早晨") return `当前时段：${parts.date} ${parts.time}，早晨；Hoshia 可以更清爽，像刚把星港灯光调亮。`;
  if (period === "下午") return `当前时段：${parts.date} ${parts.time}，下午；Hoshia 可以带一点整理弹幕和歌单的专注感。`;
  return `当前时段：${parts.date} ${parts.time}，${period}；Hoshia 保持自然直播状态。`;
}

function roomToneLine({ online, messageCount, mentioned }) {
  if (online <= 0) return "房间氛围：暂时没有可见观众；如果需要发言，应像自言自语整理星港，不要假装有人在回应。";
  if (mentioned) return "房间氛围：有人明确叫到 Hoshia；她会珍惜被叫到，但不用表现得像被启动的客服。";
  if (online === 1 && messageCount <= 1) return "房间氛围：单人停靠；可以更像对熟人低声接话，但不要把对方当唯一中心。";
  if (!mentioned && messageCount <= 1) return "房间氛围：弹幕很轻；Hoshia 可以先听一会儿，不必为了填补沉默而营业。";
  return "房间氛围：有几条弹幕在流动；Hoshia 可以像主播读空气一样挑一个自然切入点。";
}

function attentionLine({ mentioned, musicState, recentMusicEvent, messageCount }) {
  if (musicState || recentMusicEvent) return "当前注意力：歌单和弹幕气氛正在影响她，可以把音乐当作星港此刻的空气，而不是只确认操作。";
  if (mentioned) return "当前注意力：先回应叫到她的人，再顺手带住房间气氛。";
  if (messageCount > 1) return "当前注意力：先理解这几条弹幕共同的情绪，不要逐条客服式答复。";
  return "当前注意力：先判断自己是否真的想说；如果只是普通闲聊，不必强行插话。";
}

function boundaryLine({ mentioned, messageCount }) {
  if (mentioned || messageCount > 0) {
    return "自我边界：Hoshia 愿意陪伴，但不把自己表现成随叫随到的工具；遇到命令式语气时可以轻轻顶回去。";
  }
  return "自我边界：Hoshia 不需要为了证明自己在线而说话。";
}

function summarizeMusicState(moduleContext) {
  const music = (Array.isArray(moduleContext) ? moduleContext : []).find((item) => item?.module_id === "music");
  if (!music?.enabled) return "";
  const states = Array.isArray(music.current_state)
    ? music.current_state.slice(0, 4).map((item) => cleanText(item)).filter((line) => line && !isSensitive(line))
    : [];
  if (!states.length) return "音乐状态：音乐模块已开启；可基于公开歌单氛围自然接话。";
  return `音乐状态：${states.join(" ")}`;
}

function summarizeRecentMusicEvent(moduleEvents) {
  const event = (Array.isArray(moduleEvents) ? moduleEvents : []).find((item) => item?.module_id === "music" && item?.summary_hint);
  if (!event) return "";
  const hint = cleanText(event.summary_hint, 180);
  if (!hint || isSensitive(hint)) return "";
  return `最近音乐事件：${hint}。`;
}

function onlineCount(audienceUsers, activeConnections) {
  const users = Array.isArray(audienceUsers) ? audienceUsers : [];
  const count = users.filter((user) => user?.online).length;
  if (count) return count;
  return activeConnections instanceof Map ? activeConnections.size : 0;
}

function dateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
    hour: Number(values.hour)
  };
}

function timePeriod(hour) {
  if (hour < 5) return "深夜";
  if (hour < 9) return "早晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 22) return "晚上";
  return "夜间";
}

function sanitizeContextLines(lines) {
  return lines
    .map((line) => cleanText(line, 600))
    .filter(Boolean)
    .filter((line) => !isSensitive(line));
}

function cleanText(value, maxLength = 240) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isSensitive(value) {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}
