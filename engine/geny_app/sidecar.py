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
# `api.tool_use` and `api.cli_tool_call` describe the SAME call (the CLI
# backend emits both), and each fires twice — once with an empty input while
# the arguments are still streaming, then with the full input. Emitting them
# raw produced four cards per call and `?` for every result, because
# `api.tool_result` carries only tool_use_id. Dedupe by tool_use_id, keep the
# richer payload, and remember the name so results can be attributed.
_TOOL_START = {"api.tool_use", "api.cli_tool_call", "tool.start", "tool.dispatch"}
_TOOL_RESULT = {"api.tool_result", "tool.result", "tool.complete"}
_TOOL_ERROR = {"tool.error", "tool.failed"}
_USAGE_EVENTS = {"token.usage", "api.usage", "token.recorded"}
_HITL_EVENTS = {"hitl.request"}
# delegation: the engine reports orchestration boundaries, and subagent work
# arrives with a parent tool_use_id. Forwarding those raw leaves the UI to
# guess the tree; naming them lets it draw one.
_AGENT_START = {"agent.orchestrate_start", "agent.delegate_start", "subagent.start"}
_AGENT_END = {"agent.orchestrate_complete", "agent.delegate_complete", "subagent.complete"}
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
        # per-turn tool bookkeeping: tool_use_id → (name, payload-signature)
        self._tools: dict[str, dict[str, tuple[str, str]]] = {}

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
        """Drop sessions nobody has used. A session with cron jobs is NOT
        idle — evicting it would silently cancel scheduled work."""
        cutoff = time.time() - IDLE_EVICT_SECONDS
        busy = {self._turns[t] and t for t in self._turns}
        for sid, session in list(self.sessions.items()):
            if session.last_used >= cutoff or sid in busy:
                continue
            if self.host.has_scheduled_work(sid):
                continue
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
        budget = float(config.timeout_seconds or 0) or None
        started_at = time.monotonic()
        failure: Optional[dict[str, Any]] = None
        try:
            async for ev in pipeline.run_stream(text, session.state()):
                count += 1
                observed = self._forward(turn_id, ev)
                # first failure wins — later events are usually its unwinding
                if observed is not None and failure is None:
                    failure = observed
                if budget and time.monotonic() - started_at > budget:
                    raise TimeoutError(f"turn exceeded {budget:.0f}s")
        except asyncio.CancelledError:
            self._close_turn(turn_id, {"id": turn_id, "type": "cancelled"})
            raise
        except TimeoutError as exc:
            self._close_turn(turn_id, {
                "id": turn_id, "type": "error", "code": "turn.timeout", "error": str(exc),
            })
            return
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
        self._tools.pop(turn_id, None)
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
            self._emit_tool_start(turn_id, data)
        elif name in _TOOL_RESULT:
            self._emit_tool_result(turn_id, data)
        elif name in _TOOL_ERROR:
            tool_id = str(_pick(data, "tool_use_id", "id") or "")
            emit({
                "id": turn_id, "type": "tool", "phase": "error",
                "name": self._tool_name(turn_id, tool_id, data),
                "toolUseId": tool_id or None,
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

        if name in _AGENT_START:
            emit({
                "id": turn_id, "type": "agent", "phase": "start",
                "name": str(_pick(data, "agent", "name", "role") or "subagent"),
                "parentToolUseId": _pick(data, "parent_tool_use_id", "tool_use_id"),
                "detail": shrink(data, 800),
            })
        elif name in _AGENT_END:
            emit({
                "id": turn_id, "type": "agent", "phase": "end",
                "name": str(_pick(data, "agent", "name", "role") or "subagent"),
                "parentToolUseId": _pick(data, "parent_tool_use_id", "tool_use_id"),
                "detail": shrink(data, 800),
            })

        if name in _FAILURE_EVENTS:
            message = _pick(data, "message", "error", "detail", "reason")
            code = _pick(data, "code", "error_code")
            text = str(message) if message else name
            emit({"id": turn_id, "type": "notice", "level": "error", "message": text})
            return {"message": text, "code": str(code) if code else None}
        return None

    # ── tool event normalization ───────────────────────────────────
    def _tool_name(self, turn_id: str, tool_id: str, data: Any) -> str:
        direct = _pick(data, "name", "tool", "tool_name")
        if direct:
            return str(direct)
        known = self._tools.get(turn_id, {}).get(tool_id)
        return known[0] if known else "?"

    def _emit_tool_start(self, turn_id: str, data: Any) -> None:
        tool_id = str(_pick(data, "tool_use_id", "id") or "")
        name = str(_pick(data, "name", "tool", "tool_name") or "?")
        payload = _pick(data, "input", "args")
        signature = json.dumps(payload, ensure_ascii=False, default=str, sort_keys=True) if payload else ""
        seen = self._tools.setdefault(turn_id, {})
        previous = seen.get(tool_id) if tool_id else None
        # same call, same (or emptier) arguments → already shown
        if previous is not None and (signature == previous[1] or not signature):
            return
        if tool_id:
            seen[tool_id] = (name, signature)
        emit({
            "id": turn_id, "type": "tool", "phase": "start", "name": name,
            "toolUseId": tool_id or None,
            "payload": shrink(payload, 1200),
        })

    def _emit_tool_result(self, turn_id: str, data: Any) -> None:
        tool_id = str(_pick(data, "tool_use_id", "id") or "")
        content = _pick(data, "result", "content", "output")
        failed = bool(_pick(data, "is_error"))
        emit({
            "id": turn_id, "type": "tool",
            "phase": "error" if failed else "result",
            "name": self._tool_name(turn_id, tool_id, data),
            "toolUseId": tool_id or None,
            "payload": shrink(content if content is not None else data, 1200),
        })

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
        elif op == "inspect":
            await self._inspect(cmd)
        elif op == "evict":
            await self.evict(str(cmd.get("session") or ""))
        elif op == "shutdown":
            await self.shutdown()
            emit({"id": cid, "type": "notice", "level": "info", "message": "bye"})
            self._stopping.set()
        else:
            emit({"id": cid, "type": "error", "error": f"unknown op {op!r}"})

    async def _inspect(self, cmd: dict[str, Any]) -> None:
        """Report what the engine ACTUALLY loaded for a session.

        "I added an MCP server" and "the agent can use it" are different
        claims; the second is the one worth showing, so this reads the live
        registries rather than echoing config back.
        """
        cid = str(cmd.get("id") or "")
        sid = str(cmd.get("session") or "")
        report: dict[str, Any] = {"tools": [], "mcpServers": [], "skills": [], "slashCommands": []}
        session = self.sessions.get(sid)
        pipeline = getattr(session, "_pipeline", None) if session else None
        if pipeline is not None:
            try:
                registry = pipeline.tool_registry
                names = getattr(registry, "list_names", None)
                report["tools"] = sorted(names() if callable(names) else list(getattr(registry, "tools", {}) or {}))
            except Exception:
                pass
            # MCPManager exposes list_servers()/list_server_status(), not a
            # `servers` dict — reading the wrong attribute silently reported
            # "0 servers" for a server that was in fact configured, which is
            # the exact lie this panel exists to prevent.
            try:
                manager = pipeline.mcp_manager
                statuses: dict[str, Any] = {}
                status_fn = getattr(manager, "list_server_status", None)
                if callable(status_fn):
                    raw = status_fn()
                    if isinstance(raw, dict):
                        statuses = raw
                    elif isinstance(raw, list):
                        statuses = {
                            str(item.get("name", i)): item
                            for i, item in enumerate(raw)
                            if isinstance(item, dict)
                        }
                names = list(statuses) or list(getattr(manager, "list_servers", lambda: [])())
                for name in names:
                    info = statuses.get(name) if isinstance(statuses.get(name), dict) else {}
                    tools = info.get("tools") or info.get("tool_count")
                    if tools is None:
                        try:
                            tools = len(manager.discover_tools(name) or [])
                        except Exception:
                            tools = 0
                    report["mcpServers"].append({
                        "name": str(name),
                        "tools": int(tools if isinstance(tools, int) else len(tools or [])),
                        "error": info.get("error") or info.get("last_error"),
                        "state": str(info.get("state") or info.get("status") or ""),
                    })
            except Exception as exc:
                report["mcpServers"].append({"name": "(inspect failed)", "tools": 0, "error": str(exc)[:200]})

            # Under the CLI backend the engine's manager stays empty by
            # design — the CLI connects the servers itself, so report what
            # was handed to it rather than an honest-looking "0 servers".
            if not report["mcpServers"] and session is not None:
                for entry in (session.config.mcp_servers or []):
                    report["mcpServers"].append({
                        "name": str(entry.get("name") or "?"),
                        "tools": 0,
                        "state": "delegated-to-cli",
                        "error": None,
                    })
            try:
                skills = getattr(pipeline, "skill_registry", None)
                listing = getattr(skills, "list_all", None)
                if callable(listing):
                    report["skills"] = [
                        {"id": str(getattr(sk, "id", "")), "name": str(getattr(sk, "name", ""))}
                        for sk in listing()
                    ]
            except Exception:
                pass
        try:
            from geny_executor.slash_commands import get_default_registry

            listing = get_default_registry().list_all()
            report["slashCommands"] = sorted(str(getattr(c, "name", c)) for c in listing)
        except Exception:
            pass
        emit({"id": cid, "type": "meta", "data": {"kind": "capabilities", **report}})

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
