"""Host tools — engine-side Tool objects that call back into Electron.

The engine can only use what is injected into it. Everything the desktop can
do (capture the screen, drive a browser, raise a notification, move the
avatar, read the clipboard) lives in Electron, and before this module there
was no direction in the protocol for the engine to reach it — so none of it
could be an agent tool.

Each spec the app advertises becomes one `Tool` here. Calling it emits
`host_tool_call` and waits for the matching `host_tool_result`; the app must
always answer, because a dropped answer would hang the tool rather than fail
it. Timeouts are therefore an error, not a silence.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Dict, Optional

from geny_executor.tools.base import Tool, ToolContext, ToolResult

from .protocol import emit

DEFAULT_TIMEOUT = 120.0


class HostBridge:
    """Owns the pending calls. One per daemon.

    Also exposes a loopback endpoint so the Claude Code CLI — which runs its
    own tools in its own process and cannot see our registry — can reach the
    same host tools through MCP (see host_mcp.py).
    """

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._server: Any = None
        self.endpoint: Optional[str] = None
        self.token: str = uuid.uuid4().hex

    async def ensure_endpoint(self) -> Optional[str]:
        """Start the loopback listener once; returns 'host:port'."""
        if self.endpoint:
            return self.endpoint
        try:
            server = await asyncio.start_server(self._on_client, "127.0.0.1", 0)
        except OSError:
            return None
        self._server = server
        sock = server.sockets[0] if server.sockets else None
        if sock is None:
            return None
        host, port = sock.getsockname()[:2]
        self.endpoint = f"{host}:{port}"
        return self.endpoint

    async def _on_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=30)
            if not line:
                return
            req = json.loads(line)
            # loopback is not authentication on a shared machine; the token
            # keeps another local process from driving the user's desktop
            if req.get("token") != self.token:
                reply = {"ok": False, "error": "bad token"}
            else:
                reply = await self.call(
                    str(req.get("turnId") or ""), str(req.get("call") or ""), dict(req.get("args") or {})
                )
            writer.write((json.dumps(reply, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    async def call(
        self, turn_id: str, name: str, args: Dict[str, Any], timeout: float = DEFAULT_TIMEOUT
    ) -> Dict[str, Any]:
        call_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[call_id] = fut
        emit({
            "id": turn_id,
            "type": "host_tool_call",
            "callId": call_id,
            "name": name,
            "args": args,
        })
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            return {"ok": False, "error": f"host tool {name!r} did not answer in {timeout:.0f}s"}
        finally:
            self._pending.pop(call_id, None)

    def resolve(self, call_id: str, payload: Dict[str, Any]) -> bool:
        fut = self._pending.get(call_id)
        if fut is None or fut.done():
            return False
        fut.set_result(payload)
        return True

    def fail_all(self, reason: str) -> None:
        """The app went away mid-call — every waiter must fail, not hang."""
        for call_id, fut in list(self._pending.items()):
            if not fut.done():
                fut.set_result({"ok": False, "error": reason})
            self._pending.pop(call_id, None)


class HostTool(Tool):
    """One app-provided capability, exposed to the agent as a normal tool."""

    def __init__(
        self,
        bridge: HostBridge,
        spec: Dict[str, Any],
        turn_id_getter: Any,
    ) -> None:
        self._bridge = bridge
        self._name = str(spec.get("name") or "HostTool")
        self._description = str(spec.get("description") or "")
        self._schema = spec.get("schema") or {"type": "object", "properties": {}}
        self._turn_id = turn_id_getter

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def input_schema(self) -> Dict[str, Any]:
        return self._schema

    async def execute(self, input: Dict[str, Any], context: ToolContext) -> ToolResult:
        turn_id = ""
        try:
            turn_id = str(self._turn_id() or "")
        except Exception:
            pass
        reply = await self._bridge.call(turn_id, self._name, dict(input or {}))
        if not reply.get("ok"):
            return ToolResult(
                content={"error": {"code": "host_tool_failed", "message": reply.get("error") or "failed"}},
                is_error=True,
            )
        return ToolResult(content=reply.get("result"))


def build_host_tools(
    bridge: HostBridge, specs: Optional[list[Dict[str, Any]]], turn_id_getter: Any
) -> list[HostTool]:
    return [HostTool(bridge, spec, turn_id_getter) for spec in (specs or []) if spec.get("name")]
