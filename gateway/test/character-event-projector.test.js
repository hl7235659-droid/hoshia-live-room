import assert from "node:assert/strict";
import test from "node:test";
import { projectUserMessageReceivedEvent } from "../src/character-event-projector.js";

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

test("user message projector returns a cloned no-op snapshot for other events", () => {
  const snapshot = {
    public: { explain: { updated_at: "2026-06-12T00:00:00.000Z" } },
    internal: { derived: { last_applied_event_ids: ["evt-old"] } }
  };
  const next = projectUserMessageReceivedEvent(snapshot, {
    event_type: "module.music.song_requested",
    event_id: "evt-new",
    occurred_at: "2026-06-12T01:00:00.000Z"
  });

  assert.notEqual(next, snapshot);
  assert.deepEqual(next, snapshot);
});
