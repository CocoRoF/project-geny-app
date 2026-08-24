"""Host services — everything the engine pulls out of `ToolContext.extras`.

geny-executor has no HostServices protocol: the seam IS this dict. Each key
is read by a specific built-in tool, so this file is the single place where
"what the app can do for the agent" is declared.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable, Optional

from .protocol import emit


class QuestionCancelled(Exception):
    """AskUserQuestion was dismissed by the user."""


class HostServices:
    """Builds the extras dict and owns the pending UI round-trips."""

    def __init__(self) -> None:
        self._prompts: dict[str, asyncio.Future[Optional[str]]] = {}
        self._turn_of_prompt: dict[str, str] = {}

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

    # ── the extras dict ────────────────────────────────────────────
    def build_extras(self, session: Any, turn_id: str = "") -> dict[str, Any]:
        cfg = session.config
        extras: dict[str, Any] = dict(cfg.extras or {})
        extras["question_handler"] = self._question_handler(turn_id)
        # WebSearch: ddgs needs no key; the app may inject brave/tavily later
        extras.setdefault("web_search", {"backend": "ddgs"})
        return extras
