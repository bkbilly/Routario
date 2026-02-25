"""
TCP/UDP Ingestion Gateway
High-performance async network handlers for GPS device connections
"""
import asyncio
import logging
import struct
from typing import Dict, Optional, Callable, Any
from datetime import datetime

from protocols import ProtocolRegistry
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)


class DeviceConnectionManager:
    """Manages active device connections"""
    def __init__(self):
        self.connections: Dict[str, asyncio.StreamWriter] = {}
        self.imei_to_protocol: Dict[str, str] = {}
    
    def register_connection(self, imei: str, protocol: str, writer: asyncio.StreamWriter):
        self.connections[imei] = writer
        self.imei_to_protocol[imei] = protocol
        logger.info(f"Device connected: {imei} ({protocol})")
    
    def unregister_connection(self, imei: str):
        if imei in self.connections:
            del self.connections[imei]
            logger.info(f"Device disconnected: {imei}")
    
    def get_connection(self, imei: str) -> Optional[asyncio.StreamWriter]:
        return self.connections.get(imei)
    
    def is_online(self, imei: str) -> bool:
        return imei in self.connections

connection_manager = DeviceConnectionManager()


class TCPDeviceHandler:
    """
    Handles individual TCP device connections for a SPECIFIC protocol
    Includes buffering for fragmented packets
    """
    
    def __init__(
        self, 
        reader: asyncio.StreamReader, 
        writer: asyncio.StreamWriter,
        protocol: str,
        position_callback: Callable,
        command_callback: Optional[Callable] = None
    ):
        self.reader = reader
        self.writer = writer
        self.protocol = protocol
        self.position_callback = position_callback
        self.command_callback = command_callback
        
        peername = writer.get_extra_info('peername')
        self.client_ip = peername[0] if peername else 'unknown'
        self.client_port = peername[1] if peername else 0
        
        self.imei: Optional[str] = None
        self.buffer = b""
        self.decoder = ProtocolRegistry.get_decoder(self.protocol)
        
        if not self.decoder:
            logger.error(f"No decoder found for protocol: {self.protocol}")
        
        logger.info(f"New {self.protocol.upper()} connection from {self.client_ip}:{self.client_port}")
    
    async def handle(self):
        if not self.decoder:
            self.writer.close()
            return

        try:
            while True:
                try:
                    # Read new chunk
                    chunk = await asyncio.wait_for(self.reader.read(4096), timeout=300.0)
                    if not chunk: break
                    self.buffer += chunk
                    
                    # Process buffer loop
                    while True:
                        if not self.buffer: break
                        
                        # Try to decode from current buffer
                        result, consumed = await self.decoder.decode(
                            self.buffer,
                            {"ip": self.client_ip, "port": self.client_port},
                            self.imei
                        )
                        
                        if consumed == 0:
                            # Incomplete packet, wait for more data
                            break
                        
                        # Remove consumed bytes
                        self.buffer = self.buffer[consumed:]
                        
                        if not result:
                            # Packet parsed but no result (e.g. heartbeat or skip)
                            continue
                            
                        # Handle Control Events / mixed results
                        if isinstance(result, dict):
                            if "imei" in result:
                                self.imei = result["imei"]
                                connection_manager.register_connection(self.imei, self.protocol, self.writer)
                                if self.command_callback:
                                    await self.command_callback(self.imei, self.writer)

                            if "response" in result:
                                self.writer.write(result["response"])
                                await self.writer.drain()

                            # Some protocols (Teltonika, Meitrack) return a
                            # position embedded in the dict alongside a response
                            if "position" in result:
                                pos = result["position"]
                                if isinstance(pos, NormalizedPosition):
                                    if not self.imei and pos.imei:
                                        self.imei = pos.imei
                                        connection_manager.register_connection(self.imei, self.protocol, self.writer)
                                    await self.position_callback(pos)

                            # Teltonika multi-record: process any additional positions
                            for extra_pos in result.get("extra_positions", []):
                                if isinstance(extra_pos, NormalizedPosition):
                                    await self.position_callback(extra_pos)

                        # Handle plain NormalizedPosition
                        elif isinstance(result, NormalizedPosition):
                            if not self.imei and result.imei:
                                self.imei = result.imei
                                connection_manager.register_connection(self.imei, self.protocol, self.writer)

                            await self.position_callback(result)
                            
                except asyncio.TimeoutError:
                    break # Timeout logic
                except Exception as e:
                    logger.error(f"Handler error: {e}")
                    self.buffer = b"" # Reset buffer on error
                    break
                    
        finally:
            if self.imei:
                connection_manager.unregister_connection(self.imei)
            try:
                self.writer.close()
                await self.writer.wait_closed()
            except:
                pass

    # _send_ack removed: each protocol now includes its ACK bytes
    # directly in the result dict under the "response" key.


class TCPServer:
    def __init__(self, host: str, port: int, protocol: str, position_callback: Callable, command_callback: Optional[Callable] = None):
        self.host = host; self.port = port; self.protocol = protocol
        self.position_callback = position_callback; self.command_callback = command_callback
        self.server = None
    
    async def _handle_client(self, reader, writer):
        handler = TCPDeviceHandler(reader, writer, self.protocol, self.position_callback, self.command_callback)
        await handler.handle()
    
    async def start(self):
        self.server = await asyncio.start_server(self._handle_client, self.host, self.port)
        logger.info(f"{self.protocol.upper()} TCP Server started on {self.host}:{self.port}")
        async with self.server: await self.server.serve_forever()


class UDPProtocol(asyncio.DatagramProtocol):
    def __init__(self, protocol: str, position_callback: Callable):
        self.protocol = protocol; self.position_callback = position_callback
        self.decoder = ProtocolRegistry.get_decoder(protocol)

    def datagram_received(self, data: bytes, addr):
        asyncio.create_task(self._process(data, addr))

    async def _process(self, data: bytes, addr):
        if not self.decoder: return
        try:
            # UDP doesn't use buffer consumption logic same way, it's 1 packet per datagram
            res, _ = await self.decoder.decode(data, {"ip": addr[0], "port": addr[1]}, None)
            if isinstance(res, NormalizedPosition): await self.position_callback(res)
        except: pass


class UDPServer:
    def __init__(self, host: str, port: int, protocol: str, position_callback: Callable):
        self.host = host; self.port = port; self.protocol = protocol; self.position_callback = position_callback

    async def start(self):
        loop = asyncio.get_event_loop()
        await loop.create_datagram_endpoint(
            lambda: UDPProtocol(self.protocol, self.position_callback),
            local_addr=(self.host, self.port)
        )
        logger.info(f"{self.protocol.upper()} UDP Server started on {self.host}:{self.port}")

async def send_command_to_device(imei: str, command_data: bytes) -> bool:
    writer = connection_manager.get_connection(imei)
    if not writer: return False
    try:
        writer.write(command_data)
        await writer.drain()
        return True
    except: return False

def get_online_devices() -> list:
    return list(connection_manager.connections.keys())
