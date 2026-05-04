"""
OsmAnd Protocol Decoder
Supports OsmAnd mobile app and Background Geolocation (transistorsoft) GPS tracking.

Port: 5055 (TCP)
Format: HTTP GET or POST with any combination of:
  - Query string parameters in the URL
  - URL-encoded body (application/x-www-form-urlencoded)
  - JSON body (application/json) — may also contain an embedded
    URL-encoded string in a "_" key (Background Geolocation style)
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple, Union
from urllib.parse import parse_qs, unquote
from http.server import BaseHTTPRequestHandler
from io import BytesIO
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

HTTP_200 = (
    b'HTTP/1.1 200 OK\r\n'
    b'Content-Length: 2\r\n'
    b'Content-Type: application/json\r\n'
    b'Connection: keep-alive\r\n'
    b'\r\n'
    b'ok'
)

# Keys that are consumed into top-level NormalizedPosition fields.
# Everything else goes straight into sensors{}.
_POSITION_KEYS = frozenset({
    'id', 'deviceid', 'device_id',
    'lat', 'latitude',
    'lon', 'lng', 'longitude',
    'timestamp', 'time',
    'speed',
    'bearing', 'heading', 'course',
    'altitude', 'alt',
    'sat', 'satellites',
    'hdop',
    'accuracy',
    'ignition',
})


class _HTTPRequest(BaseHTTPRequestHandler):
    def __init__(self, raw: bytes):
        self.rfile = BytesIO(raw)
        self.raw_requestline = self.rfile.readline()
        self.error_code = None
        self.parse_request()

    def send_error(self, code, message=None, explain=None):
        self.error_code = code

    def log_message(self, *args):
        pass


@ProtocolRegistry.register("osmand")
class OsmAndDecoder(BaseProtocolDecoder):
    PORT = 5055
    PROTOCOL_TYPES = ['tcp']
    NATIVE_EVENTS = []

    async def decode(
        self,
        data: bytes,
        client_info: Dict[str, Any],
        known_imei: Optional[str] = None,
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:

        if not data:
            return None, 0

        header_end = data.find(b'\r\n\r\n')
        if header_end == -1:
            if len(data) > 65536:
                logger.warning("OsmAnd: Buffer overflow, resetting")
                return None, len(data)
            return None, 0

        header_bytes = data[:header_end + 4]
        req = _HTTPRequest(header_bytes)
        if req.error_code:
            logger.warning("OsmAnd: HTTP parse error %s", req.error_code)
            return None, header_end + 4

        content_length = int(req.headers.get('Content-Length', 0))
        total_length   = header_end + 4 + content_length
        if len(data) < total_length:
            return None, 0

        consumed     = total_length
        body_bytes   = data[header_end + 4:total_length]
        body_str     = body_bytes.decode('utf-8', errors='ignore').strip()
        content_type = req.headers.get('Content-Type', '').lower()

        # ── Collect params from every source and merge them ───────────────────
        # Later sources override earlier ones for the same key.
        # Order: URL query string → body (url-encoded or JSON)
        params: Dict[str, Any] = {}

        # 1. URL query string
        params.update(self._parse_qs(req.path.split('?', 1)[1] if '?' in req.path else ''))

        # 2. Body
        if body_str:
            if 'application/json' in content_type or body_str.startswith('{'):
                try:
                    json_body = json.loads(body_str)
                    params.update(self._flatten_json(json_body))
                except json.JSONDecodeError:
                    # Malformed JSON — try as url-encoded
                    params.update(self._parse_qs(body_str))
            else:
                # URL-encoded body
                params.update(self._parse_qs(body_str))

        if not params:
            logger.warning("OsmAnd: No parameters found in request")
            return {'response': HTTP_200}, consumed

        device_id = (
            params.get('id')
            or params.get('deviceid')
            or params.get('device_id')
            or known_imei
        )
        if not device_id:
            logger.warning("OsmAnd: No device ID")
            return {'response': HTTP_200}, consumed

        device_id = str(device_id)
        pos = self._build_position(params, device_id)
        if pos:
            return {'imei': device_id, 'position': pos, 'response': HTTP_200}, consumed

        return {'response': HTTP_200}, consumed

    # ── Query-string parser ───────────────────────────────────────────────────

    def _parse_qs(self, qs: str) -> Dict[str, Any]:
        """Parse a URL-encoded query string into a flat {key: value} dict."""
        if not qs:
            return {}
        try:
            return {k: v[0] for k, v in parse_qs(qs, keep_blank_values=False).items() if v}
        except Exception as exc:
            logger.debug("OsmAnd: QS parse error: %s", exc)
            return {}

    # ── JSON flattener ────────────────────────────────────────────────────────

    def _flatten_json(self, payload: Any, prefix: str = '') -> Dict[str, Any]:
        """
        Recursively flatten a JSON object into a dot-separated key/value dict,
        then apply well-known aliases so downstream code stays simple.

        Special handling:
          - "_" key — Background Geolocation embeds a URL-encoded query string
            here; it is parsed and merged at the top level.
          - Nested dicts are flattened with dot notation:
              {"battery": {"level": 0.69}} → {"battery.level": 0.69}
          - Lists are stored as-is under their key.
        """
        result: Dict[str, Any] = {}

        if not isinstance(payload, dict):
            return result

        for key, value in payload.items():
            full_key = f"{prefix}.{key}" if prefix else key

            # Background Geolocation embeds a URL-encoded string in "_"
            if key == '_' and isinstance(value, str):
                # Strip leading "&" or "?" and parse
                qs = value.lstrip('&?')
                result.update(self._parse_qs(qs))
                continue

            if isinstance(value, dict):
                result.update(self._flatten_json(value, prefix=full_key))
            elif isinstance(value, list):
                result[full_key] = value
            else:
                result[full_key] = value

        # Apply well-known aliases so position parsing works regardless
        # of whether data came from classic OsmAnd or Background Geolocation.
        result = self._apply_aliases(result)
        return result

    def _apply_aliases(self, flat: Dict[str, Any]) -> Dict[str, Any]:
        """
        Map Background Geolocation nested keys to the flat names that
        _build_position() expects.  Original keys are kept so they still
        appear in sensors{}.
        """
        aliases = {
            # coords
            'location.coords.latitude':  'lat',
            'location.coords.longitude': 'lon',
            'location.coords.altitude':  'altitude',
            'location.coords.speed':     'speed',
            'location.coords.heading':   'bearing',
            'location.coords.accuracy':  'accuracy',
            # timestamp
            'location.timestamp':        'timestamp',
            # battery
            'location.battery.level':    'batt',
            'location.battery.is_charging': 'is_charging',
            # motion
            'location.is_moving':        'is_moving',
            'location.odometer':         'odometer',
            'location.activity.type':    'activity',
            # device id
            'device_id':                 'id',
        }
        for src, dst in aliases.items():
            if src in flat and dst not in flat:
                flat[dst] = flat[src]
        return flat

    # ── Position builder ──────────────────────────────────────────────────────

    def _build_position(
        self,
        params: Dict[str, Any],
        device_id: str,
    ) -> Optional[NormalizedPosition]:
        try:
            lat = params.get('lat') or params.get('latitude')
            lon = params.get('lon') or params.get('lng') or params.get('longitude')
            if lat is None or lon is None:
                logger.warning("OsmAnd: Missing coordinates for %s", device_id)
                return None

            latitude  = float(lat)
            longitude = float(lon)

            # ── Timestamp ─────────────────────────────────────────────────────
            device_time = datetime.now(timezone.utc)
            ts = params.get('timestamp') or params.get('time')
            if ts:
                ts = str(ts)
                try:
                    # ISO 8601
                    device_time = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                    if device_time.tzinfo is None:
                        device_time = device_time.replace(tzinfo=timezone.utc)
                except ValueError:
                    try:
                        t = int(float(ts))
                        device_time = datetime.fromtimestamp(
                            t / 1000.0 if t > 10_000_000_000 else t,
                            tz=timezone.utc,
                        )
                    except (ValueError, TypeError):
                        pass

            # ── Motion fields ─────────────────────────────────────────────────
            raw_speed = params.get('speed', 0)
            try:
                speed_ms = float(raw_speed) if float(str(raw_speed)) >= 0 else 0.0
            except (ValueError, TypeError):
                speed_ms = 0.0
            speed_kph = round(speed_ms * 3.6, 2)

            raw_course = _to_float(params.get('bearing') or params.get('heading') or params.get('course'), -1.0)
            course     = raw_course if raw_course >= 0 else None
            altitude = _to_float(params.get('altitude') or params.get('alt'), 0.0)
            sats     = _to_int(params.get('sat') or params.get('satellites'), 0)

            # ── Ignition ──────────────────────────────────────────────────────
            ignition: Optional[bool] = None
            if 'ignition' in params:
                raw = str(params['ignition']).strip().lower()
                ignition = raw in ('true', '1', 'yes')

            # ── Battery level: fraction → percent ─────────────────────────────
            if 'batt' in params:
                try:
                    batt = float(params['batt'])
                    # Background Geolocation sends 0.0–1.0
                    if batt <= 1.0:
                        params['batt'] = round(batt * 100, 1)
                except (ValueError, TypeError):
                    pass

            # ── Sensors: everything that isn't a core position field ──────────
            # Skip: position keys, internal meta keys, and dotted keys that have
            # already been aliased to a shorter name (avoids duplicates like
            # "location.battery.level" alongside "batt").
            aliased_sources = {
                'location.coords.latitude', 'location.coords.longitude',
                'location.coords.altitude', 'location.coords.speed',
                'location.coords.heading', 'location.coords.accuracy',
                'location.timestamp', 'location.battery.level',
                'location.battery.is_charging', 'location.is_moving',
                'location.odometer', 'location.activity.type',
                'device_id',
            }
            sensors: Dict[str, Any] = {}
            for key, value in params.items():
                if key in _POSITION_KEYS:
                    continue
                if key in ('_',):
                    continue
                if key in aliased_sources:
                    continue
                sensors[key] = value

            logger.info(
                "OsmAnd decoded: %s @ %.5f, %.5f  speed=%.1f km/h  sensors=%s",
                device_id, latitude, longitude, speed_kph, sensors,
            )

            return NormalizedPosition(
                imei=device_id,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed_kph,
                course=course,
                satellites=sats,
                valid=True,
                ignition=ignition,
                sensors=sensors,
            )

        except Exception as exc:
            logger.error("OsmAnd: Parse error for %s: %s", device_id, exc, exc_info=True)
            return None

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        logger.warning("OsmAnd protocol does not support commands")
        return b''

    def get_available_commands(self) -> list:
        return []

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        return {'description': 'OsmAnd does not support commands', 'supported': False}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value) if value is not None else default
    except (ValueError, TypeError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value)) if value is not None else default
    except (ValueError, TypeError):
        return default
