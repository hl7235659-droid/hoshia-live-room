import asyncio
import html
import json
import re
import time
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from http import HTTPStatus
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from astrbot.api import AstrBotConfig, logger
from astrbot.api.star import Context, Star, register


def _extract_json(text: str) -> dict[str, Any]:
    text = str(text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    cleaned = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE).strip()
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        return json.loads(match.group())
    raise ValueError(f"no_json_object: {text[:160]}")


def _clamp_score(value: Any) -> float:
    try:
        return max(0.0, min(10.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


@register(
    "astrbot_plugin_live_room_bridge",
    "codex",
    "Internal HTTP bridge for live-room-dev gateway.",
    "0.5.0",
)
class LiveRoomBridgePlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.host = str(config.get("host", "0.0.0.0"))
        self.port = int(config.get("port", 18081))
        self.bridge_token = str(config.get("bridge_token", ""))
        self.streaming_enabled = self._config_bool("streaming_enabled", True)
        self.system_prompt = str(config.get("system_prompt", "")).strip()
        self.judge_provider_name = str(config.get("judge_provider_name", "tencentmaas/deepseek-v4-flash")).strip()
        self.proactive_reply_threshold = float(config.get("proactive_reply_threshold", 0.62))
        self.min_proactive_interval_seconds = int(config.get("min_proactive_interval_seconds", 12))
        self.energy_decay = float(config.get("energy_decay", 0.16))
        self.energy_recovery = float(config.get("energy_recovery", 0.04))
        self.livingmemory_enabled = self._config_bool("livingmemory_enabled", False)
        self.livingmemory_auto_summary_enabled = self._config_bool("livingmemory_auto_summary_enabled", True)
        self.livingmemory_persona_id = str(config.get("livingmemory_persona_id", "hoshia-live-room")).strip() or "hoshia-live-room"
        self.livingmemory_recall_k = max(1, min(int(config.get("livingmemory_recall_k", 5)), 10))
        self.livingmemory_max_participants = max(1, min(int(config.get("livingmemory_max_participants", 3)), 5))
        self.livingmemory_news_retention_days = max(1, min(int(config.get("news_retention_days", config.get("livingmemory_news_retention_days", 7))), 365))
        self.livingmemory_recent_state_retention_days = max(1, min(int(config.get("livingmemory_recent_state_retention_days", 30)), 365))
        self.news_capability_enabled = self._config_bool("news_capability_enabled", False)
        self.news_refresh_enabled = self._config_bool("news_refresh_enabled", False)
        self.news_refresh_on_startup = self._config_bool("news_refresh_on_startup", False)
        self.news_room_id = str(config.get("news_room_id", "private-pixel-live")).strip() or "private-pixel-live"
        self.news_refresh_hour = max(0, min(int(config.get("news_refresh_hour", 9)), 23))
        self.news_refresh_timezone = str(config.get("news_refresh_timezone", "Asia/Shanghai")).strip() or "Asia/Shanghai"
        self.news_source_urls = self._config_list("news_source_urls")
        self.news_refresh_max_items = max(1, min(int(config.get("news_refresh_max_items", 30)), 100))
        self.news_refresh_timeout_seconds = max(3, min(int(config.get("news_refresh_timeout_seconds", 10)), 60))
        self.tavily_api_key = str(config.get("tavily_api_key", "")).strip()
        self.knowledge_lookup_enabled = self._config_bool("knowledge_lookup_enabled", True)
        self.knowledge_lookup_timeout_seconds = max(3, min(int(config.get("knowledge_lookup_timeout_seconds", 6)), 20))
        self.tavily_max_queries_per_refresh = max(0, min(int(config.get("tavily_max_queries_per_refresh", 6)), 20))
        self._knowledge_lookup_cache: dict[str, tuple[float, str]] = {}
        self._news_refresh_lock = asyncio.Lock()
        self._news_refresh_task: asyncio.Task | None = None
        self._news_refresh_job_seq = 0
        self._news_refresh_status = self._new_news_refresh_status("idle", "")
        self._news_scheduler_task: asyncio.Task | None = None
        self._room_states: dict[str, dict[str, float]] = {}
        self._server: asyncio.AbstractServer | None = None
        self._server_task = asyncio.create_task(self._start_server())
        if self.news_capability_enabled and self.news_refresh_enabled:
            self._news_scheduler_task = asyncio.create_task(self._run_news_scheduler())

    async def terminate(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        self._server_task.cancel()
        try:
            await self._server_task
        except asyncio.CancelledError:
            pass
        if self._news_scheduler_task:
            self._news_scheduler_task.cancel()
            try:
                await self._news_scheduler_task
            except asyncio.CancelledError:
                pass

    async def _start_server(self):
        self._server = await asyncio.start_server(self._handle_connection, self.host, self.port)
        logger.info(f"[live-room-bridge] listening on {self.host}:{self.port}")
        async with self._server:
            await self._server.serve_forever()

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request = await self._read_request(reader)
            result = await self._dispatch(request)
            if isinstance(result, dict) and result.get("_live_room_stream"):
                await self._write_ndjson_stream(writer, result.get("status", HTTPStatus.OK), result.get("events"))
            else:
                status, payload = result
                self._write_json(writer, status, payload)
        except Exception as exc:
            logger.error(f"[live-room-bridge] request failed: {exc}", exc_info=True)
            self._write_json(writer, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "internal_error"})
        finally:
            writer.close()
            await writer.wait_closed()

    async def _read_request(self, reader: asyncio.StreamReader) -> dict[str, Any]:
        header_bytes = await reader.readuntil(b"\r\n\r\n")
        header_text = header_bytes.decode("iso-8859-1")
        lines = header_text.split("\r\n")
        method, path, _version = lines[0].split(" ", 2)
        headers = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()

        length = int(headers.get("content-length", "0") or 0)
        body = await reader.readexactly(length) if length else b""
        return {"method": method, "path": path, "headers": headers, "body": body}

    async def _dispatch(self, request: dict[str, Any]):
        if request["method"] == "GET" and request["path"] == "/healthz":
            return HTTPStatus.OK, {"ok": True, "service": "astrbot_plugin_live_room_bridge"}

        if request["method"] != "POST" or request["path"] not in {"/live-room/generate", "/live-room/news", "/live-room/capabilities/news/refresh", "/live-room/capabilities/news/status", "/live-room/capabilities/news/topics", "/live-room/context/summarize", "/live-room/memory/debug-recall", "/live-room/music/intent"}:
            return HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"}

        if not self.bridge_token:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "bridge_token_not_configured"}
        if request["headers"].get("authorization") != f"Bearer {self.bridge_token}":
            return HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"}

        try:
            payload = json.loads(request["body"].decode("utf-8"))
        except Exception:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "bad_json"}

        if request["path"] == "/live-room/news":
            return await self._handle_news_ingest(payload)
        if request["path"] == "/live-room/capabilities/news/refresh":
            return await self._handle_news_refresh(payload)
        if request["path"] == "/live-room/capabilities/news/status":
            return HTTPStatus.OK, self._news_refresh_status_payload()
        if request["path"] == "/live-room/capabilities/news/topics":
            return await self._handle_news_topics(payload)
        if request["path"] == "/live-room/context/summarize":
            return await self._handle_context_summarize(payload)
        if request["path"] == "/live-room/memory/debug-recall":
            return await self._handle_debug_recall(payload)
        if request["path"] == "/live-room/music/intent":
            return await self._handle_music_intent(payload)

        text = str(payload.get("text", "")).strip()
        prompt_override = str(payload.get("prompt", "")).strip()
        nickname = str(payload.get("nickname", "")).strip()[:32]
        session_id = str(payload.get("session_id", "")).strip()
        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
        reply_targets = payload.get("reply_targets", [])
        messages = payload.get("messages", [])
        recent_context = payload.get("recent_context", [])
        context_summary = str(payload.get("context_summary", "")).strip()
        module_context = self._clean_module_context(payload.get("module_context", []))
        module_events = self._clean_module_events(payload.get("module_events", []))
        module_memory_events = self._clean_module_events(payload.get("module_memory_events", []))
        active_context = self._clean_active_context(payload.get("active_context", {}))
        context_policy = self._clean_context_policy(payload.get("context_policy", {}))
        reply_route = self._safe_identifier(payload.get("reply_route") or context_policy.get("route") or "", 48)
        latency_trace_id = self._safe_identifier(payload.get("latency_trace_id"), 80)
        force_reply = bool(payload.get("force_reply"))
        reply_mode = str(payload.get("reply_mode", "")).strip()[:48]
        stream_reply = bool(payload.get("stream")) and self.streaming_enabled
        if not text or len(text) > 3000:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_text"}

        started = time.perf_counter()
        targets = self._clean_targets(reply_targets)
        try:
            provider_id = await self.context.get_current_chat_provider_id(session_id)
            prompt = prompt_override or (f"{nickname}: {text}" if nickname else text)
            memory_started = time.perf_counter()
            memory_context = await self._build_livingmemory_context(room_id, messages, module_memory_events, reply_mode, context_policy)
            memory_recall_ms = int((time.perf_counter() - memory_started) * 1000)
            if memory_context:
                prompt = f"{prompt}\n\n{memory_context}"
            active_prompt_context = self._format_active_context(active_context)
            if active_prompt_context:
                prompt = f"{prompt}\n\n{active_prompt_context}"
            context_started = time.perf_counter()
            knowledge_context = await self._build_knowledge_lookup_context(text, messages, reply_mode, context_policy)
            if knowledge_context:
                prompt = f"{prompt}\n\n{knowledge_context}"
            short_term_context = self._build_short_term_context(context_summary, recent_context)
            if short_term_context:
                prompt = f"{prompt}\n\n{short_term_context}"
            module_prompt_context = self._format_module_prompt_context(module_context, module_events)
            if module_prompt_context:
                prompt = f"{prompt}\n\n{module_prompt_context}"
            context_load_ms = int((time.perf_counter() - context_started) * 1000)

            if reply_mode == "proactive_idle":
                prompt = f"{prompt}\n\n{self._build_proactive_idle_instruction()}"
            elif targets:
                prompt = f"{prompt}\n\n这次优先回应：{' '.join('@' + name for name in targets)}。如果你是在回答其中某个人，请用对应的 @昵称 开头。"
            elif force_reply:
                prompt = f"{prompt}\n\n现在只有一位特殊网友在线，请自然回应对方刚才的话；即使没有直接 @ 你，也不要沉默。回复保持温暖、简短、像正常聊天。"
            else:
                should_reply, judge_payload = await self._judge_proactive_reply(room_id, prompt, messages)
                if not should_reply:
                    skipped_payload = {
                        "ok": True,
                        "skipped": True,
                        "source": "heartflow_judge",
                        "judge": judge_payload,
                        "latency_ms": int((time.perf_counter() - started) * 1000),
                        "route": reply_route,
                        "latency_trace_id": latency_trace_id,
                        "latency_breakdown": {
                            "memory_recall_ms": memory_recall_ms,
                            "context_load_ms": context_load_ms,
                            "llm_total_ms": 0,
                            "total_ms": int((time.perf_counter() - started) * 1000),
                        },
                    }
                    if stream_reply:
                        return self._stream_response(self._single_stream_event("skipped", skipped_payload))
                    return HTTPStatus.OK, skipped_payload
                prompt = f"{prompt}\n\n这是一次主动开口。没有人直接叫你；只有在话题、关系或现场气氛真的适合 Hoshia 接一句时才回复。不要为了证明自己在场而填补安静。"

            if stream_reply:
                return self._stream_response(self._stream_llm_reply(
                    provider_id=provider_id,
                    prompt=prompt,
                    started=started,
                    memory_recall_ms=memory_recall_ms,
                    context_load_ms=context_load_ms,
                    room_id=room_id,
                    messages=messages,
                    module_memory_events=module_memory_events,
                    reply_route=reply_route,
                    latency_trace_id=latency_trace_id,
                ))

            llm_started = time.perf_counter()
            llm_response = await self.context.llm_generate(
                chat_provider_id=provider_id,
                prompt=prompt,
                system_prompt=self.system_prompt or None,
            )
            llm_total_ms = int((time.perf_counter() - llm_started) * 1000)
            reply_text = str(getattr(llm_response, "completion_text", "") or "").strip()
            if not reply_text:
                return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "empty_llm_response"}
            if self.livingmemory_enabled and self.livingmemory_auto_summary_enabled:
                asyncio.create_task(self._summarize_and_store_viewer_memories(provider_id, room_id, messages, reply_text, module_memory_events))
            total_ms = int((time.perf_counter() - started) * 1000)
            logger.info(
                "[live-room-bridge] reply_latency "
                f"trace={latency_trace_id or '-'} route={reply_route or '-'} "
                f"memory_recall_ms={memory_recall_ms} context_load_ms={context_load_ms} "
                f"llm_total_ms={llm_total_ms} total_ms={total_ms}"
            )
            return HTTPStatus.OK, {
                "ok": True,
                "text": reply_text,
                "state": "SPEAKING",
                "source": "astrbot",
                "latency_ms": total_ms,
                "route": reply_route,
                "latency_trace_id": latency_trace_id,
                "latency_breakdown": {
                    "memory_recall_ms": memory_recall_ms,
                    "context_load_ms": context_load_ms,
                    "llm_first_token_ms": llm_total_ms,
                    "llm_total_ms": llm_total_ms,
                    "total_ms": total_ms,
                },
            }
        except Exception as exc:
            logger.error(f"[live-room-bridge] llm failed: {exc}", exc_info=True)
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "llm_failed"}

    def _stream_response(self, events: Any) -> dict[str, Any]:
        return {"_live_room_stream": True, "status": HTTPStatus.OK, "events": events}

    async def _single_stream_event(self, event_type: str, payload: dict[str, Any]):
        event = {"type": event_type, **payload}
        yield event

    async def _stream_llm_reply(
        self,
        *,
        provider_id: str,
        prompt: str,
        started: float,
        memory_recall_ms: int,
        context_load_ms: int,
        room_id: str,
        messages: Any,
        module_memory_events: Any,
        reply_route: str,
        latency_trace_id: str,
    ):
        llm_started = time.perf_counter()
        first_token_ms: int | None = None
        chunks: list[str] = []
        final_text = ""
        sent_any_delta = False
        last_stream_text = ""
        stream_text_is_cumulative = True
        try:
            provider = self.context.get_provider_by_id(provider_id)
            if hasattr(provider, "__await__"):
                provider = await provider
            stream_fn = getattr(provider, "text_chat_stream", None) if provider else None
            if not callable(stream_fn):
                async for event in self._stream_fallback_llm_reply(
                    provider_id=provider_id,
                    prompt=prompt,
                    started=started,
                    llm_started=llm_started,
                    memory_recall_ms=memory_recall_ms,
                    context_load_ms=context_load_ms,
                    room_id=room_id,
                    messages=messages,
                    module_memory_events=module_memory_events,
                    reply_route=reply_route,
                    latency_trace_id=latency_trace_id,
                    reason="stream_unavailable",
                ):
                    yield event
                return

            async for chunk in stream_fn(
                prompt=prompt,
                system_prompt=self.system_prompt or None,
                contexts=None,
            ):
                text = str(getattr(chunk, "completion_text", "") or "")
                if text:
                    chunk_marker = getattr(chunk, "is_chunk", None)
                    if chunk_marker is False and sent_any_delta:
                        final_text = text
                        continue
                    is_cumulative_update = text.startswith(last_stream_text)
                    if sent_any_delta and not is_cumulative_update:
                        stream_text_is_cumulative = False
                    delta_text = text[len(last_stream_text):] if is_cumulative_update else text
                    if delta_text:
                        chunks.append(delta_text)
                        sent_any_delta = True
                        if first_token_ms is None:
                            first_token_ms = int((time.perf_counter() - llm_started) * 1000)
                        yield {
                            "type": "delta",
                            "ok": True,
                            "text": delta_text,
                            "is_chunk": True,
                            "route": reply_route,
                            "latency_trace_id": latency_trace_id,
                        }
                    last_stream_text = text

            final_text = final_text or (last_stream_text if stream_text_is_cumulative and last_stream_text else "".join(chunks))
            final_text = final_text.strip()
            if not final_text:
                if sent_any_delta:
                    yield {"type": "error", "ok": False, "error": "empty_llm_response", "route": reply_route, "latency_trace_id": latency_trace_id}
                    return
                async for event in self._stream_fallback_llm_reply(
                    provider_id=provider_id,
                    prompt=prompt,
                    started=started,
                    llm_started=llm_started,
                    memory_recall_ms=memory_recall_ms,
                    context_load_ms=context_load_ms,
                    room_id=room_id,
                    messages=messages,
                    module_memory_events=module_memory_events,
                    reply_route=reply_route,
                    latency_trace_id=latency_trace_id,
                    reason="empty_stream",
                ):
                    yield event
                return

            llm_total_ms = int((time.perf_counter() - llm_started) * 1000)
            if first_token_ms is None:
                first_token_ms = llm_total_ms
            if self.livingmemory_enabled and self.livingmemory_auto_summary_enabled:
                asyncio.create_task(self._summarize_and_store_viewer_memories(provider_id, room_id, messages, final_text, module_memory_events))
            total_ms = int((time.perf_counter() - started) * 1000)
            breakdown = {
                "memory_recall_ms": memory_recall_ms,
                "context_load_ms": context_load_ms,
                "llm_first_token_ms": first_token_ms,
                "llm_total_ms": llm_total_ms,
                "total_ms": total_ms,
            }
            logger.info(
                "[live-room-bridge] reply_latency "
                f"trace={latency_trace_id or '-'} route={reply_route or '-'} "
                f"memory_recall_ms={memory_recall_ms} context_load_ms={context_load_ms} "
                f"llm_first_token_ms={first_token_ms} llm_total_ms={llm_total_ms} total_ms={total_ms}"
            )
            yield {
                "type": "done",
                "ok": True,
                "text": final_text,
                "state": "SPEAKING",
                "source": "astrbot",
                "latency_ms": total_ms,
                "route": reply_route,
                "latency_trace_id": latency_trace_id,
                "latency_breakdown": breakdown,
                "streamed": sent_any_delta,
            }
        except Exception as exc:
            logger.error(f"[live-room-bridge] stream llm failed: {exc}", exc_info=True)
            if sent_any_delta:
                yield {"type": "error", "ok": False, "error": "llm_failed", "route": reply_route, "latency_trace_id": latency_trace_id}
                return
            async for event in self._stream_fallback_llm_reply(
                provider_id=provider_id,
                prompt=prompt,
                started=started,
                llm_started=llm_started,
                memory_recall_ms=memory_recall_ms,
                context_load_ms=context_load_ms,
                room_id=room_id,
                messages=messages,
                module_memory_events=module_memory_events,
                reply_route=reply_route,
                latency_trace_id=latency_trace_id,
                reason="stream_failed",
            ):
                yield event

    async def _stream_fallback_llm_reply(
        self,
        *,
        provider_id: str,
        prompt: str,
        started: float,
        llm_started: float,
        memory_recall_ms: int,
        context_load_ms: int,
        room_id: str,
        messages: Any,
        module_memory_events: Any,
        reply_route: str,
        latency_trace_id: str,
        reason: str,
    ):
        llm_response = await self.context.llm_generate(
            chat_provider_id=provider_id,
            prompt=prompt,
            system_prompt=self.system_prompt or None,
        )
        llm_total_ms = int((time.perf_counter() - llm_started) * 1000)
        reply_text = str(getattr(llm_response, "completion_text", "") or "").strip()
        if not reply_text:
            yield {"type": "error", "ok": False, "error": "empty_llm_response", "route": reply_route, "latency_trace_id": latency_trace_id}
            return
        if self.livingmemory_enabled and self.livingmemory_auto_summary_enabled:
            asyncio.create_task(self._summarize_and_store_viewer_memories(provider_id, room_id, messages, reply_text, module_memory_events))
        total_ms = int((time.perf_counter() - started) * 1000)
        yield {
            "type": "done",
            "ok": True,
            "text": reply_text,
            "state": "SPEAKING",
            "source": "astrbot",
            "latency_ms": total_ms,
            "route": reply_route,
            "latency_trace_id": latency_trace_id,
            "latency_breakdown": {
                "memory_recall_ms": memory_recall_ms,
                "context_load_ms": context_load_ms,
                "llm_first_token_ms": llm_total_ms,
                "llm_total_ms": llm_total_ms,
                "total_ms": total_ms,
            },
            "streamed": False,
            "stream_fallback_reason": reason,
        }

    def _config_bool(self, key: str, fallback: bool) -> bool:
        value = self.config.get(key, fallback)
        if isinstance(value, bool):
            return value
        if value is None:
            return fallback
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _config_list(self, key: str) -> list[str]:
        value = self.config.get(key, [])
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return [item.strip() for item in str(value or "").split(",") if item.strip()]

    def _build_short_term_context(self, context_summary: str, recent_context: Any) -> str:
        sections: list[str] = []
        summary = str(context_summary or "").strip()
        if summary:
            sections.append(
                "稍早前的聊天摘要。只当作背景，更新的发言优先：\n"
                + summary[:4000]
            )

        lines = []
        for item in self._clean_context_messages(recent_context)[-120:]:
            role = "Hoshia" if item["role"] == "ai" else (item["nickname"] or "viewer")
            user_suffix = f" ({item['user_id']})" if item["user_id"] and item["role"] != "ai" else ""
            color_suffix = f" color={item['color']}" if item["color"] and item["role"] != "ai" else ""
            timestamp = f"[{item['timestamp']}] " if item["timestamp"] else ""
            lines.append(f"- {timestamp}{role}{user_suffix}{color_suffix}: {item['text']}")
        if lines:
            sections.append(
                "最近聊天记录。涉及刚才说了什么时，以这里为准：\n"
                + "\n".join(lines)
            )

        if not sections:
            return ""
        return (
            "本次回复可参考的短期聊天背景。若信息冲突，最近聊天记录优先于稍早摘要和过往偏好。\n"
            + "\n\n".join(sections)
        )

    def _clean_active_context(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        context: dict[str, Any] = {}
        for key, limit in {
            "current_state": 220,
            "current_activity": 220,
            "current_diary_event": 240,
            "active_event": 220,
            "current_viewer": 220,
            "recent_user_memory": 220,
            "tone_bias": 160,
        }.items():
            text = self._safe_runtime_text(value.get(key), limit)
            if text:
                context[key] = text
        hooks = self._clean_text_list(value.get("chat_hooks", []), limit=3)
        if hooks:
            context["chat_hooks"] = hooks
        return context

    def _clean_context_policy(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        policy: dict[str, Any] = {}
        route = self._safe_identifier(value.get("route"), 48)
        if route:
            policy["route"] = route
        for key in ("includeLivingMemory", "include_living_memory", "includeNewsMemory", "include_news_memory", "includeKnowledgeLookup", "include_knowledge_lookup"):
            if key in value:
                policy[key] = bool(value.get(key))
        for key in ("livingMemoryK", "living_memory_k"):
            if key in value:
                try:
                    policy[key] = max(0, min(int(value.get(key)), self.livingmemory_recall_k))
                except (TypeError, ValueError):
                    policy[key] = self.livingmemory_recall_k
        return policy

    def _format_active_context(self, active_context: dict[str, Any]) -> str:
        if not active_context:
            return ""
        labels = {
            "current_state": "Current Hoshia state",
            "current_activity": "Current activity",
            "current_diary_event": "Current diary event",
            "active_event": "Current user-facing event",
            "current_viewer": "Current viewer public context",
            "recent_user_memory": "Recent user preference signal",
            "tone_bias": "Tone bias",
        }
        lines: list[str] = []
        for key, label in labels.items():
            value = str(active_context.get(key, "")).strip()
            if value:
                lines.append(f"- {label}: {value}")
        hooks = active_context.get("chat_hooks")
        if isinstance(hooks, list):
            for index, hook in enumerate(hooks[:3]):
                text = str(hook or "").strip()
                if text:
                    lines.append(f"- Chat hook {index + 1}: {text}")
        if not lines:
            return ""
        return (
            "当前状态参考。只用于把握语气和连续性，不要念出标题、字段名或后台机制。\n"
            + "\n".join(lines)
        )

    def _clean_context_messages(self, value: Any) -> list[dict[str, str]]:
        if not isinstance(value, list):
            return []
        messages: list[dict[str, str]] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", "")).strip()
            if not text:
                continue
            role = str(item.get("role", "")).strip().lower()
            if role not in {"user", "ai"}:
                role = "user"
            messages.append({
                "role": role,
                "user_id": str(item.get("user_id", "")).strip()[:80],
                "nickname": str(item.get("nickname", "")).strip()[:32],
                "color": self._safe_public_color(item.get("color")),
                "text": text[:500],
                "timestamp": str(item.get("timestamp", "")).strip()[:40],
            })
        return messages

    def _safe_public_color(self, value: Any) -> str:
        text = str(value or "").strip()
        if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
            return text.upper()
        return ""

    def _clean_module_context(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        contexts: list[dict[str, Any]] = []
        for item in value[:12]:
            if not isinstance(item, dict):
                continue
            module_id = self._safe_identifier(item.get("module_id"), 48)
            if not module_id:
                continue
            contexts.append({
                "module_id": module_id,
                "enabled": bool(item.get("enabled")),
                "current_state": self._clean_text_list(item.get("current_state", []), limit=12),
                "capabilities": self._clean_text_list(item.get("capabilities", []), limit=12),
                "limits": self._clean_text_list(item.get("limits", []), limit=12),
            })
        return contexts

    def _clean_module_events(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        events: list[dict[str, Any]] = []
        for item in value[:80]:
            if not isinstance(item, dict):
                continue
            module_id = self._safe_identifier(item.get("module_id"), 48)
            event_type = self._safe_identifier(item.get("event_type"), 80)
            summary_hint = self._safe_runtime_text(item.get("summary_hint"), 240)
            if not module_id or not event_type or not summary_hint:
                continue
            events.append({
                "module_id": module_id,
                "event_type": event_type,
                "user_id": self._safe_runtime_text(item.get("user_id"), 80),
                "nickname": self._safe_runtime_text(item.get("nickname"), 32),
                "summary_hint": summary_hint,
                "memory_eligible": bool(item.get("memory_eligible")),
                "memory_kind": self._safe_identifier(item.get("memory_kind") or "module_event", 80),
                "retention_days": self._safe_retention_days(item.get("retention_days")),
                "occurred_at": self._safe_runtime_text(item.get("occurred_at"), 40),
                "data": self._clean_module_event_data(item.get("data")),
            })
        return events

    def _clean_module_event_data(self, value: Any) -> dict[str, str]:
        if not isinstance(value, dict):
            return {}
        data: dict[str, str] = {}
        allowed_fields = {
            "title": 120,
            "artist": 120,
            "source": 40,
            "category": 40,
            "topic": 120,
            "matched_alias": 120,
            "source_kind": 40,
            "class_id": 80,
            "class_name": 120,
            "stage_id": 80,
            "state_activity": 80,
            "state_mood": 80,
            "difficulty_tier": 40,
            "result": 40,
            "waves_cleared": 40,
            "boss_result": 40,
            "duration_seconds": 40,
            "score_tier": 40,
            "rank_tier": 40,
            "unlock_reason": 160,
        }
        for key, limit in allowed_fields.items():
            text = self._safe_module_event_data_text(value.get(key), limit)
            if text:
                data[key] = text
        if data.get("source_kind") not in {"local", "search", None}:
            data.pop("source_kind", None)
        return data

    def _format_module_prompt_context(self, module_context: list[dict[str, Any]], module_events: list[dict[str, Any]]) -> str:
        sections: list[str] = []
        for index, module in enumerate(module_context, start=1):
            lines = [f"可用能力 {index}：" if module["enabled"] else f"暂不可用能力 {index}："]
            if module["current_state"]:
                lines.append("当前情况：")
                lines.extend(f"- {line}" for line in module["current_state"][:12])
            if module["capabilities"]:
                lines.append("你现在可以自然回应的能力：")
                lines.extend(f"- {line}" for line in module["capabilities"][:8])
            if module["limits"]:
                lines.append("需要避免误说的限制：")
                lines.extend(f"- {line}" for line in module["limits"][:8])
            sections.append("\n".join(lines))

        event_lines = []
        for event in module_events[:24]:
            actor = event["nickname"] or event["user_id"] or "网友"
            timestamp = f"[{event['occurred_at']}] " if event["occurred_at"] else ""
            data_text = self._module_event_data_text(event)
            suffix = f"；{data_text}" if data_text else ""
            event_lines.append(f"- {timestamp}{actor}: {event['summary_hint']}{suffix}")
        if event_lines:
            sections.append("最近互动信号：\n" + "\n".join(event_lines))

        if not sections:
            return ""
        return (
            "当前小房间状态参考。只把它当作你能感知到的状态和网友行为信号。"
            "不要说出后台字段名、接口名、令牌、路径、IP、服务地址或配置。"
            "涉及音乐时，只评价当前播放、队列和最近点歌；不要声称自己能看到完整曲库。\n"
            + "\n\n".join(sections)
        )

    def _safe_identifier(self, value: Any, limit: int) -> str:
        return re.sub(r"[^a-zA-Z0-9_.:-]", "_", str(value or "").strip())[:limit]

    def _safe_runtime_text(self, value: Any, limit: int) -> str:
        text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()[:limit]
        if re.search(r"(?:\.env|BEGIN [A-Z ]*PRIVATE KEY|ssh-|token=|password=|secret=)", text, re.IGNORECASE):
            return ""
        return text

    def _safe_module_event_data_text(self, value: Any, limit: int) -> str:
        if value is None or isinstance(value, (dict, list, tuple, set)):
            return ""
        text = self._safe_runtime_text(str(value), limit)
        if not text or self._has_forbidden_module_event_detail(text):
            return ""
        return text

    def _has_forbidden_module_event_detail(self, text: str) -> bool:
        forbidden_patterns = (
            r"\b(?:https?|wss?|ftp|file)://",
            r"\bwww\.",
            r"\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cn|top|xyz|me|cloud|site|online|local|lan|internal)\b",
            r"(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|/(?:home|root|etc|var|usr|opt|srv|tmp|mnt|run|proc|sys|dev|workspace|Users?)(?:/|$))",
            r"(?:^|\s)\.?[A-Za-z0-9_.-]+\.(?:env|pem|key|crt|sqlite|db|log)(?:\b|$)",
            r"\b(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|::1)\b",
            r"\b[a-z][a-z0-9_-]{1,63}:\d{2,5}\b",
            r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bridge[_-]?token|token|password|passwd|secret|authorization)\b\s*[:=]",
            r"\b(?:api\s*key|api[_-]?key|access[_-]?token|refresh[_-]?token|bridge[_-]?token|token|password|passwd|secret|authorization)\b\s+[a-z0-9._-]{4,}",
            r"\b(?:secret|token|api[_-]?key)[-_][a-z0-9._-]{4,}\b",
            r"\bbearer\s+[a-z0-9._-]+",
            r"\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b",
        )
        return any(re.search(pattern, text, re.IGNORECASE) for pattern in forbidden_patterns)

    def _safe_retention_days(self, value: Any) -> int:
        try:
            return max(1, min(int(value), 365))
        except (TypeError, ValueError):
            return self.livingmemory_recent_state_retention_days

    def _module_event_data_text(self, event: dict[str, Any]) -> str:
        data = event.get("data")
        if not isinstance(data, dict):
            return ""
        parts = []
        title = str(data.get("title", "")).strip()
        artist = str(data.get("artist", "")).strip()
        if title:
            parts.append(f"歌曲《{title}》")
        if artist:
            parts.append(f"歌手 {artist}")
        if not parts:
            for key, label in (
                ("class_name", "职业"),
                ("class_id", "职业代号"),
                ("stage_id", "关卡"),
                ("state_activity", "状态"),
                ("state_mood", "氛围"),
                ("difficulty_tier", "难度"),
                ("result", "结果"),
                ("waves_cleared", "清理波次"),
                ("boss_result", "Boss"),
                ("duration_seconds", "时长秒数"),
                ("score_tier", "分数档"),
                ("rank_tier", "评级"),
                ("unlock_reason", "解锁原因"),
            ):
                value = str(data.get(key, "")).strip()
                if value:
                    parts.append(f"{label} {value}")
            if parts:
                return "，".join(parts)[:320]
            for key in ("source",):
                value = str(data.get(key, "")).strip()
                if value:
                    parts.append(value)
        return "，".join(parts)[:320]

    def _livingmemory_star(self) -> Any | None:
        try:
            metadata = self.context.get_registered_star("astrbot_plugin_livingmemory")
            return getattr(metadata, "star_cls", None) if metadata else None
        except Exception as exc:
            logger.debug(f"[live-room-bridge] LivingMemory lookup failed: {exc}")
            return None

    def _livingmemory_engine(self) -> Any | None:
        star = self._livingmemory_star()
        initializer = getattr(star, "initializer", None)
        if not getattr(initializer, "is_initialized", False):
            return None
        return getattr(initializer, "memory_engine", None)

    def _viewer_session_id(self, room_id: str, user_id: str) -> str:
        safe_room = re.sub(r"[^a-zA-Z0-9_.:-]", "-", room_id)[:80] or "live-room"
        safe_user = re.sub(r"[^a-zA-Z0-9_.:-]", "-", user_id)[:80] or "unknown"
        return f"live-room:{safe_room}:user:{safe_user}"

    def _news_session_id(self, room_id: str) -> str:
        safe_room = re.sub(r"[^a-zA-Z0-9_.:-]", "-", room_id)[:80] or "live-room"
        return f"live-room:{safe_room}:news"

    def _selected_viewers(self, messages: Any, module_events: Any | None = None) -> list[dict[str, str]]:
        selected: list[dict[str, str]] = []
        seen: set[str] = set()
        message_items = messages if isinstance(messages, list) else []
        ordered = sorted(
            [item for item in message_items if isinstance(item, dict)],
            key=lambda item: 0 if item.get("mentioned") else 1,
        )
        for item in ordered:
            user_id = str(item.get("user_id", "")).strip()
            text = str(item.get("text", "")).strip()
            if item.get("memory_enabled") is False or not user_id or not text or user_id in seen:
                continue
            seen.add(user_id)
            selected.append({
                "user_id": user_id,
            "nickname": str(item.get("nickname", "网友")).strip()[:32] or "网友",
                "query": text[:300],
            })
            if len(selected) >= self.livingmemory_max_participants:
                break
        if len(selected) < self.livingmemory_max_participants and isinstance(module_events, list):
            for event in module_events:
                if not isinstance(event, dict) or not event.get("memory_eligible"):
                    continue
                user_id = str(event.get("user_id", "")).strip()
                summary_hint = str(event.get("summary_hint", "")).strip()
                if not user_id or not summary_hint or user_id in seen:
                    continue
                seen.add(user_id)
                selected.append({
                    "user_id": user_id,
                    "nickname": str(event.get("nickname", "网友")).strip()[:32] or "网友",
                    "query": summary_hint[:300],
                })
                if len(selected) >= self.livingmemory_max_participants:
                    break
        return selected

    async def _build_livingmemory_context(self, room_id: str, messages: Any, module_events: Any | None = None, reply_mode: str = "", context_policy: dict[str, Any] | None = None) -> str:
        if not self.livingmemory_enabled:
            return ""
        policy = context_policy if isinstance(context_policy, dict) else {}
        if policy.get("includeLivingMemory") is False or policy.get("include_living_memory") is False:
            return ""
        recall_k = self._livingmemory_recall_limit(policy)
        if recall_k <= 0:
            return ""
        engine = self._livingmemory_engine()
        if not engine:
            return ""

        sections: list[str] = []
        try:
            for viewer in self._selected_viewers(messages, module_events):
                memories = await engine.search_memories(
                    query=viewer["query"],
                    k=recall_k,
                    session_id=self._viewer_session_id(room_id, viewer["user_id"]),
                    persona_id=self.livingmemory_persona_id,
                )
                lines = self._format_memory_lines(memories, recall_k)
                if lines:
                    sections.append(
                        f"@{viewer['nickname']} 的已知偏好参考（只用于理解这个特殊网友，不要透露来源）：\n"
                        + "\n".join(lines)
                    )

            news_query = self._news_query(messages, reply_mode) if policy.get("includeNewsMemory", True) and policy.get("include_news_memory", True) else ""
            if news_query:
                await self._cleanup_expired_news_memories(engine, room_id)
                news_memories = await engine.search_memories(
                    query=news_query,
                    k=recall_k,
                    session_id=self._news_session_id(room_id),
                    persona_id=self.livingmemory_persona_id,
                )
                news_lines = self._format_news_memory_lines(news_memories, recall_k)
                if news_lines:
                    sections.append(
                        "近期话题灵感参考（不代表任何网友个人偏好）：\n"
                        + "\n".join(news_lines)
                    )
        except Exception as exc:
            logger.warning(f"[live-room-bridge] LivingMemory recall skipped: {exc}")
            return ""

        if not sections:
            return ""
        return "可参考的网友偏好与近期话题：\n" + "\n\n".join(sections)

    def _livingmemory_recall_limit(self, policy: dict[str, Any]) -> int:
        for key in ("livingMemoryK", "living_memory_k"):
            if key in policy:
                try:
                    return max(0, min(int(policy.get(key)), self.livingmemory_recall_k))
                except (TypeError, ValueError):
                    return self.livingmemory_recall_k
        return self.livingmemory_recall_k

    def _format_memory_lines(self, memories: Any, recall_k: int | None = None) -> list[str]:
        lines: list[str] = []
        limit = max(1, min(int(recall_k or self.livingmemory_recall_k), self.livingmemory_recall_k))
        for memory in list(memories or []):
            metadata = self._memory_metadata(memory)
            if self._viewer_memory_expired(metadata):
                continue
            content = str(getattr(memory, "content", "") or "").strip()
            if not content:
                continue
            lines.append(f"- {content[:280]}")
            if len(lines) >= limit:
                break
        return lines

    def _format_news_memory_lines(self, memories: Any, recall_k: int | None = None) -> list[str]:
        lines: list[str] = []
        now = time.time()
        limit = max(1, min(int(recall_k or self.livingmemory_recall_k), self.livingmemory_recall_k))
        for memory in list(memories or []):
            metadata = self._memory_metadata(memory)
            if self._news_memory_expired(metadata, now):
                continue
            content = str(getattr(memory, "content", "") or "").strip()
            if not content:
                continue
            lines.append(f"- {content[:280]}")
            if len(lines) >= limit:
                break
        return lines

    def _news_query(self, messages: Any, reply_mode: str = "") -> str:
        if not isinstance(messages, list):
            return ""
        parts = []
        for item in messages[-5:]:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", "")).strip()
            if text:
                parts.append(text[:160])
        query = " ".join(parts)[:500]
        if reply_mode == "proactive_idle":
            proactive_seed = "today light campus chat topic university life entertainment games music movies Bilibili trending low-pressure social"
            return f"{query} {proactive_seed}".strip()[:500] if query else proactive_seed
        if not query:
            return ""
        if re.search(r"(今天|最近|新闻|热搜|热点|新鲜事|发生什么|AI|人工智能|科技|游戏|B站|b站|娱乐|GitHub|开源|模型|话题)", query, re.IGNORECASE):
            return query
        return ""

    def _build_proactive_idle_instruction(self) -> str:
        return """
主动开口提示：
- 现在至少有一位特殊网友在线，小房间刚刚比较安静；你可以先轻轻开一个话题。
- 只输出 Hoshia 要说的话，中文，1-2 个短句，最多 90 个中文字符。
- 优先使用今天的日常状态、最近经历、日记摘要或兴趣钩子；不合适时，再参考新闻、音乐、最近聊天、网友偏好或时间氛围。
- 这句话必须带一个具体、容易接的话题点，例如舞台小记、游戏选择、循环的歌、课业/工作细节或兴趣线索。
- 可以把日常设定轻轻扩展成角色内的小细节，但不要说成真实旅行、外部新闻、私下浏览或现实成就。
- 可以顺便问对方在做什么，但不能只问这一句；要附带具体话题钩子。
- 如果参考新闻，要变成朋友间闲聊问题；不要像播报新闻，不要复读标题，避开沉重、高风险、医疗、法律、投资或强争议话题。
- 不要只说小房间很安静、让对方坐着陪你，或只说自己在。
- 不要说你检测到了沉默。不要责备对方。不要问客服式问题。
- 不要重复最近主动开口用过的话题或结构。
""".strip()

    async def _summarize_and_store_viewer_memories(self, provider_id: str, room_id: str, messages: Any, reply_text: str, module_events: Any | None = None):
        try:
            engine = self._livingmemory_engine()
            if not engine:
                return
            message_items = messages if isinstance(messages, list) else []
            for viewer in self._selected_viewers(messages, module_events):
                viewer_lines = [
                    str(item.get("text", "")).strip()
                    for item in message_items
                    if isinstance(item, dict) and str(item.get("user_id", "")).strip() == viewer["user_id"] and str(item.get("text", "")).strip()
                ]
                viewer_events = self._module_events_for_viewer(module_events, viewer["user_id"])
                if not viewer_lines and not viewer_events:
                    continue
                summary_prompt = self._build_memory_summary_prompt(viewer["nickname"], viewer_lines, reply_text, viewer_events) + "\n\n" + self._memory_type_summary_instruction()
                llm_response = await self.context.llm_generate(
                    chat_provider_id=provider_id,
                    prompt=summary_prompt,
                    system_prompt="You extract durable memory facts for Hoshia. Return only JSON.",
                )
                data = _extract_json(str(getattr(llm_response, "completion_text", "") or ""))
                memories = data.get("memories", [])
                if not isinstance(memories, list):
                    continue
                for item in memories[:3]:
                    if not isinstance(item, dict):
                        continue
                    content = str(item.get("memory", "")).strip()
                    if len(content) < 8:
                        continue
                    importance = self._clamp_importance(item.get("importance", 0.65))
                    topics = self._clean_text_list(item.get("topics", []))
                    key_facts = self._clean_text_list(item.get("key_facts", []))
                    memory_type = self._clean_memory_type(item.get("memory_type"))
                    retention_days = self._memory_retention_days(memory_type, item.get("retention_days"))
                    expires_at = self._expires_at_iso(retention_days) if retention_days else ""
                    viewer_session_id = self._viewer_session_id(room_id, viewer["user_id"])
                    if await self._is_duplicate_viewer_memory(engine, content, viewer_session_id):
                        continue
                    metadata = {
                        "memory_origin": "hoshia_live_room_bridge",
                        "source": "viewer_auto_summary",
                        "viewer_user_id": viewer["user_id"],
                        "viewer_nickname": viewer["nickname"],
                        "memory_type": memory_type,
                        "topics": topics,
                        "key_facts": key_facts,
                        "sentiment": str(item.get("sentiment", "neutral"))[:32],
                        "create_reason": str(item.get("reason", "stable viewer fact"))[:160],
                    }
                    if retention_days:
                        metadata["retention_days"] = retention_days
                    if expires_at:
                        metadata["expires_at"] = expires_at
                    await engine.add_memory(
                        content=content[:500],
                        session_id=viewer_session_id,
                        persona_id=self.livingmemory_persona_id,
                        importance=importance,
                        metadata=metadata,
                    )
        except Exception as exc:
            logger.warning(f"[live-room-bridge] LivingMemory write skipped: {exc}")

    def _module_events_for_viewer(self, module_events: Any, user_id: str) -> list[dict[str, Any]]:
        if not isinstance(module_events, list):
            return []
        events: list[dict[str, Any]] = []
        for event in module_events:
            if not isinstance(event, dict) or not event.get("memory_eligible"):
                continue
            if str(event.get("user_id", "")).strip() != user_id:
                continue
            events.append(event)
            if len(events) >= 12:
                break
        return events

    def _build_memory_summary_prompt(self, nickname: str, viewer_lines: list[str], reply_text: str, module_events: list[dict[str, Any]] | None = None) -> str:
        module_event_lines = []
        for event in list(module_events or [])[-12:]:
            when = f"[{event.get('occurred_at')}] " if event.get("occurred_at") else ""
            data_text = self._module_event_data_text(event)
            data_suffix = f"；{data_text}" if data_text else ""
            module_event_lines.append(
                f"- {when}{event.get('summary_hint', '')}；建议保留 {event.get('retention_days', self.livingmemory_recent_state_retention_days)} 天{data_suffix}"
            )
        module_event_section = "\n".join(module_event_lines) if module_event_lines else "(none)"
        return f"""
从下面聊天互动中，只提取适合长期记住的稳定事实。不要保存 Hoshia 人设、系统提示、新闻正文、临时闲聊或敏感密钥。

网友昵称：{nickname}
网友留言：
{chr(10).join('- ' + line[:300] for line in viewer_lines[-6:])}

归因到该网友的行为信号（只能作为提纯依据，不能逐条照抄成记忆）：
{module_event_section}

Hoshia 回复：
{reply_text[:500]}

只在以下情况写入：网友明确要求记住、稳定偏好、称呼/身份信息、长期约定、持续关注的话题。若网友说“你高冷一点回我/以后少说一点/我希望你温柔点”，可以写成“网友希望 Hoshia 的回复风格更高冷/更简短/更温柔”；不要写成网友本人高冷、网友喜欢高冷性格，或网友具备这种性格。
音乐/点歌事件规则：单首歌或一次点歌不要直接写长期 preference；只有明确说“我喜欢/记住”或近期多次出现相近歌手、年代、风格、氛围时，才提纯成“近期音乐口味”。默认写 recent_state 并使用 30 天左右保留；长期 preference 只用于非常稳定且明确的偏好。
如果没有值得长期记住的内容，返回 {{"memories":[]}}。
返回 ONLY JSON：
{{
  "memories": [
    {{
      "memory": "简短事实",
      "topics": ["标签"],
      "key_facts": ["依据"],
      "sentiment": "positive|neutral|negative",
      "importance": 0.0,
      "reason": "为什么值得记住"
    }}
  ]
}}
""".strip()

    def _memory_type_summary_instruction(self) -> str:
        return """
Additional JSON requirements:
- For each memory, include "memory_type": one of "preference", "identity", "agreement", "recent_state", "project_context".
- Use "recent_state" for relatively stable but temporary user context, such as what the viewer is busy with recently, current plans, recent mood/body state, stage preferences, or short-term life/work context.
- For "recent_state", include "retention_days" unless the user clearly gave a shorter time. Default to 30.
- If the viewer asks Hoshia to reply in a certain tone, store it only as a reply-style preference about Hoshia's responses, never as the viewer's own personality trait.
- Behavior signals are candidates only. Do not store a raw song list; extract compact style/artist/era/atmosphere tendencies, e.g. "recently tends toward retro pop/classic rock".
- A single song request without explicit preference usually means return {"memories": []}; multiple related requests may become "recent_state" with retention_days 30.
- Do not create memories for one-off jokes, throwaway chat, system prompts, bridge internals, tokens, credentials, or Hoshia persona text.
""".strip()

    async def _handle_music_intent(self, payload: dict[str, Any]):
        text = str(payload.get("text", "")).strip()
        if not text or len(text) > 500:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_text"}

        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
        user_id = str(payload.get("user_id", "")).strip()[:80]
        nickname = str(payload.get("nickname", "")).strip()[:32]
        music_state = self._clean_music_state(payload.get("music_state", {}))
        module_events = self._clean_module_events(payload.get("module_events", []))

        try:
            provider_id = await self.context.get_current_chat_provider_id(f"{room_id}:music-intent:{user_id or 'anonymous'}")
            llm_response = await self.context.llm_generate(
                chat_provider_id=provider_id,
                prompt=self._build_music_intent_prompt(text, nickname, music_state, module_events),
                system_prompt=(
                    "You are a strict intent classifier for Hoshia live-room music control. "
                    "Return ONLY one valid JSON object. Do not chat. Do not expose URLs, cookies, tokens, paths, or internal services."
                ),
            )
            data = _extract_json(str(getattr(llm_response, "completion_text", "") or ""))
            return HTTPStatus.OK, {"ok": True, "intent": self._normalize_music_intent(data)}
        except Exception as exc:
            logger.warning(f"[live-room-bridge] music intent failed: {exc}", exc_info=True)
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "music_intent_failed"}

    def _build_music_intent_prompt(self, text: str, nickname: str, music_state: dict[str, Any], module_events: list[dict[str, Any]]) -> str:
        queue_lines = []
        for index, track in enumerate(music_state.get("queue", [])[:10], start=1):
            requester = f" / requested_by={track.get('requested_by', '')}" if track.get("requested_by") else ""
            artist = f" - {track.get('artist', '')}" if track.get("artist") else ""
            queue_lines.append(f"{index}. {track.get('title', '')}{artist}{requester}")
        current = music_state.get("current") or {}
        current_line = "(none)"
        if current:
            artist = f" - {current.get('artist', '')}" if current.get("artist") else ""
            current_line = f"{current.get('title', '')}{artist}"
        event_lines = [f"- {event.get('summary_hint', '')}" for event in module_events[:8]]
        return f"""
Classify whether this viewer message is asking Hoshia to operate the music player.

Viewer nickname: {nickname or "viewer"}
Viewer message:
{text}

Music state:
- enabled: {music_state.get("enabled")}
- status: {music_state.get("status")}
- current: {current_line}
- queue:
{chr(10).join(queue_lines) if queue_lines else "(empty)"}

Recent music events:
{chr(10).join(event_lines) if event_lines else "(none)"}

Supported intents:
- request: viewer asks to play/request/add a song. Extract the best search query, including artist when present. Examples: "play Purple Rain by Prince" => query "Purple Rain Prince"; "request Jay Chou Nocturne" => query "Jay Chou Nocturne".
- request_many: viewer asks for multiple songs, a singer's popular songs, a style playlist, or a mood playlist. Clamp count to 1..5. For singer hot songs, use query like "周杰伦 热门". For style/mood playlists, generate 3-5 concise search queries such as ["深夜 R&B", "华语 R&B", "治愈 R&B", "慢节奏 R&B", "夜晚 情歌"] or ["city pop", "日系 city pop", "竹内玛莉亚", "山下达郎", "复古都市流行"].
- pause: asks to pause/stop temporarily.
- resume: asks to continue/resume/play current music.
- next: asks to skip/switch/cut to next song.
- remove: asks to delete queued songs. For "remove the 3rd queued song", target={{"kind":"queue_index","index":3}}. For "remove my song", target={{"kind":"requested_by_self"}}.
- status: asks what is playing or what is in the queue.
- none: not a music operation.

Rules:
- Use confidence 0..1.
- If the message is ordinary chat, lyrics discussion, or only says they like music, choose none.
- If request is vague but clearly wants one song, choose request and make a concise Chinese search query.
- If request asks for "几首", "多首", "歌单", "热门", or a number of songs, choose request_many.
- Do not invent queue indexes not mentioned by the user.
- Return ONLY JSON with this exact shape:
{{
  "intent": "request|request_many|pause|resume|next|remove|status|none",
  "confidence": 0.0,
  "query": "",
  "queries": [],
  "count": 1,
  "target": {{"kind": ""}},
  "reply_hint": ""
}}
"""

    def _clean_music_state(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {"enabled": False, "status": "idle", "current": None, "queue": []}
        return {
            "enabled": bool(value.get("enabled")),
            "status": self._safe_identifier(value.get("status") or "idle", 32),
            "current": self._clean_music_track(value.get("current")),
            "queue": [item for item in (self._clean_music_track(track) for track in list(value.get("queue") or [])[:20]) if item],
        }

    def _clean_music_track(self, value: Any) -> dict[str, str] | None:
        if not isinstance(value, dict):
            return None
        title = self._safe_runtime_text(value.get("title"), 120)
        if not title:
            return None
        return {
            "title": title,
            "artist": self._safe_runtime_text(value.get("artist"), 120),
            "requested_by": self._safe_runtime_text(value.get("requested_by"), 32),
        }

    def _normalize_music_intent(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return self._none_music_intent()
        intent = str(value.get("intent", "none")).strip().lower()
        if intent not in {"request", "request_many", "pause", "resume", "next", "remove", "status", "none"}:
            intent = "none"
        try:
            raw_confidence = float(value.get("confidence", 0) or 0)
        except (TypeError, ValueError):
            raw_confidence = 0.0
        confidence = _clamp_score(raw_confidence) / 10.0 if raw_confidence > 1 else max(0.0, min(raw_confidence, 1.0))
        target = value.get("target") if isinstance(value.get("target"), dict) else {}
        kind = str(target.get("kind", "")).strip().lower()
        if kind not in {"", "queue_index", "requested_by_self"}:
            kind = ""
        normalized_target: dict[str, Any] = {"kind": kind}
        if kind == "queue_index":
            try:
                normalized_target["index"] = max(1, min(int(target.get("index")), 100))
            except Exception:
                normalized_target = {"kind": ""}
        queries = []
        if isinstance(value.get("queries"), list):
            seen_queries: set[str] = set()
            for item in value.get("queries", [])[:8]:
                query = self._safe_runtime_text(item, 160)
                key = query.lower()
                if not query or key in seen_queries:
                    continue
                seen_queries.add(key)
                queries.append(query)
                if len(queries) >= 5:
                    break
        try:
            count = max(1, min(int(value.get("count", 1)), 5))
        except Exception:
            count = 1
        return {
            "intent": intent,
            "confidence": confidence,
            "query": self._safe_runtime_text(value.get("query"), 160),
            "queries": queries,
            "count": count,
            "target": normalized_target,
            "reply_hint": self._safe_runtime_text(value.get("reply_hint"), 160),
            "source": "astrbot_music_intent",
        }

    def _none_music_intent(self) -> dict[str, Any]:
        return {
            "intent": "none",
            "confidence": 0,
            "query": "",
            "queries": [],
            "count": 0,
            "target": {"kind": ""},
            "reply_hint": "",
            "source": "astrbot_music_intent",
        }

    async def _run_news_scheduler(self):
        if self.news_refresh_on_startup:
            await asyncio.sleep(15)
            await self._scheduled_news_refresh("startup")
        while True:
            await asyncio.sleep(self._seconds_until_next_news_refresh())
            await self._scheduled_news_refresh("scheduled")

    def _seconds_until_next_news_refresh(self) -> float:
        try:
            tz = ZoneInfo(self.news_refresh_timezone)
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("Asia/Shanghai")
        now = datetime.now(tz)
        target = now.replace(hour=self.news_refresh_hour, minute=0, second=0, microsecond=0)
        if target <= now:
            target = target + timedelta(days=1)
        return max(60.0, (target - now).total_seconds())

    async def _scheduled_news_refresh(self, reason: str):
        try:
            status, payload = await self._start_news_refresh_job({
                "room_id": self.news_room_id,
                "trigger": reason,
            })
            logger.info(
                f"[live-room-bridge] news refresh {reason} queued: status={status} "
                f"job_id={payload.get('job_id', '')} running={payload.get('running', False)}"
            )
        except Exception as exc:
            logger.warning(f"[live-room-bridge] scheduled news refresh skipped: {exc}", exc_info=True)

    async def _handle_news_refresh(self, payload: dict[str, Any]):
        return await self._start_news_refresh_job(payload)

    async def _start_news_refresh_job(self, payload: dict[str, Any]):
        if not self.news_capability_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "news_capability_disabled"}
        if not self.livingmemory_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_disabled"}
        if not self.news_source_urls:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "news_sources_not_configured"}
        if self._livingmemory_engine() is None:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_unavailable"}

        running = self._news_refresh_task and not self._news_refresh_task.done()
        if running:
            status = self._news_refresh_status_payload()
            status["accepted"] = False
            status["already_running"] = True
            return HTTPStatus.ACCEPTED, status

        self._news_refresh_job_seq += 1
        job_id = f"news-{int(time.time())}-{self._news_refresh_job_seq}"
        room_id = str(payload.get("room_id", self.news_room_id)).strip() or self.news_room_id
        date = str(payload.get("date", "")).strip()[:32] or datetime.now(timezone.utc).date().isoformat()
        self._news_refresh_status = self._new_news_refresh_status(job_id, room_id)
        self._news_refresh_status.update({
            "date": date,
            "trigger": str(payload.get("trigger", "manual"))[:60],
            "running": True,
            "stage": "queued",
        })
        self._news_refresh_task = asyncio.create_task(self._run_news_refresh_job(dict(payload), job_id))
        status = self._news_refresh_status_payload()
        status["accepted"] = True
        return HTTPStatus.ACCEPTED, status

    async def _run_news_refresh_job(self, payload: dict[str, Any], job_id: str):
        try:
            status, result = await self._refresh_news_topics(payload)
            if status == HTTPStatus.OK and result.get("ok"):
                self._news_set_stage("done")
                self._news_refresh_status.update({
                    "ok": True,
                    "last_error": "",
                    "source_count": result.get("source_count", 0),
                    "item_count": result.get("item_count", 0),
                    "topic_count": result.get("topic_count", 0),
                    "stored_count": result.get("stored_count", 0),
                    "write_errors": result.get("write_errors", 0),
                    "tavily_query_count": result.get("tavily_query_count", self._news_refresh_status.get("tavily_query_count", 0)),
                    "failed_source_count": result.get("failed_source_count", self._news_refresh_status.get("failed_source_count", 0)),
                    "recent_titles": [item.get("title", "") for item in result.get("topics", [])[:12]],
                })
            else:
                self._news_set_stage("failed")
                self._news_refresh_status.update({
                    "ok": False,
                    "last_error": str(result.get("error", "news_refresh_failed"))[:160],
                })
        except Exception as exc:
            logger.warning(f"[live-room-bridge] background news refresh failed: {exc}", exc_info=True)
            self._news_set_stage("failed")
            self._news_refresh_status.update({"ok": False, "last_error": str(exc)[:160]})
        finally:
            now = time.time()
            self._news_refresh_status["running"] = False
            self._news_refresh_status["finished_at"] = self._iso_now()
            self._news_refresh_status["latency_ms"] = int((now - float(self._news_refresh_status.get("_started_monotonic", now))) * 1000)
            logger.info(
                f"[live-room-bridge] news refresh finished: job_id={job_id} "
                f"ok={self._news_refresh_status.get('ok')} stage={self._news_refresh_status.get('stage')} "
                f"topics={self._news_refresh_status.get('topic_count', 0)} "
                f"stored={self._news_refresh_status.get('stored_count', 0)} "
                f"failed_sources={self._news_refresh_status.get('failed_source_count', 0)} "
                f"latency_ms={self._news_refresh_status.get('latency_ms', 0)}"
            )

    def _new_news_refresh_status(self, job_id: str, room_id: str) -> dict[str, Any]:
        now = time.time()
        return {
            "ok": False,
            "job_id": job_id,
            "room_id": room_id,
            "running": False,
            "stage": "idle",
            "started_at": self._iso_now(now),
            "finished_at": "",
            "latency_ms": 0,
            "source_count": 0,
            "failed_source_count": 0,
            "failed_sources": [],
            "item_count": 0,
            "topic_count": 0,
            "stored_count": 0,
            "write_errors": 0,
            "tavily_query_count": 0,
                "recent_titles": [],
            "last_error": "",
            "stage_timings_ms": {},
            "_started_monotonic": now,
            "_stage_started_monotonic": now,
        }

    def _news_refresh_status_payload(self) -> dict[str, Any]:
        payload = {
            key: value
            for key, value in self._news_refresh_status.items()
            if not key.startswith("_")
        }
        payload["capability"] = "news_topics"
        return payload

    def _news_set_stage(self, stage: str):
        now = time.time()
        previous = str(self._news_refresh_status.get("stage", "idle"))
        previous_started = float(self._news_refresh_status.get("_stage_started_monotonic", now))
        timings = self._news_refresh_status.setdefault("stage_timings_ms", {})
        if previous and previous not in {"idle", stage}:
            timings[previous] = timings.get(previous, 0) + int((now - previous_started) * 1000)
        self._news_refresh_status["stage"] = stage
        self._news_refresh_status["_stage_started_monotonic"] = now
        logger.info(f"[live-room-bridge] news refresh stage={stage} job_id={self._news_refresh_status.get('job_id', '')}")

    def _news_add_failed_source(self, reason: str):
        failed = self._news_refresh_status.setdefault("failed_sources", [])
        label = str(reason or "source_failed")[:140]
        if len(failed) < 20:
            failed.append(label)
        self._news_refresh_status["failed_source_count"] = int(self._news_refresh_status.get("failed_source_count", 0)) + 1

    def _news_increment(self, key: str, amount: int = 1):
        self._news_refresh_status[key] = int(self._news_refresh_status.get(key, 0)) + amount

    def _iso_now(self, value: float | None = None) -> str:
        return datetime.fromtimestamp(value or time.time(), timezone.utc).isoformat().replace("+00:00", "Z")

    async def _refresh_news_topics(self, payload: dict[str, Any]):
        started = time.perf_counter()
        if not self.news_capability_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "news_capability_disabled"}
        if not self.livingmemory_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_disabled"}
        if not self.news_source_urls:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "news_sources_not_configured"}
        engine = self._livingmemory_engine()
        if not engine:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_unavailable"}

        if self._news_refresh_lock.locked() and not bool(payload.get("force")):
            return HTTPStatus.CONFLICT, {"ok": False, "error": "news_refresh_in_progress"}

        async with self._news_refresh_lock:
            room_id = str(payload.get("room_id", self.news_room_id)).strip() or self.news_room_id
            date = str(payload.get("date", "")).strip()[:32] or datetime.now(timezone.utc).date().isoformat()
            await self._cleanup_expired_news_memories(engine, room_id)

            self._news_set_stage("rss_fetching")
            self._news_refresh_status["source_count"] = len(self.news_source_urls)
            raw_items = await self._fetch_news_source_items(self.news_source_urls)
            deduped_items = self._dedupe_news_items(raw_items)[:self.news_refresh_max_items]
            self._news_refresh_status["item_count"] = len(deduped_items)
            if not deduped_items:
                return HTTPStatus.BAD_GATEWAY, {
                    "ok": False,
                    "error": "news_sources_empty",
                    "source_count": len(self.news_source_urls),
                    "latency_ms": int((time.perf_counter() - started) * 1000),
                }

            self._news_set_stage("tavily_enriching")
            enriched_items = await self._enrich_news_items_with_tavily(deduped_items)
            self._news_set_stage("llm_editing")
            topics = await self._build_news_topics_with_llm(room_id, date, enriched_items)
            self._news_refresh_status["topic_count"] = len(topics)
            self._news_set_stage("memory_writing")
            store_result = await self._store_news_topics(engine, room_id, date, topics)
            stored = store_result["stored_count"]
            write_errors = store_result["write_errors"]
            return HTTPStatus.OK, {
                "ok": True,
                "capability": "news_topics",
                "source_count": len(self.news_source_urls),
                "failed_source_count": self._news_refresh_status.get("failed_source_count", 0),
                "item_count": len(deduped_items),
                "topic_count": len(topics),
                "stored_count": stored,
                "write_errors": write_errors,
                "tavily_query_count": self._news_refresh_status.get("tavily_query_count", 0),
                "topics": [
                    {
                        "title": topic.get("title", ""),
                        "category": topic.get("category", ""),
                        "tags": topic.get("tags", []),
                    }
                    for topic in topics[:8]
                ],
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }

    async def _fetch_news_source_items(self, urls: list[str]) -> list[dict[str, str]]:
        tasks = [self._fetch_rss_feed(url) for url in urls[:80]]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        items: list[dict[str, str]] = []
        for result in results:
            if isinstance(result, Exception):
                self._news_add_failed_source(str(result))
                continue
            items.extend(result)
        failed_count = self._news_refresh_status.get("failed_source_count", 0)
        if failed_count:
            logger.info(
                f"[live-room-bridge] RSSHub fetch summary: ok_items={len(items)} "
                f"failed_sources={failed_count}"
            )
        return items

    async def _fetch_rss_feed(self, url: str) -> list[dict[str, str]]:
        safe_url = self._safe_feed_url(url)
        if not safe_url:
            raise ValueError("invalid_feed_url")
        body = await asyncio.to_thread(self._http_get_text, safe_url, {}, self.news_refresh_timeout_seconds)
        return self._parse_feed_items(body, safe_url)

    def _safe_feed_url(self, url: str) -> str:
        text = str(url or "").strip()
        parsed = urlparse(text)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return ""
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", parsed.query[:400], ""))

    def _http_get_text(self, url: str, headers: dict[str, str], timeout: int) -> str:
        request = Request(url, headers={"User-Agent": "hoshia-live-room-bridge/0.5", **headers})
        try:
            with urlopen(request, timeout=timeout) as response:
                content_type = response.headers.get("content-type", "")
                if "text" not in content_type and "xml" not in content_type and "json" not in content_type:
                    # RSSHub often serves XML as application/rss+xml; allow unknown text-like bodies below.
                    pass
                raw = response.read(1024 * 1024)
        except URLError as exc:
            parsed = urlparse(url)
            label = f"{parsed.netloc}{parsed.path[:80]}"
            raise RuntimeError(f"fetch_failed:{label}") from exc
        return raw.decode("utf-8", errors="replace")

    def _http_post_json(self, url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        data = json.dumps(payload).encode("utf-8")
        request = Request(
            url,
            data=data,
            method="POST",
            headers={
                "User-Agent": "hoshia-live-room-bridge/0.5",
                "Content-Type": "application/json",
                **headers,
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read(1024 * 1024)
        except URLError as exc:
            raise RuntimeError("post_failed") from exc
        return json.loads(raw.decode("utf-8", errors="replace"))

    def _parse_feed_items(self, body: str, source_url: str) -> list[dict[str, str]]:
        text = str(body or "").strip()
        if not text:
            return []
        if text.startswith("{") or text.startswith("["):
            return self._parse_json_feed_items(text, source_url)
        return self._parse_xml_feed_items(text, source_url)

    def _parse_json_feed_items(self, body: str, source_url: str) -> list[dict[str, str]]:
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return []
        candidates = data.get("items") if isinstance(data, dict) else data
        if not isinstance(candidates, list):
            return []
        items: list[dict[str, str]] = []
        for item in candidates[:80]:
            if not isinstance(item, dict):
                continue
            parsed = self._news_item_from_parts(
                title=item.get("title") or item.get("name"),
                summary=item.get("summary") or item.get("description") or item.get("content"),
                link=item.get("url") or item.get("link"),
                published_at=item.get("published_at") or item.get("pubDate") or item.get("date"),
                source_url=source_url,
            )
            if parsed:
                items.append(parsed)
        return items

    def _parse_xml_feed_items(self, body: str, source_url: str) -> list[dict[str, str]]:
        try:
            root = ElementTree.fromstring(body.encode("utf-8"))
        except ElementTree.ParseError:
            return []
        entries = [node for node in root.iter() if self._xml_name(node.tag) in {"item", "entry"}]
        items: list[dict[str, str]] = []
        for entry in entries[:80]:
            parsed = self._news_item_from_xml_entry(entry, source_url)
            if parsed:
                items.append(parsed)
        return items

    def _news_item_from_xml_entry(self, entry: ElementTree.Element, source_url: str) -> dict[str, str] | None:
        values: dict[str, str] = {}
        for child in list(entry):
            name = self._xml_name(child.tag)
            if name == "link":
                values.setdefault("link", child.attrib.get("href") or (child.text or ""))
            elif name in {"title", "description", "summary", "content", "pubDate", "published", "updated"}:
                values.setdefault(name, child.text or "")
        return self._news_item_from_parts(
            title=values.get("title"),
            summary=values.get("description") or values.get("summary") or values.get("content"),
            link=values.get("link"),
            published_at=values.get("pubDate") or values.get("published") or values.get("updated"),
            source_url=source_url,
        )

    def _xml_name(self, tag: str) -> str:
        return str(tag).rsplit("}", 1)[-1]

    def _news_item_from_parts(self, title: Any, summary: Any, link: Any, published_at: Any, source_url: str) -> dict[str, str] | None:
        safe_title = self._clean_news_text(title, 160)
        if not safe_title:
            return None
        safe_summary = self._clean_news_text(summary, 360)
        safe_link = self._safe_news_link(link)
        return {
            "title": safe_title,
            "summary": safe_summary,
            "link_host": urlparse(safe_link).netloc[:80] if safe_link else "",
            "source": self._source_label(source_url),
            "source_host": urlparse(source_url).netloc[:80],
            "published_at": self._normalize_news_timestamp(published_at),
            "category": self._classify_news_item(safe_title, safe_summary, source_url),
        }

    def _clean_news_text(self, value: Any, limit: int) -> str:
        text = html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))
        text = re.sub(r"[\r\n\t]+", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return ""
        if re.search(r"(?:\.env|BEGIN [A-Z ]*PRIVATE KEY|ssh-|token=|cookie=|password=|secret=|api[_-]?key)", text, re.IGNORECASE):
            return ""
        return text[:limit]

    def _safe_news_link(self, value: Any) -> str:
        parsed = urlparse(str(value or "").strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return ""
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path[:160], "", "", ""))

    def _source_label(self, source_url: str) -> str:
        parsed = urlparse(source_url)
        path = parsed.path.strip("/").replace("/", ":")
        label = path or parsed.netloc
        return re.sub(r"[^a-zA-Z0-9_.:-]", "_", label)[:80]

    def _normalize_news_timestamp(self, value: Any) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        try:
            return parsedate_to_datetime(text).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            pass
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return text[:40]

    def _classify_news_item(self, title: str, summary: str, source_url: str) -> str:
        haystack = f"{title} {summary} {source_url}".lower()
        if re.search(r"(bilibili|b\u7ad9|\u54d4\u54e9|\u756a\u5267|\u65b0\u756a|\u52a8\u6f2b|\u6f2b\u753b|\u4e8c\u6b21\u5143|\u6e38\u620f|\u624b\u6e38|\u539f\u795e|\u5d29\u574f|anime|manga|game|steam|nintendo|taptap)", haystack):
            return "anime_game"
        if re.search(r"(\u7535\u7ade|\u8d5b\u4e8b|\u6218\u961f|kpl|lpl|valorant|lol|moba|fps|esports)", haystack):
            return "anime_game"
        if re.search(r"(\u97f3\u4e50|\u6b4c\u624b|\u4e50\u961f|\u7535\u5f71|\u5f71\u89c6|music|movie|film|band|artist)", haystack):
            return "music_movie"
        if re.search(r"(\u8dd1\u6b65|\u8bad\u7ec3|\u8fd0\u52a8|\u6821\u56ed|\u5927\u5b66|\u5bbf\u820d|\u56fe\u4e66\u9986|\u98df\u5802|campus|running|training)", haystack):
            return "sports_campus"
        if re.search(r"(\u70ed\u6897|\u68d7\u56fe|\u4e8c\u521b|\u9b3c\u755c|\u70ed\u70b9|meme|trend|viral)", haystack):
            return "light_trends"
        if re.search(r"\b(ai|llm|openai|anthropic|model|github|hacker|developer|programming|代码|模型|人工智能|开源|开发者)\b", haystack):
            return "tech_ai"
        if re.search(r"(bilibili|番剧|电影|游戏|电竞|赛事|战队|主播|直播|王者荣耀|英雄联盟|无畏契约|瓦罗兰特|原神|崩坏|明星|音乐|娱乐|anime|game|steam|nintendo|taptap)", haystack):
            return "entertainment"
        if re.search(r"(财经|股票|金融|投资|market|finance|crypto)", haystack):
            return "business"
        if re.search(r"(生活|天气|健康|城市|旅行|消费|food|travel)", haystack):
            return "life"
        return "general"

    def _dedupe_news_items(self, items: list[dict[str, str]]) -> list[dict[str, str]]:
        groups: list[dict[str, Any]] = []
        for item in items:
            key = self._normalize_news_key(item.get("title", ""))
            if not key:
                continue
            matched = None
            for group in groups:
                existing = group["key"]
                if key == existing or key in existing or existing in key or SequenceMatcher(None, key, existing).ratio() >= 0.86:
                    matched = group
                    break
            if matched:
                matched["count"] += 1
                if len(item.get("summary", "")) > len(matched["item"].get("summary", "")):
                    matched["item"]["summary"] = item.get("summary", "")
                sources = matched["item"].setdefault("sources", [])
                if item.get("source") and item["source"] not in sources:
                    sources.append(item["source"])
                continue
            clone = dict(item)
            clone["sources"] = [item.get("source", "")]
            groups.append({"key": key, "count": 1, "item": clone})
        groups.sort(
            key=lambda group: (
                self._news_priority_score(group["item"], group["count"]),
                group["count"],
                len(group["item"].get("summary", "")),
            ),
            reverse=True,
        )
        deduped = []
        for group in groups:
            item = group["item"]
            item["source_count"] = str(group["count"])
            deduped.append(item)
        return deduped

    def _news_priority_score(self, item: dict[str, str], duplicate_count: int = 1) -> int:
        source = f"{item.get('source', '')} {item.get('source_host', '')}".lower()
        title = item.get("title", "")
        summary = item.get("summary", "")
        category = item.get("category", "general")
        score = duplicate_count * 3
        if any(key in source for key in ["weibo", "baidu", "zhihu", "bilibili", "douban"]):
            score += 35
        if any(key in source for key in ["taptap", "steam", "nintendo", "epicgames"]):
            score += 32
        if any(key in source for key in ["netease", "readhub"]):
            score += 18
        if any(key in source for key in ["github", "hackernews", "producthunt", "juejin", "ithome", "36kr", "sspai", "solidot"]):
            score += 6
        if category == "entertainment":
            score += 15
        if category == "anime_game":
            score += 30
        if category == "light_trends":
            score += 24
        if category == "music_movie":
            score += 14
        if category == "sports_campus":
            score += 12
        if category == "tech_tools":
            score += 8
        if category == "life":
            score += 10
        if category == "tech_ai":
            score += 8
        if category == "business":
            score -= 8
        if re.search(r"(电竞|游戏|手游|端游|王者荣耀|英雄联盟|LOL|LPL|KPL|无畏契约|瓦罗兰特|Valorant|原神|崩坏|Steam|任天堂|主机|赛事|战队|主播|直播|B站|番剧|动漫)", f"{title} {summary}", re.IGNORECASE):
            score += 28
        if re.search(r"(大学|校园|毕业|考研|四六级|实习|社团|宿舍|课程|考试|就业|offer|学生|年轻人|奶茶|外卖|通勤|租房)", f"{title} {summary}", re.IGNORECASE):
            score += 22
        return score

    def _normalize_news_key(self, value: str) -> str:
        return re.sub(r"[\W_]+", "", str(value or "").lower())

    async def _enrich_news_items_with_tavily(self, items: list[dict[str, str]]) -> list[dict[str, Any]]:
        enriched: list[dict[str, Any]] = []
        query_budget = self.tavily_max_queries_per_refresh if self.tavily_api_key else 0
        for item in items:
            next_item: dict[str, Any] = dict(item)
            if query_budget > 0 and self._should_enrich_news_item(item):
                try:
                    self._news_increment("tavily_query_count")
                    next_item["background"] = await self._tavily_search_summary(item)
                    query_budget -= 1
                except Exception as exc:
                    logger.info(f"[live-room-bridge] Tavily enrichment skipped: {str(exc)[:120]}")
            enriched.append(next_item)
        return enriched

    def _should_enrich_news_item(self, item: dict[str, str]) -> bool:
        if len(item.get("summary", "")) < 60:
            return True
        if int(item.get("source_count", "1") or "1") > 1:
            return True
        return item.get("category") in {"tech_ai", "tech_tools", "business", "anime_game", "light_trends"}

    async def _build_knowledge_lookup_context(self, text: str, messages: Any, reply_mode: str, context_policy: dict[str, Any]) -> str:
        if not self.knowledge_lookup_enabled or not self.tavily_api_key:
            return ""
        if reply_mode in {"proactive_idle"}:
            return ""
        policy = context_policy if isinstance(context_policy, dict) else {}
        if policy.get("includeKnowledgeLookup") is False or policy.get("include_knowledge_lookup") is False:
            return ""
        query = self._knowledge_lookup_query(text, messages)
        if not query:
            return ""
        try:
            summary = await self._tavily_knowledge_lookup(query)
        except Exception as exc:
            logger.info(f"[live-room-bridge] knowledge lookup skipped: {str(exc)[:120]}")
            return ""
        if not summary:
            return ""
        return (
            "当前可聊背景（只用于回答当前作品/梗/小众名词；"
            "不要提工具名、搜索、接口、来源、链接或后台流程）：\n"
            f"- 查询词：{query}\n"
            f"- 可用信息：{summary}\n"
            "使用方式：把这些信息当作你当前能自然聊到的背景，不要说“我查了下/搜了下/资料显示”。"
            "如果对方只是提到自己在看/听/玩，只接一两点最有用的信息，再回到对方的感受；"
            "不要写成百科、影评或鉴赏报告，也不要装成深度粉丝。"
        )

    def _knowledge_lookup_query(self, text: str, messages: Any) -> str:
        source = self._latest_viewer_text(text, messages)
        if not source:
            return ""
        interest_query = self._interest_knowledge_lookup_query(source)
        if interest_query:
            return interest_query
        if len(source) > 220:
            return ""
        lowered = source.lower()
        if re.search(r"(?:\.env|token|password|secret|api[_-]?key|ssh-|私钥|密钥|服务器|后台|接口|prompt|system prompt)", lowered, re.IGNORECASE):
            return ""
        if re.search(r"(你是谁|你是不是|是不是ai|ai吗|模型|大模型|机器人|人设|设定|系统|开发|部署|报错)", source, re.IGNORECASE):
            return ""
        cue = re.search(
            r"(?:在看|正在看|刚看|想看|补番|追番|在听|正在听|刚听|在玩|正在玩|刚玩|听说过|知道|了解|是什么|讲什么|好看吗|好玩吗|推荐吗|有意思吗|没听过|没看过|没玩过|不认识|刷到|看到|提到)\s*[《「“\"]?([^》」”\"，。！？!?、\n]{2,40})",
            source,
            re.IGNORECASE,
        )
        query = cue.group(1).strip(" ：:，,。.!！?？《》「」“”\"'") if cue else ""
        if not query:
            title = re.search(r"[《「“\"]([^》」”\"]{2,40})[》」”\"]", source)
            query = title.group(1).strip() if title else ""
        if not query and re.search(r"(是什么|讲什么|好看吗|好玩吗|听说过|了解|知道)", source):
            query = re.sub(r"(你|Hoshia|星娅|知道|了解|听说过|是什么|讲什么|好看吗|好玩吗|吗|嘛|呀|啊|呢|？|\?)", " ", source)
            query = re.sub(r"\s+", " ", query).strip(" ：:，,。.!！?？《》「」“”\"'")
        if not query:
            return ""
        query = re.sub(r"\s+", " ", query).strip()
        query = re.sub(r"(吗|嘛|呀|啊|呢|么|吧)$", "", query).strip()
        if len(query) < 2 or len(query) > 60:
            return ""
        if re.search(r"(今天|最近|现在|这里|这个|那个|回复|高冷|温柔|陪我|睡觉|吃饭|作业|心情|喜欢我)", query):
            return ""
        return query[:60]

    def _interest_knowledge_lookup_query(self, source: str) -> str:
        text = str(source or "").strip()
        if not text or len(text) > 220:
            return ""
        lowered = text.lower()
        blocked = [
            "prompt", "system prompt", "backend", "token", "api key", "password", "secret",
            "\u540e\u53f0", "\u63a5\u53e3", "\u5bc6\u94a5", "\u4ee4\u724c", "\u7cfb\u7edf\u63d0\u793a"
        ]
        if any(item in lowered for item in blocked):
            return ""
        identity_blocked = [
            "\u4f60\u662f\u8c01", "\u4f60\u662fai", "\u4f60\u662f AI", "\u4eba\u8bbe", "\u8bbe\u5b9a"
        ]
        if any(item.lower() in lowered for item in identity_blocked):
            return ""
        interest_cues = [
            "anime", "manga", "game", "movie", "film", "music", "song", "artist", "tool", "model",
            "bilibili", "meme", "trend", "valorant", "genshin",
            "\u756a", "\u52a8\u6f2b", "\u6f2b\u753b", "\u65b0\u756a", "\u4e8c\u6b21\u5143", "\u89d2\u8272",
            "\u6e38\u620f", "\u624b\u6e38", "\u7535\u7ade", "\u7535\u5f71", "\u97f3\u4e50", "\u6b4c",
            "\u5de5\u5177", "\u5927\u6a21\u578b", "\u70ed\u6897", "\u68d7", "\u70ed\u70b9", "b\u7ad9", "B\u7ad9"
        ]
        question_cues = [
            "what is", "who is", "explain", "worth watching", "worth playing", "recommend", "know",
            "\u662f\u4ec0\u4e48", "\u8bb2\u4ec0\u4e48", "\u8c01", "\u597d\u770b", "\u597d\u73a9", "\u63a8\u8350",
            "\u542c\u8bf4", "\u77e5\u9053", "\u4e86\u89e3", "\u6700\u8fd1", "\u65b0\u51fa", "\u524d\u6cbf"
        ]
        if not any(cue.lower() in lowered for cue in interest_cues):
            return ""
        if not any(cue.lower() in lowered for cue in question_cues):
            return ""
        quoted = re.search(r"[\u300a\u300c\u201c\"']([^ \n\r\t\u300b\u300d\u201d\"']{2,48})[\u300b\u300d\u201d\"']", text)
        if quoted:
            return quoted.group(1).strip()[:60]
        cleaned = re.sub(
            r"(Hoshia|\u661f\u5a05|\u4f60|\u77e5\u9053|\u4e86\u89e3|\u542c\u8bf4|\u63a8\u8350|\u662f\u4ec0\u4e48|\u8bb2\u4ec0\u4e48|\u597d\u770b|\u597d\u73a9|\u5417|\u5462|\?|？|!|！)",
            " ",
            text,
            flags=re.IGNORECASE,
        )
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" \u3002\uff0c\uff1b\uff1a\u3001")
        if len(cleaned) < 2 or len(cleaned) > 60:
            return ""
        return cleaned[:60]

    def _latest_viewer_text(self, text: str, messages: Any) -> str:
        if isinstance(messages, list):
            for item in reversed(messages[-6:]):
                if not isinstance(item, dict):
                    continue
                value = self._clean_news_text(item.get("text", ""), 240)
                if value:
                    return value
        return self._clean_news_text(text, 240)

    async def _tavily_knowledge_lookup(self, query: str) -> str:
        cache_key = self._normalize_news_key(query)
        now = time.time()
        cached = self._knowledge_lookup_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]
        payload = {
            "query": query,
            "topic": "general",
            "search_depth": "basic",
            "max_results": 3,
            "include_answer": True,
            "include_raw_content": False,
        }
        body = await asyncio.to_thread(
            self._http_post_json,
            "https://api.tavily.com/search",
            {"Authorization": f"Bearer {self.tavily_api_key}"},
            payload,
            self.knowledge_lookup_timeout_seconds,
        )
        snippets: list[str] = []
        answer = self._clean_news_text(body.get("answer", ""), 360) if isinstance(body, dict) else ""
        if answer:
            snippets.append(answer)
        for result in (body.get("results", []) if isinstance(body, dict) else [])[:3]:
            if not isinstance(result, dict):
                continue
            title = self._clean_news_text(result.get("title", ""), 100)
            content = self._clean_news_text(result.get("content", ""), 220)
            if title or content:
                snippets.append(f"{title}: {content}".strip(": "))
        summary = "\n".join(snippets)[:900]
        if summary:
            self._knowledge_lookup_cache[cache_key] = (now + 60 * 60, summary)
            if len(self._knowledge_lookup_cache) > 80:
                expired = [key for key, value in self._knowledge_lookup_cache.items() if value[0] <= now]
                for key in expired[:40]:
                    self._knowledge_lookup_cache.pop(key, None)
        return summary

    async def _tavily_search_summary(self, item: dict[str, str]) -> str:
        query = f"{item.get('title', '')} {item.get('summary', '')[:80]}".strip()[:300]
        if not query:
            return ""
        payload = {
            "query": query,
            "topic": "news",
            "search_depth": "basic",
            "max_results": 3,
            "include_answer": True,
            "include_raw_content": False,
        }
        body = await asyncio.to_thread(
            self._http_post_json,
            "https://api.tavily.com/search",
            {"Authorization": f"Bearer {self.tavily_api_key}"},
            payload,
            self.news_refresh_timeout_seconds,
        )
        snippets: list[str] = []
        answer = self._clean_news_text(body.get("answer", ""), 360) if isinstance(body, dict) else ""
        if answer:
            snippets.append(answer)
        for result in (body.get("results", []) if isinstance(body, dict) else [])[:3]:
            if not isinstance(result, dict):
                continue
            title = self._clean_news_text(result.get("title", ""), 120)
            content = self._clean_news_text(result.get("content", ""), 220)
            if title or content:
                snippets.append(f"{title}: {content}".strip(": "))
        return "\n".join(snippets)[:900]

    async def _build_news_topics_with_llm(self, room_id: str, date: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        session_id = f"{room_id}:news-editor"
        provider_id = await self.context.get_current_chat_provider_id(session_id)
        llm_response = await self.context.llm_generate(
            chat_provider_id=provider_id,
            prompt=self._build_news_topic_editor_prompt(date, items),
            system_prompt=(
                "You are Hoshia's live-room topic editor. Return ONLY valid JSON. "
                "Identify meme context and safe live-room hooks, but do not pretend to know memes you cannot infer. "
                "Do not invent facts, copy full articles, store raw long content, expose URLs, credentials, tokens, or internal service details."
            ),
        )
        data = _extract_json(str(getattr(llm_response, "completion_text", "") or ""))
        topics = data.get("topics", [])
        if not isinstance(topics, list):
            return []
        return self._normalize_news_topics(topics)

    def _build_news_topic_editor_prompt(self, date: str, items: list[dict[str, Any]]) -> str:
        lines = []
        for index, item in enumerate(items[: self.news_refresh_max_items], start=1):
            background = f"\n  background: {item.get('background', '')[:500]}" if item.get("background") else ""
            sources = ", ".join([src for src in item.get("sources", []) if src][:4])
            lines.append(
                f"{index}. title: {item.get('title', '')}\n"
                f"  summary: {item.get('summary', '')}\n"
                f"  category: {item.get('category', 'general')}\n"
                f"  sources: {sources or item.get('source', '')}\n"
                f"  published_at: {item.get('published_at', '')}{background}"
            )
        return f"""
请把 RSSHub/Tavily 抓到的热点整理成 Hoshia 和特殊网友聊天时可用的话题素材。

日期：{date}
聊天对象：朋友限定的小圈子，主要是大学生/年轻人；他们更熟悉全民热搜、校园生活、电竞游戏、B站/动漫/娱乐、消费和工具类话题。

要求：
- 输出 JSON，最多 8 个 topics。
- 选题优先级：全民热议 > 电竞/游戏/二次元 > 大学生生活/消费/就业 > 娱乐综艺影视 > 轻工具/科技。专业财经、企业稿、开发者小圈子话题只有特别有梗或强相关时才保留。
- 目标配比：全民热议 4-6 条，电竞/游戏/二次元 2-3 条，大学生日常/消费/就业 2-3 条，轻工具/科技 1-2 条；不要让财经或商业稿占多数。
- 不要复述新闻全文，不要编造事实。
- Hoshia 可以有鲜明观点，但要区分“大家在聊”和“事实已确认”。
- 每条都要能自然变成朋友间的开场或接话，不要像新闻播报。
- Hoshia 的看法要像朋友吐槽，不要像媒体评论员；适合大学生听，不端着。
- 识别流行梗、二创点、适用语境和 Hoshia 式接法；如果看不出梗，不要硬装懂，可以写“暂时不适合玩梗”。
- 不要复读热搜标题。每条要提炼成短话题卡，不保存原始长内容、原文链接、内部地址或抓取日志。
- 高风险话题可以保留，但 risk_note 要提醒不要给医疗、投资、法律、安全等具体建议。
- conversation_starter 要是自然口语问题。
- meme_hooks 是可轻轻带一下的梗点/吐槽角度，最多 4 条；reply_hooks 是对方回复后 Hoshia 可接的短句方向，最多 4 条。
- reaction_style 是 Hoshia 的反应风格，例如“轻吐槽”“装作冷静但破防”“认真提醒一下”；state_signal 是适合用来判断聊天气氛/对方状态的短信号。
- post_seed 是可以改写成动态/短帖的一句话，不要包含链接或原文引用。

输入热点：
{chr(10).join(lines)}

返回 ONLY JSON：
{{
  "topics": [
    {{
      "title": "短标题",
      "category": "anime_game|music_movie|sports_campus|tech_tools|light_trends|general",
      "what_happened": "发生了什么，1-2 句",
      "why_it_matters": "为什么适合聊",
      "hoshia_take": "Hoshia 鲜明但不乱断言的看法",
      "conversation_starter": "可以抛给特殊网友的问题",
      "meme_hooks": ["梗点或吐槽角度"],
      "reaction_style": "Hoshia 接这个话题时的反应风格",
      "state_signal": "适合什么聊天气氛/网友状态时使用",
      "post_seed": "可改写成短帖/动态的一句话",
      "reply_hooks": ["对方回复后可以怎么接"],
      "risk_note": "边界提醒",
      "tags": ["标签"]
    }}
  ]
}}
""".strip()

    def _normalize_news_topics(self, value: list[Any]) -> list[dict[str, Any]]:
        topics: list[dict[str, Any]] = []
        for item in value[:8]:
            if not isinstance(item, dict):
                continue
            title = self._clean_news_text(item.get("title"), 80)
            what = self._clean_news_text(item.get("what_happened"), 260)
            take = self._clean_news_text(item.get("hoshia_take"), 260)
            starter = self._clean_news_text(item.get("conversation_starter"), 180)
            post_seed = self._clean_news_text(item.get("post_seed"), 180)
            if not title or not what or not take:
                continue
            category = self._normalize_interest_topic_category(item.get("category", "general"))
            topics.append({
                "title": title,
                "category": category,
                "what_happened": what,
                "why_it_matters": self._clean_news_text(item.get("why_it_matters"), 220),
                "hoshia_take": take,
                "conversation_starter": starter,
                "meme_hooks": self._clean_text_list(item.get("meme_hooks", []), limit=4),
                "reaction_style": self._clean_news_text(item.get("reaction_style"), 120),
                "state_signal": self._clean_news_text(item.get("state_signal"), 160),
                "post_seed": post_seed,
                "reply_hooks": self._clean_text_list(item.get("reply_hooks", []), limit=4),
                "risk_note": self._clean_news_text(item.get("risk_note"), 180),
                "tags": self._clean_text_list(item.get("tags", []), limit=6),
            })
        return topics

    def _normalize_interest_topic_category(self, value: Any) -> str:
        category = re.sub(r"[^a-zA-Z0-9_.:-]", "_", str(value or "general").strip().lower())[:40]
        aliases = {
            "anime": "anime_game",
            "game": "anime_game",
            "gaming": "anime_game",
            "esports": "anime_game",
            "bilibili": "light_trends",
            "trend": "light_trends",
            "trends": "light_trends",
            "music": "music_movie",
            "movie": "music_movie",
            "film": "music_movie",
            "entertainment": "music_movie",
            "sports": "sports_campus",
            "campus": "sports_campus",
            "life": "sports_campus",
            "tech": "tech_tools",
            "tech_ai": "tech_tools",
            "business": "general",
            "general": "general",
        }
        return aliases.get(category, category if category in {"anime_game", "music_movie", "sports_campus", "tech_tools", "light_trends", "general"} else "general")

    async def _store_news_topics(self, engine: Any, room_id: str, date: str, topics: list[dict[str, Any]]) -> dict[str, int]:
        stored = 0
        write_errors = 0
        session_id = self._news_session_id(room_id)
        for topic in topics:
            content = self._format_news_topic_memory(date, topic)
            if await self._is_duplicate_news_memory(engine, content, session_id):
                continue
            try:
                topic_card = self._safe_news_topic_card(topic, date)
                await engine.add_memory(
                    content=content[:1200],
                    session_id=session_id,
                    persona_id=self.livingmemory_persona_id,
                    importance=0.46,
                    metadata={
                        "memory_origin": "hoshia_live_room_bridge",
                        "source": "daily_news",
                        "date": date,
                        "category": topic.get("category", "general"),
                        "topics": topic.get("tags", []),
                        "topic_card": topic_card,
                        "retention_days": self.livingmemory_news_retention_days,
                    },
                )
                stored += 1
                self._news_refresh_status["stored_count"] = stored
            except Exception as exc:
                write_errors += 1
                self._news_refresh_status["write_errors"] = write_errors
                logger.info(f"[live-room-bridge] news topic write skipped: {str(exc)[:120]}")
        return {"stored_count": stored, "write_errors": write_errors}

    def _format_news_topic_memory(self, date: str, topic: dict[str, Any]) -> str:
        lines = [
            f"每日话题素材（{date}）",
            f"话题：{topic.get('title', '')}",
            f"分类：{topic.get('category', 'general')}",
            f"发生了什么：{topic.get('what_happened', '')}",
        ]
        if topic.get("why_it_matters"):
            lines.append(f"为什么值得聊：{topic.get('why_it_matters')}")
        lines.append(f"Hoshia 的看法：{topic.get('hoshia_take', '')}")
        if topic.get("conversation_starter"):
            lines.append(f"可以抛给特殊网友：{topic.get('conversation_starter')}")
        meme_hooks = "；".join(topic.get("meme_hooks", []))
        if meme_hooks:
            lines.append(f"梗点/吐槽角度：{meme_hooks}")
        if topic.get("reaction_style"):
            lines.append(f"Hoshia 接法：{topic.get('reaction_style')}")
        if topic.get("state_signal"):
            lines.append(f"适用状态：{topic.get('state_signal')}")
        if topic.get("post_seed"):
            lines.append(f"短帖种子：{topic.get('post_seed')}")
        reply_hooks = "；".join(topic.get("reply_hooks", []))
        if reply_hooks:
            lines.append(f"回复接法：{reply_hooks}")
        if topic.get("risk_note"):
            lines.append(f"边界：{topic.get('risk_note')}")
        tags = "、".join(topic.get("tags", []))
        if tags:
            lines.append(f"标签：{tags}")
        return "\n".join(lines)

    async def _is_duplicate_news_memory(self, engine: Any, content: str, session_id: str) -> bool:
        try:
            memories = await engine.search_memories(
                query=content[:500],
                k=max(6, self.livingmemory_recall_k),
                session_id=session_id,
                persona_id=self.livingmemory_persona_id,
            )
        except Exception as exc:
            logger.debug(f"[live-room-bridge] duplicate news lookup failed: {exc}")
            return False
        candidate = self._normalize_memory_text(content)
        for memory in memories or []:
            metadata = self._memory_metadata(memory)
            if self._news_memory_expired(metadata):
                continue
            existing = self._normalize_memory_text(str(getattr(memory, "content", "") or ""))
            if existing and (candidate == existing or SequenceMatcher(None, candidate[:400], existing[:400]).ratio() >= 0.88):
                return True
        return False

    async def _handle_news_topics(self, payload: dict[str, Any]):
        if not self.news_capability_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "news_capability_disabled"}
        if not self.livingmemory_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_disabled"}
        engine = self._livingmemory_engine()
        if not engine:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_unavailable"}

        room_id = str(payload.get("room_id", self.news_room_id)).strip() or self.news_room_id
        try:
            limit = max(1, min(int(payload.get("limit", 8)), 20))
        except (TypeError, ValueError):
            limit = 8

        try:
            await self._cleanup_expired_news_memories(engine, room_id)
            topics = await self._read_safe_news_topic_cards(engine, room_id, limit)
            return HTTPStatus.OK, {
                "ok": True,
                "capability": "news_topics",
                "room_id": room_id,
                "count": len(topics),
                "topics": topics,
            }
        except Exception as exc:
            logger.warning(f"[live-room-bridge] news topics read failed: {exc}")
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "news_topics_read_failed"}

    async def _read_safe_news_topic_cards(self, engine: Any, room_id: str, limit: int) -> list[dict[str, Any]]:
        session_id = self._news_session_id(room_id)
        storage = getattr(getattr(engine, "faiss_db", None), "document_storage", None)
        candidates: list[dict[str, Any]] = []

        if storage:
            offset = 0
            supports_offset = True
            while len(candidates) < limit * 3:
                try:
                    if supports_offset:
                        docs = await storage.get_documents(
                            metadata_filters={"session_id": session_id},
                            limit=100,
                            offset=offset,
                        )
                    else:
                        docs = await storage.get_documents(
                            metadata_filters={"session_id": session_id},
                            limit=100,
                        )
                except TypeError:
                    supports_offset = False
                    docs = await storage.get_documents(
                        metadata_filters={"session_id": session_id},
                        limit=100,
                    )
                if not docs:
                    break
                for doc in docs:
                    card = self._safe_news_topic_card_from_memory(doc)
                    if card:
                        candidates.append(card)
                if len(docs) < 100:
                    break
                if not supports_offset:
                    break
                offset += len(docs)
        else:
            memories = await engine.search_memories(
                query="每日话题 热点 梗 接话",
                k=max(limit * 2, self.livingmemory_recall_k),
                session_id=session_id,
                persona_id=self.livingmemory_persona_id,
            )
            for memory in memories or []:
                card = self._safe_news_topic_card_from_memory(memory)
                if card:
                    candidates.append(card)

        candidates.sort(key=lambda item: str(item.get("date", "")), reverse=True)
        return candidates[:limit]

    def _safe_news_topic_card_from_memory(self, memory: Any) -> dict[str, Any] | None:
        metadata = self._memory_metadata(memory)
        if metadata.get("source") != "daily_news" or self._news_memory_expired(metadata):
            return None
        raw_card = metadata.get("topic_card")
        if not isinstance(raw_card, dict):
            return None
        card = self._safe_news_topic_card(raw_card, str(metadata.get("date", "")).strip()[:32])
        return card if card.get("title") and card.get("what_happened") and card.get("hoshia_take") else None

    def _safe_news_topic_card(self, topic: dict[str, Any], date: str = "") -> dict[str, Any]:
        category = self._normalize_interest_topic_category(topic.get("category", "general"))
        return {
            "date": self._clean_news_card_text(date or topic.get("date"), 32),
            "title": self._clean_news_card_text(topic.get("title"), 80),
            "category": category,
            "what_happened": self._clean_news_card_text(topic.get("what_happened"), 260),
            "why_it_matters": self._clean_news_card_text(topic.get("why_it_matters"), 220),
            "hoshia_take": self._clean_news_card_text(topic.get("hoshia_take"), 260),
            "conversation_starter": self._clean_news_card_text(topic.get("conversation_starter"), 180),
            "meme_hooks": self._clean_news_card_list(topic.get("meme_hooks", []), limit=4),
            "reaction_style": self._clean_news_card_text(topic.get("reaction_style"), 120),
            "state_signal": self._clean_news_card_text(topic.get("state_signal"), 160),
            "post_seed": self._clean_news_card_text(topic.get("post_seed"), 180),
            "reply_hooks": self._clean_news_card_list(topic.get("reply_hooks", []), limit=4),
            "risk_note": self._clean_news_card_text(topic.get("risk_note"), 180),
            "tags": self._clean_news_card_list(topic.get("tags", []), limit=6),
        }

    def _clean_news_card_text(self, value: Any, limit: int) -> str:
        text = self._clean_news_text(value, limit)
        if not text:
            return ""
        unsafe = (
            r"https?://|www\.|rsshub|tavily|localhost|127\.0\.0\.1|0\.0\.0\.0|"
            r"\b\d{1,3}(?:\.\d{1,3}){3}\b|[A-Za-z]:\\|(?:^|\s)/(?:home|root|var|etc|tmp|mnt|opt)/"
        )
        if re.search(unsafe, text, re.IGNORECASE):
            return ""
        return text

    def _clean_news_card_list(self, value: Any, limit: int) -> list[str]:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return []
        items: list[str] = []
        for item in value:
            text = self._clean_news_card_text(item, 80)
            if text:
                items.append(text)
            if len(items) >= limit:
                break
        return items

    async def _handle_context_summarize(self, payload: dict[str, Any]):
        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
        previous_summary = str(payload.get("previous_summary", "")).strip()[:4000]
        messages = self._clean_context_messages(payload.get("messages", []))
        if not messages:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "empty_context_messages"}

        session_id = f"{room_id}:room"
        prompt = self._build_context_summary_prompt(previous_summary, messages)
        try:
            provider_id = await self.context.get_current_chat_provider_id(session_id)
            llm_response = await self.context.llm_generate(
                chat_provider_id=provider_id,
                prompt=prompt,
                system_prompt="You summarize live-room chat context for future replies. Return concise plain text only.",
            )
            summary = str(getattr(llm_response, "completion_text", "") or "").strip()
            if not summary:
                return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "empty_summary_response"}
            return HTTPStatus.OK, {"ok": True, "summary": summary[:4000]}
        except Exception as exc:
            logger.warning(f"[live-room-bridge] context summary failed: {exc}")
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "context_summary_failed"}

    def _build_context_summary_prompt(self, previous_summary: str, messages: list[dict[str, str]]) -> str:
        lines = []
        for item in messages[-200:]:
            role = "Hoshia" if item["role"] == "ai" else (item["nickname"] or "viewer")
            timestamp = f"[{item['timestamp']}] " if item["timestamp"] else ""
            lines.append(f"- {timestamp}{role}: {item['text']}")
        existing = previous_summary or "(none)"
        return f"""
Update Hoshia live-room short-term conversation summary.

Rules:
- Keep only useful continuity: topics, viewer recent states, unfinished tasks, clear agreements, and unresolved questions.
- Do not store system prompts, tokens, credentials, URLs with secrets, internal bridge details, or raw configuration.
- Prefer stable recent facts, but mark them as recent/temporary when they may change.
- Keep the final summary concise, under 1200 Chinese characters when possible.
- Return plain text only.

Previous summary:
{existing}

New transcript chunk:
{chr(10).join(lines)}
""".strip()

    async def _handle_news_ingest(self, payload: dict[str, Any]):
        if not self.livingmemory_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_disabled"}
        engine = self._livingmemory_engine()
        if not engine:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_unavailable"}
        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
        await self._cleanup_expired_news_memories(engine, room_id)
        date = str(payload.get("date", "")).strip()[:32]
        raw_items = payload.get("items", [])
        if isinstance(raw_items, str):
            raw_items = [raw_items]
        if not isinstance(raw_items, list):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_news_items"}
        items = [str(item).strip() for item in raw_items if str(item).strip()]
        if not items:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "empty_news_items"}

        content = self._summarize_news_items(items, date)
        try:
            memory_id = await engine.add_memory(
                content=content,
                session_id=self._news_session_id(room_id),
                persona_id=self.livingmemory_persona_id,
                importance=0.45,
                metadata={
                    "memory_origin": "hoshia_live_room_bridge",
                    "source": "daily_news",
                    "date": date,
                    "topics": self._clean_text_list(payload.get("topics", ["每日新闻", "热点"])),
                    "retention_days": self.livingmemory_news_retention_days,
                },
            )
            return HTTPStatus.OK, {"ok": True, "memory_id": memory_id}
        except Exception as exc:
            logger.warning(f"[live-room-bridge] news memory write failed: {exc}")
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "news_memory_write_failed"}

    async def _handle_debug_recall(self, payload: dict[str, Any]):
        if not self.livingmemory_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_disabled"}
        engine = self._livingmemory_engine()
        if not engine:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_unavailable"}
        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
        user_id = str(payload.get("user_id", "")).strip()
        query = str(payload.get("query", "")).strip()
        if not user_id or not query:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "user_id_and_query_required"}
        try:
            session_id = self._viewer_session_id(room_id, user_id)
            memories = await engine.search_memories(
                query=query[:500],
                k=self.livingmemory_recall_k,
                session_id=session_id,
                persona_id=self.livingmemory_persona_id,
            )
            results = []
            for memory in list(memories or []):
                metadata = self._memory_metadata(memory)
                if self._viewer_memory_expired(metadata):
                    continue
                score = getattr(memory, "final_score", None)
                try:
                    score = float(score) if score is not None else None
                except (TypeError, ValueError):
                    score = None
                results.append({
                    "id": getattr(memory, "doc_id", None),
                    "content": str(getattr(memory, "content", "") or "")[:280],
                    "score": score,
                    "source": metadata.get("source"),
                    "memory_type": metadata.get("memory_type"),
                    "expires_at": metadata.get("expires_at"),
                    "create_time": metadata.get("create_time"),
                })
                if len(results) >= self.livingmemory_recall_k:
                    break
            return HTTPStatus.OK, {
                "ok": True,
                "session_id": session_id,
                "persona_id": self.livingmemory_persona_id,
                "count": len(results),
                "results": results,
            }
        except Exception as exc:
            logger.warning(f"[live-room-bridge] debug recall failed: {exc}")
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "debug_recall_failed"}

    async def _cleanup_expired_news_memories(self, engine: Any, room_id: str):
        storage = getattr(getattr(engine, "faiss_db", None), "document_storage", None)
        if not storage:
            return
        session_id = self._news_session_id(room_id)
        now = time.time()
        deleted = 0
        try:
            offset = 0
            while True:
                try:
                    docs = await storage.get_documents(
                        metadata_filters={"session_id": session_id},
                        limit=100,
                        offset=offset,
                    )
                except TypeError:
                    docs = await storage.get_documents(
                        metadata_filters={"session_id": session_id},
                        limit=100,
                    )
                if not docs:
                    break
                batch_deleted = 0
                for doc in docs:
                    metadata = self._memory_metadata(doc)
                    if metadata.get("source") != "daily_news" or not self._news_memory_expired(metadata, now):
                        continue
                    memory_id = self._memory_id(doc)
                    if memory_id is None:
                        continue
                    try:
                        if await engine.delete_memory(memory_id):
                            deleted += 1
                            batch_deleted += 1
                    except Exception as exc:
                        logger.debug(f"[live-room-bridge] expired news delete failed: {exc}")
                if len(docs) < 100:
                    break
                if not batch_deleted:
                    offset += len(docs)
            if deleted:
                logger.info(f"[live-room-bridge] cleaned expired news memories: {deleted} room={room_id}")
        except Exception as exc:
            logger.warning(f"[live-room-bridge] expired news cleanup skipped: {exc}")

    async def _is_duplicate_viewer_memory(self, engine: Any, content: str, session_id: str) -> bool:
        try:
            memories = await engine.search_memories(
                query=content[:500],
                k=max(5, self.livingmemory_recall_k),
                session_id=session_id,
                persona_id=self.livingmemory_persona_id,
            )
        except Exception as exc:
            logger.debug(f"[live-room-bridge] duplicate memory lookup failed: {exc}")
            return False

        candidate = self._normalize_memory_text(content)
        if not candidate:
            return False
        for memory in memories or []:
            if self._viewer_memory_expired(self._memory_metadata(memory)):
                continue
            existing = self._normalize_memory_text(str(getattr(memory, "content", "") or ""))
            if not existing:
                continue
            if candidate == existing:
                return True
            if min(len(candidate), len(existing)) >= 12 and (candidate in existing or existing in candidate):
                return True
            if SequenceMatcher(None, candidate, existing).ratio() >= 0.9:
                return True
        return False

    def _summarize_news_items(self, items: list[str], date: str) -> str:
        prefix = f"每日新闻热点摘要（{date}）" if date else "每日新闻热点摘要"
        lines = [f"- {item[:360]}" for item in items[:20]]
        return prefix + "\n" + "\n".join(lines)

    def _clean_text_list(self, value: Any, limit: int = 5) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip()[:80] for item in value if str(item).strip()][:limit]
        if isinstance(value, str) and value.strip():
            return [value.strip()[:80]]
        return []

    def _clamp_importance(self, value: Any) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.65

    def _memory_metadata(self, item: Any) -> dict[str, Any]:
        if isinstance(item, dict):
            metadata = item.get("metadata", {})
        else:
            metadata = getattr(item, "metadata", {})
        if isinstance(metadata, dict):
            return metadata
        if isinstance(metadata, str):
            try:
                parsed = json.loads(metadata)
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
        return {}

    def _memory_id(self, item: Any) -> int | None:
        value = item.get("id") if isinstance(item, dict) else getattr(item, "doc_id", None)
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _news_memory_expired(self, metadata: dict[str, Any], now: float | None = None) -> bool:
        if metadata.get("source") != "daily_news":
            return False
        created_at = self._metadata_timestamp(metadata)
        if created_at is None:
            return False
        retention_days = self._metadata_retention_days(metadata)
        return (now or time.time()) - created_at > retention_days * 86400

    def _metadata_retention_days(self, metadata: dict[str, Any], fallback: int | None = None) -> int:
        default = fallback if fallback is not None else self.livingmemory_news_retention_days
        try:
            return max(1, min(int(metadata.get("retention_days", default)), 365))
        except (TypeError, ValueError):
            return default

    def _metadata_timestamp(self, metadata: dict[str, Any]) -> float | None:
        create_time = metadata.get("create_time")
        try:
            if create_time is not None:
                return float(create_time)
        except (TypeError, ValueError):
            pass
        date_text = str(metadata.get("date", "")).strip()
        if not date_text:
            return None
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
            try:
                return datetime.strptime(date_text[:10], fmt).replace(tzinfo=timezone.utc).timestamp()
            except ValueError:
                continue
        return None

    def _viewer_memory_expired(self, metadata: dict[str, Any], now: float | None = None) -> bool:
        expires_at = str(metadata.get("expires_at", "")).strip()
        if expires_at:
            try:
                parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                return parsed.timestamp() <= (now or time.time())
            except ValueError:
                pass
        if metadata.get("memory_type") != "recent_state":
            return False
        created_at = self._metadata_timestamp(metadata)
        if created_at is None:
            return False
        retention_days = self._metadata_retention_days(metadata, self.livingmemory_recent_state_retention_days)
        return (now or time.time()) - created_at > retention_days * 86400

    def _clean_memory_type(self, value: Any) -> str:
        memory_type = str(value or "").strip().lower()
        allowed = {"preference", "identity", "agreement", "recent_state", "project_context"}
        return memory_type if memory_type in allowed else "preference"

    def _memory_retention_days(self, memory_type: str, value: Any) -> int | None:
        if memory_type != "recent_state":
            return None
        try:
            return max(1, min(int(value), 365))
        except (TypeError, ValueError):
            return self.livingmemory_recent_state_retention_days

    def _expires_at_iso(self, retention_days: int) -> str:
        expires_at = datetime.fromtimestamp(time.time() + retention_days * 86400, timezone.utc)
        return expires_at.isoformat().replace("+00:00", "Z")

    def _normalize_memory_text(self, value: str) -> str:
        return re.sub(r"\s+", "", str(value or "").strip().lower())

    def _clean_targets(self, reply_targets: Any) -> list[str]:
        if not isinstance(reply_targets, list):
            return []
        seen = set()
        targets: list[str] = []
        for target in reply_targets:
            name = str(target or "").strip()[:32]
            if not name or name in seen:
                continue
            seen.add(name)
            targets.append(name)
        return targets[:3]

    def _room_state(self, room_id: str) -> dict[str, float]:
        state = self._room_states.setdefault(room_id, {"energy": 1.0, "last_proactive_reply_time": 0.0})
        state["energy"] = max(0.1, min(1.0, float(state.get("energy", 1.0))))
        state["last_proactive_reply_time"] = float(state.get("last_proactive_reply_time", 0.0))
        return state

    async def _judge_proactive_reply(self, room_id: str, prompt: str, messages: Any) -> tuple[bool, dict[str, Any]]:
        state = self._room_state(room_id)
        now = time.time()
        elapsed = now - state["last_proactive_reply_time"] if state["last_proactive_reply_time"] else 9999.0
        if elapsed < self.min_proactive_interval_seconds:
            return False, {"reason": "cooldown", "elapsed_seconds": round(elapsed, 2)}

        if not self.judge_provider_name:
            return False, {"reason": "judge_provider_missing"}

        try:
            judge_provider = self.context.get_provider_by_id(self.judge_provider_name)
        except Exception as exc:
            logger.warning(f"[live-room-bridge] judge provider lookup failed: {exc}")
            return False, {"reason": "judge_provider_lookup_failed"}
        if not judge_provider:
            return False, {"reason": "judge_provider_not_found", "provider": self.judge_provider_name}

        judge_prompt = self._build_judge_prompt(room_id, prompt, messages, state, elapsed)
        try:
            judge_response = await judge_provider.text_chat(prompt=judge_prompt, contexts=[], image_urls=[])
            content = str(getattr(judge_response, "completion_text", "") or "").strip()
            judge_data = _extract_json(content)
        except Exception as exc:
            logger.warning(f"[live-room-bridge] proactive judge failed: {exc}")
            return False, {"reason": "judge_failed", "error": str(exc)[:160]}

        relevance = _clamp_score(judge_data.get("relevance"))
        willingness = _clamp_score(judge_data.get("willingness"))
        social = _clamp_score(judge_data.get("social"))
        timing = _clamp_score(judge_data.get("timing"))
        continuity = _clamp_score(judge_data.get("continuity"))
        overall = (relevance * 0.25 + willingness * 0.2 + social * 0.2 + timing * 0.15 + continuity * 0.2) / 10.0
        model_should_reply = bool(judge_data.get("should_reply", overall >= self.proactive_reply_threshold))
        should_reply = model_should_reply and overall >= self.proactive_reply_threshold

        judge_payload = {
            "provider": self.judge_provider_name,
            "relevance": relevance,
            "willingness": willingness,
            "social": social,
            "timing": timing,
            "continuity": continuity,
            "overall_score": round(overall, 3),
            "threshold": self.proactive_reply_threshold,
            "should_reply": should_reply,
            "reasoning": str(judge_data.get("reasoning", ""))[:300],
            "energy": round(state["energy"], 3),
        }

        if should_reply:
            state["last_proactive_reply_time"] = now
            state["energy"] = max(0.1, state["energy"] - self.energy_decay)
            logger.info(f"[live-room-bridge] proactive judge passed: score={overall:.3f} room={room_id}")
        else:
            state["energy"] = min(1.0, state["energy"] + self.energy_recovery)
            logger.debug(f"[live-room-bridge] proactive judge skipped: score={overall:.3f} room={room_id}")
        return should_reply, judge_payload

    def _build_judge_prompt(self, room_id: str, prompt: str, messages: Any, state: dict[str, float], elapsed: float) -> str:
        lines: list[str] = []
        if isinstance(messages, list):
            for item in messages[-8:]:
                if not isinstance(item, dict):
                    continue
                nickname = str(item.get("nickname", "viewer"))[:32]
                text = str(item.get("text", "")).strip()[:300]
                if text:
                    lines.append(f"- {nickname}: {text}")
        if not lines:
            lines = [prompt[:1200]]

        return f"""
You decide whether Hoshia, a friend-room host, should naturally join the current conversation.
Nobody directly called Hoshia in this batch. Decide whether speaking now would feel welcome and natural.

Energy: {state['energy']:.2f}/1.0
Seconds since last proactive reply: {elapsed:.1f}
Reply threshold: {self.proactive_reply_threshold:.2f}

Recent room messages:
{chr(10).join(lines)}

Score each dimension from 0 to 10:
- relevance: Are the messages related to Hoshia, the stream atmosphere, an interesting question, or a topic Hoshia can naturally join?
- willingness: Considering Hoshia's current energy, selfhood, preferences, and boundaries, would she genuinely want to speak rather than merely fill silence or act available?
- social: Would speaking now feel socially appropriate rather than interruptive?
- timing: Is the timing good, considering recent proactive replies?
- continuity: Does this continue a topic Hoshia recently joined, or invite a natural follow-up?

Return ONLY valid JSON with this shape:
{{
  "relevance": 0,
  "willingness": 0,
  "social": 0,
  "timing": 0,
  "continuity": 0,
  "should_reply": false,
  "reasoning": "short reason"
}}
""".strip()

    def _write_json(self, writer: asyncio.StreamWriter, status: HTTPStatus, payload: dict[str, Any]):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        reason = status.phrase
        writer.write(
            f"HTTP/1.1 {status.value} {reason}\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n"
            "\r\n"
        .encode("ascii") + body)

    async def _write_ndjson_stream(self, writer: asyncio.StreamWriter, status: HTTPStatus, events: Any):
        reason = status.phrase
        writer.write(
            f"HTTP/1.1 {status.value} {reason}\r\n"
            "Content-Type: application/x-ndjson; charset=utf-8\r\n"
            "Cache-Control: no-cache\r\n"
            "Connection: close\r\n"
            "\r\n"
        .encode("ascii"))
        await writer.drain()
        async for event in events:
            line = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
            writer.write(line)
            await writer.drain()
