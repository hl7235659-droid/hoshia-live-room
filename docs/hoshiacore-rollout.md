# HoshiaCore Staging to Production Rollout

This checklist keeps HoshiaCore rollout separate from new feature rollout.

## Staging baseline

- `AI_MODE=hoshiaclaw`
- `CHARACTER_STATE_AUTHORITY=event_log`
- `HOSHIA_COMMENT_REPLY_ROLLOUT_MODE=off`
- `HOSHIACLAW_DAILY_POST_SHADOW_ENABLED=false`
- `HOSHIACLAW_NEWS_TOPIC_GENERATE_SHADOW_ENABLED=false`
- `HOSHIACLAW_PROACTIVE_LIVE_ENABLED=false`
- Verify ordinary WebSocket replies include `ai_reply`, `ai_reply_done`, and `hoshia_presentation`.

## Production phase 1

- Switch only the target production room or instance to `AI_MODE=hoshiaclaw`.
- Keep the current stable `CHARACTER_STATE_AUTHORITY` value unless staging event-log authority has been verified in the same build.
- Keep comment, daily post, news topic, and proactive live takeover disabled.
- Watch provider success, skip, failed, fallback count, presentation count, and snapshot age.
- Treat phase 1 as stable only when `hoshia_core_provider_failed` and `astrbot_fallback_count` are not increasing, ordinary WebSocket replies still emit `ai_reply_done` and `hoshia_presentation`, and recent logs do not contain panic/fatal markers or raw prompt/response leaks.
- Snapshot reducer expansions during phase 1 may add safe recent activity fields, but must not enable comment, daily post, news topic, or proactive live takeover.

## Production phase 2

- After phase 1 is stable, switch `CHARACTER_STATE_AUTHORITY=event_log` for the same target room or instance.
- Verify `/api/hoshia/state`, `/api/hoshia/snapshot`, ordinary WebSocket replies, and snapshot event id progress.
- Keep comment, daily post, news topic, and proactive live takeover disabled.

## Rollback

- Reply failures: set `AI_MODE=astrbot` and restart gateway/web.
- HoshiaCore provider failures: set `HOSHIACLAW_PROVIDER=fake` or disable the active live/shadow switch.
- Event-log authority failures: set `CHARACTER_STATE_AUTHORITY=legacy` and restart gateway.
- Presentation failures: rely on the frontend fallback from `character_state` / `hoshia_state`; do not modify database state.

Do not store or paste `.env`, tokens, provider URLs, raw prompts, raw responses, or internal paths in rollout notes.
