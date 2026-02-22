"""
Meitrack Protocol Decoder
Supports Meitrack MVT, T, and other series GPS trackers
"""
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
    
    Meitrack is a popular brand in Asia, producing reliable GPS trackers
    for vehicle tracking, asset management, and personal tracking.
    
    Port: 5020 (TCP)
    Format: ASCII text with $$ delimiters
    
    Example message:
    $$A123,123456789012345,AAA,35,31.234567,121.234567,120101120101,A,10,12,0,0,0,100,200,12.34,3.45,1,2,3|4|5|6|*AB<CR><LF>
    """
    
    PORT = 5020
    PROTOCOL_TYPES = ['tcp']
    
    def __init__(self):
        super().__init__()
        # Meitrack messages start with $$
        self.pattern = re.compile(r'\$\$([A-Z]\d+),([^,]+),([^,]+),(.+?)(?:\*([0-9A-F]{2}))?\r?\n', re.DOTALL)
    
    async def decode(
        self, 
        data: bytes, 
        client_info: Dict[str, Any], 
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """
        Decode Meitrack ASCII message
        
        Args:
            data: Raw bytes from device
            client_info: Client connection metadata
            known_imei: Known device IMEI (if authenticated)
            
        Returns:
            Tuple of (decoded_data, bytes_consumed)
        """
        try:
            if not data:
                return None, 0
            
            # Decode to ASCII
            try:
                text = data.decode('ascii', errors='ignore')
            except:
                logger.error("Meitrack: Failed to decode ASCII")
                return None, len(data)
            
            # Look for complete message ($$ ... \r\n or \n)
            start = text.find('$$')
            if start == -1:
                return None, len(data)
            
            # Find end (newline)
            end = text.find('\n', start)
            if end == -1:
                # Incomplete message
                if len(data) > 2048:
                    logger.warning("Meitrack: Buffer too large, resetting")
                    return None, len(data)
                return None, 0
            
            # Extract message
            message = text[start:end+1]
            consumed = len(message.encode('ascii'))
            
            # Parse with regex
            match = self.pattern.match(message)
            if not match:
                logger.warning(f"Meitrack: Invalid format: {message[:50]}")
                return None, consumed
            
            header = match.group(1)   # A123, B456, etc. (message type + length)
            imei = match.group(2)     # Device IMEI
            event_code = match.group(3)  # AAA, CCC, etc.
            payload = match.group(4)  # Main data
            checksum = match.group(5) # Optional checksum
            
            logger.debug(f"Meitrack: IMEI={imei}, Event={event_code}")
            
            # Parse payload fields (comma-separated)
            fields = payload.split(',')
            
            # Handle different event codes
            if event_code in ['AAA', 'CCC', 'DDD']:
                # Position reports
                # AAA = Login / Periodic report
                # CCC = Command response
                # DDD = Alarm
                position = await self._parse_meitrack_position(imei, event_code, fields)
                if position:
                    # Add response if needed (login confirmation)
                    if event_code == 'AAA':
                        response = f"$$B{len(imei)+3},{imei},AAA\r\n".encode('ascii')
                        return position, consumed
                    return position, consumed
            
            else:
                logger.debug(f"Meitrack: Unhandled event code: {event_code}")
            
            return None, consumed
            
        except Exception as e:
            logger.error(f"Meitrack decode error: {e}", exc_info=True)
            return None, len(data) if len(data) > 0 else 1
    
    async def _parse_meitrack_position(
        self, 
        imei: str,
        event_code: str,
        fields: list
    ) -> Optional[NormalizedPosition]:
        """
        Parse Meitrack position data
        
        Typical field layout:
        0: Field count
        1: Latitude
        2: Longitude  
        3: Timestamp (YYMMDDHHMMSS)
        4: GPS validity (A=valid, V=invalid)
        5: Satellites
        6: GSM signal
        7: Speed (km/h)
        8: Course
        9: HDOP
        10: Altitude
        11: Odometer
        12: Runtime
        13: Base station info (MCC|MNC|LAC|CellID)
        14+: Additional fields (vary by device)
        
        Args:
            imei: Device IMEI
            event_code: Event code (AAA, CCC, DDD)
            fields: Comma-separated data fields
            
        Returns:
            NormalizedPosition object or None
        """
        try:
            if len(fields) < 10:
                logger.warning(f"Meitrack: Not enough fields ({len(fields)})")
                return None
            
            # Extract GPS data
            field_count = int(fields[0]) if fields[0] else 0
            latitude = float(fields[1]) if len(fields) > 1 and fields[1] else 0.0
            longitude = float(fields[2]) if len(fields) > 2 and fields[2] else 0.0
            
            # Timestamp (YYMMDDHHMMSS)
            time_str = fields[3] if len(fields) > 3 else ''
            if len(time_str) >= 12:
                try:
                    device_time = datetime(
                        2000 + int(time_str[0:2]),   # Year
                        int(time_str[2:4]),          # Month
                        int(time_str[4:6]),          # Day
                        int(time_str[6:8]),          # Hour
                        int(time_str[8:10]),         # Minute
                        int(time_str[10:12]),        # Second
                        tzinfo=timezone.utc
                    )
                except:
                    device_time = datetime.now(timezone.utc)
            else:
                device_time = datetime.now(timezone.utc)
            
            # GPS validity
            valid = fields[4] == 'A' if len(fields) > 4 else False
            
            # Satellites
            satellites = int(fields[5]) if len(fields) > 5 and fields[5] else 0
            
            # GSM signal
            gsm_signal = int(fields[6]) if len(fields) > 6 and fields[6] else 0
            
            # Speed (km/h)
            speed = float(fields[7]) if len(fields) > 7 and fields[7] else 0.0
            
            # Course
            course = float(fields[8]) if len(fields) > 8 and fields[8] else 0.0
            
            # HDOP
            hdop = float(fields[9]) if len(fields) > 9 and fields[9] else 0.0
            
            # Altitude
            altitude = float(fields[10]) if len(fields) > 10 and fields[10] else 0.0
            
            # Extract sensor data
            sensors = {}
            sensors['event_code'] = event_code
            sensors['gsm_signal'] = gsm_signal
            sensors['hdop'] = hdop
            
            # Odometer
            if len(fields) > 11 and fields[11]:
                try:
                    sensors['odometer'] = float(fields[11])
                except:
                    pass
            
            # Runtime
            if len(fields) > 12 and fields[12]:
                try:
                    sensors['runtime'] = int(fields[12])
                except:
                    pass
            
            # Base station info (MCC|MNC|LAC|CellID)
            if len(fields) > 13 and fields[13]:
                try:
                    bs_parts = fields[13].split('|')
                    if len(bs_parts) >= 4:
                        sensors['mcc'] = bs_parts[0]
                        sensors['mnc'] = bs_parts[1]
                        sensors['lac'] = bs_parts[2]
                        sensors['cell_id'] = bs_parts[3]
                except:
                    pass
            
            # Battery voltage (if present)
            if len(fields) > 14 and fields[14]:
                try:
                    sensors['battery_voltage'] = float(fields[14])
                except:
                    pass
            
            # Battery percentage (if present)
            if len(fields) > 15 and fields[15]:
                try:
                    sensors['battery_percent'] = int(fields[15])
                except:
                    pass
            
            # Digital inputs (if present)
            if len(fields) > 16 and fields[16]:
                try:
                    sensors['digital_inputs'] = int(fields[16])
                except:
                    pass
            
            # Digital outputs (if present)
            if len(fields) > 17 and fields[17]:
                try:
                    sensors['digital_outputs'] = int(fields[17])
                except:
                    pass
            
            # Analog inputs (if present) - often multiple values separated by |
            if len(fields) > 18 and fields[18]:
                try:
                    analog_parts = fields[18].split('|')
                    for i, val in enumerate(analog_parts):
                        if val:
                            sensors[f'analog_{i+1}'] = float(val)
                except:
                    pass
            
            # Create normalized position
            position = NormalizedPosition(
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
                sensors=sensors
            )
            
            logger.debug(f"Meitrack decoded position: {imei} @ {latitude},{longitude}")
            return position
            
        except Exception as e:
            logger.error(f"Meitrack position parse error: {e}", exc_info=True)
            return None
    
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """
        Encode command for Meitrack device
        
        Meitrack commands format: @@<letter><length>,<IMEI>,<command>,<params>*<checksum><CR><LF>
        
        Args:
            command_type: Type of command
            params: Command parameters
            
        Returns:
            Encoded command bytes
        """
        try:
            imei = params.get('imei', '')
            if not imei:
                logger.warning("Meitrack: IMEI required for commands")
                return b''
            
            if command_type == 'request_position':
                # Request current position
                cmd_str = f"A10,{imei}"
                
            elif command_type == 'reboot':
                # Reboot device
                cmd_str = f"A11,{imei}"
                
            elif command_type == 'set_interval':
                # Set reporting interval
                interval = params.get('interval', 30)  # seconds
                cmd_str = f"A12,{imei},{interval}"
                
            elif command_type == 'set_server':
                # Set server IP and port
                ip = params.get('ip', '')
                port = params.get('port', 5020)
                cmd_str = f"A13,{imei},{ip},{port}"
                
            elif command_type == 'set_apn':
                # Set APN
                apn = params.get('apn', 'internet')
                username = params.get('username', '')
                password = params.get('password', '')
                cmd_str = f"A14,{imei},{apn},{username},{password}"
                
            elif command_type == 'set_timezone':
                # Set timezone offset
                timezone_offset = params.get('timezone', 0)
                cmd_str = f"A15,{imei},{timezone_offset}"
                
            elif command_type == 'enable_output':
                # Enable specific output
                output_type = params.get('output_type', 'ACC')
                cmd_str = f"A16,{imei},{output_type},1"
                
            elif command_type == 'disable_output':
                # Disable specific output
                output_type = params.get('output_type', 'ACC')
                cmd_str = f"A16,{imei},{output_type},0"
                
            elif command_type == 'custom':
                # Custom command
                cmd_str = params.get('payload', '')
                
            else:
                logger.warning(f"Meitrack: Unknown command type: {command_type}")
                return b''
            
            # Calculate length
            length = len(cmd_str)
            
            # Build full command
            command = f"@@A{length:02d},{cmd_str}"
            
            # Calculate checksum (XOR of all bytes)
            checksum = 0
            for byte in command.encode('ascii'):
                checksum ^= byte
            
            # Add checksum and terminators
            command += f"*{checksum:02X}\r\n"
            
            # Encode as ASCII
            encoded = command.encode('ascii')
            logger.info(f"Meitrack command encoded: {command.strip()}")
            return encoded
            
        except Exception as e:
            logger.error(f"Meitrack command encode error: {e}")
            return b''
    
    def get_available_commands(self) -> list:
        """
        Get list of available commands for Meitrack protocol
        
        Returns:
            List of command type strings
        """
        return [
            'request_position',
            'reboot',
            'set_interval',
            'set_server',
            'set_apn',
            'set_timezone',
            'enable_output',
            'disable_output',
            'custom'
        ]
    
    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        """
        Get information about a specific command
        
        Args:
            command_type: Command type
            
        Returns:
            Dictionary with command metadata
        """
        command_info = {
            'request_position': {
                'description': 'Request immediate GPS position',
                'params': {
                    'imei': 'Device IMEI (required)'
                },
                'example': '{"imei": "123456789012345"}'
            },
            'reboot': {
                'description': 'Reboot the device',
                'params': {
                    'imei': 'Device IMEI (required)'
                },
                'example': '{"imei": "123456789012345"}'
            },
            'set_interval': {
                'description': 'Set reporting interval',
                'params': {
                    'imei': 'Device IMEI (required)',
                    'interval': 'Interval in seconds'
                },
                'example': '{"imei": "123456789012345", "interval": 30}'
            },
            'set_server': {
                'description': 'Configure server IP and port',
                'params': {
                    'imei': 'Device IMEI (required)',
                    'ip': 'Server IP address',
                    'port': 'Server port (default: 5020)'
                },
                'example': '{"imei": "123456789012345", "ip": "192.168.1.100", "port": 5020}'
            },
            'set_apn': {
                'description': 'Configure APN for GPRS',
                'params': {
                    'imei': 'Device IMEI (required)',
                    'apn': 'APN name',
                    'username': 'APN username (optional)',
                    'password': 'APN password (optional)'
                },
                'example': '{"imei": "123456789012345", "apn": "internet"}'
            },
            'set_timezone': {
                'description': 'Set timezone offset',
                'params': {
                    'imei': 'Device IMEI (required)',
                    'timezone': 'Timezone offset in hours (e.g., 8 for UTC+8)'
                },
                'example': '{"imei": "123456789012345", "timezone": 8}'
            },
            'enable_output': {
                'description': 'Enable specific output type',
                'params': {
                    'imei': 'Device IMEI (required)',
                    'output_type': 'Output type (ACC, GPS, etc.)'
                },
                'example': '{"imei": "123456789012345", "output_type": "ACC"}'
            },
            'disable_output': {
                'description': 'Disable specific output type',
                'params': {
                    'imei': 'Device IMEI (required)',
                    'output_type': 'Output type (ACC, GPS, etc.)'
                },
                'example': '{"imei": "123456789012345", "output_type": "ACC"}'
            },
            'custom': {
                'description': 'Send custom command',
                'params': {
                    'payload': 'Command string'
                },
                'example': '{"payload": "A10,123456789012345"}'
            }
        }
        
        return command_info.get(command_type, {
            'description': 'Unknown command',
            'params': {},
            'example': '{}'
        })
