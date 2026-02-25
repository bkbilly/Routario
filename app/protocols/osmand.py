"""
OsmAnd Protocol Decoder
Supports the OsmAnd mobile app GPS tracking protocol
"""
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler
from io import BytesIO
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

HTTP_200 = b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'


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
        pass  # silence BaseHTTPRequestHandler stdout logging


@ProtocolRegistry.register("osmand")
class OsmAndDecoder(BaseProtocolDecoder):
    """
    OsmAnd Protocol Decoder

    OsmAnd sends GPS data as HTTP GET requests, either with parameters in the
    query string or in the request body (as used by Home Assistant).

    Port: 5055 (TCP)
    Format: HTTP GET — query string or URL-encoded body

    Example (query string):
        GET /?id=123&lat=37.77&lon=-122.41&speed=0&bearing=0&altitude=10&timestamp=1234567890 HTTP/1.1

    Example (body, Home Assistant style):
        GET / HTTP/1.1
        Content-Type: application/x-www-form-urlencoded
        Content-Length: 170

        id=864454079682667&lat=37.99&lon=23.79&...
    """

    PORT = 5055
    PROTOCOL_TYPES = ['tcp']

    async def decode(
        self,
        data: bytes,
        client_info: Dict[str, Any],
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:

        if not data:
            return None, 0

        # Wait for the full HTTP request (headers + body)
        # Headers end at \r\n\r\n; body length is given by Content-Length
        header_end = data.find(b'\r\n\r\n')
        if header_end == -1:
            if len(data) > 8192:
                logger.warning("OsmAnd: Buffer too large, resetting")
                return None, len(data)
            return None, 0  # Incomplete — wait for more data

        header_bytes = data[:header_end + 4]

        # Parse the HTTP request using stdlib
        req = _HTTPRequest(header_bytes)
        if req.error_code:
            logger.warning(f"OsmAnd: HTTP parse error {req.error_code}")
            return None, header_end + 4

        # Determine body length from Content-Length header
        content_length = int(req.headers.get('Content-Length', 0))
        total_length = header_end + 4 + content_length

        if len(data) < total_length:
            return None, 0  # Body not yet fully received

        consumed = total_length
        body = data[header_end + 4:total_length].decode('utf-8', errors='ignore').strip()

        # Parse parameters — query string takes priority, fall back to body
        params = self._parse_query(req.path)
        if not params and body:
            params = self._parse_query_string(body)

        if not params:
            logger.warning("OsmAnd: No parameters in request")
            return None, consumed

        # Resolve device ID
        device_id = known_imei or params.get('id') or params.get('deviceid')
        if not device_id:
            logger.warning("OsmAnd: No device ID in request")
            return None, consumed

        position = await self._parse_osmand_params(params, device_id)
        if position:
            return {"imei": device_id, "position": position, "response": HTTP_200}, consumed

        return None, consumed

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_query(self, path: str) -> Dict[str, str]:
        """Parse parameters from a URL path query string."""
        if '?' not in path:
            return {}
        return self._parse_query_string(path.split('?', 1)[1])

    def _parse_query_string(self, qs: str) -> Dict[str, str]:
        """Parse a URL-encoded query string into a flat dict."""
        try:
            return {k: v[0] for k, v in parse_qs(qs).items() if v}
        except Exception as e:
            logger.error(f"OsmAnd: Query string parse error: {e}")
            return {}

    async def _parse_osmand_params(
        self,
        params: Dict[str, str],
        device_id: str
    ) -> Optional[NormalizedPosition]:

        try:
            lat = params.get('lat') or params.get('latitude')
            lon = params.get('lon') or params.get('longitude')

            if lat is None or lon is None:
                logger.warning("OsmAnd: Missing GPS coordinates")
                return None

            try:
                latitude = float(lat)
                longitude = float(lon)
            except (ValueError, TypeError):
                logger.warning("OsmAnd: Invalid GPS coordinates")
                return None

            # Timestamp — OsmAnd sends milliseconds, standard sends seconds
            device_time = datetime.now(timezone.utc)
            ts = params.get('timestamp')
            if ts:
                try:
                    t = int(float(ts))
                    device_time = datetime.fromtimestamp(
                        t / 1000.0 if t > 10_000_000_000 else t,
                        tz=timezone.utc
                    )
                except (ValueError, TypeError):
                    pass

            speed_ms = float(params.get('speed', 0))
            course = float(params.get('bearing', params.get('course', 0)))
            altitude = float(params.get('altitude', params.get('alt', 0)))
            satellites = int(float(params.get('sat', 0)))

            # Sensor / extra data
            known_keys = {
                'id', 'deviceid', 'lat', 'latitude', 'lon', 'longitude',
                'speed', 'bearing', 'course', 'altitude', 'alt',
                'timestamp', 'sat', 'hdop', 'accuracy', 'batt', 'battery',
            }
            sensors = {}
            for key in ('hdop', 'accuracy'):
                if key in params:
                    try:
                        sensors[key] = float(params[key])
                    except (ValueError, TypeError):
                        pass

            batt = params.get('batt') or params.get('battery')
            if batt:
                try:
                    sensors['battery'] = float(batt)
                except (ValueError, TypeError):
                    pass

            for k, v in params.items():
                if k not in known_keys:
                    sensors[k] = v

            position = NormalizedPosition(
                imei=str(device_id),
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed_ms * 3.6,   # m/s → km/h
                course=course,
                satellites=satellites,
                valid=True,
                sensors=sensors,
            )

            logger.debug(f"OsmAnd decoded: {device_id} @ {latitude},{longitude}")
            return position

        except Exception as e:
            logger.error(f"OsmAnd: Params parse error: {e}", exc_info=True)
            return None

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        logger.warning("OsmAnd protocol does not support commands")
        return b''

    def get_available_commands(self) -> list:
        return []

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        return {'description': 'OsmAnd protocol does not support commands', 'supported': False}
