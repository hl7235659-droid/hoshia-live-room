import { useEffect, useRef, useState } from "react";
import { Music } from "lucide-react";
import type { MusicState, MusicTrack } from "../types";

const appBase = import.meta.env.BASE_URL || "/";

function appPath(path: string) {
  const base = appBase.endsWith("/") ? appBase : `${appBase}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}
export function MusicRoomPanel({
  musicState,
  socketStatus,
  onMusicState,
  audioEnabled,
  playbackNotice,
  expanded
}: {
  musicState: MusicState;
  socketStatus: string;
  onMusicState: (state: MusicState) => void;
  audioEnabled: boolean;
  playbackNotice: string;
  expanded: boolean;
}) {
  const [notice, setNotice] = useState("");
  const current = musicState.current;
  const queuedTracks = current ? [current, ...musicState.queue] : musicState.queue;
  const canUseMusic = musicState.enabled && socketStatus !== "demo";
  const isPlaying = musicState.status === "playing";
  const playbackStatus = canUseMusic && current && !audioEnabled ? "Sound is off on this device." : "";
  const panelNotice = notice || playbackNotice || musicState.last_error || playbackStatus;

  async function control(action: "previous" | "pause" | "resume" | "next" | "remove", id?: string) {
    if (!canUseMusic) return;
    setNotice("");
    const payload = await postMusic("control", id ? { action, id } : { action });
    if (payload?.state) onMusicState(payload.state);
    if (!payload?.ok) setNotice(friendlyMusicNotice(payload?.error));
  }

  return (
    <section className={`music-room ${musicState.enabled ? "enabled" : "disabled"} ${expanded ? "open" : ""}`} aria-label="音乐留言播放器">
      <div className="music-room-now">
        <div className="music-room-icon" aria-hidden="true">
          <Music size={16} />
        </div>
        <div className="music-room-title">
          <span>{musicState.enabled ? statusText(musicState.status) : "music off"}</span>
          <strong>{current ? trackLabel(current) : "No song playing"}</strong>
        </div>
        <div className="music-room-inline-controls" aria-label="Playback controls">
          <button type="button" onClick={() => void control("previous")} disabled={!canUseMusic || !musicState.can_previous} title="Previous" aria-label="Previous song">‹</button>
          <button type="button" onClick={() => void control(isPlaying ? "pause" : "resume")} disabled={!canUseMusic || !current} title={isPlaying ? "Pause" : "Play"} aria-label={isPlaying ? "Pause music" : "Resume music"}>
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button type="button" onClick={() => void control("next")} disabled={!canUseMusic || (!current && !musicState.queue.length)} title="Next" aria-label="Next song">›</button>
        </div>
      </div>
      <div className="music-room-expanded" aria-hidden={!expanded}>
        <div className="music-queue" aria-label="Song queue">
          {queuedTracks.map((track, index) => (
            <div className="music-queue-row" key={track.id || `track-${index}`}>
              <span className="music-queue-index">{String(index + 1).padStart(2, "0")}</span>
              <strong>{track.title}</strong>
              <em>{track.artist || "Unknown"}</em>
              {index > 0 ? (
                <button type="button" className="music-queue-remove" onClick={() => void control("remove", track.id)} aria-label={`Remove ${track.title}`} disabled={!canUseMusic}>
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {!queuedTracks.length ? <div className="music-queue-empty">还没有排队歌曲</div> : null}
        </div>
      </div>
      {panelNotice ? (
        <p className="music-notice">{panelNotice === musicState.last_error ? friendlyMusicNotice(panelNotice) : panelNotice}</p>
      ) : null}
    </section>
  );
}

export function GlobalMusicPlayer({
  musicState,
  socketStatus,
  audioEnabled,
  onMusicState,
  onNotice
}: {
  musicState: MusicState;
  socketStatus: string;
  audioEnabled: boolean;
  onMusicState: (state: MusicState) => void;
  onNotice: (notice: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stallTimerRef = useRef<number | undefined>(undefined);
  const progressTimerRef = useRef<number | undefined>(undefined);
  const lastProgressRef = useRef({ currentTime: 0, checkedAt: 0 });
  const reportedTrackRef = useRef("");
  const current = musicState.current;
  const canUseMusic = musicState.enabled && socketStatus !== "demo";
  const shouldPlay = canUseMusic && audioEnabled && musicState.status === "playing" && Boolean(current?.stream_url);

  function clearStallTimer() {
    if (stallTimerRef.current) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = undefined;
    }
  }

  async function reportPlaybackComplete(reason: string) {
    if (!current?.id || !canUseMusic) return;
    const reportKey = `${current.id}:${reason}`;
    if (reportedTrackRef.current === reportKey) return;
    reportedTrackRef.current = reportKey;
    clearStallTimer();
    const payload = await postMusic("playback", { track_id: current.id, reason });
    if (payload?.state) onMusicState(payload.state);
    if (!payload?.ok && payload?.error !== "music_target_not_found") {
      onNotice(friendlyMusicNotice(payload?.error));
    }
  }

  function scheduleStallReport(reason: string) {
    if (!shouldPlay) return;
    clearStallTimer();
    stallTimerRef.current = window.setTimeout(() => {
      void reportPlaybackComplete(reason);
    }, 25000);
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    reportedTrackRef.current = "";
    lastProgressRef.current = { currentTime: 0, checkedAt: Date.now() };
    clearStallTimer();
    const nextSrc = canUseMusic && current?.stream_url ? appPath(current.stream_url) : "";
    if (!nextSrc) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      onNotice("");
      return;
    }
    if (audio.getAttribute("src") !== nextSrc) {
      audio.src = nextSrc;
      audio.load();
    }
    if (!shouldPlay) {
      audio.pause();
      if (musicState.status !== "error") onNotice("");
      return;
    }
    void audio.play()
      .then(() => onNotice(""))
      .catch(() => onNotice("Browser blocked playback. Turn sound off and on again after the track loads."));
    return () => {
      clearStallTimer();
    };
  }, [canUseMusic, current?.id, current?.stream_url, musicState.status, onNotice, shouldPlay]);

  useEffect(() => {
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = undefined;
    }
    if (!shouldPlay) return;
    progressTimerRef.current = window.setInterval(() => {
      const audio = audioRef.current;
      if (!audio || audio.paused || audio.ended) return;
      const now = Date.now();
      const last = lastProgressRef.current;
      if (Math.abs(audio.currentTime - last.currentTime) > 0.2) {
        lastProgressRef.current = { currentTime: audio.currentTime, checkedAt: now };
        return;
      }
      if (now - last.checkedAt >= 45000) {
        void reportPlaybackComplete("no_progress");
      }
    }, 10000);
    return () => {
      if (progressTimerRef.current) {
        window.clearInterval(progressTimerRef.current);
        progressTimerRef.current = undefined;
      }
    };
  }, [shouldPlay, current?.id]);

  return (
    <audio
      ref={audioRef}
      preload="none"
      onEnded={() => void reportPlaybackComplete("ended")}
      onError={() => void reportPlaybackComplete("error")}
      onStalled={() => scheduleStallReport("stalled")}
      onWaiting={() => scheduleStallReport("waiting")}
      onPlaying={() => {
        clearStallTimer();
        lastProgressRef.current = { currentTime: audioRef.current?.currentTime || 0, checkedAt: Date.now() };
      }}
      onTimeUpdate={() => {
        clearStallTimer();
        lastProgressRef.current = { currentTime: audioRef.current?.currentTime || 0, checkedAt: Date.now() };
      }}
    />
  );
}
async function postMusic(kind: "control" | "playback", body: Record<string, unknown>) {
  const endpoint = kind === "playback" ? "api/music/playback" : "api/music/control";
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
  if (error === "music_disabled") return "音乐留言还没有启用。";
  if (error === "music_provider_unavailable") return "音乐服务还没有准备好。";
  if (error === "music_provider_timeout") return "音乐服务响应超时。";
  if (error === "music_not_found") return "没有找到这首歌。";
  if (error === "music_unplayable") return "这首歌现在无法播放。";
  if (error === "music_rate_limited") return "点歌太频繁了，稍后再试。";
  if (error === "music_queue_full") return "音乐队列已满。";
  if (error === "music_forbidden") return "只有特别联系人可以控制播放。";
  if (error === "music_target_not_found") return "没有找到这首排队歌曲。";
  return error ? "音乐请求失败。" : "";
}
