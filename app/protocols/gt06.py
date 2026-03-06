import struct
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union, List
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)


@ProtocolRegistry.register("gt06")
class GT06Decoder(BaseProtocolDecoder):
    """
    GT06 / Concox Protocol Decoder
    Supports GT06, GT06N, GT06E, Concox, JimiIoT, and compatible Chinese GPS tracker clones.

    Port: 5023 (TCP)
    Format: Binary protocol with 0x7878 (short) or 0x7979 (long) start markers

    Supported packet types:
      0x01  — Login (IMEI registration)
      0x12  — GPS position
      0x13  — Heartbeat / status
      0x16  — GPS + LBS combined (includes altitude)
      0x1A  — GPS + LBS + status combined (includes altitude)
      0x19  — Server command response (ACK)
      0x80  — Server command (outbound)
    """

    PORT = 5023
    PROTOCOL_TYPES = ['tcp']

    # ================================================================== #
    #  Command Registry                                                   #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'reboot': {
            'description': 'Reboot / reset the device',
            'example': 'reboot',
            'requires_params': False,
            '_payload': b'\x01',
        },
        'get_info': {
            'description': 'Request device status / info report',
            'example': 'get_info',
            'requires_params': False,
            '_payload': b'\x02',
        },
        'set_interval': {
            'description': 'Set GPS reporting interval (seconds)',
            'example': 'set_interval 30',
            'requires_params': True,
            '_payload': None,   # built dynamically
        },
        'request_position': {
            'description': 'Request an immediate position update',
            'example': 'request_position',
            'requires_params': False,
            '_payload': b'\x03',
        },
        'set_output': {
            'description': 'Control digital output (relay). params: output=1, state=0|1',
            'example': 'set_output 1 1',
            'requires_params': True,
            '_payload': None,
        },
        'custom': {
            'description': 'Send a raw hex command payload to the device',
            'example': '010203',
            'requires_params': True,
            '_payload': None,
        },
    }

    # ================================================================== #
    #  Decode                                                             #
    # ================================================================== #

    async def decode(
        self,
        data: bytes,
        client_info: Dict[str, Any],
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            if len(data) < 5:
                return None, 0
            if data[0:2] not in (b'\x78\x78', b'\x79\x79'):
                return None, 1

            start_bit = data[0:2]
            if start_bit == b'\x78\x78':
                content_len = data[2]
                total_len   = content_len + 5
                offset      = 3
            else:
                if len(data) < 6:
                    return None, 0
                content_len = struct.unpack('>H', data[2:4])[0]
                total_len   = content_len + 6
                offset      = 4

            if len(data) < total_len:
                return None, 0

            packet          = data[:total_len]
            consumed        = total_len
            protocol_number = packet[offset]

            # ── Login ─────────────────────────────────────────────────
            if protocol_number == 0x01:
                imei   = self._parse_imei(packet[offset + 1:offset + 9])
                serial = packet[offset + 9:offset + 11]
                resp   = b'\x78\x78\x05\x01' + serial
                crc    = self._crc_16(resp[2:])
                resp  += struct.pack('>H', crc) + b'\x0D\x0A'
                return {'event': 'login', 'imei': imei, 'response': resp}, consumed

            # ── GPS position packets ───────────────────────────────────
            if protocol_number in (0x12, 0x16, 0x1A):
                pos = self._parse_position(packet, offset, protocol_number, known_imei)
                return pos, consumed

            # ── Heartbeat ─────────────────────────────────────────────
            if protocol_number == 0x13:
                serial = packet[offset + 1:offset + 3]
                resp   = b'\x78\x78\x05\x13' + serial
                crc    = self._crc_16(resp[2:])
                resp  += struct.pack('>H', crc) + b'\x0D\x0A'
                return {'event': 'heartbeat', 'response': resp}, consumed

            # ── Server command ACK ─────────────────────────────────────
            if protocol_number == 0x19:
                logger.debug(f"GT06: Command ACK received from {known_imei}")
                return {'event': 'command_ack'}, consumed

            logger.debug(f"GT06: Unhandled protocol 0x{protocol_number:02X}")
            return None, consumed

        except Exception as e:
            logger.error(f"GT06 decode error: {e}", exc_info=True)
            return None, len(data)

    # ================================================================== #
    #  Position parser                                                    #
    # ================================================================== #

    def _parse_position(
        self,
        data: bytes,
        offset: int,
        protocol_number: int,
        known_imei: Optional[str],
    ) -> Optional[NormalizedPosition]:
        try:
            if not known_imei:
                return None

            date_offset = offset + 1
            year   = 2000 + data[date_offset]
            month  = data[date_offset + 1]
            day    = data[date_offset + 2]
            hour   = data[date_offset + 3]
            minute = data[date_offset + 4]
            second = data[date_offset + 5]
            device_time = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)

            gps_offset = date_offset + 6

            # sat_acc byte: upper nibble = satellites, lower nibble = GPS accuracy
            sat_acc    = data[gps_offset]
            satellites = (sat_acc >> 4) & 0x0F

            # Course/status word (16 bits):
            #   bits [9:0]  = course (0-360)
            #   bit  10     = latitude  hemisphere (0=N, 1=S)
            #   bit  11     = longitude hemisphere (0=E, 1=W)
            #   bit  12     = GPS positioned       (1=valid fix)
            #   bit  13     = GPS real-time
            #   bit  14     = ACC / ignition        (1=on)
            #   bit  15     = reserved
            course_status = struct.unpack('>H', data[gps_offset + 1:gps_offset + 3])[0]
            course    = float(course_status & 0x03FF)
            lat_south = bool(course_status & 0x0400)
            lon_west  = bool(course_status & 0x0800)
            gps_valid = bool(course_status & 0x1000)
            ignition  = bool(course_status & 0x4000)

            lat_raw   = struct.unpack('>I', data[gps_offset + 3:gps_offset + 7])[0]
            latitude  = lat_raw / 1_800_000.0
            lon_raw   = struct.unpack('>I', data[gps_offset + 7:gps_offset + 11])[0]
            longitude = lon_raw / 1_800_000.0

            if lat_south:
                latitude  = -latitude
            if lon_west:
                longitude = -longitude

            speed = float(data[gps_offset + 11])  # km/h

            # ── Altitude ──────────────────────────────────────────────
            # Present in 0x16 / 0x1A extended packets (2 bytes signed, metres)
            # immediately after the 12-byte base GPS block.
            # Protocol 0x12 does not carry altitude; default to 0.
            altitude = 0.0
            if protocol_number in (0x16, 0x1A):
                alt_offset = gps_offset + 12
                if alt_offset + 2 <= len(data):
                    altitude = float(struct.unpack('>h', data[alt_offset:alt_offset + 2])[0])

            sensors: Dict[str, Any] = {
                'status_raw':   course_status,
                'acc':          ignition,
                'gps_tracking': gps_valid,
                'alarm':        bool(course_status & 0x0038),
            }

            # Alarm sub-type (bits 3-5 of course_status)
            alarm_bits = (course_status >> 3) & 0x07
            if alarm_bits:
                alarm_map = {
                    1: 'sos',
                    2: 'power_cut',
                    3: 'vibration',
                    4: 'fence_in',
                    5: 'fence_out',
                    6: 'overspeed',
                }
                sensors['alarm_type'] = alarm_map.get(alarm_bits, f'unknown_{alarm_bits}')

            return NormalizedPosition(
                imei=known_imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed,
                course=course,
                satellites=satellites,
                valid=gps_valid,
                ignition=ignition,
                sensors=sensors,
                raw_data={'protocol': f'0x{protocol_number:02X}'},
            )

        except Exception as e:
            logger.error(f"GT06 position parse error: {e}", exc_info=True)
            return None

    # ================================================================== #
    #  Command encoding                                                   #
    # ================================================================== #

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}

        cmd_key = command_type.lower()

        # ── Custom raw hex payload ─────────────────────────────────────
        if cmd_key == 'custom':
            raw = params.get('payload', '').strip().replace(' ', '')
            if not raw:
                return b''
            try:
                payload = bytes.fromhex(raw)
            except ValueError:
                logger.error(f"GT06: Invalid hex payload: {raw!r}")
                return b''
            return self._build_server_command(payload)

        # ── set_interval: 2-byte big-endian interval ───────────────────
        if cmd_key == 'set_interval':
            try:
                interval = int(params.get('interval', params.get('payload', 30)))
            except (ValueError, TypeError):
                interval = 30
            payload = b'\x05' + struct.pack('>H', interval)
            return self._build_server_command(payload)

        # ── set_output: relay / digital output control ─────────────────
        if cmd_key == 'set_output':
            try:
                output = int(params.get('output', 1))
                state  = int(params.get('state', params.get('payload', 0)))
            except (ValueError, TypeError):
                output, state = 1, 0
            payload = b'\x04' + bytes([output & 0xFF, state & 0xFF])
            return self._build_server_command(payload)

        # ── Registry-based static-payload commands ─────────────────────
        cmd_info = self.COMMAND_REGISTRY.get(cmd_key)
        if cmd_info and cmd_info.get('_payload'):
            return self._build_server_command(cmd_info['_payload'])

        logger.warning(f"GT06: Unknown or unimplemented command: {command_type!r}")
        return b''

    def _build_server_command(self, payload: bytes) -> bytes:
        """
        Frame a server→device command packet (protocol number 0x80).

        Packet layout:
          0x78 0x78            start marker (short frame)
          content_len (1 B)
          0x80                 protocol number
          0x00 0x00 0x00 0x01  server flag
          <payload>
          serial (2 B)         = 0x00 0x01
          crc    (2 B)
          0x0D 0x0A
        """
        server_flag = b'\x00\x00\x00\x01'
        serial      = b'\x00\x01'
        inner       = b'\x80' + server_flag + payload + serial
        crc         = self._crc_16(inner)
        content_len = len(inner)
        return (
            b'\x78\x78'
            + bytes([content_len])
            + inner
            + struct.pack('>H', crc)
            + b'\x0D\x0A'
        )

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

    def _parse_imei(self, imei_bytes: bytes) -> str:
        return str(int(imei_bytes.hex(), 16))

    def _crc_16(self, data: bytes) -> int:
        crc = 0xFFFF
        for byte in data:
            crc ^= (byte << 8)
            for _ in range(8):
                if crc & 0x8000:
                    crc = (crc << 1) ^ 0x1021
                else:
                    crc <<= 1
            crc &= 0xFFFF
        return crc
