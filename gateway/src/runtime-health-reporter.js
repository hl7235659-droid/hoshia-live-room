import { readFileSync } from "node:fs";
import { pickRuntimeRevision } from "./revision-utils.js";
import { buildRuntimeObservabilitySnapshot } from "./hoshia-runtime-observability.js";
import { safeMetricIdentifier } from "./character-event-writer.js";

export function createRuntimeHealthReporter({ config, db, moduleEventStore, observabilityCounters }) {
  let cachedRevisionFileValue = null;

  function safeRevision() {
    return pickRuntimeRevision([
      process.env.SOURCE_REVISION,
      readRevisionFile(),
      process.env.REVISION
    ], (value) => safeMetricIdentifier(value, 40));
  }

  function readRevisionFile() {
    if (cachedRevisionFileValue !== null) return cachedRevisionFileValue;
    try {
      cachedRevisionFileValue = readFileSync(new URL("../REVISION", import.meta.url), "utf8").trim();
    } catch {
      cachedRevisionFileValue = "";
    }
    return cachedRevisionFileValue;
  }

  function safeRuntimeModes() {
    return {
      ai_mode: ["mock", "astrbot", "hoshiaclaw"].includes(config.aiMode) ? config.aiMode : "unknown",
      character_state_authority: ["legacy", "event_log"].includes(config.characterStateAuthority) ? config.characterStateAuthority : "legacy",
      comment_reply_rollout_mode: ["live", "shadow", "off"].includes(config.hoshiaCommentReplyRolloutMode) ? config.hoshiaCommentReplyRolloutMode : "live",
      proactive_shadow_enabled: Boolean(config.hoshiaClawProactiveShadowEnabled),
      proactive_live_enabled: Boolean(config.hoshiaClawProactiveLiveEnabled),
      proactive_live_percent: Math.max(0, Math.min(100, Number(config.hoshiaClawProactiveLivePercent || 0))),
      daily_post_shadow_enabled: Boolean(config.hoshiaClawDailyPostShadowEnabled),
      news_topic_shadow_enabled: Boolean(config.hoshiaClawNewsTopicGenerateShadowEnabled),
      daily_post_live_enabled: Boolean(config.hoshiaClawDailyPostLiveEnabled),
      news_topic_live_enabled: Boolean(config.hoshiaClawNewsTopicLiveEnabled),
      daily_canon_live_enabled: Boolean(config.hoshiaClawDailyCanonLiveEnabled),
      daily_actual_diary_live_enabled: Boolean(config.hoshiaClawDailyActualDiaryLiveEnabled)
    };
  }

  function buildRuntimeObservability() {
    const snapshot = db.getLatestCharacterSnapshot?.({ roomId: config.roomId, characterId: "hoshia" });
    const ageMs = snapshot?.generated_at ? Math.max(0, Date.now() - Date.parse(snapshot.generated_at)) : null;
    return buildRuntimeObservabilitySnapshot({
      counters: observabilityCounters,
      moduleMemoryPending: typeof moduleEventStore.pendingMemorySize === "function" ? moduleEventStore.pendingMemorySize() : 0,
      characterSnapshotAgeMs: Number.isFinite(ageMs) ? ageMs : null
    });
  }

  return {
    buildRuntimeObservability,
    safeRevision,
    safeRuntimeModes
  };
}
