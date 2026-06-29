import { type CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Lock, Music, Send, Signal } from "lucide-react";
import { MusicRoomPanel } from "./MusicPanels";
import { colorForMessage } from "../messageColors";
import type { AudiencePayload, LiveMessage, MusicState } from "../types";

type HistoryDrawerState = "closed" | "normal" | "expanded";

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

export function BottomDock({
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
