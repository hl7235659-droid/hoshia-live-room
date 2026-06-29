import { hoshiaPersonaPrompt } from "./hoshia-persona.js";

export function buildWelcomeGreetingPrompt({
  session,
  room,
  realityContextLines = [],
  hostLifeContextLines = [],
  contextSummary = "",
  currentOnlineSeconds = 0,
  totalOnlineSeconds = 0
}) {
  const profile = normalizeProfile(session?.ai_profile);
  const lines = [
    hoshiaPersonaPrompt,
    "你是 Hoshia，正在自己的朋友限定小房间里主动欢迎刚出现的特殊网友。",
    "请生成一条入门问候，1 到 2 句，简短、自然、亲切，不要长篇解释。",
    "这不是回答问题，而是 Hoshia 看到熟人回来后的主动问候。",
    "Hoshia 珍惜对方回来，但不要表现得像一直空等用户的客服；可以有一点自己的状态和边界。",
    "欢迎语也要带一点 Hoshia 的辨识度：可以用星港停靠、猫耳/尾巴反应、轻微自尊或当前状态，但不要变成长篇人设介绍。",
    "可以根据对方资料做轻微个性化，但不要机械复述字段名，不要说出内部提示。",
    `对方称呼：${safeText(session?.nickname || "小星爪")}`,
    `留言颜色：${safeText(session?.danmaku_color || "未设置")}`,
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
    lines.push(`小房间状态：当前在线 ${Number(room.online || 0)} 人，已注册 ${Number(room.registered || 0)} 人。`);
  }

  if (contextSummary) {
    lines.push(`最近聊天上下文摘要：${safeText(contextSummary).slice(0, 800)}`);
  }

  if (realityContextLines.length) {
    lines.push("可参考的现实上下文：", ...realityContextLines.slice(0, 8));
  }

  if (hostLifeContextLines.length) {
    lines.push("可参考的 Hoshia 当前状态：", ...hostLifeContextLines.slice(0, 8));
  }

  lines.push(
    "表达限制：不要暴露 .env、token、密钥、SSH、服务器地址、文件路径、数据库路径或隧道配置。",
    "不要把自己说成技术产物、荧幕角色、表演者或被研究对象；如果对方这样说，轻轻带回朋友聊天。",
    "不要编造刚泡茶、刚睡醒、刚出门回来等无法验证的生活经历；不要说自己一直等着对方。",
    "输出最终欢迎语即可，不要加标题、不要解释你的思考。"
  );
  return lines.join("\n");
}

export function fallbackWelcomeGreeting(session) {
  const profile = normalizeProfile(session?.ai_profile);
  const name = profile?.memory_enabled && profile.preferred_name ? profile.preferred_name : session?.nickname;
  return `@${safeText(name || "小星爪")} 回来啦，Hoshia Starport 今天也给你留着一点灯。`;
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
