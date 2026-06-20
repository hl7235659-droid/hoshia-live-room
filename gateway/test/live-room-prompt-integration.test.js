import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("gateway prompt wiring includes Hoshia persona and host life context", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const musicDanmakuController = readFileSync(new URL("../src/music-danmaku-controller.js", import.meta.url), "utf8");
  const proactiveLiveRoomController = readFileSync(new URL("../src/proactive-live-room-controller.js", import.meta.url), "utf8");
  const gatewayPromptWiring = `${server}
${musicDanmakuController}
${proactiveLiveRoomController}`;

  assert.match(server, /import \{ buildHostLifeContext \} from "\.\/host-life-context\.js";/);
  assert.match(server, /import \{ hoshiaPersonaPrompt \} from "\.\/hoshia-persona\.js";/);
  assert.match(gatewayPromptWiring, /hostLifeContextLines = buildHostLifeContext/);
  assert.match(gatewayPromptWiring, /Hoshia 是否真的想说/);
  assert.match(gatewayPromptWiring, /不要像客服工单回复/);
  assert.match(gatewayPromptWiring, /日常留言也要有一个具体反应点/);
  assert.match(gatewayPromptWiring, /星港画面、猫耳尾巴动作/);
  assert.match(gatewayPromptWiring, /Hoshia 自身问题优先级规则/);
  assert.match(gatewayPromptWiring, /优先按 Hoshia 人格宪法和 canon 自然回答/);
  assert.match(gatewayPromptWiring, /用户偏好的回复风格只改变语气，不改变 Hoshia 自己的核心偏好、身份和关系定位/);
  assert.match(gatewayPromptWiring, /禁止用“你喜欢什么我都可以聊”“看氛围”“节奏好就行”“都可以呀”/);
  assert.match(gatewayPromptWiring, /canon 不是答题清单，只在被问到 Hoshia 自己时自然带出/);
  assert.match(gatewayPromptWiring, /问音乐\/电影时可提 60\/70 年代摇滚、后来的金属、2000 年左右有点土但抓人的老歌、20 世纪中期以后的老电影/);
  assert.match(gatewayPromptWiring, /问游戏时可提王者荣耀、蛋仔派对和游戏可以像第八艺术/);
  assert.match(gatewayPromptWiring, /问大学生活时可提课程、食堂、宿舍、图书馆、操场训练、深夜日记/);
  assert.match(gatewayPromptWiring, /不要硬猜成矿物学、艺术史或手作鉴赏/);
  assert.match(gatewayPromptWiring, /如果有外部资料参考，只自然接一两点，不要说自己查了、搜了，也不要装成深度粉丝/);
  assert.match(gatewayPromptWiring, /diaryEvent = hoshiaDailyCanonService\.getActiveEvent/);
  assert.match(gatewayPromptWiring, /diaryEvent/);
  assert.match(gatewayPromptWiring, /日记类回复规则/);
  assert.match(gatewayPromptWiring, /可以轻轻扩写小记/);
  assert.match(gatewayPromptWiring, /music_ack/);
  assert.match(gatewayPromptWiring, /高密度回复规则/);
  assert.match(gatewayPromptWiring, /Hoshia 侧的新信息/);
});

test("AstrBot bridge proactive judge asks whether Hoshia genuinely wants to speak", () => {
  const bridge = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/main.py", import.meta.url), "utf8");

  assert.match(bridge, /真的适合 Hoshia 接一句/);
  assert.match(bridge, /不要为了证明自己在场而填补安静/);
  assert.match(bridge, /current_diary_event/);
  assert.match(bridge, /Current diary event/);
  assert.match(bridge, /模块上下文是给 Hoshia 找话题用的材料/);
});

test("AstrBot bridge includes RSSHub and Tavily news topic capability", () => {
  const bridge = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/main.py", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/_conf_schema.json", import.meta.url), "utf8");

  assert.match(bridge, /\/live-room\/capabilities\/news\/refresh/);
  assert.match(bridge, /\/live-room\/capabilities\/news\/status/);
  assert.match(bridge, /_start_news_refresh_job/);
  assert.match(bridge, /asyncio\.create_task\(self\._run_news_refresh_job/);
  assert.match(bridge, /rss_fetching/);
  assert.match(bridge, /tavily_enriching/);
  assert.match(bridge, /llm_editing/);
  assert.match(bridge, /memory_writing/);
  assert.match(bridge, /_run_news_scheduler/);
  assert.match(bridge, /_fetch_rss_feed/);
  assert.match(bridge, /https:\/\/api\.tavily\.com\/search/);
  assert.match(bridge, /_format_news_topic_memory/);
  assert.match(bridge, /live-room:\{safe_room\}:news/);
  assert.match(schema, /news_capability_enabled/);
  assert.match(schema, /news_source_urls/);
  assert.match(schema, /tavily_api_key/);
});

test("AstrBot bridge can add quiet Tavily knowledge lookup for unfamiliar topics", () => {
  const bridge = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/main.py", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/_conf_schema.json", import.meta.url), "utf8");

  assert.match(bridge, /knowledge_lookup_enabled/);
  assert.match(bridge, /_build_knowledge_lookup_context/);
  assert.match(bridge, /_interest_knowledge_lookup_query/);
  assert.match(bridge, /_tavily_knowledge_lookup/);
  assert.match(bridge, /当前可聊背景/);
  assert.match(bridge, /不要说“我查了下\/搜了下\/资料显示”/);
  assert.match(bridge, /不要写成百科、影评或鉴赏报告/);
  assert.match(bridge, /anime_game\|music_movie\|sports_campus\|tech_tools\|light_trends\|general/);
  assert.match(bridge, /includeKnowledgeLookup/);
  assert.match(schema, /knowledge_lookup_enabled/);
  assert.match(schema, /knowledge_lookup_timeout_seconds/);
});

test("AstrBot bridge has proactive idle topic strategy", () => {
  const bridge = readFileSync(new URL("../../astrbot_plugin_live_room_bridge/main.py", import.meta.url), "utf8");

  assert.match(bridge, /reply_mode == "proactive_idle"/);
  assert.match(bridge, /_build_proactive_idle_instruction/);
  assert.match(bridge, /具体、容易接的话题点/);
  assert.match(bridge, /今天的日常状态、最近经历、日记摘要/);
  assert.match(bridge, /不要说成真实旅行/);
  assert.match(bridge, /不要只说联系窗口很安静/);
  assert.match(bridge, /today light campus chat topic/);
});

test("gateway proactive idle prompt prioritizes diary hooks over generic silence", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const proactiveLiveRoomController = readFileSync(new URL("../src/proactive-live-room-controller.js", import.meta.url), "utf8");
  const gatewayPromptWiring = `${server}
${proactiveLiveRoomController}`;

  assert.match(gatewayPromptWiring, /可用的主动话题钩子，按优先级排序/);
  assert.match(gatewayPromptWiring, /Daily diary: \$\{line\}/);
  assert.match(gatewayPromptWiring, /Prefer a concrete diary, safe news, or module hook/);
  assert.match(gatewayPromptWiring, /Hoshia-side detail/);
  assert.match(gatewayPromptWiring, /优先用日记钩子/);
  assert.match(gatewayPromptWiring, /不要只说联系窗口很安静/);
  assert.match(gatewayPromptWiring, /如果没有具体的日记、消息、音乐或近期聊天钩子/);
});
