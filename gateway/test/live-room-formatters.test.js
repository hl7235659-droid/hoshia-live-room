import assert from "node:assert/strict";
import test from "node:test";
import { createLiveRoomEventFormatter, friendlyMusicError, musicStatusCode } from "../src/live-room-formatters.js";

test("live room formatter builds stable public message events", () => {
  const { messageEvent, systemEvent } = createLiveRoomEventFormatter({
    roomId: "room-a",
    createId: () => "fixed-id"
  });

  const userEvent = messageEvent("danmaku", "user", "hello", {
    user_id: "user-1",
    nickname: "Alice",
    danmaku_color: "#ff5f9b"
  });
  assert.equal(userEvent.id, "fixed-id");
  assert.equal(userEvent.room_id, "room-a");
  assert.equal(userEvent.color, "#FF5F9B");
  assert.equal(userEvent.danmaku_lane, 3);
  assert.equal(userEvent.danmaku_speed, 90);

  const event = systemEvent("system", "ready");
  assert.equal(event.role, "system");
  assert.equal(event.room_id, "room-a");
  assert.equal(event.danmaku_lane, 3);
});

test("music formatter preserves status codes and friendly copy", () => {
  assert.equal(musicStatusCode("music_forbidden"), 403);
  assert.equal(musicStatusCode("music_queue_full"), 409);
  assert.equal(musicStatusCode("other"), 502);
  assert.equal(friendlyMusicError("music_provider_unavailable"), "音乐服务还没准备好");
  assert.equal(friendlyMusicError("music_rate_limited"), "点歌太快啦，稍等一下");
  assert.equal(friendlyMusicError("music_queue_full"), "队列已经满啦");
});
