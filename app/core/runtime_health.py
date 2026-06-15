from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any


PROCESS_STARTED_AT = datetime.now(timezone.utc)
_tasks: dict[str, dict[str, Any]] = {}
_state: dict[str, Any] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def register_task(name: str, task: asyncio.Task) -> None:
    state = _tasks.setdefault(name, {})
    state["task"] = task
    state["started_at"] = _now()
    state["last_error"] = None
    state.pop("cancelled", None)
    state.pop("stopped_at", None)
    task.add_done_callback(lambda finished, task_name=name: mark_task_stopped(task_name, finished))


def mark_task_success(name: str) -> None:
    state = _tasks.setdefault(name, {})
    state["last_success_at"] = _now()
    state["last_error"] = None


def mark_task_error(name: str, exc: BaseException) -> None:
    state = _tasks.setdefault(name, {})
    state["last_error_at"] = _now()
    state["last_error"] = str(exc)


def mark_task_stopped(name: str, task: asyncio.Task) -> None:
    state = _tasks.setdefault(name, {})
    state["stopped_at"] = _now()
    if task.cancelled():
        state["cancelled"] = True
        return
    exc = task.exception()
    if exc:
        mark_task_error(name, exc)


def task_snapshot() -> dict[str, dict[str, Any]]:
    now = _now()
    snapshot: dict[str, dict[str, Any]] = {}
    for name, state in _tasks.items():
        task = state.get("task")
        started_at = state.get("started_at")
        last_success_at = state.get("last_success_at")
        last_error_at = state.get("last_error_at")
        snapshot[name] = {
            "registered": task is not None,
            "running": bool(task and not task.done()),
            "cancelled": bool(state.get("cancelled")),
            "started_at": _iso(started_at),
            "last_success_at": _iso(last_success_at),
            "last_success_age_seconds": round((now - last_success_at).total_seconds(), 1) if last_success_at else None,
            "last_error_at": _iso(last_error_at),
            "last_error": state.get("last_error"),
            "uptime_seconds": round((now - started_at).total_seconds(), 1) if started_at else None,
        }
    return snapshot


def set_runtime_state(key: str, value: Any) -> None:
    _state[key] = value


def runtime_state_snapshot() -> dict[str, Any]:
    return dict(_state)
