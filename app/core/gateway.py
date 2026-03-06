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
    Handles individual TCP device connections for a SPECIFIC protocol.
    Includes buffering for fragmented packets.
    """

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        protocol: str,
        position_callback: Callable,
        command_callback: Optional[Callable] = None,
        ack_callback: Optional[Callable] = None,
    ):
        self.reader = reader
        self.writer = writer
        self.protocol = protocol
        self.position_callback = position_callback
        self.command_callback = command_callback
        self.ack_callback = ack_callback  # called when device ACKs a command

        peername = writer.get_extra_info('peername')
        self.client_ip   = peername[0] if peername else 'unknown'
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
                    chunk = await asyncio.wait_for(self.reader.read(4096), timeout=300.0)
                    if not chunk:
                        break
                    self.buffer += chunk

                    # Inner loop: drain the buffer completely before reading again
                    while True:
                        if not self.buffer:
                            break

                        result, consumed = await self.decoder.decode(
                            self.buffer,
                            {"ip": self.client_ip, "port": self.client_port},
                            self.imei,
                        )

                        if consumed == 0:
                            break  # Incomplete packet — wait for more data

                        self.buffer = self.buffer[consumed:]

                        if not result:
                            continue  # Heartbeat / padding — skip

                        # ── Dict result (login, ack, mixed) ───────────────
                        if isinstance(result, dict):

                            # Login — device identifies itself for the first time
                            if "imei" in result:
                                self.imei = result["imei"]
                                connection_manager.register_connection(
                                    self.imei, self.protocol, self.writer
                                )

                            # Send ACK/response bytes back to device
                            if "response" in result:
                                self.writer.write(result["response"])
                                await self.writer.drain()

                            # Command ACK — device confirmed it received our command
                            if result.get("event") == "command_ack":
                                if self.imei and self.ack_callback:
                                    response_text = result.get("response_text", "")
                                    await self.ack_callback(self.imei, response_text)
                                continue  # No position to process

                            # Position embedded alongside login/response
                            if "position" in result:
                                pos = result["position"]
                                if isinstance(pos, NormalizedPosition):
                                    if not self.imei and pos.imei:
                                        self.imei = pos.imei
                                        connection_manager.register_connection(
                                            self.imei, self.protocol, self.writer
                                        )
                                    await self.position_callback(pos)

                            # Extra positions (multi-record batch)
                            for extra_pos in result.get("extra_positions", []):
                                if isinstance(extra_pos, NormalizedPosition):
                                    await self.position_callback(extra_pos)

                        # ── Plain NormalizedPosition ───────────────────────
                        elif isinstance(result, NormalizedPosition):
                            if not self.imei and result.imei:
                                self.imei = result.imei
                                connection_manager.register_connection(
                                    self.imei, self.protocol, self.writer
                                )
                            await self.position_callback(result)

                        else:
                            continue

                        # ── Dispatch any pending commands now that we have
                        #    a confirmed IMEI and an open writer.
                        #
                        #    This fires on EVERY packet (position, login, ack)
                        #    so commands queued while the device is already
                        #    connected are sent on the very next message,
                        #    not just on reconnect.
                        if self.imei and self.command_callback:
                            await self.command_callback(self.imei, self.writer)

                except asyncio.TimeoutError:
                    break
                except Exception as e:
                    logger.error(f"Handler error: {e}", exc_info=True)
                    self.buffer = b""
                    break

        finally:
            if self.imei:
                connection_manager.unregister_connection(self.imei)
            try:
                self.writer.close()
                await self.writer.wait_closed()
            except Exception:
                pass


class TCPServer:
    def __init__(
        self,
        host: str,
        port: int,
        protocol: str,
        position_callback: Callable,
        command_callback: Optional[Callable] = None,
        ack_callback: Optional[Callable] = None,
    ):
        self.host = host
        self.port = port
        self.protocol = protocol
        self.position_callback = position_callback
        self.command_callback = command_callback
        self.ack_callback = ack_callback
        self.server = None

    async def _handle_client(self, reader, writer):
        handler = TCPDeviceHandler(
            reader, writer,
            self.protocol,
            self.position_callback,
            self.command_callback,
            self.ack_callback,
        )
        await handler.handle()

    async def start(self):
        self.server = await asyncio.start_server(self._handle_client, self.host, self.port)
        # logger.info(f"{self.protocol.upper()} TCP Server started on {self.host}:{self.port}")
        async with self.server:
            await self.server.serve_forever()


class UDPProtocol(asyncio.DatagramProtocol):
    def __init__(self, protocol: str, position_callback: Callable):
        self.protocol = protocol
        self.position_callback = position_callback
        self.decoder = ProtocolRegistry.get_decoder(protocol)

    def datagram_received(self, data: bytes, addr):
        asyncio.create_task(self._process(data, addr))

    async def _process(self, data: bytes, addr):
        if not self.decoder:
            return
        try:
            res, _ = await self.decoder.decode(
                data, {"ip": addr[0], "port": addr[1]}, None
            )
            if isinstance(res, NormalizedPosition):
                await self.position_callback(res)
        except Exception:
            pass


class UDPServer:
    def __init__(self, host: str, port: int, protocol: str, position_callback: Callable):
        self.host = host
        self.port = port
        self.protocol = protocol
        self.position_callback = position_callback

    async def start(self):
        loop = asyncio.get_event_loop()
        await loop.create_datagram_endpoint(
            lambda: UDPProtocol(self.protocol, self.position_callback),
            local_addr=(self.host, self.port),
        )
        # logger.info(f"{self.protocol.upper()} UDP Server started on {self.host}:{self.port}")


async def send_command_to_device(imei: str, command_data: bytes) -> bool:
    writer = connection_manager.get_connection(imei)
    if not writer:
        return False
    try:
        writer.write(command_data)
        await writer.drain()
        return True
    except Exception:
        return False


def get_online_devices() -> list:
    return list(connection_manager.connections.keys())
