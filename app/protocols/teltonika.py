import struct
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

    # ------------------------------------------------------------------ #
    #  Command helpers                                                     #
    # ------------------------------------------------------------------ #
    COMMAND_MAPPING = {
        'cpureset':   'cpureset',
        'getver':     'getver',
        'getgps':     'getgps',
        'readio':     'readio',
        'getrecord':  'getrecord',
        'ggps':       'ggps',
        'getinfo':    'getinfo',
        'setparam':   'setparam',
        'getparam':   'getparam',
        'flush':      'flush',
        'readstatus': 'readstatus',
        'getimei':    'getimei',
    }

    # ------------------------------------------------------------------ #
    #  IO element ID → human-readable name                                #
    # (covers all standard Teltonika AVL IDs for FMB/FMC/FMM families)   #
    # ------------------------------------------------------------------ #
    IO_MAP: Dict[int, str] = {
        # --- Digital / Analog inputs ---
        1:   'din1',
        2:   'din2',
        3:   'din3',
        4:   'din4',
        9:   'adc1',
        10:  'adc2',

        # --- Identification ---
        11:  'iccid1',
        14:  'iccid2',

        # --- Fuel / Engine ---
        12:  'fuel_used',
        13:  'fuel_consumption',
        30:  'fault_count',
        31:  'engine_load',
        32:  'coolant_temp',
        36:  'rpm',
        89:  'fuel_level_percent',
        115: 'engine_temp',

        # --- Motion / Position ---
        16:  'odometer',
        17:  'axis_x',
        18:  'axis_y',
        19:  'axis_z',
        24:  'speed',
        199: 'trip_odometer',

        # --- GSM / Network ---
        21:  'gsm_signal',
        205: 'cell_id',
        206: 'lac',
        236: 'active_gsm_operator',
        241: 'gsm_operator',
        244: 'roaming',
        636: 'cell_id_4g',

        # --- Power / Battery ---
        66:  'external_voltage',
        67:  'battery_voltage',
        68:  'battery_current',
        113: 'battery_level_percent',

        # --- GNSS / Signal quality ---
        69:  'gnss_status',
        181: 'pdop',
        182: 'hdop',

        # --- Temperature (Dallas / 1-Wire) ---
        72:  'temp1',
        73:  'temp2',
        74:  'temp3',
        75:  'temp4',

        # --- OBD-II ---
        81:  'obd_speed',
        82:  'throttle',
        83:  'fuel_used_obd',
        84:  'fuel_level_obd',
        85:  'rpm_obd',
        87:  'odometer_obd',

        # --- Device state ---
        70:  'pcb_temp',
        80:  'data_mode',
        200: 'sleep_mode',

        # --- Digital outputs ---
        179: 'dout1',
        180: 'dout2',

        # --- Events / Flags ---
        239: 'ignition',
        240: 'movement',
        246: 'towing',
        247: 'crash_detection',
        248: 'immobilizer',
        249: 'jamming',
        250: 'trip_event',

        # --- BLE Sensors (standard IDs) ---
        25:  'ble_temp1',
        26:  'ble_temp2',
        27:  'ble_temp3',
        28:  'ble_temp4',
        29:  'ble_humidity1',
        86:  'ble_fuel_level',
        90:  'ble_luminosity',
        94:  'ble_battery1',
        95:  'ble_battery2',
        96:  'ble_battery3',
        97:  'ble_battery4',
        105: 'ble_humidity1_alt',
        106: 'ble_humidity2_alt',
        107: 'ble_humidity3_alt',
        108: 'ble_humidity4_alt',
        110: 'ble_battery_level',
        121: 'ble_sensor_temp1',

        # --- CAN / LV-CAN ---
        662: 'door',
    }

    # ------------------------------------------------------------------ #
    #  Multipliers: raw integer value × multiplier = engineering value     #
    # ------------------------------------------------------------------ #
    IO_MULTIPLIERS: Dict[int, float] = {
        # Voltages → V
        9:   0.001,
        10:  0.001,
        66:  0.001,
        67:  0.001,
        68:  0.001,
        # Temperatures → °C
        70:  0.1,
        72:  0.1,
        73:  0.1,
        74:  0.1,
        75:  0.1,
        83:  0.1,
        84:  0.1,
        110: 0.1,
        115: 0.1,
        121: 0.1,
        # DOP
        181: 0.1,
        182: 0.1,
        # Speed km/h (IO 24 is raw km/h, no multiplier needed; included for safety)
        # Fuel consumption → L/100 km
        13:  0.01,
        # BLE humidity → %
        29:  0.01,
    }

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
            # Header: 4 zero bytes | 4-byte data-field length | payload | 4-byte CRC
            if len(data) >= 8 and data[0:4] == b'\x00\x00\x00\x00':
                data_length = struct.unpack('>I', data[4:8])[0]
                total_len   = 8 + data_length + 4
                if len(data) < total_len:
                    return None, 0          # wait for more bytes

                packet_data = data[8:8 + data_length]
                consumed    = total_len

                if len(packet_data) < 2:
                    return None, consumed

                codec_id     = packet_data[0]
                record_count = packet_data[1]

                if codec_id in (0x08, 0x8E):
                    extended  = (codec_id == 0x8E)
                    positions = self._decode_all_records(
                        packet_data[2:], known_imei, extended
                    )
                    ack = struct.pack('>I', record_count)

                    if positions:
                        return {
                            'position':        positions[0],
                            'response':        ack,
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

        cmd = self.COMMAND_MAPPING.get(command_type.lower(), '')
        if not cmd:
            return b''

        if params:
            param_str = ' '.join(str(v) for v in params.values())
            cmd = f'{cmd} {param_str}'

        return self._encode_text_command(cmd)

    def get_available_commands(self) -> List[str]:
        return list(self.COMMAND_MAPPING.keys()) + ['custom']

    def get_command_info(self, command: str) -> Dict[str, Any]:
        info_map = {
            'cpureset':   {'description': 'Reset the device CPU',            'example': 'cpureset',         'requires_params': False},
            'getver':     {'description': 'Get firmware version',            'example': 'getver',           'requires_params': False},
            'getgps':     {'description': 'Get current GPS position',        'example': 'getgps',           'requires_params': False},
            'readio':     {'description': 'Read I/O status',                 'example': 'readio',           'requires_params': False},
            'getrecord':  {'description': 'Get last record',                 'example': 'getrecord',        'requires_params': False},
            'ggps':       {'description': 'Get GPS coordinates',             'example': 'ggps',             'requires_params': False},
            'getinfo':    {'description': 'Get device information',          'example': 'getinfo',          'requires_params': False},
            'setparam':   {'description': 'Set a device parameter',          'example': 'setparam 1000:60', 'requires_params': True},
            'getparam':   {'description': 'Get parameter value',             'example': 'getparam 1000',    'requires_params': True},
            'flush':      {'description': 'Flush stored records',            'example': 'flush',            'requires_params': False},
            'readstatus': {'description': 'Read device status',              'example': 'readstatus',       'requires_params': False},
            'getimei':    {'description': 'Get IMEI number',                 'example': 'getimei',          'requires_params': False},
            'custom':     {'description': 'Send custom command (text/hex)',  'example': 'Any text or hex',  'requires_params': True},
        }
        return info_map.get(command, {'description': 'Unknown command', 'example': '', 'requires_params': False})

    # ================================================================== #
    #  Internal: single-record decoder                                     #
    # ================================================================== #

    def _decode_single_record(
        self,
        data:       bytes,
        offset:     int,
        known_imei: str,
        extended:   bool,
    ) -> Tuple[Optional[NormalizedPosition], int]:
        """
        Parse one AVL record starting at *offset*.
        Returns (NormalizedPosition | None, bytes_consumed).

        AVL record layout
        -----------------
        8 B  Timestamp (ms since epoch, big-endian uint64)
        1 B  Priority
        4 B  Longitude  (×10⁻⁷, signed int32)
        4 B  Latitude   (×10⁻⁷, signed int32)
        2 B  Altitude   (metres, signed int16)
        2 B  Course     (degrees, uint16)
        1 B  Satellites (uint8)
        2 B  Speed      (km/h, uint16)

        IO element header — Codec 8:   1B event-IO-ID  + 1B total-count
        IO element header — Codec 8E:  2B event-IO-ID  + 2B total-count

        Then for each byte-width (1, 2, 4, 8):
          Codec 8:   1B count of IOs at this width
          Codec 8E:  2B count of IOs at this width
          For each IO:
            Codec 8:   1B IO-ID  + N bytes value
            Codec 8E:  2B IO-ID  + N bytes value
        """
        start = offset

        # --- Timestamp ---------------------------------------------------
        if offset + 8 > len(data):
            return None, 0
        timestamp_ms = struct.unpack('>Q', data[offset:offset + 8])[0]
        device_time  = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
        offset += 8

        # --- Priority ----------------------------------------------------
        if offset + 1 > len(data):
            return None, 0
        priority = data[offset]
        offset += 1

        # --- GPS element (15 bytes) --------------------------------------
        if offset + 15 > len(data):
            return None, 0

        lon   = struct.unpack('>i', data[offset:offset + 4])[0] / 10_000_000.0
        lat   = struct.unpack('>i', data[offset + 4:offset + 8])[0] / 10_000_000.0
        alt   = struct.unpack('>h', data[offset + 8:offset + 10])[0]
        angle = struct.unpack('>H', data[offset + 10:offset + 12])[0]
        sats  = data[offset + 12]
        speed = struct.unpack('>H', data[offset + 13:offset + 15])[0]
        offset += 15

        # Discard records with no GPS fix (device reports 0,0 when invalid)
        valid_gps = not (lat == 0.0 and lon == 0.0)

        # --- IO element header -------------------------------------------
        # Codec 8:   event_io_id (1B) + total_io_count (1B) = 2 bytes
        # Codec 8E:  event_io_id (2B) + total_io_count (2B) = 4 bytes
        header_size = 4 if extended else 2
        if offset + header_size > len(data):
            return None, 0
        # We don't use the event_io_id or total_io_count values, just skip them.
        offset += header_size

        # --- IO elements -------------------------------------------------
        ignition: Optional[bool] = None
        sensors:  Dict[str, Any] = {}

        id_width    = 2 if extended else 1
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
                raw   = unpack_fn(data[offset:offset + byte_width])
                offset += byte_width

                # Ignition is a special top-level field
                if io_id == 239:
                    ignition = bool(raw)

                # Apply engineering unit multiplier if defined
                if io_id in self.IO_MULTIPLIERS:
                    val = round(float(raw) * self.IO_MULTIPLIERS[io_id], 3)
                else:
                    val = raw

                key = self.IO_MAP.get(io_id, f'io_{io_id}')
                sensors[key] = val

        parse_io_group(1, lambda b: b[0])
        parse_io_group(2, lambda b: struct.unpack('>H', b)[0])
        parse_io_group(4, lambda b: struct.unpack('>I', b)[0])
        parse_io_group(8, lambda b: struct.unpack('>Q', b)[0])

        # Build position — return None if no valid GPS fix but still consume bytes
        consumed = offset - start
        if not valid_gps:
            logger.debug(f"Teltonika: dropping record with lat=0, lon=0 (no fix) for {known_imei}")
            # Return a sentinel so the caller still advances the offset correctly,
            # but does not store the position.  We use a dummy that gets filtered
            # out in _decode_all_records.
            return None, consumed   # caller will skip None positions

        position = NormalizedPosition(
            imei        = known_imei,
            device_time = device_time,
            server_time = datetime.now(timezone.utc),
            latitude    = lat,
            longitude   = lon,
            altitude    = float(alt),
            speed       = float(speed),
            course      = float(angle),
            satellites  = sats,
            ignition    = ignition,
            sensors     = sensors,
            raw_data    = {'priority': priority, 'codec': '8E' if extended else '8'},
        )

        return position, consumed

    # ================================================================== #
    #  Internal: multi-record decoder (updated to handle None positions)   #
    # ================================================================== #

    def _decode_all_records(
        self,
        data:       bytes,
        known_imei: Optional[str],
        extended:   bool,
    ) -> List[NormalizedPosition]:
        """Decode every AVL record; skip records with no GPS fix."""
        if not known_imei:
            return []

        positions: List[NormalizedPosition] = []
        offset = 0

        while offset < len(data):
            try:
                pos, consumed = self._decode_single_record(data, offset, known_imei, extended)
                if consumed == 0:
                    break                        # nothing parsed, stop
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
        cmd_bytes  = command_text.encode('ascii')
        cmd_length = len(cmd_bytes)

        codec_id     = 0x0C
        cmd_quantity = 0x01
        cmd_type     = 0x05   # type 5 = text command

        data_part = (
            struct.pack('B', codec_id) +
            struct.pack('B', cmd_quantity) +
            struct.pack('B', cmd_type) +
            struct.pack('>I', cmd_length) +
            cmd_bytes +
            struct.pack('B', cmd_quantity)
        )

        crc              = self._crc16(data_part)
        data_field_length = 1 + 1 + cmd_length + 1   # type + length (4B implicit) + text + trailing count

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
