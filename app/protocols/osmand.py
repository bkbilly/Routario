"""
OsmAnd Protocol Decoder
Supports the OsmAnd mobile app GPS tracking protocol
"""
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
import logging
from urllib.parse import parse_qs, urlparse
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

logger = logging.getLogger(__name__)

@ProtocolRegistry.register("osmand")
class OsmAndDecoder(BaseProtocolDecoder):
    """
    OsmAnd Protocol Decoder
    
    OsmAnd is a popular open-source mobile navigation app that can send
    GPS tracking data via HTTP GET requests. This decoder supports the
    OsmAnd tracking protocol over TCP with HTTP-style requests.
    
    Port: 5055 (TCP)
    Format: HTTP GET with query parameters
    
    Example request:
    GET /?id=123456&lat=37.7749&lon=-122.4194&speed=45.5&bearing=180&altitude=15&timestamp=1234567890
    """
    
    PORT = 5055
    PROTOCOL_TYPES = ['tcp']
    
    # OsmAnd parameter mapping
    PARAM_MAPPING = {
        'id': 'device_id',
        'deviceid': 'device_id',
        'lat': 'latitude',
        'latitude': 'latitude',
        'lon': 'longitude',
        'longitude': 'longitude',
        'speed': 'speed',
        'bearing': 'course',
        'course': 'course',
        'altitude': 'altitude',
        'alt': 'altitude',
        'hdop': 'hdop',
        'accuracy': 'accuracy',
        'batt': 'battery',
        'battery': 'battery',
        'timestamp': 'timestamp',
        'sat': 'satellites'
    }
    
    async def decode(
        self, 
        data: bytes, 
        client_info: Dict[str, Any], 
        known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """
        Decode OsmAnd HTTP-style GPS data
        
        Args:
            data: Raw bytes from device
            client_info: Client connection metadata
            known_imei: Known device IMEI (if authenticated)
            
        Returns:
            Tuple of (decoded_data, bytes_consumed)
        """
        try:
            # OsmAnd sends HTTP GET requests
            # Look for complete HTTP request (ends with \r\n\r\n or \n\n)
            
            if not data:
                return None, 0
            
            # Try to decode as ASCII/UTF-8
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                try:
                    text = data.decode('ascii', errors='ignore')
                except:
                    logger.error("OsmAnd: Failed to decode request")
                    return None, len(data)
            
            # Check for complete HTTP request
            if '\r\n\r\n' in text:
                end_idx = text.index('\r\n\r\n') + 4
                request_text = text[:end_idx]
                consumed = len(request_text.encode('utf-8'))
            elif '\n\n' in text:
                end_idx = text.index('\n\n') + 2
                request_text = text[:end_idx]
                consumed = len(request_text.encode('utf-8'))
            else:
                # Incomplete request, need more data
                if len(data) > 4096:  # Prevent buffer overflow
                    logger.warning("OsmAnd: Buffer too large, resetting")
                    return None, len(data)
                return None, 0
            
            # Parse HTTP request
            lines = request_text.split('\n')
            if not lines or not lines[0].startswith('GET '):
                logger.warning("OsmAnd: Invalid HTTP request")
                return None, consumed
            
            # Extract URL from first line: "GET /path?params HTTP/1.1"
            first_line = lines[0].strip()
            parts = first_line.split(' ')
            if len(parts) < 2:
                logger.warning("OsmAnd: Malformed request line")
                return None, consumed
            
            url_path = parts[1]
            
            # Parse query parameters
            params = self._parse_url_params(url_path)
            
            if not params:
                logger.warning("OsmAnd: No parameters in request")
                return None, consumed
            
            # Extract device ID (IMEI)
            device_id = known_imei
            if not device_id:
                device_id = params.get('id') or params.get('deviceid')
                
                if not device_id:
                    logger.warning("OsmAnd: No device ID in request")
                    return None, consumed
            
            # Parse position data
            position = await self._parse_osmand_params(params, device_id)
            
            if position:
                # Send HTTP 200 OK response
                response = b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'
                return position, consumed
            else:
                return None, consumed
                
        except Exception as e:
            logger.error(f"OsmAnd decode error: {e}", exc_info=True)
            return None, len(data) if len(data) > 0 else 1
    
    def _parse_url_params(self, url_path: str) -> Dict[str, str]:
        """
        Parse URL query parameters
        
        Args:
            url_path: URL path with query string (e.g., "/?lat=37.7&lon=-122.4")
            
        Returns:
            Dictionary of parameters
        """
        try:
            # Handle both /?params and ?params formats
            if '?' not in url_path:
                return {}
            
            query_string = url_path.split('?', 1)[1]
            
            # Parse query string
            parsed = parse_qs(query_string)
            
            # Flatten single-value lists
            params = {}
            for key, value_list in parsed.items():
                if value_list:
                    params[key] = value_list[0]
            
            return params
        except Exception as e:
            logger.error(f"OsmAnd URL parse error: {e}")
            return {}
    
    async def _parse_osmand_params(
        self, 
        params: Dict[str, str], 
        device_id: str
    ) -> Optional[NormalizedPosition]:
        """
        Parse OsmAnd parameters into NormalizedPosition
        
        Args:
            params: Query parameters dictionary
            device_id: Device IMEI/ID
            
        Returns:
            NormalizedPosition object or None
        """
        try:
            # Extract required fields
            latitude = params.get('lat') or params.get('latitude')
            longitude = params.get('lon') or params.get('longitude')
            
            if latitude is None or longitude is None:
                logger.warning("OsmAnd: Missing GPS coordinates")
                return None
            
            # Convert to float
            try:
                latitude = float(latitude)
                longitude = float(longitude)
            except (ValueError, TypeError):
                logger.warning("OsmAnd: Invalid GPS coordinates")
                return None
            
            # Extract timestamp
            timestamp_str = params.get('timestamp')
            if timestamp_str:
                try:
                    # OsmAnd typically sends Unix timestamp in seconds
                    timestamp = int(float(timestamp_str))
                    if timestamp > 10000000000:  # Milliseconds
                        device_time = datetime.fromtimestamp(timestamp / 1000.0, tz=timezone.utc)
                    else:  # Seconds
                        device_time = datetime.fromtimestamp(timestamp, tz=timezone.utc)
                except (ValueError, TypeError):
                    device_time = datetime.now(timezone.utc)
            else:
                device_time = datetime.now(timezone.utc)
            
            # Extract optional fields with defaults
            speed = float(params.get('speed', 0))  # m/s in OsmAnd
            speed_kmh = speed * 3.6  # Convert m/s to km/h
            
            course = float(params.get('bearing', params.get('course', 0)))
            altitude = float(params.get('altitude', params.get('alt', 0)))
            satellites = int(float(params.get('sat', 0)))
            
            # Extract sensor data
            sensors = {}
            
            # HDOP
            if 'hdop' in params:
                try:
                    sensors['hdop'] = float(params['hdop'])
                except:
                    pass
            
            # Accuracy
            if 'accuracy' in params:
                try:
                    sensors['accuracy'] = float(params['accuracy'])
                except:
                    pass
            
            # Battery
            if 'batt' in params or 'battery' in params:
                try:
                    battery = params.get('batt', params.get('battery'))
                    sensors['battery'] = float(battery)
                except:
                    pass
            
            # Add any other custom parameters
            for key, value in params.items():
                if key not in ['id', 'deviceid', 'lat', 'latitude', 'lon', 'longitude', 
                              'speed', 'bearing', 'course', 'altitude', 'alt', 
                              'timestamp', 'sat', 'hdop', 'accuracy', 'batt', 'battery']:
                    sensors[key] = value
            
            # Create normalized position
            position = NormalizedPosition(
                imei=str(device_id),
                device_time=device_time,
                server_time=datetime.now(timezone.utc),
                latitude=latitude,
                longitude=longitude,
                altitude=altitude,
                speed=speed_kmh,
                course=course,
                satellites=satellites,
                valid=True,  # OsmAnd only sends when GPS has fix
                sensors=sensors
            )
            
            logger.debug(f"OsmAnd decoded position: {device_id} @ {latitude},{longitude}")
            return position
            
        except Exception as e:
            logger.error(f"OsmAnd params parse error: {e}", exc_info=True)
            return None
    
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """
        Encode command for OsmAnd device
        
        OsmAnd is a mobile app that doesn't support server-to-device commands
        in the standard protocol. Commands would need to be sent through push
        notifications or other channels.
        
        Args:
            command_type: Type of command
            params: Command parameters
            
        Returns:
            Empty bytes (commands not supported)
        """
        # OsmAnd protocol doesn't support server-to-device commands
        logger.warning("OsmAnd protocol does not support commands")
        return b''
    
    def get_available_commands(self) -> list:
        """
        Get list of available commands
        
        Returns:
            Empty list (commands not supported)
        """
        return []
    
    def get_command_info(self, command_type: str) -> Dict[str, Any]:
        """
        Get command information
        
        Returns:
            Empty dict (commands not supported)
        """
        return {
            'description': 'OsmAnd protocol does not support commands',
            'supported': False
        }
