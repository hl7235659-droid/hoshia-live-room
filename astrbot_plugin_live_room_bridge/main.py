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
        self.tavily_max_queries_per_refresh = max(0, min(int(config.get("tavily_max_queries_per_refresh", 6)), 20))
        self._news_refresh_lock = asyncio.Lock()
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
            status, payload = await self._dispatch(request)
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

        if request["method"] != "POST" or request["path"] not in {"/live-room/generate", "/live-room/news", "/live-room/capabilities/news/refresh", "/live-room/context/summarize", "/live-room/memory/debug-recall", "/live-room/music/intent"}:
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
        force_reply = bool(payload.get("force_reply"))
        reply_mode = str(payload.get("reply_mode", "")).strip()[:48]
        if not text or len(text) > 3000:
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_text"}

        started = time.perf_counter()
        targets = self._clean_targets(reply_targets)
        try:
            provider_id = await self.context.get_current_chat_provider_id(session_id)
            prompt = prompt_override or (f"{nickname}: {text}" if nickname else text)
            memory_context = await self._build_livingmemory_context(room_id, messages, module_memory_events)
            if memory_context:
                prompt = f"{prompt}\n\n{memory_context}"
            short_term_context = self._build_short_term_context(context_summary, recent_context)
            if short_term_context:
                prompt = f"{prompt}\n\n{short_term_context}"
            module_prompt_context = self._format_module_prompt_context(module_context, module_events)
            if module_prompt_context:
                prompt = f"{prompt}\n\n{module_prompt_context}"

            if targets:
                prompt = f"{prompt}\n\nExplicit reply target(s): {' '.join('@' + name for name in targets)}. If you are answering them, start your reply with the matching @nickname."
            elif force_reply:
                prompt = f"{prompt}\n\nSingle-viewer direct reply mode ({reply_mode or 'single_user_direct'}). The live room currently has one online viewer, so reply naturally to their latest message even without an @ mention. Do not run proactive silence logic; keep the answer warm, concise, and conversational."
            else:
                should_reply, judge_payload = await self._judge_proactive_reply(room_id, prompt, messages)
                if not should_reply:
                    return HTTPStatus.OK, {
                        "ok": True,
                        "skipped": True,
                        "source": "heartflow_judge",
                        "judge": judge_payload,
                        "latency_ms": int((time.perf_counter() - started) * 1000),
                    }
                prompt = f"{prompt}\n\nThis is a proactive live-room interjection. Nobody explicitly mentioned you. Reply only if the topic, relationship, or room atmosphere genuinely gives Hoshia a reason to speak. Do not fill silence just to prove she is online or available."

            llm_response = await self.context.llm_generate(
                chat_provider_id=provider_id,
                prompt=prompt,
                system_prompt=self.system_prompt or None,
            )
            reply_text = str(getattr(llm_response, "completion_text", "") or "").strip()
            if not reply_text:
                return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "empty_llm_response"}
            if self.livingmemory_enabled and self.livingmemory_auto_summary_enabled:
                asyncio.create_task(self._summarize_and_store_viewer_memories(provider_id, room_id, messages, reply_text, module_memory_events))
            return HTTPStatus.OK, {
                "ok": True,
                "text": reply_text,
                "state": "SPEAKING",
                "source": "astrbot",
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }
        except Exception as exc:
            logger.error(f"[live-room-bridge] llm failed: {exc}", exc_info=True)
            return HTTPStatus.BAD_GATEWAY, {"ok": False, "error": "llm_failed"}

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
                "Earlier live-room conversation summary. Use it only as background; newer messages override it:\n"
                + summary[:4000]
            )

        lines = []
        for item in self._clean_context_messages(recent_context)[-120:]:
            role = "Hoshia" if item["role"] == "ai" else (item["nickname"] or "viewer")
            user_suffix = f" ({item['user_id']})" if item["user_id"] and item["role"] != "ai" else ""
            timestamp = f"[{item['timestamp']}] " if item["timestamp"] else ""
            lines.append(f"- {timestamp}{role}{user_suffix}: {item['text']}")
        if lines:
            sections.append(
                "Recent live-room transcript. This is the highest-priority context for questions like what was just said:\n"
                + "\n".join(lines)
            )

        if not sections:
            return ""
        return (
            "Short-term conversation context for this reply. Priority when facts conflict: recent transcript > earlier summary > LivingMemory.\n"
            + "\n\n".join(sections)
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
                "text": text[:500],
                "timestamp": str(item.get("timestamp", "")).strip()[:40],
            })
        return messages

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
        for key, limit in {"title": 120, "artist": 120, "source": 40}.items():
            text = self._safe_runtime_text(value.get(key), limit)
            if text:
                data[key] = text
        return data

    def _format_module_prompt_context(self, module_context: list[dict[str, Any]], module_events: list[dict[str, Any]]) -> str:
        sections: list[str] = []
        for module in module_context:
            title = f"Module: {module['module_id']} ({'enabled' if module['enabled'] else 'disabled'})"
            lines = [title]
            if module["current_state"]:
                lines.append("Current state:")
                lines.extend(f"- {line}" for line in module["current_state"][:12])
            if module["capabilities"]:
                lines.append("Capabilities:")
                lines.extend(f"- {line}" for line in module["capabilities"][:8])
            if module["limits"]:
                lines.append("Limits:")
                lines.extend(f"- {line}" for line in module["limits"][:8])
            sections.append("\n".join(lines))

        event_lines = []
        for event in module_events[:24]:
            actor = event["nickname"] or event["user_id"] or "viewer"
            timestamp = f"[{event['occurred_at']}] " if event["occurred_at"] else ""
            data_text = self._module_event_data_text(event)
            suffix = f" / data: {data_text}" if data_text else ""
            event_lines.append(f"- {timestamp}{actor}: {event['summary_hint']} ({event['event_type']}){suffix}")
        if event_lines:
            sections.append("Recent module events:\n" + "\n".join(event_lines))

        if not sections:
            return ""
        return (
            "Safe live-room module context. Use it only as current known module state and behavioral signal. "
            "Do not expose internal field names, tokens, paths, IPs, provider URLs, or configuration. "
            "For music, only evaluate the current/queued songs and recent request events; do not claim access to a full library.\n"
            + "\n\n".join(sections)
        )

    def _safe_identifier(self, value: Any, limit: int) -> str:
        return re.sub(r"[^a-zA-Z0-9_.:-]", "_", str(value or "").strip())[:limit]

    def _safe_runtime_text(self, value: Any, limit: int) -> str:
        text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()[:limit]
        if re.search(r"(?:\.env|BEGIN [A-Z ]*PRIVATE KEY|ssh-|token=|password=|secret=)", text, re.IGNORECASE):
            return ""
        return text

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
        for key in ("title", "artist", "source"):
            value = str(data.get(key, "")).strip()
            if value:
                parts.append(f"{key}={value}")
        return ", ".join(parts)[:320]

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
                "nickname": str(item.get("nickname", "viewer")).strip()[:32] or "viewer",
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
                    "nickname": str(event.get("nickname", "viewer")).strip()[:32] or "viewer",
                    "query": summary_hint[:300],
                })
                if len(selected) >= self.livingmemory_max_participants:
                    break
        return selected

    async def _build_livingmemory_context(self, room_id: str, messages: Any, module_events: Any | None = None) -> str:
        if not self.livingmemory_enabled:
            return ""
        engine = self._livingmemory_engine()
        if not engine:
            return ""

        sections: list[str] = []
        try:
            for viewer in self._selected_viewers(messages, module_events):
                memories = await engine.search_memories(
                    query=viewer["query"],
                    k=self.livingmemory_recall_k,
                    session_id=self._viewer_session_id(room_id, viewer["user_id"]),
                    persona_id=self.livingmemory_persona_id,
                )
                lines = self._format_memory_lines(memories)
                if lines:
                    sections.append(
                        f"@{viewer['nickname']} 的个人长期记忆参考（只用于理解这个观众，不要透露来源）：\n"
                        + "\n".join(lines)
                    )

            news_query = self._news_query(messages)
            if news_query:
                await self._cleanup_expired_news_memories(engine, room_id)
                news_memories = await engine.search_memories(
                    query=news_query,
                    k=self.livingmemory_recall_k,
                    session_id=self._news_session_id(room_id),
                    persona_id=self.livingmemory_persona_id,
                )
                news_lines = self._format_news_memory_lines(news_memories)
                if news_lines:
                    sections.append(
                        "近期新闻热点参考（只用于话题灵感，不代表任何观众个人记忆）：\n"
                        + "\n".join(news_lines)
                    )
        except Exception as exc:
            logger.warning(f"[live-room-bridge] LivingMemory recall skipped: {exc}")
            return ""

        if not sections:
            return ""
        return "LivingMemory 召回内容：\n" + "\n\n".join(sections)

    def _format_memory_lines(self, memories: Any) -> list[str]:
        lines: list[str] = []
        for memory in list(memories or []):
            metadata = self._memory_metadata(memory)
            if self._viewer_memory_expired(metadata):
                continue
            content = str(getattr(memory, "content", "") or "").strip()
            if not content:
                continue
            lines.append(f"- {content[:280]}")
            if len(lines) >= self.livingmemory_recall_k:
                break
        return lines

    def _format_news_memory_lines(self, memories: Any) -> list[str]:
        lines: list[str] = []
        now = time.time()
        for memory in list(memories or []):
            metadata = self._memory_metadata(memory)
            if self._news_memory_expired(metadata, now):
                continue
            content = str(getattr(memory, "content", "") or "").strip()
            if not content:
                continue
            lines.append(f"- {content[:280]}")
            if len(lines) >= self.livingmemory_recall_k:
                break
        return lines

    def _news_query(self, messages: Any) -> str:
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
        if not query:
            return ""
        if re.search(r"(今天|最近|新闻|热搜|热点|新鲜事|发生什么|AI|人工智能|科技|游戏|B站|b站|娱乐|GitHub|开源|模型|话题)", query, re.IGNORECASE):
            return query
        return ""

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
            data_suffix = f" / data={data_text}" if data_text else ""
            module_event_lines.append(
                f"- {when}{event.get('summary_hint', '')} / kind={event.get('memory_kind', 'module_event')} / retention_days={event.get('retention_days', self.livingmemory_recent_state_retention_days)}{data_suffix}"
            )
        module_event_section = "\n".join(module_event_lines) if module_event_lines else "(none)"
        return f"""
从下面直播间互动中，只提取适合长期记住的稳定事实。不要保存 Hoshia 人设、系统提示、新闻正文、临时闲聊或敏感密钥。

观众昵称：{nickname}
观众弹幕：
{chr(10).join('- ' + line[:300] for line in viewer_lines[-6:])}

归因到该观众的模块事件（只能作为行为信号，不能逐条照抄成记忆）：
{module_event_section}

Hoshia 回复：
{reply_text[:500]}

只在以下情况写入：观众明确要求记住、稳定偏好、称呼/身份信息、长期约定、持续关注的话题。
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
- Module events are candidates only. Do not store a raw song list; extract compact style/artist/era/atmosphere tendencies, e.g. "recently tends toward retro pop/classic rock".
- A single music.song_requested event without explicit preference usually means return {"memories": []}; multiple related events may become "recent_state" with retention_days 30.
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
- request: viewer asks to play/request/add a song. Extract the best search query, including artist when present. Examples: "??????" => query "??? ??"; "?????????" => query "???????".
- request_many: viewer asks for multiple songs, a singer's popular songs, a style playlist, or a mood playlist. Clamp count to 1..5. For singer hot songs, use query like "周杰伦 热门". For style/mood playlists, generate 3-5 concise search queries such as ["深夜 R&B", "华语 R&B", "治愈 R&B", "慢节奏 R&B", "夜晚 情歌"] or ["city pop", "日系 city pop", "竹内玛莉亚", "山下达郎", "复古都市流行"].
- pause: asks to pause/stop temporarily.
- resume: asks to continue/resume/play current music.
- next: asks to skip/switch/cut to next song.
- remove: asks to delete queued songs. For "???/?3?/?????", target={{"kind":"queue_index","index":3}}. For "??????/?????", target={{"kind":"requested_by_self"}}.
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
            status, payload = await self._refresh_news_topics({
                "room_id": self.news_room_id,
                "trigger": reason,
            })
            logger.info(
                f"[live-room-bridge] news refresh {reason}: status={status} "
                f"stored={payload.get('stored_count', 0)} topics={payload.get('topic_count', 0)} "
                f"error={payload.get('error', '')}"
            )
        except Exception as exc:
            logger.warning(f"[live-room-bridge] scheduled news refresh skipped: {exc}", exc_info=True)

    async def _handle_news_refresh(self, payload: dict[str, Any]):
        return await self._refresh_news_topics(payload)

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

            raw_items = await self._fetch_news_source_items(self.news_source_urls)
            deduped_items = self._dedupe_news_items(raw_items)[:self.news_refresh_max_items]
            if not deduped_items:
                return HTTPStatus.BAD_GATEWAY, {
                    "ok": False,
                    "error": "news_sources_empty",
                    "source_count": len(self.news_source_urls),
                    "latency_ms": int((time.perf_counter() - started) * 1000),
                }

            enriched_items = await self._enrich_news_items_with_tavily(deduped_items)
            topics = await self._build_news_topics_with_llm(room_id, date, enriched_items)
            stored = await self._store_news_topics(engine, room_id, date, topics)
            return HTTPStatus.OK, {
                "ok": True,
                "capability": "news_topics",
                "source_count": len(self.news_source_urls),
                "item_count": len(deduped_items),
                "topic_count": len(topics),
                "stored_count": stored,
                "topics": [
                    {
                        "title": topic.get("title", ""),
                        "category": topic.get("category", ""),
                        "tags": topic.get("tags", []),
                    }
                    for topic in topics[:12]
                ],
                "latency_ms": int((time.perf_counter() - started) * 1000),
            }

    async def _fetch_news_source_items(self, urls: list[str]) -> list[dict[str, str]]:
        tasks = [self._fetch_rss_feed(url) for url in urls[:80]]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        items: list[dict[str, str]] = []
        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"[live-room-bridge] RSSHub feed skipped: {result}")
                continue
            items.extend(result)
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
            raise RuntimeError(f"fetch_failed:{urlparse(url).netloc}") from exc
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
                    next_item["background"] = await self._tavily_search_summary(item)
                    query_budget -= 1
                except Exception as exc:
                    logger.warning(f"[live-room-bridge] Tavily enrichment skipped: {exc}")
            enriched.append(next_item)
        return enriched

    def _should_enrich_news_item(self, item: dict[str, str]) -> bool:
        if len(item.get("summary", "")) < 60:
            return True
        if int(item.get("source_count", "1") or "1") > 1:
            return True
        return item.get("category") in {"tech_ai", "business"}

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
                "Do not invent facts, copy full articles, expose URLs, credentials, tokens, or internal service details."
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
请把 RSSHub/Tavily 抓到的热点整理成 Hoshia 私密直播间可用的话题素材。

日期：{date}
直播间受众：朋友限定的小圈子，观众以大学生/年轻人为主；他们更熟悉全民热搜、校园生活、电竞游戏、B站/动漫/娱乐、消费和AI工具话题。

要求：
- 输出 JSON，最多 12 个 topics。
- 选题优先级：全民热议 > 电竞/游戏/二次元 > 大学生生活/消费/就业 > 娱乐综艺影视 > AI工具/科技。专业财经、企业稿、开发者小圈子话题只有特别有梗或强相关时才保留。
- 目标配比：全民热议 4-6 条，电竞/游戏/二次元 2-3 条，大学生日常/消费/就业 2-3 条，科技/AI 1-2 条；不要让财经或商业稿占多数。
- 不要复述新闻全文，不要编造事实。
- Hoshia 可以有鲜明观点，但要区分“大家在聊”和“事实已确认”。
- 每条都要能自然变成朋友直播间里的开场或接话，不要像新闻播报。
- Hoshia 的看法要像朋友吐槽/主播锐评，不要像媒体评论员；适合大学生听，不端着。
- 高风险话题可以保留，但 risk_note 要提醒不要给医疗、投资、法律、安全等具体建议。
- conversation_starter 要是自然口语问题。

输入热点：
{chr(10).join(lines)}

返回 ONLY JSON：
{{
  "topics": [
    {{
      "title": "短标题",
      "category": "general|tech_ai|entertainment|business|life",
      "what_happened": "发生了什么，1-2 句",
      "why_it_matters": "为什么适合聊",
      "hoshia_take": "Hoshia 鲜明但不乱断言的看法",
      "conversation_starter": "可以抛给观众的问题",
      "risk_note": "边界提醒",
      "tags": ["标签"]
    }}
  ]
}}
""".strip()

    def _normalize_news_topics(self, value: list[Any]) -> list[dict[str, Any]]:
        topics: list[dict[str, Any]] = []
        for item in value[:12]:
            if not isinstance(item, dict):
                continue
            title = self._clean_news_text(item.get("title"), 80)
            what = self._clean_news_text(item.get("what_happened"), 260)
            take = self._clean_news_text(item.get("hoshia_take"), 260)
            starter = self._clean_news_text(item.get("conversation_starter"), 180)
            if not title or not what or not take:
                continue
            category = str(item.get("category", "general")).strip().lower()
            if category not in {"general", "tech_ai", "entertainment", "business", "life"}:
                category = "general"
            topics.append({
                "title": title,
                "category": category,
                "what_happened": what,
                "why_it_matters": self._clean_news_text(item.get("why_it_matters"), 220),
                "hoshia_take": take,
                "conversation_starter": starter,
                "risk_note": self._clean_news_text(item.get("risk_note"), 180),
                "tags": self._clean_text_list(item.get("tags", []), limit=6),
            })
        return topics

    async def _store_news_topics(self, engine: Any, room_id: str, date: str, topics: list[dict[str, Any]]) -> int:
        stored = 0
        session_id = self._news_session_id(room_id)
        for topic in topics:
            content = self._format_news_topic_memory(date, topic)
            if await self._is_duplicate_news_memory(engine, content, session_id):
                continue
            try:
                await engine.add_memory(
                    content=content[:900],
                    session_id=session_id,
                    persona_id=self.livingmemory_persona_id,
                    importance=0.46,
                    metadata={
                        "memory_origin": "hoshia_live_room_bridge",
                        "source": "daily_news",
                        "date": date,
                        "category": topic.get("category", "general"),
                        "topics": topic.get("tags", []),
                        "retention_days": self.livingmemory_news_retention_days,
                    },
                )
                stored += 1
            except Exception as exc:
                logger.warning(f"[live-room-bridge] news topic write skipped: {exc}")
        return stored

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
            lines.append(f"可以抛给观众：{topic.get('conversation_starter')}")
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
                mentioned = " yes" if item.get("mentioned") else " no"
                if text:
                    lines.append(f"- {nickname} (mentioned={mentioned}): {text}")
        if not lines:
            lines = [prompt[:1200]]

        return f"""
You are a decision model for Hoshia, a private AI live-room host.
Nobody explicitly mentioned Hoshia in this batch. Decide whether Hoshia should proactively join the chat.

Room: {room_id}
Energy: {state['energy']:.2f}/1.0
Seconds since last proactive reply: {elapsed:.1f}
Reply threshold: {self.proactive_reply_threshold:.2f}

Recent live-room messages:
{chr(10).join(lines)}

Score each dimension from 0 to 10:
- relevance: Are the messages related to Hoshia, the stream, AI-host behavior, an interesting question, or a topic Hoshia can naturally join?
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
