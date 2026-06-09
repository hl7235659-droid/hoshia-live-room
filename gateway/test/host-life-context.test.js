import assert from "node:assert/strict";
import test from "node:test";
import { buildHostLifeContext } from "../src/host-life-context.js";

const baseConfig = {
  realityContextTimezone: "Asia/Shanghai"
};

test("host life context derives current mood from time room and music state", () => {
  const context = buildHostLifeContext({
    config: baseConfig,
    room: { online: 1 },
    now: new Date("2026-06-09T23:30:00+08:00"),
    batch: [
      {
        session: { user_id: "user-a", nickname: "Alice" },
        text: "@Hoshia 这首歌好适合晚上",
        mentioned: true,
        timestamp: "2026-06-09T15:30:00.000Z"
      }
    ],
    moduleContext: [
      {
        module_id: "music",
        enabled: true,
        current_state: ["当前播放：Purple Rain - Prince。", "待播 1 首。"]
      }
    ],
    moduleEvents: [
      {
        module_id: "music",
        summary_hint: "Alice 点了 Purple Rain - Prince"
      }
    ]
  }).join("\n");

  assert.match(context, /Hoshia 当前状态/);
  assert.match(context, /夜间/);
  assert.match(context, /有人明确叫到 Hoshia/);
  assert.match(context, /被启动的客服/);
  assert.match(context, /当前注意力：歌单和弹幕气氛/);
  assert.match(context, /Purple Rain - Prince/);
  assert.match(context, /Alice 点了 Purple Rain - Prince/);
  assert.match(context, /不要编造刚泡茶、刚睡醒、刚出门回来/);
});

test("host life context allows silence instead of forced availability", () => {
  const context = buildHostLifeContext({
    config: baseConfig,
    room: { online: 2 },
    now: new Date("2026-06-09T20:00:00+08:00"),
    batch: [
      {
        session: { user_id: "user-a", nickname: "Alice" },
        text: "哈哈",
        mentioned: false,
        timestamp: "2026-06-09T12:00:00.000Z"
      }
    ]
  }).join("\n");

  assert.match(context, /可以先听一会儿/);
  assert.match(context, /不必为了填补沉默而营业/);
  assert.match(context, /是否真的想说/);
});

test("host life context filters sensitive-looking values", () => {
  const context = buildHostLifeContext({
    config: { realityContextTimezone: "Asia/Shanghai", roomId: "C:\\secret\\.env" },
    room: { online: 1 },
    now: new Date("2026-06-09T20:00:00+08:00"),
    moduleContext: [
      {
        module_id: "music",
        enabled: true,
        current_state: [
          "provider url http://43.133.229.140/private token=secret",
          "当前播放：Safe Song"
        ]
      }
    ],
    moduleEvents: [
      {
        module_id: "music",
        summary_hint: "cloudflared trycloudflare cookie should not pass"
      }
    ]
  }).join("\n");

  assert.match(context, /Safe Song/);
  assert.doesNotMatch(context, /\.env/i);
  assert.doesNotMatch(context, /token/i);
  assert.doesNotMatch(context, /secret/i);
  assert.doesNotMatch(context, /43\.133\.229\.140/);
  assert.doesNotMatch(context, /cloudflared/i);
  assert.doesNotMatch(context, /trycloudflare/i);
  assert.doesNotMatch(context, /cookie/i);
  assert.doesNotMatch(context, /C:\\/);
});
