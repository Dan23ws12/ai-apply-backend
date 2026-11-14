"""
Collects token usage from every Claude call made while handling one request.

Each endpoint runs its work through `run_tracked()`, and every Claude call calls
`record(response, action)`. The endpoint returns the collected list as "usage", and the
Node API saves one ai_token_usage row per entry. On an error the list is returned inside
the error detail, so tokens spent before a failure are still recorded.
"""

from __future__ import annotations

import time
from contextvars import ContextVar
from typing import Any, Callable

_records: ContextVar[list[dict] | None] = ContextVar("usage_records", default=None)

# Matches the AiAction enum in prisma/schema.prisma
FRAUD_RATING = "FRAUD_RATING"
MATCH_RATING = "MATCH_RATING"
RESUME_TAILORING = "RESUME_TAILORING"
COVER_LETTER = "COVER_LETTER"
FORM_ANSWERS = "FORM_ANSWERS"


def _get(obj: Any, name: str, default: Any = None) -> Any:
    return getattr(obj, name, default) if obj is not None else default


def _plain(obj: Any) -> Any:
    """JSON-safe copy of an SDK object (or anything else) for the details column."""
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump(mode="json")
        except Exception:  # noqa: BLE001
            pass
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    if isinstance(obj, dict):
        return {str(k): _plain(v) for k, v in obj.items()}
    if hasattr(obj, "__dict__"):
        return {k: _plain(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return str(obj)


def record(response: Any, action: str, started: float | None = None) -> None:
    """Saves the usage of one Claude API response. Never raises."""
    records = _records.get()
    if records is None:
        return
    try:
        u = response.usage
        server_tools = _get(u, "server_tool_use")
        iterations = _get(u, "iterations") or []
        details: dict[str, Any] = {"message_id": _get(response, "id")}
        if iterations:
            # Per-attempt usage when a fallback model ran (top-level usage covers only the last attempt).
            details["iterations"] = [_plain(i) for i in iterations]
        records.append({
            "action": action,
            "model": _get(response, "model") or "unknown",
            "input_tokens": _get(u, "input_tokens", 0) or 0,
            "output_tokens": _get(u, "output_tokens", 0) or 0,
            "cache_write_tokens": _get(u, "cache_creation_input_tokens", 0) or 0,
            "cache_read_tokens": _get(u, "cache_read_input_tokens", 0) or 0,
            "web_search_requests": _get(server_tools, "web_search_requests", 0) or 0,
            "fallback_used": any(_get(i, "type") == "fallback_message" for i in iterations),
            "stop_reason": _get(response, "stop_reason"),
            "duration_ms": int((time.time() - started) * 1000) if started else None,
            "details": details,
        })
    except Exception:  # noqa: BLE001 - usage tracking must never break the real work
        pass


def run_tracked(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> tuple[Any, list[dict]]:
    """Runs fn (inside the worker thread) and returns (result, usage records).

    If fn raises, the records are attached to the exception as `.usage`.
    """
    records: list[dict] = []
    token = _records.set(records)
    try:
        return fn(*args, **kwargs), records
    except Exception as e:
        e.usage = records  # type: ignore[attr-defined]
        raise
    finally:
        _records.reset(token)
