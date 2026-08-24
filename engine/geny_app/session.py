"""AgentSession — one resident geny-executor Pipeline per agent session.

Geny's backend does this in a 5,664-line class because it also serves many
users over HTTP. Single-user, in-process, it reduces to: build the manifest,
build the pipeline once, keep PipelineState across turns, refresh runtime at
turn boundaries, aclose() on eviction.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field, replace
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

from . import policy, state_store

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
    posture: str = policy.DEFAULT_POSTURE
    system_prompt: Optional[str] = None
    max_turns: Optional[int] = None
    timeout_seconds: Optional[float] = None
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
            posture=raw.get("posture") or policy.DEFAULT_POSTURE,
            system_prompt=raw.get("systemPrompt"),
            max_turns=raw.get("maxTurns"),
            timeout_seconds=raw.get("timeoutSeconds"),
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
        #: True when this session's conversation came back from disk
        self.restored = False

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
            # the app states its policy explicitly: the engine's matrix
            # allows on no-match, and the manifest's guard chain never
            # installs, so inheriting the default means "anything goes"
            permission_mode=policy.mode_for(self.config.posture),
            permission_rules=policy.rules_for(self.config.posture),
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
        # The adaptive router REWRITES the caller's model: it resolved
        # "sonnet" to "claude-sonnet-4-6", a model the installed CLI does not
        # know — and an unknown model makes the CLI hang rather than fail, so
        # the turn span until the timeout with no diagnosis. Its tier table
        # is pinned to whatever was current when the engine shipped, which a
        # desktop app cannot keep in sync. The user's model choice is honoured
        # exactly instead; silent substitution is worse than a missed cost
        # optimisation.
        for stage in manifest.stages:
            if stage.get("name") == "api":
                strategies = dict(stage.get("strategies") or {})
                if strategies.get("router") == "adaptive":
                    strategies["router"] = "passthrough"
                    stage["strategies"] = strategies

        # build_manifest emits stage-4 `chain_order` for guards that the
        # default chain does not contain, so strict load logs
        # `chain.order_unappliable` and installs NO guards at all (the
        # permission guard included). Drop the unappliable declaration rather
        # than ship a warning on every boot; real guards are installed
        # explicitly once the app owns its permission policy.
        for stage in manifest.stages:
            if stage.get("name") == "guard" and stage.get("chain_order"):
                stage.pop("chain_order", None)

        # local, zero-API-call memory: the engine's pure-python file provider
        manifest.memory = {
            "provider": "file",
            "config": {"root": str(memory), "session_id": self.session_id},
        }
        creds = CredentialBundle(by_provider={self.config.provider: self._credentials(workspace)})
        pipeline = await Pipeline.from_manifest_async(manifest, credentials=creds)
        pipeline.attach_runtime(tool_context=self._tool_context(workspace))
        return pipeline

    def _credentials(self, workspace: Path) -> ProviderCredentials:
        """Provider credentials, plus the CLI-only extras that decide WHERE
        tools run.

        Asymmetry worth knowing: with the API providers (anthropic/openai) the
        engine executes tools in-process, so `ToolContext.allowed_paths` is the
        jail. With `claude_code_cli` the CLI executes its own tools in its own
        cwd — our jail does not apply. Without `workspace_dir` the CLI inherits
        the sidecar's cwd and writes into the APP'S OWN SOURCE TREE (observed:
        it created x.txt in the repo root). And with the CLI's default
        permission mode it cannot ask anyone — there is no tty — so every edit
        is refused and the agent loops retrying. Hence: workspace as cwd,
        `acceptEdits` inside it.
        """
        creds = ProviderCredentials(
            api_key=self.config.api_key or "",
            base_url=self.config.base_url,
        )
        if self.config.provider != "claude_code_cli":
            return creds
        extras = dict(getattr(creds, "extras", None) or {})
        extras.setdefault("workspace_dir", str(workspace))
        extras.setdefault("default_permission_mode", policy.cli_mode_for(self.config.posture))
        # an unknown model makes the CLI hang rather than fail (observed with
        # the engine's default id) — bound it so the turn can report an error
        if self.config.timeout_seconds:
            extras.setdefault("timeout_s", float(self.config.timeout_seconds))
        try:
            return replace(creds, extras=extras)
        except Exception:
            creds.extras = extras  # type: ignore[attr-defined]
            return creds

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
        """The conversation. Restored from disk the first time it is asked
        for, so a restarted app continues the same session rather than
        silently starting a new one with the same name."""
        if self._state is None:
            state = PipelineState(session_id=self.session_id)
            self._ensure_dirs()
            self.restored = state_store.load_into(self.state_path(), state)
            self._state = state
        return self._state

    def state_path(self) -> Path:
        return self.agent_dir / "sessions" / f"{self.session_id}.json"

    def save_state(self) -> None:
        """Snapshot after every turn. Best-effort: a failed save must never
        take down a turn that already succeeded."""
        state = self._state
        if state is None:
            return
        try:
            self._ensure_dirs()
            state_store.save(self.state_path(), state)
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
