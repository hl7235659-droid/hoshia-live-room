import { type CSSProperties, type MouseEvent, useEffect, useState } from "react";
import { ChevronLeft, Clock, Gamepad2, LockKeyhole, Menu, Play, Settings, Signal, Sparkles, Users, X } from "lucide-react";
import { getAnimatedStageLabel } from "../CharacterStage";
import { AccountAvatar } from "./AccountPanels";
import { gameCatalog } from "../demoLiveRoomData";
import type { AudiencePayload, AudienceUser, CharacterState, RoomInfo, Session } from "../types";

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
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

export function GameLauncherOverlay({
  onClose,
  onLaunch
}: {
  onClose: () => void;
  onLaunch: (gameId: string) => void;
}) {
  return (
    <section className="game-launcher-backdrop" aria-label="Hoshia arcade game selector">
      <div className="game-launcher-scanline" aria-hidden="true" />
      <div className="game-launcher-panel">
        <header className="game-launcher-header">
          <div>
            <span>HOSHIA ARCADE</span>
            <strong>星见像素游戏机</strong>
          </div>
          <button type="button" className="game-launcher-close" aria-label="关闭游戏机菜单" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="game-launcher-screen">
          <div className="game-launcher-status">
            <span>GAME SLOT</span>
            <b>01 / {String(gameCatalog.length).padStart(2, "0")}</b>
          </div>
          <div className="game-launcher-grid">
            {gameCatalog.map((game, index) => {
              const available = game.status === "available";
              return (
                <article key={game.id} className={`game-launcher-card ${available ? "available" : "soon"}`}>
                  <div className="game-launcher-cartridge" aria-hidden="true">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <i />
                  </div>
                  <div className="game-launcher-copy">
                    <em>{game.genre}</em>
                    <strong>{game.title}</strong>
                    <p>{game.description}</p>
                    <small>{game.meta}</small>
                  </div>
                  <button
                    type="button"
                    disabled={!available}
                    onClick={() => onLaunch(game.id)}
                    aria-label={available ? `启动 ${game.title}` : `${game.title} 尚未开放`}
                  >
                    {available ? <Play size={14} /> : null}
                    {available ? "启动" : "COMING SOON"}
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

export function LiveOverlay({
  state,
  session,
  room,
  socketStatus,
  audience,
  onOpenAccount,
  onOpenSettings,
  onOpenTimeline,
  onOpenGame,
  onLeave
}: {
  state: CharacterState;
  session: Session;
  room: RoomInfo | null;
  socketStatus: string;
  audience: AudiencePayload | null;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onOpenTimeline: () => void;
  onOpenGame: () => void;
  onLeave: () => void;
}) {
  const [islandOpen, setIslandOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  function toggleIsland() {
    setIslandOpen((current) => {
      if (current) setMenuOpen(false);
      return !current;
    });
  }

  function toggleMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setMenuOpen((current) => !current);
  }

  return (
    <section className="live-overlay" aria-label="星见终端浮层">
      <header className={`overlay-top ${islandOpen ? "island-expanded" : ""}`}>
        <button
          type="button"
          className="island-leave-link"
          aria-label="离开联系入口"
          onClick={onLeave}
        >
          <ChevronLeft size={22} strokeWidth={2.25} />
        </button>
        <div className={`atomic-island ${islandOpen ? "expanded" : ""}`}>
          <button
            type="button"
            className="atomic-island-summary"
            aria-label="切换联系状态"
            aria-expanded={islandOpen}
            onClick={toggleIsland}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggleIsland();
            }}
          >
            <span className="island-live-dot" aria-hidden="true" />
            <span className="island-title">
              <strong>星见终端</strong>
              <small>特别联系人</small>
            </span>
            <span className="island-equalizer" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </button>
          {islandOpen ? (
            <button
              type="button"
              className="island-menu-button"
              aria-label="Open account menu"
              aria-expanded={menuOpen}
              onClick={toggleMenu}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen((current) => !current);
              }}
            >
              <Menu size={20} strokeWidth={2.1} />
            </button>
          ) : null}
          {islandOpen && menuOpen ? (
            <div className="island-menu-popover" role="menu" aria-label="联系状态控制">
              <button
                type="button"
                className="island-action primary"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenAccount();
                }}
              >
                <AccountAvatar session={session} size="tiny" />
                <span>联系人账号</span>
                <strong>@{session.nickname}</strong>
              </button>
              <button
                type="button"
                className="island-action primary"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings size={16} />
                <span>设置</span>
                <strong>声音 / 颜色</strong>
              </button>
              <div className="island-action status" role="note">
                <LockKeyhole size={14} />
                <span>私密联系</span>
              </div>
            </div>
          ) : null}
        </div>
        <span className="island-right-spacer" aria-hidden="true" />
      </header>

      <div className="stage-headline">
        <p className="stage-kicker">Hoshia 2.0</p>
        <AnimatedStageTitle text={getAnimatedStageLabel(state)} />
      </div>

      <AudienceBookmark audience={audience} room={room} />

      {connectionNotice(socketStatus) ? (
        <div className="connection-notice">
          <Signal size={13} />
          <span>{connectionNotice(socketStatus)}</span>
        </div>
      ) : null}
      <button
        type="button"
        className="game-open-link"
        aria-label="打开 Hoshia 游戏机 / Open Hoshia arcade"
        onClick={onOpenGame}
        title="Hoshia 像素游戏机"
      >
        <Gamepad2 size={18} strokeWidth={2.2} />
      </button>
      <button
        type="button"
        className="timeline-open-link"
        aria-label="打开 Hoshia 近况"
        onClick={onOpenTimeline}
        title="Hoshia 的动态"
      >
        <Sparkles size={18} strokeWidth={2.2} />
      </button>
    </section>
  );
}

function AudienceBookmark({ audience, room }: { audience: AudiencePayload | null; room: RoomInfo | null }) {
  const [open, setOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const users = audience?.users || [];
  const selectedUser = users.find((user) => user.user_id === selectedUserId) || null;
  const onlineCount = audience?.online_count ?? room?.online ?? 0;
  const registeredCount = audience?.registered_count ?? room?.registered ?? users.length;

  useEffect(() => {
    if (!selectedUserId) return;
    if (!users.some((user) => user.user_id === selectedUserId)) {
      setSelectedUserId(null);
    }
  }, [selectedUserId, users]);

  return (
    <aside className={`audience-bookmark ${open ? "open" : ""}`} aria-label="特别联系人">
      <button
        type="button"
        className="audience-tab"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title="查看特别联系人和联系状态"
      >
        <Users size={16} />
        <strong>{onlineCount}</strong>
        <span>/</span>
        <small>{registeredCount}</small>
      </button>

      {open ? (
        <section className="audience-panel">
          <div className="audience-panel-head">
            <div>
              <span>特别联系人</span>
              <strong>{onlineCount} 已接入 / {registeredCount} 已登记</strong>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭联系人面板">
              <X size={15} />
            </button>
          </div>

          <div className="audience-list" role="list">
            {users.length ? users.map((user) => (
              <button
                key={user.user_id}
                type="button"
                className={`audience-row ${user.online ? "online" : "offline"} ${selectedUser?.user_id === user.user_id ? "selected" : ""}`}
                onClick={() => setSelectedUserId((current) => current === user.user_id ? null : user.user_id)}
                role="listitem"
              >
                <AccountAvatar session={{ nickname: user.nickname, avatar_url: user.avatar_url }} size="tiny" />
                <span className="audience-row-name">
                  <strong>{user.nickname}</strong>
                  <small>{user.online ? "已接入" : "未接入"}</small>
                </span>
                <i aria-label={user.online ? "已接入" : "未接入"} />
              </button>
            )) : (
              <p className="audience-empty">还没有特别联系人资料。</p>
            )}
          </div>

          {selectedUser ? (
            <AudienceUserCard user={selectedUser} />
          ) : (
            <p className="audience-detail-hint">点选特别联系人查看账号信息和停留时长。</p>
          )}
        </section>
      ) : null}
    </aside>
  );
}

function AudienceUserCard({ user }: { user: AudienceUser }) {
  const [liveSeconds, setLiveSeconds] = useState(user.current_online_seconds);
  useEffect(() => {
    setLiveSeconds(user.current_online_seconds);
    if (!user.online) return undefined;
    const timer = window.setInterval(() => {
      setLiveSeconds((current) => current + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [user.user_id, user.current_online_seconds, user.online]);

  const totalSeconds = user.total_online_seconds + (user.online ? liveSeconds : 0);
  return (
    <section className={`audience-user-card ${user.online ? "online" : "offline"}`} aria-label={`${user.nickname} 联系人信息`}>
      <div className="audience-user-title">
        <AccountAvatar session={{ nickname: user.nickname, avatar_url: user.avatar_url }} />
        <div>
          <span>@{user.nickname}</span>
          <strong>{user.username || "特别联系人"}</strong>
        </div>
      </div>
      <dl>
        <div>
          <dt>联系状态</dt>
          <dd>{user.online ? "已接入" : "未接入"}</dd>
        </div>
        <div>
          <dt>登记时间</dt>
          <dd>{formatShortDate(user.registered_at)}</dd>
        </div>
        <div>
          <dt>上次接入</dt>
          <dd>{user.last_login_at ? formatShortDate(user.last_login_at) : "暂无接入记录"}</dd>
        </div>
        <div>
          <dt><Clock size={12} /> 累计停留</dt>
          <dd>{formatDuration(totalSeconds)}</dd>
        </div>
      </dl>
    </section>
  );
}

function AnimatedStageTitle({ text }: { text: string }) {
  return (
    <h2 className="animated-stage-title" aria-label={text}>
      {Array.from(text).map((char, index) => (
        <span
          key={`${char}-${index}`}
          className={char === "." ? "dot" : undefined}
          style={{ "--jump-index": index } as CSSProperties}
          aria-hidden="true"
        >
          {char}
        </span>
      ))}
    </h2>
  );
}

function connectionNotice(status: string) {
  if (status === "connecting") return "正在打开私密联系入口...";
  if (status === "reconnecting" || status === "closed") return "联系中断，正在尝试恢复...";
  if (status === "error") return "联系暂停，当前状态仍会保留。";
  return "";
}
