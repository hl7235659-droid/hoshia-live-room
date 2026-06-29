import { Fragment, type CSSProperties, type FormEvent, useState } from "react";
import { ChevronLeft, Heart, MessageCircle, Send, Sparkles } from "lucide-react";
import type { HoshiaPost, HoshiaVisualState, Session } from "../types";

const appBase = import.meta.env.BASE_URL || "/";

function appPath(path: string) {
  const base = appBase.endsWith("/") ? appBase : `${appBase}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}
const timelineAvatarUrl = appPath("assets/hoshia-timeline-avatar-new.jpg");
const timelineBgUrl = appPath("assets/hoshia-timeline-bg.jpg");

export function HoshiaTimelineOverlay({
  session,
  posts,
  visualState,
  onClose,
  onLike,
  onComment
}: {
  session: Session;
  posts: HoshiaPost[];
  visualState: HoshiaVisualState | null;
  onClose: () => void;
  onLike: (postId: string) => Promise<void>;
  onComment: (postId: string, content: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyPostId, setBusyPostId] = useState("");
  const energy = visualState?.energy ?? 72;
  const socialNeed = visualState?.social_need ?? 48;

  async function submitComment(postId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = String(drafts[postId] || "").trim();
    if (!content || busyPostId) return;
    setBusyPostId(postId);
    try {
      await onComment(postId, content);
      setDrafts((current) => ({ ...current, [postId]: "" }));
    } finally {
      setBusyPostId("");
    }
  }

  async function likePost(postId: string) {
    if (busyPostId) return;
    setBusyPostId(postId);
    try {
      await onLike(postId);
    } finally {
      setBusyPostId("");
    }
  }

  return (
    <section
      className="hoshia-timeline-shell"
      aria-label="Hoshia 近况"
      style={{ "--timeline-bg": `url("${timelineBgUrl}")` } as CSSProperties}
    >
      <div className="timeline-bg-mark" aria-hidden="true">H</div>
      <header className="timeline-topbar">
        <button type="button" aria-label="返回星见终端" onClick={onClose}>
          <ChevronLeft size={20} />
        </button>
        <strong>Hoshia 的动态</strong>
      </header>

      <div className="timeline-scroll">
        <section className="timeline-profile-card">
          <div className="timeline-avatar">
            <img src={timelineAvatarUrl} alt="" />
          </div>
          <div>
            <span className="timeline-eyebrow">soft console</span>
            <div className="timeline-name-row">
              <h2>Hoshia</h2>
              <span className="timeline-live-pill"><Sparkles size={14} /> 近况</span>
            </div>
            <p>今天也在星港里整理状态、动态和一点点嘴硬。</p>
          </div>
        </section>

        <section className="timeline-stats-card" aria-label="Hoshia 当前联系状态">
          <TimelineMetric label="活动" value={activityLabel(visualState?.activity || "idle")} />
          <TimelineMetric label="心情" value={moodLabel(visualState?.mood || "calm")} />
          <TimelineMetric label="能量" value={`${energy}%`} />
          <TimelineMetric label="陪伴感" value={`${100 - socialNeed}%`} />
        </section>

        <section className="timeline-feed" aria-label="Hoshia 近况留言">
          {posts.length ? posts.map((post) => (
            <article className="timeline-post-card" key={post.id}>
              <div className="post-watermark" aria-hidden="true">Hoshia</div>
              <header className="post-head">
                <div className="post-author">
                  <img className="post-author-avatar" src={timelineAvatarUrl} alt="" />
                  <strong>Hoshia</strong>
                </div>
                <span>{timelineStatusLabel(post.activity, post.mood)}</span>
              </header>
              <p className="post-content">{post.content}</p>
              {post.image_url ? (
                <div className="post-image-frame">
                  <img src={timelineImageUrl(post.image_url)} alt="" />
                </div>
              ) : null}
              <footer className="post-actions">
                <button
                  type="button"
                  className={post.liked_by_viewer ? "liked" : ""}
                  onClick={() => void likePost(post.id)}
                  disabled={busyPostId === post.id}
                >
                  <Heart size={16} fill={post.liked_by_viewer ? "currentColor" : "none"} />
                  <span>{post.like_count}</span>
                </button>
                <span><MessageCircle size={16} /> {post.comment_count}</span>
                <time>{formatShortDate(post.created_at)}</time>
              </footer>
              {post.interactions.length ? (
                <div className="post-comments">
                  {post.interactions.map((interaction) => (
                    <Fragment key={interaction.id}>
                      <div className={`post-comment ${interaction.nickname === "Hoshia" ? "hoshia" : ""}`}>
                        <strong>{interaction.nickname || (interaction.user_id === session.user_id ? session.nickname : "特别联系人")}</strong>
                        <span>{interaction.content}</span>
                      </div>
                      {interaction.type === "comment" && interaction.reply_status === "pending" ? (
                        <div className="post-comment-pending" aria-live="polite">Hoshia 稍后回复</div>
                      ) : null}
                    </Fragment>
                  ))}
                </div>
              ) : null}
              <form className="post-comment-form" onSubmit={(event) => void submitComment(post.id, event)}>
                <input
                  value={drafts[post.id] || ""}
                  onChange={(event) => setDrafts((current) => ({ ...current, [post.id]: event.target.value }))}
                  maxLength={180}
                  placeholder="写一句给 Hoshia..."
                />
                <button type="submit" disabled={!String(drafts[post.id] || "").trim() || busyPostId === post.id}>
                  <Send size={15} />
                </button>
              </form>
            </article>
          )) : (
            <section className="timeline-empty">
              <Sparkles size={22} />
              <strong>还没有动态</strong>
              <p>等 Hoshia 整理好今天的小心情，这里会亮起来。</p>
            </section>
          )}
        </section>
      </div>
    </section>
  );
}

function TimelineMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function timelineImageUrl(value: string) {
  if (/^(https?:|data:image\/)/i.test(value)) return value;
  return appPath(value);
}

function timelineStatusLabel(activity: string, mood: string) {
  if (activity === "gaming") return mood === "annoyed" ? "排位生气中" : "电竞中";
  if (activity === "otaku") return "补番中";
  if (activity === "sports") return mood === "tired" ? "运动后" : "训练中";
  if (activity === "sleepy") return "有点困";
  if (activity === "thinking") return "构思中";
  if (activity === "emo") return "低电量";
  if (activity === "happy") return "心情很好";
  return "今日碎碎念";
}

function activityLabel(activity: string) {
  const labels: Record<string, string> = {
    idle: "待机",
    gaming: "电竞",
    sports: "运动",
    otaku: "补番",
    sleepy: "困倦",
    happy: "开心",
    thinking: "思考",
    emo: "低落"
  };
  return labels[activity] || activity;
}

function moodLabel(mood: string) {
  const labels: Record<string, string> = {
    calm: "平静",
    curious: "好奇",
    competitive: "好胜",
    annoyed: "不服气",
    energetic: "元气",
    tired: "累了",
    excited: "兴奋",
    sleepy: "困",
    lonely: "想陪伴",
    happy: "开心",
    playful: "想逗你",
    thinking: "思考",
    focused: "专注",
    emo: "低落"
  };
  return labels[mood] || mood;
}
function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
