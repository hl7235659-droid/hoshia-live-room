import type { LiveMessage } from "./types";

const userPalette = ["#ff5f9b", "#2b9cff", "#19a989", "#8b5cf6", "#f59e0b", "#ef4444"];

export function colorForMessage(message: LiveMessage) {
  if (message.color) return message.color;
  if (message.role === "ai") return "#1487d4";
  if (message.role === "system") return "rgba(37, 65, 92, 0.58)";

  const key = message.nickname || message.id || message.text;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return userPalette[hash % userPalette.length];
}
