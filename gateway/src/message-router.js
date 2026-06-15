const routes = new Set([
  "smalltalk",
  "emotional",
  "project_discussion",
  "factual_question",
  "memory_related",
  "diary_related",
  "command"
]);

const routePolicies = {
  smalltalk: {
    recentContextLimit: 6,
    includeContextSummary: false,
    refreshSummarySync: false,
    includeLifeMemory: false,
    includeLivingMemory: false,
    livingMemoryK: 0,
    moduleEventLimit: 8,
    consumeModuleMemoryEvents: false,
    includeNewsMemory: false,
    fastLane: true
  },
  emotional: {
    recentContextLimit: 16,
    includeContextSummary: false,
    refreshSummarySync: false,
    includeLifeMemory: true,
    includeLivingMemory: true,
    livingMemoryK: 2,
    moduleEventLimit: 12,
    consumeModuleMemoryEvents: true,
    includeNewsMemory: false,
    fastLane: false
  },
  project_discussion: {
    recentContextLimit: 48,
    includeContextSummary: true,
    refreshSummarySync: true,
    includeLifeMemory: true,
    includeLivingMemory: true,
    livingMemoryK: 4,
    moduleEventLimit: 20,
    consumeModuleMemoryEvents: true,
    includeNewsMemory: false,
    fastLane: false
  },
  factual_question: {
    recentContextLimit: 18,
    includeContextSummary: false,
    refreshSummarySync: false,
    includeLifeMemory: false,
    includeLivingMemory: false,
    livingMemoryK: 0,
    moduleEventLimit: 8,
    consumeModuleMemoryEvents: false,
    includeNewsMemory: false,
    fastLane: true
  },
  memory_related: {
    recentContextLimit: 100,
    includeContextSummary: true,
    refreshSummarySync: true,
    includeLifeMemory: true,
    includeLivingMemory: true,
    livingMemoryK: 5,
    moduleEventLimit: 24,
    consumeModuleMemoryEvents: true,
    includeNewsMemory: false,
    fastLane: false
  },
  diary_related: {
    recentContextLimit: 36,
    includeContextSummary: true,
    refreshSummarySync: true,
    includeLifeMemory: true,
    includeLivingMemory: true,
    livingMemoryK: 4,
    moduleEventLimit: 18,
    consumeModuleMemoryEvents: true,
    includeNewsMemory: true,
    fastLane: false
  },
  command: {
    recentContextLimit: 12,
    includeContextSummary: false,
    refreshSummarySync: false,
    includeLifeMemory: false,
    includeLivingMemory: false,
    livingMemoryK: 0,
    moduleEventLimit: 12,
    consumeModuleMemoryEvents: false,
    includeNewsMemory: false,
    fastLane: true
  }
};

export function classifyMessageRoute(batch = []) {
  const messages = Array.isArray(batch) ? batch : [];
  const text = messages.map((item) => item?.text || "").join("\n").trim();
  const lower = text.toLowerCase();
  const mentioned = messages.some((item) => item?.mentioned || item?.forceReply);
  const cjkRoute = classifyCjkRoute(text);
  const asciiRoute = classifyAsciiRoute(lower);

  if (!text) return "smalltalk";
  if (cjkRoute) return cjkRoute;
  if (asciiRoute) return asciiRoute;
  if (matches(lower, commandPatterns)) return "command";
  if (matches(lower, emotionalPatterns)) return "emotional";
  if (matches(lower, diaryPatterns)) return "diary_related";
  if (matches(lower, memoryPatterns)) return "memory_related";
  if (matches(lower, projectPatterns)) return "project_discussion";
  if (matches(lower, factualPatterns)) return "factual_question";
  if (!mentioned && messages.length > 1) return "smalltalk";
  if (text.length <= 80 || matches(lower, smalltalkPatterns)) return "smalltalk";
  return mentioned ? "project_discussion" : "smalltalk";
}

export function buildContextPolicy(route, batch = []) {
  const safeRoute = routes.has(route) ? route : "smalltalk";
  const policy = { route: safeRoute, ...routePolicies[safeRoute] };
  const mentioned = Array.isArray(batch) && batch.some((item) => item?.mentioned);

  if (mentioned && safeRoute === "smalltalk") {
    return {
      ...policy,
      recentContextLimit: 12,
      includeLivingMemory: true,
      livingMemoryK: 1
    };
  }

  return policy;
}

export function buildActiveContext({ visualState = null, audienceUsers = [], moduleContext = [], moduleEvents = [], batch = [], diaryEvent = null } = {}) {
  const latest = Array.isArray(batch) ? batch[batch.length - 1] : null;
  const userMemory = latest?.session?.ai_profile?.memory_enabled
    ? summarizeProfile(latest.session.ai_profile, latest.session.nickname)
    : "";
  const currentViewer = summarizeCurrentViewer(latest?.session, audienceUsers);
  const hooks = chatHooksFromModules(moduleContext, moduleEvents);
  const state = visualState || {};
  const currentDiaryEvent = formatDiaryEventForReply(diaryEvent);

  return compactObject({
    current_state: [
      state.mood ? `mood=${safeText(state.mood, 48)}` : "",
      state.activity ? `activity=${safeText(state.activity, 48)}` : "",
      Number.isFinite(Number(state.energy)) ? `energy=${Number(state.energy)}` : "",
      Number.isFinite(Number(state.social_need)) ? `social_need=${Number(state.social_need)}` : ""
    ].filter(Boolean).join("; "),
    current_activity: safeText(state.state_reason || state.visual_description || "", 180),
    current_diary_event: currentDiaryEvent,
    active_event: latest?.text ? `${safeText(latest.session?.nickname || "网友", 32)}: ${safeText(latest.text, 120)}` : "",
    current_viewer: currentViewer,
    recent_user_memory: userMemory,
    chat_hooks: hooks,
    tone_bias: toneBiasForState(state, audienceUsers)
  });
}

export function pendingReplyNotice(route) {
  if (route === "emotional") return "她安静了一下，像是在认真听。";
  if (route === "diary_related") return "她翻了翻今天写下的小记。";
  if (route === "project_discussion") return "她把桌上的便签拖到面前。";
  if (route === "memory_related") return "她像是在回想你们之前聊过的事。";
  if (route === "command") return "她很快看了一眼现在的情况。";
  return "她的耳朵动了一下，像是马上要接话。";
}

export function quickReplyLead(route, text = "") {
  if (route === "smalltalk") return "";
  const value = String(text || "").trim();
  if (route === "diary_related") return "今天啊……我本来想装作很充实一点的。";
  if (route === "emotional") return "嗯……我先听着，你慢慢说。";
  if (route === "smalltalk") {
    if (/^(hi|hello|hey|yo|你好|在吗|早安|晚安)/i.test(value)) return "我在呢，刚好抬头看到你这句。";
    return "我听到了，等我把这句话接住。";
  }
  return "";
}

export function formatActiveContextLines(activeContext = {}) {
  const entries = [
    ["Current state", activeContext.current_state],
    ["Current activity", activeContext.current_activity],
    ["Current diary event", activeContext.current_diary_event],
    ["Active event", activeContext.active_event],
    ["Current viewer", activeContext.current_viewer],
    ["Recent user memory", activeContext.recent_user_memory],
    ["Tone bias", activeContext.tone_bias]
  ].filter(([, value]) => value);

  const hooks = Array.isArray(activeContext.chat_hooks) ? activeContext.chat_hooks.filter(Boolean).slice(0, 3) : [];
  if (!entries.length && !hooks.length) return [];

  return [
    "[Hoshia active_context]",
    ...entries.map(([label, value]) => `${label}: ${safeText(value, 220)}`),
    ...hooks.map((hook, index) => `Chat hook ${index + 1}: ${safeText(hook, 160)}`)
  ];
}

function matches(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyAsciiRoute(text) {
  if (/^(\/|!)/.test(text) || /\b(play|pause|resume|next|previous|refresh|open|close|save|generate)\b/.test(text)) return "command";
  if (/\b(tired|sad|anxious|lonely|stress|stressed|upset|cry|comfort|listen to me|burned out)\b/.test(text)) return "emotional";
  if (/\b(diary|what are you doing|what did you do|daily post|timeline|life state)\b/.test(text)) return "diary_related";
  if (/\btoday\b/.test(text) && /\b(do|doing|did|diary|timeline|post|life)\b/.test(text)) return "diary_related";
  if (/\b(remember|memory|last time|before|preference|i like|you know me)\b/.test(text)) return "memory_related";
  if (/\b(code|project|api|database|deploy|frontend|backend|gateway|astrbot|docker|github|bug|latency|performance|streaming|tts|llm|prompt)\b/.test(text)) return "project_discussion";
  if (/\b(what is|why|how many|where|who is|explain|lookup|fact|news)\b/.test(text) || /\?$/.test(text)) return "factual_question";
  if (/^(hi|hello|hey|yo|good morning|good night)\b/.test(text) || /\b(lol|haha|cute|just passing by)\b/.test(text)) return "smalltalk";
  return "";
}

function classifyCjkRoute(text) {
  const value = String(text || "");
  if (!value) return "";
  if (/(?:\u8bb0\u5f97|\u8bb0\u4f4f|\u8bb0\u5fc6|\u4e0a\u6b21|\u4ee5\u524d|\u4e4b\u524d|\u521a\u624d|\u521a\u521a|\u524d\u9762)|\u524d\s*\d+\s*\u6761|\u804a\u8fc7|\u8bf4\u8fc7|\u4f60\u8bf4\u4e86\u4ec0\u4e48|\u81ea\u5df1\u8bf4\u4e86\u4ec0\u4e48|\u5f39\u5e55.*(?:\u989c\u8272|\u8272)/.test(value)) return "memory_related";
  if (/\u52a8\u6001|\u73af\u5883\u4fe1\u606f|\u73b0\u5728.*(?:\u5728\u5e72\u561b|\u5e72\u4ec0\u4e48|\u505a\u4ec0\u4e48|\u72b6\u6001|\u5fc3\u60c5)|\u4eca\u5929.*(?:\u505a|\u5e72\u561b|\u5e72\u4ec0\u4e48|\u65e5\u8bb0|\u53d1\u751f)/.test(value)) return "diary_related";
  return "";
}

const smalltalkPatterns = [
  /^(hi|hello|hey|yo|早|早安|晚安|你好|在吗|哈喽|嗨)[\s!！。,.，]*$/i,
  /(哈哈|hh|笑死|好耶|摸摸|贴贴|可爱|困了|饿了|路过|冒泡)/i
];

const emotionalPatterns = [
  /(累|难受|焦虑|崩溃|委屈|孤独|失眠|压力|烦|emo|不开心|想哭|撑不住|心情不好|好累|被榨干)/i,
  /(陪陪|安慰|抱抱|听我说)/i
];

const projectPatterns = [
  /(代码|项目|架构|接口|数据库|部署|服务|前端|后端|gateway|astrbot|napcat|docker|github|bug|修复|实现|优化|重构|延迟|性能)/i,
  /(api|schema|websocket|router|streaming|tts|llm|prompt|module_context)/i
];

const factualPatterns = [
  /(什么是|为什么|怎么理解|谁是|哪里|哪一年|多少|如何|解释一下|查一下|资料|事实|新闻)/i,
  /\?$|？$/
];

const memoryPatterns = [
  /(记得|记住|忘了|上次|以前|之前|我们聊过|我的偏好|我喜欢|你知道我|还记不记得|回忆)/i
];

const diaryPatterns = [
  /(今天干嘛|你今天|日记|动态|生活|刚才做什么|现在在干嘛|今天发生|刷到|新番|跑步|状态怎么样|心情怎么样)/i
];

const commandPatterns = [
  /^(\/|!)/,
  /(点歌|暂停|继续播放|下一首|上一首|切歌|删除待播|刷新|打开|关闭|设置|帮我|执行|生成|保存)/i
];

function summarizeProfile(profile = {}, fallbackName = "") {
  const parts = [
    profile.preferred_name || fallbackName ? `称呼 ${safeText(profile.preferred_name || fallbackName, 32)}` : "",
    profile.reply_style_text ? `偏好 ${safeText(profile.reply_style_text, 60)}` : "",
    profile.interests ? `关注 ${safeText(profile.interests, 120)}` : ""
  ].filter(Boolean);
  return parts.join("; ");
}

function summarizeCurrentViewer(session = {}, audienceUsers = []) {
  if (!session || typeof session !== "object") return "";
  const userId = safeText(session.user_id, 80);
  const audience = (Array.isArray(audienceUsers) ? audienceUsers : []).find((item) => item?.user_id === userId) || {};
  const nickname = safeText(session.nickname || audience.nickname || "", 32);
  const color = safeDanmakuColor(session.danmaku_color || audience.danmaku_color || "");
  const parts = [
    nickname ? `nickname=${nickname}` : "",
    color ? `danmaku_color=${color}` : "",
    audience.online !== undefined ? `online=${Boolean(audience.online)}` : ""
  ].filter(Boolean);
  return parts.join("; ");
}

function safeDanmakuColor(value) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : "";
}

function chatHooksFromModules(moduleContext = [], moduleEvents = []) {
  const hooks = [];
  const music = moduleContext.find((item) => item?.module_id === "music" && item.enabled);
  if (music?.current_state?.length) hooks.push(safeText(music.current_state[0], 140));
  const visual = moduleContext.find((item) => (item?.module_id === "hoshia_visual" || item?.module_id === "hoshia_visual_state") && item.enabled);
  if (visual?.current_state?.length) hooks.push(safeText(visual.current_state[0], 140));
  const life = moduleContext.find((item) => item?.module_id === "hoshia_life_system" && item.enabled);
  if (life?.current_state?.length) hooks.push(safeText(life.current_state[0], 140));
  const event = moduleEvents.find((item) => item?.summary_hint);
  if (event) hooks.push(safeText(event.summary_hint, 140));
  return hooks.filter(Boolean).slice(0, 3);
}

function formatDiaryEventForReply(event = null) {
  if (!event || typeof event !== "object") return "";
  const type = safeText(event.type, 32);
  const label = diaryEventLabel(type, event.title);
  const time = safeText(event.time_range, 16);
  const detail = diaryEventDetail(type, event.title);
  const hook = Array.isArray(event.chat_hooks) ? event.chat_hooks.map((item) => safeText(item, 80)).find(Boolean) : "";
  return [time, label, detail, hook ? `可顺带接一句：${localizedDiaryHook(type, hook)}` : ""]
    .filter(Boolean)
    .join("；")
    .slice(0, 220);
}

function diaryEventLabel(type = "", title = "") {
  const text = `${type} ${title}`.toLowerCase();
  if (/wake|sleep/.test(text)) return "慢慢醒神/犯困";
  if (/class|work|campus|desk|notes/.test(text)) return "整理桌面和学习事项";
  if (/lunch/.test(text)) return "午饭后的安静空档";
  if (/run|sport|training/.test(text)) return "运动或训练后的恢复";
  if (/anime|otaku|comment|thread|interest/.test(text)) return "看兴趣话题和二次元讨论";
  if (/game|match|replay/.test(text)) return "复盘游戏里的小决定";
  if (/song|music/.test(text)) return "听歌调整房间氛围";
  if (/room|stage|live/.test(text)) return "整理小房间和准备话题";
  if (/user_related/.test(text)) return "刚和特殊网友聊过几句";
  if (/private_mood|emo/.test(text)) return "低电量地安静待一会儿";
  return "今天日记里的一件小事";
}

function diaryEventDetail(type = "", title = "") {
  const text = `${type} ${title}`.toLowerCase();
  if (/room|stage|live/.test(text)) return "她现在更像是在整理小房间状态和小话题，不是在做很大的事。";
  if (/anime|otaku|comment|thread|interest/.test(text)) return "她刚被一个兴趣点勾住，脑子里还在想要不要吐槽两句。";
  if (/game|match|replay/.test(text)) return "她在回想刚才的判断，带一点不服输的劲。";
  if (/run|sport|training/.test(text)) return "她身体有点累，但心情比之前清爽。";
  if (/class|work|campus|desk|notes/.test(text)) return "她在处理普通但真实的小安排，注意力还没完全散。";
  if (/song|music/.test(text)) return "她在用歌单和声音把小房间气氛垫起来。";
  if (/user_related/.test(text)) return "她把那个特殊网友出现这件事当成今天的一小段痕迹。";
  if (/wake|sleep|private_mood|emo/.test(text)) return "她现在动作慢一点，适合低声说几句。";
  return "她可以把它当成正在发生的生活细节来回答。";
}

function localizedDiaryHook(type = "", hook = "") {
  const text = `${type} ${hook}`.toLowerCase();
  if (/viewer|room feels less empty|arrives/.test(text)) return "有人来以后小房间没那么空。";
  if (/song|loop/.test(text)) return "问问对方今晚会循环哪首歌。";
  if (/character|anime/.test(text)) return "问问对方怎么看角色讨论。";
  if (/training|rested/.test(text)) return "问问对方今天是训练还是休息。";
  if (/game|overthinking/.test(text)) return "轻轻吐槽自己又在复盘。";
  if (/stage|wanted to say|notes/.test(text)) return "说自己刚好整理到一个想聊的小话题。";
  return safeText(hook, 80);
}

function toneBiasForState(state = {}, audienceUsers = []) {
  const online = Array.isArray(audienceUsers) ? audienceUsers.filter((user) => user?.online).length : 0;
  const mood = String(state.mood || "").toLowerCase();
  if (mood.includes("tired")) return "亲近、低声、短句，不要工具化";
  if (online <= 1) return "像熟人低声接话，轻微撒娇，短回复优先";
  return "自然朋友感，先接住重点，不要长篇解释";
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (Array.isArray(item)) return item.length > 0;
      return item !== undefined && item !== null && String(item).trim() !== "";
    })
  );
}

function safeText(value, limit = 160) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, limit);
}
