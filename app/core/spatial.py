"""
core/spatial.py

Pure-Python spatial utilities using Shapely.
Replaces all PostGIS / GeoAlchemy2 calls so the app works with
any SQLAlchemy-supported database.
"""
from __future__ import annotations

import logging
from math import atan2, cos, radians, sin, sqrt
from typing import Optional

from shapely import wkt as shapely_wkt
from shapely.geometry import LineString, Point, Polygon

logger = logging.getLogger(__name__)

# ── Distance ──────────────────────────────────────────────────────

def calculate_distance_km(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
) -> float:
    """
    Haversine great-circle distance in kilometres.
    Accurate to within ~0.5 % up to ~500 km — sufficient for alert thresholds.
    """
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


# ── WKT helpers ───────────────────────────────────────────────────

def coords_to_wkt(coords: list[list[float]], geometry_type: str = "polygon") -> str:
    """
    Convert [[lon, lat], ...] (GeoJSON / frontend order) to a WKT string.

    geometry_type: "polygon" | "polyline"
    """
    wkt_coords = ", ".join(f"{lon} {lat}" for lon, lat in coords)
    if geometry_type == "polyline":
        return f"LINESTRING({wkt_coords})"
    # Ensure the ring is closed
    if coords and coords[0] != coords[-1]:
        first = coords[0]
        wkt_coords += f", {first[0]} {first[1]}"
    return f"POLYGON(({wkt_coords}))"


def wkt_to_geojson_coords(
    polygon_wkt: str,
    geometry_type: str = "polygon",
) -> list[list[float]]:
    """
    Convert a WKT string back to [[lon, lat], ...] for the frontend.
    Returns [] on any parse error.
    """
    try:
        geom = shapely_wkt.loads(polygon_wkt)
        if geometry_type == "polyline" or isinstance(geom, LineString):
            return [[lon, lat] for lon, lat in geom.coords]
        # Polygon — return outer ring
        return [[lon, lat] for lon, lat in geom.exterior.coords]
    except Exception as exc:
        logger.warning(f"wkt_to_geojson_coords failed: {exc}")
        return []


# ── Containment ───────────────────────────────────────────────────

def point_in_geometry(lat: float, lon: float, polygon_wkt: str, buffer_meters: int = 50) -> bool:
    """
    Return True if the point (lat, lon) lies inside (or on the boundary of)
    the geometry stored as WKT.

    For LINESTRING geofences the check is whether the point is within
    buffer_meters of the line, which mirrors typical corridor-alert UX.
    """
    try:
        geom = shapely_wkt.loads(polygon_wkt)
        point = Point(lon, lat)

        if isinstance(geom, LineString):
            buffer_deg = buffer_meters / 111_320
            return geom.buffer(buffer_deg).contains(point)

        return geom.contains(point) or geom.boundary.contains(point)
    except Exception as exc:
        logger.warning(f"point_in_geometry failed: {exc}")
        return False
