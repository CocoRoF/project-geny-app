"""PipelineState persistence — the conversation survives a restart.

`PipelineState` mixes two kinds of field: the conversation (messages,
system, usage ledgers) and live objects rebuilt per pipeline (llm_client,
credentials, tool_dispatcher, event listeners). Persisting it wholesale
would either crash on serialization or, worse, restore a stale client.

So the carried set is an explicit allowlist. Anything not named here is
rebuilt — which is the safe default: a field we forgot to carry costs
context, a live object we wrongly carried costs a corrupted session.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from geny_executor import PipelineState

SCHEMA = 1

#: Fields that carry the conversation across a restart.
CARRIED = (
    "system",
    "messages",
    "iteration",
    "thinking_history",
    "total_cost_usd",
    "session_cost_usd",
    "memory_refs",
    "metadata",
    "shared",
)

#: Usage ledgers are dataclasses — carried through their own dict form.
CARRIED_DATACLASS = ("token_usage",)


def _plain(value: Any) -> Any:
    """Coerce to something json can hold, or drop it."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    for attr in ("model_dump", "to_dict", "_asdict"):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                return _plain(fn())
            except Exception:
                pass
    if hasattr(value, "__dict__"):
        return {k: _plain(v) for k, v in vars(value).items() if not k.startswith("_")}
    return None


def dump(state: PipelineState) -> dict[str, Any]:
    payload: dict[str, Any] = {"schema": SCHEMA, "session_id": state.session_id}
    for name in CARRIED:
        payload[name] = _plain(getattr(state, name, None))
    for name in CARRIED_DATACLASS:
        payload[name] = _plain(getattr(state, name, None))
    return payload


def save(path: Path, state: PipelineState) -> None:
    """Atomic write — a half-written state file is worse than none."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(dump(state), handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_into(path: Path, state: PipelineState) -> bool:
    """Rehydrate `state` in place. Returns False when there is nothing to
    restore or the file is unusable — never raises into a turn."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        return False

    for name in CARRIED:
        if name not in raw or raw[name] is None:
            continue
        try:
            setattr(state, name, raw[name])
        except Exception:
            continue

    # usage ledger: rebuild the dataclass so downstream arithmetic works
    usage = raw.get("token_usage")
    if isinstance(usage, dict):
        current = getattr(state, "token_usage", None)
        for key, value in usage.items():
            if hasattr(current, key) and isinstance(value, (int, float)):
                try:
                    setattr(current, key, value)
                except Exception:
                    pass
    return bool(raw.get("messages"))


def message_count(path: Path) -> int:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return len(raw.get("messages") or [])
    except Exception:
        return 0
