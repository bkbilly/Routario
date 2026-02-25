import re
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("queclink")
class QueclinkDecoder(BaseProtocolDecoder):
    """
    Queclink Protocol Decoder
    Supports Queclink GV, GL, and GB series GPS trackers.

    Port: 5026 (TCP)
    Format: ASCII text-based with + delimiters

    Fixed field layout for GTFRI and similar:
      0:  Protocol version
      1:  IMEI
      2:  Device name
      3:  State bitmap (hex) — bit 0 = ignition
      4:  Report ID
      5:  Report type
      6:  Number
      7:  GPS accuracy / HDOP
      8:  Speed (km/h)
      9:  Azimuth / course
      10: Altitude
      11: Longitude
      12: Latitude
      13: Timestamp (YYYYMMDDHHMMSS)
      14: MCC
      15: MNC
      16: LAC
      17: Cell ID
      18: Reserved
      19: Send time
      20: Count
    """

    PORT = 5026
    PROTOCOL_TYPES = ['tcp']

    # Fixed field indices for GTFRI-style messages
    _F_IMEI      = 1
    _F_STATE     = 3   # hex bitmap, bit 0 = ignition/ACC
    _F_HDOP      = 7
    _F_SPEED     = 8
    _F_COURSE    = 9
    _F_ALTITUDE  = 10
    _F_LON       = 11
    _F_LAT       = 12
    _F_TIMESTAMP = 13
    _F_MCC       = 14
    _F_MNC       = 15
    _F_LAC       = 16
    _F_CELL_ID   = 17

    def __init__(self):
        super().__init__()
        self.pattern = re.compile(r'\+(\w+):(\w+),(.*?)\$', re.DOTALL)

    async def decode(
        self,
        data: bytes,
        client_info: Dict[str, Any],
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            if not data:
                return None, 0

            try:
                text = data.decode('ascii', errors='ignore')
            except Exception:
                logger.error("Queclink: Failed to decode ASCII")
                return None, len(data)

            start = text.find('+')
            end   = text.find('$', start)

            if start == -1:
                return None, len(data)
            if end == -1:
                if len(data) > 2048:
                    logger.warning("Queclink: Buffer too large, resetting")
                    return None, len(data)
                return None, 0

            message  = text[start:end + 1]
            # FIX: consumed accounts for position of start in original buffer
            consumed = len(text[:end + 1].encode('ascii'))

            match = self.pattern.match(message)
            if not match:
                logger.warning(f"Queclink: Invalid format: {message[:60]}")
                return None, consumed

            prefix   = match.group(1)   # RESP, ACK, BUFF
            msg_type = match.group(2)   # GTFRI, GTSOS, etc.
            payload  = match.group(3)

            logger.debug(f"Queclink: {prefix}:{msg_type}")

            fields = payload.split(',')

            # ── Position message types ───────────────────────────────────────
            if msg_type in ('GTFRI', 'GTGEO', 'GTRTL', 'GTDOG', 'GTIDN',
                            'GTSOS', 'GTSPD', 'GTPNA', 'GTPFA', 'GTIGN', 'GTIGF'):

                position = self._parse_position(fields, msg_type, known_imei)
                if not position:
                    return None, consumed

                # Ignition events — override ignition field directly from msg type
                if msg_type == 'GTIGN':
                    position.ignition = True
                    position.sensors['event'] = 'ignition_on'
                elif msg_type == 'GTIGF':
                    position.ignition = False
                    position.sensors['event'] = 'ignition_off'
                elif msg_type == 'GTSOS':
                    position.sensors['alert_type'] = 'SOS'
                elif msg_type == 'GTSPD':
                    position.sensors['alert_type'] = 'speed'
                elif msg_type == 'GTPNA':
                    position.sensors['event'] = 'power_on'
                elif msg_type == 'GTPFA':
                    position.sensors['event'] = 'power_off'

                return position, consumed

            else:
                logger.debug(f"Queclink: Unhandled message type: {msg_type}")
                return None, consumed

        except Exception as e:
            logger.error(f"Queclink decode error: {e}", exc_info=True)
            return None, len(data) if data else 1

    def _parse_position(
        self,
        fields: list,
        msg_type: str,
        known_imei: Optional[str],
    ) -> Optional[NormalizedPosition]:
        try:
            if len(fields) <= self._F_LAT:
                logger.warning(f"Queclink: Not enough fields ({len(fields)}) for {msg_type}")
                return None

            # ── IMEI ────────────────────────────────────────────────────────
            imei = known_imei or (fields[self._F_IMEI].strip() if len(fields) > self._F_IMEI else None)
            if not imei:
                logger.warning("Queclink: No IMEI")
                return None

            # ── Ignition from state bitmap (bit 0 = ACC) ────────────────────
            # FIX: parse from fixed field index instead of heuristic search
            ignition: Optional[bool] = None
            if len(fields) > self._F_STATE and fields[self._F_STATE].strip():
                try:
                    state = int(fields[self._F_STATE].strip(), 16)
                    ignition = bool(state & 0x01)
                except (ValueError, TypeError):
                    pass

            # ── Coordinates — fixed indices ──────────────────────────────────
            # FIX: use fixed field positions, not heuristic float-range search
            try:
                latitude  = float(fields[self._F_LAT].strip())
                longitude = float(fields[self._F_LON].strip())
            except (ValueError, IndexError):
                logger.warning(f"Queclink: Invalid coordinates in {msg_type}")
                return None

            # ── Speed / course / altitude ───────────────────────────────────
            def _f(idx: int, default: float = 0.0) -> float:
                try:
                    return float(fields[idx].strip()) if len(fields) > idx and fields[idx].strip() else default
                except ValueError:
                    return default

            speed    = _f(self._F_SPEED)
            course   = _f(self._F_COURSE)
            altitude = _f(self._F_ALTITUDE)

            # ── HDOP / satellites ───────────────────────────────────────────
            hdop = _f(self._F_HDOP)
            # Queclink uses HDOP in field 7; no satellite count in standard layout
            satellites = None

            # ── Timestamp ───────────────────────────────────────────────────
            device_time = datetime.now(timezone.utc)
            if len(fields) > self._F_TIMESTAMP and len(fields[self._F_TIMESTAMP].strip()) >= 14:
                ts = fields[self._F_TIMESTAMP].strip()
                try:
                    device_time = datetime(
                        int(ts[0:4]), int(ts[4:6]),  int(ts[6:8]),
                        int(ts[8:10]), int(ts[10:12]), int(ts[12:14]),
                        tzinfo=timezone.utc
                    )
                except ValueError:
                    pass

            # ── Sensors ─────────────────────────────────────────────────────
            sensors: Dict[str, Any] = {'message_type': msg_type}

            if hdop:
                sensors['hdop'] = hdop

            if len(fields) > self._F_MCC and fields[self._F_MCC].strip():
                sensors['mcc'] = fields[self._F_MCC].strip()
            if len(fields) > self._F_MNC and fields[self._F_MNC].strip():
                sensors['mnc'] = fields[self._F_MNC].strip()
            if len(fields) > self._F_LAC and fields[self._F_LAC].strip():
                sensors['lac'] = fields[self._F_LAC].strip()
            if len(fields) > self._F_CELL_ID and fields[self._F_CELL_ID].strip():
                sensors['cell_id'] = fields[self._F_CELL_ID].strip()

            if len(fields) > 0 and fields[0].strip():
                sensors['protocol_version'] = fields[0].strip()
            if len(fields) > 2 and fields[2].strip():
                sensors['device_name'] = fields[2].strip()

            position = NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed,
                course=course,
                satellites=satellites,
                valid=True,   # Queclink only sends when GPS is valid
                ignition=ignition,
                sensors=sensors,
            )

            logger.debug(f"Queclink decoded: {imei} @ {latitude},{longitude}")
            return position

        except Exception as e:
            logger.error(f"Queclink position parse error: {e}", exc_info=True)
            return None

    # ── Commands ─────────────────────────────────────────────────────────────

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        try:
            password = params.get('password', '000000')

            if command_type == 'reboot':
                command = f"AT+GTRTO={password},,,,0002$"
            elif command_type == 'get_version':
                command = f"AT+GTVER={password},,0003$"
            elif command_type == 'set_interval':
                interval = params.get('interval', 30)
                command = f"AT+GTFRI={password},{interval},,,,0004$"
            elif command_type == 'request_position':
                command = f"AT+GTQSS={password},,0005$"
            elif command_type == 'set_server':
                ip   = params.get('ip', '')
                port = params.get('port', 5026)
                command = f"AT+GTBSI={password},{ip},{port},0,0,,,0006$"
            elif command_type == 'set_apn':
                apn = params.get('apn', 'internet')
                command = f"AT+GTBSI={password},,,,0,{apn},,,0007$"
            elif command_type == 'enable_output':
                output_type = params.get('output_type', 'GTFRI')
                command = f"AT+GTTOW={password},{output_type},1,,0008$"
            elif command_type == 'disable_output':
                output_type = params.get('output_type', 'GTFRI')
                command = f"AT+GTTOW={password},{output_type},0,,0009$"
            elif command_type == 'custom':
                command = params.get('payload', '')
                if not command.startswith('AT+'):
                    command = f"AT+{command}"
                if not command.endswith('$'):
                    command += '$'
            else:
                logger.warning(f"Queclink: Unknown command '{command_type}'")
                return b''

            return command.encode('ascii')

        except Exception as e:
            logger.error(f"Queclink command encode error: {e}")
            return b''

    def get_available_commands(self) -> list:
        return [
            'reboot', 'get_version', 'set_interval', 'request_position',
            'set_server', 'set_apn', 'enable_output', 'disable_output', 'custom',
        ]

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        info = {
            'reboot':           {'description': 'Reboot the device',                    'params': {'password': 'str'}},
            'get_version':      {'description': 'Get firmware version',                 'params': {'password': 'str'}},
            'set_interval':     {'description': 'Set reporting interval (seconds)',      'params': {'interval': 'int', 'password': 'str'}},
            'request_position': {'description': 'Request immediate GPS position',       'params': {'password': 'str'}},
            'set_server':       {'description': 'Configure server IP and port',         'params': {'ip': 'str', 'port': 'int', 'password': 'str'}},
            'set_apn':          {'description': 'Configure APN for GPRS',              'params': {'apn': 'str', 'password': 'str'}},
            'enable_output':    {'description': 'Enable message output type',           'params': {'output_type': 'str', 'password': 'str'}},
            'disable_output':   {'description': 'Disable message output type',          'params': {'output_type': 'str', 'password': 'str'}},
            'custom':           {'description': 'Send custom AT command',               'params': {'payload': 'str'}},
        }
        return info.get(command_type, {'description': 'Unknown command', 'supported': False})
