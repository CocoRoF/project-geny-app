"""Permission policy — what an agent may do without asking.

Two facts shape this:

1. The engine's own matrix defaults to ALLOW when nothing matches, and
   `build_manifest` ships a guard chain that never installs (traced: stage 4
   declares an ordering for an empty chain). Left alone, an agent in
   "default" mode can do anything silently. The app therefore states its
   policy explicitly rather than inheriting a permissive default.

2. Tools execute in different places per backend. These rules bind the
   engine-executed tools (anthropic / openai). The claude_code_cli backend
   runs its own tools in its own process and honours only its own permission
   mode — see `SessionConfig._credentials`.

Posture is per agent, chosen at creation and changeable in Config:
  · careful  — mutation asks, network reads allowed
  · standard — edits inside the workspace are allowed, shell asks
  · trusted  — everything allowed (still jailed by allowed_paths)
"""
from __future__ import annotations

from typing import Any, Iterable

from geny_executor.permission import PermissionBehavior, PermissionRule, PermissionSource

#: Tools that only read — safe under every posture.
READ_ONLY = ("Read", "Glob", "Grep", "TodoWrite", "WebSearch", "WebFetch", "NotebookRead")
#: Tools that change the user's machine.
MUTATING = ("Write", "Edit", "NotebookEdit", "MultiEdit")
#: Tools that can do anything at all.
POWERFUL = ("Bash", "SandboxExec", "Ssh", "SshExec")

POSTURES = ("careful", "standard", "trusted")
DEFAULT_POSTURE = "standard"


def _rule(tool: str, behavior: str, reason: str) -> PermissionRule:
    return PermissionRule(
        tool_name=tool,
        behavior=behavior,
        source=PermissionSource.PROJECT if hasattr(PermissionSource, "PROJECT") else "project",
        pattern=None,
        reason=reason,
    )


def rules_for(posture: str) -> list[PermissionRule]:
    """The rule list for a posture. Explicit ALLOW for reads, then the
    posture's stance on mutation, then a catch-all so 'no match' can never
    mean 'allowed'."""
    chosen = posture if posture in POSTURES else DEFAULT_POSTURE
    out: list[PermissionRule] = [
        _rule(tool, PermissionBehavior.ALLOW, "read-only") for tool in READ_ONLY
    ]

    if chosen == "trusted":
        out += [_rule(tool, PermissionBehavior.ALLOW, "trusted agent") for tool in MUTATING + POWERFUL]
        return out

    if chosen == "standard":
        # edits land inside the workspace jail, so they do not need a prompt;
        # a shell can reach anything the user can, so it does
        out += [_rule(tool, PermissionBehavior.ALLOW, "inside the workspace jail") for tool in MUTATING]
        out += [_rule(tool, PermissionBehavior.ASK, "shell can reach the whole machine") for tool in POWERFUL]
        return out

    # careful
    out += [_rule(tool, PermissionBehavior.ASK, "changes files") for tool in MUTATING]
    out += [_rule(tool, PermissionBehavior.ASK, "shell can reach the whole machine") for tool in POWERFUL]
    return out


def mode_for(posture: str) -> str:
    """The engine permission mode that matches the posture."""
    return {"careful": "default", "standard": "acceptEdits", "trusted": "bypass"}.get(
        posture, "acceptEdits"
    )


def cli_mode_for(posture: str) -> str:
    """The claude CLI's own mode. `default` is unusable in a child process —
    there is no tty to answer the prompt, so every edit is refused and the
    agent loops retrying (observed). Careful maps to plan mode instead, which
    is the CLI's read-only stance."""
    return {"careful": "plan", "standard": "acceptEdits", "trusted": "bypassPermissions"}.get(
        posture, "acceptEdits"
    )


def describe(rules: Iterable[PermissionRule]) -> list[dict[str, Any]]:
    """Shape the UI shows in Config → Permissions."""
    return [
        {"tool": r.tool_name, "behavior": str(r.behavior), "reason": r.reason}
        for r in rules
    ]
