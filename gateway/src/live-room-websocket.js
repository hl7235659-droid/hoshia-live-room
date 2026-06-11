import { WebSocket, WebSocketServer } from "ws";

export const WEB_SOCKET_OPEN = WebSocket.OPEN;

export function attachLiveRoomWebSocket(server, deps) {
  const {
    activeUserConnections,
    broadcast,
    broadcastAudienceChanged,
    characterState,
    config,
    db,
    handleDanmaku,
    hoshiaVisualStateService,
    loadSessionFromReq,
    markUserOffline,
    markUserOnline,
    musicService,
    onClose,
    roomInfo,
    scheduleProactiveReplyCheck,
    scheduleWelcomeGreeting,
    shouldScheduleWelcomeGreeting,
    sockets,
    systemEvent,
    uniqueOnlineCount
  } = deps;

  const wss = new WebSocketServer({ noServer: true });
  const websocketHeartbeatIntervalMs = 25000;

  server.on("upgrade", async (req, socket, head) => {
    if (new URL(req.url, "http://localhost").pathname !== "/ws/live") {
      socket.destroy();
      return;
    }

    const session = await loadSessionFromReq(req);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, session);
    });
  });

  wss.on("connection", (ws, _req, session) => {
    ws.isAlive = true;
    sockets.set(ws, session);
    const alreadyOnline = activeUserConnections.has(session.user_id);
    markUserOnline(session);
    broadcast(systemEvent("presence", `${session.nickname} joined`, { online: uniqueOnlineCount() }));
    broadcastAudienceChanged();
    ws.send(JSON.stringify({
      type: "room_state",
      room: roomInfo(),
      state: characterState(),
      hoshia_state: hoshiaVisualStateService.publicState(),
      messages: db.listRecentRoomMessages(config.roomId, 100)
    }));
    ws.send(JSON.stringify({ type: "music_state", ...musicService.publicState(session) }));
    ws.send(JSON.stringify({
      type: "hoshia_state",
      room_id: config.roomId,
      state: hoshiaVisualStateService.publicState(),
      timestamp: new Date().toISOString()
    }));
    if (shouldScheduleWelcomeGreeting(session, alreadyOnline)) scheduleWelcomeGreeting(session);
    scheduleProactiveReplyCheck();

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (raw) => {
      try {
        const payload = JSON.parse(raw.toString("utf8"));
        if (payload.type !== "danmaku") return;
        await handleDanmaku(session, payload);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
      markUserOffline(session);
      broadcast(systemEvent("presence", `${session.nickname} left`, { online: uniqueOnlineCount() }));
      broadcastAudienceChanged();
      scheduleProactiveReplyCheck();
    });
  });

  const websocketHeartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, websocketHeartbeatIntervalMs);

  wss.on("close", () => {
    clearInterval(websocketHeartbeat);
    onClose?.();
  });

  return wss;
}
