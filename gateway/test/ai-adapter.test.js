import assert from "node:assert/strict";
import test from "node:test";
import { generateAiReply } from "../src/ai-adapter.js";

const session = {
  user_id: "user-1",
  nickname: "Tester"
};

const baseConfig = {
  aiMode: "astrbot",
  astrbotBridgeUrl: "http://astrbot:18081/live-room/generate",
  astrbotBridgeToken: "secret-token",
  astrbotTimeoutMs: 100,
  astrbotFallbackToMock: true,
  roomId: "live-room-dev"
};

test("mock mode returns local reply without bridge fetch", async () => {
  const reply = await generateAiReply(
    session,
    "hello",
    { ...baseConfig, aiMode: "mock" },
    async () => {
      throw new Error("fetch should not be called");
    }
  );

  assert.equal(reply.source, "mock");
  assert.equal(reply.state, "SPEAKING");
  assert.match(reply.text, /Tester|mock AI/);
});

test("astrbot mode sends authenticated bridge request", async () => {
  const reply = await generateAiReply(session, "ping", baseConfig, async (url, options) => {
    assert.equal(url, baseConfig.astrbotBridgeUrl);
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), {
      session_id: "live-room-dev:user-1",
      room_id: "live-room-dev",
      user_id: "user-1",
      nickname: "Tester",
      text: "ping",
      prompt: "ping",
      reply_targets: [],
      messages: []
    });
    return responseJson(200, { ok: true, text: "AstrBot says hi", state: "SPEAKING", source: "astrbot", latency_ms: 12 });
  });

  assert.deepEqual(reply, {
    text: "AstrBot says hi",
    state: "SPEAKING",
    source: "astrbot",
    latency_ms: 12
  });
});

test("astrbot room batch uses shared room session and reply targets", async () => {
  const reply = await generateAiReply(
    { ...session, user_id: "room", nickname: "直播间弹幕" },
    "最近弹幕：\n[1] Alice @Hoshia: hi",
    baseConfig,
    async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), {
        session_id: "live-room-dev:room",
        room_id: "live-room-dev",
        user_id: "room",
        nickname: "直播间弹幕",
        text: "最近弹幕：\n[1] Alice @Hoshia: hi",
        prompt: "最近弹幕：\n[1] Alice @Hoshia: hi",
        reply_targets: ["Alice"],
        messages: [
          {
            user_id: "user-a",
            nickname: "Alice",
            text: "@Hoshia hi",
            mentioned: true,
            timestamp: "2026-06-07T00:00:00.000Z"
          }
        ]
      });
      return responseJson(200, { ok: true, text: "@Alice 我在呀。", state: "SPEAKING", source: "astrbot" });
    },
    {
      roomSession: true,
      replyTargets: ["Alice"],
      messages: [
        {
          user_id: "user-a",
          nickname: "Alice",
          text: "@Hoshia hi",
          mentioned: true,
          timestamp: "2026-06-07T00:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(reply.text, "@Alice 我在呀。");
  assert.equal(reply.source, "astrbot");
});

test("astrbot errors fall back to mock when enabled", async () => {
  const reply = await generateAiReply(session, "tts please", baseConfig, async () => responseJson(500, { ok: false }));

  assert.equal(reply.source, "mock_fallback");
  assert.equal(reply.state, "SPEAKING");
  assert.match(reply.text, /TTS|VoxCPM2/);
});

test("astrbot errors return safe gateway error when fallback is disabled", async () => {
  const reply = await generateAiReply(
    session,
    "hello",
    { ...baseConfig, astrbotFallbackToMock: false, astrbotBridgeToken: "" },
    async () => responseJson(200, { ok: true })
  );

  assert.equal(reply.source, "gateway_error");
  assert.equal(reply.state, "ERROR");
  assert.equal(reply.text, "AstrBot bridge is temporarily unavailable.");
});

function responseJson(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}
