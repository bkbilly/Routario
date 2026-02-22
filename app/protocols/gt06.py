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
    
    async def decode(self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            if len(data) < 5: return None, 0
            if data[0:2] != b'\x78\x78' and data[0:2] != b'\x79\x79': return None, 1

            start_bit = data[0:2]
            if start_bit == b'\x78\x78':
                content_len = data[2]
                total_len = content_len + 5
            else:
                if len(data) < 6: return None, 0
                content_len = struct.unpack('>H', data[2:4])[0]
                total_len = content_len + 6

            if len(data) < total_len: return None, 0

            packet = data[:total_len]
            consumed = total_len
            
            offset = 3 if start_bit == b'\x78\x78' else 4
            protocol_number = packet[offset]
            
            if protocol_number == 0x01:
                imei = self._parse_imei(packet[offset+1:offset+9])
                serial = packet[offset+9:offset+11]
                resp = b'\x78\x78\x05\x01' + serial
                crc = self._crc_16(resp[2:])
                resp += struct.pack('>H', crc) + b'\x0D\x0A'
                return {"event": "login", "imei": imei, "response": resp}, consumed
            
            if protocol_number in [0x12, 0x16, 0x1A]:
                res = await self._parse_position(packet, offset, client_info, known_imei)
                return res, consumed
            
            if protocol_number == 0x13:
                serial = packet[offset+1:offset+3]
                resp = b'\x78\x78\x05\x13' + serial
                crc = self._crc_16(resp[2:])
                resp += struct.pack('>H', crc) + b'\x0D\x0A'
                return {"event": "heartbeat", "response": resp}, consumed
            
            return None, consumed
        except Exception as e:
            logger.error(f"GT06 Decode error: {e}")
            return None, len(data)
    
    async def _parse_position(self, data: bytes, offset: int, client_info: Dict[str, Any], known_imei: Optional[str]) -> Optional[NormalizedPosition]:
        try:
            if not known_imei: return None
            
            date_offset = offset + 1
            year = 2000 + data[date_offset]
            month = data[date_offset + 1]
            day = data[date_offset + 2]
            hour = data[date_offset + 3]
            minute = data[date_offset + 4]
            second = data[date_offset + 5]
            device_time = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
            
            gps_offset = date_offset + 6
            sat_acc = data[gps_offset]
            satellites = (sat_acc >> 4) & 0x0F
            course_status = struct.unpack('>H', data[gps_offset+1:gps_offset+3])[0]
            course = course_status & 0x03FF
            lat_raw = struct.unpack('>I', data[gps_offset+3:gps_offset+7])[0]
            latitude = lat_raw / 1800000.0
            lon_raw = struct.unpack('>I', data[gps_offset+7:gps_offset+11])[0]
            longitude = lon_raw / 1800000.0
            speed = data[gps_offset+11]
            status = data[gps_offset+12]
            ignition = bool(status & 0x02)
            
            sensors = {
                'status_raw': status,
                'acc': bool(status & 0x02),
                'gps_tracking': bool(status & 0x10),
                'alarm': bool(status & 0x38),
            }
            
            return NormalizedPosition(
                imei=known_imei, device_time=device_time, latitude=latitude, longitude=longitude,
                speed=float(speed), course=float(course), satellites=satellites, ignition=ignition, sensors=sensors
            )
        except: return None

    def _parse_imei(self, imei_bytes: bytes) -> str:
        return str(int(imei_bytes.hex(), 16))
    
    def _crc_16(self, data: bytes) -> int:
        crc = 0xFFFF
        for byte in data:
            crc ^= (byte << 8)
            for _ in range(8):
                if crc & 0x8000: crc = (crc << 1) ^ 0x1021
                else: crc <<= 1
            crc &= 0xFFFF
        return crc
    
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if command_type == "reset":
            cmd = b'\x78\x78\x05\x80\x01\x00\x01'
            crc = self._crc_16(cmd[2:])
            return cmd + struct.pack('>H', crc) + b'\x0D\x0A'
        return b''
