import { pendingReplyNotice } from "./message-router.js";

export function createLiveReplyBroadcaster({
  roomId,
  createId,
  broadcast,
  broadcastHoshiaPresentation,
  normalizeHoshiaPresentation,
  replyTargets,
  sleep,
  now = () => new Date(),
  performanceNow = () => performance.now()
}) {
  function broadcastAiReplyPending({ traceId, route, batch = [] } = {}) {
    const latest = Array.isArray(batch) ? batch[batch.length - 1] : null;
    broadcast({
      type: "ai_reply_pending",
      id: `pending_${traceId || createId()}`,
      room_id: roomId,
      role: "system",
      user_id: "system",
      nickname: "sys",
      text: pendingReplyNotice(route),
      timestamp: now().toISOString(),
      latency_trace_id: traceId || "",
      route: route || "smalltalk",
      reply_targets: replyTargets(batch),
      source_message_id: latest?.id || ""
    });
    broadcastHoshiaPresentation(normalizeHoshiaPresentation({
      action: "think",
      fallback_state: "THINKING",
      source: "system",
      trace_id: traceId,
      reason: route || "reply_pending"
    }));
  }

  function broadcastAiReplyDelta({ traceId, route, text = "", deltaMode = "append", stage = "" } = {}) {
    const value = String(text || "");
    if (!traceId || !value) return;
    broadcast({
      type: "ai_reply_delta",
      room_id: roomId,
      role: "ai",
      user_id: "ai-host",
      nickname: "Hoshia",
      text: value,
      timestamp: now().toISOString(),
      latency_trace_id: traceId,
      route: route || "smalltalk",
      delta_mode: deltaMode,
      stage
    });
  }

  function createSentenceStreamEmitter({ traceId, route } = {}) {
    let buffer = "";
    let pending = Promise.resolve();
    let chunkIndex = 0;

    function enqueue(chunk, nextRoute) {
      const text = String(chunk || "");
      if (!text) return;
      const stage = `stream_${chunkIndex + 1}`;
      const delay = chunkIndex === 0 ? 0 : progressiveReplyDelayMs(nextRoute || route, chunkIndex);
      chunkIndex += 1;
      pending = pending.then(async () => {
        if (delay > 0) await sleep(Math.min(delay, 700));
        broadcastAiReplyDelta({
          traceId,
          route: nextRoute || route,
          text,
          deltaMode: "append",
          stage
        });
      });
    }

    function drain({ flush = false, nextRoute = route } = {}) {
      while (buffer) {
        const chunk = takeNextSentenceStreamChunk(buffer, flush);
        if (!chunk) break;
        buffer = buffer.slice(chunk.length);
        enqueue(chunk, nextRoute);
      }
    }

    return {
      push(text = "", nextRoute = route) {
        buffer += String(text || "");
        drain({ flush: false, nextRoute });
      },
      async flush() {
        drain({ flush: true, nextRoute: route });
        await pending;
      }
    };
  }

  async function broadcastProgressiveReplyDeltas({ traceId, route, text = "", hasLead = false } = {}) {
    const chunks = splitReplyForProgressiveDisplay(text);
    if (!traceId || chunks.length <= 1) return;
    let displayed = hasLead ? String(chunks[0] || "") : "";
    for (const [index, chunk] of chunks.entries()) {
      if (!chunk) continue;
      if (index === 0) {
        if (!hasLead) {
          displayed = chunk;
          broadcastAiReplyDelta({ traceId, route, text: displayed, deltaMode: "replace", stage: "reply_1" });
        }
        continue;
      }
      await sleep(progressiveReplyDelayMs(route, index));
      displayed = displayed ? `${displayed}${chunk}` : chunk;
      broadcastAiReplyDelta({ traceId, route, text: displayed, deltaMode: "replace", stage: `reply_${index + 1}` });
    }
  }

  function broadcastAiReplyDone({ traceId, route, skipped = false } = {}) {
    broadcast({
      type: "ai_reply_done",
      room_id: roomId,
      timestamp: now().toISOString(),
      latency_trace_id: traceId || "",
      route: route || "smalltalk",
      skipped: Boolean(skipped)
    });
  }

  function buildGatewayLatencyBreakdown({ replyBreakdown = {}, routerMs = 0, contextLoadMs = 0, gatewayStartedAt = performanceNow(), pendingVisibleMs = 0 } = {}) {
    const bridgeContextLoadMs = Number(replyBreakdown?.context_load_ms);
    const gatewayContextLoadMs = Math.max(0, Math.round(Number(contextLoadMs) || 0));
    const gatewayTotalMs = Math.max(0, Math.round(performanceNow() - gatewayStartedAt));
    const batchWaitMs = Math.max(0, Math.round(Number(pendingVisibleMs) || 0));
    return {
      ...(replyBreakdown || {}),
      router_ms: Math.max(0, Math.round(Number(routerMs) || 0)),
      batch_wait_ms: batchWaitMs,
      pending_visible_ms: batchWaitMs,
      gateway_context_load_ms: gatewayContextLoadMs,
      ...(Number.isFinite(bridgeContextLoadMs) ? { bridge_context_load_ms: Math.max(0, Math.round(bridgeContextLoadMs)) } : {}),
      context_load_ms: gatewayContextLoadMs + (Number.isFinite(bridgeContextLoadMs) ? Math.max(0, Math.round(bridgeContextLoadMs)) : 0),
      gateway_total_ms: gatewayTotalMs,
      total_ms: gatewayTotalMs
    };
  }

  return {
    broadcastAiReplyPending,
    broadcastAiReplyDelta,
    createSentenceStreamEmitter,
    broadcastProgressiveReplyDeltas,
    broadcastAiReplyDone,
    buildGatewayLatencyBreakdown
  };
}

export function takeNextSentenceStreamChunk(text = "", flush = false) {
  const value = String(text || "");
  if (!value) return "";
  const sentenceMatch = value.match(/^[\s\S]{1,90}?[。！？!?…~～]+(?:["'”’』」）)]*)?/);
  if (sentenceMatch?.[0]) return sentenceMatch[0];
  if (!flush && value.length < 42) return "";
  if (flush) return value;
  const softBreak = value.slice(0, 42).lastIndexOf("，");
  const end = softBreak >= 16 ? softBreak + 1 : 42;
  return value.slice(0, end);
}

export function splitReplyForProgressiveDisplay(text = "") {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length < 34) return [clean].filter(Boolean);
  const parts = clean.match(/[^。！？!?…]+[。！？!?…]+|[^。！？!?…]+$/g)
    ?.map((item) => item.trim())
    .filter(Boolean) || [clean];
  const chunks = [];
  for (const part of parts) {
    if (!chunks.length || chunks.length >= 3) {
      chunks.push(part);
    } else if (chunks[chunks.length - 1].length < 24) {
      chunks[chunks.length - 1] += part;
    } else {
      chunks.push(part);
    }
  }
  if (chunks.length > 3) {
    return [chunks[0], chunks[1], chunks.slice(2).join("")];
  }
  return chunks;
}

export function progressiveReplyDelayMs(route, index) {
  if (route === "diary_related") return index === 1 ? 900 : 1700;
  if (route === "emotional") return index === 1 ? 800 : 1400;
  return index === 1 ? 550 : 900;
}
