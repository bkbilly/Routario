"""
OBD-II CAN Telemetry Protocol Decoder Example
"""
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple, Union

from models.schemas import NormalizedPosition
from protocols import BaseProtocolDecoder, ProtocolRegistry


@ProtocolRegistry.register("obd2_can_telemetry")
class OBD2CANTelemetryDecoder(BaseProtocolDecoder):
    PORT = 5092
    PROTOCOL_TYPES = ["tcp", "udp"]

    async def decode(
        self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """Decode OBD-II CAN bus stream."""
        if len(data) < 12:
            return None, len(data)

        try:
            text = data.decode("ascii", errors="ignore").strip()
            if text.startswith("OBD,"):
                parts = text.split(",")
                if len(parts) >= 8:
                    imei = parts[1]
                    lat = float(parts[2])
                    lon = float(parts[3])
                    speed = float(parts[4])
                    fuel_pct = float(parts[5])
                    rpm = float(parts[6])
                    fuel_rate = float(parts[7])
                    pos = NormalizedPosition(
                        imei=imei,
                        protocol="obd2_can_telemetry",
                        latitude=lat,
                        longitude=lon,
                        speed=speed,
                        course=0.0,
                        altitude=0.0,
                        device_time=datetime.now(timezone.utc),
                        ignition=rpm > 300,
                        sensors={
                            "fuel": fuel_pct,
                            "rpm": rpm,
                            "fuel_rate": fuel_rate,
                        },
                    )
                    return pos, len(data)
        except Exception:
            pass

        return None, len(data)

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        return b""
