"""
H02 Protocol Decoder
Supports H02 and compatible Chinese GPS tracker protocol
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
from typing import Any, Dict, Optional, Tuple, Union

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
        dot = value.index('.')
        # Degrees are all digits before the last two pre-decimal digits
        deg = float(value[:dot - 2])
        mins = float(value[dot - 2:])
        result = deg + mins / 60.0
        if hemi.upper() in ('S', 'W'):
            result = -result
        return result
    except (ValueError, IndexError):
        logger.warning(f"H02: Could not parse coordinate '{value}' '{hemi}'")
        return None


def _parse_time(time_str: str, date_str: str) -> Optional[datetime]:
    """
    Parse H02 time (HHMMSS) and date (DDMMYY) into a UTC datetime.
    Returns None on failure.
    """
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
    Bit meanings vary slightly by firmware but bit 0 is ACC/ignition on most devices.
    """
    sensors: Dict[str, Any] = {}
    try:
        flags = int(flags_hex, 16)
        sensors['ignition'] = bool(flags & 0x01)   # ACC / ignition
        sensors['charging'] = bool(flags & 0x02)
        sensors['alarm_active'] = bool(flags & 0x04)
        sensors['gps_signal_ok'] = bool(flags & 0x08)
        sensors['flags_raw'] = flags_hex
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

    # Regex to find a complete H02 message: *HQ,...# with optional \r\n
    _MSG_RE = re.compile(r'\*HQ,([^#]+)#', re.ASCII)

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
            # No complete message yet — wait if buffer is small, reset if huge
            if len(data) > 2048:
                logger.warning("H02: Buffer overflow, resetting")
                return None, len(data)
            return None, 0

        # consumed = everything up to and including the closing '#'
        consumed = match.end()
        payload = match.group(1)  # everything between *HQ, and #
        parts = payload.split(',')

        if len(parts) < 2:
            logger.warning(f"H02: Too few fields: {payload[:60]}")
            return None, consumed

        imei = parts[0].strip()
        msg_type = parts[1].strip().upper()

        # ── Heartbeat ────────────────────────────────────────────
        if msg_type == 'HTBT':
            sensors: Dict[str, Any] = {}
            if len(parts) > 2:
                try:
                    sensors['battery_voltage'] = float(parts[2])
                except ValueError:
                    pass
            logger.debug(f"H02: Heartbeat from {imei}")
            # Respond with *HQ,<imei>,R12# to acknowledge
            response = f"*HQ,{imei},R12#\r\n".encode('ascii')
            return {"imei": imei, "response": response}, consumed

        # ── Standard GPS position: V1 / V4 ───────────────────────
        if msg_type in ('V1', 'V4'):
            return self._parse_v1(parts, imei, consumed)

        # ── Cell-tower (LBS) position: NBR ───────────────────────
        if msg_type == 'NBR':
            return self._parse_nbr(parts, imei, consumed)

        # ── Link / status report ──────────────────────────────────
        if msg_type == 'LINK':
            return self._parse_link(parts, imei, consumed)

        logger.debug(f"H02: Unhandled message type '{msg_type}' from {imei}")
        return None, consumed

    # ------------------------------------------------------------------
    # Message-type parsers
    # ------------------------------------------------------------------

    def _parse_v1(
        self,
        parts: list,
        imei: str,
        consumed: int,
    ) -> Tuple[Optional[NormalizedPosition], int]:
        """
        V1 / V4 GPS position report.

        Layout (0-indexed parts after splitting on comma):
          0  IMEI
          1  V1
          2  HHMMSS       time
          3  A/V           GPS validity
          4  DDMM.MMMM    latitude
          5  N/S
          6  DDDMM.MMMM   longitude
          7  E/W
          8  speed (knots)
          9  course (degrees)
          10 DDMMYY        date
          11 flags (hex)
          12 IO status (hex, optional)
          13 battery voltage (optional)
          14 signal (optional)
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

        latitude  = _parse_coord(lat_str, lat_hemi)
        longitude = _parse_coord(lon_str, lon_hemi)

        if latitude is None or longitude is None:
            logger.warning(f"H02 V1: Bad coordinates for {imei}")
            return None, consumed

        try:
            speed_kmh = float(parts[8]) * 1.852  # knots → km/h
        except (ValueError, IndexError):
            speed_kmh = 0.0

        try:
            course = float(parts[9])
        except (ValueError, IndexError):
            course = 0.0

        # Flags / status
        sensors: Dict[str, Any] = {}
        ignition: Optional[bool] = None
        if len(parts) > 11 and parts[11].strip():
            sensors = _parse_flags(parts[11].strip())
            ignition = sensors.pop('ignition', None)

        # IO status byte
        if len(parts) > 12 and parts[12].strip():
            try:
                sensors['io_status'] = int(parts[12].strip(), 16)
            except ValueError:
                pass

        # Battery voltage
        if len(parts) > 13 and parts[13].strip():
            try:
                sensors['battery_voltage'] = float(parts[13].strip())
            except ValueError:
                pass

        # Signal
        if len(parts) > 14 and parts[14].strip():
            try:
                sensors['gsm_signal'] = int(parts[14].strip())
            except ValueError:
                pass

        valid = (valid_chr == 'A')
        if not valid:
            logger.debug(f"H02 V1: Invalid GPS fix (V) for {imei}, storing anyway")

        position = NormalizedPosition(
            imei=imei,
            device_time=device_time,
            server_time=datetime.now(timezone.utc),
            latitude=latitude,
            longitude=longitude,
            speed=speed_kmh,
            course=course,
            valid=valid,
            ignition=ignition,
            sensors=sensors,
        )
        logger.debug(f"H02 V1: {imei} @ {latitude},{longitude} valid={valid}")
        return position, consumed

    def _parse_nbr(
        self,
        parts: list,
        imei: str,
        consumed: int,
    ) -> Tuple[Optional[Dict[str, Any]], int]:
        """
        NBR — network-based (cell tower / LBS) location report.
        No GPS coordinates; stores cell info in sensors only.

        Layout:
          0  IMEI
          1  NBR
          2  HHMMSS
          3  MCC
          4  MNC
          5  (LAC,CID,signal|LAC,CID,signal|...)  — parenthesised group
          ... battery voltage, signal, DDMMYY may follow
        """
        sensors: Dict[str, Any] = {'message_type': 'NBR'}

        if len(parts) > 2:
            sensors['mcc'] = parts[2].strip() if len(parts) > 3 else ''
            sensors['mnc'] = parts[3].strip() if len(parts) > 4 else ''

        # The cell list may be wrapped in parentheses and span several comma-
        # separated fields; just store it as-is for now.
        raw_cells = ','.join(parts[5:]).strip().strip('()')
        sensors['cell_info'] = raw_cells

        logger.debug(f"H02 NBR: Cell location from {imei}")
        # Return as a plain dict — no GPS position to store
        return {"imei": imei, "sensors": sensors}, consumed

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
                sensors['satellites']   = int(parts[3].strip())
            if len(parts) > 4:
                sensors['gsm_signal']   = int(parts[4].strip())
            if len(parts) > 5:
                sensors['battery_pct']  = int(parts[5].strip())
            if len(parts) > 6 and parts[6].strip():
                sensors['steps']        = int(parts[6].strip())
            if len(parts) > 7 and parts[7].strip():
                sensors['rolls']        = int(parts[7].strip())
        except (ValueError, IndexError):
            pass

        logger.debug(f"H02 LINK: Status from {imei}")
        return {"imei": imei, "sensors": sensors}, consumed

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        imei = params.get('imei', '')
        if not imei:
            logger.warning("H02: IMEI required for commands")
            return b''

        if command_type == 'reboot':
            cmd = f"*HQ,{imei},D1#\r\n"
        elif command_type == 'request_position':
            cmd = f"*HQ,{imei},R0#\r\n"
        elif command_type == 'set_interval':
            interval = int(params.get('interval', 30))
            cmd = f"*HQ,{imei},S20,{interval:04d}#\r\n"
        elif command_type == 'set_apn':
            apn = params.get('apn', 'internet')
            cmd = f"*HQ,{imei},S1,{apn}#\r\n"
        else:
            logger.warning(f"H02: Unknown command '{command_type}'")
            return b''

        return cmd.encode('ascii')

    def get_available_commands(self) -> list:
        return ['reboot', 'request_position', 'set_interval', 'set_apn']

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        info = {
            'reboot':           {'description': 'Reboot the device',                   'params': {}},
            'request_position': {'description': 'Request an immediate position update', 'params': {}},
            'set_interval':     {'description': 'Set reporting interval (seconds)',     'params': {'interval': 'int'}},
            'set_apn':          {'description': 'Set GPRS APN',                        'params': {'apn': 'str'}},
        }
        return info.get(command_type, {'description': 'Unknown command', 'supported': False})
