import { nanoid } from "nanoid";

export function buildCharacterSnapshot({
  roomId = "live-room",
  characterId = "hoshia",
  characterState = "IDLE",
  visualState = null,
  dailyContext = null,
  userProfile = null,
  roomSummary = null,
  lifeMemories = [],
  moduleEvents = [],
  now = new Date().toISOString()
} = {}) {
  const safeVisual = visualState || {};
  const safeDaily = dailyContext || {};
  const profile = userProfile || {};
  const familiarity = clampScore(profile.familiarity);
  const trust = clampScore(profile.trust);
  const bond = Math.round(familiarity * 0.6 + trust * 0.4);
  const recentEvents = sanitizeList(
    Array.isArray(safeDaily.recent_event_summaries) ? safeDaily.recent_event_summaries : safeDaily.events,
    5,
    160
  );
  return {
    schema_version: 1,
    character_id: characterId,
    snapshot_id: `snap_${nanoid(10)}`,
    generated_at: now,
    source_revision: sourceRevision(roomId, safeVisual, safeDaily, moduleEvents),
    public: {
      presence: {
        availability: "online",
        character_state: normalizeCharacterState(characterState)
      },
      expression: {
        mood: safeText(safeVisual.mood || "calm", 40),
        activity: safeText(safeVisual.activity || "idle", 40),
        energy: clampScore(safeVisual.energy),
        social_need: clampScore(safeVisual.social_need),
        current_asset: safeAsset(safeVisual.current_png),
        visual_description: safeText(safeVisual.visual_description || safeVisual.description || "", 180)
      },
      today: {
        date: safeText(safeDaily.date || safeDaily.day_key || now.slice(0, 10), 20),
        theme: safeText(safeDaily.theme || safeDaily.summary || "", 180),
        active_event_title: safeText(safeDaily.active_event_title || safeDaily.active_event?.title || "", 120),
        recent_event_summaries: recentEvents,
        chat_hooks: sanitizeList(safeDaily.chat_hooks || safeDaily.hooks, 5, 120)
      },
      relationship: {
        stage: relationshipStage(bond, trust),
        warmth_label: warmthLabel(bond),
        known_user_cues: sanitizeList([profile.summary, profile.preferred_topics, profile.interaction_style], 4, 140)
      },
      recent: {
        interaction_source: safeText(lastModuleEventSource(moduleEvents), 80),
        last_music_request: null,
        last_music_control: null,
        last_timeline_post: null,
        last_comment_reply: null,
        last_visual_state_change: null
      },
      stage: {
        presentation_suggestion: {
          mood: safeText(safeVisual.mood || "calm", 40),
          activity: safeText(safeVisual.activity || "idle", 40),
          source: "snapshot_builder"
        }
      },
      explain: {
        state_reason: safeText(safeVisual.state_reason || "legacy visual state", 180),
        updated_at: safeText(safeVisual.updated_at || now, 40)
      }
    },
    private: {
      axes: {
        bond,
        stability: estimateStability(safeDaily, roomSummary),
        dissonance: 0
      },
      needs: {
        energy: clampScore(safeVisual.energy),
        social_need: clampScore(safeVisual.social_need),
        continuity_need: roomSummary?.summary_text ? 20 : 50,
        attention_pressure: clampScore(moduleEvents.length * 8)
      },
      emotion: {
        primary: safeText(safeVisual.mood || "calm", 40),
        secondary: "",
        intensity: Math.round(clampScore(safeVisual.energy) / 100),
        decay_until: ""
      },
      daily_canon: {
        day_key: safeText(safeDaily.day_key || "", 20),
        plan_memory_id: safeText(safeDaily.plan_memory_id || "", 80),
        active_event_id: safeText(safeDaily.active_event?.id || safeDaily.active_event_id || "", 80),
        actual_diary_memory_id: safeText(safeDaily.actual_diary_memory_id || "", 80)
      },
      relationship_signals: {
        user_id: safeText(profile.user_id || "", 80),
        familiarity,
        trust,
        teasing_level: clampScore(profile.teasing_level),
        recent_positive_count: 0,
        recent_absence_count: 0,
        last_meaningful_interaction_at: safeText(profile.updated_at || "", 40)
      },
      memory_context: {
        short_term_summary_id: roomSummary?.updated_at ? `${roomId}:${roomSummary.updated_at}` : "",
        life_memory_ids: Array.isArray(lifeMemories) ? lifeMemories.map((item) => safeText(item?.id, 80)).filter(Boolean).slice(0, 8) : [],
        livingmemory_session_id: ""
      }
    },
    internal: {
      inputs: {
        hoshia_state_row_updated_at: safeText(safeVisual.updated_at || "", 40),
        room_summary_updated_at: safeText(roomSummary?.updated_at || "", 40),
        daily_canon_source_id: safeText(safeDaily.source_id || "daily_canon", 80),
        module_event_count: Array.isArray(moduleEvents) ? moduleEvents.length : 0,
        livingmemory_recall_count: Array.isArray(lifeMemories) ? lifeMemories.length : 0
      },
      derived: {
        selected_asset_rule: "legacy_visual_state",
        dominant_event_id: "",
        last_applied_event_ids: [],
        conflict_flags: []
      },
      privacy: {
        sanitized: true,
        redaction_count: 0,
        blocked_sensitive_fields: []
      },
      debug: {
        builder_version: "character_snapshot_builder_v1",
        latency_ms: 0
      }
    }
  };
}

export function summarizeCharacterSnapshotForPrompt(snapshot = {}) {
  const pub = snapshot.public || {};
  return {
    presence: pub.presence,
    expression: pub.expression,
    today: pub.today,
    relationship: pub.relationship,
    recent: pub.recent,
    stage: pub.stage,
    explain: pub.explain
  };
}

export function normalizeCharacterEvent(event = {}) {
  const eventType = safeText(event.event_type || event.eventType, 80);
  const roomId = safeText(event.room_id || event.roomId || "live-room", 80);
  const sourceId = safeText(event.source_id || event.sourceId || event.id || "", 100);
  const key = safeText(event.idempotency_key || `${roomId}:${eventType}:${sourceId || hashText(event.summary_hint || event.summary?.public_hint || "")}`, 180);
  const publicHint = safeText(event.public_hint || event.summary_hint || event.summary?.public_hint, 240);
  return {
    event_id: safeText(event.event_id || event.id || `evt_${nanoid(10)}`, 80),
    idempotency_key: key,
    schema_version: 1,
    character_id: safeText(event.character_id || "hoshia", 40),
    room_id: roomId,
    event_type: eventType,
    actor_type: safeText(event.actor?.type || event.actor_type || "system", 32),
    user_id: safeText(event.actor?.user_id || event.user_id || "", 80),
    nickname: safeText(event.actor?.nickname || event.nickname || "", 40),
    source_kind: safeText(event.source?.kind || event.source_kind || event.module_id || "system", 40),
    source_id: sourceId,
    occurred_at: safeText(event.occurred_at || new Date().toISOString(), 40),
    visibility: ["public", "private", "internal"].includes(event.visibility) ? event.visibility : "public",
    public_hint: publicHint,
    private_hint: safeText(event.private_hint || event.summary?.private_hint || publicHint, 500),
    reason: safeText(event.reason || event.summary?.reason || event.event_type || "", 180),
    data_json: JSON.stringify(sanitizeEventData(event.data)),
    raw_text_stored: 0
  };
}

function sanitizeEventData(data = {}) {
  if (!data || typeof data !== "object") return {};
  const allowed = new Set(["title", "artist", "activity", "mood", "source", "source_type", "route", "topic", "category", "post_id", "comment_id", "status", "action"]);
  const output = {};
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.has(key)) continue;
    const text = safeText(value, 120);
    if (text) output[key] = text;
  }
  return output;
}

function lastModuleEventSource(moduleEvents = []) {
  if (!Array.isArray(moduleEvents) || !moduleEvents.length) return "";
  const event = moduleEvents.findLast?.((item) => item?.event_type || item?.module_id)
    || [...moduleEvents].reverse().find((item) => item?.event_type || item?.module_id);
  return event ? `${event.module_id || "module"}:${event.event_type || "event"}` : "";
}

function normalizeCharacterState(value) {
  const state = String(value || "IDLE").toUpperCase();
  return ["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"].includes(state) ? state : "IDLE";
}

function relationshipStage(bond, trust) {
  if (bond >= 75 && trust >= 65) return "continuity_witness";
  if (bond >= 50) return "private_echo";
  if (bond >= 20) return "familiar_contact";
  return "new_viewer";
}

function warmthLabel(bond) {
  if (bond >= 75) return "close";
  if (bond >= 45) return "stable";
  if (bond >= 20) return "familiar";
  return "new";
}

function estimateStability(daily, roomSummary) {
  let score = 30;
  if (daily?.day_key || daily?.active_event || daily?.theme) score += 35;
  if (daily?.actual_diary_memory_id) score += 20;
  if (roomSummary?.summary_text) score += 10;
  return clampScore(score);
}

function sourceRevision(roomId, visualState, dailyContext, moduleEvents) {
  return hashText(`${roomId}:${visualState?.updated_at || ""}:${dailyContext?.day_key || ""}:${moduleEvents?.length || 0}`);
}

function sanitizeList(value, limit, maxLength) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => safeText(item, maxLength)).filter(Boolean).slice(0, limit);
}

function safeAsset(value) {
  const text = safeText(value, 180);
  if (!text.startsWith("/assets/") || text.includes("..") || text.includes("\\") || text.includes("//")) return "";
  return text;
}

function clampScore(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(number, 100));
}

function safeText(value, maxLength) {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text || /(?:token|secret|bearer|\.env|ssh|cloudflared|https?:\/\/|[A-Za-z]:\\|\/home\/|\/root\/|127\.0\.0\.1|localhost)/i.test(text)) return "";
  return text.slice(0, maxLength);
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return `h${Math.abs(hash)}`;
}
