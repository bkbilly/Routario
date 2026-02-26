"""
Teltonika GPS Device Simulator
Simulates a FM device sending Codec 8 data over TCP
Includes External Power, Battery Voltage, and Digital Inputs
"""
import socket
import struct
import time
import random
from datetime import datetime, timezone
import sys

# Configuration
SERVER_HOST = 'localhost'
SERVER_PORT = 5027  # Teltonika port
IMEI = "123456789012343"
UPDATE_INTERVAL = 5  # seconds

def crc16_arc(data: bytes) -> int:
    """Calculate CRC-16/ARC (IBM) for Teltonika"""
    crc = 0xA001
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

class TeltonikaSimulator:
    def __init__(self, host, port, imei):
        self.host = host
        self.port = port
        self.imei = imei
        self.sock = None
        self.lat = 37.989332  # Start Lat (San Francisco)
        self.lon = 23.793724 # Start Lon
        self.speed = 0
        self.course = 0
        
        # Simulated sensor values
        self.ext_voltage = 12500 # mV (12.5V)
        self.battery_voltage = 3900 # mV (3.9V)

    def connect(self):
        try:
            print(f"Connecting to {self.host}:{self.port}...")
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.connect((self.host, self.port))
            
            # 1. Send IMEI
            imei_bytes = self.imei.encode('ascii')
            length_bytes = struct.pack('>H', len(imei_bytes))
            packet = length_bytes + imei_bytes
            
            self.sock.send(packet)
            print(f"Sent IMEI: {self.imei}")
            
            # 2. Receive Acceptance
            response = self.sock.recv(1)
            if response == b'\x01':
                print("Server accepted connection.")
                return True
            else:
                print(f"Server rejected connection: {response.hex()}")
                return False
        except ConnectionRefusedError:
            print(f"Connection refused to {self.host}:{self.port}")
            return False
        except Exception as e:
            print(f"Connection error: {e}")
            return False

    def generate_avl_data(self):
        """Generate a single Codec 8 AVL Data record"""
        # Simulate movement
        self.lat += random.uniform(-0.005, 0.0005)
        self.lon += random.uniform(-0.0005, 0.0005)
        self.speed = random.randint(10, 60)
        self.course = random.randint(0, 360)
        
        # Simulate Sensor Fluctuation
        # External Power fluctuates slightly (+/- 0.1V)
        self.ext_voltage += random.randint(-100, 100) 
        if self.ext_voltage < 11000: self.ext_voltage = 11000
        if self.ext_voltage > 14000: self.ext_voltage = 14000
        
        # Battery drains slightly over time or charges
        self.battery_voltage += random.randint(-5, 5)
        
        # Digital Input 1 is ON when moving
        digital_input_1 = 1 if self.speed > 0 else 0
        
        # Timestamp (ms)
        timestamp = int(datetime.now(timezone.utc).timestamp() * 1000)
        
        # GPS Element
        lat_int = int(self.lat * 10000000)
        lon_int = int(self.lon * 10000000)
        altitude = 100
        satellites = 8
        
        # GPS Part (Lon, Lat, Alt, Angle, Sat, Speed)
        gps_data = struct.pack('>iiHHB', lon_int, lat_int, altitude, self.course, satellites)
        gps_data += struct.pack('>H', self.speed)
        
        # IO Data Preparation
        # 1 Byte IOs
        io_1b_data = [
            (239, 0), # Ignition (ID 239) = 1 (ON)
            (1, digital_input_1), # DIN1 (ID 1)
            (69, 1)   # GNSS Status (ID 69)
        ]
        
        # 2 Byte IOs
        io_2b_data = [
            (66, self.ext_voltage), # External Voltage (ID 66) - mV
            (67, self.battery_voltage), # Battery Voltage (ID 67) - mV
            (70, 450) # PCB Temp (ID 70) - 0.1 deg C
        ]
        
        # 4 Byte IOs
        io_4b_data = [
            (16, 100000 + int(time.time() % 10000)) # Odometer (ID 16)
        ]
        
        # 8 Byte IOs
        io_8b_data = []

        total_io_count = len(io_1b_data) + len(io_2b_data) + len(io_4b_data) + len(io_8b_data)
        
        # IO Header
        io_part = struct.pack('>BB', 0, total_io_count)
        
        # Pack 1 Byte IOs
        io_part += struct.pack('>B', len(io_1b_data))
        for io_id, val in io_1b_data:
            io_part += struct.pack('>BB', io_id, val)
            
        # Pack 2 Byte IOs
        io_part += struct.pack('>B', len(io_2b_data))
        for io_id, val in io_2b_data:
            io_part += struct.pack('>BH', io_id, val)
            
        # Pack 4 Byte IOs
        io_part += struct.pack('>B', len(io_4b_data))
        for io_id, val in io_4b_data:
            io_part += struct.pack('>BI', io_id, val)
            
        # Pack 8 Byte IOs
        io_part += struct.pack('>B', len(io_8b_data))
        for io_id, val in io_8b_data:
            io_part += struct.pack('>BQ', io_id, val)
            
        avl_record = struct.pack('>Q', timestamp) + b'\x00' + gps_data + io_part
        return avl_record

    def send_data(self):
        if not self.sock: 
            if not self.connect(): return

        try:
            avl_data = self.generate_avl_data()
            
            # Data payload
            codec_id = 0x08
            num_records = 1
            payload = struct.pack('>BB', codec_id, num_records) + avl_data + struct.pack('>B', num_records)
            
            # CRC
            crc_val = crc16_arc(payload)
            
            # Full Packet
            preamble = b'\x00\x00\x00\x00'
            data_length = struct.pack('>I', len(payload))
            crc_bytes = struct.pack('>I', crc_val)
            
            full_packet = preamble + data_length + payload + crc_bytes
            
            self.sock.send(full_packet)
            print(f"Sent: Lat {self.lat:.4f}, Spd {self.speed}km/h, ExtPwr {self.ext_voltage/1000:.1f}V, DIN1 {1 if self.speed > 0 else 0}")
            
            ack = self.sock.recv(4)
            if len(ack) != 4:
                print("No ACK received")
                self.sock.close()
                self.sock = None
                
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            print("Connection lost")
            self.sock.close()
            self.sock = None
        except Exception as e:
            print(f"Send error: {e}")
            if self.sock: self.sock.close()
            self.sock = None

    def run(self):
        while True:
            self.send_data()
            time.sleep(UPDATE_INTERVAL)

if __name__ == "__main__":
    sim = TeltonikaSimulator(SERVER_HOST, SERVER_PORT, IMEI)
    sim.run()