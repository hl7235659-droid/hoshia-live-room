# Hoshia Live Room

Hoshia Live Room is a mobile-first, friends-only AI live room prototype.

It includes:

- React/Vite frontend for the account gate, Hoshia stage, danmaku, history drawer, input dock, and status UI.
- Node.js gateway for a room-token gate, one-time registration codes, account login, SQLite message history, HttpOnly sessions, WebSocket room events, character state, mock AI replies, and optional AstrBot bridge mode.
- Optional AstrBot bridge plugin for token-protected internal AI replies.

The current version is a 2.0 prototype. Real Live2D, TTS, account avatars, gifts, and action events are planned but not fully connected yet.

## Directory Structure

```text
.
|-- astrbot_plugin_live_room_bridge/  # Optional AstrBot internal bridge plugin
|-- docs/                             # Frontend and Live2D planning notes
|-- frontend/                         # React + Vite mobile live-room frontend
|-- gateway/                          # Node.js API/WebSocket gateway
|-- .env.example                      # Safe environment template
|-- docker-compose.yml                # Sidecar deployment compose file
`-- README.md
```

## Install

```bash
cd frontend
npm install

cd ../gateway
npm install
```

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Generate a session secret:

```bash
openssl rand -hex 32
```

Generate a room-token hash:

```bash
node gateway/scripts/hash-invite.mjs "your-room-token"
```

Set at least these values in `.env`:

```env
SESSION_SECRET=<your-random-secret>
ROOM_TOKEN_HASHES=<sha256-hex>
```

Generate one-time registration codes after the gateway dependencies are installed:

```bash
node gateway/scripts/generate-register-codes.mjs 20
```

The script prints the plain registration codes once and stores only their hashes in SQLite. Keep the plain codes somewhere private before sending them to friends.

Important options:

- `LIVE_ROOM_BIND_HOST`: defaults to `127.0.0.1` to avoid public exposure.
- `LIVE_ROOM_PORT`: defaults to `18888`.
- `SQLITE_DB_PATH`: defaults to `./data/live-room.sqlite` for local gateway runs.
- `AI_MODE`: `mock` by default; set to `astrbot` only after the bridge is installed.
- `ASTRBOT_BRIDGE_TOKEN`: shared bearer token for gateway and AstrBot bridge.
- `ASTRBOT_FALLBACK_TO_MOCK`: keeps the room usable when AstrBot is unavailable.

Never commit real `.env` files, tokens, certificates, private keys, room tokens, registration codes, or SQLite database files.

## Run

### Docker Compose

```bash
docker compose config
docker compose up -d --build
docker compose ps
```

Open:

```text
http://127.0.0.1:18888
```

### Local Development

Frontend:

```bash
cd frontend
npm run dev
```

Gateway:

```bash
cd gateway
npm start
```

Frontend dev URL:

```text
http://127.0.0.1:5173/live/
```

Stage-only dev preview:

```text
http://127.0.0.1:5173/live/?demo=stage
```

## Checks

Frontend:

```bash
cd frontend
npm run build
```

Gateway:

```bash
cd gateway
npm test
```

AstrBot bridge syntax check:

```bash
python -m compileall astrbot_plugin_live_room_bridge
```

## AstrBot Bridge

`astrbot_plugin_live_room_bridge/` is optional. The gateway defaults to `AI_MODE=mock`, so the project can run without AstrBot.

To connect AstrBot:

1. Set `bridge_token` in the AstrBot plugin config.
2. Set the same value as `ASTRBOT_BRIDGE_TOKEN` in gateway `.env`.
3. Set `AI_MODE=astrbot`.
4. Set `ASTRBOT_BRIDGE_URL`, for example `http://astrbot:18081/live-room/generate`.

Do not install or restart production AstrBot without an explicit deployment window.

## Notes

- Current character visuals are PNG fallback assets, not a real Live2D model.
- Chat messages are stored in SQLite and the room state API returns the latest 100 messages.
- Hoshia reads short batches of recent danmaku instead of replying to every message one by one. Messages that explicitly mention `@Hoshia`, `@星娅`, or `@主播` are prioritized, and targeted replies should start with `@nickname`.
- AstrBot replies use a shared room session (`<room_id>:room`) so the host has room-level context instead of separate one-on-one user sessions.
- Only final runtime assets should be committed. Generated green-screen/chroma images and temporary screenshots are ignored.
- `tmp/`, `frontend/dist/`, `node_modules/`, logs, and caches are ignored.
- The layout is intentionally split into Stage, Overlay, and Control so future Live2D, TTS, gifts, and avatar systems can be connected without rewriting the whole page.
