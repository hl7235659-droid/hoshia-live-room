# Live Room 2.0 Frontend Plan

The 2.0 goal is to upgrade the MVP room into a mobile-first Hoshia live room while keeping the implementation easy to extend.

## Scope

- Mobile-first Hoshia stage.
- Stable mapping from room state to character expression and motion.
- PNG/CSS fallback before a real Live2D model is available.
- Danmaku, history, input, online count, and connection state driven by the current gateway/WebSocket.
- No full TTS, account/avatar system, gift system, or multi-room admin in this phase.

## Page Layers

```text
LiveMobile
├── Stage
│   ├── Background
│   ├── Hoshia fallback / Live2DAdapter
│   └── Floating danmaku
├── Overlay
│   ├── Room title
│   ├── Private lock / online count / connection status
│   └── Character state hint
└── Control
    ├── History drawer
    ├── Input dock
    └── Send / local state trigger
```

## State Mapping

| State | Expression | Motion | Use |
| --- | --- | --- | --- |
| `IDLE` | `idle_smile` | `idle_loop` | Waiting |
| `LISTENING` | `listening` | `listen_start` | Local state after user sends |
| `THINKING` | `thinking` | `think_loop` | Waiting for AI reply |
| `SPEAKING` | `speaking` | `speak_loop` | AI reply is shown |
| `ERROR` | `error` | `error_recover` | Gateway, connection, or bridge issue |

Future events:

- `FRIEND_JOINED`: welcome or wave motion.
- `ACTIVE_CHAT`: happy reaction when danmaku is active.
- `AFK_IDLE`: softer idle motion after long silence.

## Mobile Layout Rules

- Keep Hoshia as the first-viewport visual focus.
- Avoid placing UI over the face, ears, or main expression.
- Keep the input dock stable at the bottom with safe-area spacing.
- Let danmaku pass behind the character instead of using heavy message boxes.
- Show privacy and connection status clearly, but avoid technical wording.

## Acceptance Points

- `npm run build` passes.
- Stage renders with PNG fallback when no Live2D model exists.
- Sending a message locally enters `LISTENING` before backend response.
- Backend room state can drive `IDLE`, `LISTENING`, `THINKING`, `SPEAKING`, and `ERROR`.
- 360px to 430px mobile widths avoid obvious overlap between title, character, danmaku, history, and input.

## Next Steps

1. Connect a real Live2D runtime inside `Live2DAdapter`.
2. Add TTS queue and bind `SPEAKING` to audio playback state.
3. Add account/avatar support so the login preview can show friends inside.
4. Add gift/action events without breaking the Stage/Overlay/Control layout.
