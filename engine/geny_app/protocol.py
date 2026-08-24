"""Protocol plumbing — the stdout discipline and JSON-lines framing.

fd 1 is duplicated at import time and `sys.stdout` is rebound to stderr:
any library that prints (and several do) would otherwise interleave with
the protocol and desync the Node reader. Only `emit()` may write to the
real fd 1.
"""
from __future__ import annotations

import io
import json
import os
import sys
import threading
from typing import Any

PROTOCOL_VERSION = 1

_lock = threading.Lock()


def _claim_protocol_stdout() -> io.TextIOWrapper:
    fd = os.dup(1)
    try:
        os.dup2(2, 1)  # anything that writes to stdout now lands on stderr
    except OSError:
        pass
    stream = io.TextIOWrapper(
        os.fdopen(fd, "wb", buffering=0), encoding="utf-8", newline="\n", write_through=True
    )
    sys.stdout = sys.stderr  # type: ignore[assignment]
    return stream


_OUT = _claim_protocol_stdout()


def emit(obj: dict[str, Any]) -> None:
    """Write one protocol event. Thread/task safe, never raises upward."""
    try:
        line = json.dumps(obj, ensure_ascii=False, default=_fallback)
    except Exception as exc:  # pragma: no cover - defensive
        line = json.dumps({"type": "notice", "level": "error", "message": f"serialize failed: {exc}"})
    with _lock:
        try:
            _OUT.write(line + "\n")
        except Exception:
            pass


def _fallback(value: Any) -> Any:
    for attr in ("model_dump", "to_dict", "_asdict"):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    if hasattr(value, "__dict__"):
        return {k: v for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def shrink(value: Any, limit: int = 4000) -> Any:
    """Cap event payload size — a Read of a large file must not flood IPC."""
    try:
        text = json.dumps(value, ensure_ascii=False, default=_fallback)
    except Exception:
        return {"_unserializable": True}
    if len(text) <= limit:
        return json.loads(text)
    return {"_truncated": len(text), "preview": text[:limit]}
