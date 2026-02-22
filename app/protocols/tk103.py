"""
TK103 Protocol Decoder
Supports Coban TK103, Xexun, and many Chinese GPS tracker clones
"""
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
    
    TK103 is one of the most popular GPS tracker protocols worldwide.
    Originally from Coban/Xexun, now supported by thousands of Chinese trackers.
    
    Port: 5001 (TCP)
    Format: ASCII text-based protocol with parentheses delimiters
    
    Examples:
    - Login: (000000000000BR00240101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)
    - Position: (123456789012BR00210101A1234.5678N12345.6789E000.0123456A0000.0000000000L00000000)
    - Heartbeat: (123456789012BP05000)
    """
    
    PORT = 5001
    PROTOCOL_TYPES = ['tcp']
    
    def __init__(self):
        super().__init__()
        # Pattern for TK103 messages: (IMEI + Command + Data)
        self.pattern = re.compile(r'\((\d{12,15})(.{2})(\d{2})(.+?)\)')
    
    async def decode(
        self, 
        data: bytes, 
        client_info: Dict[str, Any], 
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """
        Decode TK103 ASCII message
        
        Args:
            data: Raw bytes from device
            client_info: Client connection metadata
            known_imei: Known device IMEI (if authenticated)
            
        Returns:
            Tuple of (decoded_data, bytes_consumed)
        """
        try:
            # TK103 uses ASCII text
            if not data:
                return None, 0
            
            # Decode to ASCII
            try:
                text = data.decode('ascii', errors='ignore').strip()
            except:
                logger.error("TK103: Failed to decode ASCII")
                return None, len(data)
            
            # Look for complete message in parentheses
            if not text:
                return None, len(data)
            
            # Find message boundaries
            start = text.find('(')
            end = text.find(')', start)
            
            if start == -1:
                # No message start found
                return None, len(data)
            
            if end == -1:
                # Incomplete message, need more data
                if len(data) > 1024:  # Prevent buffer overflow
                    logger.warning("TK103: Buffer too large, resetting")
                    return None, len(data)
                return None, 0
            
            # Extract complete message
            message = text[start:end+1]
            consumed = len(message.encode('ascii'))
            
            # Parse message with regex
            match = self.pattern.match(message)
            
            if not match:
                logger.warning(f"TK103: Invalid message format: {message}")
                return None, consumed
            
            imei = match.group(1)
            command = match.group(2)
            length = match.group(3)
            payload = match.group(4)
            
            logger.debug(f"TK103: IMEI={imei}, CMD={command}, LEN={length}")
            
            # Handle different command types
            if command == 'BP':
                # Heartbeat
                logger.info(f"TK103 heartbeat from {imei}")
                response = f"({imei}AP05)".encode('ascii')
                return {"event": "heartbeat", "imei": imei, "response": response}, consumed
            
            elif command == 'BR':
                # Login / Initial registration
                logger.info(f"TK103 login from {imei}")
                response = f"({imei}AP01HSO)".encode('ascii')
                return {"event": "login", "imei": imei, "response": response}, consumed
            
            elif command in ['BO', 'BV', 'BZ', 'BX']:
                # Position reports
                # BO = Normal report
                # BV = Speed alert
                # BZ = Low battery
                # BX = Vibration/movement alert
                position = await self._parse_tk103_position(imei, payload, command)
                if position:
                    return position, consumed
            
            elif command == 'BN':
                # SOS alert
                position = await self._parse_tk103_position(imei, payload, command)
                if position:
                    position.sensors['alert_type'] = 'SOS'
                    return position, consumed
            
            else:
                logger.warning(f"TK103: Unknown command {command}")
            
            return None, consumed
            
        except Exception as e:
            logger.error(f"TK103 decode error: {e}", exc_info=True)
            return None, len(data) if len(data) > 0 else 1
    
    async def _parse_tk103_position(
        self, 
        imei: str, 
        payload: str,
        command: str
    ) -> Optional[NormalizedPosition]:
        """
        Parse TK103 position data
        
        Format: DDMMYYA1234.5678N12345.6789E000.0123456A0000.0000000000L00000000
        
        Where:
        - DDMMYY: Date
        - A/V: GPS validity (A=valid, V=invalid)
        - Latitude in DDMM.MMMM format
        - N/S: North/South
        - Longitude in DDDMM.MMMM format
        - E/W: East/West
        - Speed in knots
        - HHMMSS: Time
        - A/V: GPS validity again
        - Course
        - Flags
        - Status codes
        
        Args:
            imei: Device IMEI
            payload: Position data string
            command: Command type (BO, BV, etc.)
            
        Returns:
            NormalizedPosition object or None
        """
        try:
            if len(payload) < 40:
                logger.warning(f"TK103: Payload too short: {len(payload)}")
                return None
            
            # Parse date/time (DDMMYY at start, HHMMSS in middle)
            date_str = payload[0:6]
            
            # Find time position (HHMMSS followed by A or V)
            # Typical format: ...E000.0123456A0000...
            # Time is at position after speed
            
            # Parse GPS validity
            validity_char = payload[6]
            valid = (validity_char == 'A')
            
            if not valid:
                logger.debug(f"TK103: GPS invalid (V) for {imei}")
                # Continue parsing but mark as invalid
            
            # Extract latitude (DDMM.MMMM + N/S)
            lat_start = 7
            lat_str = payload[lat_start:lat_start+9]  # DDMM.MMMM
            lat_dir = payload[lat_start+9]  # N or S
            
            # Extract longitude (DDDMM.MMMM + E/W)
            lon_start = lat_start + 10
            lon_str = payload[lon_start:lon_start+10]  # DDDMM.MMMM
            lon_dir = payload[lon_start+10]  # E or W
            
            # Convert coordinates
            latitude = self._parse_coordinate(lat_str, lat_dir)
            longitude = self._parse_coordinate(lon_str, lon_dir)
            
            if latitude is None or longitude is None:
                logger.warning("TK103: Invalid coordinates")
                return None
            
            # Extract speed (knots, 3 digits with decimal)
            speed_start = lon_start + 11
            speed_str = payload[speed_start:speed_start+5]  # 000.0
            speed_knots = float(speed_str)
            speed_kmh = speed_knots * 1.852  # Convert knots to km/h
            
            # Extract time (HHMMSS)
            time_start = speed_start + 5
            time_str = payload[time_start:time_start+6]
            
            # Parse datetime
            day = int(date_str[0:2])
            month = int(date_str[2:4])
            year = 2000 + int(date_str[4:6])
            hour = int(time_str[0:2])
            minute = int(time_str[2:4])
            second = int(time_str[4:6])
            
            device_time = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
            
            # Extract GPS validity again (should match earlier one)
            valid_start = time_start + 6
            validity2 = payload[valid_start] if valid_start < len(payload) else 'V'
            valid = valid and (validity2 == 'A')
            
            # Extract course (4 digits)
            course_start = valid_start + 1
            if course_start + 4 <= len(payload):
                course_str = payload[course_start:course_start+4]
                try:
                    course = float(course_str)
                except:
                    course = 0.0
            else:
                course = 0.0
            
            # Extract status and flags (remaining payload)
            status_start = course_start + 4
            status_data = payload[status_start:] if status_start < len(payload) else ""
            
            # Parse sensors from status data
            sensors = {}
            
            # Add alert type based on command
            alert_types = {
                'BO': 'normal',
                'BV': 'speed_alert',
                'BZ': 'low_battery',
                'BX': 'vibration',
                'BN': 'SOS'
            }
            if command in alert_types:
                sensors['report_type'] = alert_types[command]
            
            # Parse status flags if present
            if len(status_data) > 10:
                # Status data format varies by device
                # L = Location data
                # Try to parse basic flags
                try:
                    # Look for common patterns
                    if 'L' in status_data:
                        l_idx = status_data.index('L')
                        flags_hex = status_data[l_idx+1:l_idx+9]
                        if len(flags_hex) >= 8:
                            flags = int(flags_hex, 16)
                            # Parse flags (varies by device model)
                            sensors['acc_on'] = bool(flags & 0x01)
                            sensors['ignition'] = bool(flags & 0x02)
                            sensors['defense_on'] = bool(flags & 0x04)
                except:
                    pass
            
            # Create normalized position
            position = NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=0.0,  # TK103 doesn't provide altitude in standard format
                speed=speed_kmh,
                course=course,
                satellites=0,  # Not provided in standard format
                valid=valid,
                sensors=sensors
            )
            
            logger.debug(f"TK103 decoded position: {imei} @ {latitude},{longitude}")
            return position
            
        except Exception as e:
            logger.error(f"TK103 position parse error: {e}", exc_info=True)
            return None
    
    def _parse_coordinate(self, coord_str: str, direction: str) -> Optional[float]:
        """
        Parse TK103 coordinate format
        
        Format: DDMM.MMMM or DDDMM.MMMM
        
        Args:
            coord_str: Coordinate string (e.g., "1234.5678")
            direction: N/S for latitude, E/W for longitude
            
        Returns:
            Decimal degrees or None
        """
        try:
            # Remove any whitespace
            coord_str = coord_str.strip()
            
            # Find decimal point
            dot_idx = coord_str.find('.')
            if dot_idx == -1:
                return None
            
            # Determine if lat or lon based on direction
            if direction in ['N', 'S']:
                # Latitude: DDMM.MMMM (2 digits degrees)
                degrees = int(coord_str[0:2])
                minutes = float(coord_str[2:])
            else:
                # Longitude: DDDMM.MMMM (3 digits degrees)
                degrees = int(coord_str[0:3])
                minutes = float(coord_str[3:])
            
            # Convert to decimal degrees
            decimal = degrees + (minutes / 60.0)
            
            # Apply direction
            if direction in ['S', 'W']:
                decimal = -decimal
            
            return decimal
            
        except Exception as e:
            logger.error(f"TK103 coordinate parse error: {e}")
            return None
    
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """
        Encode command for TK103 device
        
        TK103 supports various SMS and GPRS commands.
        
        Common commands:
        - **check123456**: Check GPS position
        - **tracker123456**: Set as continuous tracking mode
        - **sleep123456**: Set as sleep mode
        - **t030s123456**: Set tracking interval to 30 seconds
        - **stockade123456 lat,lon;lat,lon**: Set geo-fence
        - **speed123456 100**: Set speed alert to 100 km/h
        
        Args:
            command_type: Type of command
            params: Command parameters
            
        Returns:
            Encoded command bytes
        """
        try:
            password = params.get('password', '123456')  # Default TK103 password
            
            if command_type == 'check_position':
                # Request current position
                command = f"**,imei:{params.get('imei', '')},A"
                
            elif command_type == 'set_interval':
                # Set tracking interval
                interval = params.get('interval', 30)  # seconds
                command = f"**,imei:{params.get('imei', '')},C,{interval}s"
                
            elif command_type == 'tracker_mode':
                # Enable continuous tracking
                command = f"tracker{password}"
                
            elif command_type == 'sleep_mode':
                # Enable sleep/power saving mode
                command = f"sleep{password}"
                
            elif command_type == 'set_apn':
                # Set APN for GPRS
                apn = params.get('apn', 'internet')
                command = f"apn{password} {apn}"
                
            elif command_type == 'set_server':
                # Set server IP and port
                ip = params.get('ip', '')
                port = params.get('port', 5001)
                command = f"adminip{password} {ip} {port}"
                
            elif command_type == 'reboot':
                # Reboot device
                command = f"reset{password}"
                
            elif command_type == 'speed_alert':
                # Set speed alert threshold
                speed = params.get('speed', 100)  # km/h
                command = f"speed{password} {speed}"
                
            elif command_type == 'custom':
                # Custom SMS command
                command = params.get('payload', '')
                
            else:
                logger.warning(f"TK103: Unknown command type: {command_type}")
                return b''
            
            # TK103 commands are sent as SMS-style text
            # When sent over GPRS, they're wrapped in a specific format
            # Format: (IMEI + AT + command)
            imei = params.get('imei', '')
            if imei:
                encoded = f"({imei}AT00{command})".encode('ascii')
            else:
                # Fallback: just the command (for testing)
                encoded = command.encode('ascii')
            
            logger.info(f"TK103 command encoded: {command}")
            return encoded
            
        except Exception as e:
            logger.error(f"TK103 command encode error: {e}")
            return b''
    
    def get_available_commands(self) -> list:
        """
        Get list of available commands for TK103 protocol
        
        Returns:
            List of command type strings
        """
        return [
            'check_position',
            'set_interval',
            'tracker_mode',
            'sleep_mode',
            'set_apn',
            'set_server',
            'reboot',
            'speed_alert',
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
            'check_position': {
                'description': 'Request current GPS position',
                'params': {
                    'imei': 'Device IMEI',
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"password": "123456"}'
            },
            'set_interval': {
                'description': 'Set tracking interval',
                'params': {
                    'imei': 'Device IMEI',
                    'interval': 'Interval in seconds',
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"interval": 30, "password": "123456"}'
            },
            'tracker_mode': {
                'description': 'Enable continuous tracking mode',
                'params': {
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"password": "123456"}'
            },
            'sleep_mode': {
                'description': 'Enable power saving / sleep mode',
                'params': {
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"password": "123456"}'
            },
            'set_apn': {
                'description': 'Configure APN for GPRS connection',
                'params': {
                    'apn': 'APN name (e.g., internet, data)',
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"apn": "internet", "password": "123456"}'
            },
            'set_server': {
                'description': 'Configure server IP and port',
                'params': {
                    'ip': 'Server IP address',
                    'port': 'Server port (default: 5001)',
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"ip": "192.168.1.100", "port": 5001, "password": "123456"}'
            },
            'reboot': {
                'description': 'Reboot the device',
                'params': {
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"password": "123456"}'
            },
            'speed_alert': {
                'description': 'Set speed alert threshold',
                'params': {
                    'speed': 'Speed in km/h',
                    'password': 'Device password (default: 123456)'
                },
                'example': '{"speed": 100, "password": "123456"}'
            },
            'custom': {
                'description': 'Send custom SMS-style command',
                'params': {
                    'payload': 'Raw command string'
                },
                'example': '{"payload": "tracker123456"}'
            }
        }
        
        return command_info.get(command_type, {
            'description': 'Unknown command',
            'params': {},
            'example': '{}'
        })
