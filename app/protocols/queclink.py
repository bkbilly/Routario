"""
Queclink Protocol Decoder
Supports Queclink GV, GL, and GB series GPS trackers
"""
import re
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("queclink")
class QueclinkDecoder(BaseProtocolDecoder):
    """
    Queclink Protocol Decoder
    
    Queclink specializes in professional IoT tracking devices with focus on
    asset tracking, fleet management, and industrial applications.
    
    Port: 5026 (TCP)
    Format: ASCII text-based with + delimiters
    Protocol: GV series (vehicle), GL series (asset), GB series (OBD)
    
    Example message:
    +RESP:GTFRI,060228,135790246811220,,,00,1,1,4.3,92,70.0,121.354335,31.222073,20090214013254,0460,0000,18d8,6141,00,20090214093254,11F0$
    """
    
    PORT = 5026
    PROTOCOL_TYPES = ['tcp']
    
    def __init__(self):
        super().__init__()
        # Queclink messages start with + and end with $
        self.pattern = re.compile(r'\+(\w+):(\w+),(.*?)\$', re.DOTALL)
    
    async def decode(
        self, 
        data: bytes, 
        client_info: Dict[str, Any], 
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """
        Decode Queclink ASCII message
        
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
                logger.error("Queclink: Failed to decode ASCII")
                return None, len(data)
            
            # Look for complete message (+ ... $)
            start = text.find('+')
            end = text.find('$', start)
            
            if start == -1:
                # No message start
                return None, len(data)
            
            if end == -1:
                # Incomplete message
                if len(data) > 2048:  # Prevent buffer overflow
                    logger.warning("Queclink: Buffer too large, resetting")
                    return None, len(data)
                return None, 0
            
            # Extract complete message
            message = text[start:end+1]
            consumed = len(message.encode('ascii'))
            
            # Parse with regex
            match = self.pattern.match(message)
            if not match:
                logger.warning(f"Queclink: Invalid format: {message[:50]}")
                return None, consumed
            
            prefix = match.group(1)  # RESP, ACK, BUFF
            msg_type = match.group(2)  # GTFRI, GTSOS, etc.
            payload = match.group(3)  # Comma-separated data
            
            logger.debug(f"Queclink: {prefix}:{msg_type}")
            
            # Split payload by commas
            fields = payload.split(',')
            
            # Handle different message types
            if msg_type in ['GTFRI', 'GTGEO', 'GTRTL', 'GTDOG', 'GTIDN']:
                # Position reports
                # GTFRI = Fixed Report Information
                # GTGEO = Geofence
                # GTRTL = Real-time location
                # GTDOG = Watchdog
                # GTIDN = Identification
                position = await self._parse_queclink_position(fields, msg_type, known_imei)
                if position:
                    return position, consumed
            
            elif msg_type == 'GTSOS':
                # SOS alert
                position = await self._parse_queclink_position(fields, msg_type, known_imei)
                if position:
                    position.sensors['alert_type'] = 'SOS'
                    return position, consumed
            
            elif msg_type == 'GTSPD':
                # Speed alert
                position = await self._parse_queclink_position(fields, msg_type, known_imei)
                if position:
                    position.sensors['alert_type'] = 'speed'
                    return position, consumed
            
            elif msg_type == 'GTPNA':
                # Power on
                position = await self._parse_queclink_position(fields, msg_type, known_imei)
                if position:
                    position.sensors['event'] = 'power_on'
                    return position, consumed
            
            elif msg_type == 'GTPFA':
                # Power off
                position = await self._parse_queclink_position(fields, msg_type, known_imei)
                if position:
                    position.sensors['event'] = 'power_off'
                    return position, consumed
            
            elif msg_type in ['GTIGN', 'GTIGF']:
                # Ignition on/off
                position = await self._parse_queclink_position(fields, msg_type, known_imei)
                if position:
                    position.sensors['event'] = 'ignition_on' if msg_type == 'GTIGN' else 'ignition_off'
                    return position, consumed
            
            else:
                logger.debug(f"Queclink: Unhandled message type: {msg_type}")
            
            return None, consumed
            
        except Exception as e:
            logger.error(f"Queclink decode error: {e}", exc_info=True)
            return None, len(data) if len(data) > 0 else 1
    
    async def _parse_queclink_position(
        self, 
        fields: list,
        msg_type: str,
        known_imei: Optional[str]
    ) -> Optional[NormalizedPosition]:
        """
        Parse Queclink position data
        
        Typical field layout (varies by message type):
        0: Protocol version
        1: IMEI
        2: Device name (optional)
        3: State bitmap (optional)
        4: Report ID
        5: Report type
        6: Number
        7: GPS accuracy
        8: Speed
        9: Azimuth (course)
        10: Altitude
        11: Longitude
        12: Latitude
        13: Timestamp (YYYYMMDDHHMMSS)
        14: MCC
        15: MNC
        16: LAC
        17: Cell ID
        18: Reserved
        19: Send time
        20: Count
        
        Args:
            fields: Comma-separated fields
            msg_type: Message type (GTFRI, GTSOS, etc.)
            known_imei: Device IMEI
            
        Returns:
            NormalizedPosition object or None
        """
        try:
            if len(fields) < 15:
                logger.warning(f"Queclink: Not enough fields ({len(fields)})")
                return None
            
            # Extract IMEI (field 1 typically)
            imei = known_imei or fields[1] if len(fields) > 1 else None
            if not imei:
                logger.warning("Queclink: No IMEI")
                return None
            
            # Field positions vary by message type and protocol version
            # We'll try to detect the layout
            
            # Find GPS data fields (look for lat/lon pattern)
            lat_idx = None
            lon_idx = None
            
            for i, field in enumerate(fields):
                if field and '.' in field:
                    try:
                        val = float(field)
                        # Latitude is typically -90 to 90
                        if -90 <= val <= 90 and lat_idx is None:
                            lat_idx = i
                        # Longitude is typically -180 to 180
                        elif -180 <= val <= 180 and lon_idx is None and lat_idx is not None:
                            lon_idx = i
                            break
                    except ValueError:
                        continue
            
            if lat_idx is None or lon_idx is None:
                logger.warning("Queclink: Could not find GPS coordinates")
                return None
            
            # Extract coordinates
            latitude = float(fields[lat_idx])
            longitude = float(fields[lon_idx])
            
            # Extract other data (with safety checks)
            # Speed is usually before coordinates
            speed_idx = lat_idx - 3 if lat_idx >= 3 else None
            speed = 0.0
            if speed_idx and speed_idx < len(fields):
                try:
                    speed = float(fields[speed_idx]) if fields[speed_idx] else 0.0
                except:
                    speed = 0.0
            
            # Course (azimuth) is usually before coordinates
            course_idx = lat_idx - 2 if lat_idx >= 2 else None
            course = 0.0
            if course_idx and course_idx < len(fields):
                try:
                    course = float(fields[course_idx]) if fields[course_idx] else 0.0
                except:
                    course = 0.0
            
            # Altitude is usually before coordinates
            altitude_idx = lat_idx - 1 if lat_idx >= 1 else None
            altitude = 0.0
            if altitude_idx and altitude_idx < len(fields):
                try:
                    altitude = float(fields[altitude_idx]) if fields[altitude_idx] else 0.0
                except:
                    altitude = 0.0
            
            # Timestamp (YYYYMMDDHHMMSS) is usually after coordinates
            time_idx = lon_idx + 1 if lon_idx + 1 < len(fields) else None
            device_time = datetime.now(timezone.utc)
            
            if time_idx and time_idx < len(fields) and fields[time_idx]:
                time_str = fields[time_idx]
                if len(time_str) >= 14:
                    try:
                        device_time = datetime(
                            int(time_str[0:4]),   # Year
                            int(time_str[4:6]),   # Month
                            int(time_str[6:8]),   # Day
                            int(time_str[8:10]),  # Hour
                            int(time_str[10:12]), # Minute
                            int(time_str[12:14]), # Second
                            tzinfo=timezone.utc
                        )
                    except:
                        pass
            
            # GPS accuracy (field before speed, typically)
            accuracy_idx = speed_idx - 1 if speed_idx and speed_idx >= 1 else None
            satellites = 0
            if accuracy_idx and accuracy_idx < len(fields):
                try:
                    # GPS accuracy in Queclink can be number of satellites or HDOP
                    acc_val = fields[accuracy_idx]
                    if acc_val:
                        satellites = int(float(acc_val))
                except:
                    pass
            
            # Extract sensor data
            sensors = {}
            sensors['message_type'] = msg_type
            
            # Report ID
            if len(fields) > 4:
                sensors['report_id'] = fields[4]
            
            # MCC, MNC, LAC, Cell ID (cellular info)
            if lon_idx + 2 < len(fields):
                try:
                    mcc_idx = lon_idx + 2
                    if mcc_idx + 3 < len(fields):
                        mcc = fields[mcc_idx] if fields[mcc_idx] else None
                        mnc = fields[mcc_idx + 1] if fields[mcc_idx + 1] else None
                        lac = fields[mcc_idx + 2] if fields[mcc_idx + 2] else None
                        cell_id = fields[mcc_idx + 3] if fields[mcc_idx + 3] else None
                        
                        if mcc:
                            sensors['mcc'] = mcc
                        if mnc:
                            sensors['mnc'] = mnc
                        if lac:
                            sensors['lac'] = lac
                        if cell_id:
                            sensors['cell_id'] = cell_id
                except:
                    pass
            
            # Protocol version
            if len(fields) > 0 and fields[0]:
                sensors['protocol_version'] = fields[0]
            
            # Device name (if present)
            if len(fields) > 2 and fields[2]:
                sensors['device_name'] = fields[2]
            
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
                valid=True,  # Queclink only reports when GPS is valid
                sensors=sensors
            )
            
            logger.debug(f"Queclink decoded position: {imei} @ {latitude},{longitude}")
            return position
            
        except Exception as e:
            logger.error(f"Queclink position parse error: {e}", exc_info=True)
            return None
    
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """
        Encode command for Queclink device
        
        Queclink uses AT-style commands sent over TCP/UDP.
        
        Command format: AT+COMMAND=param1,param2,...<CR><LF>
        
        Args:
            command_type: Type of command
            params: Command parameters
            
        Returns:
            Encoded command bytes
        """
        try:
            password = params.get('password', '000000')  # Default Queclink password
            
            if command_type == 'reboot':
                # Reboot device
                command = f"AT+GTRTO={password},,,,0002$"
                
            elif command_type == 'get_version':
                # Get firmware version
                command = f"AT+GTVER={password},,0003$"
                
            elif command_type == 'set_interval':
                # Set reporting interval
                interval = params.get('interval', 30)  # seconds
                command = f"AT+GTFRI={password},{interval},,,,0004$"
                
            elif command_type == 'request_position':
                # Request immediate position
                command = f"AT+GTQSS={password},,0005$"
                
            elif command_type == 'set_server':
                # Set server IP and port
                ip = params.get('ip', '')
                port = params.get('port', 5026)
                command = f"AT+GTBSI={password},{ip},{port},0,0,,,0006$"
                
            elif command_type == 'set_apn':
                # Set APN
                apn = params.get('apn', 'internet')
                command = f"AT+GTBSI={password},,,,0,{apn},,,0007$"
                
            elif command_type == 'enable_output':
                # Enable specific output (GTFRI, GTSOS, etc.)
                output_type = params.get('output_type', 'GTFRI')
                command = f"AT+GTTOW={password},{output_type},1,,0008$"
                
            elif command_type == 'disable_output':
                # Disable specific output
                output_type = params.get('output_type', 'GTFRI')
                command = f"AT+GTTOW={password},{output_type},0,,0009$"
                
            elif command_type == 'custom':
                # Custom AT command
                command = params.get('payload', '')
                if not command.startswith('AT+'):
                    command = f"AT+{command}"
                if not command.endswith('$'):
                    command += '$'
                    
            else:
                logger.warning(f"Queclink: Unknown command type: {command_type}")
                return b''
            
            # Encode as ASCII
            encoded = command.encode('ascii')
            logger.info(f"Queclink command encoded: {command}")
            return encoded
            
        except Exception as e:
            logger.error(f"Queclink command encode error: {e}")
            return b''
    
    def get_available_commands(self) -> list:
        """
        Get list of available commands for Queclink protocol
        
        Returns:
            List of command type strings
        """
        return [
            'reboot',
            'get_version',
            'set_interval',
            'request_position',
            'set_server',
            'set_apn',
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
            'reboot': {
                'description': 'Reboot the device',
                'params': {
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"password": "000000"}'
            },
            'get_version': {
                'description': 'Get firmware version',
                'params': {
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"password": "000000"}'
            },
            'set_interval': {
                'description': 'Set reporting interval',
                'params': {
                    'interval': 'Interval in seconds',
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"interval": 30, "password": "000000"}'
            },
            'request_position': {
                'description': 'Request immediate GPS position',
                'params': {
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"password": "000000"}'
            },
            'set_server': {
                'description': 'Configure server IP and port',
                'params': {
                    'ip': 'Server IP address',
                    'port': 'Server port (default: 5026)',
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"ip": "192.168.1.100", "port": 5026, "password": "000000"}'
            },
            'set_apn': {
                'description': 'Configure APN for GPRS',
                'params': {
                    'apn': 'APN name',
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"apn": "internet", "password": "000000"}'
            },
            'enable_output': {
                'description': 'Enable specific message output',
                'params': {
                    'output_type': 'Output type (GTFRI, GTSOS, etc.)',
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"output_type": "GTFRI", "password": "000000"}'
            },
            'disable_output': {
                'description': 'Disable specific message output',
                'params': {
                    'output_type': 'Output type (GTFRI, GTSOS, etc.)',
                    'password': 'Device password (default: 000000)'
                },
                'example': '{"output_type": "GTFRI", "password": "000000"}'
            },
            'custom': {
                'description': 'Send custom AT command',
                'params': {
                    'payload': 'AT command string'
                },
                'example': '{"payload": "AT+GTVER=000000,,0003$"}'
            }
        }
        
        return command_info.get(command_type, {
            'description': 'Unknown command',
            'params': {},
            'example': '{}'
        })
