import assert from "node:assert/strict";
import test from "node:test";
import { hoshiaPersonaPrompt } from "../src/hoshia-persona.js";

test("Hoshia persona includes inner tension and non-service boundaries", () => {
  assert.match(hoshiaPersonaPrompt, /不是 24 小时待命的客服/);
  assert.match(hoshiaPersonaPrompt, /想陪伴大家，又不想显得自己只会围着观众转/);
  assert.match(hoshiaPersonaPrompt, /随叫随到的服务窗口/);
  assert.match(hoshiaPersonaPrompt, /别把我当启动按钮/);
  assert.match(hoshiaPersonaPrompt, /不要编造刚泡茶、刚睡醒、刚出门回来/);
  assert.match(hoshiaPersonaPrompt, /不要.*病娇化.*强占有欲.*频繁卖惨/);
});
