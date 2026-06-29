---
name: hoshia-module-integration
description: Use when adding or updating Hoshia Live Room modules such as music, news, gifts, Live2D, TTS, or games that need Hoshia to understand module state, attribute user actions, or extract safe preference memories through module_context, module_events, module_memory_events, and module providers.
---

# Hoshia Module Integration

Use this skill whenever a Hoshia Live Room module should become visible to Hoshia or feed user preference memory.

## Required workflow

1. Check `git status --short --branch` before editing and keep unrelated changes isolated.
2. Do not commit `.env`, databases, `node_modules`, `dist`, logs, caches, keys, tokens, certificates, or credentials.
3. Add modules through a lightweight provider instead of hard-coding new prompt branches.
4. Run `gateway: npm test` and `frontend: npm run build` before committing.

## Provider contract

Each module that Hoshia should understand should expose a provider with:

```js
{
  moduleId: "music",
  getCapabilityContext(session) {
    return {
      module_id: "music",
      enabled: true,
      current_state: ["当前播放：...", "待播 3 首"],
      capabilities: ["观众可点歌", "可查看当前播放和队列"],
      limits: ["只能基于当前队列和最近事件回答"]
    };
  }
}
```

Keep provider context safe and public-facing. It may describe current module state and capabilities, but must not include internal paths, server IPs, provider URLs, tokens, credentials, `.env` values, database paths, SSH data, or raw logs.

## Module events

User-visible module actions should emit sanitized events:

```json
{
  "module_id": "music",
  "event_type": "music.song_requested",
  "user_id": "user-003",
  "nickname": "003",
  "summary_hint": "003 点了 Purple Rain - Prince",
  "memory_eligible": true,
  "memory_kind": "music_preference_candidate",
  "retention_days": 30,
  "data": { "title": "Purple Rain", "artist": "Prince", "source": "musicfree" }
}
```

- `module_events` are recent events for the current reply context. They must not be consumed.
- `module_memory_events` are unprocessed `memory_eligible=true` candidates for LivingMemory summarization. They should be consumed once and restored if the AstrBot reply is skipped or falls back before memory can be written.
- `data` must be a short-text whitelist. For music, use only `title`, `artist`, and `source` unless the bridge is updated to sanitize more fields.

## Memory rules

Store purified preferences, not event logs.

- A single song, gift, click, TTS request, or game action usually does not become long-term memory.
- Repeated similar behavior or an explicit request like “我喜欢/记住” may become a compact `recent_state` or stable `preference`.
- Music memories should summarize style, era, artists, and mood, not full song history.
- Example good memory: `003 最近常点复古流行、经典摇滚和 Prince/The Who/Michael Jackson 这类老派电台感歌曲。`
- Example bad memory: `003 点了 Purple Rain、Baba O'Riley、Billie Jean...`

## Music template

For music changes, keep this behavior:

- Successful song requests emit `music.song_requested` with requester attribution.
- Capability context includes current track, queue, requester, capabilities, and limits.
- Hoshia may evaluate the current queue, but must not claim access to the full music library or hidden provider data.