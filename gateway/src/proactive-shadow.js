import {
  classifyShadowReply as classifyGenericShadowReply,
  runHoshiaClawShadow
} from "./hoshiaclaw-shadow.js";

const PROACTIVE_PREFIX = "hoshiaclaw.proactive_shadow";
const PROACTIVE_REPLY_MODE = "proactive_idle_shadow";

export async function runHoshiaClawProactiveShadow(options = {}) {
  return runHoshiaClawShadow({
    ...options,
    eventPrefix: PROACTIVE_PREFIX,
    replyMode: PROACTIVE_REPLY_MODE
  });
}

export function classifyShadowReply(reply = {}) {
  return classifyGenericShadowReply(reply, { eventPrefix: PROACTIVE_PREFIX });
}
