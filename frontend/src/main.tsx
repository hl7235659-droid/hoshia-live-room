import { Fragment, type CSSProperties, FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Camera, CheckCircle2, ChevronDown, ChevronLeft, ChevronUp, Clock, Heart, Image, KeyRound, Lock, LockKeyhole, LogIn, Menu, MessageCircle, Music, Palette, Pause, Play, Save, Send, Settings, ShieldCheck, Signal, SkipForward, Sparkles, Trash2, UserCircle, UserPlus, Users, Volume2, X } from "lucide-react";
import { CharacterStage, getAnimatedStageLabel } from "./CharacterStage";
import { colorForMessage } from "./messageColors";
import type { AiProfile, AudiencePayload, AudienceUser, CharacterState, HoshiaPost, HoshiaVisualState, LiveMessage, MusicState, MusicTrack, RoomInfo, Session } from "./types";
import { toCharacterState } from "./types";
import "./styles.css";

const appBase = import.meta.env.BASE_URL || "/";
const loginMascotUrl = appPath("assets/hoshia-login-chibi.png");
const timelineAvatarUrl = appPath("assets/hoshia-timeline-avatar-new.jpg");
const timelineBgUrl = appPath("assets/hoshia-timeline-bg.jpg");
const awakeningBgUrl = appPath("assets/hoshia-awakening-bg.jpg");
const awakeningCharacterUrl = appPath("assets/hoshia-awakening-character.png");
const awakeningSoloBgUrl = appPath("assets/hoshia-awakening-solo-bg.jpg");
const awakeningFinalBgUrl = appPath("assets/hoshia-awakening-final-bg.jpg");
const introStorageKey = "hoshia:lastRegisteredUsername";
const demoParams = new URLSearchParams(window.location.search);
const isStageDemo = import.meta.env.DEV && demoParams.get("demo") === "stage";
const isAwakeningDemo = isStageDemo && demoParams.get("intro") === "awake";
const demoSession: Session = { user_id: "demo", username: "designer", nickname: "designer", avatar_url: "", danmaku_color: "#FF5F9B", room_id: "live-room-dev" };
const demoRoom: RoomInfo = { room_id: "live-room-dev", online: 2, registered: 4, private: true, websocket_auth: true };
const demoAudience: AudiencePayload = {
  ok: true,
  online_count: 2,
  registered_count: 4,
  users: [
    { user_id: "demo", username: "designer", nickname: "designer", avatar_url: "", danmaku_color: "#FF5F9B", online: true, registered_at: "2026-06-07T00:00:00.000Z", last_login_at: "2026-06-07T12:00:00.000Z", total_online_seconds: 4280, current_online_seconds: 320 },
    { user_id: "friend-a", username: "mika", nickname: "Mika", avatar_url: "", danmaku_color: "#2B9CFF", online: true, registered_at: "2026-06-07T02:10:00.000Z", last_login_at: "2026-06-07T12:12:00.000Z", total_online_seconds: 1930, current_online_seconds: 180 },
    { user_id: "friend-b", username: "blue", nickname: "Blue", avatar_url: "", danmaku_color: "#19A989", online: false, registered_at: "2026-06-06T10:20:00.000Z", last_login_at: "2026-06-07T09:00:00.000Z", total_online_seconds: 8640, current_online_seconds: 0 },
    { user_id: "friend-c", username: "ruru", nickname: "Ruru", avatar_url: "", danmaku_color: "#8B5CF6", online: false, registered_at: "2026-06-05T08:00:00.000Z", last_login_at: null, total_online_seconds: 0, current_online_seconds: 0 }
  ]
};
const demoMusicState: MusicState = {
  ok: true,
  enabled: true,
  provider: "xiaomusic",
  status: "playing",
  current: {
    id: "demo-track",
    title: "StellaNet Night Drive",
    artist: "Hoshia",
    duration: 188,
    source: "demo",
    requested_by: "Mika",
    stream_url: ""
  },
  queue: [
    { id: "demo-track-2", title: "Pixel Cat Parade", artist: "Blue", duration: 164, source: "demo", requested_by: "Blue", stream_url: "" }
  ],
  last_error: "",
  can_control: true
};
const demoHoshiaState: HoshiaVisualState = {
  character_id: "hoshia",
  mood: "calm",
  activity: "idle",
  energy: 72,
  social_need: 48,
  current_png: "assets/hoshia-character-cutout.png",
  state_reason: "demo idle stage state",
  updated_at: new Date().toISOString()
};
const demoHoshiaPosts: HoshiaPost[] = [
  {
    id: "demo-post-1",
    character_id: "hoshia",
    content: "刚刚排位被队友气到啦……我真的只是想安静赢一把，怎么这么难。",
    image_url: "assets/hoshia/stage-png/gaming_annoyed_02.png",
    mood: "annoyed",
    activity: "gaming",
    source_type: "demo",
    created_at: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
    like_count: 7,
    comment_count: 2,
    liked_by_viewer: false,
    interactions: [
      {
        id: "demo-comment-1",
        post_id: "demo-post-1",
        user_id: "demo",
        nickname: "designer",
        type: "comment",
        content: "菜就多练。",
        parent_interaction_id: "",
        created_at: new Date(Date.now() - 1000 * 60 * 18).toISOString()
      },
      {
        id: "demo-reply-1",
        post_id: "demo-post-1",
        user_id: "ai-host",
        nickname: "Hoshia",
        type: "reply",
        content: "这句话我记住了，下次赢了第一个截图给你看。",
        parent_interaction_id: "demo-comment-1",
        created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString()
      }
    ]
  },
  {
    id: "demo-post-2",
    character_id: "hoshia",
    content: "今天训练完有点累，不过坐下来整理星港的时候，突然觉得安静也挺好。",
    image_url: "assets/hoshia/stage-png/sports_tired_02.png",
    mood: "tired",
    activity: "sports",
    source_type: "demo",
    created_at: new Date(Date.now() - 1000 * 60 * 92).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 92).toISOString(),
    like_count: 4,
    comment_count: 0,
    liked_by_viewer: true,
    interactions: []
  }
];

function appPath(path: string) {
  const base = appBase.endsWith("/") ? appBase : `${appBase}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

async function fetchHoshiaPosts() {
  const payload = await fetch(appPath("api/hoshia/posts")).then((res) => (res.ok ? res.json() : null));
  return Array.isArray(payload?.posts) ? payload.posts as HoshiaPost[] : [];
}

function wsPath(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${appPath(path)}`;
}

function normalizeAuthName(value: string | undefined) {
  return String(value || "").trim().toLowerCase();
}

function rememberRegisteredUsername(username: string) {
  try {
    window.sessionStorage.setItem(introStorageKey, normalizeAuthName(username));
  } catch {
    // Session storage is only a UI hint. Login remains functional without it.
  }
}

function shouldPlayAwakeningForUser(user: Session) {
  try {
    const remembered = window.sessionStorage.getItem(introStorageKey);
    const username = normalizeAuthName(user.username || user.nickname);
    if (!remembered || remembered !== username) return false;
    window.sessionStorage.removeItem(introStorageKey);
    return true;
  } catch {
    return false;
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(() => (isStageDemo ? demoSession : null));
  const [room, setRoom] = useState<RoomInfo | null>(() => (isStageDemo ? demoRoom : null));
  const [audience, setAudience] = useState<AudiencePayload | null>(() => (isStageDemo ? demoAudience : null));
  const [gatePassed, setGatePassed] = useState(isStageDemo);
  const [authChecked, setAuthChecked] = useState(isStageDemo);
  const [messages, setMessages] = useState<LiveMessage[]>(seedMessages);
  const [musicState, setMusicState] = useState<MusicState>(demoMusicState);
  const [characterState, setCharacterState] = useState<CharacterState>("IDLE");
  const [hoshiaState, setHoshiaState] = useState<HoshiaVisualState | null>(() => (isStageDemo ? demoHoshiaState : null));
  const [socketStatus, setSocketStatus] = useState(isStageDemo ? "demo" : "locked");
  const [awakeningIntroOpen, setAwakeningIntroOpen] = useState(isAwakeningDemo);

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
          setAwakeningIntroOpen(payload.user.onboarding_completed === false);
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

    function refreshMusicState() {
      return fetch(appPath("api/music/state"))
        .then((res) => (res.ok ? res.json() : null))
        .then((payload) => {
          if (payload?.ok) setMusicState(payload);
        })
        .catch(() => undefined);
    }

    function refreshRoomState() {
      return fetch(appPath("api/room/state"))
        .then((res) => res.json())
        .then((payload) => {
          setRoom(payload.room);
          setCharacterState(toCharacterState(payload.state));
          if (payload.hoshia_state) setHoshiaState(payload.hoshia_state);
          if (payload.messages?.length) setMessages(payload.messages);
        })
        .catch(() => undefined);
    }

    function refreshHoshiaState() {
      return fetch(appPath("api/hoshia/state"))
        .then((res) => (res.ok ? res.json() : null))
        .then((payload) => {
          if (payload?.state) setHoshiaState(payload.state);
        })
        .catch(() => undefined);
    }

    void refreshRoomState();
    void refreshAudience();
    void refreshMusicState();
    void refreshHoshiaState();

    let ws: WebSocket | null = null;
    let disposed = false;
    let retryTimer: number | undefined;
    let retryCount = 0;

    function scheduleReconnect() {
      if (disposed || retryTimer) return;
      const backoff = Math.min(10000, 1000 * Math.pow(1.6, retryCount));
      const jitter = Math.floor(Math.random() * 450);
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        retryCount += 1;
        connectSocket();
      }, backoff + jitter);
    }

    function reconnectIfNeeded() {
      if (disposed) return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (retryTimer) {
          window.clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        connectSocket();
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") reconnectIfNeeded();
    }

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
        if (payload.hoshia_state) setHoshiaState(payload.hoshia_state);
        if (payload.messages?.length) setMessages(payload.messages);
      }
      if (payload.type === "music_state") {
        setMusicState(payload);
      }
      if (payload.type === "music_error") {
        setMusicState((current) => ({ ...current, status: "error", last_error: payload.error }));
      }
      if (payload.type === "character_state") {
        setCharacterState(toCharacterState(payload.state));
      }
      if (payload.type === "hoshia_state" && payload.state) {
        setHoshiaState(payload.state);
      }
      if (payload.type === "hoshia_posts_changed") {
        void refreshHoshiaPosts();
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
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
      setSocketStatus(retryCount ? "reconnecting" : "connecting");
      ws = new WebSocket(wsPath("ws/live"));
      const currentSocket = ws;
      (window as Window & { liveRoomSocket?: WebSocket }).liveRoomSocket = ws;

      ws.addEventListener("open", () => {
        retryCount = 0;
        setSocketStatus("live");
        void refreshRoomState();
        void refreshAudience();
        void refreshMusicState();
        void refreshHoshiaState();
      });
      ws.addEventListener("close", () => {
        if (disposed) return;
        if ((window as Window & { liveRoomSocket?: WebSocket }).liveRoomSocket === currentSocket) {
          delete (window as Window & { liveRoomSocket?: WebSocket }).liveRoomSocket;
        }
        setSocketStatus("closed");
        scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        if (disposed) return;
        setSocketStatus("error");
        scheduleReconnect();
      });
      ws.addEventListener("message", handleSocketMessage);
    }

    connectSocket();
    window.addEventListener("online", reconnectIfNeeded);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.removeEventListener("online", reconnectIfNeeded);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
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
    return <LoginView onLogin={(user, nextRoom, playAwakeningIntro) => {
      setSession(user);
      setRoom(nextRoom);
      setAwakeningIntroOpen(playAwakeningIntro || user.onboarding_completed === false);
    }} />;
  }

  return (
    <LiveMobile
      session={session}
      room={room}
      messages={messages}
      characterState={characterState}
      hoshiaState={hoshiaState}
      musicState={musicState}
      onMusicState={setMusicState}
      socketStatus={socketStatus}
      isDemo={isStageDemo}
      onLocalSendStart={() => {
        setCharacterState("LISTENING");
        window.setTimeout(() => setCharacterState((current) => (current === "LISTENING" ? "THINKING" : current)), 420);
      }}
      onDemoSend={isStageDemo ? (text) => {
        setMessages((current) => [...current.slice(-40), localLine("user", session.nickname, text, { color: session.danmaku_color || undefined })]);
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
      awakeningIntroOpen={awakeningIntroOpen}
      onAwakeningIntroDone={() => setAwakeningIntroOpen(false)}
      onLeave={() => {
        setSession(null);
        setRoom(null);
        setAudience(null);
        setSocketStatus("locked");
        setCharacterState("IDLE");
        setHoshiaState(null);
        setAwakeningIntroOpen(false);
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

function LoginView({ onLogin }: { onLogin: (user: Session, room: RoomInfo, playAwakeningIntro: boolean) => void }) {
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
      rememberRegisteredUsername(username);
      setAuthMode("login");
      setPassword("");
      setRegistrationCode("");
      setNotice("Account created. Enter your password and click login.");
      return;
    }

    const payload = await response.json();
    const me = await fetch(appPath("api/auth/me")).then((res) => res.json());
    onLogin(payload.user, me.room, shouldPlayAwakeningForUser(payload.user));
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
  if (error === "danmaku_color_invalid") return "Danmaku color must be a valid #RRGGBB value.";
  if (error === "current_password_invalid") return "Current password is not correct.";
  if (error === "password_invalid") return "Password needs at least 8 characters.";
  if (error === "unauthorized") return "Session expired. Log in again.";
  return "Could not save account settings.";
}

function avatarInitials(nickname: string) {
  return nickname.trim().slice(0, 2).toUpperCase() || "ME";
}

function normalizeColorInput(color: string | undefined) {
  const value = String(color || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : "";
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
  hoshiaState,
  musicState,
  onMusicState,
  socketStatus,
  audience,
  isDemo,
  onLocalSendStart,
  onDemoSend,
  onSessionUpdate,
  awakeningIntroOpen,
  onAwakeningIntroDone,
  onLeave
}: {
  session: Session;
  room: RoomInfo | null;
  messages: LiveMessage[];
  characterState: CharacterState;
  hoshiaState: HoshiaVisualState | null;
  musicState: MusicState;
  onMusicState: (state: MusicState) => void;
  socketStatus: string;
  audience: AudiencePayload | null;
  isDemo: boolean;
  onLocalSendStart: () => void;
  onDemoSend?: (text: string) => void;
  onSessionUpdate: (user: Session) => void;
  awakeningIntroOpen: boolean;
  onAwakeningIntroDone: () => void;
  onLeave: () => void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [hoshiaPosts, setHoshiaPosts] = useState<HoshiaPost[]>(() => (isDemo ? demoHoshiaPosts : []));

  useEffect(() => {
    if (!timelineOpen || isDemo) return;
    let disposed = false;
    fetchHoshiaPosts()
      .then((posts) => {
        if (!disposed) setHoshiaPosts(posts);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [timelineOpen, isDemo]);

  async function refreshPosts() {
    if (isDemo) return;
    const posts = await fetchHoshiaPosts();
    setHoshiaPosts(posts);
  }

  async function handleLikePost(postId: string) {
    if (isDemo) {
      setHoshiaPosts((current) => current.map((post) => post.id === postId ? {
        ...post,
        liked_by_viewer: true,
        like_count: post.liked_by_viewer ? post.like_count : post.like_count + 1
      } : post));
      return;
    }
    const payload = await fetch(appPath(`api/hoshia/posts/${postId}/like`), { method: "POST" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("like_failed"))));
    if (payload?.post) {
      setHoshiaPosts((current) => current.map((post) => post.id === postId ? payload.post : post));
    } else {
      await refreshPosts();
    }
  }

  async function handleCommentPost(postId: string, content: string) {
    if (isDemo) {
      const interaction = {
        id: `demo-comment-${Date.now()}`,
        post_id: postId,
        user_id: session.user_id,
        nickname: session.nickname,
        type: "comment" as const,
        content,
        parent_interaction_id: "",
        created_at: new Date().toISOString()
      };
      setHoshiaPosts((current) => current.map((post) => post.id === postId ? {
        ...post,
        comment_count: post.comment_count + 1,
        interactions: [...post.interactions, interaction]
      } : post));
      return;
    }
    const payload = await fetch(appPath(`api/hoshia/posts/${postId}/comment`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    }).then((res) => (res.ok ? res.json() : Promise.reject(new Error("comment_failed"))));
    if (payload?.post) {
      setHoshiaPosts((current) => current.map((post) => post.id === postId ? payload.post : post));
    } else {
      await refreshPosts();
    }
  }

  return (
    <main className="phone-shell">
      <section className="live-phone">
        <CharacterStage state={characterState} messages={messages} visualState={hoshiaState} />
        <LiveOverlay
          state={characterState}
          session={session}
          room={room}
          socketStatus={socketStatus}
          audience={audience}
          onOpenAccount={() => setAccountOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenTimeline={() => setTimelineOpen(true)}
          onLeave={onLeave}
        />
        <BottomDock
          messages={messages}
          musicState={musicState}
          onMusicState={onMusicState}
          audience={audience}
          socketStatus={socketStatus}
          nickname={session.nickname}
          audioEnabled={audioEnabled}
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
        {settingsOpen ? (
          <RoomSettingsModal
            session={session}
            isDemo={isDemo}
            audioEnabled={audioEnabled}
            onAudioEnabledChange={setAudioEnabled}
            onClose={() => setSettingsOpen(false)}
            onSessionUpdate={onSessionUpdate}
          />
        ) : null}
        {timelineOpen ? (
          <HoshiaTimelineOverlay
            session={session}
            posts={hoshiaPosts}
            visualState={hoshiaState}
            onClose={() => setTimelineOpen(false)}
            onLike={handleLikePost}
            onComment={handleCommentPost}
          />
        ) : null}
        {awakeningIntroOpen ? (
          <HoshiaAwakeningIntro
            session={session}
            isDemo={isDemo}
            onSessionUpdate={onSessionUpdate}
            onDone={onAwakeningIntroDone}
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
  onOpenSettings,
  onOpenTimeline,
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
                <span>Settings</span>
                <strong>sound / color</strong>
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
      <button
        type="button"
        className="timeline-open-link"
        aria-label="Open Hoshia timeline"
        onClick={onOpenTimeline}
        title="Hoshia 的动态"
      >
        <Sparkles size={18} strokeWidth={2.2} />
      </button>
    </section>
  );
}

function HoshiaTimelineOverlay({
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
      aria-label="Hoshia dynamic page"
      style={{ "--timeline-bg": `url("${timelineBgUrl}")` } as CSSProperties}
    >
      <div className="timeline-bg-mark" aria-hidden="true">H</div>
      <header className="timeline-topbar">
        <button type="button" aria-label="Back to live room" onClick={onClose}>
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
              <span className="timeline-live-pill"><Sparkles size={14} /> live</span>
            </div>
            <p>今天也在星港里整理状态、动态和一点点嘴硬。</p>
          </div>
        </section>

        <section className="timeline-stats-card" aria-label="Hoshia current status">
          <TimelineMetric label="活动" value={activityLabel(visualState?.activity || "idle")} />
          <TimelineMetric label="心情" value={moodLabel(visualState?.mood || "calm")} />
          <TimelineMetric label="能量" value={`${energy}%`} />
          <TimelineMetric label="陪伴感" value={`${100 - socialNeed}%`} />
        </section>

        <section className="timeline-feed" aria-label="Hoshia posts">
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
                        <strong>{interaction.nickname || (interaction.user_id === session.user_id ? session.nickname : "viewer")}</strong>
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

type AwakeningIntroPhase =
  | "opening"
  | "focusedWait"
  | "chibiTransition"
  | "chibiEnter"
  | "catLine1"
  | "catLine2"
  | "innerTransition"
  | "innerQuestion"
  | "introReturn"
  | "innerStartled"
  | "askName"
  | "innerMustAnswerName"
  | "chooseName"
  | "confirmName"
  | "askStyle"
  | "chooseStyle"
  | "confirmStyle"
  | "askInterests"
  | "chooseInterests"
  | "interestsFeedback"
  | "askMemory"
  | "chooseMemory"
  | "finalSaving"
  | "finalSaved"
  | "finalUnsaved"
  | "finalError"
  | "finalBlackReady"
  | "finalEyeOpening"
  | "finalFollowLine"
  | "finalWhiteBloom"
  | "finalWhiteReady";

type ReplyStyle = AiProfile["reply_style"];

type AwakeningAnswers = {
  preferredName: string;
  replyStyle: ReplyStyle;
  replyStyleText: string;
  interests: string;
  memoryEnabled: boolean | null;
};

type CustomChoiceKind = "name" | "style" | "interests" | null;

const initialAwakeningAnswers: AwakeningAnswers = {
  preferredName: "",
  replyStyle: "friend",
  replyStyleText: "像朋友一样",
  interests: "",
  memoryEnabled: null
};

function HoshiaAwakeningIntro({
  session,
  isDemo,
  onSessionUpdate,
  onDone
}: {
  session: Session;
  isDemo: boolean;
  onSessionUpdate: (user: Session) => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<AwakeningIntroPhase>("opening");
  const [typedText, setTypedText] = useState("");
  const [typingComplete, setTypingComplete] = useState(true);
  const [answers, setAnswers] = useState<AwakeningAnswers>(() => ({
    ...initialAwakeningAnswers,
    preferredName: session.nickname || session.username || "你"
  }));
  const [customKind, setCustomKind] = useState<CustomChoiceKind>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [saveError, setSaveError] = useState("");
  const typingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "opening") return;
    const timer = window.setTimeout(() => setPhase("focusedWait"), 7200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "chibiTransition") return;
    const timer = window.setTimeout(() => setPhase("chibiEnter"), 560);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "innerTransition") return;
    const timer = window.setTimeout(() => setPhase("innerQuestion"), 620);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "finalEyeOpening") return;
    const timer = window.setTimeout(() => setPhase("finalFollowLine"), 7200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "finalWhiteBloom") return;
    const timer = window.setTimeout(() => setPhase("finalWhiteReady"), 1450);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const dialogueText = awakeningDialogueText(phase, answers, saveError);
  const innerThought = awakeningInnerThought(phase);
  const choicePhase = isAwakeningChoicePhase(phase);
  const finalCenterText = phase === "finalBlackReady" ? "星港连接稳定……都准备就绪了喵。" : "";
  const isFinalImagePhase = phase === "finalEyeOpening" || phase === "finalFollowLine" || phase === "finalWhiteBloom" || phase === "finalWhiteReady";
  const isFinalBloomPhase = phase === "finalWhiteBloom" || phase === "finalWhiteReady";
  const showInnerContent = Boolean(innerThought) || choicePhase;
  const showChibi = isAwakeningCharacterPhase(phase);
  const showParticles = phase !== "opening" && phase !== "finalBlackReady" && !isFinalBloomPhase;
  const canAdvanceDialogue = nextAwakeningPhase(phase) !== phase;

  useEffect(() => {
    if (typingTimerRef.current) {
      window.clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    if (!dialogueText) {
      setTypedText("");
      setTypingComplete(true);
      return;
    }

    setTypedText("");
    setTypingComplete(false);
    let index = 0;
    const characters = Array.from(dialogueText);
    typingTimerRef.current = window.setInterval(() => {
      index += 1;
      setTypedText(characters.slice(0, index).join(""));
      if (index >= characters.length) {
        if (typingTimerRef.current) {
          window.clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        setTypingComplete(true);
      }
    }, 42);

    return () => {
      if (typingTimerRef.current) {
        window.clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
  }, [dialogueText]);

  function advanceIntro() {
    if (choicePhase || customKind || phase === "finalSaving") return;
    if (phase === "finalWhiteBloom") return;
    if (phase === "finalWhiteReady") {
      onDone();
      return;
    }
    if (dialogueText && !typingComplete) {
      if (typingTimerRef.current) {
        window.clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      setTypedText(dialogueText);
      setTypingComplete(true);
      return;
    }

    setPhase((current) => nextAwakeningPhase(current));
  }

  function chooseName(name: string) {
    setAnswers((current) => ({ ...current, preferredName: name.trim() || session.nickname || "你" }));
    setCustomKind(null);
    setCustomDraft("");
    setPhase("confirmName");
  }

  function chooseStyle(replyStyle: ReplyStyle, replyStyleText: string) {
    setAnswers((current) => ({ ...current, replyStyle, replyStyleText }));
    setCustomKind(null);
    setCustomDraft("");
    setPhase("confirmStyle");
  }

  function chooseInterests(interests: string) {
    setAnswers((current) => ({ ...current, interests }));
    setCustomKind(null);
    setCustomDraft("");
    setPhase("interestsFeedback");
  }

  async function chooseMemory(memoryEnabled: boolean) {
    const nextAnswers = { ...answers, memoryEnabled };
    setAnswers(nextAnswers);
    setCustomKind(null);
    setCustomDraft("");
    setSaveError("");
    setPhase("finalSaving");

    try {
      const nextUser = await saveAwakeningProfile(nextAnswers, session, isDemo);
      onSessionUpdate(nextUser);
      setPhase(memoryEnabled ? "finalSaved" : "finalUnsaved");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "save_failed");
      setPhase("finalError");
    }
  }

  function openCustom(kind: Exclude<CustomChoiceKind, null>) {
    setCustomKind(kind);
    setCustomDraft("");
  }

  function submitCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const value = customDraft.trim();
    if (!value || !customKind) return;
    if (customKind === "name") chooseName(value.slice(0, 24));
    if (customKind === "style") chooseStyle("custom", value.slice(0, 48));
    if (customKind === "interests") chooseInterests(value.slice(0, 80));
  }

  function stopChoiceClick(event: MouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  return (
    <section
      className={`awakening-intro phase-${phase}${showChibi ? " is-character-phase" : ""}${showInnerContent ? " is-inner-phase" : ""}${isFinalImagePhase ? " is-final-image-phase" : ""}${isFinalBloomPhase ? " is-final-bloom-phase" : ""}`}
      style={{
        "--awakening-bg": `url(${awakeningBgUrl})`,
        "--awakening-solo-bg": `url(${awakeningSoloBgUrl})`,
        "--awakening-final-bg": `url(${awakeningFinalBgUrl})`
      } as CSSProperties}
      aria-label="Hoshia awakening intro"
      onClick={advanceIntro}
    >
      <div className="awakening-bg" aria-hidden="true" />
      <div className="awakening-vignette" aria-hidden="true" />
      {showParticles ? (
        <div className="awakening-particles" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <div className="awakening-call" aria-hidden="true">
        <span className="awakening-rule" />
        <strong>信号接收成功……Hoshia 终于找到你了。</strong>
        <span className="awakening-rule" />
      </div>
      <p className="awakening-thought">是……谁在呼唤我？</p>
      <div className="eyelid eyelid-top" aria-hidden="true" />
      <div className="eyelid eyelid-bottom" aria-hidden="true" />
      {phase === "focusedWait" ? <span className="awakening-touch-cue">轻触继续</span> : null}
      {finalCenterText ? (
        <div className="awakening-final-center" aria-live="polite">{finalCenterText}</div>
      ) : null}
      {showChibi ? (
        <div className="awakening-chibi-stage" aria-hidden="true">
          <span className="chibi-aura" />
          <img src={awakeningCharacterUrl} alt="" draggable={false} />
        </div>
      ) : null}
      {dialogueText || showInnerContent ? (
        <section className="awakening-galgame-box" aria-live="polite">
          {dialogueText ? (
            <>
              <p key={phase} className={typingComplete ? "typing-complete" : "typing-active"}>{typedText}</p>
              {canAdvanceDialogue ? <span className="cat-continue-cue" aria-hidden="true">✦</span> : null}
            </>
          ) : null}
          {!dialogueText && showInnerContent ? (
            <span className="awakening-empty-cursor" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
          <span className="cat-paw paw-one" aria-hidden="true" />
          <span className="cat-paw paw-two" aria-hidden="true" />
          <span className="cat-tail" aria-hidden="true" />
        </section>
      ) : null}
      {innerThought ? (
        <div className="awakening-inner-question" aria-live="polite">
          <span className="awakening-rule" />
          <strong>{innerThought}</strong>
          <span className="awakening-rule" />
        </div>
      ) : null}
      {choicePhase ? (
        <div className="awakening-inner-question awakening-choice-panel" aria-live="polite" onClick={stopChoiceClick}>
          <AwakeningChoiceBranches
            phase={phase}
            session={session}
            customKind={customKind}
            customDraft={customDraft}
            onCustomDraftChange={setCustomDraft}
            onCustomSubmit={submitCustom}
            onChooseName={chooseName}
            onChooseStyle={chooseStyle}
            onChooseInterests={chooseInterests}
            onChooseMemory={(enabled) => void chooseMemory(enabled)}
            onOpenCustom={openCustom}
          />
        </div>
      ) : null}
      {isFinalBloomPhase ? <div className="awakening-white-bloom" aria-hidden="true" /> : null}
    </section>
  );
}

function AwakeningChoiceBranches({
  phase,
  session,
  customKind,
  customDraft,
  onCustomDraftChange,
  onCustomSubmit,
  onChooseName,
  onChooseStyle,
  onChooseInterests,
  onChooseMemory,
  onOpenCustom
}: {
  phase: AwakeningIntroPhase;
  session: Session;
  customKind: CustomChoiceKind;
  customDraft: string;
  onCustomDraftChange: (value: string) => void;
  onCustomSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChooseName: (name: string) => void;
  onChooseStyle: (style: ReplyStyle, text: string) => void;
  onChooseInterests: (interests: string) => void;
  onChooseMemory: (enabled: boolean) => void;
  onOpenCustom: (kind: Exclude<CustomChoiceKind, null>) => void;
}) {
  if (phase === "chooseName") {
    return (
      <>
        <div className="awakening-choice-branches">
          <button type="button" onClick={() => onChooseName(session.nickname || session.username || "你")}>直接叫我名字</button>
          <button type="button" onClick={() => onChooseName("主人")}>主人</button>
          <button type="button" onClick={() => onChooseName("前辈")}>前辈</button>
          <button type="button" onClick={() => onOpenCustom("name")}>我自己说</button>
        </div>
        {customKind === "name" ? (
          <AwakeningCustomChoiceForm
            value={customDraft}
            placeholder="告诉猫猫一个称呼..."
            submitLabel="这样叫我"
            maxLength={24}
            onChange={onCustomDraftChange}
            onSubmit={onCustomSubmit}
          />
        ) : null}
      </>
    );
  }

  if (phase === "chooseStyle") {
    return (
      <>
        <div className="awakening-choice-branches">
          <button type="button" onClick={() => onChooseStyle("friend", "像朋友一样")}>像朋友一样</button>
          <button type="button" onClick={() => onChooseStyle("teasing_friend", "像损友一样")}>像损友一样</button>
          <button type="button" onClick={() => onChooseStyle("cool", "高冷一点")}>高冷一点</button>
          <button type="button" onClick={() => onOpenCustom("style")}>我自己说</button>
        </div>
        {customKind === "style" ? (
          <AwakeningCustomChoiceForm
            value={customDraft}
            placeholder="写下你想要的回应风格..."
            submitLabel="就是这样"
            maxLength={48}
            onChange={onCustomDraftChange}
            onSubmit={onCustomSubmit}
          />
        ) : null}
      </>
    );
  }

  if (phase === "chooseInterests") {
    return (
      <>
        <div className="awakening-choice-branches compact">
          <button type="button" onClick={() => onOpenCustom("interests")}>写给猫猫听</button>
          <button type="button" onClick={() => onChooseInterests("")}>你猜</button>
        </div>
        {customKind === "interests" ? (
          <AwakeningCustomChoiceForm
            value={customDraft}
            placeholder="比如游戏、音乐、动画、日常..."
            submitLabel="告诉猫猫"
            maxLength={80}
            onChange={onCustomDraftChange}
            onSubmit={onCustomSubmit}
          />
        ) : null}
      </>
    );
  }

  if (phase === "chooseMemory") {
    return (
      <div className="awakening-choice-branches compact">
        <button type="button" onClick={() => onChooseMemory(true)}>是</button>
        <button type="button" onClick={() => onChooseMemory(false)}>否</button>
      </div>
    );
  }

  return null;
}

function AwakeningCustomChoiceForm({
  value,
  placeholder,
  submitLabel,
  maxLength,
  onChange,
  onSubmit
}: {
  value: string;
  placeholder: string;
  submitLabel: string;
  maxLength: number;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="awakening-custom-choice" onSubmit={onSubmit}>
      <input
        value={value}
        maxLength={maxLength}
        autoFocus
        placeholder={placeholder}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="submit" disabled={!value.trim()}>{submitLabel}</button>
    </form>
  );
}

function awakeningDialogueText(phase: AwakeningIntroPhase, answers: AwakeningAnswers, saveError: string) {
  if (phase === "catLine1") return "欢迎停靠，星港旅人。Hoshia 一直在这里等你哦。";
  if (phase === "catLine2") return "刚才星网里传来了很温柔的讯号。它说……今天会有一位很重要的小星爪来到这里。";
  if (phase === "introReturn") return "是你哦。在真正进入星娅星港以前，Hoshia 想悄悄记住一点关于你的事。不是冷冰冰的资料……是为了以后你呼唤我的时候，我能更认真地陪着你。";
  if (phase === "askName") return "首先，可以告诉 Hoshia……该怎么称呼你吗？名字是很重要的坐标，猫猫会好好记住的。";
  if (phase === "confirmName") return `嗯，记住啦。从现在开始，Hoshia 就这样呼唤你：${answers.preferredName || "你"}。`;
  if (phase === "askStyle") return "那么，当你在星港呼唤我的时候……希望 Hoshia 用什么样的感觉回应你呢？";
  if (phase === "confirmStyle") return `原来如此……${answers.preferredName || "你"}喜欢“${answers.replyStyleText || "像朋友一样"}”这样的陪伴方式呀。Hoshia 会试着调整自己的频道。`;
  if (phase === "askInterests") return "不要着急哦，星港连接马上就稳定啦。Hoshia 还想知道……你平时会被什么东西点亮呢？";
  if (phase === "interestsFeedback") return answers.interests
    ? `嗯嗯，收到。“${answers.interests}”……这就是会让你发光的东西之一，对吧？Hoshia 把它放进星港的小小记忆灯里了。`
    : "嘿嘿，要让猫猫自己发现吗？那也很好。Hoshia 会在以后的聊天里，慢慢靠近你的星光。";
  if (phase === "askMemory") return "最后一个问题啦。Hoshia 可以把这些小小的连接记录保存下来吗？这样以后你 @ 我的时候，我就能更快认出属于你的星光。";
  if (phase === "finalSaving") return "Hoshia 正在把这份约定轻轻收好……星港核心同步中。";
  if (phase === "finalSaved") return "好哦。Hoshia 会把这份约定收进星港核心里。以后你呼唤我的时候，猫猫会更快找到你。";
  if (phase === "finalUnsaved") return "嗯嗯，没关系。不保存也没关系，Hoshia 还是会认真听你说话。陪伴不是因为记录才成立的。";
  if (phase === "finalError") return saveError ? "呜...刚才没能保存成功。猫猫先停在这里，等你再看看。" : "呜...刚才没能保存成功。";
  if (phase === "finalFollowLine") return "那么……牵好 Hoshia 的手。现在，就跟我一起进入星港吧。";
  return "";
}

function awakeningInnerThought(phase: AwakeningIntroPhase) {
  if (phase === "innerQuestion") return "那个人……是我吗？";
  if (phase === "innerStartled") return "欸……要记住我吗？";
  if (phase === "innerMustAnswerName") return "如果这是属于我的坐标……那我应该作出回答——";
  return "";
}

function isAwakeningChoicePhase(phase: AwakeningIntroPhase) {
  return phase === "chooseName" || phase === "chooseStyle" || phase === "chooseInterests" || phase === "chooseMemory";
}

function isAwakeningCharacterPhase(phase: AwakeningIntroPhase) {
  return phase === "chibiEnter" ||
    phase === "catLine1" ||
    phase === "catLine2" ||
    phase === "innerTransition" ||
    phase === "introReturn" ||
    phase === "askName" ||
    phase === "confirmName" ||
    phase === "askStyle" ||
    phase === "confirmStyle" ||
    phase === "askInterests" ||
    phase === "interestsFeedback" ||
    phase === "askMemory" ||
    phase === "finalSaving" ||
    phase === "finalSaved" ||
    phase === "finalUnsaved" ||
    phase === "finalError";
}

function nextAwakeningPhase(phase: AwakeningIntroPhase): AwakeningIntroPhase {
  if (phase === "opening") return "focusedWait";
  if (phase === "focusedWait") return "chibiTransition";
  if (phase === "chibiTransition" || phase === "innerTransition") return phase;
  if (phase === "chibiEnter") return "catLine1";
  if (phase === "catLine1") return "catLine2";
  if (phase === "catLine2") return "innerTransition";
  if (phase === "innerQuestion") return "introReturn";
  if (phase === "introReturn") return "innerStartled";
  if (phase === "innerStartled") return "askName";
  if (phase === "askName") return "innerMustAnswerName";
  if (phase === "innerMustAnswerName") return "chooseName";
  if (phase === "confirmName") return "askStyle";
  if (phase === "askStyle") return "chooseStyle";
  if (phase === "confirmStyle") return "askInterests";
  if (phase === "askInterests") return "chooseInterests";
  if (phase === "interestsFeedback") return "askMemory";
  if (phase === "askMemory") return "chooseMemory";
  if (phase === "finalSaved" || phase === "finalUnsaved") return "finalBlackReady";
  if (phase === "finalBlackReady") return "finalEyeOpening";
  if (phase === "finalEyeOpening") return phase;
  if (phase === "finalFollowLine") return "finalWhiteBloom";
  if (phase === "finalWhiteBloom" || phase === "finalWhiteReady") return phase;
  return phase;
}

async function saveAwakeningProfile(answers: AwakeningAnswers, session: Session, isDemo: boolean): Promise<Session> {
  const profile: AiProfile | null = answers.memoryEnabled ? {
    preferred_name: answers.preferredName || session.nickname || "你",
    reply_style: answers.replyStyle,
    reply_style_text: answers.replyStyleText || "像朋友一样",
    interests: answers.interests || "",
    memory_enabled: true
  } : null;

  if (isDemo) {
    return {
      ...session,
      onboarding_completed: true,
      ai_profile: profile
    };
  }

  const response = await fetch(appPath("api/account/onboarding"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile ? {
      preferred_name: profile.preferred_name,
      reply_style: profile.reply_style,
      reply_style_text: profile.reply_style_text,
      interests: profile.interests,
      memory_enabled: true
    } : {
      memory_enabled: false
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.user) {
    throw new Error(payload?.error || "onboarding_save_failed");
  }
  return payload.user;
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
    const currentDanmakuColor = normalizeColorInput(session.danmaku_color) || "#FF5F9B";

    if (nextNickname.length < 2) {
      setProfileNotice({ type: "error", text: "Display name needs at least 2 characters." });
      return;
    }

    if (isDemo) {
      onSessionUpdate({ ...session, nickname: nextNickname, avatar_url: nextAvatarUrl, danmaku_color: currentDanmakuColor });
      setProfileNotice({ type: "success", text: "Demo profile updated in this preview." });
      return;
    }

    setProfileBusy(true);
    const response = await fetch(appPath("api/account/profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nextNickname, avatarUrl: nextAvatarUrl, danmakuColor: currentDanmakuColor })
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

function RoomSettingsModal({
  session,
  isDemo,
  audioEnabled,
  onAudioEnabledChange,
  onClose,
  onSessionUpdate
}: {
  session: Session;
  isDemo: boolean;
  audioEnabled: boolean;
  onAudioEnabledChange: (enabled: boolean) => void;
  onClose: () => void;
  onSessionUpdate: (user: Session) => void;
}) {
  const [danmakuColor, setDanmakuColor] = useState(normalizeColorInput(session.danmaku_color) || "#FF5F9B");
  const [colorBusy, setColorBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const normalizedColor = normalizeColorInput(danmakuColor);

  async function saveDanmakuColor(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (!normalizedColor) {
      setNotice({ type: "error", text: "Choose a valid #RRGGBB danmaku color." });
      return;
    }

    if (isDemo) {
      onSessionUpdate({ ...session, danmaku_color: normalizedColor });
      setNotice({ type: "success", text: "Demo danmaku color updated." });
      return;
    }

    setColorBusy(true);
    const response = await fetch(appPath("api/account/profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: session.nickname,
        avatarUrl: session.avatar_url || "",
        danmakuColor: normalizedColor
      })
    });
    setColorBusy(false);

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setNotice({ type: "error", text: accountErrorMessage(payload?.error) });
      return;
    }

    onSessionUpdate(payload.user);
    setNotice({ type: "success", text: "Danmaku color saved." });
  }

  return (
    <div className="account-modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="room-settings-title">
        <header className="account-modal-header">
          <div className="account-modal-title">
            <span className="settings-title-icon" aria-hidden="true"><Settings size={20} /></span>
            <div>
              <span>Room settings</span>
              <h3 id="room-settings-title">Sound and danmaku</h3>
            </div>
          </div>
          <button type="button" className="account-close-button" aria-label="Close room settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <section className="settings-card" aria-label="Sound settings">
          <div className="account-section-heading">
            <Volume2 size={17} />
            <div>
              <strong>Music sound</strong>
              <span>Control whether this device plays room music.</span>
            </div>
          </div>
          <button
            type="button"
            className={`settings-toggle ${audioEnabled ? "enabled" : ""}`}
            aria-pressed={audioEnabled}
            onClick={() => onAudioEnabledChange(!audioEnabled)}
          >
            <span>{audioEnabled ? "Sound on" : "Sound off"}</span>
            <i aria-hidden="true" />
          </button>
        </section>

        <form className="settings-card" onSubmit={saveDanmakuColor}>
          <div className="account-section-heading">
            <Palette size={17} />
            <div>
              <strong>Danmaku color</strong>
              <span>Choose the color attached to your own sent messages.</span>
            </div>
          </div>
          <label>
            <span>My danmaku color</span>
            <div className="danmaku-color-control">
              <input
                className="danmaku-color-swatch"
                value={normalizedColor || "#FF5F9B"}
                onChange={(event) => setDanmakuColor(event.target.value)}
                type="color"
                aria-label="Choose my danmaku color"
              />
              <input
                value={danmakuColor}
                onChange={(event) => setDanmakuColor(event.target.value)}
                maxLength={7}
                placeholder="#FF5F9B"
                spellCheck={false}
              />
            </div>
          </label>
          {notice ? <AccountNotice notice={notice} /> : null}
          <button type="submit" className="account-save-button" disabled={colorBusy || !normalizedColor}>
            {colorBusy ? <Signal size={16} /> : <Save size={16} />}
            {colorBusy ? "Saving..." : "Save color"}
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
  musicState,
  onMusicState,
  audience,
  socketStatus,
  nickname,
  audioEnabled,
  onSendStart,
  onDemoSend
}: {
  messages: LiveMessage[];
  musicState: MusicState;
  onMusicState: (state: MusicState) => void;
  audience: AudiencePayload | null;
  socketStatus: string;
  nickname: string;
  audioEnabled: boolean;
  onSendStart: () => void;
  onDemoSend?: (text: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [musicOpen, setMusicOpen] = useState(false);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const historyCount = Math.min(messages.length, 100);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onlineMembers = (audience?.users || []).filter((user) => user.online && user.nickname !== nickname);

  function toggleHistory() {
    setHistoryOpen((current) => {
      const next = !current;
      if (next) setMusicOpen(false);
      return next;
    });
  }

  function toggleMusic() {
    setMusicOpen((current) => {
      const next = !current;
      if (next) setHistoryOpen(false);
      return next;
    });
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
    <section className={`bottom-dock ${historyOpen ? "history-open" : ""} ${musicOpen ? "music-open" : ""}`} aria-label="Live chat dock">
      <section className={`history-drawer ${historyOpen || musicOpen ? "open" : ""} ${musicOpen ? "music-active" : ""}`} aria-label="Message history">
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
            <span>History</span>
          </button>
          <button
            type="button"
            className="music-header-toggle"
            aria-expanded={musicOpen}
            onClick={toggleMusic}
          >
            <Music size={15} />
            <span>Music</span>
          </button>
          <span className="history-count" aria-label={`${historyCount} of 100 history messages`}>
            {historyCount}/100
          </span>
        </div>
        {musicOpen ? (
          <MusicRoomPanel
            musicState={musicState}
            socketStatus={socketStatus}
            onMusicState={onMusicState}
            audioEnabled={audioEnabled}
            expanded={musicOpen}
          />
        ) : historyOpen ? (
          <DanmakuHistory messages={messages} onMention={insertMention} />
        ) : null}
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
              aria-label="Mention Hoshia"
              disabled={socketStatus !== "live" && socketStatus !== "demo"}
            >
              @
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

function MusicRoomPanel({
  musicState,
  socketStatus,
  onMusicState,
  audioEnabled,
  expanded
}: {
  musicState: MusicState;
  socketStatus: string;
  onMusicState: (state: MusicState) => void;
  audioEnabled: boolean;
  expanded: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [notice, setNotice] = useState("");
  const current = musicState.current;
  const queuedTracks = current ? [current, ...musicState.queue] : musicState.queue;
  const canUseMusic = musicState.enabled && socketStatus !== "demo";
  const canControl = musicState.can_control && canUseMusic;
  const isPlaying = musicState.status === "playing";

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextSrc = current?.stream_url ? appPath(current.stream_url) : "";
    if (!nextSrc) {
      audio.removeAttribute("src");
      audio.load();
      return;
    }
    if (audio.getAttribute("src") !== nextSrc) {
      audio.src = nextSrc;
      audio.load();
    }
    if (!audioEnabled || musicState.status !== "playing") {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setNotice("Browser blocked playback. Turn sound off and on again after the track loads."));
  }, [audioEnabled, current?.id, current?.stream_url, musicState.status]);

  async function control(action: string, id?: string) {
    const payload = await postMusic("control", { action, id });
    if (payload?.state) onMusicState(payload.state);
    if (!payload?.ok) setNotice(friendlyMusicNotice(payload?.error));
  }

  return (
    <section className={`music-room ${musicState.enabled ? "enabled" : "disabled"} ${expanded ? "open" : ""}`} aria-label="Music room player">
      <audio ref={audioRef} preload="none" onEnded={() => void control("next")} />
      <div className="music-room-now">
        <div className="music-room-icon" aria-hidden="true">
          <Music size={16} />
        </div>
        <div className="music-room-title">
          <span>{musicState.enabled ? statusText(musicState.status) : "music off"}</span>
          <strong>{current ? trackLabel(current) : "No song playing"}</strong>
        </div>
      </div>
      <div className="music-room-expanded" aria-hidden={!expanded}>
        {canControl ? (
          <div className="music-room-controls">
            <button type="button" onClick={() => void control(isPlaying ? "pause" : "resume")} disabled={!current}>
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              <span>{isPlaying ? "pause" : "play"}</span>
            </button>
            <button type="button" onClick={() => void control("next")} disabled={!current && !musicState.queue.length}>
              <SkipForward size={14} />
              <span>next</span>
            </button>
            <button type="button" onClick={() => void control("clear")} disabled={!musicState.queue.length}>
              <Trash2 size={14} />
              <span>clear</span>
            </button>
          </div>
        ) : null}
        <div className="music-queue" aria-label="Song queue">
          {queuedTracks.map((track, index) => (
            <div className="music-queue-row" key={track.id || `track-${index}`}>
              <span className="music-queue-index">{String(index + 1).padStart(2, "0")}</span>
              <strong>{track.title}</strong>
              <em>{track.artist || "Unknown"}</em>
              {canControl && index > 0 ? (
                <button type="button" onClick={() => void control("remove", track.id)} aria-label={`Remove ${track.title}`}>
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {!queuedTracks.length ? <div className="music-queue-empty">还没有排队歌曲</div> : null}
        </div>
      </div>
      {(notice || musicState.last_error) ? (
        <p className="music-notice">{notice || friendlyMusicNotice(musicState.last_error)}</p>
      ) : null}
    </section>
  );
}
async function postMusic(_kind: "control", body: Record<string, unknown>) {
  const endpoint = "api/music/control";
  try {
    return await fetch(appPath(endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then((res) => res.json());
  } catch {
    return { ok: false, error: "music_network_error" };
  }
}

function trackLabel(track: MusicTrack) {
  return track.artist ? `${track.title} · ${track.artist}` : track.title;
}

function statusText(status: MusicState["status"]) {
  if (status === "loading") return "searching";
  if (status === "playing") return "now playing";
  if (status === "paused") return "paused";
  if (status === "error") return "music issue";
  return "music queue";
}

function friendlyMusicNotice(error?: string) {
  if (error === "music_disabled") return "Music room is not enabled yet.";
  if (error === "music_provider_unavailable") return "Music service is not ready.";
  if (error === "music_provider_timeout") return "Music service timed out.";
  if (error === "music_not_found") return "Could not find that song.";
  if (error === "music_unplayable") return "That song is not playable right now.";
  if (error === "music_rate_limited") return "Too many song requests. Try again later.";
  if (error === "music_queue_full") return "Song queue is full.";
  if (error === "music_forbidden") return "Only the host can control playback.";
  if (error === "music_target_not_found") return "Could not find that queued song.";
  return error ? "Music request failed." : "";
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

function localLine(role: "user" | "ai" | "system", nickname: string, text: string, extra: Partial<LiveMessage> = {}): LiveMessage {
  return {
    type: role === "ai" ? "ai_reply" : "danmaku",
    id: `${role}-${nickname}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    nickname,
    text,
    timestamp: new Date().toISOString(),
    ...extra
  };
}

function demoReply(text: string) {
  if (/断线|错误|error/i.test(text)) return "我看到连接提示了，会先稳住房间状态再继续陪你。";
  if (/你好|hi|hello/i.test(text)) return "我在这里，房间还是只对你和朋友开放。";
  return `收到啦：${text.slice(0, 36)}。我会保持这个阳光一点的直播节奏。`;
}

createRoot(document.getElementById("root")!).render(<App />);
