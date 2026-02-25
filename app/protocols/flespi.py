"""
Flespi Protocol Decoder
Supports Flespi's standardized message format for GPS tracking devices
"""
import struct
import json
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("flespi")
class FlespiDecoder(BaseProtocolDecoder):
    """
    Flespi Protocol Decoder
    
    Flespi uses a JSON-based protocol over TCP/UDP for device communication.
    Messages contain telemetry data in a structured JSON format.
    
    Port: 5149 (TCP)
    Format: JSON messages with standardized field names
    """
    
    PORT = 5149
    PROTOCOL_TYPES = ['tcp']
    
    # Flespi standard field mappings
    FIELD_MAPPING = {
        'position.latitude': 'latitude',
        'position.longitude': 'longitude',
        'position.altitude': 'altitude',
        'position.speed': 'speed',
        'position.direction': 'course',
        'position.satellites': 'satellites',
        'device.ident': 'ident',
        'server.timestamp': 'timestamp',
        'position.valid': 'valid',
        'engine.ignition.status': 'ignition',
        'battery.voltage': 'battery_voltage',
        'external.powersource.voltage': 'external_voltage',
        'gnss.hdop': 'hdop',
        'gsm.signal.level': 'rssi',
        'engine.rpm': 'rpm',
        'fuel.level': 'fuel_level',
        'vehicle.mileage': 'odometer',
    }
    
    async def decode(
        self, 
        data: bytes, 
        client_info: Dict[str, Any], 
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """
        Decode Flespi JSON message
        
        Args:
            data: Raw bytes from device
            client_info: Client connection metadata
            known_imei: Known device IMEI (if authenticated)
            
        Returns:
            Tuple of (decoded_data, bytes_consumed)
        """
        try:
            # Flespi messages are JSON strings, typically newline-delimited
            # Try to find a complete JSON message
            
            # Check if we have any data
            if not data or len(data) == 0:
                return None, 0
            
            # Try to decode as UTF-8
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                logger.error("Flespi: Failed to decode UTF-8")
                return None, 1  # Skip one byte and try again
            
            # Find the first newline (message delimiter)
            newline_idx = text.find('\n')
            if newline_idx == -1:
                # No complete message yet, need more data
                if len(data) > 8192:  # Prevent buffer overflow
                    logger.warning("Flespi: Buffer too large without newline, resetting")
                    return None, len(data)
                return None, 0
            
            # Extract the complete JSON message
            json_str = text[:newline_idx].strip()
            consumed = len(json_str.encode('utf-8')) + 1  # +1 for newline
            
            if not json_str:
                return None, consumed
            
            # Parse JSON
            try:
                message = json.loads(json_str)
            except json.JSONDecodeError as e:
                logger.error(f"Flespi: JSON decode error: {e}")
                return None, consumed
            
            # Handle different message types
            if isinstance(message, dict):
                # Check for login/authentication message
                if 'ident' in message or 'device.ident' in message:
                    ident = message.get('ident') or message.get('device.ident')
                    if ident and not known_imei:
                        # This is a login message
                        logger.info(f"Flespi login: {ident}")
                        return {
                            "event": "login",
                            "imei": str(ident),
                            "response": b'{"status": "ok"}\n'
                        }, consumed
                
                # Parse telemetry message
                position = await self._parse_flespi_message(message, known_imei)
                if position:
                    return position, consumed
            
            elif isinstance(message, list):
                # Batch of messages
                positions = []
                for msg in message:
                    pos = await self._parse_flespi_message(msg, known_imei)
                    if pos:
                        positions.append(pos)
                
                # Return the first position (or None if empty)
                # Note: In a production system, you might want to handle batch processing
                if positions:
                    return positions[0], consumed
            
            # Unknown message format
            logger.warning(f"Flespi: Unknown message format")
            return None, consumed
            
        except Exception as e:
            logger.error(f"Flespi decode error: {e}", exc_info=True)
            return None, 1
    
    async def _parse_flespi_message(
        self, 
        message: Dict[str, Any], 
        known_imei: Optional[str]
    ) -> Optional[NormalizedPosition]:
        """
        Parse a single Flespi telemetry message into NormalizedPosition
        
        Args:
            message: Parsed JSON message dictionary
            known_imei: Device IMEI
            
        Returns:
            NormalizedPosition object or None
        """
        try:
            # Extract IMEI/identifier
            imei = known_imei
            if not imei:
                imei = message.get('ident') or message.get('device.ident')
                if imei:
                    imei = str(imei)
            
            if not imei:
                logger.warning("Flespi: No IMEI in message")
                return None
            
            # Extract timestamp
            timestamp = message.get('timestamp') or message.get('server.timestamp')
            if timestamp:
                # Flespi uses Unix timestamp (seconds or milliseconds)
                if timestamp > 10000000000:  # Milliseconds
                    device_time = datetime.fromtimestamp(timestamp / 1000.0, tz=timezone.utc)
                else:  # Seconds
                    device_time = datetime.fromtimestamp(timestamp, tz=timezone.utc)
            else:
                device_time = datetime.now(timezone.utc)
            
            # Extract GPS coordinates
            latitude = self._get_nested_value(message, ['position.latitude', 'lat', 'latitude'])
            longitude = self._get_nested_value(message, ['position.longitude', 'lon', 'longitude'])
            
            if latitude is None or longitude is None:
                logger.warning("Flespi: Missing GPS coordinates")
                return None
            
            # Extract other position data
            altitude = self._get_nested_value(message, ['position.altitude', 'alt', 'altitude']) or 0
            speed = self._get_nested_value(message, ['position.speed', 'speed']) or 0
            course = self._get_nested_value(message, ['position.direction', 'course', 'heading']) or 0
            satellites = self._get_nested_value(message, ['position.satellites', 'sat', 'satellites']) or 0
            
            # GPS validity
            valid = self._get_nested_value(message, ['position.valid', 'valid'])
            if valid is None:
                valid = True  # Assume valid if not specified
            
            # Extract sensor data
            sensors = {}
            
            # Ignition
            ignition = self._get_nested_value(message, ['engine.ignition.status', 'ignition'])
            if ignition is not None:
                sensors['ignition'] = bool(ignition)
            
            # Battery voltage
            battery = self._get_nested_value(message, ['battery.voltage', 'battery_voltage'])
            if battery is not None:
                sensors['battery_voltage'] = float(battery)
            
            # External voltage
            ext_voltage = self._get_nested_value(message, ['external.powersource.voltage', 'external_voltage'])
            if ext_voltage is not None:
                sensors['external_voltage'] = float(ext_voltage)
            
            # HDOP
            hdop = self._get_nested_value(message, ['gnss.hdop', 'hdop'])
            if hdop is not None:
                sensors['hdop'] = float(hdop)
            
            # Signal strength
            rssi = self._get_nested_value(message, ['gsm.signal.level', 'rssi', 'signal'])
            if rssi is not None:
                sensors['rssi'] = int(rssi)
            
            # RPM
            rpm = self._get_nested_value(message, ['engine.rpm', 'rpm'])
            if rpm is not None:
                sensors['rpm'] = int(rpm)
            
            # Fuel level
            fuel = self._get_nested_value(message, ['fuel.level', 'fuel_level'])
            if fuel is not None:
                sensors['fuel_level'] = float(fuel)
            
            # Odometer
            odometer = self._get_nested_value(message, ['vehicle.mileage', 'odometer', 'mileage'])
            if odometer is not None:
                sensors['odometer'] = float(odometer)
            
            # Add any other custom fields
            for key, value in message.items():
                if key not in ['ident', 'device.ident', 'timestamp', 'server.timestamp'] and \
                   not key.startswith('position.') and \
                   key not in sensors:
                    sensors[key] = value
            
            # Create normalized position
            position = NormalizedPosition(
                imei=imei,
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=float(latitude),
                longitude=float(longitude),
                altitude=float(altitude),
                speed=float(speed),
                course=float(course),
                satellites=int(satellites),
                valid=bool(valid),
                ignition=bool(ignition) if ignition is not None else None,
                sensors=sensors
            )
            
            logger.debug(f"Flespi decoded position: {imei} @ {latitude},{longitude}")
            return position
            
        except Exception as e:
            logger.error(f"Flespi message parse error: {e}", exc_info=True)
            return None
    
    def _get_nested_value(self, data: Dict[str, Any], keys: list) -> Any:
        """
        Try to get a value from multiple possible key names
        
        Args:
            data: Dictionary to search
            keys: List of possible key names to try
            
        Returns:
            Value if found, None otherwise
        """
        for key in keys:
            if key in data:
                return data[key]
        return None
    
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """
        Encode command for Flespi device
        
        Flespi supports JSON-based commands sent to devices.
        
        Args:
            command_type: Type of command (e.g., 'custom', 'config', 'reboot')
            params: Command parameters
            
        Returns:
            Encoded command bytes
        """
        try:
            # Build command message
            command_msg = {
                "command": command_type,
                "timestamp": datetime.now(timezone.utc).timestamp()
            }
            
            # Add parameters
            if params:
                payload = params.get('payload', {})
                if isinstance(payload, str):
                    try:
                        payload = json.loads(payload)
                    except json.JSONDecodeError:
                        payload = {"data": payload}
                
                command_msg.update(payload)
            
            # Encode as JSON with newline delimiter
            json_str = json.dumps(command_msg) + "\n"
            return json_str.encode('utf-8')
            
        except Exception as e:
            logger.error(f"Flespi command encode error: {e}")
            return b''
    
    def get_available_commands(self) -> list:
        """
        Get list of available commands for Flespi protocol
        
        Returns:
            List of command type strings
        """
        return [
            'custom',
            'reboot',
            'config',
            'request_position',
            'set_interval'
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
            'custom': {
                'description': 'Send custom JSON command',
                'params': {
                    'payload': 'JSON object or string with command data'
                },
                'example': '{"action": "get_status"}'
            },
            'reboot': {
                'description': 'Reboot the device',
                'params': {},
                'example': '{}'
            },
            'config': {
                'description': 'Update device configuration',
                'params': {
                    'payload': 'JSON object with configuration parameters'
                },
                'example': '{"interval": 30, "mode": "tracking"}'
            },
            'request_position': {
                'description': 'Request immediate position update',
                'params': {},
                'example': '{}'
            },
            'set_interval': {
                'description': 'Set reporting interval',
                'params': {
                    'interval': 'Interval in seconds'
                },
                'example': '{"interval": 60}'
            }
        }
        
        return command_info.get(command_type, {
            'description': 'Unknown command',
            'params': {},
            'example': '{}'
        })
