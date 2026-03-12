"""
Speeding Alert (Valhalla-backed)
=================================
Fires when a vehicle exceeds the road's actual speed limit for a
configurable duration.

How it works
------------
1. If the current speed is below `min_speed_kmh` (default 30), the check
   is skipped — avoids noisy lookups at low speeds / in traffic.

2. Every `check_interval_seconds` (default 10) the alert queries the local
   Valhalla instance via /trace_attributes, passing the last
   `trace_seconds` (default 15) of recorded positions for accurate
   map-matching. The interval is measured against wall-clock time (not
   device time) so replayed or backdated positions don't hammer Valhalla.

3. If only one position is available for the trace window the current
   position is appended as a second point so Valhalla always receives the
   minimum two shape entries required for map-matching.

4. If Valhalla is unavailable (failed health check at startup, or any
   individual request error), the check is silently skipped.

5. If the matched road has no tagged speed limit, the check is silently
   skipped.

6. The alert fires only after the vehicle has continuously exceeded
   `limit × (1 + overspeed_percent / 100)` for at least
   `duration_seconds`.

State keys stored per-device (all in alert_states dict)
---------------------------------------------------------
  sl_last_check_wall  – wall-clock ISO timestamp of the last Valhalla call
  sl_cached_limit     – speed limit (km/h) returned by that call, or None
  speeding_since      – ISO timestamp when current overspeed episode began
  speeding_alerted    – True once the alert has fired for this crossing.
                        Resets to False when speed drops back below threshold,
                        allowing the alert to fire again on the next crossing.
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Tuple

from .base import BaseAlert, AlertDefinition, AlertField
from models.schemas import AlertType, Severity
from core.valhalla import is_valhalla_available, get_speed_limit
from core.database import get_db

logger = logging.getLogger(__name__)


class SpeedingAlert(BaseAlert):

    @classmethod
    def definition(cls) -> AlertDefinition:
        return AlertDefinition(
            key        = "speed_tolerance",
            alert_type = AlertType.SPEEDING,
            label      = "Speed Limit Alert",
            description= (
                "Fires when the vehicle exceeds the road's actual speed limit "
                "(fetched live from Valhalla / OpenStreetMap) by more than the "
                "configured tolerance for the configured duration."
            ),
            icon       = "⚡",
            severity   = Severity.WARNING,
            state_keys = [
                "sl_last_check_wall",
                "sl_cached_limit",
                "speeding_since",
                "speeding_alerted",
            ],
            fields     = [
                AlertField(
                    key       = "overspeed_percent",
                    label     = "Overspeed Tolerance",
                    unit      = "%",
                    default   = 10,
                    min_value = 0,
                    max_value = 50,
                    help_text = (
                        "Alert fires when speed exceeds the road limit by this "
                        "percentage. 10% on a 50 km/h road triggers at 55 km/h."
                    ),
                ),
                AlertField(
                    key       = "duration_seconds",
                    label     = "Confirmation Duration",
                    unit      = "seconds",
                    default   = 15,
                    min_value = 0,
                    max_value = 300,
                    help_text = (
                        "Speed must be exceeded continuously for this long before "
                        "the alert fires. Set to 0 to fire immediately."
                    ),
                ),
                AlertField(
                    key       = "min_speed_kmh",
                    label     = "Minimum Speed to Check",
                    unit      = "km/h",
                    default   = 30,
                    min_value = 0,
                    max_value = 100,
                    help_text = (
                        "Speed limit lookup is skipped when the vehicle is slower "
                        "than this value. Avoids noise at very low speeds."
                    ),
                ),
                AlertField(
                    key       = "check_interval_seconds",
                    label     = "Valhalla Query Interval",
                    unit      = "seconds",
                    default   = 10,
                    min_value = 5,
                    max_value = 60,
                    help_text = (
                        "How often to query Valhalla for the current road speed "
                        "limit. Shorter = more accurate but more server load."
                    ),
                ),
                AlertField(
                    key       = "trace_seconds",
                    label     = "Trace Window",
                    unit      = "seconds",
                    default   = 15,
                    min_value = 5,
                    max_value = 60,
                    help_text = (
                        "How many seconds of recent GPS history to send to "
                        "Valhalla for map-matching. More points = better accuracy."
                    ),
                ),
            ],
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _wall_seconds_since(iso_ts: Optional[str]) -> float:
        """Elapsed real-world seconds since a stored wall-clock ISO timestamp."""
        if not iso_ts:
            return float("inf")
        try:
            ts = datetime.fromisoformat(iso_ts).replace(tzinfo=None)
            return (datetime.utcnow() - ts).total_seconds()
        except Exception:
            return float("inf")

    @staticmethod
    def _device_seconds_since(iso_ts: Optional[str], now: datetime) -> float:
        """Elapsed device-time seconds since a stored ISO timestamp."""
        if not iso_ts:
            return float("inf")
        try:
            ts = datetime.fromisoformat(iso_ts).replace(tzinfo=None)
            return (now.replace(tzinfo=None) - ts).total_seconds()
        except Exception:
            return float("inf")

    async def _fetch_recent_points(
        self,
        device_id: int,
        trace_seconds: int,
        current_lat: float,
        current_lon: float,
    ) -> List[Tuple[float, float]]:
        """
        Return (lat, lon) pairs for the last `trace_seconds` from the DB.
        Always guarantees at least two points by appending the current
        position if the DB returns fewer (handles first-position edge case).

        Import of get_db is deferred to inside this method to avoid a
        module-level circular import: alerts/ -> core.database -> alerts/
        """
        points: List[Tuple[float, float]] = []
        try:
            db = get_db()
            now_utc = datetime.utcnow()
            start   = now_utc - timedelta(seconds=trace_seconds)
            records = await db.get_position_history(
                device_id,
                start_time=start,
                end_time=now_utc,
                max_points=20,
                order="asc",
            )
            points = [
                (r.latitude, r.longitude)
                for r in records
                if r.latitude is not None and r.longitude is not None
            ]
        except Exception as exc:
            logger.debug(f"SpeedingAlert: could not fetch recent positions: {exc}")

        current = (current_lat, current_lon)

        # Ensure the very latest position is always the last point
        if not points:
            points = [current, current]
        else:
            if points[-1] != current:
                points.append(current)
            # Valhalla requires at least 2 shape points
            if len(points) < 2:
                points.insert(0, current)

        return points

    # ------------------------------------------------------------------
    # Core check
    # ------------------------------------------------------------------

    async def check(self, position, device, state, params: dict) -> Optional[dict]:
        # ── 0. Valhalla must be available ────────────────────────────────────
        if not is_valhalla_available():
            return None

        # ── 1. Read params ───────────────────────────────────────────────────
        overspeed_pct  = float(params.get("overspeed_percent",      10))
        duration       = float(params.get("duration_seconds",       15))
        min_speed      = float(params.get("min_speed_kmh",          30))
        check_interval = float(params.get("check_interval_seconds", 10))
        trace_secs     = int(  params.get("trace_seconds",          15))

        current_speed = position.speed or 0.0
        device_now    = position.device_time.replace(tzinfo=None)

        # ── 2. Below minimum speed — reset & skip ────────────────────────────
        if current_speed < min_speed:
            state.alert_states["speeding_since"]   = None
            state.alert_states["speeding_alerted"] = False
            state.alert_states["sl_cached_limit"]  = None
            return None

        # ── 3. Maybe refresh the cached speed limit from Valhalla ────────────
        # Wall-clock interval prevents backdated device clocks from causing a
        # flood of Valhalla requests on every position update.
        since_last_check = self._wall_seconds_since(
            state.alert_states.get("sl_last_check_wall")
        )

        if since_last_check >= check_interval:
            # Stamp the attempt immediately so even if get_speed_limit raises,
            # we won't hammer Valhalla on the next position.
            state.alert_states["sl_last_check_wall"] = datetime.utcnow().isoformat()

            points = await self._fetch_recent_points(
                device.id, trace_secs,
                position.latitude, position.longitude,
            )
            fetched_limit = await get_speed_limit(points)

            if fetched_limit is not None:
                prev_limit = state.alert_states.get("sl_cached_limit")
                state.alert_states["sl_cached_limit"] = fetched_limit

                # Road limit changed → reset overspeed episode so a new alert
                # can fire on the new road segment.
                if prev_limit is not None and prev_limit != fetched_limit:
                    state.alert_states["speeding_since"] = None
                    logger.debug(
                        f"SpeedingAlert [{device.name}]: road limit changed "
                        f"{prev_limit} → {fetched_limit} km/h, episode reset"
                    )
            # If Valhalla returns no limit (untagged road or transient error),
            # keep the previously cached value so the alert can still fire.

        # ── 4. No cached limit → skip silently ──────────────────────────────
        limit = state.alert_states.get("sl_cached_limit")
        if limit is None:
            return None

        # ── 5. Evaluate overspeed ────────────────────────────────────────────
        threshold = limit * (1.0 + overspeed_pct / 100.0)

        if current_speed <= threshold:
            # Back within tolerance — reset episode
            state.alert_states["speeding_since"]   = None
            state.alert_states["speeding_alerted"] = False
            return None

        # Already fired for this crossing — wait until speed drops below
        # threshold (step 5 above) before allowing another alert.
        if state.alert_states.get("speeding_alerted"):
            return None

        # ── 6. Duration gate (device time for consistency with position log) ─
        since = state.alert_states.get("speeding_since")
        if not since:
            state.alert_states["speeding_since"] = device_now.isoformat()
            return None

        elapsed = self._device_seconds_since(since, device_now)
        if elapsed < duration:
            return None

        # ── 7. Fire ──────────────────────────────────────────────────────────
        state.alert_states["speeding_alerted"] = True
        logger.info(
            f"SpeedingAlert [{device.name}]: {current_speed:.1f} km/h on "
            f"{limit:.0f} km/h road (threshold {threshold:.0f} km/h), "
            f"exceeded for {elapsed:.0f}s"
        )
        return {
            "type":     AlertType.SPEEDING,
            "severity": Severity.WARNING,
            "message":  (
                f"Speeding: {current_speed:.1f} km/h — "
                f"road limit {limit:.0f} km/h "
                f"(+{overspeed_pct:.0f}% tolerance = {threshold:.0f} km/h)."
            ),
            "alert_metadata": {"config_key": "speed_tolerance"},
        }
