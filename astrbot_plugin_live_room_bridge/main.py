import asyncio
import json
import re
import time
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
    "0.2.0",
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

        if request["method"] != "POST" or request["path"] not in {"/live-room/generate", "/live-room/news"}:
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

        text = str(payload.get("text", "")).strip()
        prompt_override = str(payload.get("prompt", "")).strip()
        nickname = str(payload.get("nickname", "")).strip()[:32]
        session_id = str(payload.get("session_id", "")).strip()
        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
        reply_targets = payload.get("reply_targets", [])
        messages = payload.get("messages", [])
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
                asyncio.create_task(self._summarize_and_store_viewer_memories(provider_id, room_id, messages, reply_text))
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

    def _selected_viewers(self, messages: Any) -> list[dict[str, str]]:
        if not isinstance(messages, list):
            return []
        selected: list[dict[str, str]] = []
        seen: set[str] = set()
        ordered = sorted(
            [item for item in messages if isinstance(item, dict)],
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
        return selected

    async def _build_livingmemory_context(self, room_id: str, messages: Any) -> str:
        if not self.livingmemory_enabled:
            return ""
        engine = self._livingmemory_engine()
        if not engine:
            return ""

        sections: list[str] = []
        try:
            for viewer in self._selected_viewers(messages):
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
                news_memories = await engine.search_memories(
                    query=news_query,
                    k=self.livingmemory_recall_k,
                    session_id=self._news_session_id(room_id),
                    persona_id=self.livingmemory_persona_id,
                )
                news_lines = self._format_memory_lines(news_memories)
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
        for memory in list(memories or [])[: self.livingmemory_recall_k]:
            content = str(getattr(memory, "content", "") or "").strip()
            if not content:
                continue
            lines.append(f"- {content[:280]}")
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

    async def _summarize_and_store_viewer_memories(self, provider_id: str, room_id: str, messages: Any, reply_text: str):
        try:
            engine = self._livingmemory_engine()
            if not engine:
                return
            for viewer in self._selected_viewers(messages):
                viewer_lines = [
                    str(item.get("text", "")).strip()
                    for item in messages
                    if isinstance(item, dict) and str(item.get("user_id", "")).strip() == viewer["user_id"] and str(item.get("text", "")).strip()
                ]
                if not viewer_lines:
                    continue
                summary_prompt = self._build_memory_summary_prompt(viewer["nickname"], viewer_lines, reply_text)
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
                    await engine.add_memory(
                        content=content[:500],
                        session_id=self._viewer_session_id(room_id, viewer["user_id"]),
                        persona_id=self.livingmemory_persona_id,
                        importance=importance,
                        metadata={
                            "memory_origin": "hoshia_live_room_bridge",
                            "source": "viewer_auto_summary",
                            "viewer_user_id": viewer["user_id"],
                            "viewer_nickname": viewer["nickname"],
                            "topics": topics,
                            "key_facts": key_facts,
                            "sentiment": str(item.get("sentiment", "neutral"))[:32],
                            "create_reason": str(item.get("reason", "stable viewer fact"))[:160],
                        },
                    )
        except Exception as exc:
            logger.warning(f"[live-room-bridge] LivingMemory write skipped: {exc}")

    def _build_memory_summary_prompt(self, nickname: str, viewer_lines: list[str], reply_text: str) -> str:
        return f"""
从下面直播间互动中，只提取适合长期记住的稳定事实。不要保存 Hoshia 人设、系统提示、新闻正文、临时闲聊或敏感密钥。

观众昵称：{nickname}
观众弹幕：
{chr(10).join('- ' + line[:300] for line in viewer_lines[-6:])}

Hoshia 回复：
{reply_text[:500]}

只在以下情况写入：观众明确要求记住、稳定偏好、称呼/身份信息、长期约定、持续关注的话题。
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

    async def _handle_news_ingest(self, payload: dict[str, Any]):
        if not self.livingmemory_enabled:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_disabled"}
        engine = self._livingmemory_engine()
        if not engine:
            return HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "livingmemory_unavailable"}
        room_id = str(payload.get("room_id", "live-room")).strip() or "live-room"
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
