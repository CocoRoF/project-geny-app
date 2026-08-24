"""Sidecar daemon — resident asyncio loop speaking JSON-lines to Electron.

Design points that are load-bearing (each one is a bug someone already hit):
 · one Pipeline per session, kept resident (rebuilding reconnects MCP
   children and re-warms the client every turn)
 · turns are asyncio tasks in ONE loop — not threads; the engine is
   asyncio-native and threads produce N loops and cross-loop hazards
 · exactly one terminal event per turn, and a cancelled turn closes as
   `cancelled` even if the engine stream ended naturally first
 · protocol stdout is claimed at import (see protocol.py)
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
import traceback
from typing import Any, Optional

from .host import HostServices, QuestionCancelled
from .protocol import PROTOCOL_VERSION, emit, shrink
from .session import AgentSession, SessionConfig

IDLE_EVICT_SECONDS = 30 * 60

# engine event → fast-path UI event
_TEXT_EVENTS = {"text.delta", "api.text_delta"}
_TOOL_START = {"api.tool_use", "tool.start", "tool.dispatch"}
_TOOL_RESULT = {"api.tool_result", "tool.result", "tool.complete"}
_TOOL_ERROR = {"tool.error", "tool.failed"}
_USAGE_EVENTS = {"token.usage", "api.usage", "token.recorded"}
_HITL_EVENTS = {"hitl.request"}
# run_stream does NOT raise on engine failure — it yields these and then ends
# normally. Without watching them a failed turn closes as `done` and the UI
# shows a silent success (found by tracing a keyless turn).
_FAILURE_EVENTS = {"pipeline.error", "stage.error", "api.error", "guard.reject", "api.router.error"}


def _event_name(ev: Any) -> str:
    return str(getattr(ev, "type", None) or getattr(ev, "event_type", "") or "")


def _event_data(ev: Any) -> Any:
    return getattr(ev, "data", None)


def _pick(data: Any, *keys: str) -> Any:
    if isinstance(data, dict):
        for k in keys:
            if k in data:
                return data[k]
    return None


class Daemon:
    def __init__(self) -> None:
        self.host = HostServices()
        self.sessions: dict[str, AgentSession] = {}
        self._turns: dict[str, asyncio.Task[None]] = {}
        self._cancelled: set[str] = set()
        self._stopping = asyncio.Event()

    # ── session registry ───────────────────────────────────────────
    async def session(self, sid: str, config: SessionConfig) -> AgentSession:
        existing = self.sessions.get(sid)
        if existing is None:
            existing = AgentSession(sid, config, self.host)
            self.sessions[sid] = existing
        else:
            await existing.refresh(config)
        existing.last_used = time.time()
        return existing

    async def evict(self, sid: str) -> None:
        session = self.sessions.pop(sid, None)
        if session is not None:
            session.save_state()
            await session.aclose()

    async def evict_idle(self) -> None:
        cutoff = time.time() - IDLE_EVICT_SECONDS
        for sid, session in list(self.sessions.items()):
            if session.last_used < cutoff and sid not in {
                t for t in self._turns
            }:
                await self.evict(sid)

    # ── one turn ───────────────────────────────────────────────────
    async def run_turn(self, cmd: dict[str, Any]) -> None:
        turn_id = str(cmd.get("id"))
        sid = str(cmd.get("session") or "default")
        text = str(cmd.get("text") or "")
        try:
            config = SessionConfig.from_json(cmd.get("config") or {})
        except KeyError as exc:
            emit({"id": turn_id, "type": "error", "error": f"config missing {exc}"})
            return

        try:
            session = await self.session(sid, config)
            pipeline = await session.pipeline()
        except Exception as exc:
            emit({
                "id": turn_id,
                "type": "error",
                "error": str(exc) or exc.__class__.__name__,
                "code": getattr(exc, "code", None),
                "trace": traceback.format_exc()[-1200:],
            })
            return

        # host services are per-turn (question_handler must know the turn id)
        try:
            ctx = getattr(pipeline, "tool_context", None)
            if ctx is not None and hasattr(ctx, "extras"):
                ctx.extras.update(self.host.build_extras(session, turn_id))
        except Exception:
            pass

        emit({"id": turn_id, "type": "started", "session": sid})
        count = 0
        failure: Optional[dict[str, Any]] = None
        try:
            async for ev in pipeline.run_stream(text, session.state()):
                count += 1
                observed = self._forward(turn_id, ev)
                # first failure wins — later events are usually its unwinding
                if observed is not None and failure is None:
                    failure = observed
        except asyncio.CancelledError:
            self._close_turn(turn_id, {"id": turn_id, "type": "cancelled"})
            raise
        except QuestionCancelled:
            self._close_turn(turn_id, {"id": turn_id, "type": "cancelled"})
            return
        except Exception as exc:
            self._close_turn(turn_id, {
                "id": turn_id,
                "type": "error",
                "error": str(exc) or exc.__class__.__name__,
                "code": getattr(exc, "code", None),
                "trace": traceback.format_exc()[-1200:],
            })
            return

        session.save_state()
        # precedence: cancel > engine failure > done. A cancel observed
        # mid-stream wins even if the engine finished cleanly first (the
        # done/cancel race); an engine failure must never report success.
        if turn_id in self._cancelled:
            self._close_turn(turn_id, {"id": turn_id, "type": "cancelled"})
        elif failure is not None:
            self._close_turn(turn_id, {
                "id": turn_id,
                "type": "error",
                "error": failure.get("message") or "engine reported a failure",
                "code": failure.get("code"),
            })
        else:
            self._close_turn(turn_id, {"id": turn_id, "type": "done", "events": count})

    def _close_turn(self, turn_id: str, terminal: dict[str, Any]) -> None:
        self._cancelled.discard(turn_id)
        self.host.cancel_prompts_for_turn(turn_id)
        emit(terminal)

    def _forward(self, turn_id: str, ev: Any) -> Optional[dict[str, Any]]:
        """Fan one engine event out to the UI. Returns a failure descriptor
        when the event means the turn cannot succeed, else None."""
        name = _event_name(ev)
        data = _event_data(ev)
        # always forward the raw engine event — the UI's transcript needs it
        emit({"id": turn_id, "type": "event", "event": name, "data": shrink(data, 2000)})

        if name in _TEXT_EVENTS:
            chunk = _pick(data, "text", "delta", "content")
            if isinstance(chunk, str) and chunk:
                emit({"id": turn_id, "type": "chunk", "text": chunk})
        elif name in _TOOL_START:
            emit({
                "id": turn_id, "type": "tool", "phase": "start",
                "name": str(_pick(data, "name", "tool", "tool_name") or "?"),
                "toolUseId": _pick(data, "tool_use_id", "id"),
                "payload": shrink(_pick(data, "input", "args"), 1200),
            })
        elif name in _TOOL_RESULT:
            emit({
                "id": turn_id, "type": "tool", "phase": "result",
                "name": str(_pick(data, "name", "tool", "tool_name") or "?"),
                "toolUseId": _pick(data, "tool_use_id", "id"),
                "payload": shrink(_pick(data, "result", "content", "output"), 1200),
            })
        elif name in _TOOL_ERROR:
            emit({
                "id": turn_id, "type": "tool", "phase": "error",
                "name": str(_pick(data, "name", "tool", "tool_name") or "?"),
                "payload": shrink(data, 1200),
            })
        elif name in _USAGE_EVENTS:
            emit({
                "id": turn_id, "type": "usage",
                "inputTokens": int(_pick(data, "input_tokens", "prompt_tokens") or 0),
                "outputTokens": int(_pick(data, "output_tokens", "completion_tokens") or 0),
                "costUsd": _pick(data, "cost_usd", "cost"),
            })
        elif name in _HITL_EVENTS:
            token = _pick(data, "token")
            if token:
                emit({
                    "id": turn_id, "type": "hitl_request", "token": str(token),
                    "kind": str(_pick(data, "kind", "reason") or "approval"),
                    "detail": shrink(data, 2000),
                })

        if name in _FAILURE_EVENTS:
            message = _pick(data, "message", "error", "detail", "reason")
            code = _pick(data, "code", "error_code")
            text = str(message) if message else name
            emit({"id": turn_id, "type": "notice", "level": "error", "message": text})
            return {"message": text, "code": str(code) if code else None}
        return None

    # ── commands ───────────────────────────────────────────────────
    async def dispatch(self, cmd: dict[str, Any]) -> None:
        op = cmd.get("op")
        cid = str(cmd.get("id") or "")

        if op == "ping":
            emit({"id": cid, "type": "pong"})
        elif op == "turn":
            task = asyncio.create_task(self.run_turn(cmd))
            self._turns[cid] = task
            task.add_done_callback(lambda _t, k=cid: self._turns.pop(k, None))
        elif op == "cancel":
            target = str(cmd.get("target") or "")
            self._cancelled.add(target)
            self.host.cancel_prompts_for_turn(target)
            task = self._turns.get(target)
            if task is not None and not task.done():
                task.cancel()
        elif op == "prompt_reply":
            ok = self.host.reply_prompt(str(cmd.get("promptId")), cmd.get("value"))
            if not ok:
                emit({"id": cid, "type": "notice", "level": "warn",
                      "message": "prompt no longer pending"})
        elif op == "hitl":
            await self._hitl(cmd)
        elif op == "refresh":
            sid = str(cmd.get("session") or "")
            session = self.sessions.get(sid)
            if session is not None:
                await session.refresh(SessionConfig.from_json(cmd.get("config") or {}))
        elif op == "evict":
            await self.evict(str(cmd.get("session") or ""))
        elif op == "shutdown":
            await self.shutdown()
            emit({"id": cid, "type": "notice", "level": "info", "message": "bye"})
            self._stopping.set()
        else:
            emit({"id": cid, "type": "error", "error": f"unknown op {op!r}"})

    async def _hitl(self, cmd: dict[str, Any]) -> None:
        token = str(cmd.get("token") or "")
        decision = str(cmd.get("decision") or "reject")
        for session in self.sessions.values():
            pipeline = getattr(session, "_pipeline", None)
            if pipeline is None:
                continue
            try:
                pending = pipeline.list_pending_hitl()
            except Exception:
                pending = []
            tokens = {
                str(getattr(p, "token", p.get("token") if isinstance(p, dict) else ""))
                for p in (pending or [])
            }
            if token in tokens or not tokens:
                try:
                    pipeline.resume(token, decision)
                    return
                except Exception:
                    continue
        emit({"id": str(cmd.get("id") or ""), "type": "notice", "level": "warn",
              "message": f"hitl token not pending: {token}"})

    async def shutdown(self) -> None:
        for task in list(self._turns.values()):
            task.cancel()
        for sid in list(self.sessions):
            await self.evict(sid)

    # ── run loop ───────────────────────────────────────────────────
    async def serve(self) -> None:
        import geny_executor

        emit({
            "type": "ready",
            "protocol": PROTOCOL_VERSION,
            "engine": getattr(geny_executor, "__version__", "?"),
            "python": sys.version.split()[0],
        })
        reader = asyncio.StreamReader()
        loop = asyncio.get_running_loop()
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        janitor = asyncio.create_task(self._janitor())
        try:
            while not self._stopping.is_set():
                line = await reader.readline()
                if not line:
                    break
                try:
                    cmd = json.loads(line)
                except Exception:
                    continue
                try:
                    await self.dispatch(cmd)
                except Exception as exc:
                    emit({"id": str(cmd.get("id") or ""), "type": "error",
                          "error": str(exc), "trace": traceback.format_exc()[-800:]})
        finally:
            janitor.cancel()
            await self.shutdown()

    async def _janitor(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await self.evict_idle()
            except Exception:
                pass


def main(argv: Optional[list[str]] = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    daemon = Daemon()
    if "--serve" in args:
        asyncio.run(daemon.serve())
        return 0
    # one-shot diagnostic mode: read a single command from stdin
    raw = sys.stdin.read().strip()
    if not raw:
        emit({"type": "error", "error": "no command on stdin"})
        return 2
    asyncio.run(daemon.dispatch(json.loads(raw)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
