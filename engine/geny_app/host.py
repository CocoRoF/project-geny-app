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

from .protocol import emit


class QuestionCancelled(Exception):
    """AskUserQuestion was dismissed by the user."""


class HostServices:
    """Builds the extras dict and owns the pending UI round-trips."""

    def __init__(self) -> None:
        self._prompts: dict[str, asyncio.Future[Optional[str]]] = {}
        self._turn_of_prompt: dict[str, str] = {}
        #: long-lived per-session objects (task runner, cron store) — they
        #: must outlive a single turn or scheduled work restarts every time
        self._shared: dict[str, Any] = {}

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
            from geny_executor.runtime.task_executors import LocalAgentExecutor, LocalBashExecutor

            key = f"tasks:{session.session_id}"
            runner = self._shared.get(key)
            if runner is None:
                runner = BackgroundTaskRunner()
                self._shared[key] = runner
            out["task_runner"] = runner
            registry = getattr(runner, "registry", None)
            if registry is not None:
                out["task_registry"] = registry
            out.setdefault("task_executors", {
                "bash": LocalBashExecutor(),
                "agent": LocalAgentExecutor(),
            })
        except Exception:
            pass

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
        except Exception:
            pass
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
