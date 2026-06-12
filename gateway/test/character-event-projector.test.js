import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAiReplySentEvent,
  projectCharacterEvent,
  projectMusicSongRequestedEvent,
  projectUserMessageReceivedEvent
} from "../src/character-event-projector.js";

test("user message projector appends event id and updates public explain timestamp", () => {
  const snapshot = {
    snapshot_id: "snap-1",
    public: {
      explain: {
        state_reason: "existing",
        updated_at: "2026-06-12T00:00:00.000Z"
      }
    },
    internal: {
      derived: {
        selected_asset_rule: "legacy_visual_state",
        last_applied_event_ids: ["evt-old"],
        conflict_flags: []
      }
    }
  };
  const next = projectUserMessageReceivedEvent(snapshot, {
    event_type: "user.message_received",
    event_id: "evt-new",
    occurred_at: "2026-06-12T01:00:00.000Z",
    public_hint: "viewer said hello"
  });

  assert.notEqual(next, snapshot);
  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-old", "evt-new"]);
  assert.equal(next.public.explain.updated_at, "2026-06-12T01:00:00.000Z");
  assert.equal(next.public.explain.state_reason, "existing");
  assert.deepEqual(snapshot.internal.derived.last_applied_event_ids, ["evt-old"]);
});

test("user message projector falls back safely when snapshot fields are missing", () => {
  const next = projectUserMessageReceivedEvent({}, {
    event_type: "user.message_received",
    idempotency_key: "room:user.message_received:msg-1"
  });

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["room:user.message_received:msg-1"]);
  assert.equal(next.public.explain.updated_at, "");
});

test("user message projector deduplicates event ids and keeps only recent metadata", () => {
  const existingIds = Array.from({ length: 20 }, (_, index) => `evt-${index}`);
  const next = projectUserMessageReceivedEvent(
    {
      public: { explain: { updated_at: "2026-06-12T00:00:00.000Z" } },
      internal: { derived: { last_applied_event_ids: existingIds } }
    },
    {
      event_type: "user.message_received",
      event_id: "evt-19",
      occurred_at: "2026-06-12T02:00:00.000Z"
    }
  );

  assert.equal(next.internal.derived.last_applied_event_ids.length, 20);
  assert.equal(next.internal.derived.last_applied_event_ids.at(-1), "evt-19");
});

test("generic character projector returns a cloned no-op snapshot for unknown events", () => {
  const snapshot = {
    public: { explain: { updated_at: "2026-06-12T00:00:00.000Z" } },
    internal: { derived: { last_applied_event_ids: ["evt-old"] } }
  };
  const next = projectCharacterEvent(snapshot, {
    event_type: "module.unknown",
    event_id: "evt-new",
    occurred_at: "2026-06-12T01:00:00.000Z"
  });

  assert.notEqual(next, snapshot);
  assert.deepEqual(next, snapshot);
});

test("ai reply projector records safe reply metadata without raw text", () => {
  const next = projectAiReplySentEvent({
    public: { explain: { updated_at: "2026-06-12T00:00:00.000Z" } },
    internal: { derived: { last_applied_event_ids: ["evt-old"] } }
  }, {
    event_type: "ai.reply_sent",
    event_id: "evt-ai",
    occurred_at: "2026-06-12T01:00:00.000Z",
    reason: "smalltalk",
    data_json: JSON.stringify({
      route: "smalltalk",
      source_type: "openai_compatible",
      raw_response: "should not be read"
    })
  });

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-old", "evt-ai"]);
  assert.equal(next.public.explain.updated_at, "2026-06-12T01:00:00.000Z");
  assert.equal(next.public.recent.last_ai_reply_at, "2026-06-12T01:00:00.000Z");
  assert.equal(next.public.recent.last_ai_reply_route, "smalltalk");
  assert.equal(next.public.recent.last_ai_reply_source, "openai_compatible");
  assert.equal(next.public.recent.raw_response, undefined);
  assert.equal(next.internal.derived.last_ai_reply_event_id, "evt-ai");
});

test("music song projector records short safe song metadata", () => {
  const next = projectMusicSongRequestedEvent({}, {
    event_type: "module.music.song_requested",
    event_id: "evt-music",
    occurred_at: "2026-06-12T02:00:00.000Z",
    data_json: JSON.stringify({
      title: "Demo Song",
      artist: "Alice",
      source_type: "musicfree",
      token: "secret",
      url: "https://example.test/song"
    })
  });

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-music"]);
  assert.deepEqual(next.public.recent.last_music_request, {
    title: "Demo Song",
    artist: "Alice",
    requested_at: "2026-06-12T02:00:00.000Z"
  });
  assert.equal(next.public.recent.last_music_request.token, undefined);
  assert.equal(next.public.recent.last_music_request.url, undefined);
  assert.equal(next.internal.derived.last_music_event_id, "evt-music");
});

test("generic projector applies mixed event types in order", () => {
  const events = [
    {
      event_type: "user.message_received",
      event_id: "evt-user",
      occurred_at: "2026-06-12T01:00:00.000Z"
    },
    {
      event_type: "ai.reply_sent",
      event_id: "evt-ai",
      occurred_at: "2026-06-12T01:01:00.000Z",
      data_json: JSON.stringify({ route: "smalltalk", source_type: "openai_compatible" })
    },
    {
      event_type: "module.music.song_requested",
      event_id: "evt-music",
      occurred_at: "2026-06-12T01:02:00.000Z",
      data_json: JSON.stringify({ title: "Demo Song", artist: "Alice" })
    }
  ];
  const next = events.reduce((snapshot, event) => projectCharacterEvent(snapshot, event), {});

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-user", "evt-ai", "evt-music"]);
  assert.equal(next.public.explain.updated_at, "2026-06-12T01:02:00.000Z");
  assert.equal(next.public.recent.last_ai_reply_route, "smalltalk");
  assert.equal(next.public.recent.last_music_request.title, "Demo Song");
});
