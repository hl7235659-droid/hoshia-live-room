import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealityContext,
  calendarItemsForDate,
  calendarLines,
  formatTimeLine
} from "../src/reality-context.js";

const baseConfig = {
  roomId: "live-room-dev",
  aiMode: "astrbot",
  singleUserDirectReplyEnabled: true,
  realityContextEnabled: true,
  realityContextTimezone: "Asia/Shanghai",
  realityContextIncludeOps: true
};

test("reality time context includes local date weekday timezone and period", () => {
  const line = formatTimeLine(new Date("2026-06-09T12:34:56+08:00"), "Asia/Shanghai");
  assert.match(line, /2026-06-09 12:34:56/);
  assert.match(line, /星期二/);
  assert.match(line, /Asia\/Shanghai/);
  assert.match(line, /中午/);
});

test("calendar context includes holiday today and upcoming solar term", () => {
  const todayItems = calendarItemsForDate("2026-10-01");
  assert.ok(todayItems.some((item) => item.name.includes("国庆节")));

  const lines = calendarLines(new Date("2026-06-20T09:00:00+08:00"), "Asia/Shanghai");
  assert.ok(lines.some((line) => line.includes("端午节假期")));
  assert.ok(lines.some((line) => line.includes("明天 夏至")));
});

test("calendar context stays quiet on ordinary dates without nearby events", () => {
  const lines = calendarLines(new Date("2026-03-10T09:00:00+08:00"), "Asia/Shanghai");
  assert.deepEqual(lines, []);
});

test("reality context includes safe room viewer configuration and memory", () => {
  const context = buildRealityContext({
    config: baseConfig,
    room: { room_id: "live-room-dev", online: 1, registered: 2 },
    now: new Date("2026-06-09T20:10:00+08:00"),
    audienceUsers: [
      {
        user_id: "user-a",
        nickname: "Alice",
        danmaku_color: "#7DDCFF",
        online: true,
        total_online_seconds: 3600,
        current_online_seconds: 120
      }
    ],
    batch: [
      {
        session: {
          user_id: "user-a",
          nickname: "Alice",
          danmaku_color: "#7DDCFF",
          ai_profile: {
            preferred_name: "小艾",
            reply_style: "teasing_friend",
            reply_style_text: "像熟朋友一样轻松吐槽",
            interests: "游戏和老电影",
            memory_enabled: true
          }
        },
        text: "@Hoshia 今天什么日子",
        mentioned: true,
        timestamp: "2026-06-09T12:10:00.000Z"
      }
    ]
  }).join("\n");

  assert.match(context, /当前现实时间：2026-06-09 20:10:00/);
  assert.match(context, /当前在线 1 人/);
  assert.doesNotMatch(context, /AI_MODE=astrbot/);
  assert.match(context, /留言颜色 #7DDCFF/);
  assert.match(context, /累计在线约 1小时2分钟/);
  assert.match(context, /称呼「小艾」/);
  assert.match(context, /游戏和老电影/);
  assert.doesNotMatch(context, /React\/Vite/);
  assert.doesNotMatch(context, /Node\.js gateway/);
  assert.doesNotMatch(context, /SQLite/);
  assert.match(context, /不要让 Hoshia 自称或承认自己是技术产物、荧幕角色、表演者或被研究对象/);
});

test("reality context can be disabled and filters sensitive-looking values", () => {
  assert.deepEqual(buildRealityContext({ config: { ...baseConfig, realityContextEnabled: false } }), []);

  const context = buildRealityContext({
    config: {
      ...baseConfig,
      roomId: "C:\\secret\\.env",
      aiMode: "mock"
    },
    room: { room_id: "43.133.229.140", online: 1, registered: 1 },
    now: new Date("2026-01-01T10:00:00+08:00"),
    batch: []
  }).join("\n");

  assert.doesNotMatch(context, /\.env/i);
  assert.doesNotMatch(context, /token/i);
  assert.doesNotMatch(context, /ssh/i);
  assert.doesNotMatch(context, /43\.133\.229\.140/);
  assert.doesNotMatch(context, /C:\\/);
});
