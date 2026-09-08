"""
Teltonika CAN Bus Extended Telemetry Decoder Example
"""
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple, Union

from models.schemas import NormalizedPosition
from protocols import BaseProtocolDecoder, ProtocolRegistry


@ProtocolRegistry.register("teltonika_can_extended")
class TeltonikaCANExtendedDecoder(BaseProtocolDecoder):
    PORT = 5094
    PROTOCOL_TYPES = ["tcp"]

    async def decode(
        self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """Decode extended Teltonika CAN telemetry."""
        if len(data) < 10:
            return None, len(data)

        try:
            text = data.decode("ascii", errors="ignore").strip()
            if text.startswith("TCAN,"):
                parts = text.split(",")
                if len(parts) >= 7:
                    imei = parts[1]
                    lat = float(parts[2])
                    lon = float(parts[3])
                    speed = float(parts[4])
                    axle_weight = float(parts[5])
                    tacho_state = parts[6]
                    pos = NormalizedPosition(
                        imei=imei,
                        protocol="teltonika_can_extended",
                        latitude=lat,
                        longitude=lon,
                        speed=speed,
                        course=0.0,
                        altitude=0.0,
                        device_time=datetime.now(timezone.utc),
                        ignition=speed > 0 or tacho_state == "driving",
                        sensors={
                            "axle_weight_kg": axle_weight,
                            "tacho_state": tacho_state,
                        },
                    )
                    return pos, len(data)
        except Exception:
            pass

        return None, len(data)

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        return b""
