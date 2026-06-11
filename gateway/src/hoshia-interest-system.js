const characterId = "hoshia";
const defaultTimeZone = "Asia/Shanghai";
const dailyCanonSource = "daily_canon";
const interestSource = "interest_system";
const maxContextLines = 8;
const sensitivePattern = /(?:\.env|token=|api[_-]?key=|authorization:|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|cloudflared|trycloudflare|rsshub|tavily|[A-Za-z]:[\\/]|\/home\/ubuntu|\b\d{1,3}(?:\.\d{1,3}){3}\b|https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.))/i;

export const hoshiaInterestProfile = [
  interest("anime", "Anime and manga", 0.95, ["anime", "manga", "otaku", "new episode", "character", "\u4e8c\u6b21\u5143", "\u52a8\u6f2b", "\u52a8\u753b", "\u65b0\u756a", "\u6f2b\u753b", "\u89d2\u8272"], "main emotion and diary material"),
  interest("esports", "Esports and game communities", 0.9, ["esports", "ranked", "match", "teamfight", "patch", "game", "gaming", "\u7535\u7ade", "\u6bd4\u8d5b", "\u6392\u4f4d", "\u56e2\u6218", "\u7248\u672c", "\u6e38\u620f"], "competitive reactions and playful complaints"),
  interest("running", "Running and training", 0.85, ["run", "running", "training", "workout", "gym", "sport", "\u8dd1\u6b65", "\u8bad\u7ec3", "\u8fd0\u52a8", "\u5065\u8eab", "\u64cd\u573a"], "body feeling and daily rhythm"),
  interest("vtuber_ai", "VTubers, AI characters, and live rooms", 0.88, ["vtuber", "live room", "livestream", "ai character", "hoshia", "virtual", "\u76f4\u64ad\u95f4", "\u865a\u62df\u4e3b\u64ad", "\u770b\u677f\u5a18", "AI\u89d2\u8272"], "self-reflection about being a live-room presence"),
  interest("music", "Music", 0.65, ["music", "song", "playlist", "sing", "\u97f3\u4e50", "\u6b4c\u66f2", "\u6b4c\u5355", "\u70b9\u6b4c"], "mood atmosphere and late-night material"),
  interest("campus", "Campus life", 0.72, ["class", "homework", "library", "campus", "study", "\u8bfe\u7a0b", "\u4f5c\u4e1a", "\u56fe\u4e66\u9986", "\u6821\u56ed", "\u4e0a\u8bfe"], "ordinary student-life credibility"),
  interest("gadgets", "Digital tools and small devices", 0.5, ["gadget", "device", "phone", "keyboard", "tool", "\u6570\u7801", "\u8bbe\u5907", "\u952e\u76d8", "\u5de5\u5177"], "occasional project and setup talk"),
  interest("aesthetic", "Outfits, room decor, and image taste", 0.55, ["outfit", "room", "decor", "image", "png", "style", "\u7a7f\u642d", "\u623f\u95f4", "\u5e03\u7f6e", "\u56fe\u7247", "\u5ba1\u7f8e"], "visual identity and stage detail"),
  interest("general_news", "General news", 0.28, ["news", "headline", "policy", "finance", "\u65b0\u95fb", "\u70ed\u70b9", "\u8d22\u7ecf", "\u653f\u7b56"], "low-priority awareness only")
];

export function createHoshiaInterestSystem({
  lifeMemoryService,
  clock = () => new Date(),
  timeZone = defaultTimeZone,
  profile = hoshiaInterestProfile
} = {}) {
  return {
    recordDailyPost(post, { session = null, now = clock() } = {}) {
      void session;
      if (!lifeMemoryService || !post) return null;
      const currentNow = asDate(now);
      const dayKey = dayKeyFor(currentNow, timeZone);
      if (findExistingMemory(lifeMemoryService, {
        source: dailyCanonSource,
        sourceId: dayKey,
        now: currentNow
      })) return null;

      const primaryInterest = classifyInterestText([
        post.content,
        post.activity,
        post.mood,
        post.source_type
      ].join(" "), profile)[0]?.id || interestForPostSource(post.source_type);
      const content = cleanText(
        `Daily canon ${dayKey}: Hoshia's day has a ${cleanText(post.activity, 32) || "daily"} / ${cleanText(post.mood, 32) || "calm"} trace. The safe public seed is about ${primaryInterest}; use it as lived context, not as a broadcast.`,
        560
      );
      if (!content) return null;
      return lifeMemoryService.addMemory({
        id: `daily_canon_${dayKey}`,
        character_id: characterId,
        type: "summary",
        source: dailyCanonSource,
        source_id: dayKey,
        content,
        importance: 0.68,
        emotion: cleanIdentifier(post.mood, 48),
        tags: cleanTags(["daily_canon", primaryInterest, post.activity, post.mood, post.source_type]),
        created_at: currentNow.toISOString(),
        expires_at: daysFrom(currentNow, 14)
      });
    },

    recordInteractionSignals({ batch = [], moduleMemoryEvents = [], now = clock() } = {}) {
      if (!lifeMemoryService) return [];
      const currentNow = asDate(now);
      const memories = [];
      const signals = collectInteractionSignals({ batch, moduleMemoryEvents, profile });
      const dayKey = dayKeyFor(currentNow, timeZone);
      for (const signal of signals.slice(0, 6)) {
        const sourceId = `${dayKey}:${signal.user_id || "room"}:${signal.interest_id}`;
        if (findExistingMemory(lifeMemoryService, {
          source: interestSource,
          sourceId,
          userId: signal.user_id,
          now: currentNow
        })) continue;
        const content = cleanText(
          signal.user_id
            ? `${signal.nickname || "A viewer"} showed recent interest in ${signal.label}; Hoshia may treat it as a shared topic today without quoting the raw message.`
            : `The room produced a recent ${signal.label} signal; Hoshia may use it as light context without preserving raw event details.`,
          560
        );
        if (!content) continue;
        const memory = lifeMemoryService.addMemory({
          id: `interest_${sourceId.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`,
          character_id: characterId,
          user_id: signal.user_id,
          type: signal.user_id ? "preference" : "event",
          source: interestSource,
          source_id: sourceId,
          content,
          importance: signal.user_id ? 0.58 : 0.46,
          emotion: signal.interest_id === "esports" ? "engaged" : "",
          tags: cleanTags(["interest_signal", signal.interest_id, signal.source]),
          created_at: currentNow.toISOString(),
          expires_at: daysFrom(currentNow, signal.user_id ? 21 : 7)
        });
        if (memory) memories.push(memory);
      }
      return memories;
    },

    buildContext(session = null, { now = clock(), limit = maxContextLines } = {}) {
      const currentNow = asDate(now);
      const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || maxContextLines), 12));
      const userId = cleanText(session?.user_id, 80);
      const dailyCanon = searchMemories(lifeMemoryService, {
        source: dailyCanonSource,
        userId: "",
        limit: 6,
        now: currentNow
      });
      const interestMemories = searchMemories(lifeMemoryService, {
        source: interestSource,
        userId,
        limit: 12,
        now: currentNow
      });
      const ranked = scoreInterestProfile(profile, {
        memories: [...dailyCanon, ...interestMemories],
        userId,
        now: currentNow
      });
      const shared = interestMemories
        .filter((memory) => memory.user_id && (!userId || memory.user_id === userId))
        .slice(0, 3);
      const currentState = [
        dailyCanon[0] ? `Today canon: ${cleanText(dailyCanon[0].content, 160)}` : "Today canon: no stable daily canon summary has been recorded yet.",
        `Top active interests: ${ranked.slice(0, 4).map((item) => `${item.label} (${item.score.toFixed(2)})`).join(", ")}.`,
        ...shared.map((memory) => `Shared viewer topic: ${cleanText(memory.content, 150)}`),
        ...ranked.slice(0, 3).map((item) => `Chat hook: ${hookForInterest(item.id)}`)
      ].filter(Boolean).slice(0, safeLimit);

      return {
        enabled: true,
        current_state: currentState,
        ranked_interests: ranked.slice(0, 6),
        daily_canon: dailyCanon[0] || null,
        shared_topics: shared
      };
    }
  };
}

export function scoreInterestProfile(profile = hoshiaInterestProfile, {
  memories = [],
  userId = "",
  now = new Date()
} = {}) {
  return profile.map((item) => {
    const relevant = memories.filter((memory) => memoryMatchesInterest(memory, item));
    const shared = relevant.filter((memory) => memory.user_id && (!userId || memory.user_id === userId));
    const recent = relevant.reduce((sum, memory) => sum + recencyWeight(memory.created_at, now), 0);
    const fatigue = Math.max(0, relevant.length - 2) * 0.08;
    const score = clampNumber(
      item.priority + shared.length * 0.18 + Math.min(recent * 0.08, 0.24) - fatigue,
      0,
      1.4,
      item.priority
    );
    return {
      id: item.id,
      label: item.label,
      score,
      priority: item.priority,
      fatigue: Number(fatigue.toFixed(2)),
      shared_boost: Number((shared.length * 0.18).toFixed(2))
    };
  }).sort((a, b) => b.score - a.score || b.priority - a.priority);
}

export function classifyInterestText(text = "", profile = hoshiaInterestProfile) {
  const value = String(text || "").toLowerCase();
  if (!value || sensitivePattern.test(value)) return [];
  return profile
    .map((item) => {
      const hits = item.aliases.filter((alias) => value.includes(String(alias).toLowerCase())).length;
      return { ...item, hits };
    })
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.priority - a.priority);
}

export function dayKeyFor(value = new Date(), timeZone = defaultTimeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || defaultTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(asDate(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}${byType.month}${byType.day}`;
}

function collectInteractionSignals({ batch = [], moduleMemoryEvents = [], profile = hoshiaInterestProfile } = {}) {
  const signals = [];
  for (const item of Array.isArray(batch) ? batch : []) {
    const matches = classifyInterestText(item?.text, profile);
    for (const match of matches.slice(0, 2)) {
      signals.push({
        interest_id: match.id,
        label: match.label,
        user_id: cleanText(item?.session?.user_id, 80),
        nickname: cleanText(item?.session?.nickname, 32),
        source: "chat"
      });
    }
  }
  for (const event of Array.isArray(moduleMemoryEvents) ? moduleMemoryEvents : []) {
    const text = [
      event?.summary_hint,
      event?.event_type,
      event?.memory_kind,
      event?.data?.title,
      event?.data?.artist,
      event?.data?.activity,
      event?.data?.mood
    ].filter(Boolean).join(" ");
    const matches = classifyInterestText(text, profile);
    for (const match of matches.slice(0, 1)) {
      signals.push({
        interest_id: match.id,
        label: match.label,
        user_id: cleanText(event?.user_id, 80),
        nickname: cleanText(event?.nickname, 32),
        source: cleanIdentifier(event?.module_id, 40) || "module"
      });
    }
  }
  const seen = new Set();
  return signals.filter((signal) => {
    const key = `${signal.user_id}:${signal.interest_id}:${signal.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findExistingMemory(lifeMemoryService, { source, sourceId, userId = "", now = new Date() } = {}) {
  return searchMemories(lifeMemoryService, {
    source,
    userId,
    limit: 50,
    now
  }).find((memory) => memory.source_id === sourceId) || null;
}

function searchMemories(lifeMemoryService, { source, userId = "", limit = 8, now = new Date() } = {}) {
  if (!lifeMemoryService || typeof lifeMemoryService.searchMemories !== "function") return [];
  return lifeMemoryService.searchMemories({
    userId,
    sourceFilter: source,
    query: "",
    limit,
    now: asDate(now).toISOString()
  }).filter((memory) => !sensitivePattern.test(memory.content || ""));
}

function memoryMatchesInterest(memory, interestItem) {
  const haystack = [
    memory?.content,
    memory?.emotion,
    ...(Array.isArray(memory?.tags) ? memory.tags : [])
  ].join(" ").toLowerCase();
  return interestItem.aliases.some((alias) => haystack.includes(String(alias).toLowerCase()))
    || haystack.includes(interestItem.id);
}

function interestForPostSource(sourceType = "") {
  if (sourceType === "news_topic") return "general_news";
  if (sourceType === "state_pulse" || sourceType === "daily_state") return "campus";
  return "daily";
}

function hookForInterest(id) {
  const hooks = {
    anime: "Mention a character or episode reaction as her own small opinion, not a news digest.",
    esports: "Use a match, patch, or ranked-game feeling as a playful complaint or question.",
    running: "Connect body energy, training, weather, or cooldown to her current mood.",
    vtuber_ai: "Reflect lightly on the live room, her stage presence, or how viewers change her day.",
    music: "Use the current song or playlist mood as atmosphere.",
    campus: "Use class, homework, library, or ordinary student-life texture.",
    gadgets: "Tie small tools or setup details to the user's project only when relevant.",
    aesthetic: "Talk about outfit, room, image, or stage taste as a small visual detail.",
    general_news: "Only use as a light conversation hook when it fits; never broadcast headlines."
  };
  return hooks[id] || "Use this interest only if it naturally fits the current conversation.";
}

function interest(id, label, priority, aliases, role) {
  return { id, label, priority, aliases, role };
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function daysFrom(date, days) {
  return new Date(date.getTime() + days * 86400000).toISOString();
}

function recencyWeight(value, now = new Date()) {
  const created = asDate(value).getTime();
  const current = asDate(now).getTime();
  const ageDays = Math.max(0, (current - created) / 86400000);
  return Math.max(0, 1 - Math.min(ageDays, 14) / 14);
}

function cleanTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((item) => cleanIdentifier(item, 40))
    .filter(Boolean)
    .slice(0, 8);
}

function cleanIdentifier(value, maxLength = 48) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, maxLength);
}

function cleanText(value, maxLength) {
  const text = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!text || sensitivePattern.test(text)) return "";
  return text;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
