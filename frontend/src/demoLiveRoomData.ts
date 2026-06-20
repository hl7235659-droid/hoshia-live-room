import type { AudiencePayload, HoshiaPost, HoshiaVisualState, MusicState, RoomInfo, Session } from "./types";

export type GameCatalogItem = {
  id: string;
  title: string;
  genre: string;
  status: "available" | "soon";
  description: string;
  meta: string;
};

export const gameCatalog: GameCatalogItem[] = [
  {
    id: "hoshia_pixel_mowdown",
    title: "Radio Pixel Mowdown",
    genre: "Survivors-like",
    status: "available",
    description: "锁定 Hoshia 当前心情与活动，进入 15 分钟像素割草波次。",
    meta: "1P / Hoshia mood director"
  },
  {
    id: "signal_puzzle_shift",
    title: "Signal Puzzle Shift",
    genre: "Puzzle",
    status: "soon",
    description: "把直播间信号块调到同一频率，预留给后续小游戏扩充。",
    meta: "COMING SOON"
  },
  {
    id: "catwalk_rhythm_dash",
    title: "Catwalk Rhythm Dash",
    genre: "Rhythm runner",
    status: "soon",
    description: "跟随弹幕节拍冲刺、闪避和收集星屑，后续开放。",
    meta: "COMING SOON"
  }
];
const demoParams = new URLSearchParams(window.location.search);
export const isStageDemo = import.meta.env.DEV && demoParams.get("demo") === "stage";
export const isAwakeningDemo = isStageDemo && demoParams.get("intro") === "awake";
export const demoSession: Session = { user_id: "demo", username: "designer", nickname: "designer", avatar_url: "", danmaku_color: "#FF5F9B", room_id: "live-room-dev" };
export const demoRoom: RoomInfo = { room_id: "live-room-dev", online: 2, registered: 4, private: true, websocket_auth: true };
export const demoAudience: AudiencePayload = {
  ok: true,
  online_count: 2,
  registered_count: 4,
  users: [
    { user_id: "demo", username: "designer", nickname: "designer", avatar_url: "", danmaku_color: "#FF5F9B", online: true, registered_at: "2026-06-07T00:00:00.000Z", last_login_at: "2026-06-07T12:00:00.000Z", total_online_seconds: 4280, current_online_seconds: 320 },
    { user_id: "friend-a", username: "mika", nickname: "Mika", avatar_url: "", danmaku_color: "#2B9CFF", online: true, registered_at: "2026-06-07T02:10:00.000Z", last_login_at: "2026-06-07T12:12:00.000Z", total_online_seconds: 1930, current_online_seconds: 180 },
    { user_id: "friend-b", username: "blue", nickname: "Blue", avatar_url: "", danmaku_color: "#19A989", online: false, registered_at: "2026-06-06T10:20:00.000Z", last_login_at: "2026-06-07T09:00:00.000Z", total_online_seconds: 8640, current_online_seconds: 0 },
    { user_id: "friend-c", username: "ruru", nickname: "Ruru", avatar_url: "", danmaku_color: "#8B5CF6", online: false, registered_at: "2026-06-05T08:00:00.000Z", last_login_at: null, total_online_seconds: 0, current_online_seconds: 0 }
  ]
};
export const demoMusicState: MusicState = {
  ok: true,
  enabled: true,
  provider: "xiaomusic",
  status: "playing",
  current: {
    id: "demo-track",
    title: "StellaNet Night Drive",
    artist: "Hoshia",
    duration: 188,
    source: "demo",
    requested_by: "Mika",
    stream_url: ""
  },
  queue: [
    { id: "demo-track-2", title: "Pixel Cat Parade", artist: "Blue", duration: 164, source: "demo", requested_by: "Blue", stream_url: "" }
  ],
  last_error: "",
  can_control: true
};
export const demoHoshiaState: HoshiaVisualState = {
  character_id: "hoshia",
  mood: "calm",
  activity: "idle",
  energy: 72,
  social_need: 48,
  current_png: "assets/hoshia-character-cutout.png",
  state_reason: "demo idle stage state",
  updated_at: new Date().toISOString()
};
export const demoHoshiaPosts: HoshiaPost[] = [
  {
    id: "demo-post-1",
    character_id: "hoshia",
    content: "刚刚排位被队友气到啦……我真的只是想安静赢一把，怎么这么难。",
    image_url: "assets/hoshia/stage-png/gaming_annoyed_02.png",
    mood: "annoyed",
    activity: "gaming",
    source_type: "demo",
    created_at: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
    like_count: 7,
    comment_count: 2,
    liked_by_viewer: false,
    interactions: [
      {
        id: "demo-comment-1",
        post_id: "demo-post-1",
        user_id: "demo",
        nickname: "designer",
        type: "comment",
        content: "菜就多练。",
        parent_interaction_id: "",
        created_at: new Date(Date.now() - 1000 * 60 * 18).toISOString()
      },
      {
        id: "demo-reply-1",
        post_id: "demo-post-1",
        user_id: "ai-host",
        nickname: "Hoshia",
        type: "reply",
        content: "这句话我记住了，下次赢了第一个截图给你看。",
        parent_interaction_id: "demo-comment-1",
        created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString()
      }
    ]
  },
  {
    id: "demo-post-2",
    character_id: "hoshia",
    content: "今天训练完有点累，不过坐下来整理星港的时候，突然觉得安静也挺好。",
    image_url: "assets/hoshia/stage-png/sports_tired_02.png",
    mood: "tired",
    activity: "sports",
    source_type: "demo",
    created_at: new Date(Date.now() - 1000 * 60 * 92).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 92).toISOString(),
    like_count: 4,
    comment_count: 0,
    liked_by_viewer: true,
    interactions: []
  }
];
