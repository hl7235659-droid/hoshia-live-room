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
