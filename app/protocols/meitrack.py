import re
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("meitrack")
class MeitrackDecoder(BaseProtocolDecoder):
    """
    Meitrack Protocol Decoder
    Supports Meitrack MVT, T, and other series GPS trackers.

    Port: 5020 (TCP)
    Format: ASCII text with $$ delimiters

    Example:
      $$A123,123456789012345,AAA,35,31.234567,121.234567,120101120101,A,10,12,0,0,0,100,200,12.34,3.45,1,2,3|4|5|6|*AB<CR><LF>

    Field layout:
      0:  Field count
      1:  Latitude
      2:  Longitude
      3:  Timestamp (YYMMDDHHMMSS)
      4:  GPS validity (A/V)
      5:  Satellites
      6:  GSM signal
      7:  Speed (km/h)
      8:  Course
      9:  HDOP
      10: Altitude
      11: Odometer
      12: Runtime
      13: Base station (MCC|MNC|LAC|CellID)
      14: Battery voltage
      15: Battery percent
      16: Digital inputs bitmask (bit 0 = ACC/ignition)
      17: Digital outputs bitmask
      18: Analog inputs (pipe-separated)
    """

    PORT = 5020
    PROTOCOL_TYPES = ['tcp']

    def __init__(self):
        super().__init__()
        self.pattern = re.compile(
            r'\$\$([A-Z]\d+),([^,]+),([^,]+),(.+?)(?:\*([0-9A-F]{2}))?\r?\n',
            re.DOTALL
        )

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

            if event_code in ('AAA', 'CCC', 'DDD'):
                position = self._parse_position(imei, event_code, fields)
                if position:
                    if event_code == 'AAA':
                        # FIX: return login ACK alongside position instead of discarding it
                        response = f"$$B{len(imei) + 3},{imei},AAA\r\n".encode('ascii')
                        return {"position": position, "imei": imei, "response": response}, consumed
                    return position, consumed

            else:
                logger.debug(f"Meitrack: Unhandled event code: {event_code}")

            return None, consumed

        except Exception as e:
            logger.error(f"Meitrack decode error: {e}", exc_info=True)
            return None, len(data) if data else 1

    def _parse_position(
        self,
        imei: str,
        event_code: str,
        fields: list,
    ) -> Optional[NormalizedPosition]:
        try:
            if len(fields) < 10:
                logger.warning(f"Meitrack: Not enough fields ({len(fields)})")
                return None

            def _float(idx: int, default: float = 0.0) -> float:
                try:
                    return float(fields[idx]) if len(fields) > idx and fields[idx] else default
                except ValueError:
                    return default

            def _int(idx: int, default: int = 0) -> int:
                try:
                    return int(fields[idx]) if len(fields) > idx and fields[idx] else default
                except ValueError:
                    return default

            latitude  = _float(1)
            longitude = _float(2)

            # Timestamp YYMMDDHHMMSS
            time_str = fields[3] if len(fields) > 3 else ''
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
                    device_time = datetime.now(timezone.utc)
            else:
                device_time = datetime.now(timezone.utc)

            valid      = fields[4] == 'A' if len(fields) > 4 else False
            satellites = _int(5)
            gsm_signal = _int(6)
            speed      = _float(7)
            course     = _float(8)
            hdop       = _float(9)
            altitude   = _float(10)

            sensors: Dict[str, Any] = {
                'event_code': event_code,
                'gsm_signal': gsm_signal,
                'hdop':       hdop,
            }

            # Odometer
            if len(fields) > 11 and fields[11]:
                try:
                    sensors['odometer'] = float(fields[11])
                except ValueError:
                    pass

            # Runtime
            if len(fields) > 12 and fields[12]:
                try:
                    sensors['runtime'] = int(fields[12])
                except ValueError:
                    pass

            # Base station info
            if len(fields) > 13 and fields[13]:
                try:
                    bs = fields[13].split('|')
                    if len(bs) >= 4:
                        sensors['mcc']     = bs[0]
                        sensors['mnc']     = bs[1]
                        sensors['lac']     = bs[2]
                        sensors['cell_id'] = bs[3]
                except Exception:
                    pass

            # Battery voltage
            if len(fields) > 14 and fields[14]:
                try:
                    sensors['battery_voltage'] = float(fields[14])
                except ValueError:
                    pass

            # Battery percent
            if len(fields) > 15 and fields[15]:
                try:
                    sensors['battery_percent'] = int(fields[15])
                except ValueError:
                    pass

            # FIX: extract ignition from digital inputs bitmask (bit 0 = ACC)
            ignition: Optional[bool] = None
            if len(fields) > 16 and fields[16]:
                try:
                    digital_inputs = int(fields[16])
                    sensors['digital_inputs'] = digital_inputs
                    ignition = bool(digital_inputs & 0x01)
                except ValueError:
                    pass

            # Digital outputs
            if len(fields) > 17 and fields[17]:
                try:
                    sensors['digital_outputs'] = int(fields[17])
                except ValueError:
                    pass

            # Analog inputs (pipe-separated)
            if len(fields) > 18 and fields[18]:
                try:
                    for i, val in enumerate(fields[18].split('|')):
                        if val:
                            sensors[f'analog_{i + 1}'] = float(val)
                except Exception:
                    pass

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),  # FIX: was missing
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed,
                course=course,
                satellites=satellites,
                valid=valid,
                ignition=ignition,
                sensors=sensors,
            )

        except Exception as e:
            logger.error(f"Meitrack position parse error: {e}", exc_info=True)
            return None

    # ── Commands ─────────────────────────────────────────────────────────────

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        try:
            imei = params.get('imei', '')
            if not imei:
                logger.warning("Meitrack: IMEI required for commands")
                return b''

            if command_type == 'request_position':
                cmd_str = f"A10,{imei}"
            elif command_type == 'reboot':
                cmd_str = f"A11,{imei}"
            elif command_type == 'set_interval':
                interval = params.get('interval', 30)
                cmd_str = f"A12,{imei},{interval}"
            elif command_type == 'set_server':
                ip   = params.get('ip', '')
                port = params.get('port', 5020)
                cmd_str = f"A13,{imei},{ip},{port}"
            elif command_type == 'set_apn':
                apn      = params.get('apn', 'internet')
                username = params.get('username', '')
                password = params.get('password', '')
                cmd_str = f"A14,{imei},{apn},{username},{password}"
            elif command_type == 'set_timezone':
                tz_offset = params.get('timezone', 0)
                cmd_str = f"A15,{imei},{tz_offset}"
            elif command_type == 'enable_output':
                output_type = params.get('output_type', 'ACC')
                cmd_str = f"A16,{imei},{output_type},1"
            elif command_type == 'disable_output':
                output_type = params.get('output_type', 'ACC')
                cmd_str = f"A16,{imei},{output_type},0"
            elif command_type == 'custom':
                cmd_str = params.get('payload', '')
            else:
                logger.warning(f"Meitrack: Unknown command '{command_type}'")
                return b''

            length  = len(cmd_str)
            command = f"@@A{length:02d},{cmd_str}"
            checksum = 0
            for byte in command.encode('ascii'):
                checksum ^= byte
            command += f"*{checksum:02X}\r\n"
            return command.encode('ascii')

        except Exception as e:
            logger.error(f"Meitrack command encode error: {e}")
            return b''

    def get_available_commands(self) -> list:
        return [
            'request_position', 'reboot', 'set_interval', 'set_server',
            'set_apn', 'set_timezone', 'enable_output', 'disable_output', 'custom',
        ]

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        info = {
            'request_position': {'description': 'Request current position',          'params': {'imei': 'str'}},
            'reboot':           {'description': 'Reboot the device',                 'params': {'imei': 'str'}},
            'set_interval':     {'description': 'Set reporting interval (seconds)',   'params': {'imei': 'str', 'interval': 'int'}},
            'set_server':       {'description': 'Set server IP and port',            'params': {'imei': 'str', 'ip': 'str', 'port': 'int'}},
            'set_apn':          {'description': 'Set GPRS APN',                      'params': {'imei': 'str', 'apn': 'str'}},
            'set_timezone':     {'description': 'Set timezone offset',               'params': {'imei': 'str', 'timezone': 'int'}},
            'enable_output':    {'description': 'Enable output (ACC, etc.)',          'params': {'imei': 'str', 'output_type': 'str'}},
            'disable_output':   {'description': 'Disable output (ACC, etc.)',         'params': {'imei': 'str', 'output_type': 'str'}},
            'custom':           {'description': 'Send a raw custom command string',  'params': {'imei': 'str', 'payload': 'str'}},
        }
        return info.get(command_type, {'description': 'Unknown command', 'supported': False})
