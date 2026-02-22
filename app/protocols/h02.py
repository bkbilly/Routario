from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, Union
from models.schemas import NormalizedPosition
from . import BaseProtocolDecoder, ProtocolRegistry

@ProtocolRegistry.register("h02")
class H02Decoder(BaseProtocolDecoder):
    PORT = 5013
    PROTOCOL_TYPES = ['tcp']
    
    async def decode(self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            msg = data.decode('ascii', errors='ignore').strip()
            if not msg.startswith('*HQ,'): return None, len(data)
            parts = msg[4:].split(',')
            if len(parts) < 12: return None, len(data)
            imei = parts[0]
            if parts[3] != 'A': return None, len(data)
            
            def pc(c, h):
                if not c: return 0.0
                dot = c.find('.')
                if dot == -1: d=float(c[:-2]); m=float(c[-2:])
                else: d=float(c[:dot-2]); m=float(c[dot-2:])
                val = d + m/60
                return -val if h in ['S','W'] else val

            lat = pc(parts[4], parts[5])
            lon = pc(parts[6], parts[7])
            speed = float(parts[8]) * 1.852
            course = float(parts[9])
            ts = parts[2]; ds = parts[10]
            dt = datetime(2000+int(ds[4:6]), int(ds[2:4]), int(ds[0:2]), int(ts[0:2]), int(ts[2:4]), int(ts[4:6]), tzinfo=timezone.utc)
            
            return NormalizedPosition(imei=imei, device_time=dt, latitude=lat, longitude=lon, speed=speed, course=course, ignition=None, sensors={}), len(data)
        except: return None, len(data)

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes: return b''
