"""
Rate Limiter Service - Routario Platform
Sliding window rate limiting for authentication and sensitive API endpoints.
"""
import asyncio
import time
from typing import Dict, List, Optional, Tuple
from fastapi import HTTPException, Request, status
import logging

logger = logging.getLogger(__name__)


class SlidingWindowRateLimiter:
    """
    In-memory async sliding window rate limiter.
    Maintains a list of timestamps per key and automatically prunes expired entries.
    """

    def __init__(self):
        self._records: Dict[str, List[float]] = {}
        self._lock = asyncio.Lock()
        self._last_prune = time.time()

    async def check(self, key: str, max_requests: int, window_seconds: int) -> Tuple[bool, int]:
        """
        Check if the request under `key` is allowed within the sliding window.
        Returns:
            (allowed: bool, retry_after_seconds: int)
        """
        now = time.time()
        cutoff = now - window_seconds

        async with self._lock:
            # Periodic background cleanup of all keys every 60s
            if now - self._last_prune > 60:
                self._prune_all(now)
                self._last_prune = now

            timestamps = self._records.get(key, [])
            # Filter out timestamps older than cutoff
            valid_timestamps = [t for t in timestamps if t > cutoff]

            if len(valid_timestamps) >= max_requests:
                earliest_valid = valid_timestamps[0]
                retry_after = max(1, int(window_seconds - (now - earliest_valid)))
                self._records[key] = valid_timestamps
                return False, retry_after

            valid_timestamps.append(now)
            self._records[key] = valid_timestamps
            return True, 0

    def _prune_all(self, now: float):
        """Clean up empty or completely expired keys to prevent memory leaks."""
        keys_to_delete = []
        for k, timestamps in self._records.items():
            valid = [t for t in timestamps if now - t < 3600]
            if not valid:
                keys_to_delete.append(k)
            else:
                self._records[k] = valid
        for k in keys_to_delete:
            self._records.pop(k, None)

    async def reset(self, key: str):
        """Reset rate limit count for a specific key (e.g. after successful login)."""
        async with self._lock:
            self._records.pop(key, None)


rate_limiter = SlidingWindowRateLimiter()


def get_client_ip(request: Request) -> str:
    """Extract client IP taking forward headers into account."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "127.0.0.1"


async def check_rate_limit(key: str, max_requests: int, window_seconds: int) -> Tuple[bool, int]:
    return await rate_limiter.check(key, max_requests, window_seconds)


async def require_rate_limit(
    key: str,
    max_requests: int,
    window_seconds: int,
    detail: str = "Too many requests. Please try again later.",
):
    allowed, retry_after = await rate_limiter.check(key, max_requests, window_seconds)
    if not allowed:
        logger.warning("Rate limit exceeded for key '%s' (retry after %ss)", key, retry_after)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=detail,
            headers={"Retry-After": str(retry_after)},
        )


async def reset_rate_limit(key: str):
    await rate_limiter.reset(key)
