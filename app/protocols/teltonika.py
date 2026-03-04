import struct
import uuid
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

    # ================================================================== #
    #  Command Registry (Mapping + Metadata merged)                      #
    # ================================================================== #
    COMMAND_REGISTRY = {
        'cpureset': {
            'cmd': 'cpureset',
            'description': 'Reset the device CPU',
            'example': 'cpureset',
            'requires_params': False
        },
        'getver': {
            'cmd': 'getver',
            'description': 'Get firmware version',
            'example': 'getver',
            'requires_params': False
        },
        'getgps': {
            'cmd': 'getgps',
            'description': 'Get current GPS position',
            'example': 'getgps',
            'requires_params': False
        },
        'readio': {
            'cmd': 'readio',
            'description': 'Read I/O status',
            'example': 'readio',
            'requires_params': False
        },
        'getrecord': {
            'cmd': 'getrecord',
            'description': 'Get last record',
            'example': 'getrecord',
            'requires_params': False
        },
        'ggps': {
            'cmd': 'ggps',
            'description': 'Get GPS coordinates',
            'example': 'ggps',
            'requires_params': False
        },
        'getinfo': {
            'cmd': 'getinfo',
            'description': 'Get device information',
            'example': 'getinfo',
            'requires_params': False
        },
        'setparam': {
            'cmd': 'setparam',
            'description': 'Set a device parameter',
            'example': 'setparam 1000:60',
            'requires_params': True
        },
        'getparam': {
            'cmd': 'getparam',
            'description': 'Get parameter value',
            'example': 'getparam 1000',
            'requires_params': True
        },
        'flush': {
            'cmd': 'flush',
            'description': 'Flush stored records',
            'example': 'flush',
            'requires_params': False
        },
        'readstatus': {
            'cmd': 'readstatus',
            'description': 'Read device status',
            'example': 'readstatus',
            'requires_params': False
        },
        'getimei': {
            'cmd': 'getimei',
            'description': 'Get IMEI number',
            'example': 'getimei',
            'requires_params': False
        },
        'custom': {
            'cmd': None,  # Special handling in encode code
            'description': 'Send custom command (text/hex)',
            'example': 'Any text or hex',
            'requires_params': True
        },
    }

    # ================================================================== #
    #  IO Definitions (List of Dictionaries)                             #
    # ================================================================== #
    IO_DEFINITIONS = [
        # --- Digital / Analog inputs ---
        {'id': 1, 'name': 'din1'},
        {'id': 2, 'name': 'din2'},
        {'id': 3, 'name': 'din3'},
        {'id': 4, 'name': 'pulse_counter_din1'},
        {'id': 5, 'name': 'pulse_counter_din2'},
        {'id': 6, 'name': 'analog_input2', 'multiplier': 0.001},  # mV -> V
        {'id': 9, 'name': 'analog_input1', 'multiplier': 0.001},  # mV -> V
        {'id': 11, 'name': 'iccid1'},
        {'id': 12, 'name': 'fuel_used', 'multiplier': 0.001},
        {'id': 13, 'name': 'fuel_rate', 'multiplier': 0.01},  # L/100km
        {'id': 14, 'name': 'iccid2'},
        {'id': 15, 'name': 'eco_score', 'multiplier': 0.01},
        {'id': 16, 'name': 'odometer', 'multiplier': 0.001},  # m -> km
        {'id': 17, 'name': 'axis_x'},
        {'id': 18, 'name': 'axis_y'},
        {'id': 19, 'name': 'axis_z'},
        {'id': 20, 'name': 'ble_battery2'},
        {'id': 21, 'name': 'gsm_signal'},
        {'id': 22, 'name': 'ble_battery3'},
        {'id': 23, 'name': 'ble_battery4'},
        {'id': 24, 'name': 'speed'},
        {'id': 25, 'name': 'ble_temp1', 'multiplier': 0.01},
        {'id': 26, 'name': 'ble_temp2', 'multiplier': 0.01},
        {'id': 27, 'name': 'ble_temp3', 'multiplier': 0.01},
        {'id': 28, 'name': 'ble_temp4', 'multiplier': 0.01},
        {'id': 29, 'name': 'ble_battery1'},
        {'id': 31, 'name': 'obd_engine_load'},
        {'id': 32, 'name': 'obd_coolant_temp'},
        {'id': 36, 'name': 'obd_rpm'},
        {'id': 66, 'name': 'external_voltage', 'multiplier': 0.001},
        {'id': 67, 'name': 'battery_voltage', 'multiplier': 0.001},
        {'id': 68, 'name': 'battery_current', 'multiplier': 0.001},
        {'id': 69, 'name': 'gnss_status'},
        {'id': 72, 'name': 'dallas_temp1', 'multiplier': 0.1},
        {'id': 73, 'name': 'dallas_temp2', 'multiplier': 0.1},
        {'id': 74, 'name': 'dallas_temp3', 'multiplier': 0.1},
        {'id': 75, 'name': 'dallas_temp4', 'multiplier': 0.1},
        {'id': 80, 'name': 'data_mode'},
        {'id': 81, 'name': 'obd_speed'},
        {'id': 82, 'name': 'obd_throttle'},
        {'id': 83, 'name': 'obd_fuel_used', 'multiplier': 0.1},
        {'id': 84, 'name': 'obd_fuel_level', 'multiplier': 0.1},
        {'id': 85, 'name': 'obd_rpm'},
        {'id': 86, 'name': 'ble_humidity1', 'multiplier': 0.1},
        {'id': 87, 'name': 'obd_odometer', 'multiplier': 0.001},
        {'id': 89, 'name': 'fuel_level_percent'},
        {'id': 104, 'name': 'ble_humidity2', 'multiplier': 0.1},
        {'id': 106, 'name': 'ble_humidity3', 'multiplier': 0.1},
        {'id': 108, 'name': 'ble_humidity4', 'multiplier': 0.1},
        {'id': 113, 'name': 'battery_level_percent'},
        {'id': 115, 'name': 'engine_temp', 'multiplier': 0.1},
        {'id': 175, 'name': 'auto_geofence'},
        {'id': 179, 'name': 'dout1'},
        {'id': 180, 'name': 'dout2'},
        {'id': 181, 'name': 'pdop', 'multiplier': 0.1},
        {'id': 182, 'name': 'hdop', 'multiplier': 0.1},
        {'id': 199, 'name': 'trip_odometer', 'multiplier': 0.001},  # m -> km
        {'id': 200, 'name': 'sleep_mode'},
        {'id': 205, 'name': 'cell_id_gsm'},
        {'id': 206, 'name': 'gsm_area_code'},
        {'id': 236, 'name': 'alarm'},
        {'id': 237, 'name': 'network_type'},
        {'id': 238, 'name': 'user_id'},
        {'id': 239, 'name': 'ignition'},
        {'id': 240, 'name': 'movement'},
        {'id': 241, 'name': 'gsm_operator'},
        {'id': 246, 'name': 'towing'},
        {'id': 247, 'name': 'crash_detection'},
        {'id': 248, 'name': 'immobilizer'},
        {'id': 249, 'name': 'jamming'},
        {'id': 250, 'name': 'trip_event'},
        {'id': 251, 'name': 'idling'},
        {'id': 252, 'name': 'unplug_detection'},
        {'id': 257, 'name': 'crash_trace_data'},
        {'id': 385, 'name': 'beacon_ids'},
        {'id': 636, 'name': 'cell_id_4g'},
        {'id': 13201, 'name': 'pcb_temp', 'multiplier': 0.1},
    ]

    # Pre-calculated lookups for O(1) access during decode
    _io_name_map: Dict[int, str] = {}
    _io_mult_map: Dict[int, float] = {}

    def __init__(self):
        super().__init__()
        # Build lookup maps if not already built (safe for multiple instances)
        if not self._io_name_map:
            self._build_lookups()

    @classmethod
    def _build_lookups(cls):
        """Convert list of dicts to efficient lookup dicts."""
        for item in cls.IO_DEFINITIONS:
            io_id = item['id']
            cls._io_name_map[io_id] = item['name']
            if 'multiplier' in item:
                cls._io_mult_map[io_id] = item['multiplier']

    # ================================================================== #
    #  Public interface                                                    #
    # ================================================================== #

    async def decode(
        self,
        data: bytes,
        client_info: Dict[str, Any],
        known_imei: Optional[str] = None,
    ) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        try:
            # ---- TCP data packet ----------------------------------------
            if len(data) >= 8 and data[0:4] == b'\x00\x00\x00\x00':
                data_length = struct.unpack('>I', data[4:8])[0]
                total_len = 8 + data_length + 4
                if len(data) < total_len:
                    return None, 0  # wait for more bytes

                packet_data = data[8:8 + data_length]
                consumed = total_len

                if len(packet_data) < 2:
                    return None, consumed

                codec_id = packet_data[0]
                record_count = packet_data[1]

                if codec_id in (0x08, 0x8E):
                    extended = (codec_id == 0x8E)
                    positions = self._decode_all_records(
                        packet_data[2:], known_imei, extended
                    )
                    ack = struct.pack('>I', record_count)

                    if positions:
                        return {
                            'position': positions[0],
                            'response': ack,
                            'extra_positions': positions[1:],
                        }, consumed
                    else:
                        return {'response': ack}, consumed

                else:
                    logger.warning(f"Teltonika: unsupported codec 0x{codec_id:02X}")
                    return None, consumed

            # ---- IMEI login packet --------------------------------------
            elif len(data) >= 2:
                imei_len = struct.unpack('>H', data[0:2])[0]
                if imei_len == 0:
                    return None, 1 if len(data) >= 4 else 0
                if len(data) >= imei_len + 2:
                    try:
                        imei = data[2:2 + imei_len].decode('ascii')
                        logger.info(f"Teltonika login: IMEI={imei}")
                        return {'event': 'login', 'imei': imei, 'response': b'\x01'}, imei_len + 2
                    except UnicodeDecodeError:
                        return None, 1
                return None, 0

            return None, 0

        except Exception as exc:
            logger.error(f"Teltonika decode error: {exc}", exc_info=True)
            return None, 1

    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        if not params:
            params = {}
        
        cmd_info = self.COMMAND_REGISTRY.get(command_type.lower())
        
        if command_type == 'custom':
            payload = params.get('payload', '').strip()
            if not payload:
                return b''
            # If the string looks like hex, send binary; otherwise send as text.
            if len(payload) % 2 == 0 and all(c in '0123456789ABCDEFabcdef' for c in payload):
                try:
                    return bytes.fromhex(payload)
                except ValueError:
                    pass
            return self._encode_text_command(payload)

        if not cmd_info:
            return b''

        cmd_str = cmd_info.get('cmd')
        if not cmd_str:
            return b''

        if params:
            # Simple space concatenation for parameters
            param_str = ' '.join(str(v) for v in params.values())
            cmd_str = f'{cmd_str} {param_str}'

        return self._encode_text_command(cmd_str)

    def get_available_commands(self) -> List[str]:
        return list(self.COMMAND_REGISTRY.keys())

    def get_command_info(self, command: str) -> Dict[str, Any]:
        info = self.COMMAND_REGISTRY.get(command)
        if info:
            # Return copy to prevent mutation, filter out internal 'cmd' key if preferred
            return {
                'description': info['description'],
                'example': info['example'],
                'requires_params': info['requires_params']
            }
        return {'description': 'Unknown command', 'example': '', 'requires_params': False}

    # ================================================================== #
    #  Internal: single-record decoder                                     #
    # ================================================================== #

    def _decode_beacon_list(self, data: bytes) -> List[Dict[str, Any]]:
        """Decode Teltonika Beacon List (IO 385)."""
        results = []
        if len(data) < 1:
            return results

        # Byte 0 is usually record count or part info.
        # We skip it and parse until data ends.
        offset = 1

        while offset < len(data):
            # Need at least 1 byte for flags
            if offset + 1 > len(data):
                break

            flags = data[offset]
            offset += 1

            # Parse flags
            has_rssi = bool(flags & 0x01)
            has_battery = bool(flags & 0x02)
            has_temp = bool(flags & 0x04)
            is_ibeacon = bool(flags & 0x20)

            beacon = {}

            # RSSI (1 byte signed)
            if has_rssi:
                if offset + 1 > len(data): break
                beacon['rssi'] = struct.unpack('b', data[offset:offset + 1])[0]
                offset += 1

            # Battery (2 bytes unsigned, mV)
            if has_battery:
                if offset + 2 > len(data): break
                beacon['battery'] = struct.unpack('>H', data[offset:offset + 2])[0]
                offset += 2

            # Temp (2 bytes signed, 0.01 C or similar)
            if has_temp:
                if offset + 2 > len(data): break
                beacon['temp'] = struct.unpack('>h', data[offset:offset + 2])[0]
                offset += 2

            # Beacon ID
            if is_ibeacon:
                # UUID (16) + Major (2) + Minor (2) = 20 bytes
                if offset + 20 > len(data): break
                uuid_bytes = data[offset:offset + 16]
                major = struct.unpack('>H', data[offset + 16:offset + 18])[0]
                minor = struct.unpack('>H', data[offset + 18:offset + 20])[0]
                offset += 20

                beacon['type'] = 'ibeacon'
                beacon['uuid'] = str(uuid.UUID(bytes=uuid_bytes))
                beacon['major'] = major
                beacon['minor'] = minor
                beacon['id'] = f"{beacon['uuid']}:{major}:{minor}"
            else:
                # Eddystone: Namespace (10) + Instance (6) = 16 bytes
                if offset + 16 > len(data): break
                namespace = data[offset:offset + 10].hex()
                instance = data[offset + 10:offset + 16].hex()
                offset += 16

                beacon['type'] = 'eddystone'
                beacon['namespace'] = namespace
                beacon['instance'] = instance
                beacon['id'] = f"{namespace}:{instance}"

            results.append(beacon)

        return results

    def _decode_single_record(
        self,
        data: bytes,
        offset: int,
        known_imei: str,
        extended: bool,
    ) -> Tuple[Optional[NormalizedPosition], int]:
        
        start = offset

        # --- Timestamp ---------------------------------------------------
        if offset + 8 > len(data):
            return None, 0
        timestamp_ms = struct.unpack('>Q', data[offset:offset + 8])[0]
        device_time = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
        offset += 8

        # --- Priority ----------------------------------------------------
        if offset + 1 > len(data):
            return None, 0
        priority = data[offset]
        offset += 1

        # --- GPS element (15 bytes) --------------------------------------
        if offset + 15 > len(data):
            return None, 0

        lon = struct.unpack('>i', data[offset:offset + 4])[0] / 10_000_000.0
        lat = struct.unpack('>i', data[offset + 4:offset + 8])[0] / 10_000_000.0
        alt = struct.unpack('>h', data[offset + 8:offset + 10])[0]
        angle = struct.unpack('>H', data[offset + 10:offset + 12])[0]
        sats = data[offset + 12]
        speed = struct.unpack('>H', data[offset + 13:offset + 15])[0]
        offset += 15

        valid_gps = not (lat == 0.0 and lon == 0.0)

        # --- IO element header -------------------------------------------
        header_size = 4 if extended else 2
        if offset + header_size > len(data):
            return None, 0
        offset += header_size

        # --- IO elements -------------------------------------------------
        ignition: Optional[bool] = None
        sensors: Dict[str, Any] = {}

        id_width = 2 if extended else 1
        count_width = 2 if extended else 1

        def read_count() -> int:
            nonlocal offset
            if offset + count_width > len(data):
                return 0
            if extended:
                val = struct.unpack('>H', data[offset:offset + 2])[0]
            else:
                val = data[offset]
            offset += count_width
            return val

        def read_id() -> int:
            nonlocal offset
            if extended:
                val = struct.unpack('>H', data[offset:offset + 2])[0]
            else:
                val = data[offset]
            offset += id_width
            return val

        def parse_io_group(byte_width: int, unpack_fn) -> None:
            nonlocal offset, ignition
            count = read_count()
            for _ in range(count):
                if offset + id_width + byte_width > len(data):
                    break
                io_id = read_id()
                val_bytes = data[offset:offset + byte_width]
                raw = unpack_fn(val_bytes)
                offset += byte_width

                # Ignition is a special top-level field
                if io_id == 239:
                    ignition = bool(raw)

                # Look up multiplier
                multiplier = self._io_mult_map.get(io_id)
                if multiplier is not None:
                    val = round(float(raw) * multiplier, 3)
                else:
                    val = raw

                # Look up name
                key = self._io_name_map.get(io_id, f'io_{io_id}')
                sensors[key] = val

        parse_io_group(1, lambda b: b[0])
        parse_io_group(2, lambda b: struct.unpack('>H', b)[0])
        parse_io_group(4, lambda b: struct.unpack('>I', b)[0])
        parse_io_group(8, lambda b: struct.unpack('>Q', b)[0])
        # NX group: variable-length elements, extended (8E) only
        # Each element: ID (2 bytes) + length (2 bytes) + value (length bytes)
        if extended:
            nx_count = read_count()
            for _ in range(nx_count):
                if offset + id_width + 2 > len(data):
                    break
                io_id = read_id()
                if offset + 2 > len(data):
                    break
                val_len = struct.unpack('>H', data[offset:offset + 2])[0]
                offset += 2
                if offset + val_len > len(data):
                    break
                val_bytes = data[offset:offset + val_len]
                offset += val_len
                key = self._io_name_map.get(io_id, f'io_{io_id}')
                
                if io_id == 385:
                    sensors[key] = self._decode_beacon_list(val_bytes)
                else:
                    sensors[key] = val_bytes.hex()

        # No per-record footer in codec 8 or 8E.
        # The packet-level end marker lives outside records_data in decode().
        consumed = offset - start
        if not valid_gps:
            logger.debug(f"Teltonika: dropping record with lat=0, lon=0 (no fix) for {known_imei}")
            return None, consumed

        position = NormalizedPosition(
            imei=known_imei,
            device_time=device_time,
            server_time=datetime.now(timezone.utc),
            latitude=lat,
            longitude=lon,
            altitude=float(alt),
            speed=float(speed),
            course=float(angle),
            satellites=sats,
            ignition=ignition,
            sensors=sensors,
            raw_data={'priority': priority, 'codec': '8E' if extended else '8'},
        )

        return position, consumed

    # ================================================================== #
    #  Internal: multi-record decoder                                      #
    # ================================================================== #

    def _decode_all_records(
        self,
        data: bytes,
        known_imei: Optional[str],
        extended: bool,
    ) -> List[NormalizedPosition]:
        if not known_imei:
            return []

        positions: List[NormalizedPosition] = []
        offset = 0

        while offset < len(data):
            try:
                pos, consumed = self._decode_single_record(data, offset, known_imei, extended)
                if consumed == 0:
                    break
                offset += consumed
                if pos is not None:
                    positions.append(pos)
            except Exception as exc:
                logger.error(
                    f"Teltonika: record decode error at offset {offset}: {exc}",
                    exc_info=True,
                )
                break

        return positions

    # ================================================================== #
    #  Internal: command encoding                                          #
    # ================================================================== #

    def _encode_text_command(self, command_text: str) -> bytes:
        cmd_bytes = command_text.encode('ascii')
        cmd_length = len(cmd_bytes)

        codec_id = 0x0C
        cmd_quantity = 0x01
        cmd_type = 0x05

        data_part = (
            struct.pack('B', codec_id) +
            struct.pack('B', cmd_quantity) +
            struct.pack('B', cmd_type) +
            struct.pack('>I', cmd_length) +
            cmd_bytes +
            struct.pack('B', cmd_quantity)
        )

        crc = self._crc16(data_part)
        data_field_length = 1 + 1 + cmd_length + 1

        return (
            b'\x00\x00\x00\x00' +
            struct.pack('>I', data_field_length) +
            data_part +
            struct.pack('>I', crc)
        )

    @staticmethod
    def _crc16(data: bytes) -> int:
        crc = 0
        for byte in data:
            crc ^= byte
            for _ in range(8):
                crc = (crc >> 1) ^ 0xA001 if (crc & 1) else (crc >> 1)
        return crc & 0xFFFF
