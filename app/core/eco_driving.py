"""
Eco-Driving & Driver Safety Scoring Engine.

Evaluates telematics data for:
- Harsh Acceleration (hardware attribute or GPS delta a > +3.0 m/s²)
- Harsh Braking (hardware attribute or GPS delta a < -3.5 m/s²)
- Sharp Cornering (hardware attribute or heading turn rate > 35°/s at speed > 40 km/h)
- Speeding duration (speed > speed limit)
- Excessive Idling (ignition ON with speed < 2 km/h for > 3 minutes)

Computes normalized 0-100% safety scores and letter grades (A/B/C/D/F).
"""

from datetime import datetime, timezone
import logging
import math
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# Default thresholds
DEFAULT_MAX_SPEED_LIMIT_KMH = 120.0
DEFAULT_HARSH_ACCEL_THRESHOLD_MS2 = 2.8   # m/s² (~10.0 km/h/s)
DEFAULT_HARSH_BRAKE_THRESHOLD_MS2 = -3.2  # m/s² (~-11.5 km/h/s)
DEFAULT_HARSH_CORNER_DEG_PER_S = 32.0     # °/s at speed >= 35 km/h

# Speeding severity thresholds (km/h over posted limit)
SPEEDING_MINOR_KMH = 0.0      # > 0 and <= 10 km/h over
SPEEDING_MODERATE_KMH = 10.0  # > 10 and <= 20 km/h over
SPEEDING_SEVERE_KMH = 20.0    # > 20 km/h over (or > 15 km/h over on <= 60 km/h roads)

# Fatigue monitoring thresholds (minutes)
FATIGUE_WARNING_MINUTES = 240.0         # 4.0 hours continuous driving caution
FATIGUE_MAX_CONTINUOUS_MINUTES = 270.0  # 4.5 hours continuous driving limit (EU/DOT tachograph standard)


def normalize_datetime(dt: Any) -> Optional[datetime]:
    if not dt:
        return None
    if isinstance(dt, str):
        try:
            dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
        except Exception:
            return None
    if isinstance(dt, datetime) and dt.tzinfo:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def get_eco_grade(score: float) -> str:
    """Returns letter grade corresponding to eco score (0-100)."""
    if score >= 90.0:
        return "A"
    if score >= 80.0:
        return "B"
    if score >= 70.0:
        return "C"
    if score >= 55.0:
        return "D"
    return "F"


def check_sensor_eco_flags(sensors: dict) -> Tuple[bool, bool, bool]:
    """
    Inspects hardware sensors dictionary for direct harsh event flags.
    Returns (harsh_accel, harsh_brake, harsh_corner).
    """
    if not sensors or not isinstance(sensors, dict):
        return False, False, False

    accel = False
    brake = False
    corner = False

    # Teltonika Green Driving (IO 253): 1 = Harsh Acceleration, 2 = Harsh Braking, 3 = Harsh Cornering
    gd_type = sensors.get("green_driving_type") or sensors.get("green_driving") or sensors.get("io253") or sensors.get("io_253")
    if gd_type is not None:
        try:
            val = int(gd_type)
            if val == 1:
                accel = True
            elif val == 2:
                brake = True
            elif val == 3:
                corner = True
        except (ValueError, TypeError):
            s_val = str(gd_type).lower()
            if "accel" in s_val:
                accel = True
            elif "brake" in s_val or "braking" in s_val:
                brake = True
            elif "corner" in s_val or "turn" in s_val:
                corner = True

    # Generic & custom boolean/numeric flags
    if not accel and (sensors.get("harsh_accel") or sensors.get("harsh_acceleration") or sensors.get("rapid_accel")):
        accel = True
    if not brake and (sensors.get("harsh_brake") or sensors.get("harsh_braking") or sensors.get("sudden_brake")):
        brake = True
    if not corner and (sensors.get("harsh_corner") or sensors.get("harsh_cornering") or sensors.get("sharp_turn")):
        corner = True

    return accel, brake, corner


def evaluate_consecutive_positions(
    prev_pos: Any,
    curr_pos: Any,
    speed_limit_kmh: float = DEFAULT_MAX_SPEED_LIMIT_KMH,
) -> Dict[str, Any]:
    """
    Compares two consecutive positions and determines acceleration, cornering,
    speeding (with severity classification), and idling flags.
    """
    result = {
        "harsh_accel": False,
        "harsh_brake": False,
        "harsh_corner": False,
        "is_speeding": False,
        "speeding_severity": None,
        "overspeed_kmh": 0.0,
        "is_idling": False,
        "dt_seconds": 0.0,
        "acceleration_ms2": 0.0,
        "speed_kmh": getattr(curr_pos, "speed", 0) or 0.0,
    }

    speed2 = float(getattr(curr_pos, "speed", 0) or 0.0)
    ign2 = getattr(curr_pos, "ignition", None)
    sensors2 = getattr(curr_pos, "sensors", None) or {}
    t2 = normalize_datetime(getattr(curr_pos, "device_time", None) or getattr(curr_pos, "timestamp", None))

    # Check speeding and classify severity
    if speed2 > speed_limit_kmh:
        result["is_speeding"] = True
        overspeed = speed2 - speed_limit_kmh
        result["overspeed_kmh"] = round(overspeed, 1)
        if overspeed > SPEEDING_SEVERE_KMH or (speed_limit_kmh <= 60.0 and overspeed > 15.0):
            result["speeding_severity"] = "severe"
        elif overspeed > SPEEDING_MODERATE_KMH:
            result["speeding_severity"] = "moderate"
        else:
            result["speeding_severity"] = "minor"

    # Check idling
    if (ign2 is True or ign2 == 1) and speed2 < 2.0:
        result["is_idling"] = True

    # Check hardware direct sensor attributes first
    hw_accel, hw_brake, hw_corner = check_sensor_eco_flags(sensors2)
    if hw_accel:
        result["harsh_accel"] = True
    if hw_brake:
        result["harsh_brake"] = True
    if hw_corner:
        result["harsh_corner"] = True

    if not prev_pos or not t2:
        return result

    t1 = normalize_datetime(getattr(prev_pos, "device_time", None) or getattr(prev_pos, "timestamp", None))
    if not t1:
        return result

    dt = (t2 - t1).total_seconds()
    if dt < 0.5 or dt > 20.0:
        # Ignore invalid or large time gaps
        return result

    result["dt_seconds"] = dt
    speed1 = float(getattr(prev_pos, "speed", 0) or 0.0)

    # Convert km/h to m/s
    v1_ms = speed1 / 3.6
    v2_ms = speed2 / 3.6
    accel_ms2 = (v2_ms - v1_ms) / dt
    result["acceleration_ms2"] = round(accel_ms2, 2)

    # GPS Mathematical Acceleration / Braking (if not already flagged by hardware)
    if not result["harsh_accel"] and accel_ms2 >= DEFAULT_HARSH_ACCEL_THRESHOLD_MS2:
        result["harsh_accel"] = True

    if not result["harsh_brake"] and accel_ms2 <= DEFAULT_HARSH_BRAKE_THRESHOLD_MS2:
        result["harsh_brake"] = True

    # GPS Mathematical Cornering
    course1 = getattr(prev_pos, "course", None)
    course2 = getattr(curr_pos, "course", None)
    result["turn_rate_deg_s"] = 0.0
    if course1 is not None and course2 is not None and speed2 >= 35.0:
        try:
            c1 = float(course1)
            c2 = float(course2)
            d_course = abs((c2 - c1 + 180) % 360 - 180)
            rate_deg_per_s = d_course / dt
            result["turn_rate_deg_s"] = round(rate_deg_per_s, 1)
            if not result["harsh_corner"] and rate_deg_per_s >= DEFAULT_HARSH_CORNER_DEG_PER_S and d_course >= 30.0:
                result["harsh_corner"] = True
        except (ValueError, TypeError):
            pass

    return result


def calculate_trip_eco_score(
    positions: List[Any],
    distance_km: float = 0.0,
    duration_minutes: float = 0.0,
    speed_limit_kmh: float = DEFAULT_MAX_SPEED_LIMIT_KMH,
    speed_limits_list: Optional[List[Optional[float]]] = None,
) -> Dict[str, Any]:
    """
    Processes a list of chronologically ordered positions for a trip and computes
    overall eco safety score, event counts, coordinates of harsh events,
    tiered speeding breakdown, and continuous driving fatigue risk.

    Optionally accepts `speed_limits_list` (a list of road speed limits corresponding
    to each position in `positions` from Valhalla map-matching).
    """
    continuous_mins_fallback = round(duration_minutes or 0.0, 1)
    if not positions:
        fatigue_risk = "high" if continuous_mins_fallback >= FATIGUE_MAX_CONTINUOUS_MINUTES else (
            "warning" if continuous_mins_fallback >= FATIGUE_WARNING_MINUTES else "none"
        )
        fatigue_penalty = (
            min(20.0, 6.0 + ((continuous_mins_fallback - FATIGUE_MAX_CONTINUOUS_MINUTES) / 15.0) * 2.0)
            if continuous_mins_fallback >= FATIGUE_MAX_CONTINUOUS_MINUTES
            else (2.0 if continuous_mins_fallback >= FATIGUE_WARNING_MINUTES else 0.0)
        )
        final_score = max(0.0, min(100.0, round(100.0 - fatigue_penalty, 1)))
        return {
            "eco_score": final_score,
            "grade": get_eco_grade(final_score),
            "harsh_accel_count": 0,
            "harsh_brake_count": 0,
            "harsh_corner_count": 0,
            "speeding_duration_minutes": 0.0,
            "speeding_minor_minutes": 0.0,
            "speeding_moderate_minutes": 0.0,
            "speeding_severe_minutes": 0.0,
            "idling_duration_minutes": 0.0,
            "continuous_driving_minutes": continuous_mins_fallback,
            "fatigue_risk": fatigue_risk,
            "fatigue_events_count": 1 if fatigue_risk == "high" else 0,
            "events": [],
        }

    harsh_accels = 0
    harsh_brakes = 0
    harsh_corners = 0
    speeding_minor_seconds = 0.0
    speeding_moderate_seconds = 0.0
    speeding_severe_seconds = 0.0
    speeding_seconds = 0.0
    idling_seconds = 0.0
    events = []

    # Continuous driving tracking
    continuous_driving_seconds = 0.0
    warned_fatigue = False
    violated_fatigue = False

    last_event_time = {"accel": 0.0, "brake": 0.0, "corner": 0.0, "speeding": 0.0}

    for i in range(len(positions)):
        curr = positions[i]
        prev = positions[i - 1] if i > 0 else None

        active_limit = speed_limit_kmh
        if speed_limits_list and i < len(speed_limits_list) and speed_limits_list[i] is not None:
            active_limit = float(speed_limits_list[i])

        eval_res = evaluate_consecutive_positions(prev, curr, speed_limit_kmh=active_limit)
        dt = eval_res["dt_seconds"] or 3.0  # default delta fallback
        t_curr = normalize_datetime(getattr(curr, "device_time", None) or getattr(curr, "timestamp", None))
        epoch = t_curr.timestamp() if t_curr else float(i * 3)

        lat = getattr(curr, "latitude", None)
        lng = getattr(curr, "longitude", None)
        speed = eval_res["speed_kmh"]

        # Track continuous driving time (resets if vehicle stopped for > 15 mins)
        if prev and dt > 900.0:
            continuous_driving_seconds = 0.0
        else:
            continuous_driving_seconds += dt

        # Continuous driving fatigue checks
        if continuous_driving_seconds >= FATIGUE_MAX_CONTINUOUS_MINUTES * 60.0 and not violated_fatigue:
            violated_fatigue = True
            if lat is not None and lng is not None:
                events.append({
                    "type": "fatigue",
                    "severity": "severe",
                    "label": "Fatigue Risk (>4.5h Continuous Driving)",
                    "latitude": float(lat),
                    "longitude": float(lng),
                    "speed": round(speed, 1),
                    "time": t_curr.isoformat().replace("T", " ") if t_curr else None,
                    "duration_minutes": round(continuous_driving_seconds / 60.0, 1),
                })
        elif continuous_driving_seconds >= FATIGUE_WARNING_MINUTES * 60.0 and not warned_fatigue and not violated_fatigue:
            warned_fatigue = True
            if lat is not None and lng is not None:
                events.append({
                    "type": "fatigue",
                    "severity": "warning",
                    "label": "Fatigue Warning (4.0h Continuous Driving)",
                    "latitude": float(lat),
                    "longitude": float(lng),
                    "speed": round(speed, 1),
                    "time": t_curr.isoformat().replace("T", " ") if t_curr else None,
                    "duration_minutes": round(continuous_driving_seconds / 60.0, 1),
                })

        # Debounce repeated event triggers within 5 seconds
        if eval_res["harsh_accel"]:
            if epoch - last_event_time["accel"] > 5.0:
                harsh_accels += 1
                last_event_time["accel"] = epoch
                if lat is not None and lng is not None:
                    events.append({
                        "type": "harsh_accel",
                        "label": "Harsh Acceleration",
                        "latitude": float(lat),
                        "longitude": float(lng),
                        "speed": round(speed, 1),
                        "time": t_curr.isoformat().replace("T", " ") if t_curr else None,
                        "acceleration_ms2": eval_res["acceleration_ms2"],
                    })

        if eval_res["harsh_brake"]:
            if epoch - last_event_time["brake"] > 5.0:
                harsh_brakes += 1
                last_event_time["brake"] = epoch
                if lat is not None and lng is not None:
                    events.append({
                        "type": "harsh_brake",
                        "label": "Harsh Braking",
                        "latitude": float(lat),
                        "longitude": float(lng),
                        "speed": round(speed, 1),
                        "time": t_curr.isoformat().replace("T", " ") if t_curr else None,
                        "acceleration_ms2": eval_res["acceleration_ms2"],
                    })

        if eval_res["harsh_corner"]:
            if epoch - last_event_time["corner"] > 5.0:
                harsh_corners += 1
                last_event_time["corner"] = epoch
                if lat is not None and lng is not None:
                    events.append({
                        "type": "harsh_corner",
                        "label": "Sharp Cornering",
                        "latitude": float(lat),
                        "longitude": float(lng),
                        "speed": round(speed, 1),
                        "time": t_curr.isoformat().replace("T", " ") if t_curr else None,
                        "turn_rate_deg_s": eval_res.get("turn_rate_deg_s", 0.0),
                    })

        # Tiered Speeding Accumulation & Event Tagging
        if eval_res["is_speeding"]:
            speeding_seconds += dt
            sev = eval_res.get("speeding_severity") or "minor"
            overspeed = eval_res.get("overspeed_kmh") or (speed - active_limit)
            if sev == "severe":
                speeding_severe_seconds += dt
            elif sev == "moderate":
                speeding_moderate_seconds += dt
            else:
                speeding_minor_seconds += dt

            if epoch - last_event_time["speeding"] > 20.0:
                last_event_time["speeding"] = epoch
                if lat is not None and lng is not None:
                    sev_title = sev.capitalize()
                    events.append({
                        "type": "speeding",
                        "severity": sev,
                        "overspeed_kmh": round(overspeed, 1),
                        "label": f"{sev_title} Speeding ({speed:.0f} km/h on {active_limit:.0f} km/h limit, +{overspeed:.0f} km/h)",
                        "latitude": float(lat),
                        "longitude": float(lng),
                        "speed": round(speed, 1),
                        "speed_limit": round(active_limit, 1),
                        "time": t_curr.isoformat().replace("T", " ") if t_curr else None,
                    })

        if eval_res["is_idling"]:
            idling_seconds += dt

    speeding_minutes = round(speeding_seconds / 60.0, 1)
    speeding_minor_mins = round(speeding_minor_seconds / 60.0, 1)
    speeding_moderate_mins = round(speeding_moderate_seconds / 60.0, 1)
    speeding_severe_mins = round(speeding_severe_seconds / 60.0, 1)
    idling_minutes = round(idling_seconds / 60.0, 1)
    continuous_driving_mins = max(round(continuous_driving_seconds / 60.0, 1), round(duration_minutes or 0.0, 1))

    # Determine overall fatigue risk state
    if violated_fatigue or continuous_driving_mins >= FATIGUE_MAX_CONTINUOUS_MINUTES:
        fatigue_risk = "high"
    elif warned_fatigue or continuous_driving_mins >= FATIGUE_WARNING_MINUTES:
        fatigue_risk = "warning"
    else:
        fatigue_risk = "none"

    # ── Score calculation (100-point scale) ──
    # Penalties are weighted and normalized to prevent short trips from unfairly tanking:
    dist = max(distance_km, 0.5)
    # Scale penalty by trip length (standardized per 100km factor)
    dist_factor = min(1.5, max(0.4, math.sqrt(dist / 10.0)))

    accel_penalty = (harsh_accels * 4.0) / dist_factor
    brake_penalty = (harsh_brakes * 5.0) / dist_factor
    corner_penalty = (harsh_corners * 3.5) / dist_factor

    # Tiered Speeding Penalty (Minor: 0.5 pts/min, Moderate: 1.5 pts/min, Severe: 3.5 pts/min)
    speeding_penalty = min(
        30.0,
        (speeding_minor_mins * 0.5) + (speeding_moderate_mins * 1.5) + (speeding_severe_mins * 3.5),
    )

    # Idling over 3 minutes incurs a small penalty
    excess_idle = max(0.0, idling_minutes - 3.0)
    idle_penalty = min(15.0, excess_idle * 0.5)

    # Fatigue penalty for excessive continuous driving (>4.5h)
    fatigue_penalty = 0.0
    if continuous_driving_mins >= FATIGUE_MAX_CONTINUOUS_MINUTES:
        excess_drive = continuous_driving_mins - FATIGUE_MAX_CONTINUOUS_MINUTES
        fatigue_penalty = min(20.0, 6.0 + (excess_drive / 15.0) * 2.0)
    elif continuous_driving_mins >= FATIGUE_WARNING_MINUTES:
        fatigue_penalty = 2.0

    total_penalty = accel_penalty + brake_penalty + corner_penalty + speeding_penalty + idle_penalty + fatigue_penalty
    final_score = max(0.0, min(100.0, round(100.0 - total_penalty, 1)))

    return {
        "eco_score": final_score,
        "grade": get_eco_grade(final_score),
        "harsh_accel_count": harsh_accels,
        "harsh_brake_count": harsh_brakes,
        "harsh_corner_count": harsh_corners,
        "speeding_duration_minutes": speeding_minutes,
        "speeding_minor_minutes": speeding_minor_mins,
        "speeding_moderate_minutes": speeding_moderate_mins,
        "speeding_severe_minutes": speeding_severe_mins,
        "idling_duration_minutes": idling_minutes,
        "continuous_driving_minutes": continuous_driving_mins,
        "fatigue_risk": fatigue_risk,
        "fatigue_events_count": len([e for e in events if e.get("type") == "fatigue"]),
        "events": events,
    }


async def calculate_trip_eco_score_async(
    positions: List[Any],
    distance_km: float = 0.0,
    duration_minutes: float = 0.0,
    speed_limit_kmh: float = DEFAULT_MAX_SPEED_LIMIT_KMH,
    use_valhalla: bool = True,
) -> Dict[str, Any]:
    """
    Asynchronously evaluates trip telematics and queries Valhalla /trace_attributes
    for exact road speed limits along the route polyline when available.
    """
    speed_limits_list: Optional[List[Optional[float]]] = None
    if use_valhalla and len(positions) >= 2:
        try:
            from core.valhalla import get_trace_speed_limits, is_valhalla_available
            if is_valhalla_available():
                pts = [
                    (float(getattr(p, "latitude", None) or 0.0), float(getattr(p, "longitude", None) or 0.0))
                    for p in positions
                    if getattr(p, "latitude", None) is not None and getattr(p, "longitude", None) is not None
                ]
                if len(pts) == len(positions) and len(pts) >= 2:
                    speed_limits_list = await get_trace_speed_limits(pts)
        except Exception as exc:
            logger.debug("Valhalla speed limit trace query failed: %s", exc)

    return calculate_trip_eco_score(
        positions=positions,
        distance_km=distance_km,
        duration_minutes=duration_minutes,
        speed_limit_kmh=speed_limit_kmh,
        speed_limits_list=speed_limits_list,
    )

