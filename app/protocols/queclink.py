"""
Queclink Protocol Decoder
Supports Queclink GV, GL, and GB series GPS trackers.

Port: 5026 (TCP)
Format: ASCII text-based. Messages start with '+' and end with '$'.

Message structure:
  +<PREFIX>:<MSG_TYPE>,<fields...>$

  PREFIX   — RESP (unsolicited report), ACK (command acknowledgement),
             BUFF (buffered report)
  MSG_TYPE — GTFRI, GTSOS, GTIGN, etc.

Fixed field layout for GTFRI-style position messages:
  0:  Protocol version
  1:  IMEI
  2:  Device name
  3:  State bitmap (hex) — bit 0 = ignition/ACC
  4:  Report ID
  5:  Report type
  6:  Number
  7:  HDOP
  8:  Speed (km/h)
  9:  Course (degrees)
  10: Altitude (metres)
  11: Longitude
  12: Latitude
  13: Timestamp (YYYYMMDDHHMMSS)
  14: MCC
  15: MNC
  16: LAC
  17: Cell ID
  18: Reserved
  19: Send time
  20: Count / sequence

Outbound command format (server → device):
  AT+<CMD>=<password>,<params>$
"""
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

# Map message types to alert_type / event sensor values
_EVENT_MAP: Dict[str, Dict[str, str]] = {
    'GTIGN': {'event':      'ignition_on'},
    'GTIGF': {'event':      'ignition_off'},
    'GTSOS': {'alert_type': 'sos'},
    'GTSPD': {'alert_type': 'overspeed'},
    'GTPNA': {'event':      'power_on'},
    'GTPFA': {'event':      'power_off'},
    'GTTOW': {'alert_type': 'towing'},
    'GTDOG': {'alert_type': 'heartbeat'},
}


@ProtocolRegistry.register("queclink")
class QueclinkDecoder(BaseProtocolDecoder):
    """
    Queclink Protocol Decoder.
    Supports Queclink GV55, GV65, GV300, GL300, GL500, and compatible devices.
    """

    PORT = 5026
    PROTOCOL_TYPES = ['tcp']

    # ── Fixed field indices for GTFRI-style messages ──────────────────────
    _F_VER       = 0
    _F_IMEI      = 1
    _F_NAME      = 2
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

    # ================================================================== #
    #  Command Registry                                                   #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'reboot': {
            'description': 'Reboot the device',
            'example': 'reboot',
            'requires_params': False,
            '_at': 'GTRTO',
            '_args': lambda p: f"{p.get('password','000000')},,,,",
        },
        'get_version': {
            'description': 'Request firmware version',
            'example': 'get_version',
            'requires_params': False,
            '_at': 'GTVER',
            '_args': lambda p: f"{p.get('password','000000')},",
        },
        'request_position': {
            'description': 'Request an immediate GPS position update',
            'example': 'request_position',
            'requires_params': False,
            '_at': 'GTQSS',
            '_args': lambda p: f"{p.get('password','000000')},",
        },
        'set_interval': {
            'description': 'Set the periodic reporting interval (seconds)',
            'example': 'set_interval 30',
            'requires_params': True,
            '_at': None,   # built dynamically
        },
        'set_output': {
            'description': 'Control digital output / relay. params: output=1, state=0|1',
            'example': 'set_output 1 1',
            'requires_params': True,
            '_at': None,
        },
        'set_apn': {
            'description': 'Configure GPRS APN',
            'example': 'set_apn internet',
            'requires_params': True,
            '_at': None,
        },
        'set_server': {
            'description': 'Configure server address. params: ip, port',
            'example': 'set_server 1.2.3.4 5026',
            'requires_params': True,
            '_at': None,
        },
        'custom': {
            'description': 'Send a raw AT+ command string, e.g. "AT+GTQSS=000000,$"',
            'example': 'AT+GTQSS=000000,$',
            'requires_params': True,
            '_at': None,
        },
    }

    NATIVE_EVENTS = [
        {"key": "alert_type", "label": "🆘 SOS",           "severity": "critical", "trigger_value": "sos"},
        {"key": "alert_type", "label": "⚡ Power Off",      "severity": "critical", "trigger_value": "power_off"},
        {"key": "alert_type", "label": "🚨 Towing",        "severity": "critical", "trigger_value": "towing"},
        {"key": "event",      "label": "🔑 Ignition On",   "severity": "info",     "trigger_value": "ignition_on"},
        {"key": "event",      "label": "🔑 Ignition Off",  "severity": "info",     "trigger_value": "ignition_off"},
        {"key": "alert_type", "label": "⚡ Overspeed",     "severity": "warning",  "trigger_value": "overspeed"},
    ]

    # Running sequence counter for outbound AT commands (0000–FFFF)
    _seq: int = 0

    def __init__(self):
        super().__init__()
        self.pattern = re.compile(r'\+(\w+):(\w+),(.*?)\$', re.DOTALL)

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

            # ── Position message types ─────────────────────────────
            if msg_type in (
                'GTFRI', 'GTGEO', 'GTRTL', 'GTDOG', 'GTIDN',
                'GTSOS', 'GTSPD', 'GTPNA', 'GTPFA', 'GTIGN', 'GTIGF',
                'GTTOW',
            ):
                position = self._parse_position(fields, msg_type, known_imei)
                if not position:
                    return None, consumed

                # Apply event/alert annotations from the message type
                annotations = _EVENT_MAP.get(msg_type, {})
                for k, v in annotations.items():
                    position.sensors[k] = v

                # Ignition events — also set the top-level ignition field
                if msg_type == 'GTIGN':
                    position.ignition = True
                elif msg_type == 'GTIGF':
                    position.ignition = False

                return position, consumed

            # ── ACK packets ───────────────────────────────────────
            if prefix == 'ACK':
                logger.debug(f"Queclink: Command ACK for {msg_type}")
                return {'event': 'command_ack', 'msg_type': msg_type}, consumed

            logger.debug(f"Queclink: Unhandled message type: {msg_type}")
            return None, consumed

        except Exception as e:
            logger.error(f"Queclink decode error: {e}", exc_info=True)
            return None, len(data) if data else 1

    # ================================================================== #
    #  Position parser                                                    #
    # ================================================================== #

    def _parse_position(
        self,
        fields: List[str],
        msg_type: str,
        known_imei: Optional[str],
    ) -> Optional[NormalizedPosition]:
        try:
            if len(fields) <= self._F_LAT:
                logger.warning(f"Queclink: Not enough fields ({len(fields)}) for {msg_type}")
                return None

            # ── IMEI ──────────────────────────────────────────────
            imei = known_imei
            if not imei and len(fields) > self._F_IMEI:
                imei = fields[self._F_IMEI].strip() or None
            if not imei:
                logger.warning("Queclink: No IMEI")
                return None

            # ── Ignition from state bitmap (bit 0 = ACC) ──────────
            ignition: Optional[bool] = None
            if len(fields) > self._F_STATE and fields[self._F_STATE].strip():
                try:
                    state    = int(fields[self._F_STATE].strip(), 16)
                    ignition = bool(state & 0x01)
                except (ValueError, TypeError):
                    pass

            # ── Coordinates ───────────────────────────────────────
            try:
                latitude  = float(fields[self._F_LAT].strip())
                longitude = float(fields[self._F_LON].strip())
            except (ValueError, IndexError):
                logger.warning(f"Queclink: Invalid coordinates in {msg_type}")
                return None

            # ── Speed / course / altitude ─────────────────────────
            def _f(idx: int, default: float = 0.0) -> float:
                try:
                    v = fields[idx].strip() if len(fields) > idx else ''
                    return float(v) if v else default
                except ValueError:
                    return default

            speed    = _f(self._F_SPEED)
            course   = _f(self._F_COURSE)
            altitude = _f(self._F_ALTITUDE)
            hdop     = _f(self._F_HDOP)

            # ── Timestamp ─────────────────────────────────────────
            device_time = datetime.now(timezone.utc)
            if len(fields) > self._F_TIMESTAMP:
                ts = fields[self._F_TIMESTAMP].strip()
                if len(ts) >= 14:
                    try:
                        device_time = datetime(
                            int(ts[0:4]),  int(ts[4:6]),  int(ts[6:8]),
                            int(ts[8:10]), int(ts[10:12]), int(ts[12:14]),
                            tzinfo=timezone.utc,
                        )
                    except ValueError:
                        pass

            # ── Sensors ───────────────────────────────────────────
            sensors: Dict[str, Any] = {'message_type': msg_type}

            if hdop:
                sensors['hdop'] = hdop

            for attr, idx in (
                ('mcc',      self._F_MCC),
                ('mnc',      self._F_MNC),
                ('lac',      self._F_LAC),
                ('cell_id',  self._F_CELL_ID),
            ):
                if len(fields) > idx and fields[idx].strip():
                    sensors[attr] = fields[idx].strip()

            if len(fields) > self._F_VER  and fields[self._F_VER].strip():
                sensors['protocol_version'] = fields[self._F_VER].strip()
            if len(fields) > self._F_NAME and fields[self._F_NAME].strip():
                sensors['device_name'] = fields[self._F_NAME].strip()

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed,
                course=course,
                satellites=None,    # Queclink uses HDOP instead of satellite count
                valid=True,         # Queclink only reports when GPS is valid
                ignition=ignition,
                sensors=sensors,
                raw_data={'message_type': msg_type, 'prefix': 'RESP'},
            )

        except Exception as e:
            logger.error(f"Queclink position parse error: {e}", exc_info=True)
            return None

    # ================================================================== #
    #  Command encoding                                                   #
    # ================================================================== #

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}

        cmd_key  = command_type.lower()
        password = params.get('password', '000000')

        # ── custom: pass through verbatim ─────────────────────────
        if cmd_key == 'custom':
            raw = params.get('payload', '').strip()
            if not raw:
                return b''
            if not raw.upper().startswith('AT+'):
                raw = f'AT+{raw}'
            if not raw.endswith('$'):
                raw += '$'
            return raw.encode('ascii')

        # ── set_interval: AT+GTFRI ────────────────────────────────
        if cmd_key == 'set_interval':
            try:
                interval = int(params.get('interval', params.get('payload', 30)))
            except (ValueError, TypeError):
                interval = 30
            return self._at('GTFRI', f'{password},{interval},,,,')

        # ── set_output: AT+GTOUT ──────────────────────────────────
        if cmd_key == 'set_output':
            try:
                output = int(params.get('output', 1))
                state  = int(params.get('state', params.get('payload', 0)))
            except (ValueError, TypeError):
                output, state = 1, 0
            return self._at('GTOUT', f'{password},{output},{state},')

        # ── set_apn: AT+GTBSI (APN field only) ───────────────────
        if cmd_key == 'set_apn':
            apn = str(params.get('apn', params.get('payload', 'internet'))).strip()
            return self._at('GTBSI', f'{password},,,,0,{apn},,,')

        # ── set_server: AT+GTBSI (IP+port fields) ────────────────
        if cmd_key == 'set_server':
            ip   = str(params.get('ip',   '')).strip()
            port = int(params.get('port', 5026))
            return self._at('GTBSI', f'{password},{ip},{port},0,0,,,')

        # ── Registry-based lambda-args commands ───────────────────
        cmd_info = self.COMMAND_REGISTRY.get(cmd_key)
        if cmd_info and cmd_info.get('_at') and cmd_info.get('_args'):
            return self._at(cmd_info['_at'], cmd_info['_args'](params))

        logger.warning(f"Queclink: Unknown or unimplemented command: {command_type!r}")
        return b''

    def _at(self, cmd: str, args: str) -> bytes:
        """
        Build a Queclink AT command with an auto-incrementing sequence counter.
        Format: AT+<CMD>=<args><seq:04X>$
        """
        QueclinkDecoder._seq = (QueclinkDecoder._seq + 1) & 0xFFFF
        seq = f'{QueclinkDecoder._seq:04X}'
        return f'AT+{cmd}={args}{seq}$'.encode('ascii')

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
