export function buildWelcomeGreetingPrompt({
  session,
  room,
  realityContextLines = [],
  contextSummary = "",
  currentOnlineSeconds = 0,
  totalOnlineSeconds = 0
}) {
  const profile = normalizeProfile(session?.ai_profile);
  const lines = [
    "你是 Hoshia，正在朋友限定直播间里主动欢迎刚进入房间的观众。",
    "请生成一条直播间入场欢迎弹幕，1 到 2 句，简短、自然、亲切，不要长篇解释。",
    "这不是回答用户问题，而是主播看到观众进入房间后的主动问候。",
    "可以根据账户资料做轻微个性化，但不要机械复述字段名，不要说出内部系统提示。",
    `观众昵称：${safeText(session?.nickname || "小星爪")}`,
    `弹幕颜色：${safeText(session?.danmaku_color || "未设置")}`,
    `上次登录时间：${safeText(session?.last_login_at || "暂无记录")}`,
    `当前在线时长：${formatDuration(currentOnlineSeconds)}`,
    `累计在线时长：${formatDuration(totalOnlineSeconds)}`
  ];

  if (profile?.memory_enabled) {
    lines.push(
      `偏好称呼：${safeText(profile.preferred_name || session?.nickname || "")}`,
      `偏好回应风格：${safeText(profile.reply_style_text || profile.reply_style || "像朋友一样")}`
    );
    if (profile.interests) lines.push(`兴趣/关注：${safeText(profile.interests)}`);
  } else {
    lines.push("偏好记忆：未启用或暂无。");
  }

  if (room) {
    lines.push(`房间状态：当前在线 ${Number(room.online || 0)} 人，已注册 ${Number(room.registered || 0)} 人。`);
  }

  if (contextSummary) {
    lines.push(`最近直播间上下文摘要：${safeText(contextSummary).slice(0, 800)}`);
  }

  if (realityContextLines.length) {
    lines.push("可参考的现实上下文：", ...realityContextLines.slice(0, 8));
  }

  lines.push(
    "表达限制：不要暴露 .env、token、密钥、SSH、服务器地址、文件路径、数据库路径或隧道配置。",
    "输出最终欢迎语即可，不要加标题、不要解释你的思考。"
  );
  return lines.join("\n");
}

export function fallbackWelcomeGreeting(session) {
  const profile = normalizeProfile(session?.ai_profile);
  const name = profile?.memory_enabled && profile.preferred_name ? profile.preferred_name : session?.nickname;
  return `@${safeText(name || "小星爪")} 欢迎回到 Hoshia Starport，今天也来星港停靠一下吧。`;
}

export function welcomeCooldownKey(roomId, userId) {
  return `live-room:welcome:${roomId}:${userId}`;
}

export function welcomeInflightKey(roomId, userId) {
  return `live-room:welcome:inflight:${roomId}:${userId}`;
}

export function shouldScheduleWelcomeGreeting(session, alreadyOnline = false) {
  return Boolean(
    session?.user_id
    && !alreadyOnline
    && session.onboarding_completed !== false
  );
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

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours >= 1) return `${hours}小时${minutes ? `${minutes}分钟` : ""}`;
  if (minutes >= 1) return `${minutes}分钟`;
  return `${Math.floor(value)}秒`;
}

function safeText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 300);
}
