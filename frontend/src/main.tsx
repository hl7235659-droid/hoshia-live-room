import { type CSSProperties, FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronLeft, ChevronUp, Clock, Gamepad2, KeyRound, Lock, LockKeyhole, LogIn, Menu, Music, Play, Send, Settings, Signal, Sparkles, UserPlus, Users, X } from "lucide-react";
import { CharacterStage, getAnimatedStageLabel } from "./CharacterStage";
import { AccountAvatar, AccountSettingsModal, RoomSettingsModal } from "./components/AccountPanels";
import { HoshiaTimelineOverlay } from "./components/TimelineOverlay";
import { GlobalMusicPlayer, MusicRoomPanel } from "./components/MusicPanels";
import { HoshiaGameOverlay } from "./game/HoshiaGameOverlay";
import { colorForMessage } from "./messageColors";
import type { AiProfile, AudiencePayload, AudienceUser, CharacterState, HoshiaPost, HoshiaPresentation, HoshiaVisualState, LiveMessage, MusicState, MusicTrack, RoomInfo, Session } from "./types";
import { isHoshiaPresentation, toCharacterState } from "./types";
import "./styles.css";

const appBase = import.meta.env.BASE_URL || "/";
const awakeningBgUrl = appPath("assets/hoshia-awakening-bg.jpg");
const awakeningCharacterUrl = appPath("assets/hoshia-awakening-character.png");
const awakeningSoloBgUrl = appPath("assets/hoshia-awakening-solo-bg.jpg");
const awakeningFinalBgUrl = appPath("assets/hoshia-awakening-final-bg.jpg");
const introStorageKey = "hoshia:lastRegisteredUsername";
const autoLoginStorageKey = "hoshia:autoLogin:v1";
const maxHistoryMessages = 100;
type HistoryDrawerState = "closed" | "normal" | "expanded";

type GameCatalogItem = {
  id: string;
  title: string;
  genre: string;
  status: "available" | "soon";
  description: string;
  meta: string;
};

const gameCatalog: GameCatalogItem[] = [
  {
    id: "hoshia_pixel_mowdown",
    title: "Radio Pixel Mowdown",
    genre: "Survivors-like",
    status: "available",
    description: "锁定 Hoshia 当前心情与活动，进入 15 分钟像素割草波次。",
    meta: "1P / Hoshia mood director"
  },
  {
    id: "signal_puzzle_shift",
    title: "Signal Puzzle Shift",
    genre: "Puzzle",
    status: "soon",
    description: "把直播间信号块调到同一频率，预留给后续小游戏扩充。",
    meta: "COMING SOON"
  },
  {
    id: "catwalk_rhythm_dash",
    title: "Catwalk Rhythm Dash",
    genre: "Rhythm runner",
    status: "soon",
    description: "跟随弹幕节拍冲刺、闪避和收集星屑，后续开放。",
    meta: "COMING SOON"
  }
];
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

function appendRoomMessage(current: LiveMessage[], message: LiveMessage) {
  const traceId = message.latency_trace_id;
  const withoutPending = traceId && message.type === "ai_reply"
    ? current.filter((item) => !(item.type === "ai_reply_pending" && item.latency_trace_id === traceId))
    : current;
  return [...withoutPending, message].slice(-maxHistoryMessages);
}

function appendPendingMessage(current: LiveMessage[], message: LiveMessage) {
  if (!message.latency_trace_id) return appendRoomMessage(current, message);
  const exists = current.some((item) => item.type === "ai_reply_pending" && item.latency_trace_id === message.latency_trace_id);
  if (exists) {
    return current.map((item) => item.type === "ai_reply_pending" && item.latency_trace_id === message.latency_trace_id
      ? { ...item, ...message, pending: true }
      : item);
  }
  return appendRoomMessage(current, { ...message, pending: true });
}

function appendReplyDelta(current: LiveMessage[], payload: Partial<LiveMessage>) {
  const traceId = payload.latency_trace_id;
  if (!traceId) return current;
  return current.map((item) => item.type === "ai_reply_pending" && item.latency_trace_id === traceId
    ? {
        ...item,
        role: payload.stage === "stream" ? payload.role || "ai" : item.role,
        user_id: payload.stage === "stream" ? payload.user_id || "ai-host" : item.user_id,
        nickname: payload.stage === "stream" ? payload.nickname || "Hoshia" : item.nickname,
        text: payload.delta_mode === "replace" || (payload.stage === "stream" && !item.stream_started)
          ? `${payload.text || ""}`
          : `${item.text || ""}${payload.text || ""}`,
        stream_started: item.stream_started || payload.stage === "stream"
      }
    : item);
}

function removePendingReply(current: LiveMessage[], traceId: string | undefined) {
  if (!traceId) return current;
  return current.filter((item) => !(item.type === "ai_reply_pending" && item.latency_trace_id === traceId && !item.stream_started));
}

function toHoshiaPresentation(value: unknown) {
  return isHoshiaPresentation(value) ? value : null;
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

type AutoLoginRecord = {
  enabled: boolean;
  username: string;
  password: string;
};

function loadAutoLoginRecord(): AutoLoginRecord | null {
  try {
    const raw = window.localStorage.getItem(autoLoginStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AutoLoginRecord>;
    if (!value?.enabled || typeof value.username !== "string" || typeof value.password !== "string") return null;
    return {
      enabled: true,
      username: value.username,
      password: value.password
    };
  } catch {
    return null;
  }
}

function saveAutoLoginRecord(username: string, password: string) {
  try {
    window.localStorage.setItem(autoLoginStorageKey, JSON.stringify({
      enabled: true,
      username,
      password
    } satisfies AutoLoginRecord));
  } catch {
    // Auto login is optional. Login still succeeds when local storage is unavailable.
  }
}

function clearAutoLoginRecord() {
  try {
    window.localStorage.removeItem(autoLoginStorageKey);
  } catch {
    // Ignore unavailable local storage.
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(() => (isStageDemo ? demoSession : null));
  const [room, setRoom] = useState<RoomInfo | null>(() => (isStageDemo ? demoRoom : null));
  const [audience, setAudience] = useState<AudiencePayload | null>(() => (isStageDemo ? demoAudience : null));
  const [authChecked, setAuthChecked] = useState(isStageDemo);
  const [messages, setMessages] = useState<LiveMessage[]>(seedMessages);
  const [musicState, setMusicState] = useState<MusicState>(demoMusicState);
  const [characterState, setCharacterState] = useState<CharacterState>("IDLE");
  const [hoshiaState, setHoshiaState] = useState<HoshiaVisualState | null>(() => (isStageDemo ? demoHoshiaState : null));
  const [hoshiaPresentation, setHoshiaPresentation] = useState<HoshiaPresentation | null>(null);
  const [socketStatus, setSocketStatus] = useState(isStageDemo ? "demo" : "locked");
  const [awakeningIntroOpen, setAwakeningIntroOpen] = useState(isAwakeningDemo);
  const [hoshiaPostsRefreshKey, setHoshiaPostsRefreshKey] = useState(0);

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
          return;
        }
      } catch {
        // The QQ email account entry remains available even if the session check fails.
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
        // Contact data is optional UI chrome; keep the entry usable if it fails.
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
          setHoshiaPresentation(toHoshiaPresentation(payload.hoshia_presentation));
          if (payload.hoshia_state) setHoshiaState(payload.hoshia_state);
          if (payload.messages?.length) setMessages(payload.messages.slice(-maxHistoryMessages));
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
        setMessages((current) => appendRoomMessage(current, payload));
      }
      if (payload.type === "ai_reply_pending") {
        setMessages((current) => appendPendingMessage(current, payload));
      }
      if (payload.type === "ai_reply_delta") {
        setMessages((current) => appendReplyDelta(current, payload));
      }
      if (payload.type === "ai_reply_done") {
        setMessages((current) => removePendingReply(current, payload.latency_trace_id));
      }
      if (payload.type === "error") {
        setSocketStatus("error");
        setCharacterState("ERROR");
        setHoshiaPresentation(null);
        setMessages((current) => appendRoomMessage(current, localLine("system", "room", friendlyError(payload.error))));
      }
      if (payload.type === "room_state") {
        setRoom(payload.room);
        setCharacterState(toCharacterState(payload.state));
        setHoshiaPresentation(toHoshiaPresentation(payload.hoshia_presentation));
        if (payload.hoshia_state) setHoshiaState(payload.hoshia_state);
        if (payload.messages?.length) setMessages(payload.messages.slice(-maxHistoryMessages));
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
      if (payload.type === "hoshia_presentation") {
        setHoshiaPresentation(toHoshiaPresentation(payload.presentation ?? payload.hoshia_presentation ?? payload));
      }
      if (payload.type === "hoshia_posts_changed") {
        setHoshiaPostsRefreshKey((current) => current + 1);
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
      hoshiaPresentation={hoshiaPresentation}
      musicState={musicState}
      onMusicState={setMusicState}
      socketStatus={socketStatus}
      audience={audience}
      isDemo={isStageDemo}
      hoshiaPostsRefreshKey={hoshiaPostsRefreshKey}
      onLocalSendStart={() => {
        setHoshiaPresentation(null);
        setCharacterState("LISTENING");
        window.setTimeout(() => setCharacterState((current) => (current === "LISTENING" ? "THINKING" : current)), 420);
      }}
      onDemoSend={isStageDemo ? (text) => {
        setMessages((current) => appendRoomMessage(current, localLine("user", session.nickname, text, { color: session.danmaku_color || undefined })));
        setHoshiaPresentation(null);
        setCharacterState("LISTENING");
        window.setTimeout(() => setCharacterState((current) => (current === "LISTENING" ? "THINKING" : current)), 420);
        window.setTimeout(() => {
          setMessages((current) => appendRoomMessage(current, localLine("ai", "hoshia", demoReply(text))));
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
        setHoshiaPresentation(null);
        setAwakeningIntroOpen(false);
      }}
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
            <span>联系入口</span>
            <strong>正在确认入口</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

function LoginView({ onLogin }: { onLogin: (user: Session, room: RoomInfo, playAwakeningIntro: boolean) => void }) {
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [autoLoginEnabled, setAutoLoginEnabled] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
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

  useEffect(() => {
    const saved = loadAutoLoginRecord();
    if (!saved) return;
    setAuthMode("login");
    setUsername(saved.username);
    setPassword(saved.password);
    setAutoLoginEnabled(true);
    if (isQqEmail(saved.username) && saved.password.length >= 8) {
      void loginWithCredentials(saved.username, saved.password, { automatic: true, persistAutoLogin: true });
    }
  }, []);

  useEffect(() => {
    if (!codeCooldown) return;
    const timer = window.setTimeout(() => setCodeCooldown((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [codeCooldown]);

  useEffect(() => {
    if (!error && !notice) return;
    const timer = window.setTimeout(() => {
      setError("");
      setNotice("");
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [error, notice]);

  async function sendVerificationCode() {
    setError("");
    setNotice("");
    if (!isQqEmail(username)) {
      setError("请先填写有效的 QQ 邮箱");
      return;
    }
    setCodeBusy(true);
    const response = await fetch(appPath("api/auth/register-code/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: username })
    });
    setCodeBusy(false);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(authErrorMessage(payload?.error, "register"));
      return;
    }
    setCodeCooldown(Number(payload?.cooldown_seconds || 60));
    setNotice("验证码已发送到 QQ 邮箱，10 分钟内有效");
  }

  async function loginWithCredentials(
    loginUsername: string,
    loginPassword: string,
    options: { automatic?: boolean; persistAutoLogin?: boolean } = {}
  ) {
    setBusy(true);
    setError("");
    setNotice("");

    const response = await fetch(appPath("api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: loginUsername, password: loginPassword })
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(options.automatic ? "自动登录失败，请检查账号或密码" : authErrorMessage(payload?.error, "login"));
      return;
    }

    if (options.persistAutoLogin) {
      saveAutoLoginRecord(loginUsername, loginPassword);
    } else {
      clearAutoLoginRecord();
    }

    const payload = await response.json();
    const me = await fetch(appPath("api/auth/me")).then((res) => res.json());
    onLogin(payload.user, me.room, shouldPlayAwakeningForUser(payload.user));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const isRegistering = authMode === "register";

    if (!isRegistering) {
      await loginWithCredentials(username, password, { persistAutoLogin: autoLoginEnabled });
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");

    const response = await fetch(appPath("api/auth/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, verificationCode })
    });
    setBusy(false);

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(authErrorMessage(payload?.error, authMode));
      return;
    }

    rememberRegisteredUsername(username);
    setAuthMode("login");
    setPassword("");
    setVerificationCode("");
    setNotice("QQ 邮箱注册成功，请使用密码登录");
  }

  return (
    <main className="phone-shell login-shell">
      <section className="login-card">
        <header className="login-glass-header">
          <div className="login-title-copy">
            <span>Hoshia Live Room</span>
            <div className="login-title-row">
              <h1>{authMode === "register" ? "注册" : "登录"}</h1>
              <div className="login-presence" aria-label="在线人数">
                <span className="presence-dot" aria-hidden="true" />
                <Users size={14} />
                <span>{roomPreview.online} 人在线</span>
              </div>
            </div>
            <p>{authMode === "register" ? "使用 QQ 邮箱接收验证码，完成账号注册" : "使用 QQ 邮箱和密码登录"}</p>
          </div>
        </header>
        <form className={`login-form ${authMode === "register" ? "is-register" : "is-login"}`} onSubmit={submit}>
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
              <span>登录</span>
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
              <span>注册</span>
            </button>
          </div>
          <label>
            <span>QQ 邮箱</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={64} placeholder="123456@qq.com" autoComplete="email" inputMode="email" />
          </label>
          <label>
            <span>密码</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="至少 8 位" autoComplete={authMode === "register" ? "new-password" : "current-password"} />
          </label>
          {authMode === "register" ? (
            <label>
              <span>邮箱验证码</span>
              <div className="verification-code-row">
                <input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} placeholder="6 位验证码" inputMode="numeric" autoComplete="one-time-code" />
                <button type="button" className="inline-code-button" disabled={codeBusy || codeCooldown > 0 || !isQqEmail(username)} onClick={sendVerificationCode}>
                  {codeBusy ? "发送中" : codeCooldown > 0 ? `${codeCooldown}s` : "发送验证码"}
                </button>
              </div>
            </label>
          ) : null}
          <div className="login-submit-wrap">
            <button disabled={busy || !canSubmitAuth(authMode, { username, password, verificationCode })} type="submit">
              <KeyRound size={16} />
              {busy ? "处理中..." : authMode === "register" ? "注册" : "登录"}
            </button>
            {authMode === "login" ? (
              <label className="auto-login-toggle">
                <input
                  type="checkbox"
                  checked={autoLoginEnabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setAutoLoginEnabled(checked);
                    if (!checked) clearAutoLoginRecord();
                  }}
                />
                <span>自动登录</span>
              </label>
            ) : null}
          </div>
        </form>
      </section>
      {error || notice ? (
        <div className={`login-toast ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}>
          {error || notice}
        </div>
      ) : null}
    </main>
  );
}

function canSubmitAuth(
  mode: "login" | "register",
  values: { username: string; password: string; verificationCode: string }
) {
  if (!isQqEmail(values.username) || values.password.length < 8) return false;
  if (mode === "login") return true;
  return /^\d{6}$/.test(values.verificationCode.trim());
}

function isQqEmail(value: string) {
  return /^[1-9]\d{4,11}@qq\.com$/i.test(value.trim());
}

function authErrorMessage(error: string | undefined, mode: "login" | "register") {
  if (error === "invalid_credentials") return "QQ 邮箱或密码不正确";
  if (error === "qq_email_invalid" || error === "username_invalid") return "请输入 QQ 邮箱，例如 123456@qq.com";
  if (error === "password_invalid") return "密码至少 8 位";
  if (error === "nickname_required") return "昵称至少 2 个字符";
  if (error === "username_taken") return "这个 QQ 邮箱已经注册过";
  if (error === "email_code_invalid") return "验证码不正确";
  if (error === "email_code_used") return "验证码已经使用，请重新获取";
  if (error === "email_code_expired") return "验证码已过期，请重新获取";
  if (error === "email_code_rate_limited") return "验证码发送太频繁，请稍后再试";
  if (error === "email_send_failed") return "验证码邮件发送失败，邮箱服务暂时不可用";
  return mode === "register" ? "注册失败，请检查 QQ 邮箱和验证码" : "登录失败";
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
  hoshiaPresentation,
  musicState,
  onMusicState,
  socketStatus,
  audience,
  isDemo,
  hoshiaPostsRefreshKey,
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
  hoshiaPresentation: HoshiaPresentation | null;
  musicState: MusicState;
  onMusicState: (state: MusicState) => void;
  socketStatus: string;
  audience: AudiencePayload | null;
  isDemo: boolean;
  hoshiaPostsRefreshKey: number;
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
  const [musicPlaybackNotice, setMusicPlaybackNotice] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [gameLauncherOpen, setGameLauncherOpen] = useState(false);
  const [activeGameId, setActiveGameId] = useState("");
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
  }, [timelineOpen, isDemo, hoshiaPostsRefreshKey]);

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
        <CharacterStage state={characterState} messages={messages} visualState={hoshiaState} presentation={hoshiaPresentation} />
        <LiveOverlay
          state={characterState}
          session={session}
          room={room}
          socketStatus={socketStatus}
          audience={audience}
          onOpenAccount={() => setAccountOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenTimeline={() => setTimelineOpen(true)}
          onOpenGame={() => setGameLauncherOpen(true)}
          onLeave={onLeave}
        />
        <BottomDock
          messages={messages}
          musicState={musicState}
          onMusicState={onMusicState}
          musicPlaybackNotice={musicPlaybackNotice}
          audience={audience}
          socketStatus={socketStatus}
          nickname={session.nickname}
          audioEnabled={audioEnabled}
          onSendStart={onLocalSendStart}
          onDemoSend={onDemoSend}
        />
        <GlobalMusicPlayer
          musicState={musicState}
          socketStatus={socketStatus}
          audioEnabled={audioEnabled}
          onMusicState={onMusicState}
          onNotice={setMusicPlaybackNotice}
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
        {gameLauncherOpen ? (
          <GameLauncherOverlay
            onClose={() => setGameLauncherOpen(false)}
            onLaunch={(gameId) => {
              setGameLauncherOpen(false);
              setActiveGameId(gameId);
            }}
          />
        ) : null}
        {activeGameId === "hoshia_pixel_mowdown" ? (
          <HoshiaGameOverlay
            session={session}
            isDemo={isDemo}
            hoshiaState={hoshiaState}
            onClose={() => setActiveGameId("")}
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

function GameLauncherOverlay({
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

function LiveOverlay({
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
          <button type="button" onClick={() => onChooseName("特别联系人")}>特别联系人</button>
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
      {messages.map((message, index) => {
        const repeatedSender = isSameHistorySender(messages[index - 1], message);
        const displayName = message.nickname || labelForRole(message.role);
        return (
          <p
            key={`${message.id}-${index}`}
            className={`line ${message.role} ${repeatedSender ? "continuation" : ""}`}
            style={{ "--message-color": colorForMessage(message) } as CSSProperties}
          >
            {repeatedSender ? (
              <span className="mention-spacer" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className="mention-name"
                onClick={() => onMention(displayName)}
                title={`提到 ${displayName}`}
              >
                {displayName}
              </button>
            )}
            <span>{message.text}</span>
          </p>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function BottomDock({
  messages,
  musicState,
  onMusicState,
  musicPlaybackNotice,
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
  musicPlaybackNotice: string;
  audience: AudiencePayload | null;
  socketStatus: string;
  nickname: string;
  audioEnabled: boolean;
  onSendStart: () => void;
  onDemoSend?: (text: string) => void;
}) {
  const [historyMode, setHistoryMode] = useState<HistoryDrawerState>("normal");
  const [musicOpen, setMusicOpen] = useState(false);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const historyCount = Math.min(messages.length, 100);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onlineMembers = (audience?.users || []).filter((user) => user.online && user.nickname !== nickname);

  function toggleHistory() {
    setHistoryMode((current) => {
      setMusicOpen(false);
      if (current === "closed") return "normal";
      if (current === "normal") return "expanded";
      return "closed";
    });
  }

  function toggleMusic() {
    setMusicOpen((current) => {
      const next = !current;
      if (next) setHistoryMode("closed");
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
  const historyVisible = historyMode !== "closed";
  const historyExpanded = historyMode === "expanded";
  const historyToggleLabel = historyMode === "closed" ? "展开留言" : historyMode === "normal" ? "展开更多留言" : "收起留言";

  return (
    <section className={`bottom-dock ${historyVisible ? "history-open" : ""} ${historyExpanded ? "history-expanded" : ""} ${musicOpen ? "music-open" : ""}`} aria-label="留言栏">
      <section className={`history-drawer ${historyVisible || musicOpen ? "open" : ""} ${historyExpanded ? "expanded" : ""} ${musicOpen ? "music-active" : ""}`} aria-label="留言记录">
        <div className="history-header">
          <button
            type="button"
            className="history-toggle"
            aria-expanded={historyVisible}
            aria-label={historyToggleLabel}
            onClick={toggleHistory}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggleHistory();
            }}
          >
            {historyMode === "expanded" ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            <span>留言</span>
          </button>
          <button
            type="button"
            className="music-header-toggle"
            aria-expanded={musicOpen}
            onClick={toggleMusic}
          >
            <Music size={15} />
            <span>音乐</span>
          </button>
          <span className="history-count" aria-label={`${historyCount} / 100 条留言`}>
            {historyCount}/100
          </span>
        </div>
        {musicOpen ? (
          <MusicRoomPanel
            musicState={musicState}
            socketStatus={socketStatus}
            onMusicState={onMusicState}
            audioEnabled={audioEnabled}
            playbackNotice={musicPlaybackNotice}
            expanded={musicOpen}
          />
        ) : historyVisible ? (
          <DanmakuHistory messages={messages} onMention={insertMention} />
        ) : null}
      </section>
      <section className="live-control" aria-label="联系状态控制">
        <form className="sendbar" onSubmit={send}>
          <div className={`mention-combo ${mentionPickerOpen ? "open" : ""}`}>
            {mentionPickerOpen ? (
              <div className="mention-picker" role="listbox" aria-label="提到已接入联系人">
                <span className="mention-picker-title">提到联系人</span>
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
                  <span className="mention-picker-empty">暂无其他联系人接入</span>
                )}
              </div>
            ) : null}
            <button
              type="button"
              className="mention-expand"
              onClick={() => setMentionPickerOpen((current) => !current)}
              title="提到已接入联系人"
              aria-label="提到已接入联系人"
              aria-expanded={mentionPickerOpen}
              disabled={socketStatus !== "live" && socketStatus !== "demo"}
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              className="mention-hoshia"
              onClick={() => insertMention("Hoshia")}
              title="提到 Hoshia"
              aria-label="提到 Hoshia"
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
            placeholder="写一条留言或 @Hoshia..."
          />
          <button type="submit" title="发送留言" disabled={!canSend}>
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

function isSameHistorySender(previous?: LiveMessage, current?: LiveMessage) {
  if (!previous || !current) return false;
  if (previous.role !== current.role) return false;
  const previousName = previous.nickname || labelForRole(previous.role);
  const currentName = current.nickname || labelForRole(current.role);
  return previous.user_id === current.user_id && previousName === currentName;
}

function labelForRole(role: string) {
  if (role === "ai") return "hoshia";
  if (role === "system") return "系统";
  return "特别联系人";
}

function friendlySocketStatus(status: string) {
  if (status === "live") return "联系已接通";
  if (status === "connecting") return "正在接入";
  if (status === "reconnecting") return "正在重连";
  if (status === "closed") return "正在重连";
  if (status === "error") return "联系暂停";
  if (status === "demo") return "预览";
  return "私密联系";
}

function connectionNotice(status: string) {
  if (status === "connecting") return "正在打开私密联系入口...";
  if (status === "reconnecting" || status === "closed") return "联系中断，正在尝试恢复...";
  if (status === "error") return "联系暂停，当前状态仍会保留。";
  return "";
}

function friendlyError(error: unknown) {
  if (error === "rate_limited") return "留言发送太快了，请稍等一下。";
  if (error === "message_invalid") return "这条留言无法发送，请试试短一点的内容。";
  return "联系状态出现小问题，正在尝试恢复。";
}

function sessionCue(state: CharacterState, fallback: string) {
  if (state === "IDLE") return "等待你的留言";
  if (state === "LISTENING") return "正在接收留言";
  if (state === "THINKING") return "Hoshia 正在整理";
  if (state === "SPEAKING") return "Hoshia 正在回应";
  if (state === "ERROR") return "正在恢复联系状态";
  return fallback;
}

const seedMessages: LiveMessage[] = [
  line("ai", "hoshia", "你好，我是 Hoshia。星见终端已经准备好。"),
  line("user", "miruko2", "这里是特别联系人入口，对吧？"),
  line("ai", "hoshia", "对。我会把联系状态保持在私密、安静、明亮。"),
  line("user", "miruko2", "试试接收留言的状态。"),
  line("ai", "hoshia", "收到，我在认真接收。")
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
  return `收到啦：${text.slice(0, 36)}。我会保持这个阳光一点的聊天节奏。`;
}

createRoot(document.getElementById("root")!).render(<App />);
