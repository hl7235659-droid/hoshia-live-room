import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("gateway prompt wiring includes Hoshia persona and host life context", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(server, /import \{ buildHostLifeContext \} from "\.\/host-life-context\.js";/);
  assert.match(server, /import \{ hoshiaPersonaPrompt \} from "\.\/hoshia-persona\.js";/);
  assert.match(server, /hostLifeContextLines = buildHostLifeContext/);
  assert.match(server, /Hoshia 是否真的想说/);
  assert.match(server, /不要像客服工单回复/);
  assert.match(server, /music_ack/);
});

test("AstrBot bridge proactive judge asks whether Hoshia genuinely wants to speak", () => {
  const bridge = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/main.py", import.meta.url), "utf8");

  assert.match(bridge, /would she genuinely want to speak/);
  assert.match(bridge, /rather than merely fill silence or act available/);
  assert.match(bridge, /Do not fill silence just to prove she is online or available/);
});
