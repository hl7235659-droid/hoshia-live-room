import { type CSSProperties, FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Camera, CheckCircle2, ChevronDown, ChevronLeft, ChevronUp, Clock, Image, KeyRound, Lock, LockKeyhole, LogIn, Menu, Save, Send, ShieldCheck, Signal, UserCircle, UserPlus, Users, X } from "lucide-react";
import { CharacterStage, getAnimatedStageLabel } from "./CharacterStage";
import { colorForMessage } from "./messageColors";
import type { AudiencePayload, AudienceUser, CharacterState, LiveMessage, RoomInfo, Session } from "./types";
import { toCharacterState } from "./types";
import "./styles.css";

const appBase = import.meta.env.BASE_URL || "/";
const loginMascotUrl = appPath("assets/hoshia-login-chibi.png");
const isStageDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "stage";
const demoSession: Session = { user_id: "demo", username: "designer", nickname: "designer", avatar_url: "", room_id: "live-room-dev" };
const demoRoom: RoomInfo = { room_id: "live-room-dev", online: 2, registered: 4, private: true, websocket_auth: true };
const demoAudience: AudiencePayload = {
  ok: true,
  online_count: 2,
  registered_count: 4,
  users: [
    { user_id: "demo", username: "designer", nickname: "designer", avatar_url: "", online: true, registered_at: "2026-06-07T00:00:00.000Z", last_login_at: "2026-06-07T12:00:00.000Z", total_online_seconds: 4280, current_online_seconds: 320 },
    { user_id: "friend-a", username: "mika", nickname: "Mika", avatar_url: "", online: true, registered_at: "2026-06-07T02:10:00.000Z", last_login_at: "2026-06-07T12:12:00.000Z", total_online_seconds: 1930, current_online_seconds: 180 },
    { user_id: "friend-b", username: "blue", nickname: "Blue", avatar_url: "", online: false, registered_at: "2026-06-06T10:20:00.000Z", last_login_at: "2026-06-07T09:00:00.000Z", total_online_seconds: 8640, current_online_seconds: 0 },
    { user_id: "friend-c", username: "ruru", nickname: "Ruru", avatar_url: "", online: false, registered_at: "2026-06-05T08:00:00.000Z", last_login_at: null, total_online_seconds: 0, current_online_seconds: 0 }
  ]
};

function appPath(path: string) {
  const base = appBase.endsWith("/") ? appBase : `${appBase}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

function wsPath(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${appPath(path)}`;
}

function App() {
  const [session, setSession] = useState<Session | null>(() => (isStageDemo ? demoSession : null));
  const [room, setRoom] = useState<RoomInfo | null>(() => (isStageDemo ? demoRoom : null));
  const [audience, setAudience] = useState<AudiencePayload | null>(() => (isStageDemo ? demoAudience : null));
  const [gatePassed, setGatePassed] = useState(isStageDemo);
  const [authChecked, setAuthChecked] = useState(isStageDemo);
  const [messages, setMessages] = useState<LiveMessage[]>(seedMessages);
  const [characterState, setCharacterState] = useState<CharacterState>("IDLE");
  const [socketStatus, setSocketStatus] = useState(isStageDemo ? "demo" : "locked");

  useEffect(() => {
    if (isStageDemo) return;
    let disposed = false;

    async function checkAuth() {
      try {
        const payload = await fetch(appPath("api/auth/me")).then((res) => (res.ok ? res.json() : null));
        if (disposed) return;
        if (payload?.user) {
          setSession(payload.user);
          setRoom(payload.room);
          setAudience((current) => current ? {
            ...current,
            online_count: payload.room?.online ?? current.online_count,
            registered_count: payload.room?.registered ?? current.registered_count
          } : current);
          setGatePassed(true);
          return;
        }

        const gate = await fetch(appPath("api/auth/gate")).then((res) => (res.ok ? res.json() : null));
        if (!disposed) setGatePassed(Boolean(gate?.passed));
      } catch {
        if (!disposed) setGatePassed(false);
      } finally {
        if (!disposed) setAuthChecked(true);
      }
    }

    void checkAuth();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!session || isStageDemo) return;

    async function refreshAudience() {
      try {
        const payload = await fetch(appPath("api/room/audience")).then((res) => (res.ok ? res.json() : null));
        if (payload?.ok) {
          setAudience(payload);
          setRoom((current) => current ? {
            ...current,
            online: payload.online_count,
            registered: payload.registered_count
          } : current);
        }
      } catch {
        // Audience data is optional UI chrome; keep the live room usable if it fails.
      }
    }

    fetch(appPath("api/room/state"))
      .then((res) => res.json())
      .then((payload) => {
        setRoom(payload.room);
        setCharacterState(toCharacterState(payload.state));
        if (payload.messages?.length) setMessages(payload.messages);
      })
      .catch(() => undefined);
    void refreshAudience();

    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: number | undefined;
    let retryCount = 0;

    function handleSocketMessage(event: MessageEvent) {
      const payload = JSON.parse(event.data);
      if (["danmaku", "ai_reply", "presence"].includes(payload.type)) {
        setMessages((current) => [...current.slice(-40), payload]);
      }
      if (payload.type === "error") {
        setSocketStatus("error");
        setCharacterState("ERROR");
        setMessages((current) => [...current.slice(-40), localLine("system", "room", friendlyError(payload.error))]);
      }
      if (payload.type === "room_state") {
        setRoom(payload.room);
        setCharacterState(toCharacterState(payload.state));
      }
      if (payload.type === "character_state") {
        setCharacterState(toCharacterState(payload.state));
      }
      if (payload.type === "presence") {
        setRoom((current) => (current ? { ...current, online: payload.online ?? current.online } : current));
      }
      if (payload.type === "audience_changed") {
        setAudience((current) => current ? {
          ...current,
          online_count: payload.online_count ?? current.online_count,
          registered_count: payload.registered_count ?? current.registered_count
        } : current);
        setRoom((current) => current ? {
          ...current,
          online: payload.online_count ?? current.online,
          registered: payload.registered_count ?? current.registered
        } : current);
        void refreshAudience();
      }
    }

    function connectSocket() {
      if (disposed) return;
      setSocketStatus(retryCount ? "reconnecting" : "connecting");
      ws = new WebSocket(wsPath("ws/live"));
      (window as Window & { liveRoomSocket?: WebSocket }).liveRoomSocket = ws;

      ws.addEventListener("open", () => {
        retryCount = 0;
        setSocketStatus("live");
      });
      ws.addEventListener("close", () => {
        if (disposed) return;
        setSocketStatus("closed");
        setCharacterState("ERROR");
        retryTimer = window.setTimeout(() => {
          retryCount += 1;
          connectSocket();
        }, Math.min(4200, 1200 + retryCount * 700));
      });
      ws.addEventListener("error", () => {
        if (disposed) return;
        setSocketStatus("error");
        setCharacterState("ERROR");
      });
      ws.addEventListener("message", handleSocketMessage);
    }

    connectSocket();

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
      delete (window as Window & { liveRoomSocket?: WebSocket }).liveRoomSocket;
    };
  }, [session]);

  if (!authChecked) {
    return <GateLoadingView />;
  }

  if (!session && !gatePassed) {
    return <GateView onUnlock={() => setGatePassed(true)} />;
  }

  if (!session) {
    return <LoginView onLogin={(user, nextRoom) => { setSession(user); setRoom(nextRoom); }} />;
  }

  return (
    <LiveMobile
      session={session}
      room={room}
      messages={messages}
      characterState={characterState}
      socketStatus={socketStatus}
      isDemo={isStageDemo}
      onLocalSendStart={() => {
        setCharacterState("LISTENING");
        window.setTimeout(() => setCharacterState((current) => (current === "LISTENING" ? "THINKING" : current)), 420);
      }}
      onDemoSend={isStageDemo ? (text) => {
        setMessages((current) => [...current.slice(-40), localLine("user", session.nickname, text)]);
        setCharacterState("LISTENING");
        window.setTimeout(() => setCharacterState((current) => (current === "LISTENING" ? "THINKING" : current)), 420);
        window.setTimeout(() => {
          setMessages((current) => [...current.slice(-40), localLine("ai", "hoshia", demoReply(text))]);
          setCharacterState("SPEAKING");
        }, 980);
        window.setTimeout(() => setCharacterState("IDLE"), 2400);
      } : undefined}
      onSessionUpdate={(nextUser) => {
        setSession((current) => (current ? { ...current, ...nextUser } : current));
      }}
      onLeave={() => {
        setSession(null);
        setRoom(null);
        setAudience(null);
        setSocketStatus("locked");
        setCharacterState("IDLE");
      }}
      audience={audience}
    />
  );
}

function GateLoadingView() {
  return (
    <main className="phone-shell">
      <section className="login-card gate-only-card">
        <div className="gate-header">
          <div className="login-mark" />
          <div className="gate-status">
            <span>Room gate</span>
            <strong>Checking access</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

function GateView({ onUnlock }: { onUnlock: () => void }) {
  const [roomToken, setRoomToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    const response = await fetch(appPath("api/auth/gate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomToken })
    });
    setBusy(false);

    if (!response.ok) {
      setError("Room token is not valid.");
      return;
    }

    onUnlock();
  }

  return (
    <main className="phone-shell">
      <section className="login-card gate-only-card">
        <div className="gate-header">
          <div className="login-mark" />
          <div className="gate-status">
            <span>Room gate</span>
            <strong>Private doorway</strong>
          </div>
        </div>
        <h1>Hoshia Live</h1>
        <p>Enter the room token first. After the gate opens, you can log in or register.</p>
        <section className="login-welcome" aria-label="Hoshia room gate">
          <div className="login-mascot">
            <img src={loginMascotUrl} alt="Hoshia welcomes you at the private room gate" draggable={false} />
          </div>
          <div className="welcome-bubble">
            <strong>Private gate.</strong>
            <span>I will show the account room after the token matches.</span>
          </div>
        </section>
        <div className="gate-strip" aria-label="Private room safety notes">
          <span><ShieldCheck size={14} /> Friends only</span>
          <span><LockKeyhole size={14} /> Token gate</span>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>Room token</span>
            <input value={roomToken} onChange={(event) => setRoomToken(event.target.value)} type="password" placeholder="Room token" />
          </label>
          {error ? <span className="login-error">{error}</span> : null}
          <button disabled={busy || !roomToken} type="submit">
            <KeyRound size={16} />
            {busy ? "Checking gate..." : "Open gate"}
          </button>
        </form>
      </section>
    </main>
  );
}

function LoginView({ onLogin }: { onLogin: (user: Session, room: RoomInfo) => void }) {
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [roomPreview, setRoomPreview] = useState<{ online: number; private: boolean }>({ online: 0, private: true });

  useEffect(() => {
    fetch(appPath("api/room/preview"))
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (payload?.room) {
          setRoomPreview({
            online: payload.room.online ?? 0,
            private: Boolean(payload.room.private)
          });
        }
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    const isRegistering = authMode === "register";
    const response = await fetch(appPath(isRegistering ? "api/auth/register" : "api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isRegistering
        ? { username, password, registrationCode }
        : { username, password })
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(authErrorMessage(payload?.error, authMode));
      return;
    }

    if (isRegistering) {
      setAuthMode("login");
      setPassword("");
      setRegistrationCode("");
      setNotice("Account created. Enter your password and click login.");
      return;
    }

    const payload = await response.json();
    const me = await fetch(appPath("api/auth/me")).then((res) => res.json());
    onLogin(payload.user, me.room);
  }

  return (
    <main className="phone-shell">
      <section className="login-card">
        <div className="gate-header">
          <div className="login-mark" />
          <div className="gate-status">
            <span>Account gate</span>
            <strong>{authMode === "register" ? "Create access" : "Private access"}</strong>
          </div>
          <button type="button" className="room-preview-button" onClick={() => setPreviewOpen((current) => !current)}>
            <Users size={14} />
            <span>{roomPreview.online} online</span>
            {previewOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
        {previewOpen ? (
          <div className="room-preview-panel">
            <div className="preview-avatar-stack" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p>{roomPreview.online ? "Friends are already inside." : "No friends are visible inside yet."}</p>
            <small>Names and avatars will appear after the account system is connected.</small>
          </div>
        ) : null}
        <h1>Hoshia Live</h1>
        <p>{authMode === "register" ? "Use a one-time code to create your account." : "Use your account to enter the friends-only stage."}</p>
        <section className="login-welcome" aria-label="Hoshia welcome">
          <div className="login-mascot">
            <img src={loginMascotUrl} alt="Hoshia welcomes you at the private room gate" draggable={false} />
          </div>
          <div className="welcome-bubble">
            <strong>{authMode === "register" ? "First visit?" : "Welcome back."}</strong>
            <span>{authMode === "register" ? "Your account can be personalized later in profile." : "The room is locked. I will open it after your password matches."}</span>
          </div>
        </section>
        <div className="gate-strip" aria-label="Private room safety notes">
          <span><ShieldCheck size={14} /> Friends only</span>
          <span><LockKeyhole size={14} /> Account protected</span>
        </div>
        <form onSubmit={submit}>
          <div className="auth-switch" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              className={authMode === "login" ? "active" : ""}
              onClick={() => {
                setAuthMode("login");
                setError("");
                setNotice("");
              }}
            >
              <LogIn size={15} />
              <span>Login</span>
            </button>
            <button
              type="button"
              className={authMode === "register" ? "active" : ""}
              onClick={() => {
                setAuthMode("register");
                setError("");
                setNotice("");
              }}
            >
              <UserPlus size={15} />
              <span>Register</span>
            </button>
          </div>
          <label>
            <span>Account</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} placeholder="hoshia_friend" autoComplete="username" />
          </label>
          <label>
            <span>Password</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" autoComplete={authMode === "register" ? "new-password" : "current-password"} />
          </label>
          {authMode === "register" ? (
            <>
              <label>
                <span>Register code</span>
                <input value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value.toUpperCase())} placeholder="HOSHA-7K2P-MQ9A" />
              </label>
            </>
          ) : null}
          {error ? <span className="login-error">{error}</span> : null}
          {notice ? <span className="login-success">{notice}</span> : null}
          <button disabled={busy || !canSubmitAuth(authMode, { username, password, registrationCode })} type="submit">
            <KeyRound size={16} />
            {busy ? "Checking gate..." : authMode === "register" ? "Create account" : "Unlock room"}
          </button>
        </form>
      </section>
    </main>
  );
}

function canSubmitAuth(
  mode: "login" | "register",
  values: { username: string; password: string; registrationCode: string }
) {
  if (!values.username.trim() || !values.password) return false;
  if (mode === "login") return true;
  return Boolean(values.registrationCode.trim());
}

function authErrorMessage(error: string | undefined, mode: "login" | "register") {
  if (error === "invalid_credentials") return "Account or password is not correct.";
  if (error === "username_invalid") return "Use 3-32 letters, numbers, dots, dashes, or underscores.";
  if (error === "password_invalid") return "Password needs at least 8 characters.";
  if (error === "nickname_required") return "Display name needs at least 2 characters.";
  if (error === "username_taken") return "That account already exists. Choose another account name.";
  if (error === "gate_required") return "Open the room gate first.";
  if (error === "registration_code_invalid") return "Register code is not valid.";
  if (error === "registration_code_used") return "Register code has already been used.";
  if (error === "registration_code_expired") return "Register code has expired.";
  return mode === "register" ? "Could not create account. Check your keys." : "Could not unlock the room.";
}

function accountErrorMessage(error: string | undefined) {
  if (error === "nickname_invalid") return "Display name needs 2-24 characters.";
  if (error === "avatar_url_invalid") return "Avatar must be a valid http(s), data image, or site-relative URL.";
  if (error === "current_password_invalid") return "Current password is not correct.";
  if (error === "password_invalid") return "Password needs at least 8 characters.";
  if (error === "unauthorized") return "Session expired. Log in again.";
  return "Could not save account settings.";
}

function avatarInitials(nickname: string) {
  return nickname.trim().slice(0, 2).toUpperCase() || "ME";
}

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

function LiveMobile({
  session,
  room,
  messages,
  characterState,
  socketStatus,
  audience,
  isDemo,
  onLocalSendStart,
  onDemoSend,
  onSessionUpdate,
  onLeave
}: {
  session: Session;
  room: RoomInfo | null;
  messages: LiveMessage[];
  characterState: CharacterState;
  socketStatus: string;
  audience: AudiencePayload | null;
  isDemo: boolean;
  onLocalSendStart: () => void;
  onDemoSend?: (text: string) => void;
  onSessionUpdate: (user: Session) => void;
  onLeave: () => void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <main className="phone-shell">
      <section className="live-phone">
        <CharacterStage state={characterState} messages={messages} />
        <LiveOverlay
          state={characterState}
          session={session}
          room={room}
          socketStatus={socketStatus}
          audience={audience}
          onOpenAccount={() => setAccountOpen(true)}
          onLeave={onLeave}
        />
        <BottomDock
          messages={messages}
          audience={audience}
          socketStatus={socketStatus}
          nickname={session.nickname}
          onSendStart={onLocalSendStart}
          onDemoSend={onDemoSend}
        />
        {accountOpen ? (
          <AccountSettingsModal
            session={session}
            isDemo={isDemo}
            onClose={() => setAccountOpen(false)}
            onSessionUpdate={onSessionUpdate}
          />
        ) : null}
      </section>
    </main>
  );
}

function LiveOverlay({
  state,
  session,
  room,
  socketStatus,
  audience,
  onOpenAccount,
  onLeave
}: {
  state: CharacterState;
  session: Session;
  room: RoomInfo | null;
  socketStatus: string;
  audience: AudiencePayload | null;
  onOpenAccount: () => void;
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
    <section className="live-overlay" aria-label="Live room overlay">
      <header className={`overlay-top ${islandOpen ? "island-expanded" : ""}`}>
        <button
          type="button"
          className="island-leave-link"
          aria-label="Leave room"
          onClick={onLeave}
        >
          <ChevronLeft size={22} strokeWidth={2.25} />
        </button>
        <div className={`atomic-island ${islandOpen ? "expanded" : ""}`}>
          <button
            type="button"
            className="atomic-island-summary"
            aria-label="Toggle live room controls"
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
              <strong>Hoshia Live</strong>
              <small>friends only</small>
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
            <div className="island-menu-popover" role="menu" aria-label="Live room controls">
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
                <span>Personal account</span>
                <strong>@{session.nickname}</strong>
              </button>
              <div className="island-action status" role="note">
                <LockKeyhole size={14} />
                <span>Private</span>
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
    <aside className={`audience-bookmark ${open ? "open" : ""}`} aria-label="Room audience">
      <button
        type="button"
        className="audience-tab"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title="View online and registered members"
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
              <span>Audience</span>
              <strong>{onlineCount} online / {registeredCount} registered</strong>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close audience panel">
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
                  <small>{user.online ? "online now" : "offline"}</small>
                </span>
                <i aria-label={user.online ? "online" : "offline"} />
              </button>
            )) : (
              <p className="audience-empty">No registered member data yet.</p>
            )}
          </div>

          {selectedUser ? (
            <AudienceUserCard user={selectedUser} />
          ) : (
            <p className="audience-detail-hint">Tap a member to view account info and total room time.</p>
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
    <section className={`audience-user-card ${user.online ? "online" : "offline"}`} aria-label={`${user.nickname} account info`}>
      <div className="audience-user-title">
        <AccountAvatar session={{ nickname: user.nickname, avatar_url: user.avatar_url }} />
        <div>
          <span>@{user.nickname}</span>
          <strong>{user.username || "member"}</strong>
        </div>
      </div>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{user.online ? "Online" : "Offline"}</dd>
        </div>
        <div>
          <dt>Registered</dt>
          <dd>{formatShortDate(user.registered_at)}</dd>
        </div>
        <div>
          <dt>Last login</dt>
          <dd>{user.last_login_at ? formatShortDate(user.last_login_at) : "No login record"}</dd>
        </div>
        <div>
          <dt><Clock size={12} /> Total stay</dt>
          <dd>{formatDuration(totalSeconds)}</dd>
        </div>
      </dl>
    </section>
  );
}

function AccountSettingsModal({
  session,
  isDemo,
  onClose,
  onSessionUpdate
}: {
  session: Session;
  isDemo: boolean;
  onClose: () => void;
  onSessionUpdate: (user: Session) => void;
}) {
  const [nickname, setNickname] = useState(session.nickname);
  const [avatarUrl, setAvatarUrl] = useState(session.avatar_url || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileNotice(null);
    const nextNickname = nickname.trim();
    const nextAvatarUrl = avatarUrl.trim();

    if (nextNickname.length < 2) {
      setProfileNotice({ type: "error", text: "Display name needs at least 2 characters." });
      return;
    }

    if (isDemo) {
      onSessionUpdate({ ...session, nickname: nextNickname, avatar_url: nextAvatarUrl });
      setProfileNotice({ type: "success", text: "Demo profile updated in this preview." });
      return;
    }

    setProfileBusy(true);
    const response = await fetch(appPath("api/account/profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nextNickname, avatarUrl: nextAvatarUrl })
    });
    setProfileBusy(false);

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setProfileNotice({ type: "error", text: accountErrorMessage(payload?.error) });
      return;
    }

    onSessionUpdate(payload.user);
    setProfileNotice({ type: "success", text: "Profile saved." });
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setPasswordNotice(null);

    if (nextPassword !== confirmPassword) {
      setPasswordNotice({ type: "error", text: "New passwords do not match." });
      return;
    }
    if (nextPassword.length < 8) {
      setPasswordNotice({ type: "error", text: "Password needs at least 8 characters." });
      return;
    }

    if (isDemo) {
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setPasswordNotice({ type: "success", text: "Demo password flow is preview-only." });
      return;
    }

    setPasswordBusy(true);
    const response = await fetch(appPath("api/account/password"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, nextPassword })
    });
    setPasswordBusy(false);

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setPasswordNotice({ type: "error", text: accountErrorMessage(payload?.error) });
      return;
    }

    setCurrentPassword("");
    setNextPassword("");
    setConfirmPassword("");
    setPasswordNotice({ type: "success", text: "Password updated." });
  }

  return (
    <div className="account-modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
        <header className="account-modal-header">
          <div className="account-modal-title">
            <AccountAvatar session={{ ...session, nickname, avatar_url: avatarUrl }} />
            <div>
              <span>Personal account</span>
              <h3 id="account-settings-title">@{session.username || session.nickname}</h3>
            </div>
          </div>
          <button type="button" className="account-close-button" aria-label="Close account settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <form className="account-card" onSubmit={saveProfile}>
          <div className="account-section-heading">
            <UserCircle size={17} />
            <div>
              <strong>Profile</strong>
              <span>Nickname and avatar shown in the live room.</span>
            </div>
          </div>
          <label>
            <span>Display name</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              minLength={2}
              maxLength={24}
              placeholder="Your nickname"
              autoComplete="nickname"
            />
          </label>
          <label>
            <span>Avatar image URL</span>
            <input
              value={avatarUrl}
              onChange={(event) => setAvatarUrl(event.target.value)}
              maxLength={500}
              placeholder="https://.../avatar.png"
              autoComplete="photo"
            />
          </label>
          <div className="avatar-url-help">
            <Image size={14} />
            <span>Leave blank to use initials. Uploaded avatar storage can be added later.</span>
          </div>
          {profileNotice ? <AccountNotice notice={profileNotice} /> : null}
          <button type="submit" className="account-save-button" disabled={profileBusy || nickname.trim().length < 2}>
            {profileBusy ? <Signal size={16} /> : <Save size={16} />}
            {profileBusy ? "Saving..." : "Save profile"}
          </button>
        </form>

        <form className="account-card" onSubmit={savePassword}>
          <div className="account-section-heading">
            <KeyRound size={17} />
            <div>
              <strong>Password</strong>
              <span>Change the password for this private-room account.</span>
            </div>
          </div>
          <label>
            <span>Current password</span>
            <input
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              placeholder={isDemo ? "Demo preview" : "Current password"}
              autoComplete="current-password"
              disabled={isDemo}
            />
          </label>
          <label>
            <span>New password</span>
            <input
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
              type="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              placeholder="Repeat new password"
              autoComplete="new-password"
            />
          </label>
          {passwordNotice ? <AccountNotice notice={passwordNotice} /> : null}
          <button
            type="submit"
            className="account-save-button secondary"
            disabled={passwordBusy || nextPassword.length < 8 || confirmPassword.length < 8 || (!isDemo && !currentPassword)}
          >
            {passwordBusy ? <Signal size={16} /> : <KeyRound size={16} />}
            {passwordBusy ? "Updating..." : "Update password"}
          </button>
        </form>
      </section>
    </div>
  );
}

function AccountNotice({ notice }: { notice: { type: "success" | "error"; text: string } }) {
  return (
    <span className={`account-notice ${notice.type}`}>
      {notice.type === "success" ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
      {notice.text}
    </span>
  );
}

function AccountAvatar({ session, size = "normal" }: { session: Pick<Session, "nickname" | "avatar_url">; size?: "tiny" | "normal" }) {
  const avatarUrl = session.avatar_url?.trim();
  return (
    <span className={`account-avatar ${size}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" draggable={false} />
      ) : (
        <>
          <Camera size={size === "tiny" ? 13 : 18} />
          <strong>{avatarInitials(session.nickname)}</strong>
        </>
      )}
    </span>
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

function DanmakuHistory({ messages, onMention }: { messages: LiveMessage[]; onMention: (nickname: string) => void }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" }), [messages.length]);

  return (
    <div className="danmaku-stream">
      {messages.map((message, index) => (
        <p
          key={`${message.id}-${index}`}
          className={`line ${message.role}`}
          style={{ "--message-color": colorForMessage(message) } as CSSProperties}
        >
          <button
            type="button"
            className="mention-name"
            onClick={() => onMention(message.nickname || labelForRole(message.role))}
            title={`Mention ${message.nickname || labelForRole(message.role)}`}
          >
            {message.nickname || labelForRole(message.role)}
          </button>
          <span>{message.text}</span>
        </p>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function BottomDock({
  messages,
  audience,
  socketStatus,
  nickname,
  onSendStart,
  onDemoSend
}: {
  messages: LiveMessage[];
  audience: AudiencePayload | null;
  socketStatus: string;
  nickname: string;
  onSendStart: () => void;
  onDemoSend?: (text: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const historyCount = Math.min(messages.length, 100);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onlineMembers = (audience?.users || []).filter((user) => user.online && user.nickname !== nickname);

  function toggleHistory() {
    setHistoryOpen((current) => !current);
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const socket = (window as Window & { liveRoomSocket?: WebSocket }).liveRoomSocket;
    const nextText = text.trim();
    if (!nextText) return;
    if (socketStatus === "demo" && onDemoSend) {
      onDemoSend(nextText);
      setText("");
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    onSendStart();
    socket.send(JSON.stringify({ type: "danmaku", text: nextText }));
    setText("");
  }

  function insertMention(target: string) {
    const cleanTarget = target.replace(/^@+/, "").trim();
    if (!cleanTarget) return;
    const mention = `@${cleanTarget} `;
    setText((current) => {
      if (!current.trim()) return mention;
      if (current.endsWith(" ")) return `${current}${mention}`;
      return `${current} ${mention}`;
    });
    setMentionPickerOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  const canSend = (socketStatus === "live" || socketStatus === "demo") && Boolean(text.trim());

  return (
    <section className={`bottom-dock ${historyOpen ? "history-open" : ""}`} aria-label="Live chat dock">
      <section className={`history-drawer ${historyOpen ? "open" : ""}`} aria-label="Message history">
        <div className="history-header">
          <button
            type="button"
            className="history-toggle"
            aria-expanded={historyOpen}
            onPointerDown={(event) => {
              event.preventDefault();
              toggleHistory();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggleHistory();
            }}
          >
            {historyOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            <span>{historyOpen ? "Hide history" : "History"}</span>
          </button>
          <span className="history-count" aria-label={`${historyCount} of 100 history messages`}>
            {historyCount}/100
          </span>
        </div>
        {historyOpen ? <DanmakuHistory messages={messages} onMention={insertMention} /> : null}
      </section>
      <section className="live-control" aria-label="Live controls">
        <form className="sendbar" onSubmit={send}>
          <div className={`mention-combo ${mentionPickerOpen ? "open" : ""}`}>
            {mentionPickerOpen ? (
              <div className="mention-picker" role="listbox" aria-label="Mention online member">
                <span className="mention-picker-title">Mention online</span>
                {onlineMembers.length ? onlineMembers.map((user) => (
                  <button
                    key={user.user_id}
                    type="button"
                    className="mention-picker-row"
                    onClick={() => insertMention(user.nickname)}
                  >
                    <AccountAvatar session={{ nickname: user.nickname, avatar_url: user.avatar_url }} size="tiny" />
                    <span>@{user.nickname}</span>
                  </button>
                )) : (
                  <span className="mention-picker-empty">No one else online</span>
                )}
              </div>
            ) : null}
            <button
              type="button"
              className="mention-expand"
              onClick={() => setMentionPickerOpen((current) => !current)}
              title="Mention online member"
              aria-label="Mention online member"
              aria-expanded={mentionPickerOpen}
              disabled={socketStatus !== "live" && socketStatus !== "demo"}
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              className="mention-hoshia"
              onClick={() => insertMention("Hoshia")}
              title="Mention Hoshia"
              disabled={socketStatus !== "live" && socketStatus !== "demo"}
            >
              @Hoshia
            </button>
          </div>
          <input
            ref={inputRef}
            value={text}
            maxLength={500}
            onChange={(event) => setText(event.target.value)}
            placeholder="Send a message or @Hoshia..."
          />
          <button type="submit" title="Send" disabled={!canSend}>
            <Send size={20} />
          </button>
        </form>
        <div className="control-status">
          <span><Signal size={13} /> {friendlySocketStatus(socketStatus)}</span>
          <span><Lock size={12} /> private</span>
          <span>@{nickname}</span>
        </div>
      </section>
    </section>
  );
}

function labelForRole(role: string) {
  if (role === "ai") return "hoshia";
  if (role === "system") return "sys";
  return "guest";
}

function friendlySocketStatus(status: string) {
  if (status === "live") return "connected";
  if (status === "connecting") return "opening room";
  if (status === "reconnecting") return "reconnecting";
  if (status === "closed") return "reconnecting";
  if (status === "error") return "connection paused";
  if (status === "demo") return "preview";
  return "private";
}

function connectionNotice(status: string) {
  if (status === "connecting") return "Opening the private room...";
  if (status === "reconnecting" || status === "closed") return "Connection dropped. Trying to bring you back...";
  if (status === "error") return "Connection paused. Keeping the room state visible.";
  return "";
}

function friendlyError(error: unknown) {
  if (error === "rate_limited") return "Messages are moving too fast. Please wait a moment.";
  if (error === "message_invalid") return "That message could not be sent. Try a shorter one.";
  return "Room signal had a small issue. Trying to recover.";
}

function sessionCue(state: CharacterState, fallback: string) {
  if (state === "IDLE") return "Waiting for your message";
  if (state === "LISTENING") return "Reading your message";
  if (state === "THINKING") return "Hoshia is thinking";
  if (state === "SPEAKING") return "Hoshia is replying";
  if (state === "ERROR") return "Recovering session";
  return fallback;
}

const seedMessages: LiveMessage[] = [
  line("ai", "hoshia", "Hi, I am Hoshia. The 2.0 stage is warming up."),
  line("user", "miruko2", "The room is friends-only, right?"),
  line("ai", "hoshia", "Yes. I will keep the stage bright, private, and cozy."),
  line("user", "miruko2", "Try the listening state."),
  line("ai", "hoshia", "Ears forward. I am listening.")
];

function line(role: "user" | "ai" | "system", nickname: string, text: string): LiveMessage {
  return localLine(role, nickname, text);
}

function localLine(role: "user" | "ai" | "system", nickname: string, text: string): LiveMessage {
  return {
    type: role === "ai" ? "ai_reply" : "danmaku",
    id: `${role}-${nickname}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    nickname,
    text,
    timestamp: new Date().toISOString()
  };
}

function demoReply(text: string) {
  if (/断线|错误|error/i.test(text)) return "我看到连接提示了，会先稳住房间状态再继续陪你。";
  if (/你好|hi|hello/i.test(text)) return "我在这里，房间还是只对你和朋友开放。";
  return `收到啦：${text.slice(0, 36)}。我会保持这个阳光一点的直播节奏。`;
}

createRoot(document.getElementById("root")!).render(<App />);
