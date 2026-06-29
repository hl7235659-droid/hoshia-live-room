import assert from "node:assert/strict";
import test from "node:test";
import { buildCharacterSnapshot, normalizeCharacterEvent, summarizeCharacterSnapshotForPrompt } from "../src/character-snapshot.js";

test("character snapshot builds a safe public/private read model", () => {
  const snapshot = buildCharacterSnapshot({
    roomId: "room",
    characterState: "SPEAKING",
    visualState: {
      mood: "happy",
      activity: "idle",
      energy: 70,
      social_need: 20,
      current_png: "/assets/hoshia/stage-png/happy_happy_01.png",
      state_reason: "chat warmed up",
      updated_at: "2026-06-12T00:00:00.000Z"
    },
    dailyContext: {
      day_key: "20260612",
      theme: "campus afternoon",
      active_event: { id: "event-1", title: "club room" },
      chat_hooks: ["music", "homework"]
    },
    userProfile: {
      user_id: "user-1",
      familiarity: 60,
      trust: 40,
      summary: "Likes gentle replies"
    },
    roomSummary: { summary_text: "Room has been calm.", updated_at: "2026-06-12T00:00:00.000Z" }
  });

  assert.equal(snapshot.public.presence.character_state, "SPEAKING");
  assert.equal(snapshot.public.expression.current_asset, "/assets/hoshia/stage-png/happy_happy_01.png");
  assert.equal(snapshot.public.recent.interaction_source, "");
  assert.equal(snapshot.public.stage.presentation_suggestion.mood, "happy");
  assert.equal(snapshot.private.axes.bond, 52);
  assert.equal(summarizeCharacterSnapshotForPrompt(snapshot).internal, undefined);
  assert.equal(summarizeCharacterSnapshotForPrompt(snapshot).private, undefined);
  assert.equal(summarizeCharacterSnapshotForPrompt(snapshot).recent, snapshot.public.recent);
  assert.equal(summarizeCharacterSnapshotForPrompt(snapshot).stage, snapshot.public.stage);
});

test("character event normalization keeps summaries and drops sensitive data", () => {
  const event = normalizeCharacterEvent({
    event_type: "module.music.song_requested",
    room_id: "room",
    source_id: "track-1",
    public_hint: "Alice requested a song",
    data: {
      title: "Demo Song",
      token: "secret",
      path: "C:\\Users\\me\\secret.txt"
    }
  });

  assert.equal(event.event_type, "module.music.song_requested");
  assert.equal(JSON.parse(event.data_json).title, "Demo Song");
  assert.equal(JSON.parse(event.data_json).token, undefined);
  assert.equal(JSON.parse(event.data_json).path, undefined);
});

test("character event normalization keeps safe ai reply route only", () => {
  const event = normalizeCharacterEvent({
    event_type: "ai.reply_sent",
    room_id: "room",
    source_id: "reply-1",
    public_hint: "Hoshia replied",
    data: {
      route: "smalltalk",
      source_type: "openai_compatible",
      action: "pause",
      raw_response: "full reply should not persist",
      base_url: "https://example.test/v1"
    }
  });
  const data = JSON.parse(event.data_json);

  assert.equal(data.route, "smalltalk");
  assert.equal(data.source_type, "openai_compatible");
  assert.equal(data.action, "pause");
  assert.equal(data.raw_response, undefined);
  assert.equal(data.base_url, undefined);
});

test("shadow metric events can be unique per observation without raw text", () => {
  const first = normalizeCharacterEvent({
    id: "shadow_daily_post_shadow_a1",
    idempotency_key: "room:hoshiaclaw.daily_post_shadow.skip:shadow_daily_post_shadow_a1",
    event_type: "hoshiaclaw.daily_post_shadow.skip",
    room_id: "room",
    source_id: "shadow_daily_post_shadow_a1",
    public_hint: "HoshiaClaw daily_post_shadow skip",
    reason: "daily_post_disabled",
    data: {
      status: "skip",
      route: "daily_post_shadow",
      source_type: "gateway",
      candidate_text: "must not persist"
    }
  });
  const second = normalizeCharacterEvent({
    id: "shadow_daily_post_shadow_b2",
    idempotency_key: "room:hoshiaclaw.daily_post_shadow.skip:shadow_daily_post_shadow_b2",
    event_type: "hoshiaclaw.daily_post_shadow.skip",
    room_id: "room",
    source_id: "shadow_daily_post_shadow_b2",
    public_hint: "HoshiaClaw daily_post_shadow skip",
    reason: "daily_post_disabled",
    data: {
      status: "skip",
      route: "daily_post_shadow",
      source_type: "gateway"
    }
  });

  assert.notEqual(first.idempotency_key, second.idempotency_key);
  assert.equal(JSON.parse(first.data_json).route, "daily_post_shadow");
  assert.equal(JSON.parse(first.data_json).candidate_text, undefined);
});

test("snapshot prompt summary only exposes public safe blocks", () => {
  const snapshot = buildCharacterSnapshot({
    visualState: {
      mood: "focused",
      activity: "reading",
      state_reason: "C:\\secret\\raw.txt"
    },
    moduleEvents: [{
      module_id: "music",
      event_type: "music.control",
      data: { raw_prompt: "hidden" }
    }]
  });
  const summary = summarizeCharacterSnapshotForPrompt(snapshot);

  assert.equal(summary.expression.mood, "focused");
  assert.equal(summary.stage.presentation_suggestion.activity, "reading");
  assert.equal(summary.recent.interaction_source, "music:music.control");
  assert.equal(summary.private, undefined);
  assert.equal(summary.internal, undefined);
  assert.equal(JSON.stringify(summary).includes("raw_prompt"), false);
  assert.equal(JSON.stringify(summary).includes("C:\\secret"), false);
});
