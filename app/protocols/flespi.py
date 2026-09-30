"""
Flespi Protocol Decoder
Supports Flespi's standardized JSON message format for GPS tracking devices.

Port: 5149 (TCP)
Format: Newline-delimited JSON. Each message is a UTF-8 JSON object (or array
        of objects for batch sends) terminated by '\n'.

Flespi standard field names used here:
  position.latitude       — decimal degrees
  position.longitude      — decimal degrees
  position.altitude       — metres
  position.speed          — km/h
  position.direction      — degrees (0-360)
  position.satellites     — integer
  position.valid          — bool
  engine.ignition.status  — bool
  battery.voltage         — volts
  external.powersource.voltage
  gnss.hdop
  gsm.signal.level
  engine.rpm
  fuel.level
  vehicle.mileage         — km (odometer)
  device.ident / ident    — IMEI or device identifier

Outbound command format (server → device):
  {"command": "<type>", ...params...}\n
"""
import gzip
import json
import logging
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import parse_qs

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

HTTP_200_KEEP_ALIVE = (
    b'HTTP/1.1 200 OK\r\n'
    b'Content-Length: 2\r\n'
    b'Content-Type: application/json\r\n'
    b'Connection: keep-alive\r\n'
    b'\r\n'
    b'ok'
)

HTTP_200_CLOSE = (
    b'HTTP/1.1 200 OK\r\n'
    b'Content-Length: 2\r\n'
    b'Content-Type: application/json\r\n'
    b'Connection: close\r\n'
    b'\r\n'
    b'ok'
)

_HTTP_METHODS = (b'POST ', b'GET ', b'PUT ', b'HEAD ', b'OPTIONS ', b'PATCH ')


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


# Fields that are consumed into top-level NormalizedPosition attributes and
# should not be duplicated in sensors{}.
_POSITION_KEYS = frozenset({
    'ident', 'device.ident',
    'timestamp', 'server.timestamp',
    'position.latitude', 'lat', 'latitude',
    'position.longitude', 'lon', 'longitude',
    'position.altitude', 'alt', 'altitude',
    'position.speed', 'speed',
    'position.direction', 'course', 'heading',
    'position.satellites', 'sat', 'satellites',
    'position.valid', 'valid',
    'engine.ignition.status', 'ignition',
    # Internal flespi metadata
    'device.id', 'device.name', 'device.type.id',
    'channel.id', 'protocol.id', 'peer',
})


@ProtocolRegistry.register("flespi")
class FlespiDecoder(BaseProtocolDecoder):
    """
    Flespi Protocol Decoder.

    Flespi is a cloud IoT platform that normalises many device protocols into
    a common JSON schema.  This decoder handles devices that send data directly
    using Flespi's wire format.
    """

    PORT = 5149
    PROTOCOL_TYPES = ['tcp']
    NATIVE_EVENTS = [
        {"key": "alarm.event.trigger",           "label": "🔔 General Alarm",       "severity": "warning",  "trigger_value": ""},
        {"key": "towing.event.trigger",          "label": "🚗 Towing",              "severity": "critical", "trigger_value": ""},
        {"key": "towing.alarm.status",           "label": "🚗 Towing (Status)",     "severity": "critical", "trigger_value": ""},
        {"key": "geofence.event.enter",          "label": "📍 Geofence Enter",      "severity": "warning",  "trigger_value": ""},
        {"key": "geofence.event.exit",           "label": "🚪 Geofence Exit",       "severity": "warning",  "trigger_value": ""},
        {"key": "shock.event.trigger",           "label": "📳 Shock / Vibration",   "severity": "warning",  "trigger_value": ""},
        {"key": "overspeeding.event.trigger",    "label": "⚡ Overspeed",           "severity": "warning",  "trigger_value": ""},
        {"key": "harsh.acceleration.event.trigger", "label": "🌿 Harsh Acceleration","severity": "warning", "trigger_value": ""},
        {"key": "harsh.braking.event.trigger",   "label": "🌿 Harsh Braking",       "severity": "warning",  "trigger_value": ""},
        {"key": "harsh.cornering.event.trigger", "label": "🌿 Harsh Cornering",     "severity": "warning",  "trigger_value": ""},
        {"key": "gnss.antenna.cut.status",       "label": "📡 GPS Antenna Cut",     "severity": "critical", "trigger_value": ""},
        {"key": "gsm.jamming.event.trigger",     "label": "📵 GSM Jamming",         "severity": "warning",  "trigger_value": ""},
        {"key": "hood.open.status",              "label": "🚗 Hood/Bonnet Open",    "severity": "warning",  "trigger_value": ""},
        {"key": "external.powersource.status",   "label": "🔌 Power Cut",           "severity": "critical", "trigger_value": ""},
    ]

    # ================================================================== #
    #  Command Registry                                                   #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'custom': {
            'description': 'Send a custom JSON payload to the device',
            'example': '{"action": "get_status"}',
            'requires_params': True,
        },
        'reboot': {
            'description': 'Reboot the device',
            'example': 'reboot',
            'requires_params': False,
            '_body': {'action': 'reboot'},
        },
        'request_position': {
            'description': 'Request an immediate position update',
            'example': 'request_position',
            'requires_params': False,
            '_body': {'action': 'get_position'},
        },
        'set_interval': {
            'description': 'Set the telemetry reporting interval (seconds)',
            'example': 'set_interval 30',
            'requires_params': True,
        },
        'config': {
            'description': 'Send a JSON configuration update to the device',
            'example': '{"interval": 30, "mode": "tracking"}',
            'requires_params': True,
        },
    }

    # ================================================================== #
    #  Decode                                                             #
    # ================================================================== #

    async def decode(
        self,
        data: bytes,
        client_info: Dict[str, Any],
        known_imei: Optional[str] = None,
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            if not data:
                return None, 0

            data_stripped = data.lstrip()
            strip_offset = len(data) - len(data_stripped)

            # ── Check if incoming data is an HTTP request ──────────────
            is_http = any(data_stripped.startswith(m) for m in _HTTP_METHODS)
            if not is_http and len(data_stripped) < 7:
                # Buffer might be a partial HTTP method (e.g. b"POS" or b"POST")
                if any(m.startswith(data_stripped) for m in _HTTP_METHODS):
                    return None, 0

            if is_http:
                header_end = data_stripped.find(b'\r\n\r\n')
                sep_len = 4
                if header_end == -1:
                    header_end = data_stripped.find(b'\n\n')
                    sep_len = 2

                if header_end == -1:
                    if len(data) > 65536:
                        logger.warning("Flespi: HTTP header too large, resetting")
                        return None, len(data)
                    return None, 0  # Incomplete HTTP headers, wait for more data

                header_bytes = data_stripped[:header_end + sep_len]
                try:
                    req = _HTTPRequest(header_bytes)
                except Exception as exc:
                    logger.warning("Flespi: HTTP parse exception: %s", exc)
                    return None, strip_offset + header_end + sep_len

                if req.error_code:
                    logger.warning("Flespi: HTTP parse error %s", req.error_code)
                    return None, strip_offset + header_end + sep_len

                is_close = (req.headers.get('Connection') or '').lower() == 'close'
                resp_200 = HTTP_200_CLOSE if is_close else HTTP_200_KEEP_ALIVE

                content_length_str = req.headers.get('Content-Length')
                try:
                    content_length = int(content_length_str) if content_length_str else 0
                except (ValueError, TypeError):
                    content_length = 0

                total_length = strip_offset + header_end + sep_len + content_length
                if len(data) < total_length:
                    return None, 0  # Incomplete HTTP body, wait for remaining chunks

                consumed = total_length
                body_bytes = data_stripped[header_end + sep_len : header_end + sep_len + content_length]

                # HTTP GET / HEAD handler
                if req.command in ('GET', 'HEAD'):
                    if req.command == 'GET' and '?' in req.path:
                        query_str = req.path.split('?', 1)[1]
                        params = {k: v[0] for k, v in parse_qs(query_str, keep_blank_values=False).items() if v}
                        if params:
                            pos = self._parse_message(params, known_imei)
                            if pos:
                                return {'response': resp_200, 'position': pos}, consumed
                    return {'response': resp_200}, consumed

                # Decompress if Content-Encoding is present
                content_encoding = (req.headers.get('Content-Encoding') or '').lower().strip()
                if 'gzip' in content_encoding:
                    try:
                        body_bytes = gzip.decompress(body_bytes)
                    except Exception as exc:
                        logger.error("Flespi: Gzip decompression error: %s", exc)
                        return {'response': resp_200}, consumed
                elif 'deflate' in content_encoding:
                    try:
                        body_bytes = zlib.decompress(body_bytes)
                    except zlib.error:
                        try:
                            body_bytes = zlib.decompress(body_bytes, -zlib.MAX_WBITS)
                        except Exception as exc:
                            logger.error("Flespi: Deflate decompression error: %s", exc)
                            return {'response': resp_200}, consumed

                body_text = body_bytes.decode('utf-8', errors='replace').strip()
                if not body_text:
                    return {'response': resp_200}, consumed

                try:
                    message = json.loads(body_text)
                except json.JSONDecodeError:
                    # Fallback: support newline-delimited JSON inside the HTTP body
                    lines = [l.strip() for l in body_text.splitlines() if l.strip()]
                    message = []
                    for line in lines:
                        try:
                            message.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
                    if not message:
                        logger.error("Flespi: JSON decode error in HTTP body — raw: %s", body_text[:120])
                        return {'response': resp_200}, consumed

                positions: List[NormalizedPosition] = []
                if isinstance(message, dict):
                    pos = self._parse_message(message, known_imei)
                    if pos:
                        positions.append(pos)
                elif isinstance(message, list):
                    for msg in message:
                        if isinstance(msg, dict):
                            pos = self._parse_message(msg, known_imei)
                            if pos:
                                positions.append(pos)

                if positions:
                    return {
                        'response': resp_200,
                        'position': positions[0],
                        'extra_positions': positions[1:],
                    }, consumed

                return {'response': resp_200}, consumed

            # ── Newline-delimited JSON (NDJSON) over TCP ─────────────
            newline_idx = data.find(b'\n')
            if newline_idx == -1:
                if len(data) > 65536:
                    logger.warning("Flespi: Buffer too large without newline, resetting")
                    return None, len(data)
                return None, 0

            line_bytes = data[:newline_idx].strip()
            consumed = newline_idx + 1  # Exactly consumed through '\n'

            if not line_bytes:
                return None, consumed

            try:
                json_str = line_bytes.decode('utf-8')
                message = json.loads(json_str)
            except UnicodeDecodeError:
                logger.error("Flespi: Failed to decode UTF-8")
                return None, consumed
            except json.JSONDecodeError as e:
                logger.error(f"Flespi: JSON decode error: {e} — raw: {line_bytes[:120].decode('utf-8', errors='replace')}")
                return None, consumed

            # ── Single message ─────────────────────────────────────
            if isinstance(message, dict):
                ident = message.get('ident') or message.get('device.ident')
                pos = self._parse_message(message, known_imei)
                if ident and not known_imei:
                    logger.info(f"Flespi login: {ident}")
                    res: Dict[str, Any] = {
                        'event': 'login',
                        'imei': str(ident),
                        'response': b'{"status":"ok"}\n',
                    }
                    if pos:
                        res['position'] = pos
                    return res, consumed

                if pos:
                    return pos, consumed
                return None, consumed

            # ── Batch of messages ──────────────────────────────────
            if isinstance(message, list):
                positions = []
                for msg in message:
                    if isinstance(msg, dict):
                        pos = self._parse_message(msg, known_imei)
                        if pos:
                            positions.append(pos)

                if not positions:
                    return None, consumed

                return {
                    'position': positions[0],
                    'extra_positions': positions[1:],
                }, consumed

            logger.warning(f"Flespi: Unexpected top-level JSON type: {type(message)}")
            return None, consumed

        except Exception as e:
            logger.error(f"Flespi decode error: {e}", exc_info=True)
            return None, 1

    # ================================================================== #
    #  Message parser                                                     #
    # ================================================================== #

    def _parse_message(
        self,
        message: Dict[str, Any],
        known_imei: Optional[str],
    ) -> Optional[NormalizedPosition]:
        try:
            # ── IMEI ──────────────────────────────────────────────
            imei = known_imei
            if not imei:
                raw_ident = message.get('ident') or message.get('device.ident')
                if raw_ident:
                    imei = str(raw_ident)
            if not imei:
                logger.warning("Flespi: No IMEI in message")
                return None

            # ── Timestamp ─────────────────────────────────────────
            ts = message.get('timestamp') or message.get('server.timestamp')
            if ts:
                try:
                    t = float(ts)
                    device_time = datetime.fromtimestamp(
                        t / 1000.0 if t > 10_000_000_000 else t,
                        tz=timezone.utc,
                    )
                except (ValueError, TypeError):
                    device_time = datetime.now(timezone.utc)
            else:
                device_time = datetime.now(timezone.utc)

            # ── Coordinates ───────────────────────────────────────
            latitude  = self._get(message, ['position.latitude',  'lat',  'latitude'])
            longitude = self._get(message, ['position.longitude', 'lon',  'longitude'])

            if latitude is None or longitude is None:
                logger.debug(f"Flespi: Missing GPS coordinates for {imei}")
                return None

            try:
                lat_f = float(latitude)
                lon_f = float(longitude)
            except (ValueError, TypeError):
                return None

            if lat_f == 0.0 and lon_f == 0.0:
                logger.debug(f"Flespi: Zero GPS coordinates for {imei}")
                return None

            # ── Position fields ───────────────────────────────────
            altitude   = float(self._get(message, ['position.altitude',  'alt',       'altitude'])  or 0)
            speed      = float(self._get(message, ['position.speed',     'speed'])                  or 0)
            course     = float(self._get(message, ['position.direction', 'course',    'heading'])   or 0)
            satellites = int(  self._get(message, ['position.satellites','sat',       'satellites'])or 0)

            valid_raw  = self._get(message, ['position.valid', 'valid'])
            valid      = bool(valid_raw) if valid_raw is not None else True

            # ── Ignition ──────────────────────────────────────────
            ign_raw  = self._get(message, ['engine.ignition.status', 'ignition'])
            ignition = bool(ign_raw) if ign_raw is not None else None

            # ── Sensors ───────────────────────────────────────────
            sensors: Dict[str, Any] = {}

            _sensor_map = [
                (['battery.voltage',              'battery_voltage'],   'battery_voltage',   float),
                (['battery.level',                'battery_percent'],   'battery_percent',   float),
                (['external.powersource.voltage', 'external_voltage'],  'external_voltage',  float),
                (['gnss.hdop',                    'hdop'],              'hdop',              float),
                (['gsm.signal.level',             'rssi',    'signal'], 'gsm_signal',        int),
                (['engine.rpm',                   'rpm'],               'rpm',               int),
                (['fuel.level',                   'fuel_level'],        'fuel_level',        float),
                (['vehicle.mileage',              'odometer','mileage'],'odometer',          float),
                (['gsm.mcc',                      'mcc'],               'mcc',               str),
                (['gsm.mnc',                      'mnc'],               'mnc',               str),
                (['gsm.lac',                      'lac'],               'lac',               str),
                (['gsm.cellid',                   'cell_id'],           'cell_id',           str),
            ]

            for keys, sensor_key, cast in _sensor_map:
                val = self._get(message, keys)
                if val is not None:
                    try:
                        sensors[sensor_key] = cast(val)
                    except (ValueError, TypeError):
                        pass

            # Pass through any remaining unknown fields not already consumed
            for key, value in message.items():
                if key not in _POSITION_KEYS and key not in sensors:
                    sensors[key] = value

            return NormalizedPosition(
                imei=imei,
                protocol="flespi",
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=float(latitude),
                longitude=float(longitude),
                altitude=altitude,
                speed=speed,
                course=course,
                satellites=satellites,
                valid=valid,
                ignition=ignition,
                sensors=sensors,
                raw_data={'protocol': 'flespi'},
            )

        except Exception as e:
            logger.error(f"Flespi message parse error: {e}", exc_info=True)
            return None

    # ================================================================== #
    #  Command encoding                                                   #
    # ================================================================== #

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}

        cmd_key = command_type.lower()

        # ── custom: send raw JSON payload ─────────────────────────
        if cmd_key == 'custom':
            raw = params.get('payload', '')
            if not raw:
                return b''
            if isinstance(raw, str):
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    body = {'data': raw}
            else:
                body = raw
            return self._frame(body)

        # ── set_interval ──────────────────────────────────────────
        if cmd_key == 'set_interval':
            try:
                interval = int(params.get('interval', params.get('payload', 30)))
            except (ValueError, TypeError):
                interval = 30
            return self._frame({'action': 'set_interval', 'interval': interval})

        # ── config: send a JSON config blob ───────────────────────
        if cmd_key == 'config':
            raw = params.get('payload', {})
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except json.JSONDecodeError:
                    raw = {'data': raw}
            return self._frame({'action': 'config', **raw})

        # ── Registry-based static-body commands ───────────────────
        cmd_info = self.COMMAND_REGISTRY.get(cmd_key)
        if cmd_info and cmd_info.get('_body'):
            return self._frame(cmd_info['_body'])

        logger.warning(f"Flespi: Unknown or unimplemented command: {command_type!r}")
        return b''

    def _frame(self, body: Dict[str, Any]) -> bytes:
        """Serialise a dict as newline-terminated JSON (Flespi wire format)."""
        return (json.dumps(body) + '\n').encode('utf-8')

    # ================================================================== #
    #  Command metadata                                                   #
    # ================================================================== #

    def get_available_commands(self) -> List[str]:
        return list(self.COMMAND_REGISTRY.keys())

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        info = self.COMMAND_REGISTRY.get(command_type.lower(), {})
        return {
            'description':     info.get('description', 'Unknown command'),
            'example':         info.get('example', ''),
            'requires_params': info.get('requires_params', False),
        }

    # ================================================================== #
    #  Helpers                                                            #
    # ================================================================== #

    @staticmethod
    def _get(data: Dict[str, Any], keys: List[str]) -> Any:
        """Return the first matching value from a list of candidate keys."""
        for key in keys:
            if key in data:
                return data[key]
        return None
