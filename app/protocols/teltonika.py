import struct
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, List, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("teltonika")
class TeltonikaDecoder(BaseProtocolDecoder):
    PORT = 5027
    PROTOCOL_TYPES = ['tcp', 'udp']

    # Command mapping for Teltonika SMS/GPRS commands
    COMMAND_MAPPING = {
        'cpureset': 'cpureset',
        'getver': 'getver',
        'getgps': 'getgps',
        'readio': 'readio',
        'getrecord': 'getrecord',
        'ggps': 'ggps',
        'getinfo': 'getinfo',
        'setparam': 'setparam',
        'getparam': 'getparam',
        'flush': 'flush',
        'readstatus': 'readstatus',
        'getimei': 'getimei',
    }
    
    IO_MAP = {
        1: 'din1', 2: 'din2', 3: 'din3', 4: 'din4', 9: 'adc1', 10: 'adc2', 11: 'iccid',
        12: 'fuel_used', 13: 'fuel_consumption', 16: 'odometer', 17: 'axisX', 18: 'axisY', 19: 'axisZ',
        21: 'gsm_signal', 24: 'speed', 30: 'fault_count', 31: 'engine_load', 32: 'coolant_temp', 36: 'rpm',
        66: 'external_voltage', 67: 'battery_voltage', 68: 'battery_current', 69: 'gnss_status', 70: 'pcb_temp',
        72: 'temp1', 73: 'temp2', 74: 'temp3', 75: 'temp4', 80: 'data_mode', 81: 'obd_speed', 82: 'throttle',
        83: 'fuel_used_obd', 84: 'fuel_level_obd', 85: 'rpm_obd', 87: 'odometer_obd', 89: 'fuel_level_percent',
        113: 'battery_level_percent', 115: 'engine_temp', 179: 'din_out1', 180: 'din_out2', 181: 'pdop',
        182: 'hdop', 199: 'trip_odometer', 200: 'sleep_mode', 205: 'cid2g', 206: 'lac', 239: 'ignition',
        240: 'movement', 241: 'gsm_operator', 244: 'roaming', 636: 'cid4g', 662: 'door'
    }

    IO_MULTIPLIERS = {
        9: 0.001, 10: 0.001, 12: 0.001, 13: 0.01, 21: 1, 24: 1.852, 25: 0.01, 26: 0.01, 27: 0.01, 28: 0.01,
        66: 0.001, 67: 0.001, 68: 0.001, 70: 0.1, 72: 0.1, 73: 0.1, 74: 0.1, 75: 0.1, 83: 0.1, 84: 0.1,
        110: 0.1, 115: 0.1, 181: 0.1, 182: 0.1, 701: 0.01, 702: 0.01, 703: 0.01, 704: 0.01
    }

    async def decode(self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            # TCP Data packet
            if len(data) >= 4 and data[0:4] == b'\x00\x00\x00\x00':
                if len(data) < 8: 
                    return None, 0
                data_length = struct.unpack('>I', data[4:8])[0]
                total_len = 8 + data_length + 4
                if len(data) < total_len: 
                    return None, 0
                packet_data = data[8:8+data_length]
                consumed = total_len
                if len(packet_data) < 2: 
                    return None, consumed
                
                codec_id = packet_data[0]
                
                # Codec 8 (0x08)
                if codec_id == 0x08:
                    decoded = await self._decode_codec8(packet_data[2:], known_imei, extended=False)
                    return decoded, consumed
                
                # Codec 8 Extended (0x8E)
                elif codec_id == 0x8E:
                    decoded = await self._decode_codec8(packet_data[2:], known_imei, extended=True)
                    return decoded, consumed
                
                else:
                    logger.warning(f"Unsupported Teltonika codec: 0x{codec_id:02X}")
                    return None, consumed
            
            # IMEI login packet
            elif len(data) >= 2:
                imei_len = struct.unpack('>H', data[0:2])[0]
                if imei_len == 0: 
                    return None, 1 if len(data) >= 4 else 0
                if len(data) >= imei_len + 2:
                    try:
                        imei = data[2:2+imei_len].decode('ascii')
                        logger.info(f"Teltonika Login: {imei}")
                        return {"event": "login", "imei": imei, "response": b'\x01'}, imei_len + 2
                    except UnicodeDecodeError: 
                        return None, 1
                return None, 0
            
            return None, 0
        except Exception as e:
            logger.error(f"Teltonika Decode error: {e}")
            return None, 1

    async def _decode_codec8(self, data: bytes, known_imei: Optional[str], extended: bool = False) -> Optional[NormalizedPosition]:
        """
        Decode Codec 8 or Codec 8 Extended
        Args:
            data: Raw packet data after codec ID and record count
            known_imei: Device IMEI
            extended: True for Codec 8 Extended (2-byte IO IDs), False for Codec 8 (1-byte IO IDs)
        """
        if not known_imei: 
            return None
        try:
            offset = 0
            
            # Timestamp (8 bytes)
            timestamp_ms = struct.unpack('>Q', data[offset:offset+8])[0]
            device_time = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
            offset += 8
            
            # Priority (1 byte)
            priority = data[offset]
            offset += 1
            
            # GPS Element (15 bytes)
            lon = struct.unpack('>i', data[offset:offset+4])[0] / 10000000.0
            lat = struct.unpack('>i', data[offset+4:offset+8])[0] / 10000000.0
            alt = struct.unpack('>h', data[offset+8:offset+10])[0]
            angle = struct.unpack('>H', data[offset+10:offset+12])[0]
            sat = data[offset+12]
            speed = struct.unpack('>H', data[offset+13:offset+15])[0]
            offset += 15
            
            # IO Element
            offset += 2  # Skip IO Event ID + Total IO count
            
            ignition = None
            sensors = {}
            
            # IO parsing function
            def parse_io(byte_width: int, unpack_func):
                nonlocal offset, ignition
                if offset + 1 > len(data): 
                    return
                
                count = data[offset]
                offset += 1
                
                for _ in range(count):
                    # Codec 8 Extended uses 2-byte IO IDs
                    id_width = 2 if extended else 1
                    
                    if offset + id_width + byte_width > len(data): 
                        break
                    
                    # Read IO ID (1 or 2 bytes depending on codec)
                    if extended:
                        io_id = struct.unpack('>H', data[offset:offset+2])[0]
                        offset += 2
                    else:
                        io_id = data[offset]
                        offset += 1
                    
                    # Read IO value
                    val = unpack_func(data[offset:offset+byte_width])
                    offset += byte_width
                    
                    # Special handling for ignition
                    if io_id == 239: 
                        ignition = bool(val)
                    
                    # Apply multiplier if defined
                    if io_id in self.IO_MULTIPLIERS: 
                        val = round(float(val) * self.IO_MULTIPLIERS[io_id], 3)
                    
                    # Map to readable name or use generic name
                    key = self.IO_MAP.get(io_id, f"io_{io_id}")
                    sensors[key] = val
            
            # Parse 1-byte, 2-byte, 4-byte, and 8-byte IO elements
            parse_io(1, lambda b: b[0])
            parse_io(2, lambda b: struct.unpack('>H', b)[0])
            parse_io(4, lambda b: struct.unpack('>I', b)[0])
            parse_io(8, lambda b: struct.unpack('>Q', b)[0])

            return NormalizedPosition(
                imei=known_imei, 
                device_time=device_time, 
                latitude=lat, 
                longitude=lon, 
                altitude=float(alt), 
                speed=float(speed), 
                course=float(angle), 
                satellites=sat, 
                ignition=ignition, 
                sensors=sensors, 
                raw_data={"priority": priority, "codec": "8E" if extended else "8"}
            )
        except Exception as e: 
            logger.error(f"Codec 8{'E' if extended else ''} decode error: {e}")
            return None

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """
        Encode commands for Teltonika devices.
        
        Args:
            command_type: Type of command ('custom' or predefined command name)
            params: Dictionary containing 'payload' for custom commands
        
        Returns:
            bytes: Encoded command in Teltonika Codec 12 format
        """
        if not params:
            params = {}
        
        # Handle custom commands
        if command_type == 'custom':
            payload = params.get('payload', '')
            if not payload:
                return b''
            
            # Check if payload is hex string
            if len(payload) % 2 == 0 and all(c in '0123456789ABCDEFabcdef' for c in payload):
                try:
                    return bytes.fromhex(payload)
                except ValueError:
                    pass
            
            # Treat as text command
            command_text = payload.strip()
        
        # Handle predefined commands
        elif command_type.lower() in self.COMMAND_MAPPING:
            command_text = self.COMMAND_MAPPING[command_type.lower()]

        else:
            return b''
        
        return self._encode_text_command(command_text)
    
    def _encode_text_command(self, command_text: str) -> bytes:
        """
        Encode a text command into Teltonika Codec 12 binary format.
        
        Format:
        - Preamble: 4 bytes (00 00 00 00)
        - Data Field Length: 4 bytes (big-endian)
        - Codec ID: 1 byte (0x0C)
        - Command Quantity 1: 1 byte (0x01)
        - Command Type: 1 byte (0x05)
        - Command Size: 4 bytes (big-endian)
        - Command: N bytes (ASCII)
        - Command Quantity 2: 1 byte (0x01)
        - CRC-16: 4 bytes (big-endian)
        """
        cmd_bytes = command_text.encode('ascii')
        cmd_length = len(cmd_bytes)
        
        # Protocol constants
        codec_id = 0x0C
        cmd_quantity = 0x01
        cmd_type = 0x05
        
        # Build data part (what gets CRC'd)
        data_part = b''
        data_part += struct.pack('B', codec_id)
        data_part += struct.pack('B', cmd_quantity)
        data_part += struct.pack('B', cmd_type)
        data_part += struct.pack('>I', cmd_length)
        data_part += cmd_bytes
        data_part += struct.pack('B', cmd_quantity)
        
        # Calculate CRC-16
        crc = self._calculate_crc16(data_part)
        
        # Data Field Length = Quantity1 + Type + Command + Quantity2
        data_field_length = 1 + 1 + cmd_length + 1
        
        # Build complete message
        preamble = b'\x00\x00\x00\x00'
        length_field = struct.pack('>I', data_field_length)
        crc_bytes = struct.pack('>I', crc)
        
        return preamble + length_field + data_part + crc_bytes
    
    def _calculate_crc16(self, data: bytes) -> int:
        """
        Calculate CRC-16 using CRC-16/IBM (Modbus) algorithm.
        
        Args:
            data: Data bytes to calculate CRC for
            
        Returns:
            int: CRC-16 value
        """
        crc = 0
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if crc & 1:
                    crc = (crc >> 1) ^ 0xA001
                else:
                    crc >>= 1
        return crc & 0xFFFF
    
    def get_available_commands(self) -> List[str]:
        """Get list of available commands."""
        return list(self.COMMAND_MAPPING.keys()) + ['custom']
    
    def get_command_info(self, command: str) -> Dict[str, Any]:
        """Get information about a specific command."""
        info_map = {
            'cpureset': {
                'description': 'Reset the device CPU',
                'example': 'cpureset',
                'requires_params': False
            },
            'getver': {
                'description': 'Get firmware version',
                'example': 'getver',
                'requires_params': False
            },
            'getgps': {
                'description': 'Get current GPS position',
                'example': 'getgps',
                'requires_params': False
            },
            'readio': {
                'description': 'Read I/O status',
                'example': 'readio',
                'requires_params': False
            },
            'getrecord': {
                'description': 'Get last record',
                'example': 'getrecord',
                'requires_params': False
            },
            'ggps': {
                'description': 'Get GPS coordinates',
                'example': 'ggps',
                'requires_params': False
            },
            'getinfo': {
                'description': 'Get device information',
                'example': 'getinfo',
                'requires_params': False
            },
            'setparam': {
                'description': 'Set a device parameter',
                'example': 'setparam 1000:60',
                'requires_params': True
            },
            'getparam': {
                'description': 'Get parameter value',
                'example': 'getparam 1000',
                'requires_params': True
            },
            'flush': {
                'description': 'Flush stored records',
                'example': 'flush',
                'requires_params': False
            },
            'readstatus': {
                'description': 'Read device status',
                'example': 'readstatus',
                'requires_params': False
            },
            'getimei': {
                'description': 'Get IMEI number',
                'example': 'getimei',
                'requires_params': False
            },
            'custom': {
                'description': 'Send custom command (text or hex)',
                'example': 'Any text command or hex string',
                'requires_params': True
            }
        }
        
        return info_map.get(command, {
            'description': 'Unknown command',
            'example': '',
            'requires_params': False
        })
