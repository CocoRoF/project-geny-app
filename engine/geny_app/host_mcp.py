"""Host tools as an MCP server — the bridge for the Claude Code CLI backend.

The asymmetry that makes this necessary: with the API providers the engine
executes tools in-process, so a Tool registered on the pipeline reaches the
model directly (verified). With `claude_code_cli` the CLI runs its OWN tools
in its own process — our registry is invisible to it. The CLI's only door for
outside capabilities is MCP.

So the sidecar opens a loopback endpoint, and this module runs as the stdio
MCP server the CLI spawns, forwarding every call back to the sidecar (and
from there to Electron). Same host tools, both backends, one implementation.

Spawned by the CLI as:
    python -I -X utf8 -m geny_app.host_mcp --endpoint 127.0.0.1:PORT --token T
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

DEFAULT_TIMEOUT = 120.0


async def _ask_sidecar(host: str, port: int, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    """One request per call — the CLI's call rate is human-scale, and a
    per-call connection cannot leave a half-open socket behind."""
    try:
        reader, writer = await asyncio.open_connection(host, port)
    except OSError as exc:
        return {"ok": False, "error": f"host bridge unreachable: {exc}"}
    try:
        writer.write((json.dumps({**payload, "token": token}) + "\n").encode("utf-8"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=DEFAULT_TIMEOUT)
        if not line:
            return {"ok": False, "error": "host bridge closed the connection"}
        return json.loads(line)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "host tool timed out"}
    except Exception as exc:  # noqa: BLE001 - report, never crash the server
        return {"ok": False, "error": str(exc)}
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def _serve(endpoint: str, token: str, specs: list[dict[str, Any]]) -> None:
    import mcp.types as types
    from mcp.server import Server
    from mcp.server.stdio import stdio_server

    host, _, port_s = endpoint.rpartition(":")
    port = int(port_s)

    tools = [
        types.Tool(
            name=str(spec.get("name")),
            description=str(spec.get("description") or ""),
            inputSchema=spec.get("schema") or {"type": "object", "properties": {}},
        )
        for spec in specs
        if spec.get("name")
    ]

    async def on_list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
        return types.ListToolsResult(tools=tools)

    async def on_call_tool(_ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        reply = await _ask_sidecar(
            host, port, token, {"call": params.name, "args": dict(params.arguments or {})}
        )
        if not reply.get("ok"):
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=str(reply.get("error") or "failed"))],
                isError=True,
            )
        result = reply.get("result")
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)])

    server = Server("geny-host", version="1", on_list_tools=on_list_tools, on_call_tool=on_call_tool)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--specs", default="")
    args = parser.parse_args(argv)
    specs = json.loads(args.specs) if args.specs else []
    if not specs:
        # specs may also arrive on stdin's first line when the argv would be
        # too long for the platform
        first = sys.stdin.readline()
        specs = json.loads(first) if first.strip() else []
    asyncio.run(_serve(args.endpoint, args.token, specs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
