"""
Teltonika GPS Device Simulator
Simulates a FM device sending Codec 8 or Codec 8E (extended) data over TCP.
Codec 8E is required for beacons (IO 385, NX variable-length group).
"""
import socket
import struct
import time
import uuid
import random
from datetime import datetime, timezone

SERVER_HOST = 'localhost'
SERVER_PORT = 5027
IMEI = "123456789012343"
UPDATE_INTERVAL = 5  # seconds

# Set to True to include a BLE beacon in every packet (requires Codec 8E)
SIMULATE_BEACON = True

# The beacon that acts as the driver's ID tag
BEACON_UUID  = "12345678-1234-1234-1234-123456789abc"
BEACON_MAJOR = 1
BEACON_MINOR = 7


def crc16_arc(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if (crc & 1) else (crc >> 1)
    return crc & 0xFFFF


def encode_ibeacon_payload(beacon_uuid: str, major: int, minor: int, rssi: int) -> bytes:
    """
    Encode a single iBeacon entry for Teltonika IO 385 (beacon_ids).

    Byte layout produced by _decode_beacon_list():
      [0]      record_count  (always 1 for a single beacon here)
      [1]      flags byte    (0x21 = has_rssi | is_ibeacon)
      [2]      rssi          (signed byte)
      [3..18]  UUID          (16 bytes)
      [19..20] major         (uint16 big-endian)
      [21..22] minor         (uint16 big-endian)
    """
    flags = 0x01 | 0x20   # has_rssi (bit 0) + is_ibeacon (bit 5)
    uuid_bytes = uuid.UUID(beacon_uuid).bytes
    payload = (
        struct.pack('B', 1) +           # record count
        struct.pack('B', flags) +        # flags
        struct.pack('b', rssi) +         # RSSI signed byte
        uuid_bytes +                     # 16 bytes UUID
        struct.pack('>H', major) +       # major
        struct.pack('>H', minor)         # minor
    )
    return payload


class TeltonikaSimulator:
    def __init__(self, host, port, imei):
        self.host = host
        self.port = port
        self.imei = imei
        self.sock = None
        self.lat = 37.989332
        self.lon = 23.793724
        self.speed = 0
        self.course = 0
        self.ext_voltage    = 12500
        self.battery_voltage = 3900

    def connect(self):
        try:
            print(f"Connecting to {self.host}:{self.port}...")
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.connect((self.host, self.port))

            imei_bytes = self.imei.encode('ascii')
            self.sock.send(struct.pack('>H', len(imei_bytes)) + imei_bytes)
            print(f"Sent IMEI: {self.imei}")

            response = self.sock.recv(1)
            if response == b'\x01':
                print("Server accepted connection.")
                return True
            print(f"Server rejected: {response.hex()}")
            return False
        except ConnectionRefusedError:
            print(f"Connection refused to {self.host}:{self.port}")
            return False
        except Exception as e:
            print(f"Connection error: {e}")
            return False

    def _build_io_section(self, extended: bool, beacon_payload: bytes | None) -> bytes:
        """
        Build the full IO element block.
        extended=True  → Codec 8E: IDs are 2 bytes, counts are 2 bytes, NX group appended.
        extended=False → Codec 8:  IDs are 1 byte,  counts are 1 byte,  no NX group.
        """
        self.ext_voltage     += random.randint(-100, 100)
        self.ext_voltage      = max(11000, min(14000, self.ext_voltage))
        self.battery_voltage += random.randint(-5, 5)

        digital_input_1 = 1 if self.speed > 0 else 0

        io_1b = [(239, 1), (1, digital_input_1), (69, 1)]   # ignition ON
        io_2b = [(66, self.ext_voltage), (67, self.battery_voltage), (70, 450)]
        io_4b = [(16, 100000 + int(time.time() % 10000))]
        io_8b = []
        nx    = [(385, beacon_payload)] if beacon_payload else []

        total = len(io_1b) + len(io_2b) + len(io_4b) + len(io_8b) + len(nx)

        def pack_id(io_id):
            return struct.pack('>H', io_id) if extended else struct.pack('B', io_id)

        def pack_count(n):
            return struct.pack('>H', n) if extended else struct.pack('B', n)

        # IO header: event IO ID (0) + total count
        block = pack_id(0) + pack_count(total)

        # 1-byte group
        block += pack_count(len(io_1b))
        for io_id, val in io_1b:
            block += pack_id(io_id) + struct.pack('B', val)

        # 2-byte group
        block += pack_count(len(io_2b))
        for io_id, val in io_2b:
            block += pack_id(io_id) + struct.pack('>H', val)

        # 4-byte group
        block += pack_count(len(io_4b))
        for io_id, val in io_4b:
            block += pack_id(io_id) + struct.pack('>I', val)

        # 8-byte group
        block += pack_count(len(io_8b))
        for io_id, val in io_8b:
            block += pack_id(io_id) + struct.pack('>Q', val)

        # NX group (Codec 8E only): ID (2 bytes) + length (2 bytes) + value
        if extended:
            block += pack_count(len(nx))
            for io_id, val in nx:
                block += struct.pack('>H', io_id)
                block += struct.pack('>H', len(val))
                block += val

        return block

    def generate_avl_data(self, extended: bool, beacon_payload: bytes | None) -> bytes:
        self.lat   += random.uniform(-0.005, 0.0005)
        self.lon   += random.uniform(-0.0005, 0.0005)
        self.speed  = random.randint(10, 60)
        self.course = random.randint(0, 360)

        timestamp = int(datetime.now(timezone.utc).timestamp() * 1000)
        lat_int   = int(self.lat * 10_000_000)
        lon_int   = int(self.lon * 10_000_000)

        gps_data = (
            struct.pack('>i', lon_int) +
            struct.pack('>i', lat_int) +
            struct.pack('>h', 100) +        # altitude
            struct.pack('>H', self.course) +
            struct.pack('B',  8) +          # satellites
            struct.pack('>H', self.speed)
        )

        io_block = self._build_io_section(extended, beacon_payload)

        return struct.pack('>Q', timestamp) + b'\x00' + gps_data + io_block

    def send_data(self):
        if not self.sock:
            if not self.connect():
                return

        try:
            extended = SIMULATE_BEACON
            beacon_payload = None

            if SIMULATE_BEACON:
                rssi = random.randint(-75, -55)
                beacon_payload = encode_ibeacon_payload(
                    BEACON_UUID, BEACON_MAJOR, BEACON_MINOR, rssi
                )

            avl_data   = self.generate_avl_data(extended, beacon_payload)
            codec_id   = 0x8E if extended else 0x08
            num_records = 1

            payload = (
                struct.pack('B', codec_id) +
                struct.pack('B', num_records) +
                avl_data +
                struct.pack('B', num_records)
            )

            crc_val    = crc16_arc(payload)
            full_packet = (
                b'\x00\x00\x00\x00' +
                struct.pack('>I', len(payload)) +
                payload +
                struct.pack('>I', crc_val)
            )

            self.sock.send(full_packet)

            beacon_info = f"Beacon {BEACON_UUID}:{BEACON_MAJOR}:{BEACON_MINOR} rssi={rssi}" if SIMULATE_BEACON else "no beacon"
            print(f"Sent ({'8E' if extended else '8'}): Lat {self.lat:.4f}, Spd {self.speed}km/h | {beacon_info}")

            ack = self.sock.recv(4)
            if len(ack) != 4:
                print("No ACK received")
                self.sock = None

        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            print("Connection lost")
            self.sock = None
        except Exception as e:
            print(f"Send error: {e}")
            self.sock = None

    def run(self):
        while True:
            self.send_data()
            time.sleep(UPDATE_INTERVAL)


if __name__ == "__main__":
    sim = TeltonikaSimulator(SERVER_HOST, SERVER_PORT, IMEI)
    sim.run()