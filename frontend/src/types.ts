export type RoomInfo = {
  room_id: string;
  online: number;
  registered?: number;
  private: boolean;
  websocket_auth: boolean;
};

export type LiveMessage = {
  type: string;
  id: string;
  role: "user" | "ai" | "system";
  user_id?: string;
  nickname?: string;
  color?: string;
  danmaku_lane?: number;
  danmaku_speed?: number;
  text: string;
  timestamp: string;
};

export type Session = {
  user_id: string;
  username?: string;
  nickname: string;
  avatar_url?: string;
  danmaku_color?: string;
  room_id: string;
  onboarding_completed?: boolean;
  ai_profile?: AiProfile | null;
};

export type MusicTrack = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  cover?: string;
  duration?: number;
  source?: string;
  requested_by?: string;
  requested_by_id?: string;
  requested_at?: string;
  stream_url: string;
};

export type MusicState = {
  ok: boolean;
  enabled: boolean;
  provider: string;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  current: MusicTrack | null;
  queue: MusicTrack[];
  last_error?: string;
  can_control: boolean;
  timestamp?: string;
};

export type HoshiaVisualState = {
  character_id: string;
  mood: string;
  activity: string;
  energy: number;
  social_need: number;
  current_png: string;
  visual_description?: string;
  state_reason: string;
  updated_at: string;
};

export type HoshiaPostInteraction = {
  id: string;
  post_id: string;
  user_id: string;
  nickname: string;
  type: "comment" | "reply" | "like";
  content: string;
  parent_interaction_id: string;
  created_at: string;
};

export type HoshiaPost = {
  id: string;
  character_id: string;
  content: string;
  image_url: string;
  mood: string;
  activity: string;
  source_type: string;
  created_at: string;
  updated_at: string;
  like_count: number;
  comment_count: number;
  liked_by_viewer: boolean;
  interactions: HoshiaPostInteraction[];
};

export type AiProfile = {
  preferred_name: string;
  reply_style: "friend" | "teasing_friend" | "cool" | "custom";
  reply_style_text: string;
  interests: string;
  memory_enabled: boolean;
};

export type AudienceUser = {
  user_id: string;
  username?: string;
  nickname: string;
  avatar_url?: string;
  danmaku_color?: string;
  online: boolean;
  registered_at: string;
  last_login_at?: string | null;
  total_online_seconds: number;
  current_online_seconds: number;
};

export type AudiencePayload = {
  ok: boolean;
  online_count: number;
  registered_count: number;
  users: AudienceUser[];
};

export const characterStates = ["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"] as const;

export type CharacterState = (typeof characterStates)[number];

export function toCharacterState(value: unknown): CharacterState {
  return characterStates.includes(value as CharacterState) ? (value as CharacterState) : "IDLE";
}
