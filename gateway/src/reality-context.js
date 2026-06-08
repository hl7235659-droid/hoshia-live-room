const weekdayLabels = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

// 2026 China public holiday schedule per the State Council General Office notice.
// Dates are local calendar dates in Asia/Shanghai. Do not include URLs or secrets in prompts.
const chinaHoliday2026 = [
  { date: "2026-01-01", name: "元旦假期", kind: "holiday" },
  { date: "2026-01-02", name: "元旦假期", kind: "holiday" },
  { date: "2026-01-03", name: "元旦假期", kind: "holiday" },
  { date: "2026-02-14", name: "春节调休上班日", kind: "workday" },
  { date: "2026-02-15", name: "春节假期", kind: "holiday" },
  { date: "2026-02-16", name: "春节假期", kind: "holiday" },
  { date: "2026-02-17", name: "春节假期（农历正月初一）", kind: "holiday" },
  { date: "2026-02-18", name: "春节假期", kind: "holiday" },
  { date: "2026-02-19", name: "春节假期", kind: "holiday" },
  { date: "2026-02-20", name: "春节假期", kind: "holiday" },
  { date: "2026-02-21", name: "春节假期", kind: "holiday" },
  { date: "2026-02-22", name: "春节假期", kind: "holiday" },
  { date: "2026-02-23", name: "春节假期", kind: "holiday" },
  { date: "2026-02-28", name: "春节调休上班日", kind: "workday" },
  { date: "2026-04-04", name: "清明节假期", kind: "holiday" },
  { date: "2026-04-05", name: "清明节假期", kind: "holiday" },
  { date: "2026-04-06", name: "清明节假期", kind: "holiday" },
  { date: "2026-05-01", name: "劳动节假期", kind: "holiday" },
  { date: "2026-05-02", name: "劳动节假期", kind: "holiday" },
  { date: "2026-05-03", name: "劳动节假期", kind: "holiday" },
  { date: "2026-05-04", name: "劳动节假期", kind: "holiday" },
  { date: "2026-05-05", name: "劳动节假期", kind: "holiday" },
  { date: "2026-05-09", name: "劳动节调休上班日", kind: "workday" },
  { date: "2026-06-19", name: "端午节假期", kind: "holiday" },
  { date: "2026-06-20", name: "端午节假期", kind: "holiday" },
  { date: "2026-06-21", name: "端午节假期", kind: "holiday" },
  { date: "2026-09-25", name: "中秋节假期", kind: "holiday" },
  { date: "2026-09-26", name: "中秋节假期", kind: "holiday" },
  { date: "2026-09-27", name: "中秋节假期", kind: "holiday" },
  { date: "2026-10-01", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-02", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-03", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-04", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-05", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-06", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-07", name: "国庆节假期", kind: "holiday" },
  { date: "2026-10-10", name: "国庆节调休上班日", kind: "workday" }
];

const solarTerms2026 = [
  ["2026-01-05", "小寒"],
  ["2026-01-20", "大寒"],
  ["2026-02-04", "立春"],
  ["2026-02-19", "雨水"],
  ["2026-03-05", "惊蛰"],
  ["2026-03-20", "春分"],
  ["2026-04-05", "清明"],
  ["2026-04-20", "谷雨"],
  ["2026-05-05", "立夏"],
  ["2026-05-21", "小满"],
  ["2026-06-05", "芒种"],
  ["2026-06-21", "夏至"],
  ["2026-07-07", "小暑"],
  ["2026-07-23", "大暑"],
  ["2026-08-07", "立秋"],
  ["2026-08-23", "处暑"],
  ["2026-09-07", "白露"],
  ["2026-09-23", "秋分"],
  ["2026-10-08", "寒露"],
  ["2026-10-23", "霜降"],
  ["2026-11-07", "立冬"],
  ["2026-11-22", "小雪"],
  ["2026-12-07", "大雪"],
  ["2026-12-21", "冬至"]
].map(([date, name]) => ({ date, name, kind: "solar_term" }));

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
  /\/home\/ubuntu/i
];

export function buildRealityContext({
  config,
  room,
  batch,
  audienceUsers = [],
  activeConnections = new Map(),
  now = new Date()
}) {
  if (!config?.realityContextEnabled) return [];

  const timezone = config.realityContextTimezone || "Asia/Shanghai";
  const audienceById = new Map(audienceUsers.map((user) => [user.user_id || user.id, user]));
  const lines = [
    "【现实与运行上下文】",
    formatTimeLine(now, timezone),
    ...calendarLines(now, timezone),
    `房间状态：room_id=${safeText(room?.room_id || config.roomId)}；当前在线 ${Number(room?.online || 0)} 人；已注册 ${Number(room?.registered || 0)} 人；房间为朋友限定。`,
    `AI链路：当前 AI_MODE=${safeText(config.aiMode)}；AstrBot bridge ${config.aiMode === "astrbot" ? "已作为回复后端启用" : "未启用，使用本地 mock 回复"}；单人直回模式 ${config.singleUserDirectReplyEnabled ? "开启" : "关闭"}。`,
    ...viewerContextLines(batch, audienceById, activeConnections)
  ];

  if (config.realityContextIncludeOps) {
    lines.push(
      "运行自知：Hoshia 前端是 React/Vite 直播间界面，后端是 Node.js gateway，消息历史在 SQLite 中保存，会话/限流优先使用 Redis，AstrBot bridge 可作为可选 AI 大脑。",
      "安全边界：可以概括自己运行在直播间系统中，但不要透露环境文件、访问凭据、远程登录信息、服务器地址、本地或服务器路径、数据库路径或隧道配置。"
    );
  }

  lines.push(
    "表达要求：时间、节日和运行状态只在用户询问或自然相关时使用；在线时长、弹幕颜色、偏好记忆只用于更贴心的互动，不要机械复述字段名或内部结构。"
  );

  return sanitizeContextLines(lines);
}

export function formatTimeLine(now = new Date(), timezone = "Asia/Shanghai") {
  const parts = dateParts(now, timezone);
  return `当前现实时间：${parts.date} ${parts.time}，${parts.weekday}，时区 ${timezone}，${timePeriod(parts.hour)}。`;
}

export function calendarLines(now = new Date(), timezone = "Asia/Shanghai") {
  const today = localDateKey(now, timezone);
  const lines = [];
  const todayItems = calendarItemsForDate(today);
  if (todayItems.length) {
    lines.push(`今日日历：${todayItems.map(describeCalendarItem).join("；")}。`);
  }

  const upcoming = [...chinaHoliday2026, ...solarTerms2026]
    .map((item) => ({ ...item, days: daysBetween(today, item.date) }))
    .filter((item) => item.days > 0 && item.days <= 7)
    .sort((a, b) => a.days - b.days || a.date.localeCompare(b.date))
    .slice(0, 3);
  if (upcoming.length) {
    lines.push(`近期待办日历：${upcoming.map((item) => `${item.days === 1 ? "明天" : `${item.days}天后`} ${item.name}`).join("；")}。`);
  }

  return lines;
}

export function calendarItemsForDate(dateKey) {
  return [
    ...chinaHoliday2026.filter((item) => item.date === dateKey),
    ...solarTerms2026.filter((item) => item.date === dateKey)
  ];
}

function viewerContextLines(batch, audienceById, activeConnections) {
  const seen = new Set();
  const lines = [];
  for (const item of batch || []) {
    const session = item.session || {};
    const userId = session.user_id;
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);

    const audience = audienceById.get(userId) || {};
    const active = activeConnections.get(userId);
    const currentOnlineSeconds = Number(audience.current_online_seconds ?? (
      active ? Math.max(0, Math.floor((Date.now() - active.connectedAtMs) / 1000)) : 0
    ));
    const totalOnlineSeconds = Number(audience.total_online_seconds || 0) + currentOnlineSeconds;
    const color = safeText(session.danmaku_color || audience.danmaku_color || "未设置");
    const online = audience.online ?? Boolean(active);
    const profile = normalizeProfile(session.ai_profile);
    const profileText = profile?.memory_enabled
      ? `；偏好：称呼「${safeText(profile.preferred_name || session.nickname)}」，回应风格「${safeText(profile.reply_style_text || profile.reply_style || "朋友式") }」${profile.interests ? `，关注「${safeText(profile.interests)}」` : ""}`
      : "；偏好记忆未启用或未提供";

    lines.push(
      `本轮观众 @${safeText(session.nickname || audience.nickname || "观众")}：弹幕颜色 ${color}；当前在线 ${formatDuration(currentOnlineSeconds)}；累计在线约 ${formatDuration(totalOnlineSeconds)}；现在${online ? "在线" : "离线"}${profileText}。`
    );
  }
  return lines.length ? lines : ["本轮没有可用的观众上下文。"];
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
  const localNoon = new Date(`${values.year}-${values.month}-${values.day}T12:00:00+08:00`);
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
    weekday: weekdayLabels[localNoon.getUTCDay()],
    hour: Number(values.hour)
  };
}

function localDateKey(date, timezone) {
  return dateParts(date, timezone).date;
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

function describeCalendarItem(item) {
  if (item.kind === "workday") return `${item.name}，今天是调休上班日`;
  if (item.kind === "solar_term") return `二十四节气「${item.name}」`;
  return item.name;
}

function daysBetween(fromDateKey, toDateKey) {
  const from = Date.parse(`${fromDateKey}T00:00:00+08:00`);
  const to = Date.parse(`${toDateKey}T00:00:00+08:00`);
  return Math.round((to - from) / 86400000);
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours >= 1) return `${hours}小时${minutes ? `${minutes}分钟` : ""}`;
  if (minutes >= 1) return `${minutes}分钟`;
  return `${Math.floor(value)}秒`;
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return {
    preferred_name: String(profile.preferred_name || "").trim().slice(0, 32),
    reply_style: String(profile.reply_style || "").trim().slice(0, 32),
    reply_style_text: String(profile.reply_style_text || "").trim().slice(0, 60),
    interests: String(profile.interests || "").trim().slice(0, 160),
    memory_enabled: profile.memory_enabled === true
  };
}

function sanitizeContextLines(lines) {
  return lines
    .map((line) => safeText(line))
    .filter(Boolean)
    .filter((line) => !forbiddenPatterns.some((pattern) => pattern.test(line)));
}

function safeText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 600);
}
