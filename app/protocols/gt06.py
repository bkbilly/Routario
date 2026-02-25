import struct
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("gt06")
class GT06Decoder(BaseProtocolDecoder):
    PORT = 5023
    PROTOCOL_TYPES = ['tcp']

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
                total_len = content_len + 5
            else:
                if len(data) < 6:
                    return None, 0
                content_len = struct.unpack('>H', data[2:4])[0]
                total_len = content_len + 6

            if len(data) < total_len:
                return None, 0

            packet = data[:total_len]
            consumed = total_len
            offset = 3 if start_bit == b'\x78\x78' else 4
            protocol_number = packet[offset]

            # Login packet
            if protocol_number == 0x01:
                imei = self._parse_imei(packet[offset + 1:offset + 9])
                serial = packet[offset + 9:offset + 11]
                resp = b'\x78\x78\x05\x01' + serial
                crc = self._crc_16(resp[2:])
                resp += struct.pack('>H', crc) + b'\x0D\x0A'
                return {"event": "login", "imei": imei, "response": resp}, consumed

            # GPS position packets
            if protocol_number in [0x12, 0x16, 0x1A]:
                pos = self._parse_position(packet, offset, known_imei)
                return pos, consumed

            # Heartbeat
            if protocol_number == 0x13:
                serial = packet[offset + 1:offset + 3]
                resp = b'\x78\x78\x05\x13' + serial
                crc = self._crc_16(resp[2:])
                resp += struct.pack('>H', crc) + b'\x0D\x0A'
                return {"event": "heartbeat", "response": resp}, consumed

            return None, consumed

        except Exception as e:
            logger.error(f"GT06 Decode error: {e}")
            return None, len(data)

    def _parse_position(
        self,
        data: bytes,
        offset: int,
        known_imei: Optional[str]
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

            # Status word: 16 bits
            # bits [9:0]  = course (0-360)
            # bit  10     = latitude hemisphere  (0=N, 1=S)
            # bit  11     = longitude hemisphere (0=E, 1=W)
            # bit  12     = GPS positioned       (1=valid fix)
            # bit  13     = GPS real-time        (1=real-time)
            # bit  14     = ACC / ignition       (1=on)
            # bit  15     = reserved
            course_status = struct.unpack('>H', data[gps_offset + 1:gps_offset + 3])[0]
            course    = float(course_status & 0x03FF)
            lat_south = bool(course_status & 0x0400)   # FIX: apply hemisphere
            lon_west  = bool(course_status & 0x0800)   # FIX: apply hemisphere
            gps_valid = bool(course_status & 0x1000)   # FIX: use real validity bit
            ignition  = bool(course_status & 0x4000)

            lat_raw   = struct.unpack('>I', data[gps_offset + 3:gps_offset + 7])[0]
            latitude  = lat_raw / 1_800_000.0
            lon_raw   = struct.unpack('>I', data[gps_offset + 7:gps_offset + 11])[0]
            longitude = lon_raw / 1_800_000.0

            # FIX: apply hemisphere signs
            if lat_south:
                latitude  = -latitude
            if lon_west:
                longitude = -longitude

            speed = float(data[gps_offset + 11])  # already km/h

            sensors = {
                'status_raw':   course_status,
                'acc':          ignition,
                'gps_tracking': bool(course_status & 0x1000),
                'alarm':        bool(course_status & 0x0038),
            }

            return NormalizedPosition(
                imei=known_imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),  # FIX: was missing
                latitude=latitude,
                longitude=longitude,
                speed=speed,
                course=course,
                satellites=satellites,
                valid=gps_valid,
                ignition=ignition,
                sensors=sensors,
            )

        except Exception as e:
            logger.error(f"GT06 position parse error: {e}")
            return None

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

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if command_type == "reset":
            cmd = b'\x78\x78\x05\x80\x01\x00\x01'
            crc = self._crc_16(cmd[2:])
            return cmd + struct.pack('>H', crc) + b'\x0D\x0A'
        return b''

    def get_available_commands(self) -> list:
        return ['reset']

    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        return {
            'reset': {'description': 'Reboot the device', 'params': {}}
        }.get(command_type, {'description': 'Unknown command', 'supported': False})
