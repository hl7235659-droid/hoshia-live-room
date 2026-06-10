import assert from "node:assert/strict";
import test from "node:test";
import { buildHoshiaOpsSummary } from "../src/hoshia-ops-summary.js";

test("ops summary returns current counts and safe state details", () => {
  const summary = buildHoshiaOpsSummary({
    db: {
      countHoshiaPostsForDay() {
        return {
          day_key: "20260611",
          total: 4,
          by_source: { daily_state: 1, state_pulse: 3, daily_news: 1 }
        };
      },
      countHoshiaRepliesForDay() {
        return { day_key: "20260611", total: 6 };
      },
      countHoshiaCommentReplyStatuses() {
        return { pending: 2, failed: 1, skipped: 3 };
      }
    },
    visualState: {
      mood: "sleepy",
      activity: "idle",
      energy: 62,
      social_need: 48,
      visual_description: "Hoshia is curled up in a quiet late-night pose.",
      state_reason: "scheduled visual refresh",
      updated_at: "2026-06-11T00:00:00.000Z",
      current_png: "/assets/hoshia/stage-png/sleepy_sleepy_01.png"
    },
    newsStatus: {
      enabled: true,
      running: true,
      stage: "memory_writing",
      topic_count: 3,
      recent_titles: ["Open source desktop workflow improves", "Creator tool release notes"],
      recent_signal: "Light tech topics are fresh"
    },
    config: {
      hoshiaNewsEnabled: true,
      hoshiaDailyPostEnabled: true,
      hoshiaDailyPostMin: 1,
      hoshiaDailyPostMax: 5,
      hoshiaStatePostMinIntervalMinutes: 90,
      hoshiaStatePostActiveWindowStart: "10:00",
      hoshiaStatePostActiveWindowEnd: "23:50",
      hoshiaAsyncCommentReplyEnabled: true,
      hoshiaCommentReplyTickLimit: 2,
      hoshiaCommentReplyDailyLimit: 20,
      hoshiaCommentReplyMinDelayMinutes: 3,
      hoshiaCommentReplyMaxDelayMinutes: 45,
      hoshiaStateTickMinMinutes: 20,
      hoshiaStateTickMaxMinutes: 60
    },
    now: "2026-06-11T02:00:00.000Z"
  });

  assert.equal(summary.day_key, "20260611");
  assert.equal(summary.generated_post_count, 4);
  assert.equal(summary.daily_state_count, 1);
  assert.equal(summary.state_pulse_count, 3);
  assert.equal(summary.reply_processed_today, 6);
  assert.equal(summary.pending_comment_count, 2);
  assert.equal(summary.failed_comment_count, 1);
  assert.equal(summary.skipped_comment_count, 3);
  assert.equal(summary.visual_state.activity, "idle");
  assert.equal(summary.visual_state.current_png, undefined);
  assert.match(summary.state_summary, /idle\/sleepy/);
  assert.deepEqual(summary.news, {
    enabled: true,
    running: true,
    stage: "memory_writing",
    topic_count: 3,
    recent_titles: ["Open source desktop workflow improves", "Creator tool release notes"],
    recent_signal: "Light tech topics are fresh",
    news_post_count_today: 1
  });
  assert.equal(summary.limits.daily_max, 5);
  assert.equal(summary.limits.comment_reply_daily_limit, 20);
});

test("ops summary strips sensitive values from state summary output", () => {
  const summary = buildHoshiaOpsSummary({
    db: {
      countHoshiaPostsForDay() {
        return { day_key: "20260611", total: 0, by_source: {} };
      },
      countHoshiaRepliesForDay() {
        return { day_key: "20260611", total: 0 };
      },
      countHoshiaCommentReplyStatuses() {
        return {};
      }
    },
    visualState: {
      mood: "calm",
      activity: "idle",
      energy: 70,
      social_need: 30,
      visual_description: "token=secret path E:\\secret\\.env",
      state_reason: "localhost:3000 secret=1",
      updated_at: "2026-06-11T02:00:00.000Z"
    },
    now: "2026-06-11T02:00:00.000Z"
  });

  assert.equal(summary.visual_state.visual_description, "");
  assert.equal(summary.visual_state.state_reason, "");
  assert.doesNotMatch(JSON.stringify(summary), /token=|localhost|E:\\\\secret|\.env/i);
});

test("ops summary news block keeps compatibility and strips sensitive details", () => {
  const summary = buildHoshiaOpsSummary({
    db: {
      countHoshiaPostsForDay() {
        return { day_key: "20260611", total: 2, by_source: { hoshia_news: 2 } };
      },
      countHoshiaRepliesForDay() {
        return { day_key: "20260611", total: 0 };
      },
      countHoshiaCommentReplyStatuses() {
        return {};
      }
    },
    newsStatus: {
      enabled: true,
      running: false,
      stage: "done",
      topic_count: 9,
      recent_titles: [
        "Safe public title",
        "https://example.com/private/rss?token=secret",
        "RSSHub private route /private/feed",
        "Tavily api_key=secret",
        "loaded from C:\\secret\\.env",
        "internal host 192.168.1.20"
      ],
      recent_signal: "http://localhost:1200/rsshub token=secret"
    },
    config: { hoshiaNewsEnabled: true },
    now: "2026-06-11T02:00:00.000Z"
  });

  assert.equal(summary.news.enabled, true);
  assert.equal(summary.news.running, false);
  assert.equal(summary.news.stage, "done");
  assert.equal(summary.news.topic_count, 9);
  assert.deepEqual(summary.news.recent_titles, ["Safe public title"]);
  assert.equal(summary.news.recent_signal, "");
  assert.equal(summary.news.news_post_count_today, 2);
  assert.doesNotMatch(JSON.stringify(summary.news), /https?:\/\/|token|\.env|C:\\\\|192\.168\.1\.20|rsshub|tavily|localhost/i);
});
