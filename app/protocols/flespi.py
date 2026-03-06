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
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

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

            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                logger.error("Flespi: Failed to decode UTF-8, skipping byte")
                return None, 1

            newline_idx = text.find('\n')
            if newline_idx == -1:
                if len(data) > 8192:
                    logger.warning("Flespi: Buffer too large without newline, resetting")
                    return None, len(data)
                return None, 0

            json_str = text[:newline_idx].strip()
            consumed = len(json_str.encode('utf-8')) + 1  # +1 for the newline

            if not json_str:
                return None, consumed

            try:
                message = json.loads(json_str)
            except json.JSONDecodeError as e:
                logger.error(f"Flespi: JSON decode error: {e} — raw: {json_str[:120]}")
                return None, consumed

            # ── Single message ─────────────────────────────────────
            if isinstance(message, dict):
                # Login / auth message — device identifies itself
                ident = message.get('ident') or message.get('device.ident')
                if ident and not known_imei:
                    logger.info(f"Flespi login: {ident}")
                    return {
                        'event': 'login',
                        'imei': str(ident),
                        'response': b'{"status":"ok"}\n',
                    }, consumed

                pos = self._parse_message(message, known_imei)
                if pos:
                    return pos, consumed
                return None, consumed

            # ── Batch of messages ──────────────────────────────────
            if isinstance(message, list):
                positions: List[NormalizedPosition] = []
                for msg in message:
                    if isinstance(msg, dict):
                        pos = self._parse_message(msg, known_imei)
                        if pos:
                            positions.append(pos)

                if not positions:
                    return None, consumed

                # Return first position; extras passed through extra_positions
                # so the server can persist all of them (same pattern as Teltonika).
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
                logger.warning(f"Flespi: Missing GPS coordinates for {imei}")
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
