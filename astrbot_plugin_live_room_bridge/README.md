# astrbot_plugin_live_room_bridge

Internal AstrBot bridge for `live-room-dev`.

## Behavior

- Binds an internal HTTP endpoint, default `0.0.0.0:18081`.
- Accepts `POST /live-room/generate` for live-room replies, `POST /live-room/context/summarize` for rolling short-term context summaries, `POST /live-room/news` for optional daily news memory ingestion, `POST /live-room/capabilities/news/refresh` and `POST /live-room/capabilities/news/status` for the RSS topic-card refresh loop, `POST /live-room/capabilities/news/topics` for safe topic-card reads, and `POST /live-room/memory/debug-recall` for internal memory checks.
- Requires `Authorization: Bearer <bridge_token>`.
- Calls `context.llm_generate()` with the current AstrBot provider for the supplied live-room session.
- Skips the proactive reply judge when the gateway sends `force_reply: true` for single-viewer direct replies.
- Can optionally recall and write `astrbot_plugin_livingmemory` memories, isolated by web viewer account.
- Injects gateway-provided short-term context with priority: recent transcript, then earlier summary, then LivingMemory.
- Skips duplicate viewer memories before writing, filters expired recent-state viewer memories, and filters or deletes expired daily news memories.
- Can optionally maintain a short-lived news topic pool by pulling configured RSSHub/RSS feeds, selectively enriching unclear topics with Tavily, asking AstrBot to turn them into Hoshia-style conversation cards, and writing them to the isolated LivingMemory news session. Topic cards include short safe fields such as meme hooks, reaction style, state signal, post seed, and reply hooks.
- Returns only reply text, state, source, and latency. It never returns provider URLs or internal service addresses.

## Role Boundary

Engineering-side names such as AstrBot, gateway, live-room, module, event, LivingMemory, endpoint, provider, and field names are allowed in this README and in internal logs/configuration. They are not part of Hoshia's role-visible identity.

Prompts sent to Hoshia should describe only what she can naturally know: recent chat, current room state, viewer preferences, topic inspiration, music state, and safe behavior signals. Do not expose backend component names, JSON field names, tokens, paths, IPs, provider URLs, or configuration details in role-facing prompt text.

## Config

Set `bridge_token` in the plugin config to the same value as gateway `.env` `ASTRBOT_BRIDGE_TOKEN`.

LivingMemory integration is disabled by default. Enable it with `livingmemory_enabled` only after the LivingMemory plugin is installed and its data directory is backed up. Viewer memories use `live-room:<room_id>:user:<user_id>` sessions, and daily news uses `live-room:<room_id>:news`. Temporary `recent_state` memories default to 30 days. The debug recall endpoint requires the same bearer token and is intended only for internal deployment checks.

News topic refresh is also disabled by default. To enable it, configure:

- `news_capability_enabled=true`
- `news_refresh_enabled=true`
- `news_room_id=<gateway ROOM_ID>`
- `news_source_urls=http://rsshub:1200/...,http://rsshub:1200/...`
- `tavily_api_key=<server-private key>` if background search should be used

The scheduler runs inside the AstrBot bridge, not the gateway. It writes short-lived topic cards to LivingMemory as `source=daily_news`; it does not store raw articles, long URLs, cookies, tokens, or RSSHub private route credentials. If RSSHub, Tavily, or LivingMemory is unavailable, the refresh is skipped and normal live-room chat continues.

Safe topic-card reads use:

```text
POST /live-room/capabilities/news/topics
Authorization: Bearer <bridge_token>

{"room_id":"private-pixel-live","limit":8}
```

The response only returns whitelisted card fields: `date`, `title`, `category`, `what_happened`, `why_it_matters`, `hoshia_take`, `conversation_starter`, `meme_hooks`, `reaction_style`, `state_signal`, `post_seed`, `reply_hooks`, `risk_note`, and `tags`. It does not return RSSHub URLs, Tavily keys, original article links, internal addresses, local paths, or raw logs.

Default endpoint for the gateway:

```text
http://astrbot:18081/live-room/generate
```

## Safety

Do not install into production AstrBot or restart AstrBot without an explicit deployment confirmation. The live-room gateway defaults to `AI_MODE=mock`, so this plugin is not required for the sidecar to run.
