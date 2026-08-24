"""Hooks must be attached AND able to deny — verified without a model.

The app-level test can only exercise this with an API key, because the
in-process tool path is where the hook runner sits (the CLI backend runs its
own tools). This drives the same wiring directly: build a session with a
hooks file, then dispatch a tool and assert the hook stopped it.

Run: engine/.venv/bin/python test/hooks_engine_test.py
"""
from __future__ import annotations

import asyncio
import os
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "engine")

from geny_app.session import AgentSession, SessionConfig  # noqa: E402
from geny_app.host import HostServices  # noqa: E402


def write_deny_hook(root: Path) -> tuple[Path, Path]:
    marker = root / "hook-ran.txt"
    script = root / "deny.sh"
    script.write_text(
        "#!/bin/sh\n"
        "cat > /dev/null\n"
        f'echo ran >> "{marker}"\n'
        # the engine's contract: decision 'block' (not 'deny') and
        # continue:false — HookOutcome.from_response reads exactly these
        "printf '%s' '{\"continue\":false,\"decision\":\"block\","
        "\"stop_reason\":\"blocked by test hook\"}'\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    hooks = root / "hooks.yaml"
    hooks.write_text(
        "enabled: true\n"
        "hooks:\n"
        "  pre_tool_use:\n"
        f"    - command: {script}\n"
        "      timeout_ms: 5000\n"
        "      match:\n"
        "        tool: Bash\n",
        encoding="utf-8",
    )
    return hooks, marker


async def main() -> int:
    root = Path(tempfile.mkdtemp())
    agent_dir = root / "agent"
    (agent_dir / "workspace").mkdir(parents=True)
    hooks_file, marker = write_deny_hook(root)

    config = SessionConfig(
        provider="anthropic",
        agent_dir=str(agent_dir),
        model="claude-sonnet-4-5",
        api_key="sk-not-used-for-tool-dispatch",
        built_in_tools=["Bash", "Read"],
        hooks_file=str(hooks_file),
    )
    session = AgentSession("hooktest", config, HostServices())
    pipeline = await session.pipeline()

    runner = session.hook_runner
    attached = runner is not None
    print(f"{'✓' if attached else '✗'} hook runner attached: {type(runner).__name__ if runner else 'None'}")

    # Dispatch through the ROUTER, not Tool.execute: hooks are consulted by
    # the tool stage's router, so calling the tool directly bypasses exactly
    # the thing under test (the first version of this test did, and reported
    # a pass-shaped failure).
    proof = agent_dir / "workspace" / "hooked.txt"
    tool = pipeline.tool_registry.get("Bash")
    print(f"{'✓' if tool else '✗'} Bash tool present")

    from geny_executor.stages.s10_tool.artifact.default.routers import RegistryRouter
    from geny_executor.tools.base import ToolContext

    router = RegistryRouter(pipeline.tool_registry)
    ctx = ToolContext(
        session_id="hooktest",
        working_dir=str(agent_dir / "workspace"),
        allowed_paths=[str(agent_dir / "workspace")],
        hook_runner=runner,
    )
    result = await router.route("Bash", {"command": f"touch {proof}"}, ctx)
    print(f"  routed result is_error={getattr(result, 'is_error', None)}")

    ran = marker.exists()
    print(f"{'✓' if ran else '✗'} the hook program ran")
    print(f"{'✓' if not proof.exists() else '✗'} the shell command did not happen")

    await session.aclose()
    ok = attached and ran and not proof.exists()
    print(f"\nhooks (engine): {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
