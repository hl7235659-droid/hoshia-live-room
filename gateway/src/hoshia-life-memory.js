import { nanoid } from "nanoid";

const characterId = "hoshia";
const sensitivePattern = /(?:\.env|token=|api[_-]?key=|authorization:|password=|secret=|BEGIN [A-Z ]*PRIVATE KEY|cloudflared|trycloudflare|[A-Za-z]:[\\/]|\/home\/ubuntu|\b\d{1,3}(?:\.\d{1,3}){3}\b|https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.))/i;

export function createHoshiaLifeMemoryService({ db, clock = () => new Date() }) {
  return {
    addMemory(input = {}) {
      const memory = normalizeMemory(input, clock);
      if (!memory) return null;
      return db.addHoshiaLifeMemory(memory);
    },

    recordPost(post) {
      if (!post) return null;
      return this.addMemory({
        type: "event",
        source: "post",
        source_id: post.id,
        content: `Hoshia 在校园动态里记了一条${lifeActivityLabel(post.activity)}近况：${post.content}`,
        importance: 0.62,
        emotion: post.mood || "",
        tags: [post.activity, post.mood, post.source_type].filter(Boolean)
      });
    },

    recordInteraction({ post, interaction }) {
      if (!post || !interaction) return null;
      if (interaction.type === "like") {
        return this.addMemory({
          user_id: interaction.user_id,
          type: "event",
          source: "post_like",
          source_id: interaction.id,
          content: `${interaction.nickname || "一位网友"}给 Hoshia 的${lifeActivityLabel(post.activity)}校园动态点了赞。`,
          importance: 0.28,
          emotion: "positive",
          tags: ["like", post.activity, post.mood].filter(Boolean),
          expires_at: daysFromNow(clock(), 30)
        });
      }

      if (interaction.type === "comment") {
        return this.addMemory({
          user_id: interaction.user_id,
          type: "event",
          source: "post_comment",
          source_id: post.id,
          content: `${interaction.nickname || "一位网友"}在 Hoshia 的${lifeActivityLabel(post.activity)}校园动态下留言：${interaction.content}`,
          importance: importanceForText(interaction.content, questionLike(interaction.content) ? 0.72 : 0.58),
          emotion: emotionForText(interaction.content),
          tags: ["comment", post.activity, post.mood, questionLike(interaction.content) ? "question" : ""].filter(Boolean),
          expires_at: daysFromNow(clock(), 45)
        });
      }

      if (interaction.type === "reply") {
        return this.addMemory({
          user_id: interaction.user_id,
          type: commitmentLike(interaction.content) ? "commitment" : "event",
          source: "post_reply",
          source_id: post.id,
          content: `Hoshia 在校园动态评论串里回复了一句：${interaction.content}`,
          importance: importanceForText(interaction.content, 0.66),
          emotion: emotionForText(interaction.content),
          tags: ["reply", post.activity, post.mood, questionLike(interaction.content) ? "question" : ""].filter(Boolean)
        });
      }
      return null;
    },

    recordChatInteraction({ session, text, messageId }) {
      const importance = importanceForText(text, 0.34);
      if (importance < 0.55) return null;
      return this.addMemory({
        user_id: session?.user_id || "",
        type: commitmentLike(text) ? "commitment" : "event",
        source: "chat",
        source_id: messageId || "",
        content: `${session?.nickname || "一位网友"}在宿舍小房间聊到：${text}`,
        importance,
        emotion: emotionForText(text),
        tags: ["chat", ...topicTags(text)],
        expires_at: importance >= 0.75 ? null : daysFromNow(clock(), 30)
      });
    },

    searchMemories(input = {}) {
      return db.searchHoshiaLifeMemories({
        characterId: input.character_id || input.characterId || characterId,
        userId: input.user_id || input.userId || "",
        query: input.query || "",
        sourceFilter: input.source_filter || input.sourceFilter || "",
        limit: input.limit || 8,
        now: clock().toISOString()
      });
    },

    buildMemoryPacket({ session = null, batch = [], query = "", scene = "", postId = "", limit = 6 } = {}) {
      const primary = session?.user_id
        ? { session }
        : (Array.isArray(batch) ? batch.find((item) => item?.session?.user_id) : null);
      const userId = primary?.session?.user_id || "";
      const text = memoryPacketQuery({ query, scene, postId, batch });
      const memories = rankMemoryPacketCandidates({
        memories: [
          ...this.searchMemories({ userId, query: text, limit: Math.max(limit * 3, 12) }),
          ...this.searchMemories({ userId, query: "", limit: Math.max(limit * 4, 20) }),
          ...this.searchMemories({ userId, query: text, sourceFilter: "post_comment", limit: Math.max(limit * 3, 12) }),
          ...this.searchMemories({ userId, query: "", sourceFilter: "post_comment", limit: Math.max(limit * 3, 12) }),
          ...this.searchMemories({ userId, query: text, sourceFilter: "post_reply", limit: Math.max(limit * 3, 12) }),
          ...this.searchMemories({ userId, query: "", sourceFilter: "post_reply", limit: Math.max(limit * 3, 12) })
        ],
        userId,
        query: text,
        postId,
        now: clock(),
        limit
      });
      if (!memories.length) return [];
      return [
        "【Hoshia 生活记忆】",
        ...memories.map((memory) => `- ${memoryLine(memory)}`)
      ];
    }
  };
}

export function publicPost(row) {
  return {
    id: row.id,
    character_id: row.character_id,
    content: row.content,
    image_url: row.image_url || "",
    mood: row.mood || "",
    activity: row.activity || "",
    source_type: row.source_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
    like_count: Number(row.like_count || 0),
    comment_count: Number(row.comment_count || 0),
    liked_by_viewer: Boolean(row.liked_by_viewer),
    interactions: (row.interactions || [])
      .filter((item) => item.type !== "like")
      .map(publicInteraction)
  };
}

export function publicInteraction(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    user_id: row.user_id,
    nickname: row.nickname || "",
    type: row.type,
    content: row.content || "",
    parent_interaction_id: row.parent_interaction_id || "",
    reply_status: row.reply_status || "",
    reply_due_at: row.reply_due_at || "",
    replied_at: row.replied_at || "",
    created_at: row.created_at
  };
}

export function normalizePostInput(body = {}, now = new Date()) {
  const content = cleanText(body.content, 700);
  if (!content) return null;
  return {
    id: cleanIdentifier(body.id, 80) || `post_${nanoid(12)}`,
    character_id: characterId,
    content,
    image_url: cleanUrl(body.image_url ?? body.imageUrl, 260),
    mood: cleanIdentifier(body.mood, 48) || "calm",
    activity: cleanIdentifier(body.activity, 48) || "idle",
    source_type: cleanIdentifier(body.source_type ?? body.sourceType, 48) || "manual",
    created_at: cleanDate(body.created_at ?? body.createdAt) || now.toISOString(),
    updated_at: now.toISOString()
  };
}

export function normalizeCommentInput(body = {}, session = {}, now = new Date()) {
  const content = cleanText(body.content ?? body.text, 500);
  if (!content) return null;
  return {
    id: cleanIdentifier(body.id, 80) || `comment_${nanoid(12)}`,
    user_id: cleanText(session.user_id, 80) || "anonymous",
    nickname: cleanText(session.nickname, 32) || "viewer",
    type: "comment",
    content,
    parent_interaction_id: cleanIdentifier(body.parent_interaction_id ?? body.parentInteractionId, 80),
    created_at: now.toISOString()
  };
}

export function likeInteractionInput({ postId, session, now = new Date() }) {
  return {
    id: `like_${postId}_${cleanIdentifier(session?.user_id, 80) || "anonymous"}`,
    user_id: cleanText(session?.user_id, 80) || "anonymous",
    nickname: cleanText(session?.nickname, 32) || "viewer",
    type: "like",
    content: "",
    parent_interaction_id: "",
    created_at: now.toISOString()
  };
}

function normalizeMemory(input, clock) {
  const content = cleanText(input.content, 700);
  if (!content || sensitivePattern.test(content)) return null;
  return {
    id: cleanIdentifier(input.id, 80) || `memory_${nanoid(12)}`,
    character_id: cleanIdentifier(input.character_id ?? input.characterId, 48) || characterId,
    user_id: cleanText(input.user_id ?? input.userId, 80),
    type: normalizeMemoryType(input.type),
    source: cleanIdentifier(input.source, 48) || "system",
    source_id: cleanIdentifier(input.source_id ?? input.sourceId, 80),
    content,
    importance: clampNumber(input.importance, 0, 1, 0.5),
    emotion: cleanIdentifier(input.emotion, 48),
    tags: cleanTags(input.tags),
    created_at: cleanDate(input.created_at ?? input.createdAt) || clock().toISOString(),
    expires_at: cleanDate(input.expires_at ?? input.expiresAt) || null
  };
}

function normalizeMemoryType(value) {
  const type = cleanIdentifier(value, 48);
  return ["event", "preference", "relationship", "commitment", "summary"].includes(type) ? type : "event";
}

function memoryLine(memory) {
  const when = shortDate(memory.created_at);
  const owner = memory.user_id ? "和网友有关" : "Hoshia 自己";
  return `${when} ${owner} ${memoryTypeLabel(memory.type)}：${cleanText(memory.content, 220)}`;
}

function memoryTypeLabel(type) {
  const labels = {
    event: "生活片段",
    preference: "偏好",
    relationship: "关系线索",
    commitment: "约定",
    summary: "摘要"
  };
  return labels[type] || "记录";
}

function lifeActivityLabel(activity) {
  const labels = {
    idle: "日常",
    gaming: "游戏",
    sports: "运动",
    otaku: "兴趣",
    sleepy: "困困",
    happy: "开心",
    thinking: "思考",
    emo: "低电量"
  };
  return labels[activity] || "日常";
}

function memoryPacketQuery({ query = "", scene = "", postId = "", batch = [] } = {}) {
  return [
    query,
    scene,
    postId,
    ...(Array.isArray(batch) ? batch.map((item) => item?.text || "") : [])
  ].filter(Boolean).join(" ");
}

function rankMemoryPacketCandidates({ memories = [], userId = "", query = "", postId = "", now = new Date(), limit = 6 } = {}) {
  const byId = new Map();
  for (const memory of memories) {
    if (!memory || sensitivePattern.test(memory.content || "")) continue;
    const score = memoryPacketScore(memory, { userId, query, postId, now });
    const previous = byId.get(memory.id);
    if (!previous || score > previous._packet_score) {
      byId.set(memory.id, { ...memory, _packet_score: score });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b._packet_score - a._packet_score ||
      b.importance - a.importance ||
      String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, Math.max(1, Math.min(Math.floor(Number(limit) || 6), 20)));
}

function memoryPacketScore(memory, { userId = "", query = "", postId = "", now = new Date() } = {}) {
  let score = Number(memory.match_score || 0) + Number(memory.importance || 0) * 10;
  if (memory.user_id && userId && memory.user_id === userId) score += 20;
  if (memory.type === "commitment") score += 70;
  if (memory.source === "post_reply") score += 45;
  if (memory.source === "post_comment") score += 40;
  if (postId && memory.source_id === postId) score += 60;
  if (questionLike(memory.content)) score += questionLike(query) ? 30 : 12;
  if (commitmentLike(memory.content)) score += 25;
  score += recencyScore(memory.created_at, now);
  return score;
}

function recencyScore(value, now = new Date()) {
  const created = new Date(value).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(current)) return 0;
  const ageDays = Math.max(0, (current - created) / 86400000);
  return Math.max(0, 10 - Math.min(ageDays, 10));
}

function importanceForText(text, fallback) {
  const value = String(text || "");
  let score = fallback;
  if (/(记住|remember|答应|promise|承诺|说过|截图|下次|喜欢|讨厌)/i.test(value)) score += 0.22;
  if (/(动态|评论|主页|练|排位|游戏|电竞|项目|小房间|Hoshia)/i.test(value)) score += 0.12;
  if (questionLike(value)) score += 0.12;
  if (value.length >= 80) score += 0.08;
  return clampNumber(score, 0, 1, fallback);
}

function commitmentLike(text) {
  return /(答应|承诺|promise|说过|记住|remember|下次|截图|给你看)/i.test(String(text || ""));
}

function questionLike(text) {
  const value = String(text || "").trim();
  return /[?？]$/.test(value) ||
    /(?:吗|呢|么|是不是|有没有|会不会|能不能|要不要|练了吗|了吗|what|why|when|where|how|did you|do you|can you)/i.test(value);
}

function emotionForText(text) {
  const value = String(text || "").toLowerCase();
  if (/(喜欢|可爱|谢谢|开心|love|cute|nice)/i.test(value)) return "positive";
  if (/(菜|多练|输|气|annoy|tilt|bad)/i.test(value)) return "teasing";
  if (/(难过|孤独|emo|sad|lonely)/i.test(value)) return "low";
  return "";
}

function topicTags(text) {
  const value = String(text || "").toLowerCase();
  const tags = [];
  if (/(游戏|电竞|排位|game|gaming)/i.test(value)) tags.push("gaming");
  if (/(番|动漫|二次元|anime|manga)/i.test(value)) tags.push("otaku");
  if (/(运动|训练|跑步|sport|gym)/i.test(value)) tags.push("sports");
  if (/(动态|评论|主页|post|comment)/i.test(value)) tags.push("posts");
  return tags;
}

function cleanTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((item) => cleanIdentifier(item, 40))
    .filter(Boolean)
    .slice(0, 8);
}

function cleanUrl(value, maxLength) {
  const text = cleanText(value, maxLength);
  if (!text) return "";
  if (/^(?:\/|https?:\/\/|data:image\/)/i.test(text)) return text;
  return "";
}

function cleanDate(value) {
  const text = cleanText(value, 40);
  if (!text || Number.isNaN(Date.parse(text))) return "";
  return new Date(text).toISOString();
}

function cleanIdentifier(value, maxLength = 48) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_")
    .slice(0, maxLength);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function daysFromNow(date, days) {
  return new Date(date.getTime() + days * 86400000).toISOString();
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toISOString().slice(0, 10);
}
