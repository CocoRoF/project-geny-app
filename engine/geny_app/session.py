"""AgentSession — one resident geny-executor Pipeline per agent session.

Geny's backend does this in a 5,664-line class because it also serves many
users over HTTP. Single-user, in-process, it reduces to: build the manifest,
build the pipeline once, keep PipelineState across turns, refresh runtime at
turn boundaries, aclose() on eviction.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
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

# What the agent can reach. Every entry here has its host service wired in
# host.py — a tool whose service is missing answers with an error the user
# cannot act on, which is worse than not offering it. Keep the two in step.
DEFAULT_TOOLS = [
    # files + shell, jailed to the agent workspace
    "Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit",
    # planning
    "TodoWrite", "ExitPlanMode",
    # web
    "WebSearch", "WebFetch",
    # asking the user (routed to the app's prompt UI)
    "AskUserQuestion",
    # background work — needs task_registry + task_runner
    "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskUpdate", "TaskStop",
    # schedules — needs cron_store + cron_runner
    "CronCreate", "CronList", "CronDelete",
    # delegation — needs agent_orchestrator + subagent_registry
    "Agent",
    # MCP resources — the pipeline's own manager
    "ListMcpResources", "ReadMcpResource",
    # discovery: lets the model find deferred tools instead of guessing
    "ToolSearch",
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
    mcp_servers: list[dict[str, Any]] = field(default_factory=list)
    #: directories scanned for SKILL.md and slash commands
    skill_dirs: list[str] = field(default_factory=list)
    command_dirs: list[str] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)
    #: capabilities only Electron can perform, exposed to the agent as tools
    host_tools: list[dict[str, Any]] = field(default_factory=list)
    #: hooks.yaml — user-configurable gates that can block or modify a tool
    hooks_file: Optional[str] = None

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
            mcp_servers=raw.get("mcpServers") or [],
            skill_dirs=raw.get("skillDirs") or [],
            command_dirs=raw.get("commandDirs") or [],
            extras=raw.get("extras") or {},
            host_tools=raw.get("hostTools") or [],
            hooks_file=raw.get("hooksFile"),
        )


class AgentSession:
    """Holds the pipeline + conversation state for one session id."""

    def __init__(self, session_id: str, config: SessionConfig, host: Any) -> None:
        self.session_id = session_id
        self.config = config
        self._host = host
        self._pipeline: Optional[Pipeline] = None
        #: the user's hook gates, or None when they have none
        self.hook_runner: Any = None
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
    @property
    def permission_rules(self) -> list[Any]:
        """The posture's rules — exposed so diagnostics and tests can drive
        the same policy the turn will."""
        return policy.rules_for(self.config.posture)

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

    def _discover_slash_commands(self) -> None:
        """Point the engine's slash registry at the app's command dirs.

        Discovery is global in the engine (one default registry), so this is
        idempotent and additive rather than per-session state."""
        if not self.config.command_dirs:
            return
        try:
            from geny_executor.slash_commands import get_default_registry

            registry = get_default_registry()
            paths = getattr(registry, "discovery_paths", None)
            if paths is None:
                return
            for directory in self.config.command_dirs:
                if directory not in paths:
                    paths.append(directory)
            discover = getattr(registry, "discover_paths", None)
            if callable(discover):
                discover()
        except Exception:
            pass

    async def _build(self) -> Pipeline:
        workspace, memory, _ = self._ensure_dirs()
        self._discover_slash_commands()
        preset = self.config.preset if self.config.preset in _PRESETS else "worker_adaptive"
        manifest = build_manifest(
            preset,
            provider=self.config.provider,
            model=self.config.model,
            built_in_tools=self.config.built_in_tools or DEFAULT_TOOLS,
            mcp_servers=self.config.mcp_servers or None,
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
        # attach_runtime is construction-time only, so everything the session
        # injects has to go in this one call — a later refresh_runtime for the
        # hook runner looked like it worked and left hooks unattached.
        hook_runner = self._build_hook_runner()
        # Stage 15 ships requester 'null' and the tool router reads
        # context.hitl_requester — without both, an ASK rule has nobody to
        # ask and the engine safe-denies, so "신중" refuses instead of asking.
        requester = None
        if self._host is not None:
            try:
                from .host import AppRequester

                requester = AppRequester(self._host)
            except Exception:
                requester = None
        # keep it: the pipeline does not expose one, and both diagnostics and
        # tests need to know whether gates are actually active
        self.hook_runner = hook_runner
        tool_context = self._tool_context(workspace)
        if hook_runner is not None:
            tool_context.hook_runner = hook_runner
        if requester is not None:
            # not a constructor field — the router reads it off the context
            tool_context.hitl_requester = requester
        pipeline.attach_runtime(tool_context=tool_context, hook_runner=hook_runner)
        if requester is not None:
            self._install_requester(pipeline, requester)
        self._register_host_tools(pipeline)
        return pipeline

    def _build_hook_runner(self) -> Any:
        """User hooks — external programs that observe, and can BLOCK, tool
        calls. Returns None when the user has none.

        Two opt-ins on purpose. The engine additionally requires
        GENY_ALLOW_HOOKS in the environment before it will spawn a subprocess,
        because a config file that silently starts running programs on the
        user's machine is not something an app should arrange quietly. The app
        sets it only when a hooks file actually exists and declares
        `enabled: true`.
        """
        path_s = self.config.hooks_file
        if not path_s:
            return None
        path = Path(path_s)
        if not path.exists():
            return None
        try:
            from geny_executor.hooks import HookRunner, load_hooks_config

            config = load_hooks_config(path)
            if not getattr(config, "enabled", False):
                return None
            os.environ.setdefault("GENY_ALLOW_HOOKS", "1")
            return HookRunner(config)
        except Exception as exc:
            # a broken hooks file must not take the session down, but it must
            # not be invisible either
            from .protocol import emit

            emit({
                "type": "notice",
                "level": "warn",
                "message": f"hooks 파일을 읽지 못했습니다 ({path.name}): {exc}",
            })
            return None

    def _install_requester(self, pipeline: Pipeline, requester: Any) -> None:
        """Replace stage 15's null requester so approvals raised there reach
        the app too (the tool router is only one of the two paths)."""
        try:
            stage = pipeline.get_stage("hitl")
            if stage is None:
                return
            for attr in ("requester", "_requester"):
                if hasattr(stage, attr):
                    setattr(stage, attr, requester)
                    return
            slot = getattr(stage, "slots", None)
            if slot is not None and hasattr(slot, "set"):
                slot.set("requester", requester)
        except Exception:
            # a stage shape we do not recognise still leaves the tool-router
            # path working, which covers the permission case
            pass

    def _register_host_tools(self, pipeline: Pipeline) -> None:
        """Expose the app's own capabilities as ordinary agent tools.

        Registered as CORE, i.e. advertised to the model directly. Non-core
        puts them behind progressive disclosure, and a probe showed the model
        then burning a turn on ToolSearch queries that never resolve them —
        the capability existed and was unreachable. An app capability the
        user installed should be visible, not discoverable."""
        specs = self.config.host_tools
        if not specs or self._host is None:
            return
        bridge = getattr(self._host, "bridge", None)
        if bridge is None:
            return
        try:
            from .host_tools import build_host_tools

            registry = pipeline.tool_registry
            if registry is None:
                return
            for tool in build_host_tools(bridge, specs, self._host.current_turn_id):
                registry.register(tool, core=True)
        except Exception:
            # a broken host-tool spec must never take down the session
            pass

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
        # MCP is asymmetric the same way tools are: for API providers the
        # ENGINE connects the servers from the manifest, but under the CLI
        # backend `from_manifest_async` leaves `mcp_manager` empty on purpose
        # — the CLI owns its own MCP. Hand them over as `--mcp-config`
        # instead, or a server the user enabled would silently do nothing.
        # The CLI cannot see engine-registered tools (it runs its own), so
        # the app's host tools are offered to it the only way it accepts
        # outside capabilities: as an MCP server pointed at our loopback
        # bridge. Same tools, both backends.
        if self.config.provider == "claude_code_cli" and self.config.host_tools and self._host is not None:
            bridge = getattr(self._host, "bridge", None)
            # the daemon opens this at startup, so it is just a read here
            endpoint = getattr(bridge, "endpoint", None) if bridge is not None else None
            if endpoint:
                servers = dict((extras.get("mcp_config") or {}).get("mcpServers") or {})
                servers["geny-host"] = {
                    "command": sys.executable,
                    "args": [
                        "-I", "-X", "utf8", "-m", "geny_app.host_mcp",
                        "--endpoint", endpoint,
                        "--token", bridge.token,
                        "--specs", json.dumps(self.config.host_tools, ensure_ascii=False),
                    ],
                }
                extras["mcp_config"] = {"mcpServers": servers}
                # The CLI gates MCP tools behind its own permission prompt,
                # which nothing can answer under a piped host — a probe showed
                # the model calling the tool and then reporting "I don't have
                # permission". These are the APP's own capabilities, already
                # constrained by their handlers (OpenPath stays in the agent
                # dir, ReadUserFile is text-only), so allow them explicitly.
                allow = list(extras.get("allow_tools") or [])
                allow += [f"mcp__geny-host__{spec['name']}" for spec in self.config.host_tools
                          if spec.get("name")]
                extras["allow_tools"] = allow

        if self.config.mcp_servers and "mcp_config" not in extras:
            servers: dict[str, Any] = {}
            for entry in self.config.mcp_servers:
                name = str(entry.get("name") or "").strip()
                command = str(entry.get("command") or "").strip()
                if not name or not command:
                    continue
                spec: dict[str, Any] = {"type": "stdio", "command": command,
                                        "args": list(entry.get("args") or [])}
                env = entry.get("env") or {}
                if env:
                    spec["env"] = dict(env)
                servers[name] = spec
            if servers:
                extras["mcp_config"] = {"mcpServers": servers}
        try:
            return replace(creds, extras=extras)
        except Exception:
            creds.extras = extras  # type: ignore[attr-defined]
            return creds

    async def pipeline(self) -> Pipeline:
        if self._pipeline is None:
            self._pipeline = await self._build()
        return self._pipeline

    #: config fields baked into the manifest at build time — changing any of
    #: them cannot be applied by refresh_runtime, which only swaps the tool
    #: context. A settings screen whose changes the runtime ignores is worse
    #: than no screen (observed: turning Bash off left all 31 tools live), so
    #: these force a rebuild on the next turn instead.
    _MANIFEST_FIELDS = (
        "provider",
        "model",
        "preset",
        "built_in_tools",
        "mcp_servers",
        "host_tools",
        "system_prompt",
    )

    def _manifest_signature(self, config: SessionConfig) -> tuple[Any, ...]:
        def freeze(value: Any) -> Any:
            if isinstance(value, list):
                return tuple(freeze(v) for v in value)
            if isinstance(value, dict):
                return tuple(sorted((k, freeze(v)) for k, v in value.items()))
            return value

        return tuple(freeze(getattr(config, name, None)) for name in self._MANIFEST_FIELDS)

    async def refresh(self, config: SessionConfig) -> None:
        """Apply config changes at a turn boundary.

        Runtime-only changes (keys, workspace, permission mode) are swapped in
        place; anything the manifest captured forces a rebuild, which the next
        turn performs lazily. The conversation is untouched either way — state
        lives on the session, not the pipeline.
        """
        rebuild = self._manifest_signature(config) != self._manifest_signature(self.config)
        self.config = config
        if self._pipeline is None:
            return
        if rebuild:
            await self.aclose()
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
