"""
TK103 Protocol Decoder
Supports Coban TK103, Xexun, and many Chinese GPS tracker clones.

Port: 5001 (TCP)
Format: ASCII text-based protocol with parentheses delimiters

Examples:
  Heartbeat: (123456789012345BP05000)
  Login:     (000000000000000BR00240101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)
  Position:  (123456789012345BO00210101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)
  SOS:       (123456789012345BN00210101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)

Inbound command types (device → server):
  BP  — heartbeat / keepalive
  BR  — login / registration
  BO  — normal position report
  BV  — speed alarm position report
  BZ  — low battery alarm position report
  BX  — vibration / shock alarm position report
  BN  — SOS alarm position report

Outbound command types (server → device):
  AP05  — heartbeat ACK
  AP01  — login ACK
  AP10  — request immediate position
  AP11  — reboot device
  AR00  — set reporting interval
  AW00  — arm device
  AW01  — disarm device
  AV00  — relay cut (output on)
  AV01  — relay restore (output off)
"""
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union
import logging

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)


# Map inbound command codes to alert_type sensor values
_ALERT_MAP: Dict[str, str] = {
    'BV': 'overspeed',
    'BZ': 'low_battery',
    'BX': 'vibration',
    'BN': 'sos',
}


@ProtocolRegistry.register("tk103")
class TK103Decoder(BaseProtocolDecoder):
    """
    TK103 / Coban Protocol Decoder.
    Supports TK103, TK103B, TK103A, Xexun XT009, and compatible clones.
    """

    PORT = 5001
    PROTOCOL_TYPES = ['tcp']

    # ================================================================== #
    #  Command Registry                                                   #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'request_position': {
            'description': 'Request an immediate position update',
            'example': 'request_position',
            'requires_params': False,
            '_cmd': 'AP10',
        },
        'reboot': {
            'description': 'Reboot the device',
            'example': 'reboot',
            'requires_params': False,
            '_cmd': 'AP11',
        },
        'set_interval': {
            'description': 'Set GPS reporting interval (seconds)',
            'example': 'set_interval 30',
            'requires_params': True,
            '_cmd': None,   # built dynamically
        },
        'arm': {
            'description': 'Arm the device / enable alarm',
            'example': 'arm',
            'requires_params': False,
            '_cmd': 'AW00',
        },
        'disarm': {
            'description': 'Disarm the device / disable alarm',
            'example': 'disarm',
            'requires_params': False,
            '_cmd': 'AW01',
        },
        'set_output': {
            'description': 'Control relay / digital output. params: state=0|1',
            'example': 'set_output 1',
            'requires_params': True,
            '_cmd': None,
        },
        'custom': {
            'description': 'Send a raw TK103 command string, e.g. "AP10" or "AV00"',
            'example': 'AP10',
            'requires_params': True,
            '_cmd': None,
        },
    }

    def __init__(self):
        super().__init__()
        # Matches: ( <imei 12-15 digits> <2 uppercase letters> <2 digits> <payload> )
        self.pattern = re.compile(r'\((\d{12,15})([A-Z]{2})(\d{2})(.+?)\)')

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
                logger.error("TK103: Failed to decode ASCII")
                return None, len(data)

            if not text:
                return None, len(data)

            match = self.pattern.search(text)

            if not match:
                if len(data) > 1024:
                    logger.warning("TK103: Buffer too large, resetting")
                    return None, len(data)
                if '(' in text:
                    return None, 0
                return None, len(data)

            consumed = len(text[:match.end()].encode('ascii'))

            imei    = match.group(1)
            command = match.group(2)
            payload = match.group(4)

            logger.debug(f"TK103: IMEI={imei}, CMD={command}")

            # ── Heartbeat ─────────────────────────────────────────
            if command == 'BP':
                response = f"({imei}AP05)".encode('ascii')
                return {'event': 'heartbeat', 'imei': imei, 'response': response}, consumed

            # ── Login ─────────────────────────────────────────────
            elif command == 'BR':
                response = f"({imei}AP01HSO)".encode('ascii')
                return {'event': 'login', 'imei': imei, 'response': response}, consumed

            # ── Position reports ───────────────────────────────────
            elif command in ('BO', 'BV', 'BZ', 'BX', 'BN'):
                position = self._parse_position(imei, payload, command)
                if position:
                    alert = _ALERT_MAP.get(command)
                    if alert:
                        position.sensors['alert_type'] = alert
                    return position, consumed

            else:
                logger.warning(f"TK103: Unknown command '{command}' from {imei}")

            return None, consumed

        except Exception as e:
            logger.error(f"TK103 decode error: {e}", exc_info=True)
            return None, len(data) if data else 1

    # ================================================================== #
    #  Position parser                                                    #
    # ================================================================== #

    def _parse_position(
        self,
        imei: str,
        payload: str,
        command: str,
    ) -> Optional[NormalizedPosition]:
        """
        Parse TK103 position payload.

        Format (fixed-width ASCII):
          [0:6]   DDMMYY     date
          [6]     A/V        GPS validity
          [7:16]  DDMM.MMMM  latitude  (9 chars)
          [16]    N/S
          [17:27] DDDMM.MMMM longitude (10 chars)
          [27]    E/W
          [28:33] KKK.K      speed (knots)
          [33:39] HHMMSS     time
          [39]    A/V        GPS validity (repeated)
          [40:44] VVVV       course (degrees)
          [44:52] LLLLLLLL   flags (hex, optional)
        """
        try:
            if len(payload) < 40:
                logger.warning(f"TK103: Payload too short ({len(payload)}) for {imei}")
                return None

            date_str  = payload[0:6]
            valid     = payload[6] == 'A'
            lat_str   = payload[7:16]
            lat_dir   = payload[16]
            lon_str   = payload[17:27]
            lon_dir   = payload[27]
            speed_str = payload[28:33]
            time_str  = payload[33:39]

            if len(payload) > 39:
                valid = valid and (payload[39] == 'A')

            course_str = payload[40:44] if len(payload) > 43 else '0000'

            latitude  = self._parse_coordinate(lat_str, lat_dir)
            longitude = self._parse_coordinate(lon_str, lon_dir)

            if latitude is None or longitude is None:
                logger.warning(f"TK103: Invalid coordinates for {imei}")
                return None

            try:
                speed_kmh = float(speed_str) * 1.852   # knots → km/h
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

            sensors: Dict[str, Any] = {'packet_type': command}
            ignition: Optional[bool] = None

            # Flags (8 hex chars = 32 bits) at offset 44
            if len(payload) > 44:
                try:
                    flags = int(payload[44:52], 16)
                    sensors['flags']    = flags
                    ignition            = bool(flags & 0x01)
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
                altitude=0.0,       # TK103 protocol does not carry altitude
                speed=speed_kmh,
                course=course,
                satellites=None,    # TK103 protocol does not carry satellite count
                valid=valid,
                ignition=ignition,
                sensors=sensors,
                raw_data={'packet_type': command},
            )

        except Exception as e:
            logger.error(f"TK103 position parse error: {e}", exc_info=True)
            return None

    def _parse_coordinate(self, coord_str: str, direction: str) -> Optional[float]:
        try:
            coord_str = coord_str.strip()
            dot_idx   = coord_str.find('.')
            if dot_idx == -1:
                return None
            degrees = int(coord_str[:dot_idx - 2])
            minutes = float(coord_str[dot_idx - 2:])
            decimal = degrees + minutes / 60.0
            if direction in ('S', 'W'):
                decimal = -decimal
            return decimal
        except Exception as e:
            logger.error(f"TK103 coordinate parse error: {e}")
            return None

    # ================================================================== #
    #  Command encoding                                                   #
    # ================================================================== #

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}

        # TK103 wraps commands as (<imei><cmd>) — IMEI must be passed in params
        imei = params.get('imei', '').strip()
        if not imei:
            logger.warning("TK103: encode_command called without 'imei' in params")
            return b''

        cmd_key = command_type.lower()

        # ── Custom raw command string ──────────────────────────────
        if cmd_key == 'custom':
            raw = params.get('payload', '').strip()
            if not raw:
                return b''
            return self._frame(imei, raw)

        # ── set_interval: AR00<interval padded to 4 digits>0000 ───
        if cmd_key == 'set_interval':
            try:
                interval = int(params.get('interval', params.get('payload', 30)))
            except (ValueError, TypeError):
                interval = 30
            return self._frame(imei, f'AR00{interval:04d}0000')

        # ── set_output: relay control ──────────────────────────────
        if cmd_key == 'set_output':
            try:
                state = int(params.get('state', params.get('payload', 0)))
            except (ValueError, TypeError):
                state = 0
            # AV00 = cut / activate output, AV01 = restore / deactivate
            return self._frame(imei, 'AV00' if state else 'AV01')

        # ── Registry-based static commands ─────────────────────────
        cmd_info = self.COMMAND_REGISTRY.get(cmd_key)
        if cmd_info and cmd_info.get('_cmd'):
            return self._frame(imei, cmd_info['_cmd'])

        logger.warning(f"TK103: Unknown or unimplemented command: {command_type!r}")
        return b''

    def _frame(self, imei: str, cmd: str) -> bytes:
        """Wrap a command in the TK103 parenthesis frame: (<imei><cmd>)"""
        return f'({imei}{cmd})'.encode('ascii')

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
