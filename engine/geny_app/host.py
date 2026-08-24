"""Host services — everything the engine pulls out of `ToolContext.extras`.

geny-executor has no HostServices protocol: the seam IS this dict. Each key
is read by a specific built-in tool, so this file is the single place where
"what the app can do for the agent" is declared.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from .host_tools import HostBridge
from .protocol import emit


class QuestionCancelled(Exception):
    """AskUserQuestion was dismissed by the user."""


class HostServices:
    """Builds the extras dict and owns the pending UI round-trips."""

    def __init__(self) -> None:
        #: engine → app calls (screen capture, notifications, avatar, …)
        self.bridge = HostBridge()
        #: HostTool.execute needs the turn it belongs to so the app can
        #: attribute the call; the daemon sets this around each turn
        self._current_turn: str = ""
        #: wiring problems worth telling the user about, rather than hiding
        self._wiring_errors: list[str] = []
        self._prompts: dict[str, asyncio.Future[Optional[str]]] = {}
        self._turn_of_prompt: dict[str, str] = {}
        #: long-lived per-session objects (task runner, cron store) — they
        #: must outlive a single turn or scheduled work restarts every time
        self._shared: dict[str, Any] = {}

    def wiring_errors(self) -> list[str]:
        return list(self._wiring_errors)

    def current_turn_id(self) -> str:
        return self._current_turn

    def set_current_turn(self, turn_id: str) -> None:
        self._current_turn = turn_id

    # ── AskUserQuestion → UI → back ────────────────────────────────
    def _question_handler(self, turn_id: str) -> Callable[..., Awaitable[str]]:
        async def ask(
            question: str,
            options: Optional[list[str]] = None,
            default: Optional[str] = None,
            timeout_seconds: Optional[float] = None,
            prompt_id: Optional[str] = None,
        ) -> str:
            pid = prompt_id or uuid.uuid4().hex[:12]
            loop = asyncio.get_running_loop()
            fut: asyncio.Future[Optional[str]] = loop.create_future()
            self._prompts[pid] = fut
            self._turn_of_prompt[pid] = turn_id
            emit({
                "id": turn_id,
                "type": "prompt",
                "promptId": pid,
                "question": question,
                "options": options or [],
                "timeoutSeconds": timeout_seconds,
            })
            try:
                if timeout_seconds:
                    value = await asyncio.wait_for(fut, timeout=timeout_seconds)
                else:
                    value = await fut
            finally:
                self._prompts.pop(pid, None)
                self._turn_of_prompt.pop(pid, None)
            if value is None:
                if default is not None:
                    return default
                raise QuestionCancelled(question)
            return value

        return ask

    def reply_prompt(self, prompt_id: str, value: Optional[str]) -> bool:
        fut = self._prompts.get(prompt_id)
        if fut is None or fut.done():
            return False
        fut.set_result(value)
        return True

    def cancel_prompts_for_turn(self, turn_id: str) -> None:
        for pid, tid in list(self._turn_of_prompt.items()):
            if tid != turn_id:
                continue
            fut = self._prompts.get(pid)
            if fut is not None and not fut.done():
                fut.set_result(None)

    # ── background work: tasks and cron ────────────────────────────
    def _background(self, session: Any) -> dict[str, Any]:
        """Task* and Cron* tools need a registry, a runner and a store.

        The engine ships all three; the app only has to give them somewhere
        to live. Cron state is a file under the agent dir so a schedule
        survives a restart — a reminder that silently forgets is worse than
        no reminder.
        """
        out: dict[str, Any] = {}
        agent_dir = Path(session.config.agent_dir)
        try:
            from geny_executor.runtime.task_runner import BackgroundTaskRunner
            from geny_executor.runtime.task_executors import LocalBashExecutor
            from geny_executor.stages.s13_task_registry.artifact.default.file_backed_registry import (
                FileBackedRegistry,
            )

            key = f"tasks:{session.session_id}"
            runner = self._shared.get(key)
            if runner is None:
                # BackgroundTaskRunner(registry, executors) — calling it bare
                # raises TypeError, which a blanket `except` would swallow and
                # leave Task* reporting "no runner" forever. Build it right.
                # TaskRegistry is abstract — the host supplies the store.
                # File-backed so a submitted task survives a restart; an
                # in-memory registry would lose work the user was told was
                # queued.
                tasks_dir = agent_dir / "tasks"
                tasks_dir.mkdir(parents=True, exist_ok=True)
                registry = FileBackedRegistry(str(tasks_dir / "tasks.json"))
                executors = {"bash": LocalBashExecutor()}
                runner = BackgroundTaskRunner(registry, executors)
                start = getattr(runner, "start", None)
                if callable(start):
                    result = start()
                    if hasattr(result, "__await__"):
                        asyncio.ensure_future(result)
                self._shared[key] = runner
                self._shared[f"{key}:registry"] = registry
            out["task_runner"] = runner
            out["task_registry"] = self._shared.get(f"{key}:registry")
        except Exception as exc:
            # never silent: a missing background runner is a capability the
            # user will be told they have and will not get
            self._wiring_errors.append(f"tasks: {exc}")

        try:
            from geny_executor.cron.store_impl.file_backed import FileBackedCronJobStore

            key = f"cron:{session.session_id}"
            store = self._shared.get(key)
            if store is None:
                cron_dir = agent_dir / "cron"
                cron_dir.mkdir(parents=True, exist_ok=True)
                store = FileBackedCronJobStore(str(cron_dir / "jobs.json"))
                self._shared[key] = store
            out["cron_store"] = store

            # A store without a runner is the worst possible combination:
            # CronCreate reports success, the job is persisted, and
            # cron_tools._refresh() returns quietly because there is nothing
            # to refresh — so the schedule never fires and nothing says so.
            # The runner must exist wherever the store does.
            runner_key = f"cron_runner:{session.session_id}"
            runner = self._shared.get(runner_key)
            if runner is None and out.get("task_runner") is not None:
                from geny_executor.cron.runner import CronRunner

                runner = CronRunner(store, out["task_runner"])
                start = getattr(runner, "start", None)
                if callable(start):
                    result = start()
                    if hasattr(result, "__await__"):
                        # started from a running loop: schedule it
                        asyncio.ensure_future(result)
                self._shared[runner_key] = runner
            if runner is not None:
                out["cron_runner"] = runner
        except Exception as exc:
            self._wiring_errors.append(f"cron: {exc}")

        # Delegation. Without an orchestrator the Agent tool answers
        # NO_ORCHESTRATOR — loudly, at least — and the app's subagent tree
        # can never draw anything. The engine ships both the registry and a
        # type-driven orchestrator; the app only has to hand them over.
        try:
            from geny_executor.stages.s12_agent.subagent_catalog import default_subagent_specs
            from geny_executor.stages.s12_agent.subagent_type import (
                SubagentTypeOrchestrator,
                SubagentTypeRegistry,
            )

            key = f"subagents:{session.session_id}"
            bundle = self._shared.get(key)
            if bundle is None:
                registry = SubagentTypeRegistry()
                for spec in default_subagent_specs():
                    try:
                        registry.register(spec)
                    except Exception:
                        pass
                bundle = {
                    "registry": registry,
                    "orchestrator": SubagentTypeOrchestrator(registry),
                }
                self._shared[key] = bundle
            out["agent_orchestrator"] = bundle["orchestrator"]
            out["subagent_registry"] = bundle["registry"]
            # recursion guard: a subagent that can delegate forever will
            out.setdefault("agent_depth", 0)
            out.setdefault("agent_max_depth", 3)
        except Exception as exc:
            self._wiring_errors.append(f"delegation: {exc}")
        return out

    def has_scheduled_work(self, session_id: str) -> bool:
        """Whether this session has cron jobs — idle eviction must not drop a
        session that is supposed to fire something later."""
        store = self._shared.get(f"cron:{session_id}")
        if store is None:
            return False
        try:
            listing = getattr(store, "list", None)
            return bool(listing and listing())
        except Exception:
            return False

    # ── the extras dict ────────────────────────────────────────────
    def build_extras(self, session: Any, turn_id: str = "") -> dict[str, Any]:
        cfg = session.config
        extras: dict[str, Any] = dict(cfg.extras or {})
        extras["question_handler"] = self._question_handler(turn_id)
        # WebSearch: ddgs needs no key; the app may inject brave/tavily later
        extras.setdefault("web_search", {"backend": "ddgs"})
        for key, value in self._background(session).items():
            extras.setdefault(key, value)
        return extras
