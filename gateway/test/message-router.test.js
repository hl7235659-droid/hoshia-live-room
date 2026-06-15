import assert from "node:assert/strict";
import test from "node:test";
import {
  buildActiveContext,
  buildContextPolicy,
  classifyMessageRoute,
  formatActiveContextLines,
  pendingReplyNotice,
  quickReplyLead
} from "../src/message-router.js";

const session = {
  user_id: "user-1",
  nickname: "Alice",
  ai_profile: {
    memory_enabled: true,
    preferred_name: "Alice",
    reply_style_text: "cozy and direct",
    interests: "anime, running"
  }
};

function batch(text, extra = {}) {
  return [{ session, text, mentioned: false, timestamp: "2026-06-11T00:00:00.000Z", ...extra }];
}

test("message router classifies low-latency and heavy reply routes", () => {
  assert.equal(classifyMessageRoute(batch("hello")), "smalltalk");
  assert.equal(classifyMessageRoute(batch("I feel tired and stressed today")), "emotional");
  assert.equal(classifyMessageRoute(batch("Can you review the gateway latency code?")), "project_discussion");
  assert.equal(classifyMessageRoute(batch("What is the capital of France?")), "factual_question");
  assert.equal(classifyMessageRoute(batch("Do you remember what I liked last time?")), "memory_related");
  assert.equal(classifyMessageRoute(batch("What did you do today, any diary update?")), "diary_related");
  assert.equal(classifyMessageRoute(batch("/refresh music state")), "command");
});

test("message router classifies common Chinese live-room messages", () => {
  assert.equal(classifyMessageRoute(batch("你好")), "smalltalk");
  assert.equal(classifyMessageRoute(batch("我今天好累，压力有点大")), "emotional");
  assert.equal(classifyMessageRoute(batch("你今天干嘛了，有没有写日记")), "diary_related");
  assert.equal(classifyMessageRoute(batch("你还记得我以前喜欢什么吗")), "memory_related");
  assert.equal(classifyMessageRoute(batch("这个项目的网关延迟需要继续优化")), "project_discussion");
  assert.equal(classifyMessageRoute(batch("什么是流式输出？")), "factual_question");
  assert.equal(classifyMessageRoute(batch("/刷新状态")), "command");
});

test("message router classifies actual Chinese context and memory questions", () => {
  assert.equal(classifyMessageRoute(batch("你现在在干嘛，动态是什么？")), "diary_related");
  assert.equal(classifyMessageRoute(batch("环境信息系统现在是什么状态")), "diary_related");
  assert.equal(classifyMessageRoute(batch("你刚才自己说了什么")), "memory_related");
  assert.equal(classifyMessageRoute(batch("前100条信息里我问了什么")), "memory_related");
  assert.equal(classifyMessageRoute(batch("我的弹幕颜色是什么")), "memory_related");
});

test("message router classifies current hot-topic questions as context-heavy", () => {
  assert.equal(classifyMessageRoute(batch("最近有什么热点你怎么看")), "diary_related");
  assert.equal(classifyMessageRoute(batch("给这个新闻锐评一下")), "diary_related");
});

test("smalltalk context policy keeps personality, life, and module context available", () => {
  const policy = buildContextPolicy("smalltalk", batch("hello"));
  assert.equal(policy.fastLane, false);
  assert.equal(policy.includeContextSummary, false);
  assert.equal(policy.refreshSummarySync, false);
  assert.equal(policy.includeLifeMemory, true);
  assert.equal(policy.includeLivingMemory, true);
  assert.equal(policy.includeNewsMemory, true);
  assert.equal(policy.consumeModuleMemoryEvents, true);
  assert.equal(policy.recentContextLimit, 12);
  assert.equal(policy.moduleEventLimit, 12);
  assert.ok(policy.livingMemoryK >= 1);
});

test("factual question context policy can use recent life and news hooks", () => {
  const policy = buildContextPolicy("factual_question", batch("what is this news"));
  assert.equal(policy.fastLane, false);
  assert.equal(policy.includeLifeMemory, true);
  assert.equal(policy.includeLivingMemory, true);
  assert.equal(policy.includeNewsMemory, true);
  assert.equal(policy.consumeModuleMemoryEvents, true);
  assert.equal(policy.recentContextLimit, 32);
  assert.equal(policy.moduleEventLimit, 16);
});

test("heavy routes keep memory and summary context available", () => {
  const policy = buildContextPolicy("memory_related", batch("remember this"));
  assert.equal(policy.includeContextSummary, true);
  assert.equal(policy.refreshSummarySync, true);
  assert.equal(policy.includeLifeMemory, true);
  assert.equal(policy.includeLivingMemory, true);
  assert.equal(policy.consumeModuleMemoryEvents, true);
  assert.ok(policy.recentContextLimit >= 100);
  assert.ok(policy.livingMemoryK >= 1);
});

test("active context is compact and safe for prompt insertion", () => {
  const activeContext = buildActiveContext({
    visualState: {
      mood: "calm",
      activity: "chatting",
      energy: 68,
      social_need: 55,
      state_reason: "Hoshia is watching chat"
    },
    audienceUsers: [{ online: true }],
    moduleContext: [
      {
        module_id: "music",
        enabled: true,
        current_state: ["Now playing: StellaNet Night Drive"]
      }
    ],
    moduleEvents: [
      {
        module_id: "music",
        summary_hint: "Alice requested a night-drive song"
      }
    ],
    batch: batch("hello")
  });

  assert.match(activeContext.current_state, /mood=calm/);
  assert.match(activeContext.recent_user_memory, /cozy and direct/);
  assert.match(activeContext.current_viewer, /nickname=Alice/);
  assert.ok(activeContext.chat_hooks.length >= 1);
  assert.ok(formatActiveContextLines(activeContext).some((line) => line.includes("active_context")));
});

test("active context exposes current viewer public color safely", () => {
  const activeContext = buildActiveContext({
    audienceUsers: [{ user_id: "user-1", online: true, danmaku_color: "#112233" }],
    batch: batch("我的弹幕颜色是什么", {
      session: { ...session, danmaku_color: "#7ddcff" }
    })
  });

  assert.match(activeContext.current_viewer, /danmaku_color=#7DDCFF/);
  assert.match(formatActiveContextLines(activeContext).join("\n"), /Current viewer: .*#7DDCFF/);
});

test("active context exposes current diary event as a concrete reply hook", () => {
  const activeContext = buildActiveContext({
    visualState: {
      mood: "sleepy",
      activity: "sleepy",
      energy: 20,
      social_need: 70
    },
    diaryEvent: {
      time_range: "22:40-23:30",
      type: "room_activity",
      title: "Stage notes",
      chat_hooks: ["Mention having one thing she wanted to say."]
    },
    batch: batch("what are you doing now?")
  });
  const lines = formatActiveContextLines(activeContext).join("\n");

  assert.match(activeContext.current_diary_event, /22:40-23:30/);
  assert.match(activeContext.current_diary_event, /小房间|房间状态|话题/);
  assert.match(lines, /Current diary event/);
  assert.doesNotMatch(activeContext.current_diary_event, /Stage notes|token=|\/home\/ubuntu|\.env/i);
});

test("pending reply notices are route-specific text", () => {
  assert.notEqual(pendingReplyNotice("smalltalk"), pendingReplyNotice("emotional"));
  assert.ok(pendingReplyNotice("diary_related").length > 0);
});

test("quick reply leads provide early spoken text for lightweight routes", () => {
  assert.match(quickReplyLead("diary_related", "你今天干嘛了"), /今天/);
  assert.match(quickReplyLead("emotional", "我今天好累"), /听/);
  assert.equal(quickReplyLead("smalltalk", "hello"), "");
  assert.equal(quickReplyLead("smalltalk", "lunch?"), "");
  assert.equal(quickReplyLead("project_discussion", "看看项目架构"), "");
});
