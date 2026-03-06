"""
H02 Protocol Decoder
Supports H02 and compatible Chinese GPS tracker protocol.
Used by devices branded as H02, H08, H12, and many OEM clones.

Protocol reference:
  *HQ,<IMEI>,V1,<time>,<valid>,<lat>,<N/S>,<lon>,<E/W>,<speed>,<course>,<date>,<flags>,<io>,<volt>,<signal>#
  *HQ,<IMEI>,NBR,<time>,<mcc>,<mnc>,(<lac>,<cid>,<signal>,...),<volt>,<signal>,<date>#  (LBS/cell)
  *HQ,<IMEI>,HTBT,<volt>#   (heartbeat)
  *HQ,<IMEI>,LINK,<time>,<sat>,<rssi>,<bat%>,<steps>,<rolls>,<date>#  (link/status)
"""
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union

from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)


def _parse_coord(value: str, hemi: str) -> Optional[float]:
    """
    Convert DDMM.MMMM / DDDMM.MMMM + hemisphere to decimal degrees.
    Returns None if the input is empty or unparseable.
    """
    value = value.strip()
    if not value:
        return None
    try:
        dot  = value.index('.')
        deg  = float(value[:dot - 2])
        mins = float(value[dot - 2:])
        result = deg + mins / 60.0
        if hemi.upper() in ('S', 'W'):
            result = -result
        return result
    except (ValueError, IndexError):
        logger.warning(f"H02: Could not parse coordinate '{value}' '{hemi}'")
        return None


def _parse_time(time_str: str, date_str: str) -> Optional[datetime]:
    """Parse H02 time (HHMMSS) and date (DDMMYY) into a UTC datetime."""
    try:
        hh = int(time_str[0:2])
        mm = int(time_str[2:4])
        ss = int(time_str[4:6])
        dd = int(date_str[0:2])
        mo = int(date_str[2:4])
        yy = int(date_str[4:6])
        return datetime(2000 + yy, mo, dd, hh, mm, ss, tzinfo=timezone.utc)
    except (ValueError, IndexError):
        logger.warning(f"H02: Could not parse time '{time_str}' date '{date_str}'")
        return None


def _parse_flags(flags_hex: str) -> Dict[str, Any]:
    """
    Parse the H02 status/flags field (hex string).
    Bit 0 = ACC/ignition, bit 1 = charging, bit 2 = alarm, bit 3 = GPS signal OK.
    """
    sensors: Dict[str, Any] = {}
    try:
        flags = int(flags_hex, 16)
        sensors['ignition']      = bool(flags & 0x01)
        sensors['charging']      = bool(flags & 0x02)
        sensors['alarm_active']  = bool(flags & 0x04)
        sensors['gps_signal_ok'] = bool(flags & 0x08)
        sensors['flags_raw']     = flags_hex
    except (ValueError, TypeError):
        pass
    return sensors


@ProtocolRegistry.register("h02")
class H02Decoder(BaseProtocolDecoder):
    """
    H02 Protocol Decoder

    H02 is a widely-used ASCII protocol from Chinese GPS tracker manufacturers.
    Messages are framed as:  *HQ,<fields...>#

    Supported message types:
      V1   — standard GPS position report
      V4   — alternative position report (same layout as V1)
      NBR  — cell-tower / LBS position (no GPS)
      HTBT — heartbeat / keepalive
      LINK — device status / link report
    """

    PORT = 5013
    PROTOCOL_TYPES = ['tcp']

    # Regex to find a complete H02 message: *HQ,...#
    _MSG_RE = re.compile(r'\*HQ,([^#]+)#', re.ASCII)

    # ================================================================== #
    #  Command Registry                                                   #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'reboot': {
            'description': 'Reboot the device',
            'example': 'reboot',
            'requires_params': False,
            '_cmd': 'D1',
        },
        'request_position': {
            'description': 'Request an immediate position update',
            'example': 'request_position',
            'requires_params': False,
            '_cmd': 'R0',
        },
        'set_interval': {
            'description': 'Set GPS reporting interval (seconds)',
            'example': 'set_interval 30',
            'requires_params': True,
            '_cmd': None,   # built dynamically
        },
        'set_apn': {
            'description': 'Set the GPRS APN',
            'example': 'set_apn internet',
            'requires_params': True,
            '_cmd': None,
        },
        'arm': {
            'description': 'Arm the device / enable alarm',
            'example': 'arm',
            'requires_params': False,
            '_cmd': 'SCF,0,1',
        },
        'disarm': {
            'description': 'Disarm the device / disable alarm',
            'example': 'disarm',
            'requires_params': False,
            '_cmd': 'SCF,0,0',
        },
        'set_output': {
            'description': 'Set digital output / relay. params: state=0|1',
            'example': 'set_output 1',
            'requires_params': True,
            '_cmd': None,
        },
        'custom': {
            'description': 'Send a raw H02 command string, e.g. "R1" or "S20,0030"',
            'example': 'R1',
            'requires_params': True,
            '_cmd': None,
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

        if not data:
            return None, 0

        try:
            text = data.decode('ascii', errors='ignore')
        except Exception:
            return None, len(data)

        match = self._MSG_RE.search(text)
        if not match:
            if len(data) > 2048:
                logger.warning("H02: Buffer overflow, resetting")
                return None, len(data)
            return None, 0

        consumed = match.end()
        payload  = match.group(1)
        parts    = payload.split(',')

        if len(parts) < 2:
            logger.warning(f"H02: Too few fields: {payload[:60]}")
            return None, consumed

        imei     = parts[0].strip()
        msg_type = parts[1].strip().upper()

        # ── Heartbeat ─────────────────────────────────────────────
        if msg_type == 'HTBT':
            sensors: Dict[str, Any] = {}
            if len(parts) > 2:
                try:
                    sensors['battery_voltage'] = float(parts[2])
                except ValueError:
                    pass
            response = f"*HQ,{imei},R12#\r\n".encode('ascii')
            return {'imei': imei, 'response': response, 'sensors': sensors}, consumed

        # ── Standard GPS position: V1 / V4 ────────────────────────
        if msg_type in ('V1', 'V4'):
            return self._parse_v1(parts, imei, consumed, msg_type)

        # ── Cell-tower (LBS) position: NBR ────────────────────────
        if msg_type == 'NBR':
            return self._parse_nbr(parts, imei, consumed)

        # ── Link / status report ───────────────────────────────────
        if msg_type == 'LINK':
            return self._parse_link(parts, imei, consumed)

        logger.debug(f"H02: Unhandled message type '{msg_type}' from {imei}")
        return None, consumed

    # ================================================================== #
    #  Message-type parsers                                               #
    # ================================================================== #

    def _parse_v1(
        self,
        parts: list,
        imei: str,
        consumed: int,
        msg_type: str = 'V1',
    ) -> Tuple[Optional[NormalizedPosition], int]:
        """
        V1 / V4 GPS position report.

        Field layout (0-indexed after splitting on comma):
          0  IMEI
          1  V1
          2  HHMMSS        time
          3  A/V            GPS validity
          4  DDMM.MMMM     latitude
          5  N/S
          6  DDDMM.MMMM    longitude
          7  E/W
          8  speed (knots)
          9  course (degrees)
          10 DDMMYY         date
          11 flags (hex)
          12 IO status (hex, optional)
          13 battery voltage (optional)
          14 GSM signal (optional)
          15 altitude in metres (optional, some firmware variants)
        """
        if len(parts) < 11:
            logger.warning(f"H02 V1: Too few fields ({len(parts)}) for {imei}")
            return None, consumed

        time_str  = parts[2].strip()
        valid_chr = parts[3].strip().upper()
        lat_str   = parts[4].strip()
        lat_hemi  = parts[5].strip()
        lon_str   = parts[6].strip()
        lon_hemi  = parts[7].strip()
        date_str  = parts[10].strip()

        device_time = _parse_time(time_str, date_str) or datetime.now(timezone.utc)
        latitude    = _parse_coord(lat_str,  lat_hemi)
        longitude   = _parse_coord(lon_str,  lon_hemi)

        if latitude is None or longitude is None:
            logger.warning(f"H02 V1: Bad coordinates for {imei}")
            return None, consumed

        try:
            speed_kmh = float(parts[8]) * 1.852   # knots → km/h
        except (ValueError, IndexError):
            speed_kmh = 0.0

        try:
            course = float(parts[9])
        except (ValueError, IndexError):
            course = 0.0

        sensors:  Dict[str, Any] = {}
        ignition: Optional[bool] = None

        # Flags / status (field 11)
        if len(parts) > 11 and parts[11].strip():
            sensors  = _parse_flags(parts[11].strip())
            ignition = sensors.pop('ignition', None)

        # IO status byte (field 12)
        if len(parts) > 12 and parts[12].strip():
            try:
                sensors['io_status'] = int(parts[12].strip(), 16)
            except ValueError:
                pass

        # Battery voltage (field 13)
        if len(parts) > 13 and parts[13].strip():
            try:
                sensors['battery_voltage'] = float(parts[13].strip())
            except ValueError:
                pass

        # GSM signal (field 14)
        if len(parts) > 14 and parts[14].strip():
            try:
                sensors['gsm_signal'] = int(parts[14].strip())
            except ValueError:
                pass

        # Altitude in metres (field 15 — present in some firmware variants)
        altitude = 0.0
        if len(parts) > 15 and parts[15].strip():
            try:
                altitude = float(parts[15].strip())
            except ValueError:
                pass

        valid = (valid_chr == 'A')
        if not valid:
            logger.debug(f"H02 V1: Invalid GPS fix (V) for {imei}, storing anyway")

        return NormalizedPosition(
            imei=imei,
            device_time=device_time,
            server_time=datetime.now(timezone.utc),
            latitude=latitude,
            longitude=longitude,
            altitude=altitude,
            speed=speed_kmh,
            course=course,
            valid=valid,
            ignition=ignition,
            sensors=sensors,
            raw_data={'message_type': msg_type},
        ), consumed

    def _parse_nbr(
        self,
        parts: list,
        imei: str,
        consumed: int,
    ) -> Tuple[Optional[Dict[str, Any]], int]:
        """
        NBR — network-based (cell tower / LBS) location report.
        No GPS coordinates; stores cell info in sensors only.
        """
        sensors: Dict[str, Any] = {'message_type': 'NBR'}

        if len(parts) > 3:
            sensors['mcc'] = parts[3].strip()
        if len(parts) > 4:
            sensors['mnc'] = parts[4].strip()
        if len(parts) > 5:
            sensors['cell_info'] = ','.join(parts[5:]).strip().strip('()')

        logger.debug(f"H02 NBR: Cell location from {imei}")
        return {'imei': imei, 'sensors': sensors, 'raw_data': {'message_type': 'NBR'}}, consumed

    def _parse_link(
        self,
        parts: list,
        imei: str,
        consumed: int,
    ) -> Tuple[Optional[Dict[str, Any]], int]:
        """
        LINK — device status / link report.

        Layout:
          0  IMEI
          1  LINK
          2  HHMMSS
          3  satellites
          4  GSM signal
          5  battery %
          6  steps (pedometer, optional)
          7  rolls (optional)
          8  DDMMYY
        """
        sensors: Dict[str, Any] = {'message_type': 'LINK'}

        try:
            if len(parts) > 3:
                sensors['satellites']  = int(parts[3].strip())
            if len(parts) > 4:
                sensors['gsm_signal']  = int(parts[4].strip())
            if len(parts) > 5:
                sensors['battery_pct'] = int(parts[5].strip())
            if len(parts) > 6 and parts[6].strip():
                sensors['steps']       = int(parts[6].strip())
            if len(parts) > 7 and parts[7].strip():
                sensors['rolls']       = int(parts[7].strip())
        except (ValueError, IndexError):
            pass

        logger.debug(f"H02 LINK: Status from {imei}")
        return {'imei': imei, 'sensors': sensors, 'raw_data': {'message_type': 'LINK'}}, consumed

    # ================================================================== #
    #  Command encoding                                                   #
    # ================================================================== #

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}

        # H02 embeds the IMEI in the command frame itself, so it must be
        # passed in params by the caller (pulled from the device session).
        imei = params.get('imei', '').strip()
        if not imei:
            logger.warning("H02: encode_command called without 'imei' in params")
            return b''

        cmd_key = command_type.lower()

        # ── Custom raw command string ──────────────────────────────
        if cmd_key == 'custom':
            raw = params.get('payload', '').strip()
            if not raw:
                return b''
            return self._frame(imei, raw)

        # ── set_interval ───────────────────────────────────────────
        if cmd_key == 'set_interval':
            try:
                interval = int(params.get('interval', params.get('payload', 30)))
            except (ValueError, TypeError):
                interval = 30
            return self._frame(imei, f'S20,{interval:04d}')

        # ── set_apn ────────────────────────────────────────────────
        if cmd_key == 'set_apn':
            apn = str(params.get('apn', params.get('payload', 'internet'))).strip()
            return self._frame(imei, f'S1,{apn}')

        # ── set_output (relay control) ─────────────────────────────
        if cmd_key == 'set_output':
            try:
                state = int(params.get('state', params.get('payload', 0)))
            except (ValueError, TypeError):
                state = 0
            # S36 = cut engine/output ON, S37 = restore/output OFF
            return self._frame(imei, 'S36' if state else 'S37')

        # ── Registry-based static commands ─────────────────────────
        cmd_info = self.COMMAND_REGISTRY.get(cmd_key)
        if cmd_info and cmd_info.get('_cmd'):
            return self._frame(imei, cmd_info['_cmd'])

        logger.warning(f"H02: Unknown or unimplemented command: {command_type!r}")
        return b''

    def _frame(self, imei: str, cmd: str) -> bytes:
        """Build a complete *HQ,<imei>,<cmd># message."""
        return f'*HQ,{imei},{cmd}#\r\n'.encode('ascii')

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
