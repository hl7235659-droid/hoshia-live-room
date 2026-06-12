import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAiReplySentEvent,
  projectCharacterEvent,
  projectMusicControlEvent,
  projectMusicSongRequestedEvent,
  projectTimelineCommentReplyEvent,
  projectTimelinePostCreatedEvent,
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

test("music control projector records safe control metadata", () => {
  const next = projectMusicControlEvent({}, {
    event_type: "module.music.control",
    event_id: "evt-control",
    occurred_at: "2026-06-12T02:10:00.000Z",
    data_json: JSON.stringify({
      action: "pause",
      status: "done",
      raw_prompt: "should not be read"
    })
  });

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-control"]);
  assert.deepEqual(next.public.recent.last_music_control, {
    action: "pause",
    status: "done",
    controlled_at: "2026-06-12T02:10:00.000Z"
  });
  assert.equal(next.public.recent.raw_prompt, undefined);
  assert.equal(next.internal.derived.last_music_event_id, "evt-control");
});

test("visual state projector updates public expression and stage suggestion", () => {
  const next = projectCharacterEvent({}, {
    event_type: "hoshia_visual_state.changed",
    event_id: "evt-visual",
    source_kind: "hoshia_visual_state",
    occurred_at: "2026-06-12T02:20:00.000Z",
    data_json: JSON.stringify({
      mood: "happy",
      activity: "chatting",
      source: "chat",
      path: "C:\\secret\\state.json"
    })
  });

  assert.equal(next.public.expression.mood, "happy");
  assert.equal(next.public.expression.activity, "chatting");
  assert.deepEqual(next.public.recent.last_visual_state_change, {
    mood: "happy",
    activity: "chatting",
    source: "chat",
    changed_at: "2026-06-12T02:20:00.000Z"
  });
  assert.equal(next.public.stage.presentation_suggestion.source, "character_snapshot");
  assert.equal(next.public.recent.last_visual_state_change.path, undefined);
  assert.equal(next.internal.derived.last_visual_event_id, "evt-visual");
});

test("timeline post projector records daily activity without raw post body", () => {
  const next = projectTimelinePostCreatedEvent({}, {
    event_type: "hoshia_timeline.post_created",
    event_id: "evt-post",
    occurred_at: "2026-06-12T03:00:00.000Z",
    data_json: JSON.stringify({
      activity: "studying",
      mood: "calm",
      source_type: "daily_state",
      raw_response: "full post body"
    })
  });

  assert.equal(next.public.today.last_activity, "studying");
  assert.deepEqual(next.public.recent.last_timeline_post, {
    activity: "studying",
    mood: "calm",
    source_type: "daily_state",
    posted_at: "2026-06-12T03:00:00.000Z"
  });
  assert.equal(next.public.recent.last_timeline_post.raw_response, undefined);
  assert.equal(next.internal.derived.last_daily_event_id, "evt-post");
});

test("timeline comment projector records pending and replied status safely", () => {
  const pending = projectTimelineCommentReplyEvent({}, {
    event_type: "hoshia_timeline.comment_reply_pending",
    event_id: "evt-comment-pending",
    occurred_at: "2026-06-12T03:10:00.000Z",
    data_json: JSON.stringify({
      activity: "gaming",
      status: "pending",
      comment_text: "raw comment"
    })
  });
  const replied = projectCharacterEvent(pending, {
    event_type: "hoshia_timeline.comment_replied",
    event_id: "evt-comment-replied",
    occurred_at: "2026-06-12T03:20:00.000Z",
    data_json: JSON.stringify({
      activity: "gaming",
      status: "replied",
      raw_response: "raw reply"
    })
  });

  assert.deepEqual(replied.internal.derived.last_applied_event_ids, ["evt-comment-pending", "evt-comment-replied"]);
  assert.deepEqual(replied.public.recent.last_comment_reply, {
    status: "replied",
    activity: "gaming",
    updated_at: "2026-06-12T03:20:00.000Z"
  });
  assert.equal(replied.public.recent.last_comment_reply.raw_response, undefined);
  assert.equal(replied.internal.derived.last_comment_event_id, "evt-comment-replied");
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
    },
    {
      event_type: "module.music.control",
      event_id: "evt-control",
      occurred_at: "2026-06-12T01:03:00.000Z",
      data_json: JSON.stringify({ action: "next", status: "done" })
    }
  ];
  const next = events.reduce((snapshot, event) => projectCharacterEvent(snapshot, event), {});

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-user", "evt-ai", "evt-music", "evt-control"]);
  assert.equal(next.public.explain.updated_at, "2026-06-12T01:03:00.000Z");
  assert.equal(next.public.recent.last_ai_reply_route, "smalltalk");
  assert.equal(next.public.recent.last_music_request.title, "Demo Song");
  assert.equal(next.public.recent.last_music_control.action, "next");
});
