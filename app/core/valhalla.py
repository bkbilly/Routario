"""
Valhalla Client
Provides road speed limit lookups via a local Valhalla instance.

Uses /trace_attributes with map-matching for accuracy.
The client is a singleton; availability is checked once at startup
and cached. Individual request failures are silently swallowed so
the alert pipeline is never blocked by routing errors.
"""
import logging
from typing import Optional, List, Tuple

import httpx

logger = logging.getLogger(__name__)

# Module-level availability flag — set by check_valhalla_health() at startup.
_valhalla_available: bool = False
_valhalla_url: str = ""


def set_valhalla_url(url: str) -> None:
    global _valhalla_url
    _valhalla_url = url.rstrip("/")


def is_valhalla_available() -> bool:
    return _valhalla_available


async def check_valhalla_health() -> bool:
    """
    Probe Valhalla at startup. Sets the module-level flag and returns it.
    A simple GET /status is enough; Valhalla returns 200 when healthy.
    """
    global _valhalla_available
    if not _valhalla_url:
        logger.warning("Valhalla URL not configured — speed limit alerts disabled.")
        _valhalla_available = False
        return False

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{_valhalla_url}/status")
            if resp.status_code == 200:
                logger.info(f"Valhalla is available at {_valhalla_url}")
                _valhalla_available = True
                return True
            else:
                logger.warning(
                    f"Valhalla health check returned HTTP {resp.status_code} — "
                    "speed limit alerts disabled."
                )
    except Exception as exc:
        logger.warning(
            f"Valhalla not reachable at {_valhalla_url} ({exc}) — "
            "speed limit alerts disabled."
        )

    _valhalla_available = False
    return False


async def get_speed_limit(
    points: List[Tuple[float, float]],
) -> Optional[float]:
    """
    Query Valhalla /trace_attributes and return the speed limit (km/h)
    for the matched road segment, or None if:
      - Valhalla is unavailable
      - The road has no tagged speed limit
      - Any network / parsing error occurs

    Args:
        points: List of (latitude, longitude) tuples, chronological order.
                At least 2 points are needed for map-matching.
    """
    if not _valhalla_available or not _valhalla_url:
        return None

    if len(points) < 2:
        return None

    shape = [{"lat": lat, "lon": lon} for lat, lon in points]

    payload = {
        "shape": shape,
        "costing": "auto",
        "shape_match": "map_snap",
        "filters": {
            "attributes": ["edge.speed_limit"],
            "action": "include",
        },
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{_valhalla_url}/trace_attributes",
                json=payload,
            )

        if resp.status_code != 200:
            logger.debug(
                f"Valhalla /trace_attributes returned HTTP {resp.status_code}"
            )
            return None

        data = resp.json()
        edges = data.get("edges") or []

        # Collect all non-null speed limits from matched edges and return the
        # most common value (mode), falling back to the first found.
        limits = [
            e["speed_limit"]
            for e in edges
            if isinstance(e.get("speed_limit"), (int, float)) and e["speed_limit"] > 0
        ]

        if not limits:
            return None

        # Use the most frequently occurring limit across matched edges.
        limit = max(set(limits), key=limits.count)
        return float(limit)

    except Exception as exc:
        logger.debug(f"Valhalla speed limit lookup failed: {exc}")
        return None


async def get_trace_speed_limits(
    points: List[Tuple[float, float]],
    chunk_size: int = 1000,
) -> List[Optional[float]]:
    """
    Query Valhalla /trace_attributes for an entire polyline and return the
    road speed limit (km/h) corresponding to each input point in `points`.

    Returns a list of floats (or None where unknown / unmatched) matching
    the exact length of `points`.
    """
    if not _valhalla_available or not _valhalla_url or len(points) < 2:
        return [None] * len(points)

    if len(points) <= chunk_size:
        return await _fetch_trace_speed_limits(points)

    results: List[Optional[float]] = []
    idx = 0
    while idx < len(points):
        chunk = points[idx : idx + chunk_size]
        if len(chunk) < 2:
            results.extend([None] * len(chunk))
            break
        chunk_limits = await _fetch_trace_speed_limits(chunk)
        results.extend(chunk_limits)
        idx += chunk_size

    if len(results) < len(points):
        results.extend([None] * (len(points) - len(results)))
    return results[: len(points)]


async def _fetch_trace_speed_limits(
    points: List[Tuple[float, float]],
) -> List[Optional[float]]:
    if len(points) < 2:
        return [None] * len(points)

    shape = [{"lat": lat, "lon": lon} for lat, lon in points]
    payload = {
        "shape": shape,
        "costing": "auto",
        "shape_match": "map_snap",
        "filters": {
            "attributes": [
                "edge.speed_limit",
                "matched.edge_index",
                "matched.type",
            ],
            "action": "include",
        },
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{_valhalla_url}/trace_attributes",
                json=payload,
            )

        if resp.status_code != 200:
            logger.debug(f"Valhalla trace_attributes returned HTTP {resp.status_code}")
            return [None] * len(points)

        data = resp.json()
        edges = data.get("edges") or []
        matched_points = data.get("matched_points") or []

        limits: List[Optional[float]] = []
        for mp in matched_points:
            edge_idx = mp.get("edge_index")
            if edge_idx is not None and 0 <= edge_idx < len(edges):
                lim = edges[edge_idx].get("speed_limit")
                if isinstance(lim, (int, float)) and lim > 0:
                    limits.append(float(lim))
                else:
                    limits.append(None)
            else:
                limits.append(None)

        if len(limits) < len(points):
            limits.extend([None] * (len(points) - len(limits)))
        return limits[: len(points)]

    except Exception as exc:
        logger.debug(f"Valhalla batch trace speed limit lookup failed: {exc}")
        return [None] * len(points)

