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
|-- services/hoshiaclaw/              # Optional Go AI sidecar service
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
- `AI_MODE`: `mock` by default; set to `astrbot` or `hoshiaclaw` only after that backend is installed.
- `ASTRBOT_BRIDGE_TOKEN`: shared bearer token for gateway and AstrBot bridge.
- `ASTRBOT_FALLBACK_TO_MOCK`: keeps the room usable when AstrBot is unavailable.
- `HOSHIACLAW_BRIDGE_URL`: internal Compose URL for the optional Hoshiaclaw sidecar generate endpoint, normally `http://live-room-hoshiaclaw:8080/live-room/generate`.
- `HOSHIACLAW_TOKEN`: shared internal token between the gateway and Hoshiaclaw. Use a generated secret in `.env`; never commit the real value.
- `HOSHIACLAW_TIMEOUT_MS`: gateway timeout for Hoshiaclaw replies.
- `HOSHIACLAW_FALLBACK_TO_MOCK`: keeps the room usable if Hoshiaclaw is unavailable.
- `HOSHIACLAW_STREAMING_ENABLED`: enables streaming when the Hoshiaclaw backend supports it.
- `HOSHIACLAW_LISTEN_ADDR`: Hoshiaclaw container listen address, normally `0.0.0.0:8080`.
- `HOSHIACLAW_DATA_DIR` / `HOSHIACLAW_LOG_DIR`: container runtime paths for sidecar data and logs.
- `HOSHIACLAW_PROVIDER`: `fake` by default. Set to `openai_compatible` only in private `.env` files after the provider key and model are ready.
- `HOSHIACLAW_OPENAI_BASE_URL`: OpenAI-compatible base URL without `/chat/completions`, for example `https://opencode.ai/zen/go/v1` for OpenCode Go.
- `HOSHIACLAW_OPENAI_API_KEY`: provider API key. Keep the real value only in private server `.env`.
- `HOSHIACLAW_OPENAI_MODEL`: provider model id, for example `deepseek-v4-flash` on OpenCode Go.
- `HOSHIACLAW_OPENAI_TIMEOUT_MS` / `HOSHIACLAW_OPENAI_MAX_TOKENS` / `HOSHIACLAW_OPENAI_TEMPERATURE`: sidecar model-call limits. `deepseek-v4-flash` may need a larger token cap such as `1200` because reasoning tokens can consume part of the budget before the final JSON content.
- `SINGLE_USER_DIRECT_REPLY_ENABLED`: makes single-viewer rooms reply without requiring `@Hoshia`.
- `SINGLE_USER_REPLY_DELAY_MS`: short delay before a single-viewer direct reply; defaults to `600`.
- `MUSIC_ENABLED`: enables the private-room music queue experiment.
- `MUSIC_PROVIDER_BASE_URL`: internal xiaomusic URL, for example `http://xiaomusic:8090`.
- `MUSIC_ADMIN_USERNAMES`: comma-separated live-room usernames allowed to control playback.
- `SHORT_TERM_CONTEXT_MAX_MESSAGES`: recent user/AI messages sent to AstrBot as live-room short-term context; defaults to `100` (about 50 rounds).
- `CONTEXT_SUMMARY_LOOKBACK_MESSAGES`: maximum unsummarized messages scanned for rolling context summary refresh; defaults to `600`.
- `CONTEXT_SUMMARY_COMPRESS_MESSAGES`: older messages summarized per refresh when the recent context is over the limit; defaults to `20`.
- `PROACTIVE_REPLY_ENABLED`: enables idle proactive Hoshia replies when at least one viewer is online; defaults to `false`.
- `PROACTIVE_REPLY_MIN_IDLE_SECONDS` / `PROACTIVE_REPLY_MAX_IDLE_SECONDS`: random idle window before Hoshia speaks; defaults to `300`-`900`.
- `PROACTIVE_REPLY_MAX_UNANSWERED`: pauses idle proactive replies after this many unanswered proactive messages; defaults to `3`.
- `PROACTIVE_REPLY_CONTEXT_MESSAGES`: recent room messages sent as proactive reply context; defaults to `24`.
- `HOSHIA_DAILY_POST_ENABLED`: enables automatic Hoshia timeline posts; defaults to `true`. Set it to `false` to pause automatic posting without affecting manual ticks.
- `HOSHIA_DAILY_POST_MIN` / `HOSHIA_DAILY_POST_MAX`: daily automatic post floor and cap; defaults to `1` and `5`.
- `HOSHIA_STATE_POST_MIN_INTERVAL_MINUTES`: minimum spacing between automatic posts; defaults to `90`.
- `HOSHIA_STATE_POST_ACTIVE_WINDOW_START` / `HOSHIA_STATE_POST_ACTIVE_WINDOW_END`: local active posting window for automatic posts; defaults to `10:00`-`23:50`.
- `HOSHIA_NEWS_ENABLED`: enables the gateway-side safe news context switch; defaults to `true`.
- `HOSHIA_NEWS_POST_ENABLED`: allows news topics to be used for automatic Hoshia timeline posts; defaults to `true`.
- `HOSHIA_NEWS_POST_DAILY_LIMIT`: maximum news-based Hoshia posts per day; defaults to `1`.
- `HOSHIA_NEWS_SIGNAL_TTL_HOURS`: how long a recent news signal can be considered fresh; defaults to `6`.
- `HOSHIA_NEWS_TOPIC_MAX_AGE_HOURS`: maximum age for news topics shown to Hoshia; defaults to `36`.
- `HOSHIA_ASYNC_COMMENT_REPLY_ENABLED`: enables delayed Hoshia timeline replies; defaults to `true`. Set it to `false` to pause automatic comment replies while keeping posting online.
- `HOSHIA_COMMENT_REPLY_TICK_LIMIT`: maximum replies processed in one reply tick; defaults to `2`.
- `HOSHIA_COMMENT_REPLY_DAILY_LIMIT`: maximum delayed timeline replies per day; defaults to `20`.
- AstrBot bridge news sources are configured in the AstrBot plugin, not in the gateway `.env`. Keep feed URLs, RSSHub routes, Tavily keys, and provider credentials only in private server-side config. The gateway only exposes short safe summaries, recent titles, topic counts, and whether news can be used as a light conversation hook.

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

### Hoshiaclaw Sidecar

Hoshiaclaw is designed to run side-by-side with the existing gateway as an internal Compose service. It is on the private `live_room_dev_network`, exposes port `8080` only to other containers, and has no host port by default.

Keep the default room mode as `AI_MODE=mock` until the sidecar image and gateway integration are ready. To test the sidecar path in an isolated environment:

```env
AI_MODE=hoshiaclaw
HOSHIACLAW_BRIDGE_URL=http://live-room-hoshiaclaw:8080/live-room/generate
HOSHIACLAW_TOKEN=<generated-internal-token>
```

Start the optional profile:

```bash
docker compose --profile hoshiaclaw up -d --build live-room-hoshiaclaw live-room-gateway live-room-web
```

To roll back from Hoshiaclaw without changing persisted room data, set `AI_MODE=mock` or the previous backend mode in the server `.env`, then restart only the affected services:

```bash
docker compose up -d live-room-gateway live-room-web
```

The sidecar runtime mounts `data/hoshiaclaw`, `logs/hoshiaclaw`, and `private/hoshiaclaw`. These paths are ignored by Git and are for local/server runtime state only. Do not store raw user transcripts, real model provider tokens, private URLs, SSH details, or tunnel information in committed files.

Local Hoshiaclaw verification:

```bash
cd services/hoshiaclaw
go test ./...
go vet ./...
```

If Go is not installed on the local machine, run the same checks through Docker from the repository root:

```bash
docker run --rm -v "$PWD/services/hoshiaclaw:/src" -w /src golang:1.22 sh -c "go test ./... && go vet ./..."
```

To test a real OpenAI-compatible model while keeping room traffic on the current backend, keep `AI_MODE` unchanged and only switch the sidecar provider in a private server `.env`:

```env
HOSHIACLAW_PROVIDER=openai_compatible
HOSHIACLAW_OPENAI_BASE_URL=https://opencode.ai/zen/go/v1
HOSHIACLAW_OPENAI_API_KEY=<provider-key-in-private-env>
HOSHIACLAW_OPENAI_MODEL=deepseek-v4-flash
```

Then restart `live-room-hoshiaclaw` and send shadow requests from inside the Compose network before changing `AI_MODE`.

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
npm run typecheck
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

## Deployment Traceability

The staging server deployment directory is a synchronized runtime tree, not a Git working tree. During deployment, write the source commit into a plain `REVISION` file before or during sync so the running code can be traced back without storing any server secrets:

```bash
git rev-parse HEAD > REVISION
```

Keep the server `.env`, `gateway/data`, and existing `docker-compose.yml` cloudflared tunnel settings when updating `/home/ubuntu/staging/live-room-dev`. After syncing code, rebuild and restart only the live-room services, then verify:

```bash
sudo docker compose build live-room-gateway live-room-web
sudo docker compose up -d live-room-redis live-room-gateway live-room-web live-room-tunnel
sudo docker compose ps
curl http://127.0.0.1:18888/live/healthz
```

Do not commit `REVISION`, server host details, SSH key paths, tunnel URLs, credentials, databases, or private runtime logs.

If a deployment using `AI_MODE=hoshiaclaw` fails, roll back by restoring the previous `.env` AI mode and restarting the gateway/web containers. If the compose file itself is the problem, restore the latest backup of the runtime tree while preserving the server `.env`, `gateway/data`, and tunnel-specific compose entries.

## AstrBot Bridge

`astrbot_plugin_live_room_bridge/` is optional. The gateway defaults to `AI_MODE=mock`, so the project can run without AstrBot.

To connect AstrBot:

1. Set `bridge_token` in the AstrBot plugin config.
2. Set the same value as `ASTRBOT_BRIDGE_TOKEN` in gateway `.env`.
3. Set `AI_MODE=astrbot`.
4. Set `ASTRBOT_BRIDGE_URL`, for example `http://astrbot:18081/live-room/generate`.

Do not install or restart production AstrBot without an explicit deployment window.

## Music Room Experiment

The music room is optional and disabled by default. When enabled, friends can request songs with `点歌 歌名`, `/song 歌名`, or `@Hoshia 点歌 歌名`. The gateway keeps the queue and proxies playback URLs through authenticated live-room endpoints.

For xiaomusic, keep account cookies, tokens, and plugin credentials only in xiaomusic's private config directory. Do not put QQ Music credentials in this repository, `.env.example`, frontend code, chat logs, or committed files.

Recommended private admin access:

```powershell
ssh -i <private-key-file> -L <local-port>:127.0.0.1:<remote-port> <user>@<server-host>
```

Then open the forwarded local admin URL in your browser and configure xiaomusic yourself. Do not commit real server hosts, SSH key paths, cookies, or provider tokens.

## Notes

- Current character visuals are PNG fallback assets, not a real Live2D model.
- Chat messages are stored in SQLite and the room state API returns the latest 100 messages.
- Newly registered users can complete a short Hoshia awakening onboarding flow. If they allow memory, the gateway stores a small AI preference profile in SQLite.
- Hoshia reads short batches of recent danmaku instead of replying to every message one by one. Messages that explicitly mention `@Hoshia`, `@星娅`, or `@主播` are prioritized, and targeted replies should start with `@nickname`.
- When a viewer who enabled memory explicitly mentions Hoshia, the AstrBot room prompt can use their saved preferred name, reply style, and interests without exposing the profile as chat text.
- The frontend includes an `@Hoshia` shortcut in the send bar, and history nicknames can be clicked to insert `@nickname`.
- When nobody mentions Hoshia, the AstrBot bridge can run a Heartflow-lite judge model before replying. The default judge provider is `tencentmaas/deepseek-v4-flash`; low-score batches are silently skipped so Hoshia does not over-speak.
- AstrBot replies use a shared room session (`<room_id>:room`) so the host has room-level context instead of separate one-on-one user sessions.
- When exactly one web account is online, the gateway can send `force_reply: true` so Hoshia replies to each message without requiring `@Hoshia`.
- The gateway sends AstrBot a short-term context layer: a rolling room summary plus the latest user/AI messages. Recent transcript has priority over the summary and LivingMemory when facts conflict.
- The AstrBot bridge can optionally connect to `astrbot_plugin_livingmemory`. Viewer memories are isolated by web account session (`live-room:<room_id>:user:<user_id>`) and require the viewer's memory consent; daily news memories use a separate `live-room:<room_id>:news` pool.
- LivingMemory viewer memories can include `recent_state` for relatively stable but temporary user context, such as what someone is busy with recently. These memories default to 30 days and are filtered after expiry.
- The bridge skips duplicate viewer memories, filters expired daily news memories, and exposes a token-protected internal debug recall endpoint for deployment checks.
- The bridge can maintain a daily Hoshia topic pool from self-hosted RSSHub feeds, optionally enriched by Tavily. The stored memories are short-lived topic cards with Hoshia's take and conversation starters, not raw articles or search result dumps.
- Hoshia's news module context is safety-trimmed before it reaches the prompt. It may include enabled/running state, refresh stage, topic count, recent public titles, and a short recent signal, but it must not include URLs, tokens, `.env` content, local paths, internal addresses, RSSHub private routes, Tavily keys, or raw feed/search payloads.
- Only final runtime assets should be committed. Generated green-screen/chroma images and temporary screenshots are ignored.
- `tmp/`, `frontend/dist/`, `node_modules/`, logs, and caches are ignored.
- The layout is intentionally split into Stage, Overlay, and Control so future Live2D, TTS, gifts, and avatar systems can be connected without rewriting the whole page.
