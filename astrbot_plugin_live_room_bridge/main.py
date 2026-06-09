import asyncio
import json
import re
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from http import HTTPStatus
from typing import Any

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
    "0.4.0",
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
        self.livingmemory_news_retention_days = max(1, min(int(config.get("livingmemory_news_retention_days", 7)), 365))
        self.livingmemory_recent_state_retention_days = max(1, min(int(config.get("livingmemory_recent_state_retention_days", 30)), 365))
        self._room_states: dict[str, dict[str, float]] = {}
        self._server: asyncio.AbstractServer | None = None
        self._server_task = asyncio.create_task(self._start_server())

    async def terminate(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        self._server_task.cancel()
        try:
            await self._server_task
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

        if request["method"] != "POST" or request["path"] not in {"/live-room/generate", "/live-room/news", "/live-room/context/summarize", "/live-room/memory/debug-recall", "/live-room/music/intent"}:
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
            memory_context = await self._build_livingmemory_context(room_id, messages)
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
                prompt = f"{prompt}\n\nThis is a proactive live-room interjection. Nobody explicitly mentioned you. Reply only if it feels natural, concise, and socially appropriate."

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
        return " ".join(parts)[:500]

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
- pause: asks to pause/stop temporarily.
- resume: asks to continue/resume/play current music.
- next: asks to skip/switch/cut to next song.
- remove: asks to delete queued songs. For "???/?3?/?????", target={{"kind":"queue_index","index":3}}. For "??????/?????", target={{"kind":"requested_by_self"}}.
- status: asks what is playing or what is in the queue.
- none: not a music operation.

Rules:
- Use confidence 0..1.
- If the message is ordinary chat, lyrics discussion, or only says they like music, choose none.
- If request is vague but clearly wants music, still choose request and make a concise Chinese search query.
- Do not invent queue indexes not mentioned by the user.
- Return ONLY JSON with this exact shape:
{{
  "intent": "request|pause|resume|next|remove|status|none",
  "confidence": 0.0,
  "query": "",
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
        if intent not in {"request", "pause", "resume", "next", "remove", "status", "none"}:
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
        return {
            "intent": intent,
            "confidence": confidence,
            "query": self._safe_runtime_text(value.get("query"), 160),
            "target": normalized_target,
            "reply_hint": self._safe_runtime_text(value.get("reply_hint"), 160),
            "source": "astrbot_music_intent",
        }

    def _none_music_intent(self) -> dict[str, Any]:
        return {
            "intent": "none",
            "confidence": 0,
            "query": "",
            "target": {"kind": ""},
            "reply_hint": "",
            "source": "astrbot_music_intent",
        }

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
- willingness: Considering current energy, should Hoshia want to speak?
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
