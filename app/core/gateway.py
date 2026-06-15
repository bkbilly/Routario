"""
TCP/UDP Ingestion Gateway
High-performance async network handlers for GPS device connections
"""
import asyncio
import logging
import struct
from typing import Dict, Optional, Callable, Any, Coroutine
from datetime import datetime

from sqlalchemy import select

from core.database import get_db
from protocols import ProtocolRegistry
from models import Device
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
        logger.info(f"{self.protocol.upper()} TCP Server started on {self.host}:{self.port}")
        try:
            async with self.server:
                await self.server.serve_forever()
        except asyncio.CancelledError:
            raise
        finally:
            await self.stop()

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
            logger.info(f"{self.protocol.upper()} TCP Server stopped on {self.host}:{self.port}")


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
        self.transport = None

    async def start(self):
        loop = asyncio.get_event_loop()
        self.transport, _ = await loop.create_datagram_endpoint(
            lambda: UDPProtocol(self.protocol, self.position_callback),
            local_addr=(self.host, self.port),
        )
        logger.info(f"{self.protocol.upper()} UDP Server started on {self.host}:{self.port}")
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            raise
        finally:
            await self.stop()

    async def stop(self):
        if self.transport:
            self.transport.close()
            self.transport = None
            logger.info(f"{self.protocol.upper()} UDP Server stopped on {self.host}:{self.port}")


class ProtocolServerManager:
    """Starts only the protocol listeners required by active devices."""

    def __init__(self):
        self._running: Dict[tuple[str, str], tuple[Any, asyncio.Task]] = {}
        self._lock = asyncio.Lock()
        self._tcp_host = "0.0.0.0"
        self._udp_host = "0.0.0.0"
        self._position_callback: Optional[Callable[..., Coroutine[Any, Any, None]]] = None
        self._command_callback: Optional[Callable[..., Coroutine[Any, Any, None]]] = None
        self._ack_callback: Optional[Callable[..., Coroutine[Any, Any, None]]] = None

    def configure(
        self,
        *,
        tcp_host: str,
        udp_host: str,
        position_callback: Callable[..., Coroutine[Any, Any, None]],
        command_callback: Optional[Callable[..., Coroutine[Any, Any, None]]] = None,
        ack_callback: Optional[Callable[..., Coroutine[Any, Any, None]]] = None,
    ) -> None:
        self._tcp_host = tcp_host
        self._udp_host = udp_host
        self._position_callback = position_callback
        self._command_callback = command_callback
        self._ack_callback = ack_callback

    async def sync(self, active_protocols: set[str]) -> None:
        if self._position_callback is None:
            logger.warning("Protocol server manager is not configured; skipping sync")
            return

        wanted: set[tuple[str, str]] = set()
        for protocol in active_protocols:
            decoder = ProtocolRegistry.get_decoder(protocol)
            if not decoder:
                continue
            for protocol_type in getattr(decoder, "PROTOCOL_TYPES", ["tcp"]):
                wanted.add((protocol.lower(), protocol_type.lower()))

        async with self._lock:
            for key in list(self._running):
                if key not in wanted:
                    await self._stop(key)

            for key in sorted(wanted):
                if key not in self._running:
                    await self._start(key)

    async def stop_all(self) -> None:
        async with self._lock:
            for key in list(self._running):
                await self._stop(key)

    def running_protocols(self) -> list[dict]:
        rows = []
        for (protocol, protocol_type), (server, task) in sorted(self._running.items()):
            rows.append({
                "protocol": protocol,
                "protocol_type": protocol_type,
                "port": getattr(server, "port", None),
                "running": not task.done(),
            })
        return rows

    async def _start(self, key: tuple[str, str]) -> None:
        protocol, protocol_type = key
        decoder = ProtocolRegistry.get_decoder(protocol)
        if not decoder:
            return

        if protocol_type == "udp":
            server = UDPServer(self._udp_host, decoder.PORT, protocol, self._position_callback)
        else:
            server = TCPServer(
                self._tcp_host,
                decoder.PORT,
                protocol,
                self._position_callback,
                self._command_callback,
                self._ack_callback,
            )

        task = asyncio.create_task(server.start())
        task.add_done_callback(lambda t, p=protocol, pt=protocol_type: self._log_task_result(p, pt, t))
        self._running[key] = (server, task)

    async def _stop(self, key: tuple[str, str]) -> None:
        server, task = self._running.pop(key)
        await server.stop()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _log_task_result(self, protocol: str, protocol_type: str, task: asyncio.Task) -> None:
        self._running.pop((protocol, protocol_type), None)
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.error("%s %s server stopped unexpectedly: %s", protocol, protocol_type, exc, exc_info=exc)


protocol_server_manager = ProtocolServerManager()


async def get_active_device_protocols() -> set[str]:
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(select(Device.protocol).where(Device.is_active == True))
        return {protocol.lower() for protocol in result.scalars().all() if protocol}


async def sync_active_protocol_servers() -> None:
    await protocol_server_manager.sync(await get_active_device_protocols())


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
