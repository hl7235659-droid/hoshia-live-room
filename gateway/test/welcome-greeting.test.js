import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWelcomeGreetingPrompt,
  fallbackWelcomeGreeting,
  shouldScheduleWelcomeGreeting,
  welcomeCooldownKey
} from "../src/welcome-greeting.js";

test("welcome greeting prompt includes account personalization", () => {
  const prompt = buildWelcomeGreetingPrompt({
    session: {
      user_id: "user-a",
      nickname: "Alice",
      danmaku_color: "#7DDCFF",
      last_login_at: "2026-06-09T12:00:00.000Z",
      onboarding_completed: true,
      ai_profile: {
        preferred_name: "小艾",
        reply_style: "teasing_friend",
        reply_style_text: "像熟朋友一样轻松吐槽",
        interests: "AI 和游戏",
        memory_enabled: true
      }
    },
    room: { online: 2, registered: 4 },
    currentOnlineSeconds: 90,
    totalOnlineSeconds: 3690,
    contextSummary: "Alice 最近在准备一次直播间演示。",
    realityContextLines: ["当前现实时间：2026-06-09 20:10:00，星期二，时区 Asia/Shanghai，晚上。"],
    hostLifeContextLines: ["【Hoshia 当前状态】", "房间氛围：有人明确叫到 Hoshia；她会珍惜被叫到，但不用表现得像被启动的客服。"]
  });

  assert.match(prompt, /主动欢迎刚进入房间的观众/);
  assert.match(prompt, /Alice/);
  assert.match(prompt, /#7DDCFF/);
  assert.match(prompt, /2026-06-09T12:00:00.000Z/);
  assert.match(prompt, /1分钟/);
  assert.match(prompt, /1小时1分钟/);
  assert.match(prompt, /小艾/);
  assert.match(prompt, /AI 和游戏/);
  assert.match(prompt, /直播间演示/);
  assert.match(prompt, /当前在线 2 人/);
  assert.match(prompt, /Hoshia 当前状态/);
  assert.match(prompt, /客服/);
  assert.match(prompt, /不要说自己一直等着对方/);
  assert.match(prompt, /不要暴露/);
});

test("fallback welcome uses preferred name when memory is enabled", () => {
  const text = fallbackWelcomeGreeting({
    nickname: "Alice",
    ai_profile: {
      preferred_name: "小艾",
      memory_enabled: true
    }
  });
  assert.match(text, /@小艾/);
  assert.match(text, /Hoshia Starport/);
});

test("welcome cooldown key is scoped by room and user", () => {
  assert.equal(welcomeCooldownKey("room-a", "user-a"), "live-room:welcome:room-a:user-a");
});

test("welcome scheduling skips duplicate tabs and incomplete onboarding", () => {
  assert.equal(shouldScheduleWelcomeGreeting({ user_id: "user-a", onboarding_completed: true }, false), true);
  assert.equal(shouldScheduleWelcomeGreeting({ user_id: "user-a", onboarding_completed: true }, true), false);
  assert.equal(shouldScheduleWelcomeGreeting({ user_id: "user-a", onboarding_completed: false }, false), false);
  assert.equal(shouldScheduleWelcomeGreeting(null, false), false);
});
