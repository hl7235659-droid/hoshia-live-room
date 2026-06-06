# astrbot_plugin_live_room_bridge

Internal AstrBot bridge for `live-room-dev`.

## Behavior

- Binds an internal HTTP endpoint, default `0.0.0.0:18081`.
- Accepts only `POST /live-room/generate`.
- Requires `Authorization: Bearer <bridge_token>`.
- Calls `context.llm_generate()` with the current AstrBot provider for the supplied live-room session.
- Returns only reply text, state, source, and latency. It never returns provider URLs or internal service addresses.

## Config

Set `bridge_token` in the plugin config to the same value as gateway `.env` `ASTRBOT_BRIDGE_TOKEN`.

Default endpoint for the gateway:

```text
http://astrbot:18081/live-room/generate
```

## Safety

Do not install into production AstrBot or restart AstrBot without an explicit deployment confirmation. The live-room gateway defaults to `AI_MODE=mock`, so this plugin is not required for the sidecar to run.
