# astrbot_plugin_live_room_bridge

Internal AstrBot bridge for `live-room-dev`.

## Behavior

- Binds an internal HTTP endpoint, default `0.0.0.0:18081`.
- Accepts `POST /live-room/generate` for live-room replies and `POST /live-room/news` for optional daily news memory ingestion.
- Requires `Authorization: Bearer <bridge_token>`.
- Calls `context.llm_generate()` with the current AstrBot provider for the supplied live-room session.
- Skips the proactive reply judge when the gateway sends `force_reply: true` for single-viewer direct replies.
- Can optionally recall and write `astrbot_plugin_livingmemory` memories, isolated by web viewer account.
- Returns only reply text, state, source, and latency. It never returns provider URLs or internal service addresses.

## Config

Set `bridge_token` in the plugin config to the same value as gateway `.env` `ASTRBOT_BRIDGE_TOKEN`.

LivingMemory integration is disabled by default. Enable it with `livingmemory_enabled` only after the LivingMemory plugin is installed and its data directory is backed up. Viewer memories use `live-room:<room_id>:user:<user_id>` sessions, and daily news uses `live-room:<room_id>:news`.

Default endpoint for the gateway:

```text
http://astrbot:18081/live-room/generate
```

## Safety

Do not install into production AstrBot or restart AstrBot without an explicit deployment confirmation. The live-room gateway defaults to `AI_MODE=mock`, so this plugin is not required for the sidecar to run.
