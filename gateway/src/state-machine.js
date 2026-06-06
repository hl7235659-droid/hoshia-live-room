const states = new Set(["IDLE", "LISTENING", "THINKING", "SPEAKING", "ERROR"]);

export function nextCharacterState(eventType, text = "") {
  if (eventType === "user_message") return "LISTENING";
  if (eventType === "ai_thinking") return "THINKING";
  if (eventType === "ai_reply") return "SPEAKING";
  if (eventType === "error") return "ERROR";
  return "IDLE";
}

export function isValidState(state) {
  return states.has(state);
}
