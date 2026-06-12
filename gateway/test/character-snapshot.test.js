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
  assert.equal(snapshot.private.axes.bond, 52);
  assert.equal(summarizeCharacterSnapshotForPrompt(snapshot).internal, undefined);
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
