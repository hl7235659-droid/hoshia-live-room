import { type CSSProperties, FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronLeft, ChevronUp, Clock, Gamepad2, KeyRound, Lock, LockKeyhole, LogIn, Menu, Music, Play, Send, Settings, Signal, Sparkles, UserPlus, Users, X } from "lucide-react";
import { CharacterStage, getAnimatedStageLabel } from "./CharacterStage";
import { AccountAvatar, AccountSettingsModal, RoomSettingsModal } from "./components/AccountPanels";
import { HoshiaTimelineOverlay } from "./components/TimelineOverlay";
import { HoshiaAwakeningIntro } from "./components/HoshiaAwakeningIntro";
import { GameLauncherOverlay, LiveOverlay } from "./components/LiveOverlay";
import { BottomDock } from "./components/LiveInputDock";
import { GlobalMusicPlayer, MusicRoomPanel } from "./components/MusicPanels";
import { HoshiaGameOverlay } from "./game/HoshiaGameOverlay";
import { colorForMessage } from "./messageColors";
import type { AudiencePayload, AudienceUser, CharacterState, HoshiaPost, HoshiaPresentation, HoshiaVisualState, LiveMessage, MusicState, MusicTrack, RoomInfo, Session } from "./types";
import { toCharacterState } from "./types";
import { appendPendingMessage, appendReplyDelta, appendRoomMessage, maxHistoryMessages, removePendingReply, toHoshiaPresentation } from "./liveMessageHistory";
import { appPath, fetchHoshiaPosts, wsPath } from "./liveRoomApi";
import { clearAutoLoginRecord, loadAutoLoginRecord, rememberRegisteredUsername, saveAutoLoginRecord, shouldPlayAwakeningForUser } from "./authStorage";
import { demoAudience, demoHoshiaPosts, demoHoshiaState, demoMusicState, demoRoom, demoSession, gameCatalog, isAwakeningDemo, isStageDemo } from "./demoLiveRoomData";
import "./styles.css";

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
