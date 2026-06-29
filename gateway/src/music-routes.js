import { musicStatusCode } from "./live-room-formatters.js";

export function registerMusicRoutes(app, {
  config,
  musicService,
  moduleEventStore,
  requireSession,
  createMusicSongRequestedEvent,
  createMusicControlEvent,
  normalizeStoredAiProfile,
  appendMusicSongRequestedCharacterEvent,
  appendMusicControlCharacterEvent,
  broadcastMusicState,
  broadcastSystemText
}) {
  app.get("/api/music/state", requireSession, async (req, res) => {
    res.json(musicService.publicState(req.session));
  });

  app.post("/api/music/request", requireSession, async (req, res) => {
    const result = await musicService.requestSong(req.body?.query, req.session);
    if (!result.ok) {
      broadcastMusicState(req.session);
      return res.status(musicStatusCode(result.error)).json(result);
    }
    moduleEventStore.append(createMusicSongRequestedEvent(result.track, req.session, {
      roomId: config.roomId,
      memoryEligible: normalizeStoredAiProfile(req.session.ai_profile)?.memory_enabled === true,
      retentionDays: 30
    }));
    appendMusicSongRequestedCharacterEvent(result.track, req.session);
    await broadcastSystemText(`♪ ${req.session.nickname} 点歌《${result.track.title}》已加入播放。`);
    broadcastMusicState(req.session);
    res.json(result);
  });

  app.post("/api/music/control", requireSession, async (req, res) => {
    const result = musicService.control(req.body?.action, req.session, req.body || {});
    broadcastMusicState(req.session);
    if (!result.ok) return res.status(musicStatusCode(result.error)).json(result);
    moduleEventStore.append(createMusicControlEvent(req.body?.action, req.session, {
      roomId: config.roomId,
      status: "done",
      sourceKind: "manual"
    }));
    appendMusicControlCharacterEvent(req.body?.action, req.session, { sourceKind: "manual" });
    res.json(result);
  });

  app.post("/api/music/playback", requireSession, async (req, res) => {
    const result = musicService.completeCurrentTrack(req.body?.track_id ?? req.body?.trackId, req.session);
    broadcastMusicState(req.session);
    if (!result.ok) return res.status(musicStatusCode(result.error)).json(result);
    res.json(result);
  });

  app.get("/api/music/stream/:trackId", requireSession, async (req, res) => {
    try {
      await musicService.streamTrack(req.params.trackId, req, res);
    } catch (error) {
      res.status(502).json({ error: "music_stream_failed" });
    }
  });
}
