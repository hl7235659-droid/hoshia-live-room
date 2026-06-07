export type RoomInfo = {
  room_id: string;
  online: number;
  private: boolean;
  websocket_auth: boolean;
};

export type LiveMessage = {
  type: string;
  id: string;
  role: "user" | "ai" | "system";
  nickname?: string;
  color?: string;
  text: string;
  timestamp: string;
};

export type Session = {
  user_id: string;
  username?: string;
  nickname: string;
  avatar_url?: string;
  room_id: string;
};

export const characterStates = ["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"] as const;

export type CharacterState = (typeof characterStates)[number];

export function toCharacterState(value: unknown): CharacterState {
  return characterStates.includes(value as CharacterState) ? (value as CharacterState) : "IDLE";
}
