import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAiReplySentEvent,
  projectCharacterEvent,
  projectHoshiaClawProactiveActivityEvent,
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

test("proactive activity projector records live and shadow status without raw candidate text", () => {
  const shadow = projectHoshiaClawProactiveActivityEvent({}, {
    event_type: "hoshiaclaw.proactive_shadow.skip",
    event_id: "evt-proactive-shadow",
    source_kind: "hoshiaclaw",
    occurred_at: "2026-06-12T04:00:00.000Z",
    data_json: JSON.stringify({
      status: "skip",
      route: "proactive_idle_shadow",
      source_type: "gateway",
      candidate_text: "raw candidate should not persist",
      raw_prompt: "hidden"
    })
  });
  const live = projectCharacterEvent(shadow, {
    event_type: "hoshiaclaw.proactive_live.success",
    event_id: "evt-proactive-live",
    source_kind: "hoshiaclaw",
    occurred_at: "2026-06-12T04:05:00.000Z",
    data_json: JSON.stringify({
      status: "success",
      route: "proactive_idle_live",
      source_type: "openai_compatible",
      raw_response: "full reply should not persist"
    })
  });

  assert.deepEqual(live.internal.derived.last_applied_event_ids, ["evt-proactive-shadow", "evt-proactive-live"]);
  assert.deepEqual(live.public.recent.last_proactive_activity, {
    status: "success",
    route: "proactive_idle_live",
    source_type: "openai_compatible",
    updated_at: "2026-06-12T04:05:00.000Z"
  });
  assert.equal(live.public.recent.last_proactive_activity.candidate_text, undefined);
  assert.equal(live.public.recent.last_proactive_activity.raw_response, undefined);
  assert.equal(live.internal.derived.last_proactive_event_id, "evt-proactive-live");
});

test("news event projector records safe topic activity without raw payloads", () => {
  const next = projectCharacterEvent({}, {
    event_type: "hoshia_news.topic_post_created",
    event_id: "evt-news-topic",
    source_kind: "hoshia_news",
    occurred_at: "2026-06-12T05:00:00.000Z",
    reason: "news_topic_post",
    data_json: JSON.stringify({
      status: "observed",
      source_type: "news_topic",
      topic: "safe public topic",
      raw_response: "full generated post should not persist",
      url: "https://example.test/news"
    })
  });

  assert.deepEqual(next.internal.derived.last_applied_event_ids, ["evt-news-topic"]);
  assert.equal(next.public.today.last_activity, "news_topic");
  assert.deepEqual(next.public.recent.last_news_activity, {
    event_type: "hoshia_news.topic_post_created",
    status: "observed",
    source_type: "news_topic",
    topic: "safe public topic",
    updated_at: "2026-06-12T05:00:00.000Z"
  });
  assert.equal(next.public.recent.last_news_activity.raw_response, undefined);
  assert.equal(next.public.recent.last_news_activity.url, undefined);
  assert.equal(next.internal.derived.last_news_event_id, "evt-news-topic");
});

test("daily and news shadow projector records safe observation metadata", () => {
  const daily = projectCharacterEvent({}, {
    event_type: "hoshiaclaw.daily_post_shadow.skip",
    event_id: "evt-daily-shadow",
    source_kind: "hoshiaclaw",
    occurred_at: "2026-06-12T05:10:00.000Z",
    data_json: JSON.stringify({
      status: "skip",
      route: "daily_post_shadow",
      source_type: "gateway",
      candidate_text: "hidden draft"
    })
  });
  const news = projectCharacterEvent(daily, {
    event_type: "hoshiaclaw.news_topic_generate_shadow.failed",
    event_id: "evt-news-shadow",
    source_kind: "hoshiaclaw",
    occurred_at: "2026-06-12T05:20:00.000Z",
    data_json: JSON.stringify({
      status: "failed",
      route: "news_topic_generate_shadow",
      source_type: "gateway",
      raw_prompt: "hidden prompt"
    })
  });

  assert.deepEqual(news.internal.derived.last_applied_event_ids, ["evt-daily-shadow", "evt-news-shadow"]);
  assert.deepEqual(news.public.recent.last_shadow_activity, {
    status: "failed",
    route: "news_topic_generate_shadow",
    source_type: "gateway",
    updated_at: "2026-06-12T05:20:00.000Z"
  });
  assert.equal(news.public.recent.last_shadow_activity.candidate_text, undefined);
  assert.equal(news.public.recent.last_shadow_activity.raw_prompt, undefined);
  assert.equal(news.internal.derived.last_daily_shadow_event_id, "evt-daily-shadow");
  assert.equal(news.internal.derived.last_news_shadow_event_id, "evt-news-shadow");
});

test("pixel game projector records safe play activity and stage suggestion", () => {
  const next = projectCharacterEvent({}, {
    event_type: "hoshia_pixel_game.run_finished",
    event_id: "evt-game",
    source_kind: "hoshia_pixel_game",
    occurred_at: "2026-06-12T06:00:00.000Z",
    data_json: JSON.stringify({
      class_id: "star_idol",
      stage_id: "night_rooftop",
      state_activity: "gaming",
      state_mood: "focused",
      score_tier: "S",
      result: "cleared",
      raw_response: "hidden report",
      url: "https://example.test/run"
    })
  });

  assert.equal(next.public.today.last_activity, "pixel_game");
  assert.deepEqual(next.public.recent.last_pixel_game_activity, {
    event_type: "hoshia_pixel_game.run_finished",
    status: "finished",
    class_id: "star_idol",
    stage_id: "night_rooftop",
    score_tier: "S",
    result: "cleared",
    updated_at: "2026-06-12T06:00:00.000Z"
  });
  assert.equal(next.public.expression.mood, "focused");
  assert.equal(next.public.expression.activity, "gaming");
  assert.equal(next.public.stage.presentation_suggestion.source, "character_snapshot");
  assert.equal(next.public.recent.last_pixel_game_activity.raw_response, undefined);
  assert.equal(next.public.recent.last_pixel_game_activity.url, undefined);
});

test("interest and module memory projectors keep relationship cues safe", () => {
  const interest = projectCharacterEvent({}, {
    event_type: "interest.topic_mentioned",
    event_id: "evt-interest",
    source_kind: "hoshia_interest_knowledge",
    occurred_at: "2026-06-12T06:10:00.000Z",
    data_json: JSON.stringify({
      topic: "classic rock",
      category: "music_movie",
      matched_alias: "rock",
      raw_prompt: "hidden chat"
    })
  });
  const memory = projectCharacterEvent(interest, {
    event_type: "module.memory.recorded",
    event_id: "evt-memory",
    source_kind: "module_memory",
    occurred_at: "2026-06-12T06:12:00.000Z",
    data_json: JSON.stringify({
      memory_kind: "music",
      memory_type: "preference",
      source_module: "module_memory",
      candidate_text: "hidden candidate"
    })
  });

  assert.equal(memory.public.recent.last_interest_activity.topic, "classic rock");
  assert.equal(memory.public.recent.last_interest_activity.raw_prompt, undefined);
  assert.deepEqual(memory.public.recent.last_memory_activity, {
    memory_kind: "music",
    memory_type: "preference",
    source_module: "module_memory",
    updated_at: "2026-06-12T06:12:00.000Z"
  });
  assert.equal(memory.public.recent.last_memory_activity.candidate_text, undefined);
  assert.equal(memory.private.relationship.last_memory_kind, "music");
  assert.equal(memory.private.relationship.last_memory_type, "preference");
  assert.equal(memory.internal.derived.last_interest_event_id, "evt-interest");
  assert.equal(memory.internal.derived.last_memory_event_id, "evt-memory");
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
