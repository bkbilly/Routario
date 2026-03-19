"""
Meitrack Protocol Decoder
Supports Meitrack MVT, T1, T3, T333, and other series GPS trackers.

Port: 5020 (TCP)
Format: ASCII text with $$ delimiters and optional XOR checksum.

Device → Server message structure:
  $$<flag><length>,<IMEI>,<event_code>,<field_count>,<fields...>*<XOR>\r\n

Server → Device command structure:
  @@<flag><length>,<IMEI>,<cmd_code>,<args>*<XOR>\r\n

Example (device → server):
  $$A123,123456789012345,AAA,35,31.234567,121.234567,120101120101,A,10,12,0,0,0,100,200,12.34,3.45,1,2,3|4|5|6|*AB\r\n

Common event codes:
  AAA — GPS tracking / login
  CCC — Heartbeat / status
  DDD — GPS tracking (extended)
  BPP — SOS alarm
  BPA — Power cut alarm
  BPB — Low battery alarm
  BPC — Speeding alarm
  BPD — Geo-fence alarm
  BPE — Towing alarm
  BPF — Tampering / shock alarm

Field layout (payload after event code + field count):
  0:  (field count — already consumed by regex group)
  1:  Latitude  (decimal degrees)
  2:  Longitude (decimal degrees)
  3:  Timestamp (YYMMDDHHMMSS)
  4:  GPS validity (A = valid, V = invalid)
  5:  Satellites
  6:  GSM signal strength
  7:  Speed (km/h)
  8:  Course (degrees)
  9:  HDOP
  10: Altitude (metres)
  11: Odometer (metres — divide by 1000 for km)
  12: Runtime (seconds)
  13: Base station info (MCC|MNC|LAC|CellID)
  14: Battery voltage (mV — divide by 1000 for V)
  15: Battery percent
  16: Digital inputs bitmask (bit 0 = ACC / ignition)
  17: Digital outputs bitmask
  18: Analog inputs (pipe-separated, mV)
"""
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)


# Event code → sensor annotation
_EVENT_MAP: Dict[str, Dict[str, str]] = {
    'BPP': {'alert_type': 'sos'},
    'BPA': {'alert_type': 'power_cut'},
    'BPB': {'alert_type': 'low_battery'},
    'BPC': {'alert_type': 'overspeed'},
    'BPD': {'alert_type': 'geofence'},
    'BPE': {'alert_type': 'towing'},
    'BPF': {'alert_type': 'tampering'},
    'CCC': {'event':      'heartbeat'},
}


@ProtocolRegistry.register("meitrack")
class MeitrackDecoder(BaseProtocolDecoder):
    """
    Meitrack Protocol Decoder.
    Supports MVT100, MVT340, MVT380, T1, T3, T333, and compatible devices.
    """

    PORT = 5020
    PROTOCOL_TYPES = ['tcp']

    # ================================================================== #
    #  Command Registry                                                   #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'request_position': {
            'description': 'Request an immediate position update',
            'example': 'request_position',
            'requires_params': False,
            '_code': 'A10',
            '_args': lambda imei, p: imei,
        },
        'reboot': {
            'description': 'Reboot the device',
            'example': 'reboot',
            'requires_params': False,
            '_code': 'A11',
            '_args': lambda imei, p: imei,
        },
        'set_interval': {
            'description': 'Set GPS reporting interval (seconds)',
            'example': 'set_interval 30',
            'requires_params': True,
            '_code': 'A12',
            '_args': lambda imei, p: f"{imei},{int(p.get('interval', p.get('payload', 30)))}",
        },
        'set_server': {
            'description': 'Set server IP and port',
            'example': 'set_server 1.2.3.4 5020',
            'requires_params': True,
            '_code': 'A13',
            '_args': lambda imei, p: f"{imei},{p.get('ip','')},{int(p.get('port',5020))}",
        },
        'set_apn': {
            'description': 'Set GPRS APN (and optional username/password)',
            'example': 'set_apn internet',
            'requires_params': True,
            '_code': 'A14',
            '_args': lambda imei, p: f"{imei},{p.get('apn','internet')},{p.get('username','')},{p.get('password','')}",
        },
        'set_output': {
            'description': 'Control digital output. params: output=ACC|OUT1|OUT2, state=0|1',
            'example': 'set_output ACC 1',
            'requires_params': True,
            '_code': 'A16',
            '_args': None,   # built dynamically
        },
        'set_timezone': {
            'description': 'Set timezone offset in minutes (e.g. 120 for UTC+2)',
            'example': 'set_timezone 120',
            'requires_params': True,
            '_code': 'A15',
            '_args': lambda imei, p: f"{imei},{int(p.get('timezone', p.get('payload', 0)))}",
        },
        'custom': {
            'description': 'Send a raw Meitrack command body, e.g. "A10,<imei>"',
            'example': 'A10,123456789012345',
            'requires_params': True,
            '_code': None,
            '_args': None,
        },
    }

    NATIVE_EVENTS = [
        {"key": "alert_type", "label": "🆘 SOS",          "severity": "critical", "trigger_value": "sos"},
        {"key": "alert_type", "label": "⚡ Power Cut",     "severity": "critical", "trigger_value": "power_cut"},
        {"key": "alert_type", "label": "🪫 Low Battery",  "severity": "warning",  "trigger_value": "low_battery"},
        {"key": "alert_type", "label": "🚨 Towing",       "severity": "critical", "trigger_value": "towing"},
        {"key": "alert_type", "label": "⚠️ Tampering",    "severity": "warning",  "trigger_value": "tampering"},
        {"key": "alert_type", "label": "⚡ Overspeed",    "severity": "warning",  "trigger_value": "overspeed"},
        {"key": "alert_type", "label": "📍 Geofence",     "severity": "warning",  "trigger_value": "geofence"},
    ]

    def __init__(self):
        super().__init__()
        # Matches: $$<flag><len>,<imei>,<event>,<payload>[*<XOR>]\r\n
        self.pattern = re.compile(
            r'\$\$([A-Z]\d+),([^,]+),([^,]+),(.+?)(?:\*([0-9A-F]{2}))?\r?\n',
            re.DOTALL,
        )

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
                logger.error("Meitrack: Failed to decode ASCII")
                return None, len(data)

            start = text.find('$$')
            if start == -1:
                return None, len(data)

            end = text.find('\n', start)
            if end == -1:
                if len(data) > 2048:
                    logger.warning("Meitrack: Buffer too large, resetting")
                    return None, len(data)
                return None, 0

            message  = text[start:end + 1]
            consumed = len(text[:end + 1].encode('ascii'))

            match = self.pattern.match(message)
            if not match:
                logger.warning(f"Meitrack: Invalid format: {message[:60]}")
                return None, consumed

            imei       = match.group(2)
            event_code = match.group(3)
            payload    = match.group(4)

            logger.debug(f"Meitrack: IMEI={imei}, Event={event_code}")

            fields = payload.split(',')

            # ── Position-bearing event codes ───────────────────────
            if event_code in (
                'AAA', 'CCC', 'DDD',
                'BPP', 'BPA', 'BPB', 'BPC', 'BPD', 'BPE', 'BPF',
            ):
                position = self._parse_position(imei, event_code, fields)
                if position:
                    # Annotate from event map
                    for k, v in _EVENT_MAP.get(event_code, {}).items():
                        position.sensors[k] = v

                    if event_code == 'AAA':
                        # Login — ACK and return position together
                        response = f"$$B{len(imei) + 3},{imei},AAA\r\n".encode('ascii')
                        return {'position': position, 'imei': imei, 'response': response}, consumed

                    return position, consumed

            else:
                logger.debug(f"Meitrack: Unhandled event code: {event_code}")

            return None, consumed

        except Exception as e:
            logger.error(f"Meitrack decode error: {e}", exc_info=True)
            return None, len(data) if data else 1

    # ================================================================== #
    #  Position parser                                                    #
    # ================================================================== #

    def _parse_position(
        self,
        imei: str,
        event_code: str,
        fields: List[str],
    ) -> Optional[NormalizedPosition]:
        try:
            if len(fields) < 10:
                logger.warning(f"Meitrack: Not enough fields ({len(fields)}) for {event_code}")
                return None

            def _f(idx: int, default: float = 0.0) -> float:
                try:
                    return float(fields[idx]) if len(fields) > idx and fields[idx].strip() else default
                except ValueError:
                    return default

            def _i(idx: int, default: int = 0) -> int:
                try:
                    return int(fields[idx]) if len(fields) > idx and fields[idx].strip() else default
                except ValueError:
                    return default

            latitude  = _f(1)
            longitude = _f(2)

            # Timestamp: YYMMDDHHMMSS
            time_str    = fields[3].strip() if len(fields) > 3 else ''
            device_time = datetime.now(timezone.utc)
            if len(time_str) >= 12:
                try:
                    device_time = datetime(
                        2000 + int(time_str[0:2]),
                        int(time_str[2:4]),
                        int(time_str[4:6]),
                        int(time_str[6:8]),
                        int(time_str[8:10]),
                        int(time_str[10:12]),
                        tzinfo=timezone.utc,
                    )
                except ValueError:
                    pass

            valid      = fields[4].strip() == 'A' if len(fields) > 4 else False
            satellites = _i(5)
            gsm_signal = _i(6)
            speed      = _f(7)
            course     = _f(8)
            hdop       = _f(9)
            altitude   = _f(10)

            sensors: Dict[str, Any] = {
                'event_code': event_code,
                'gsm_signal': gsm_signal,
                'hdop':       hdop,
            }

            # Odometer — stored in metres, expose as km
            if len(fields) > 11 and fields[11].strip():
                try:
                    sensors['odometer'] = round(float(fields[11]) / 1000.0, 3)
                except ValueError:
                    pass

            # Runtime (seconds)
            if len(fields) > 12 and fields[12].strip():
                try:
                    sensors['runtime'] = int(fields[12])
                except ValueError:
                    pass

            # Base station: MCC|MNC|LAC|CellID
            if len(fields) > 13 and fields[13].strip():
                try:
                    bs = fields[13].strip().split('|')
                    if len(bs) >= 4:
                        sensors['mcc']     = bs[0]
                        sensors['mnc']     = bs[1]
                        sensors['lac']     = bs[2]
                        sensors['cell_id'] = bs[3]
                except Exception:
                    pass

            # Battery voltage — stored in mV, expose as V
            if len(fields) > 14 and fields[14].strip():
                try:
                    sensors['battery_voltage'] = round(float(fields[14]) / 1000.0, 3)
                except ValueError:
                    pass

            # Battery percent
            if len(fields) > 15 and fields[15].strip():
                try:
                    sensors['battery_percent'] = int(fields[15])
                except ValueError:
                    pass

            # Digital inputs — bit 0 = ACC / ignition
            ignition: Optional[bool] = None
            if len(fields) > 16 and fields[16].strip():
                try:
                    din = int(fields[16])
                    sensors['digital_inputs'] = din
                    ignition = bool(din & 0x01)
                except ValueError:
                    pass

            # Digital outputs
            if len(fields) > 17 and fields[17].strip():
                try:
                    sensors['digital_outputs'] = int(fields[17])
                except ValueError:
                    pass

            # Analog inputs (pipe-separated, in mV — expose as V)
            if len(fields) > 18 and fields[18].strip():
                try:
                    for i, val in enumerate(fields[18].strip().split('|')):
                        if val:
                            sensors[f'analog_{i + 1}'] = round(float(val) / 1000.0, 3)
                except Exception:
                    pass

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed,
                course=course,
                satellites=satellites,
                valid=valid,
                ignition=ignition,
                sensors=sensors,
                raw_data={'event_code': event_code},
            )

        except Exception as e:
            logger.error(f"Meitrack position parse error: {e}", exc_info=True)
            return None

    # ================================================================== #
    #  Command encoding                                                   #
    # ================================================================== #

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}

        imei = params.get('imei', '').strip()
        if not imei:
            logger.warning("Meitrack: encode_command called without 'imei' in params")
            return b''

        cmd_key = command_type.lower()

        # ── custom: raw command body ───────────────────────────────
        if cmd_key == 'custom':
            raw = params.get('payload', '').strip()
            if not raw:
                return b''
            return self._frame(raw)

        # ── set_output: A16,<imei>,<output_type>,<state> ──────────
        if cmd_key == 'set_output':
            output = str(params.get('output', params.get('output_type', 'ACC'))).strip()
            try:
                state = int(params.get('state', params.get('payload', 0)))
            except (ValueError, TypeError):
                state = 0
            return self._frame(f'A16,{imei},{output},{state}')

        # ── Registry-based commands with lambda args ───────────────
        cmd_info = self.COMMAND_REGISTRY.get(cmd_key)
        if cmd_info and cmd_info.get('_code') and cmd_info.get('_args'):
            try:
                args = cmd_info['_args'](imei, params)
                return self._frame(f"{cmd_info['_code']},{args}")
            except Exception as e:
                logger.error(f"Meitrack: Failed to build command {cmd_key!r}: {e}")
                return b''

        logger.warning(f"Meitrack: Unknown or unimplemented command: {command_type!r}")
        return b''

    def _frame(self, body: str) -> bytes:
        """
        Wrap a command body in the Meitrack server→device frame.

        Format: @@<flag><length>,<body>*<XOR>\r\n

        The length field counts everything from the flag char to the end of
        body (inclusive), i.e. len("A" + str(length_field) + "," + body).
        Meitrack uses a fixed single-character flag 'A' for most commands.
        The XOR checksum covers the entire message including '@@'.
        """
        # First pass: estimate length (flag + len_digits + comma + body)
        # length field = number of bytes from flag through end of body
        flag    = 'A'
        # The length digits themselves are part of the counted region, so we
        # need to solve: len(flag + str(L) + "," + body) == L
        # Typically body is short enough that len(str(L)) == 3 (100-999).
        for digits in (2, 3, 4):
            candidate = len(flag) + digits + 1 + len(body)   # flag + digits + comma + body
            if len(str(candidate)) == digits:
                length = candidate
                break
        else:
            length = len(flag) + 3 + 1 + len(body)

        msg_body   = f'@@{flag}{length},{body}'
        xor        = 0
        for ch in msg_body.encode('ascii'):
            xor ^= ch
        packet = f'{msg_body}*{xor:02X}\r\n'
        return packet.encode('ascii')

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
