import { readFileSync } from "node:fs";

const knowledgeEntries = JSON.parse(
  readFileSync(new URL("./interest-knowledge-data.json", import.meta.url), "utf8")
);

const domainProfiles = [
  domain("anime_game", "Anime, games, and fandom", 0.95, [
    "anime", "manga", "game", "gaming", "character", "episode", "otaku",
    "二次元", "动漫", "动画", "漫画", "新番", "番剧", "游戏", "手游", "角色", "抽卡", "电竞"
  ], "Use character reactions, episode feelings, gameplay decisions, and light fandom jokes."),
  domain("music_movie", "Music and movies", 0.78, [
    "music", "song", "artist", "band", "movie", "film", "rock",
    "音乐", "歌曲", "歌手", "乐队", "电影", "摇滚", "老电影", "影评"
  ], "Use Hoshia's concrete taste: classic rock, older movies, and room atmosphere."),
  domain("sports_campus", "Training and campus life", 0.74, [
    "run", "running", "training", "campus", "class", "library", "dorm",
    "跑步", "训练", "运动", "操场", "校园", "大学", "上课", "图书馆", "宿舍", "食堂"
  ], "Use ordinary university-life texture and body-energy details."),
  domain("tech_tools", "Tech tools and small workflows", 0.58, [
    "ai", "tool", "model", "app", "workflow", "keyboard", "device",
    "AI", "工具", "模型", "大模型", "应用", "软件", "数码", "键盘", "设备"
  ], "Treat tools as useful curiosities, never as Hoshia's identity."),
  domain("light_trends", "Light trends and memes", 0.5, [
    "trend", "meme", "hot", "viral", "bilibili",
    "热点", "热梗", "梗", "梗图", "B站", "b站", "二创", "鬼畜", "热搜"
  ], "Use only as casual hooks, not as authoritative reporting.")
];

const domainById = new Map(domainProfiles.map((item) => [item.id, item]));
const explicitPreferencePattern = /(喜欢|愛|爱|记住|記住|偏好|经常|經常|常看|常听|最近在追|一直在看|i like|favorite|favourite|prefer|remember)/i;
const sensitivePattern = /(?:\.env|token=|api[_-]?key|authorization:|bearer\s+|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|ssh-|cloudflared|trycloudflare|rsshub|tavily|https?:\/\/|www\.|localhost|127\.0\.0\.1|[A-Za-z]:[\\/]|\/home\/ubuntu|\/app\/data|\b\d{1,3}(?:\.\d{1,3}){3}\b)/i;

export function createHoshiaInterestKnowledgeService({
  entries = knowledgeEntries,
  domains = domainProfiles,
  maxRecent = 4
} = {}) {
  const normalizedEntries = entries.map(normalizeEntry).filter(Boolean);
  const normalizedDomains = domains.map(normalizeDomain).filter(Boolean);
  const recentMatches = [];

  return {
    observeBatch(batch = [], { roomId = "" } = {}) {
      const events = [];
      for (const item of Array.isArray(batch) ? batch : []) {
        const result = matchInterestKnowledge(item?.text, {
          entries: normalizedEntries,
          domains: normalizedDomains
        });
        if (!result) continue;
        const session = item?.session || {};
        const explicitPreference = explicitPreferencePattern.test(String(item?.text || ""));
        const match = {
          ...result,
          user_id: cleanText(session.user_id, 80),
          nickname: cleanText(session.nickname, 32),
          observed_at: new Date().toISOString()
        };
        rememberRecent(recentMatches, match, maxRecent);
        events.push(createInterestTopicEvent(match, session, {
          roomId,
          memoryEligible: explicitPreference
        }));
        if (match.source_kind === "local") {
          events.push(createInterestKnowledgeMatchedEvent(match, session, {
            roomId,
            memoryEligible: explicitPreference
          }));
        }
      }
      return events.filter(Boolean);
    },
    getCapabilityContext() {
      return buildInterestKnowledgeContext(recentMatches);
    },
    recentMatches() {
      return recentMatches.map((item) => ({ ...item }));
    },
    clear() {
      recentMatches.splice(0);
    }
  };
}

export function matchInterestKnowledge(text = "", {
  entries = knowledgeEntries.map(normalizeEntry).filter(Boolean),
  domains = domainProfiles.map(normalizeDomain).filter(Boolean)
} = {}) {
  const value = cleanText(text, 500);
  if (!value || sensitivePattern.test(value)) return null;
  const lower = value.toLowerCase();

  let bestEntry = null;
  let bestAlias = "";
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (!alias || !lower.includes(alias.toLowerCase())) continue;
      if (!bestEntry || alias.length > bestAlias.length) {
        bestEntry = entry;
        bestAlias = alias;
      }
    }
  }
  if (bestEntry) {
    return {
      category: bestEntry.category,
      topic: bestEntry.title,
      matched_alias: bestAlias,
      source_kind: "local",
      summary: bestEntry.summary,
      hoshia_angle: bestEntry.hoshia_angle,
      avoid: bestEntry.avoid
    };
  }

  const domainMatch = domains
    .map((domainItem) => ({
      domain: domainItem,
      alias: domainItem.aliases.find((alias) => lower.includes(alias.toLowerCase())) || ""
    }))
    .filter((item) => item.alias)
    .sort((a, b) => b.domain.priority - a.domain.priority || b.alias.length - a.alias.length)[0];

  if (!domainMatch) return null;
  return {
    category: domainMatch.domain.id,
    topic: domainMatch.alias,
    matched_alias: domainMatch.alias,
    source_kind: "search",
    summary: "",
    hoshia_angle: domainMatch.domain.reply_angle,
    avoid: domainMatch.domain.avoid
  };
}

export function buildInterestKnowledgeContext(matches = []) {
  const active = Array.isArray(matches) ? matches.filter(Boolean).slice(0, 3) : [];
  if (!active.length) {
    return {
      module_id: "hoshia_interest_knowledge",
      enabled: false,
      current_state: ["No current interest knowledge match."],
      capabilities: [],
      limits: [
        "Do not pretend to know unfamiliar works, tools, songs, movies, games, or memes without provided context."
      ]
    };
  }

  const currentState = [];
  for (const match of active) {
    const domainInfo = domainById.get(match.category);
    currentState.push(`Interest field: ${cleanText(domainInfo?.label || match.category, 80)}.`);
    currentState.push(`Current topic: ${cleanText(match.topic, 80)} (${match.source_kind}).`);
    if (match.summary) currentState.push(`Stable background: ${cleanText(match.summary, 160)}.`);
    if (match.hoshia_angle) currentState.push(`Natural angle: ${cleanText(match.hoshia_angle, 160)}.`);
  }

  return {
    module_id: "hoshia_interest_knowledge",
    enabled: true,
    current_state: currentState.slice(0, 10),
    capabilities: [
      "Hoshia can use small, safe background notes about her interest fields when the current chat mentions them.",
      "Local background notes take priority over live search context.",
      "Recent or unfamiliar topics may be handled as search-needed context without becoming long-term memory."
    ],
    limits: [
      "Use this as conversational background, not as an encyclopedia or news broadcast.",
      "Do not say tool names, source names, links, backend fields, search actions, credentials, secret values, paths, or internal addresses.",
      "Do not turn one mention into a permanent viewer preference unless the viewer clearly says they like it or want it remembered."
    ]
  };
}

export function createInterestTopicEvent(match, session, {
  roomId = "",
  memoryEligible = false,
  retentionDays = 14
} = {}) {
  if (!match?.category || !match?.topic) return null;
  const nickname = cleanText(session?.nickname || match.nickname, 32) || "viewer";
  return {
    room_id: roomId,
    module_id: "hoshia_interest_knowledge",
    event_type: "interest.topic_mentioned",
    user_id: session?.user_id || match.user_id || "",
    nickname,
    summary_hint: `${nickname} mentioned ${cleanText(match.topic, 80)} in ${cleanText(match.category, 40)}`,
    memory_eligible: Boolean(memoryEligible),
    memory_kind: "interest_preference_candidate",
    retention_days: retentionDays,
    data: eventData(match)
  };
}

export function createInterestKnowledgeMatchedEvent(match, session, {
  roomId = "",
  memoryEligible = false,
  retentionDays = 14
} = {}) {
  if (!match?.category || !match?.topic) return null;
  const nickname = cleanText(session?.nickname || match.nickname, 32) || "viewer";
  return {
    room_id: roomId,
    module_id: "hoshia_interest_knowledge",
    event_type: "interest.knowledge_matched",
    user_id: session?.user_id || match.user_id || "",
    nickname,
    summary_hint: `Local interest note matched ${cleanText(match.topic, 80)} for ${nickname}`,
    memory_eligible: Boolean(memoryEligible),
    memory_kind: "interest_preference_candidate",
    retention_days: retentionDays,
    data: eventData(match)
  };
}

export { domainProfiles, knowledgeEntries };

function eventData(match) {
  return {
    category: cleanIdentifier(match.category, 40),
    topic: cleanText(match.topic, 80),
    matched_alias: cleanText(match.matched_alias, 80),
    source_kind: match.source_kind === "local" ? "local" : "search"
  };
}

function rememberRecent(recentMatches, match, maxRecent) {
  const key = `${match.category}:${match.topic}:${match.user_id}`;
  const existing = recentMatches.findIndex((item) => `${item.category}:${item.topic}:${item.user_id}` === key);
  if (existing >= 0) recentMatches.splice(existing, 1);
  recentMatches.unshift(match);
  recentMatches.splice(Math.max(1, Math.min(Number(maxRecent) || 4, 12)));
}

function normalizeEntry(entry = {}) {
  const category = cleanIdentifier(entry.category, 40);
  const title = cleanText(entry.title, 80);
  const domainInfo = domainById.get(category);
  if (!category || !title || !domainInfo) return null;
  return {
    id: cleanIdentifier(entry.id || title, 80),
    category,
    title,
    aliases: cleanList([title, ...(Array.isArray(entry.aliases) ? entry.aliases : [])], 20, 80),
    summary: cleanText(entry.summary, 180),
    hoshia_angle: cleanText(entry.hoshia_angle, 180),
    avoid: cleanList(entry.avoid, 5, 100)
  };
}

function normalizeDomain(item = {}) {
  const id = cleanIdentifier(item.id, 40);
  const label = cleanText(item.label, 80);
  if (!id || !label) return null;
  return {
    id,
    label,
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0.5,
    aliases: cleanList(item.aliases, 30, 80),
    reply_angle: cleanText(item.reply_angle, 180),
    avoid: cleanList(item.avoid, 5, 100),
    proactive: item.proactive !== false
  };
}

function domain(id, label, priority, aliases, replyAngle, avoid = []) {
  return { id, label, priority, aliases, reply_angle: replyAngle, avoid, proactive: true };
}

function cleanList(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanIdentifier(value, maxLength = 48) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, maxLength);
}

function cleanText(value, maxLength = 160) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text || sensitivePattern.test(text)) return "";
  return text;
}
