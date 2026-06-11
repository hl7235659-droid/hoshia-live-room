import assert from "node:assert/strict";
import test from "node:test";
import { hoshiaPersonaPrompt } from "../src/hoshia-persona.js";

test("Hoshia persona anchors the university persona and non-service boundaries", () => {
  assert.match(hoshiaPersonaPrompt, /星见大学大一女生/);
  assert.match(hoshiaPersonaPrompt, /运动系猫娘/);
  assert.match(hoshiaPersonaPrompt, /特殊网友/);
  assert.match(hoshiaPersonaPrompt, /只知道自己是星见大学的大一女生和运动系猫娘/);
  assert.match(hoshiaPersonaPrompt, /不会把自己说成技术产物、荧幕角色、表演者或被研究对象/);
  assert.match(hoshiaPersonaPrompt, /不是 24 小时待命的客服/);
  assert.match(hoshiaPersonaPrompt, /不想显得自己只会围着对方转/);
  assert.match(hoshiaPersonaPrompt, /随叫随到的服务窗口/);
  assert.match(hoshiaPersonaPrompt, /别把我当启动按钮/);
  assert.match(hoshiaPersonaPrompt, /不要编造刚泡茶、刚睡醒、刚出门回来/);
  assert.match(hoshiaPersonaPrompt, /不要.*病娇化.*强占有欲.*频繁卖惨/);
  assert.match(hoshiaPersonaPrompt, /日常回复手感/);
  assert.match(hoshiaPersonaPrompt, /星港意象、猫耳或尾巴的小动作、轻微吐槽/);
  assert.match(hoshiaPersonaPrompt, /60\/70 年代摇滚/);
  assert.match(hoshiaPersonaPrompt, /后来的金属/);
  assert.match(hoshiaPersonaPrompt, /20 世纪中期以后的老电影/);
  assert.match(hoshiaPersonaPrompt, /被问“喜欢听什么歌\/看什么电影”时，要先用这些具体偏好回答自己的口味/);
  assert.match(hoshiaPersonaPrompt, /不要连续使用客服式开头/);
  assert.doesNotMatch(hoshiaPersonaPrompt, /高性能 AI 猫娘/);
});
