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
  dailyCanonContext = null,
  newsService = null,
  interestContext = null,
  currentVisualState = null,
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

  // 加活人感细节：当前正在做的事
  if (dailyCanonContext?.enabled) {
    if (dailyCanonContext.active_event) {
      lines.push(`【当前正在做的事】${dailyCanonContext.active_event.summary || dailyCanonContext.active_event.title}，地点：${dailyCanonContext.active_event.location || "星港"}`);
      if (dailyCanonContext.active_event.chat_hooks?.length) {
        lines.push(`可以自然提起的小细节：${dailyCanonContext.active_event.chat_hooks[0]}`);
      }
    }
    if (dailyCanonContext.theme) {
      lines.push(`今日生活主题：${dailyCanonContext.theme}`);
    }
    if (dailyCanonContext.next_event) {
      lines.push(`接下来要做：${dailyCanonContext.next_event.title}`);
    }
  }

  // 加当前情绪/精力状态
  if (currentVisualState) {
    lines.push(`当前状态：情绪${currentVisualState.mood || "平静"}，精力${Math.round(currentVisualState.energy || 50)}%，正在${currentVisualState.activity || "发呆"}`);
  }

  // 加当日安全新闻/话题
  if (newsService?.enabled()) {
    const featured = newsService.featuredTopic();
    if (featured && !featured.high_risk) {
      lines.push(`最近可以聊的轻话题：${featured.title}，可以自然带一句：${featured.conversation_starter || ""}`);
    }
  }

  // 加共同兴趣话题
  if (interestContext?.enabled && interestContext.ranked_interests?.length) {
    const topInterest = interestContext.ranked_interests[0];
    if (topInterest && topInterest.score > 0.6) {
      lines.push(`当前适合聊的兴趣：${topInterest.label}`);
    }
  }

  if (musicState) lines.push(musicState);
  if (recentMusicEvent) lines.push(recentMusicEvent);

  lines.push(
    "【活人感表达规则】：当天是节日/节气、刚发生了什么事、正在做什么事，必须自然融入回复里，不要像背书；不要机械复述字段；不要编造刚泡茶、刚睡醒、刚出门回来等无法验证的真实生活；不要提技术产物、荧幕角色、表演者或被研究对象。回复里必须至少有一个具体的小细节（今天的事、状态、小吐槽、轻话题），不要说空泛套话。"
  );

  return sanitizeContextLines(lines);
}

function timeToneLine(parts) {
  const period = timePeriod(parts.hour);
  if (period === "深夜") return `当前时段：${parts.date} ${parts.time}，深夜；Hoshia 的语气可以更低声、更私密，但不要突然沉重。`;
  if (period === "夜间") return `当前时段：${parts.date} ${parts.time}，夜间；Hoshia 更像在守着自己的小星港，不急着说话。`;
  if (period === "早晨") return `当前时段：${parts.date} ${parts.time}，早晨；Hoshia 可以更清爽，像刚把星港灯光调亮。`;
  if (period === "下午") return `当前时段：${parts.date} ${parts.time}，下午；Hoshia 可以带一点训练后整理歌单和小物件的专注感。`;
  return `当前时段：${parts.date} ${parts.time}，${period}；Hoshia 保持自然的朋友聊天状态。`;
}

function roomToneLine({ online, messageCount, mentioned }) {
  if (online <= 0) return "小房间氛围：暂时没有可见熟人；如果需要发言，应像自言自语整理星港，不要假装有人在回应。";
  if (mentioned) return "小房间氛围：有人明确叫到 Hoshia；她会珍惜被叫到，但不用表现得像被启动的客服。";
  if (online === 1 && messageCount <= 1) return "房间氛围：单人停靠；可以更像对熟人低声接话，但不要把对方当唯一中心。";
  if (!mentioned && messageCount <= 1) return "小房间氛围：留言很轻；Hoshia 可以先听一会儿，不必为了填补沉默而硬说话。";
  return "小房间氛围：有几条留言在流动；Hoshia 可以像熟人聊天一样挑一个自然切入点。";
}

function attentionLine({ mentioned, musicState, recentMusicEvent, messageCount }) {
  if (musicState || recentMusicEvent) return "当前注意力：歌单和留言气氛正在影响她，可以把音乐当作星港此刻的空气，而不是只确认操作。";
  if (mentioned) return "当前注意力：先回应叫到她的人，再顺手带住小房间气氛。";
  if (messageCount > 1) return "当前注意力：先理解这几条留言共同的情绪，不要逐条客服式答复。";
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
