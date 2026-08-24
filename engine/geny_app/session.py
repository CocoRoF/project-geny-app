"""AgentSession — one resident geny-executor Pipeline per agent session.

Geny's backend does this in a 5,664-line class because it also serves many
users over HTTP. Single-user, in-process, it reduces to: build the manifest,
build the pipeline once, keep PipelineState across turns, refresh runtime at
turn boundaries, aclose() on eviction.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from geny_executor import (
    CredentialBundle,
    Pipeline,
    PipelineState,
    ProviderCredentials,
    build_manifest,
)
from geny_executor.tools.base import ToolContext

DEFAULT_TOOLS = [
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite",
    "WebSearch", "WebFetch", "AskUserQuestion",
]

# manifest presets the engine actually ships
_PRESETS = {"worker_adaptive", "vtuber", "default"}


@dataclass
class SessionConfig:
    provider: str
    agent_dir: str
    model: Optional[str] = None
    preset: str = "worker_adaptive"
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    allowed_paths: Optional[list[str]] = None
    built_in_tools: Optional[list[str]] = None
    permission_mode: str = "default"
    system_prompt: Optional[str] = None
    max_turns: Optional[int] = None
    extras: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> "SessionConfig":
        return cls(
            provider=raw.get("provider") or "anthropic",
            agent_dir=raw["agentDir"],
            model=raw.get("model"),
            preset=raw.get("preset") or "worker_adaptive",
            api_key=raw.get("apiKey"),
            base_url=raw.get("baseUrl"),
            allowed_paths=raw.get("allowedPaths"),
            built_in_tools=raw.get("builtInTools"),
            permission_mode=raw.get("permissionMode") or "default",
            system_prompt=raw.get("systemPrompt"),
            max_turns=raw.get("maxTurns"),
            extras=raw.get("extras") or {},
        )


class AgentSession:
    """Holds the pipeline + conversation state for one session id."""

    def __init__(self, session_id: str, config: SessionConfig, host: Any) -> None:
        self.session_id = session_id
        self.config = config
        self._host = host
        self._pipeline: Optional[Pipeline] = None
        self._state: Optional[PipelineState] = None
        self._lock = asyncio.Lock()
        self.last_used = time.time()

    # ── directories ────────────────────────────────────────────────
    @property
    def agent_dir(self) -> Path:
        return Path(self.config.agent_dir)

    def _ensure_dirs(self) -> tuple[Path, Path, Path]:
        workspace = self.agent_dir / "workspace"
        memory = self.agent_dir / "memory"
        sessions = self.agent_dir / "sessions"
        for d in (workspace, memory, sessions):
            d.mkdir(parents=True, exist_ok=True)
        return workspace, memory, sessions

    # ── build ──────────────────────────────────────────────────────
    def _tool_context(self, workspace: Path) -> ToolContext:
        jail = self.config.allowed_paths or [str(workspace)]
        return ToolContext(
            session_id=self.session_id,
            working_dir=str(workspace),
            storage_path=str(self.agent_dir),
            allowed_paths=jail,
            permission_mode=self.config.permission_mode,
            extras=self._host.build_extras(self),
        )

    async def _build(self) -> Pipeline:
        workspace, memory, _ = self._ensure_dirs()
        preset = self.config.preset if self.config.preset in _PRESETS else "worker_adaptive"
        manifest = build_manifest(
            preset,
            provider=self.config.provider,
            model=self.config.model,
            built_in_tools=self.config.built_in_tools or DEFAULT_TOOLS,
            name=f"agent-{self.session_id}",
        )
        # local, zero-API-call memory: the engine's pure-python file provider
        manifest.memory = {
            "provider": "file",
            "config": {"root": str(memory), "session_id": self.session_id},
        }
        creds = CredentialBundle(
            by_provider={
                self.config.provider: ProviderCredentials(
                    api_key=self.config.api_key or "",
                    base_url=self.config.base_url,
                )
            }
        )
        pipeline = await Pipeline.from_manifest_async(manifest, credentials=creds)
        pipeline.attach_runtime(tool_context=self._tool_context(workspace))
        return pipeline

    async def pipeline(self) -> Pipeline:
        if self._pipeline is None:
            self._pipeline = await self._build()
        return self._pipeline

    async def refresh(self, config: SessionConfig) -> None:
        """Apply config changes at a turn boundary (keys, workspace, mode)."""
        self.config = config
        if self._pipeline is None:
            return
        workspace, _, _ = self._ensure_dirs()
        try:
            self._pipeline.refresh_runtime(tool_context=self._tool_context(workspace))
        except Exception:
            # a refresh the engine refuses means a rebuild is required
            await self.aclose()

    # ── state ──────────────────────────────────────────────────────
    def state(self) -> PipelineState:
        if self._state is None:
            self._state = PipelineState(session_id=self.session_id)
        return self._state

    def state_path(self) -> Path:
        return self.agent_dir / "sessions" / f"{self.session_id}.json"

    def save_state(self) -> None:
        """Best-effort snapshot so a restart can resume the conversation."""
        state = self._state
        if state is None:
            return
        payload: dict[str, Any] = {"session_id": self.session_id, "saved_at": time.time()}
        for attr in ("messages", "history", "turn_count"):
            value = getattr(state, attr, None)
            if value is not None:
                payload[attr] = value
        try:
            self._ensure_dirs()
            self.state_path().write_text(
                json.dumps(payload, ensure_ascii=False, default=str), encoding="utf-8"
            )
        except Exception:
            pass

    async def aclose(self) -> None:
        pipeline, self._pipeline = self._pipeline, None
        if pipeline is None:
            return
        try:
            await pipeline.aclose()
        except Exception:
            pass
