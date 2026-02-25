import re
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("tk103")
class TK103Decoder(BaseProtocolDecoder):
    """
    TK103 Protocol Decoder
    Supports Coban TK103, Xexun, and many Chinese GPS tracker clones.

    Port: 5001 (TCP)
    Format: ASCII text-based protocol with parentheses delimiters

    Examples:
      Heartbeat: (123456789012BP05000)
      Login:     (000000000000BR00240101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)
      Position:  (123456789012BO00210101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)
    """

    PORT = 5001
    PROTOCOL_TYPES = ['tcp']

    def __init__(self):
        super().__init__()
        # FIX: use [A-Z]{2} instead of .{2} to avoid matching garbage bytes
        self.pattern = re.compile(r'\((\d{12,15})([A-Z]{2})(\d{2})(.+?)\)')

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
                logger.error("TK103: Failed to decode ASCII")
                return None, len(data)

            if not text:
                return None, len(data)

            # FIX: search (not find) so we get the match position in original text,
            # allowing correct consumed calculation even with leading garbage bytes.
            match = self.pattern.search(text)

            if not match:
                # No complete message found
                if len(data) > 1024:
                    logger.warning("TK103: Buffer too large, resetting")
                    return None, len(data)
                # Check if there's a '(' without a closing ')' — wait for more data
                if '(' in text:
                    return None, 0
                return None, len(data)

            # FIX: consumed = position of end of match in original bytes
            consumed = len(text[:match.end()].encode('ascii'))

            imei    = match.group(1)
            command = match.group(2)
            payload = match.group(4)

            logger.debug(f"TK103: IMEI={imei}, CMD={command}")

            if command == 'BP':
                # Heartbeat
                response = f"({imei}AP05)".encode('ascii')
                return {"event": "heartbeat", "imei": imei, "response": response}, consumed

            elif command == 'BR':
                # Login / initial registration
                response = f"({imei}AP01HSO)".encode('ascii')
                return {"event": "login", "imei": imei, "response": response}, consumed

            elif command in ('BO', 'BV', 'BZ', 'BX', 'BN'):
                # Position reports (BO=normal, BV=speed alert, BZ=low batt,
                #                   BX=vibration, BN=SOS)
                position = self._parse_position(imei, payload, command)
                if position:
                    if command == 'BN':
                        position.sensors['alert_type'] = 'SOS'
                    return position, consumed

            else:
                logger.warning(f"TK103: Unknown command '{command}' from {imei}")

            return None, consumed

        except Exception as e:
            logger.error(f"TK103 decode error: {e}", exc_info=True)
            return None, len(data) if data else 1

    def _parse_position(
        self,
        imei: str,
        payload: str,
        command: str
    ) -> Optional[NormalizedPosition]:
        """
        Parse TK103 position payload.

        Format: DDMMYYAVVVVVVVVNVVVVVVVVVVEKKK.KHHMMSSAVVVVLLLLLLLL
          DDMMYY   date
          A/V      GPS validity
          DDMM.MMMM  latitude
          N/S
          DDDMM.MMMM longitude
          E/W
          KKK.K    speed (knots)
          HHMMSS   time
          A/V      GPS validity (again)
          VVVV     course
          LLLLLLLL flags
        """
        try:
            if len(payload) < 40:
                logger.warning(f"TK103: Payload too short ({len(payload)})")
                return None

            date_str    = payload[0:6]
            valid       = payload[6] == 'A'

            lat_str  = payload[7:16]    # DDMM.MMMM (9 chars)
            lat_dir  = payload[16]
            lon_str  = payload[17:27]   # DDDMM.MMMM (10 chars)
            lon_dir  = payload[27]

            speed_str = payload[28:33]  # KKK.K
            time_str  = payload[33:39]  # HHMMSS

            # second validity flag
            if len(payload) > 39:
                valid = valid and (payload[39] == 'A')

            course_str = payload[40:44] if len(payload) > 43 else '0000'

            latitude  = self._parse_coordinate(lat_str,  lat_dir)
            longitude = self._parse_coordinate(lon_str, lon_dir)

            if latitude is None or longitude is None:
                logger.warning(f"TK103: Invalid coordinates for {imei}")
                return None

            try:
                speed_kmh = float(speed_str) * 1.852
            except ValueError:
                speed_kmh = 0.0

            try:
                course = float(course_str)
            except ValueError:
                course = 0.0

            try:
                day   = int(date_str[0:2])
                month = int(date_str[2:4])
                year  = 2000 + int(date_str[4:6])
                hh    = int(time_str[0:2])
                mm    = int(time_str[2:4])
                ss    = int(time_str[4:6])
                device_time = datetime(year, month, day, hh, mm, ss, tzinfo=timezone.utc)
            except (ValueError, IndexError):
                device_time = datetime.now(timezone.utc)

            # Flags byte after course (if present)
            sensors: Dict[str, Any] = {'command': command}
            if len(payload) > 44:
                try:
                    flags = int(payload[44:52], 16)
                    sensors['flags']    = flags
                    sensors['ignition'] = bool(flags & 0x01)
                    sensors['door']     = bool(flags & 0x02)
                    sensors['shock']    = bool(flags & 0x04)
                except (ValueError, IndexError):
                    pass

            return NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=None,
                speed=speed_kmh,
                course=course,
                satellites=None,
                valid=valid,
                sensors=sensors,
            )

        except Exception as e:
            logger.error(f"TK103 position parse error: {e}", exc_info=True)
            return None

    def _parse_coordinate(self, coord_str: str, direction: str) -> Optional[float]:
        try:
            coord_str = coord_str.strip()
            dot_idx = coord_str.find('.')
            if dot_idx == -1:
                return None
            if direction in ('N', 'S'):
                degrees = int(coord_str[:dot_idx - 2])
                minutes = float(coord_str[dot_idx - 2:])
            else:
                degrees = int(coord_str[:dot_idx - 2])
                minutes = float(coord_str[dot_idx - 2:])
            decimal = degrees + minutes / 60.0
            if direction in ('S', 'W'):
                decimal = -decimal
            return decimal
        except Exception as e:
            logger.error(f"TK103 coordinate parse error: {e}")
            return None

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        imei = params.get('imei', '')
        if command_type == 'request_position':
            return f"({imei}AP10)".encode('ascii')
        elif command_type == 'reboot':
            return f"({imei}AP11)".encode('ascii')
        elif command_type == 'set_interval':
            interval = int(params.get('interval', 30))
            return f"({imei}AR00{interval:04d}0000)".encode('ascii')
        return b''

    def get_available_commands(self) -> list:
        return ['request_position', 'reboot', 'set_interval']

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        return {
            'request_position': {'description': 'Request immediate position update', 'params': {}},
            'reboot':           {'description': 'Reboot the device',                 'params': {}},
            'set_interval':     {'description': 'Set reporting interval (seconds)',   'params': {'interval': 'int'}},
        }.get(command_type, {'description': 'Unknown command', 'supported': False})
