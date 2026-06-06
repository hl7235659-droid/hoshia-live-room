import { type CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ChevronDown, ChevronUp, KeyRound, Lock, LockKeyhole, Send, ShieldCheck, Signal, Users } from "lucide-react";
import { CharacterStage, getAnimatedStageLabel, getStagePresentation } from "./CharacterStage";
import { colorForMessage } from "./messageColors";
import type { CharacterState, LiveMessage, RoomInfo, Session } from "./types";
import { toCharacterState } from "./types";
import "./styles.css";

const loginMascotUrl = new URL("./assets/hoshia-login-chibi.png", import.meta.url).href;
const appBase = import.meta.env.BASE_URL || "/";
const isStageDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "stage";
const demoSession: Session = { user_id: "demo", nickname: "designer", room_id: "live-room-dev" };
const demoRoom: RoomInfo = { room_id: "live-room-dev", online: 2, private: true, websocket_auth: true };

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
  const [messages, setMessages] = useState<LiveMessage[]>(seedMessages);
  const [characterState, setCharacterState] = useState<CharacterState>("IDLE");
  const [socketStatus, setSocketStatus] = useState(isStageDemo ? "demo" : "locked");

  useEffect(() => {
    if (isStageDemo) return;
    fetch(appPath("api/auth/me"))
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (payload?.user) {
          setSession(payload.user);
          setRoom(payload.room);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session || isStageDemo) return;

    fetch(appPath("api/room/state"))
      .then((res) => res.json())
      .then((payload) => {
        setRoom(payload.room);
        setCharacterState(toCharacterState(payload.state));
        if (payload.messages?.length) setMessages(payload.messages);
      })
      .catch(() => undefined);

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
      onLeave={() => {
        setSession(null);
        setRoom(null);
        setSocketStatus("locked");
        setCharacterState("IDLE");
      }}
    />
  );
}

function LoginView({ onLogin }: { onLogin: (user: Session, room: RoomInfo) => void }) {
  const [nickname, setNickname] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
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

    const response = await fetch(appPath("api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, invite })
    });
    setBusy(false);

    if (!response.ok) {
      setError("Invite code is not valid.");
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
            <span>Invite gate</span>
            <strong>Private access</strong>
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
        <p>Use your room key to enter the friends-only stage.</p>
        <section className="login-welcome" aria-label="Hoshia welcome">
          <div className="login-mascot">
            <img src={loginMascotUrl} alt="Hoshia welcomes you at the private room gate" draggable={false} />
          </div>
          <div className="welcome-bubble">
            <strong>Welcome back.</strong>
            <span>The room is locked. I will open it when your key matches.</span>
          </div>
        </section>
        <div className="gate-strip" aria-label="Private room safety notes">
          <span><ShieldCheck size={14} /> Friends only</span>
          <span><LockKeyhole size={14} /> Locked room</span>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>Display name</span>
            <input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={32} placeholder="Nickname" />
          </label>
          <label>
            <span>Room key</span>
            <input value={invite} onChange={(event) => setInvite(event.target.value)} type="password" placeholder="Invite code" />
          </label>
          {error ? <span className="login-error">{error}</span> : null}
          <button disabled={busy || !nickname || !invite} type="submit">
            <KeyRound size={16} />
            {busy ? "Checking gate..." : "Unlock room"}
          </button>
        </form>
      </section>
    </main>
  );
}

function LiveMobile({
  session,
  room,
  messages,
  characterState,
  socketStatus,
  onLocalSendStart,
  onDemoSend,
  onLeave
}: {
  session: Session;
  room: RoomInfo | null;
  messages: LiveMessage[];
  characterState: CharacterState;
  socketStatus: string;
  onLocalSendStart: () => void;
  onDemoSend?: (text: string) => void;
  onLeave: () => void;
}) {
  const online = room?.online ?? 1;

  return (
    <main className="phone-shell">
      <section className="live-phone">
        <CharacterStage state={characterState} messages={messages} />
        <LiveOverlay
          state={characterState}
          online={online}
          socketStatus={socketStatus}
          messageCount={Math.min(messages.length, 100)}
          onLeave={onLeave}
        />
        <BottomDock
          messages={messages}
          socketStatus={socketStatus}
          nickname={session.nickname}
          onSendStart={onLocalSendStart}
          onDemoSend={onDemoSend}
        />
      </section>
    </main>
  );
}

function LiveOverlay({
  state,
  online,
  socketStatus,
  messageCount,
  onLeave
}: {
  state: CharacterState;
  online: number;
  socketStatus: string;
  messageCount: number;
  onLeave: () => void;
}) {
  const presentation = getStagePresentation(state);
  return (
    <section className="live-overlay" aria-label="Live room overlay">
      <header className="overlay-top">
        <button type="button" className="esc-button" aria-label="Leave room" onClick={onLeave}>
          <ArrowLeft size={18} />
        </button>
        <div className="live-title">
          <span className="live-dot" />
          <strong>Hoshia Live</strong>
          <small>friends only</small>
        </div>
        <div className="privacy-pill" title="Invite-only room">
          <LockKeyhole size={15} />
        </div>
      </header>

      <div className="stage-headline">
        <p className="stage-kicker">Hoshia 2.0</p>
        <AnimatedStageTitle text={getAnimatedStageLabel(state)} />
      </div>

      <div className="room-status-bar">
        <span><LockKeyhole size={12} /> Private room</span>
        <span>{online} online</span>
        <span>{friendlySocketStatus(socketStatus)}</span>
        <span>{sessionCue(state, presentation.cue)}</span>
        <span>{messageCount}/100</span>
      </div>

      {connectionNotice(socketStatus) ? (
        <div className="connection-notice">
          <Signal size={13} />
          <span>{connectionNotice(socketStatus)}</span>
        </div>
      ) : null}
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

function DanmakuHistory({ messages }: { messages: LiveMessage[] }) {
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
          <b>{message.nickname || labelForRole(message.role)}</b>
          <span>{message.text}</span>
        </p>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function BottomDock({
  messages,
  socketStatus,
  nickname,
  onSendStart,
  onDemoSend
}: {
  messages: LiveMessage[];
  socketStatus: string;
  nickname: string;
  onSendStart: () => void;
  onDemoSend?: (text: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [text, setText] = useState("");

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

  const canSend = (socketStatus === "live" || socketStatus === "demo") && Boolean(text.trim());

  return (
    <section className={`bottom-dock ${historyOpen ? "history-open" : ""}`} aria-label="Live chat dock">
      <section className={`history-drawer ${historyOpen ? "open" : ""}`} aria-label="Message history">
        <button type="button" className="history-toggle" onClick={() => setHistoryOpen((current) => !current)}>
          {historyOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          <span>{historyOpen ? "Hide history" : "History"}</span>
        </button>
        {historyOpen ? <DanmakuHistory messages={messages} /> : null}
      </section>
      <section className="live-control" aria-label="Live controls">
        <form className="sendbar" onSubmit={send}>
          <input
            value={text}
            maxLength={500}
            onChange={(event) => setText(event.target.value)}
            placeholder="Send a message to Hoshia..."
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
