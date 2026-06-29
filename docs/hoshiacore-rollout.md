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

## Character snapshot and memory phases

- Phase 3 snapshot expansion only projects sanitized `character_events` into `character_snapshots`; it must not write legacy `hoshia_state`.
- Safe snapshot activity may include music, timeline, news, daily/shadow, proactive, pixel game, interest, and module memory summaries.
- Snapshot fields must remain short public/private summaries and must not contain raw chat, prompt, response, candidate text, URLs, tokens, credentials, server paths, or internal addresses.
- Phase 4 memory intake uses sanitized `module_memory_events` as the local entry point and records only purified preferences, habits, commitments, or recent-state summaries.
- A single weak action should be skipped or kept short term; stable repeated signals or explicit remember/like/preference wording may become a longer-lived memory.
- Memory failures must not block live replies, broadcast fake replies, write room messages, or enable comment, daily post, news topic, or proactive live takeover.

## Production phase 5 observability and deployment gates

Phase 5 is an observability/docs/deployment-gate phase. It does not open new live takeovers by default.

1. Deploy the build with all live takeover switches still closed:
   - `HOSHIA_COMMENT_REPLY_ROLLOUT_MODE=off`
   - `HOSHIACLAW_PROACTIVE_LIVE_ENABLED=false`
   - `HOSHIACLAW_PROACTIVE_LIVE_PERCENT=0`
   - `HOSHIACLAW_DAILY_POST_LIVE_ENABLED=false`
   - `HOSHIACLAW_NEWS_TOPIC_LIVE_ENABLED=false`
   - Keep daily post and news topic on the existing stable path until their own later rollout window.
2. Confirm `/healthz` exposes both the existing aggregate shadow counters and route-level counters:
   - `proactive_live_success|skip|failed`
   - `comment_reply_live_success|skip|failed`
   - `daily_post_live_success|skip|failed`
   - `news_topic_live_success|skip|failed`
   - `proactive_shadow_*`, `comment_reply_shadow_*`, `daily_post_shadow_*`, `news_topic_shadow_*`
3. Preserve shadow checks while watching `shadow_success`, `shadow_skip`, and `shadow_failed`; route-level shadow counters are additive and must not replace the existing aggregate shadow metrics.
4. Before opening any single live takeover, verify the target route's success/skip/failed counters remain understandable in `/healthz` and do not include prompt text, candidate text, URLs, tokens, server paths, or internal addresses.
5. Open only one live route at a time, with the smallest switch possible:
   - Proactive live: set `HOSHIACLAW_PROACTIVE_LIVE_ENABLED=true` and start with a very low `HOSHIACLAW_PROACTIVE_LIVE_PERCENT`.
   - Comment replies: move `HOSHIA_COMMENT_REPLY_ROLLOUT_MODE` from `off` to `shadow` first, then to `live` only after shadow metrics are stable.
   - Daily post live: keep `HOSHIACLAW_DAILY_POST_LIVE_ENABLED=false` until daily shadow is stable, then enable it in a separate rollout window.
   - News topic live: keep `HOSHIACLAW_NEWS_TOPIC_LIVE_ENABLED=false` until news shadow is stable, then enable it last in a separate rollout window.
6. Keep a short observation window after each switch. Do not open another route while the current route's `*_failed` counter is increasing or logs show unsafe content.

### Phase 5 sensitive log scan

After deployment and after each rollout switch, scan recent gateway logs and rollout notes for sensitive markers before sharing results:

- Forbidden markers: `.env`, `token`, `secret`, `bearer`, provider URLs, tunnel URLs, raw prompts, raw responses, candidate text, local/server absolute paths, SSH details, internal addresses.
- Safe summary style: use route names, statuses, counts, and sanitized reasons only.
- If sensitive data appears in logs, stop rollout, rotate/replace affected secrets if needed, and summarize only the remediation status without pasting the sensitive value.

## Production phase 6 AstrBot downgrade preparation

Phase 6 starts only after main replies, event-log state, local memory intake, and Phase 5 live routes are stable on HoshiaClaw. This phase prepares AstrBot to become a backup rollback path; it does not delete AstrBot code, bridge config, tests, or deployment files.

- Default role: HoshiaClaw owns ordinary WebSocket replies, presentation/state projection, local sanitized memory intake, proactive live, comment live, daily post live, and news topic live.
- AstrBot role: keep AstrBot available as an emergency rollback provider only. Do not use AstrBot as the only trigger for module memory processing, and do not rely on AstrBot success for `module_memory_events` to become purified local memories.
- Stability gate: enter deeper AstrBot downgrade only when `/live/healthz` shows `hoshia_core_provider_failed` and `astrbot_fallback_count` are not increasing, route-level `*_failed` counters are not increasing, `module_memory_pending` is not piling up, and `character_snapshot_age_ms` is understandable for the room state.
- Rollback gate: if HoshiaClaw bridge errors, provider failures, unsafe logs, or live route failures recur, stop Phase 6 changes and use the rollback switches below instead of deleting data or editing server-only config.
- Documentation rule: rollout notes may mention route names, statuses, counts, and sanitized reasons only. Never paste `.env`, tokens, provider URLs, raw prompts, raw responses, generated candidate text, server paths, tunnel details, or internal addresses.

### Phase 6 validation checklist

- Confirm `AI_MODE=hoshiaclaw` and `CHARACTER_STATE_AUTHORITY=event_log` for the target environment.
- Confirm `/live/healthz` exposes `hoshia_core_provider_success|skip|failed`, `astrbot_fallback_count`, `module_memory_pending`, `character_snapshot_age_ms`, and route-level live/shadow counters.
- Confirm module memory uses the local sanitized memory service after successful main replies, and pending memory events are restored when a reply is skipped or fails.
- Confirm AstrBot bridge tests and rollback docs remain in the repository.
- Do not remove AstrBot env keys, plugin files, fallback code paths, or server rollback instructions during this preparation step.

## Character Core final convergence

The final target is not replacing AstrBot with another model API. HoshiaClaw is the Character Core: the unified center for persona, state, memory, reply decisions, and stage presentation. Gateway remains a context wrapper, safety normalizer, event store, and rollback coordinator.

- Unified persona: HoshiaClaw is the reply authority. Gateway may pass the Hoshia persona constitution and scene context, but new features must not create separate persona branches that override the Character Core boundary.
- Unified state: `character_events` remains the replayable fact source, and `character_snapshots` remains the derived read model. Do not write new live state directly into legacy `hoshia_state`.
- Unified memory: memory intake must store purified preferences, commitments, habits, or recent-state summaries only. Do not store raw chat, raw comments, prompts, responses, generated candidates, provider payloads, URLs, tokens, paths, or internal addresses.
- Unified reply decisions: ordinary WebSocket replies, proactive live, comment live, daily post live, and news topic live must use HoshiaClaw when `AI_MODE=hoshiaclaw`. AstrBot remains only an emergency rollback provider through `AI_MODE=astrbot`.
- Unified presentation: HoshiaClaw presentation envelopes must pass through the gateway whitelist normalizer before frontend broadcast. Routes that do not need stage motion may omit presentation, but they must not emit unnormalized presentation data.

## Rollback

- Reply failures after Phase 6 preparation: set `AI_MODE=astrbot` only as an emergency rollback provider, then restart gateway/web.
- HoshiaCore provider failures: set `HOSHIACLAW_PROVIDER=fake` or disable the active live/shadow switch.
- Event-log authority failures: set `CHARACTER_STATE_AUTHORITY=legacy` and restart gateway.
- Presentation failures: rely on the frontend fallback from `character_state` / `hoshia_state`; do not modify database state.
- Proactive live failures: set `HOSHIACLAW_PROACTIVE_LIVE_ENABLED=false` and `HOSHIACLAW_PROACTIVE_LIVE_PERCENT=0`, then restart gateway.
- Comment live failures: set `HOSHIA_COMMENT_REPLY_ROLLOUT_MODE=off` or back to `shadow`, then restart gateway.
- Daily/news route failures: set `HOSHIACLAW_DAILY_POST_LIVE_ENABLED=false` or `HOSHIACLAW_NEWS_TOPIC_LIVE_ENABLED=false`; if needed also disable the relevant shadow flag or scheduler while keeping main replies unaffected.
- Observability/log safety failures: close the active route switch first, preserve aggregate shadow metrics for comparison, and run the sensitive log scan before continuing.

Do not store or paste `.env`, tokens, provider URLs, raw prompts, raw responses, or internal paths in rollout notes.
