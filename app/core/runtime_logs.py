from __future__ import annotations

import asyncio
import logging
import traceback
from collections import Counter, deque
from datetime import datetime, timezone
from typing import Any


MAX_LOG_RECORDS = 5000


class RuntimeLogBuffer:
    def __init__(self, max_records: int = MAX_LOG_RECORDS):
        self.max_records = max_records
        self._records: deque[dict[str, Any]] = deque(maxlen=max_records)
        self._counts: Counter[str] = Counter()
        self._next_id = 1
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def append(self, record: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            record = {**record, "id": self._next_id}
            self._next_id += 1
            self._records.append(record)
            self._counts[record["level"].lower()] += 1
            payload = {"type": "runtime_log", "record": record, "counts": self.counts_unlocked()}
            subscribers = list(self._subscribers)

        for queue in subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass
        return record

    async def snapshot(self, limit: int = MAX_LOG_RECORDS) -> dict[str, Any]:
        async with self._lock:
            records = list(self._records)[-limit:]
            return {
                "records": records,
                "counts": self.counts_unlocked(),
                "max_records": self.max_records,
            }

    async def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    def counts_unlocked(self) -> dict[str, int]:
        return {
            "debug": int(self._counts.get("debug", 0)),
            "info": int(self._counts.get("info", 0)),
            "warning": int(self._counts.get("warning", 0)),
            "error": int(self._counts.get("error", 0)),
            "critical": int(self._counts.get("critical", 0)),
            "total": int(sum(self._counts.values())),
        }


runtime_log_buffer = RuntimeLogBuffer()


class RuntimeLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            payload = {
                "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
                "level": record.levelname.lower(),
                "logger": record.name,
                "module": record.module,
                "function": record.funcName,
                "line": record.lineno,
                "message": record.getMessage(),
                "exception": self._format_exception(record),
            }
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            loop.create_task(runtime_log_buffer.append(payload))
        except Exception:
            self.handleError(record)

    def _format_exception(self, record: logging.LogRecord) -> str | None:
        if not record.exc_info:
            return None
        text = "".join(traceback.format_exception(*record.exc_info))
        return text[-8000:]


class MakeAccessLogsDebug(logging.Filter):
    """Demote Uvicorn HTTP access log records from INFO to DEBUG level."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno == logging.INFO:
            record.levelno = logging.DEBUG
            record.levelname = "DEBUG"
        return True


def install_runtime_log_handler() -> RuntimeLogHandler:
    root = logging.getLogger()
    if root.level > logging.INFO:
        root.setLevel(logging.INFO)

    access_logger = logging.getLogger("uvicorn.access")
    access_logger.setLevel(logging.DEBUG)
    if not any(isinstance(f, MakeAccessLogsDebug) for f in access_logger.filters):
        access_logger.addFilter(MakeAccessLogsDebug())

    for handler in root.handlers:
        if isinstance(handler, RuntimeLogHandler):
            return handler
    handler = RuntimeLogHandler()
    handler.setLevel(logging.DEBUG)
    root.addHandler(handler)
    return handler
