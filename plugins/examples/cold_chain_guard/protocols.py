"""
Cold-Chain BLE Beacon Protocol Decoder Example
"""
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple, Union

from models.schemas import NormalizedPosition
from protocols import BaseProtocolDecoder, ProtocolRegistry


@ProtocolRegistry.register("temp_beacon_udp")
class TempBeaconDecoder(BaseProtocolDecoder):
    PORT = 5088
    PROTOCOL_TYPES = ["udp"]

    async def decode(
        self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """Decode incoming temperature beacon packet."""
        if len(data) < 10:
            return None, len(data)

        try:
            text = data.decode("ascii", errors="ignore").strip()
            if text.startswith("TEMP,"):
                parts = text.split(",")
                if len(parts) >= 6:
                    imei = parts[1]
                    lat = float(parts[2])
                    lon = float(parts[3])
                    temp = float(parts[4])
                    humidity = float(parts[5])
                    pos = NormalizedPosition(
                        imei=imei,
                        protocol="temp_beacon_udp",
                        latitude=lat,
                        longitude=lon,
                        speed=0.0,
                        course=0.0,
                        altitude=0.0,
                        device_time=datetime.now(timezone.utc),
                        ignition=True,
                        sensors={"temperature": temp, "humidity": humidity},
                    )
                    return pos, len(data)
        except Exception:
            pass

        return None, len(data)

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        return b""
