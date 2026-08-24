"""An ASK rule must reach the user, not fall back to a silent deny.

The manifest ships stage-15 with requester 'null'. If nothing replaces it,
an ASK decision has nobody to ask — the engine's documented fallback is a
safe deny, which looks to the user like "the agent refused for no reason"
rather than "you were never asked".

Drives the real tool router with the app's own careful-posture rules.
Run: engine/.venv/bin/python test/permission_engine_test.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "engine")

from geny_app.host import HostServices  # noqa: E402
from geny_app.session import AgentSession, SessionConfig  # noqa: E402


async def main() -> int:
    root = Path(tempfile.mkdtemp())
    agent_dir = root / "agent"
    (agent_dir / "workspace").mkdir(parents=True)

    config = SessionConfig(
        provider="anthropic",
        agent_dir=str(agent_dir),
        model="claude-sonnet-4-5",
        api_key="sk-not-used",
        built_in_tools=["Bash", "Read"],
        posture="careful",   # every mutation and shell call should ASK
    )
    session = AgentSession("permtest", config, HostServices())
    pipeline = await session.pipeline()

    from geny_executor.stages.s10_tool.artifact.default.routers import RegistryRouter
    from geny_executor.tools.base import ToolContext

    # capture what the app would show, and answer it — this is exactly the
    # round trip AppRequester performs against the real UI
    emitted: list[dict] = []
    import geny_app.protocol as protocol

    original_emit = protocol.emit

    def capture(event: dict) -> None:
        emitted.append(event)
        if event.get("type") == "hitl_request":
            # answer as the user would, on the next tick
            asyncio.get_running_loop().call_soon(
                session._host.resolve_approval, str(event.get("token")), answer[0]
            )

    protocol.emit = capture
    # host.py bound `emit` at import time, so patch that reference too
    import geny_app.host as host_mod
    host_mod.emit = capture

    async def attempt(decision: str, filename: str) -> tuple[bool, bool]:
        answer[0] = decision
        emitted.clear()
        target = agent_dir / "workspace" / filename
        ctx = ToolContext(
            session_id="permtest",
            working_dir=str(agent_dir / "workspace"),
            allowed_paths=[str(agent_dir / "workspace")],
            permission_mode="default",
            permission_rules=session.permission_rules,
        )
        ctx.hitl_requester = requester
        await router.route("Bash", {"command": f"touch {target}"}, ctx)
        asked = any(e.get("type") == "hitl_request" for e in emitted)
        return asked, target.exists()

    answer = ["approve"]
    from geny_app.host import AppRequester

    requester = AppRequester(session._host)
    router = RegistryRouter(pipeline.tool_registry)

    asked_yes, ran_yes = await attempt("approve", "approved.txt")
    print(f"{'✓' if asked_yes else '✗'} approve: the user was asked")
    print(f"{'✓' if ran_yes else '✗'} approve: the command ran")

    asked_no, ran_no = await attempt("reject", "rejected.txt")
    print(f"{'✓' if asked_no else '✗'} reject: the user was asked")
    print(f"{'✓' if not ran_no else '✗'} reject: the command did NOT run")

    protocol.emit = original_emit
    host_mod.emit = original_emit
    await session.aclose()
    ok = asked_yes and ran_yes and asked_no and not ran_no
    print(f"\npermission ask: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
