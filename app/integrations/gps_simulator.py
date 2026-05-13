"""
app/integrations/gps_simulator.py

GPS Simulator integration.
Simulates a vehicle moving along a defined route in real time.

Waypoint format (one per line):
    lat,lng[,key=value,...]

Supported per-waypoint keys:
    wait=N          seconds to pause at this point (default 0)
    speed=N         travel speed in km/h from this point (overrides global)
    heading=N       reported course in degrees (overrides auto-calculated bearing)
    ignition=true   ignition state from this point onward
    sat=N           satellite count reported at this point
    <any>=<value>   added verbatim to the sensors dict

Backward-compatible shorthand: a bare number as the third field = wait seconds.
    48.8566,2.3522,10        → wait=10

Example route:
    # Start at depot, engine off
    48.8566,2.3522,wait=30,ignition=false,sat=4
    # Pull out, engine on
    48.8600,2.3600,speed=30,ignition=true,sat=8
    # Highway segment
    48.8800,2.4000,speed=110,sat=10,heading=45
    # Traffic jam
    48.9000,2.4200,speed=5,wait=60
    # Destination
    48.9500,2.5000,wait=120,ignition=false,fuel_level=0.4

State is persisted between poll cycles so the simulation survives restarts.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field as dc_field
from datetime import datetime, timezone, timedelta
from typing import AsyncIterator, List, Optional

from integrations.base import BaseIntegration, AuthContext, IntegrationField
from integrations.registry import IntegrationRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(min(a, 1.0)))


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing in degrees [0, 360) from point 1 to point 2."""
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(lat2r)
    y = (math.cos(lat1r) * math.sin(lat2r)
         - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon))
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _interp(lat1: float, lon1: float, lat2: float, lon2: float,
            frac: float) -> tuple[float, float]:
    return lat1 + (lat2 - lat1) * frac, lon1 + (lon2 - lon1) * frac


# ── Waypoint data model ───────────────────────────────────────────────────────

@dataclass
class Waypoint:
    lat:          float
    lng:          float
    wait:         float         = 0.0   # seconds to pause after arriving
    speed:        Optional[float] = None  # km/h for this segment; None = global default
    heading:      Optional[float] = None  # degrees override; None = auto-calculate
    ignition:     Optional[bool]  = None  # None = inherit previous state
    satellites:   Optional[int]   = None
    extra_sensors: dict           = dc_field(default_factory=dict)


# ── Waypoint parser ───────────────────────────────────────────────────────────

_BOOL_TRUE  = {"true", "1", "yes", "on"}
_BOOL_FALSE = {"false", "0", "no", "off"}

def _parse_bool(val: str, key: str) -> bool:
    v = val.strip().lower()
    if v in _BOOL_TRUE:  return True
    if v in _BOOL_FALSE: return False
    raise ValueError(f"Expected true/false for '{key}', got: {val!r}")


def _parse_waypoints(text: str) -> List[Waypoint]:
    """
    Parse waypoints text into a list of Waypoint objects.
    Lines starting with # are treated as comments.
    Raises ValueError with a human-readable message on bad input.
    """
    result: List[Waypoint] = []
    for lineno, raw in enumerate(text.strip().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 2:
            raise ValueError(f"Line {lineno}: expected at least 'lat,lng' — got: {raw!r}")

        try:
            lat = float(parts[0])
            lng = float(parts[1])
        except ValueError:
            raise ValueError(f"Line {lineno}: non-numeric lat/lng in: {raw!r}")

        if not (-90  <= lat <=  90):  raise ValueError(f"Line {lineno}: latitude {lat} out of range [-90, 90]")
        if not (-180 <= lng <= 180):  raise ValueError(f"Line {lineno}: longitude {lng} out of range [-180, 180]")

        wp = Waypoint(lat=lat, lng=lng)
        extra_parts = parts[2:]

        for idx, part in enumerate(extra_parts):
            if "=" in part:
                k, _, v = part.partition("=")
                k = k.strip().lower()
                v = v.strip()
            else:
                # bare number as third field → backward-compat wait seconds
                if idx == 0:
                    try:
                        wp.wait = float(part)
                        continue
                    except ValueError:
                        pass
                raise ValueError(f"Line {lineno}: expected 'key=value', got: {part!r}")

            try:
                if k == "wait":
                    wp.wait = float(v)
                elif k in ("speed", "spd"):
                    wp.speed = float(v)
                    if wp.speed < 0:
                        raise ValueError("speed must be ≥ 0")
                elif k in ("heading", "course", "hdg"):
                    wp.heading = float(v) % 360
                elif k in ("ignition", "ign"):
                    wp.ignition = _parse_bool(v, k)
                elif k in ("sat", "satellites"):
                    wp.satellites = int(float(v))
                else:
                    # arbitrary sensor value
                    try:
                        wp.extra_sensors[k] = float(v)
                    except ValueError:
                        lv = v.lower()
                        if lv in _BOOL_TRUE:
                            wp.extra_sensors[k] = True
                        elif lv in _BOOL_FALSE:
                            wp.extra_sensors[k] = False
                        else:
                            wp.extra_sensors[k] = v
            except ValueError as e:
                raise ValueError(f"Line {lineno}, key '{k}': {e}")

        result.append(wp)

    if len(result) < 2:
        raise ValueError("At least 2 waypoints are required")
    return result


def _truthy(val: object, default: bool = True) -> bool:
    return str(val).strip().lower() in _BOOL_TRUE if val is not None else default


# ── Integration ───────────────────────────────────────────────────────────────

@IntegrationRegistry.register("gps_simulator")
class GPSSimulatorIntegration(BaseIntegration):
    """
    Simulates vehicle movement along a fixed route.
    All per-point attributes (speed, heading, ignition, satellites, sensors)
    are specified inline in the waypoints field.
    """

    PROVIDER_ID                  = "gps_simulator"
    DISPLAY_NAME                 = "GPS Simulator"
    POLL_INTERVAL_SECONDS        = 5
    POLL_INTERVAL_ACTIVE_SECONDS = 5
    SUPPORTS_BROWSE              = False

    FIELDS = [
        IntegrationField(
            key="waypoints",
            label="Waypoints",
            field_type="textarea",
            required=True,
            placeholder=(
                "# lat,lng[,key=value,...]\n"
                "48.8566,2.3522,ignition=false,sat=4\n"
                "48.8600,2.3600,speed=50,ignition=true,sat=8\n"
                "48.8800,2.4000,speed=110,sat=10\n"
                "48.9500,2.5000,wait=60,ignition=false"
            ),
            help_text=(
                "One waypoint per line: lat,lng[,key=value,...]\n"
                "Keys: wait (s), speed (km/h), heading (°), ignition (true/false), "
                "sat (count), or any sensor name=value.\n"
                "Lines starting with # are comments."
            ),
        ),
        IntegrationField(
            key="speed_kmh",
            label="Default Speed (km/h)",
            field_type="number",
            required=False,
            placeholder="50",
            default=50,
            help_text="Fallback speed used for waypoints that don't specify speed=.",
        ),
        IntegrationField(
            key="loop",
            label="Loop Route",
            field_type="text",
            required=False,
            placeholder="true",
            default="true",
            help_text="true = repeat the route continuously; false = stop at the last waypoint.",
        ),
    ]

    # ── Auth ──────────────────────────────────────────────────────────────────

    async def authenticate(self, credentials: dict) -> AuthContext:
        waypoints  = _parse_waypoints(credentials.get("waypoints") or "")
        speed_kmh  = float(credentials.get("speed_kmh") or 50)
        if speed_kmh <= 0:
            raise ValueError("Default speed must be greater than 0 km/h")
        return AuthContext(
            data={
                "waypoints":        waypoints,
                "speed_kmh":        speed_kmh,
                "loop":             _truthy(credentials.get("loop"), True),
                "_persisted_state": {},
            },
            token_expires_at=None,
        )

    # ── Fetch positions ───────────────────────────────────────────────────────

    async def fetch_positions(
        self,
        auth_ctx:  AuthContext,
        devices:   list[dict],
    ) -> AsyncIterator[NormalizedPosition]:
        if not devices:
            return

        waypoints:  List[Waypoint] = auth_ctx.data["waypoints"]
        default_spd: float         = auth_ctx.data["speed_kmh"]
        loop:        bool          = auth_ctx.data["loop"]

        n      = len(waypoints)
        n_segs = n if loop else n - 1

        state: dict = auth_ctx.data.get("_persisted_state") or {}
        now         = datetime.now(timezone.utc)
        now_iso     = now.isoformat()

        # ── First run ─────────────────────────────────────────────────────────
        if not state:
            wp = waypoints[0]
            cur_ign = wp.ignition if wp.ignition is not None else True
            state = {
                "seg_idx":       0,
                "seg_frac":      0.0,
                "waiting_until": None,
                "cur_ignition":  cur_ign,
                "last_time":     now_iso,
            }
            auth_ctx.data["_persisted_state"] = state
            next_wp = waypoints[1 % n]
            course  = wp.heading if wp.heading is not None else _bearing(wp.lat, wp.lng, next_wp.lat, next_wp.lng)
            for dev in devices:
                yield _make_pos(dev["imei"], now, wp.lat, wp.lng,
                                0.0, course, cur_ign, wp.satellites, wp.extra_sensors)
            return

        # ── Parse state ───────────────────────────────────────────────────────
        seg_idx:    int   = int(state.get("seg_idx",    0))
        seg_frac:   float = float(state.get("seg_frac", 0.0))
        cur_ign:    bool  = bool(state.get("cur_ignition", True))
        last_time         = _parse_dt(state.get("last_time")) or now
        elapsed_s         = max((now - last_time).total_seconds(), 0.001)

        # ── Honour a wait pause ───────────────────────────────────────────────
        wu = state.get("waiting_until")
        if wu:
            waiting_until = _parse_dt(wu)
            if waiting_until and now < waiting_until:
                wp = waypoints[seg_idx % n]
                state["last_time"] = now_iso
                auth_ctx.data["_persisted_state"] = state
                for dev in devices:
                    yield _make_pos(dev["imei"], now, wp.lat, wp.lng,
                                    0.0, 0.0, cur_ign, wp.satellites, wp.extra_sensors)
                return
            state["waiting_until"] = None

        # ── Advance simulation ────────────────────────────────────────────────
        dep_wp    = waypoints[seg_idx % n]
        seg_speed = dep_wp.speed if dep_wp.speed is not None else default_spd
        travel_km = seg_speed * elapsed_s / 3600.0
        stopped   = False

        while travel_km > 0:
            if seg_idx >= n_segs:
                stopped  = True
                seg_idx  = n_segs - 1
                seg_frac = 1.0
                break

            wp_s = waypoints[seg_idx % n]
            wp_e = waypoints[(seg_idx + 1) % n]

            # Speed for this segment comes from the departure waypoint
            seg_speed = wp_s.speed if wp_s.speed is not None else default_spd
            seg_km    = max(_haversine_km(wp_s.lat, wp_s.lng, wp_e.lat, wp_e.lng), 1e-9)
            remaining = seg_km * (1.0 - seg_frac)

            if travel_km < remaining:
                seg_frac  += travel_km / seg_km
                travel_km  = 0
            else:
                travel_km -= remaining
                seg_idx   += 1
                seg_frac   = 0.0

                if seg_idx >= n_segs:
                    if loop:
                        seg_idx = 0
                    else:
                        stopped   = True
                        seg_idx   = n_segs - 1
                        seg_frac  = 1.0
                        travel_km = 0
                        break

                # Arrived at the start of the new segment = new waypoint
                arrived = waypoints[seg_idx % n]
                if arrived.ignition is not None:
                    cur_ign = arrived.ignition

                # Recalculate speed for remaining travel on new segment
                travel_km = travel_km * (seg_speed / max(
                    arrived.speed if arrived.speed is not None else default_spd, 1e-9
                )) if travel_km > 0 else 0
                # (No speed conversion needed — travel_km is distance, not time)
                # Reset dep_wp for next iteration
                dep_wp = arrived

                # Check wait
                if arrived.wait > 0:
                    state["waiting_until"] = (now + timedelta(seconds=arrived.wait)).isoformat()
                    travel_km = 0

        # ── Compute output position ───────────────────────────────────────────
        wp_s     = waypoints[seg_idx % n]
        wp_e     = waypoints[(seg_idx + 1) % n]
        lat, lng = _interp(wp_s.lat, wp_s.lng, wp_e.lat, wp_e.lng, seg_frac)

        # Use departure waypoint's heading override or auto-calculate bearing
        if wp_s.heading is not None:
            course = wp_s.heading
        else:
            course = _bearing(wp_s.lat, wp_s.lng, wp_e.lat, wp_e.lng)

        # Speed: 0 if stopped/waiting, else departure waypoint speed
        if stopped or state.get("waiting_until"):
            out_speed = 0.0
        else:
            out_speed = wp_s.speed if wp_s.speed is not None else default_spd

        state["seg_idx"]      = seg_idx
        state["seg_frac"]     = seg_frac
        state["cur_ignition"] = cur_ign
        state["last_time"]    = now_iso
        auth_ctx.data["_persisted_state"] = state

        for dev in devices:
            yield _make_pos(dev["imei"], now,
                            round(lat, 7), round(lng, 7),
                            round(out_speed, 2), round(course, 2),
                            cur_ign, wp_s.satellites, wp_s.extra_sensors)

    # ── Test credentials ──────────────────────────────────────────────────────

    async def test_credentials(self, credentials: dict) -> tuple[bool, str]:
        try:
            waypoints  = _parse_waypoints(credentials.get("waypoints") or "")
            speed      = float(credentials.get("speed_kmh") or 50)
            if speed <= 0:
                return False, "Default speed must be greater than 0 km/h"
            loop = _truthy(credentials.get("loop"), True)
            total_km = sum(
                _haversine_km(waypoints[i].lat, waypoints[i].lng,
                              waypoints[i + 1].lat, waypoints[i + 1].lng)
                for i in range(len(waypoints) - 1)
            )
            if loop:
                total_km += _haversine_km(waypoints[-1].lat, waypoints[-1].lng,
                                          waypoints[0].lat, waypoints[0].lng)
            loop_str = "looping" if loop else "one-way"
            return True, (
                f"Simulator ready: {len(waypoints)} waypoints, "
                f"{total_km:.1f} km route, default {speed} km/h, {loop_str}"
            )
        except ValueError as e:
            return False, str(e)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_dt(val: object) -> Optional[datetime]:
    if not val:
        return None
    try:
        dt = datetime.fromisoformat(str(val))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _make_pos(
    imei:      str,
    ts:        datetime,
    lat:       float,
    lng:       float,
    speed:     float,
    course:    float,
    ignition:  bool,
    satellites: Optional[int],
    extra:     dict,
) -> NormalizedPosition:
    sensors = {**extra, "simulated": True}
    return NormalizedPosition(
        imei=imei,
        device_time=ts,
        server_time=ts,
        latitude=lat,
        longitude=lng,
        speed=speed,
        course=course,
        ignition=ignition,
        satellites=satellites,
        sensors=sensors,
        raw_data={"source": "gps_simulator"},
    )
