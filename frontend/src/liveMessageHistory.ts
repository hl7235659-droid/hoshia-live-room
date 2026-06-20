import type { HoshiaPresentation, LiveMessage } from "./types";
import { isHoshiaPresentation } from "./types";

export const maxHistoryMessages = 100;

export function appendRoomMessage(current: LiveMessage[], message: LiveMessage) {
  const traceId = message.latency_trace_id;
  const withoutPending = traceId && message.type === "ai_reply"
    ? current.filter((item) => !(item.type === "ai_reply_pending" && item.latency_trace_id === traceId))
    : current;
  return [...withoutPending, message].slice(-maxHistoryMessages);
}

export function appendPendingMessage(current: LiveMessage[], message: LiveMessage) {
  if (!message.latency_trace_id) return appendRoomMessage(current, message);
  const exists = current.some((item) => item.type === "ai_reply_pending" && item.latency_trace_id === message.latency_trace_id);
  if (exists) {
    return current.map((item) => item.type === "ai_reply_pending" && item.latency_trace_id === message.latency_trace_id
      ? { ...item, ...message, pending: true }
      : item);
  }
  return appendRoomMessage(current, { ...message, pending: true });
}

export function appendReplyDelta(current: LiveMessage[], payload: Partial<LiveMessage>) {
  const traceId = payload.latency_trace_id;
  if (!traceId) return current;
  return current.map((item) => item.type === "ai_reply_pending" && item.latency_trace_id === traceId
    ? {
        ...item,
        role: payload.stage === "stream" ? payload.role || "ai" : item.role,
        user_id: payload.stage === "stream" ? payload.user_id || "ai-host" : item.user_id,
        nickname: payload.stage === "stream" ? payload.nickname || "Hoshia" : item.nickname,
        text: payload.delta_mode === "replace" || (payload.stage === "stream" && !item.stream_started)
          ? `${payload.text || ""}`
          : `${item.text || ""}${payload.text || ""}`,
        stream_started: item.stream_started || payload.stage === "stream"
      }
    : item);
}

export function removePendingReply(current: LiveMessage[], traceId: string | undefined) {
  if (!traceId) return current;
  return current.filter((item) => !(item.type === "ai_reply_pending" && item.latency_trace_id === traceId && !item.stream_started));
}

export function toHoshiaPresentation(value: unknown): HoshiaPresentation | null {
  return isHoshiaPresentation(value) ? value : null;
}
