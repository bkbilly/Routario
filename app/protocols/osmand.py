"""
OsmAnd Protocol Decoder
Supports OsmAnd mobile app and Background Geolocation (transistorsoft) GPS tracking.

Port: 5055 (TCP)
Format: HTTP GET or POST with:
  - Query string parameters (classic OsmAnd)
  - URL-encoded body (Home Assistant style)
  - JSON body (Background Geolocation / transistorsoft style)
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple, Union
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler
from io import BytesIO
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

HTTP_200 = b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\nok'


class _HTTPRequest(BaseHTTPRequestHandler):
    """Minimal HTTP request parser — no socket, no logging."""
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
    """
    OsmAnd Protocol Decoder.

    Handles three request formats:
      1. Classic OsmAnd — GET with query string parameters
      2. URL-encoded body — POST with application/x-www-form-urlencoded
      3. JSON body — POST with application/json (Background Geolocation app)

    Background Geolocation JSON structure:
      {
        "device_id": "93147180",
        "location": {
          "timestamp": "2026-05-03T22:31:22.005Z",
          "coords": {
            "latitude": 37.99,
            "longitude": 23.79,
            "accuracy": 13.97,
            "speed": -1,
            "heading": -1,
            "altitude": 253.1
          },
          "is_moving": false,
          "odometer": 0,
          "battery": { "level": 0.69, "is_charging": false },
          "activity": { "type": "still" },
          "extras": {}
        }
      }
    """

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

        # Wait for complete HTTP request
        header_end = data.find(b'\r\n\r\n')
        if header_end == -1:
            if len(data) > 8192:
                logger.warning("OsmAnd: Buffer too large, resetting")
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

        consumed    = total_length
        body_bytes  = data[header_end + 4:total_length]
        body_str    = body_bytes.decode('utf-8', errors='ignore').strip()
        content_type = req.headers.get('Content-Type', '').lower()

        # ── 1. Try JSON body first (Background Geolocation app) ──────────────
        if 'application/json' in content_type and body_str:
            try:
                payload = json.loads(body_str)
                params  = self._flatten_json_payload(payload)
                if params:
                    device_id = params.get('id') or known_imei
                    if not device_id:
                        logger.warning("OsmAnd: No device ID in JSON payload")
                        return {'response': HTTP_200}, consumed
                    pos = await self._parse_osmand_params(params, str(device_id))
                    if pos:
                        return {'imei': str(device_id), 'position': pos, 'response': HTTP_200}, consumed
                    return {'response': HTTP_200}, consumed
            except json.JSONDecodeError:
                pass  # fall through to query-string parsing

        # ── 2. Query string from URL ──────────────────────────────────────────
        params = self._parse_query(req.path)

        # ── 3. URL-encoded body ───────────────────────────────────────────────
        if not params and body_str and 'application/x-www-form-urlencoded' in content_type:
            params = self._parse_query_string(body_str)

        # ── 4. Try body as query string regardless of content-type ───────────
        if not params and body_str and not body_str.startswith('{'):
            params = self._parse_query_string(body_str)

        if not params:
            logger.warning("OsmAnd: No parameters found in request")
            return {'response': HTTP_200}, consumed

        device_id = params.get('id') or params.get('deviceid') or known_imei
        if not device_id:
            logger.warning("OsmAnd: No device ID")
            return {'response': HTTP_200}, consumed

        pos = await self._parse_osmand_params(params, str(device_id))
        if pos:
            return {'imei': str(device_id), 'position': pos, 'response': HTTP_200}, consumed

        return {'response': HTTP_200}, consumed

    # ── JSON flattener ────────────────────────────────────────────────────────

    def _flatten_json_payload(self, payload: dict) -> Dict[str, Any]:
        """
        Convert the Background Geolocation nested JSON structure into the
        flat key/value dict that _parse_osmand_params() expects.

        Handles both the transistorsoft Background Geolocation format and
        simple flat JSON ({"lat": ..., "lon": ..., "id": ...}).
        """
        params: Dict[str, Any] = {}

        # ── transistorsoft / Background Geolocation format ────────────────────
        if 'location' in payload:
            loc    = payload['location']
            coords = loc.get('coords', {})

            # Device ID
            device_id = (
                payload.get('device_id')
                or payload.get('id')
                or loc.get('device_id')
            )
            if device_id:
                params['id'] = str(device_id)

            # Core position fields
            if coords.get('latitude') is not None:
                params['lat'] = coords['latitude']
            if coords.get('longitude') is not None:
                params['lon'] = coords['longitude']
            if coords.get('altitude') is not None:
                params['altitude'] = coords['altitude']

            # Speed — Background Geolocation sends -1 when unavailable
            speed = coords.get('speed', -1)
            if speed is not None and float(speed) >= 0:
                # Already in m/s
                params['speed'] = float(speed)
            else:
                params['speed'] = 0

            # Heading — -1 when unavailable
            heading = coords.get('heading', -1)
            if heading is not None and float(heading) >= 0:
                params['bearing'] = float(heading)

            # Accuracy
            if coords.get('accuracy') is not None:
                params['accuracy'] = coords['accuracy']

            # Timestamp
            ts = loc.get('timestamp')
            if ts:
                params['timestamp'] = ts

            # Battery
            battery = loc.get('battery', {})
            if battery.get('level') is not None:
                # level is 0.0–1.0, convert to percentage
                params['batt'] = round(float(battery['level']) * 100, 1)
            if battery.get('is_charging') is not None:
                params['charging'] = battery['is_charging']

            # Motion / activity
            if loc.get('is_moving') is not None:
                params['is_moving'] = loc['is_moving']

            activity = loc.get('activity', {})
            if activity.get('type'):
                params['activity'] = activity['type']

            # Odometer (metres)
            odometer = loc.get('odometer')
            if odometer is not None and float(odometer) > 0:
                params['odometer'] = float(odometer)

            # Pass through anything in extras{}
            extras = loc.get('extras', {})
            if isinstance(extras, dict):
                params.update(extras)

            return params

        # ── Simple flat JSON: {"lat": ..., "lon": ..., "id": ...} ─────────────
        flat_map = {
            'lat': ['lat', 'latitude'],
            'lon': ['lon', 'longitude'],
            'id':  ['id', 'device_id', 'deviceid'],
        }
        for dst, src_keys in flat_map.items():
            for key in src_keys:
                if key in payload:
                    params[dst] = payload[key]
                    break

        # Copy everything else straight through
        known = {k for keys in flat_map.values() for k in keys}
        for k, v in payload.items():
            if k not in known:
                params[k] = v

        return params

    # ── Query string helpers ──────────────────────────────────────────────────

    def _parse_query(self, path: str) -> Dict[str, str]:
        if '?' not in path:
            return {}
        return self._parse_query_string(path.split('?', 1)[1])

    def _parse_query_string(self, qs: str) -> Dict[str, str]:
        try:
            return {k: v[0] for k, v in parse_qs(qs).items() if v}
        except Exception as exc:
            logger.error("OsmAnd: Query string parse error: %s", exc)
            return {}

    # ── Position builder ──────────────────────────────────────────────────────

    async def _parse_osmand_params(
        self,
        params: Dict[str, Any],
        device_id: str,
    ) -> Optional[NormalizedPosition]:
        try:
            lat = params.get('lat') or params.get('latitude')
            lon = params.get('lon') or params.get('longitude')
            if lat is None or lon is None:
                logger.warning("OsmAnd: Missing coordinates for %s", device_id)
                return None

            latitude  = float(lat)
            longitude = float(lon)

            # Timestamp — ISO string or Unix epoch (seconds or milliseconds)
            device_time = datetime.now(timezone.utc)
            ts = params.get('timestamp')
            if ts:
                try:
                    # ISO 8601 string (Background Geolocation sends this)
                    device_time = datetime.fromisoformat(
                        str(ts).replace('Z', '+00:00')
                    )
                    if device_time.tzinfo is None:
                        device_time = device_time.replace(tzinfo=timezone.utc)
                except ValueError:
                    # Try Unix epoch
                    try:
                        t = int(float(str(ts)))
                        device_time = datetime.fromtimestamp(
                            t / 1000.0 if t > 10_000_000_000 else t,
                            tz=timezone.utc,
                        )
                    except (ValueError, TypeError):
                        pass

            # Speed — OsmAnd sends m/s, Background Geolocation also m/s
            raw_speed = params.get('speed', 0)
            try:
                speed_ms  = float(raw_speed) if float(raw_speed) >= 0 else 0.0
            except (ValueError, TypeError):
                speed_ms = 0.0
            speed_kph = round(speed_ms * 3.6, 2)

            course   = float(params.get('bearing',  params.get('heading',  0)) or 0)
            altitude = float(params.get('altitude', 0) or 0)
            sats     = int(float(params.get('sat', 0) or 0))

            # ── Sensors ───────────────────────────────────────────────────────
            sensors: Dict[str, Any] = {}

            for src, dst in [
                ('accuracy',  'accuracy'),
                ('hdop',      'hdop'),
                ('batt',      'battery_percent'),
                ('battery',   'battery_percent'),
                ('odometer',  'odometer'),
                ('activity',  'activity'),
                ('charging',  'is_charging'),
                ('is_moving', 'is_moving'),
            ]:
                v = params.get(src)
                if v is not None:
                    sensors[dst] = v

            # Ignition — accepts true/false/1/0
            ignition: Optional[bool] = None
            if 'ignition' in params:
                raw = str(params['ignition']).strip().lower()
                ignition = raw in ('true', '1', 'yes')

            # Pass through any remaining unknown keys
            known_keys = {
                'id', 'deviceid', 'lat', 'latitude', 'lon', 'longitude',
                'speed', 'bearing', 'heading', 'course', 'altitude',
                'timestamp', 'sat', 'hdop', 'accuracy', 'batt', 'battery',
                'ignition', 'odometer', 'activity', 'charging', 'is_moving',
            }
            for k, v in params.items():
                if k not in known_keys and k not in sensors:
                    sensors[k] = v

            logger.info(
                "OsmAnd decoded: %s @ %.5f, %.5f  speed=%.1f km/h  sensors=%s",
                device_id, latitude, longitude, speed_kph,
                {k: v for k, v in sensors.items() if k != 'raw'},
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
