# app/main.py
"""
FastAPI Application - Routario Platform
"""
import asyncio
import json
import logging
import os
import signal
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import httpx
import jwt
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from core.alert_engine import get_alert_engine, periodic_alert_task
from core.schedule_runner import periodic_schedule_task
from core.config import get_settings
from core.database import get_db, init_database
from core.gateway import TCPServer, UDPServer, connection_manager
from core.push_notifications import get_push_service
from core.valhalla import check_valhalla_health, set_valhalla_url
from integrations.engine import integration_poll_task
from models import AlertHistory, Device, User
from models.schemas import NormalizedPosition, UserCreate, WSMessageType
from protocols import ProtocolRegistry
from routes import ROUTE_REGISTRY
from routes.integrations import router as integrations_router
from routes.share import page_router
import integrations  # triggers autodiscover()

logger = logging.getLogger(__name__)


# ==================== Redis Pub/Sub (optional) ====================

class RedisPubSub:
    """
    Wraps redis pub/sub.  If Redis is not reachable the instance
    degrades gracefully: publish() is a no-op and the WebSocket
    manager falls back to direct in-process broadcasting.
    """

    def __init__(self):
        self.redis_client = None
        self.available = False

    async def connect(self, redis_url: str):
        try:
            import redis.asyncio as redis
            client = await redis.from_url(redis_url, decode_responses=True)
            await client.ping()
            self.redis_client = client
            self.available = True
            logger.info("Redis connected for Pub/Sub at %s", redis_url)
        except Exception as exc:
            self.available = False
            logger.warning(
                "Redis not available (%s) — WebSocket pub/sub will use "
                "in-process broadcasting only. Start Redis to enable "
                "multi-process support.", exc
            )

    async def publish(self, channel: str, message: Dict[str, Any]):
        if self.redis_client and self.available:
            try:
                await self.redis_client.publish(channel, json.dumps(message))
            except Exception as exc:
                logger.debug("Redis publish failed: %s", exc)
                self.available = False

    async def close(self):
        if self.redis_client:
            try:
                await self.redis_client.aclose()
            except Exception:
                pass


redis_pubsub = RedisPubSub()


# ==================== WebSocket Manager ====================

class WebSocketManager:
    """
    Manages active WebSocket connections.

    When Redis is available messages flow through Redis pub/sub so
    multiple worker processes stay in sync.  When Redis is absent
    (e.g. local development) messages are broadcast directly to all
    connected sockets in this process.
    """

    def __init__(self):
        # user_id -> list of connected WebSocket objects
        self.active_connections: Dict[int, List[WebSocket]] = {}
        # device_id -> set of user_ids that care about this device
        self._device_users: Dict[int, set] = {}

    async def connect(self, user_id: int, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.setdefault(user_id, []).append(websocket)
        logger.info("WebSocket connected for user %s", user_id)

    def disconnect(self, user_id: int, websocket: WebSocket):
        conns = self.active_connections.get(user_id, [])
        if websocket in conns:
            conns.remove(websocket)
        if not conns:
            self.active_connections.pop(user_id, None)
        logger.info("WebSocket disconnected for user %s", user_id)

    async def _send_to_user(self, user_id: int, message: str):
        """Send a raw JSON string to all sockets belonging to user_id."""
        dead = []
        for ws in self.active_connections.get(user_id, []):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active_connections.get(user_id, []).remove(ws)

    async def _broadcast_direct(self, device_id: int, message: Dict[str, Any]):
        """
        Fallback path: look up which users own this device and push
        directly without going through Redis.
        """
        raw = json.dumps(message)
        try:
            db = get_db()
            device = await db.get_device_by_id(device_id)
            if not device:
                return
            for user in device.users:
                await self._send_to_user(user.id, raw)
        except Exception as exc:
            logger.debug("Direct broadcast error: %s", exc)

    # ── Public broadcast helpers ──────────────────────────────────

    async def broadcast_position_update(
        self, position: NormalizedPosition, device: Device
    ):
        state_data = {}
        if device.state:
            state_data = {
                "total_odometer":      device.state.total_odometer,
                "trip_odometer":       device.state.trip_odometer,
                "is_moving":           device.state.is_moving,
                "is_online":           device.state.is_online,
                "current_driver_id":   device.state.current_driver_id,
                "current_driver_name": device.state.current_driver_name,
            }
        position.sensors = {**(position.sensors or {}), "last_gps_time": position.device_time.strftime("%Y-%m-%dT%H:%M:%S")}
        message = {
            "type":      WSMessageType.POSITION_UPDATE.value,
            "device_id": device.id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": {
                "last_latitude":  position.latitude,
                "last_longitude": position.longitude,
                "last_altitude":  position.altitude,
                "satellites":     position.satellites,
                "sensors":        position.sensors,
                "last_speed":     position.speed,
                "last_course":    position.course,
                "ignition_on":    position.ignition,
                "last_update":    position.device_time.isoformat(),
                **state_data,
            },
        }
        if redis_pubsub.available:
            await redis_pubsub.publish(f"device:{device.id}", message)
        else:
            await self._broadcast_direct(device.id, message)

    async def broadcast_alert(self, alert: AlertHistory, notify_user_ids=None):
        message = {
            "type":           WSMessageType.ALERT.value,
            "device_id":      alert.device_id,
            "timestamp":      alert.created_at.isoformat(),
            "notify_user_ids": notify_user_ids,
            "data": {
                "id":             alert.id,
                "type":           alert.alert_type,
                "severity":       alert.severity,
                "message":        alert.message,
                "alert_metadata": alert.alert_metadata,
                "created_at":     alert.created_at.isoformat(),
            },
        }
        if alert.device_id is None:
            await self._send_to_user(alert.user_id, json.dumps(message))
            return
        if notify_user_ids is not None:
            # Send only to the specified users (direct, no broadcast)
            raw = json.dumps(message)
            for uid in notify_user_ids:
                await self._send_to_user(uid, raw)
            return
        if redis_pubsub.available:
            await redis_pubsub.publish(f"device:{alert.device_id}", message)
        else:
            await self._broadcast_direct(alert.device_id, message)


ws_manager = WebSocketManager()


def get_ws_manager() -> "WebSocketManager":
    return ws_manager


# ==================== Webhook Notifications ====================

async def _notify_webhooks(
    user: User, position: NormalizedPosition, device: Device
):
    urls = user.webhook_urls or []
    if not urls:
        return
    payload = {
        "device_id":     device.id,
        "device_name":   device.name,
        "imei":          device.imei,
        "vehicle_type":  device.vehicle_type,
        "license_plate": device.license_plate,
        "latitude":      position.latitude,
        "longitude":     position.longitude,
        "speed":         position.speed,
        "course":        position.course,
        "altitude":      position.altitude,
        "satellites":    position.satellites,
        "ignition":      position.ignition,
        "timestamp":     position.device_time.isoformat(),
        "sensors":       position.sensors,
    }
    async with httpx.AsyncClient(timeout=5) as client:
        for url in urls:
            try:
                await client.post(url, json=payload)
            except Exception as exc:
                logger.warning("Webhook failed %s: %s", url, exc)


# ==================== Position / Command Callbacks ====================

async def process_position_callback(position: NormalizedPosition):
    try:
        db = get_db()
        success = await db.process_position(position)
        if not success:
            return
        device = await db.get_device_by_imei(position.imei)
        if not device or not device.state:
            return
        alert_engine = get_alert_engine()
        await alert_engine.process_position_alerts(position, device, device.state)
        await ws_manager.broadcast_position_update(position, device)
        for user in device.users:
            await _notify_webhooks(user, position, device)
        logger.debug("Position processed: %s", device.name)
    except Exception as exc:
        logger.error("Position processing error: %s", exc, exc_info=True)


async def command_callback(imei: str, writer) -> None:
    try:
        db = get_db()
        device = await db.get_device_by_imei(imei)
        if not device:
            return
        commands = await db.get_pending_commands(device.id)
        if not commands:
            return
        decoder = ProtocolRegistry.get_decoder(device.protocol)
        if not decoder:
            return
        for command in commands:
            params: dict = {}
            if command.payload:
                try:
                    params = json.loads(command.payload)
                    if not isinstance(params, dict):
                        params = {"payload": command.payload}
                except (json.JSONDecodeError, ValueError):
                    params = {"payload": command.payload}
            command_bytes = await decoder.encode_command(command.command_type, params)
            if not command_bytes:
                continue
            try:
                writer.write(command_bytes)
                await writer.drain()
                await db.mark_command_sent(command.id)
                logger.info("Command sent to %s: %s", device.name, command.command_type)
            except Exception as exc:
                logger.error("Failed to write command %s: %s", command.id, exc)
    except Exception as exc:
        logger.error("Command callback error: %s", exc, exc_info=True)


async def ack_callback(imei: str, response_text: str = "") -> None:
    try:
        db = get_db()
        device = await db.get_device_by_imei(imei)
        if not device:
            return
        await db.mark_oldest_sent_command_acked(device.id, response_text)
        logger.info("Command ACKed by %s", device.name)
    except Exception as exc:
        logger.error("ACK callback error: %s", exc, exc_info=True)


async def handle_new_alert(alert: AlertHistory, notify_user_ids=None):
    try:
        await ws_manager.broadcast_alert(alert, notify_user_ids=notify_user_ids)
    except Exception as exc:
        logger.error("Failed to broadcast alert: %s", exc)


# ==================== Lifespan ====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Routario Platform...")
    settings = get_settings()

    await init_database(settings.database_url)

    # Create default admin on first run
    if settings.admin_password:
        db = get_db()
        try:
            existing = await db.get_user_by_username(settings.admin_username)
            if not existing:
                await db.create_user(UserCreate(
                    username=settings.admin_username,
                    email=settings.admin_email,
                    password=settings.admin_password,
                    is_admin=True,
                ))
                logger.info("Default admin '%s' created.", settings.admin_username)
        except Exception as exc:
            logger.warning("Could not create default admin: %s", exc)

    # Redis — optional, degrades gracefully
    await redis_pubsub.connect(settings.redis_url)

    alert_engine = get_alert_engine()
    alert_engine.set_alert_callback(handle_new_alert)

    # Valhalla — optional
    if settings.valhalla_enabled:
        set_valhalla_url(settings.valhalla_url)
        available = await check_valhalla_health()
        if not available:
            logger.warning(
                "Valhalla not available — speed limit alerts disabled. "
                "Start Valhalla and restart to enable."
            )
    else:
        logger.info("Valhalla disabled in config.")

    # Start protocol servers
    protocols = ProtocolRegistry.get_all()
    for name, decoder in protocols.items():
        port = decoder.PORT
        for protocol_type in decoder.PROTOCOL_TYPES:
            if protocol_type == "udp":
                server = UDPServer(settings.udp_host, port, name, process_position_callback)
                asyncio.create_task(server.start())
                logger.info("Started UDP Server for %s on port %s", name, port)
            else:
                server = TCPServer(
                    settings.tcp_host, port, name,
                    process_position_callback, command_callback, ack_callback,
                )
                asyncio.create_task(server.start())
                logger.info("Started TCP Server for %s on port %s", name, port)

    alert_task    = asyncio.create_task(periodic_alert_task())
    poll_task     = asyncio.create_task(integration_poll_task(process_position_callback))
    schedule_task = asyncio.create_task(periodic_schedule_task())
    logger.info("Routario Platform started successfully")

    yield

    logger.info("Shutting down...")

    # Cancel background tasks so their loops exit before we tear down resources
    alert_task.cancel()
    poll_task.cancel()
    schedule_task.cancel()
    await asyncio.gather(alert_task, poll_task, schedule_task, return_exceptions=True)

    # Stop FCM clients — each holds an open TCP connection to Google's MCS
    # endpoint with its own internal read loop that would otherwise block
    # the event loop from exiting.
    from integrations.google_find_hub import stop_all_fcm_clients
    await stop_all_fcm_clients()

    db = get_db()
    await db.close()
    await redis_pubsub.close()
    logger.info("Shutdown complete")


# ==================== App ====================

app = FastAPI(
    title="Routario Platform API",
    description="High-performance GPS tracking and IoT platform",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in ROUTE_REGISTRY:
    app.include_router(router)
app.include_router(page_router)
app.include_router(integrations_router)


@app.get("/api/protocols")
async def get_protocols():
    protocols_info = {}
    for name, decoder in ProtocolRegistry.get_all().items():
        try:
            cmds = decoder.get_available_commands() if hasattr(decoder, "get_available_commands") else []
        except Exception:
            cmds = []
        protocols_info[name] = {
            "native_events":     getattr(decoder, "NATIVE_EVENTS", []),
            "port":              getattr(decoder, "PORT", None),
            "protocol_types":    getattr(decoder, "PROTOCOL_TYPES", ["tcp"]),
            "supports_commands": len(cmds) > 0,
            "supports_camera":   getattr(decoder, "SUPPORTS_CAMERA", False),
        }
    return {
        "protocols":       ProtocolRegistry.list_protocols(),
        "online_devices":  len(connection_manager.connections),
        "protocol_info":   protocols_info,
    }


@app.get("/")
async def root():
    return FileResponse("web/gps-dashboard.html")

@app.get("/login.html")
async def login_page():
    return FileResponse("web/login.html")

@app.get("/share.html")
async def share_html_page():
    return FileResponse("web/share.html")

@app.get("/device-management.html")
async def devices_page():
    return FileResponse("web/device-management.html")

@app.get("/user-settings.html")
async def settings_page():
    return FileResponse("web/user-settings.html")


@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: int):
    await ws_manager.connect(user_id, websocket)
    try:
        if redis_pubsub.available:
            await _websocket_redis_loop(websocket, user_id)
        else:
            await _websocket_direct_loop(websocket, user_id)
    except Exception as exc:
        logger.debug("WebSocket error for user %s: %s", user_id, exc)
    finally:
        ws_manager.disconnect(user_id, websocket)


async def _websocket_redis_loop(websocket: WebSocket, user_id: int):
    """WebSocket handler that subscribes to Redis channels."""
    import redis.asyncio as redis

    r = await redis.from_url(get_settings().redis_url, decode_responses=True)
    pubsub = r.pubsub()
    try:
        db = get_db()
        devices = await db.get_user_devices(user_id)
        channels = [f"device:{d.id}" for d in devices]
        if channels:
            await pubsub.subscribe(*channels)

        async def _redis_listener():
            try:
                async for message in pubsub.listen():
                    if message["type"] == "message":
                        try:
                            data = json.loads(message["data"])
                            nids = data.get("notify_user_ids")
                            if nids is not None and user_id not in nids:
                                continue
                            await websocket.send_text(message["data"])
                        except Exception:
                            break
            except asyncio.CancelledError:
                pass

        async def _client_listener():
            try:
                while True:
                    await websocket.receive_text()
            except WebSocketDisconnect:
                pass

        await asyncio.gather(_redis_listener(), _client_listener())
    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()
        await r.aclose()


async def _websocket_direct_loop(websocket: WebSocket, user_id: int):
    """
    WebSocket handler used when Redis is not available.
    Simply keeps the connection alive; messages are pushed directly
    by ws_manager._send_to_user() from broadcast_position_update()
    and broadcast_alert().
    """
    try:
        while True:
            # Wait for client messages (ping/pong or disconnect)
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass


# Static files — must be last
os.makedirs("web/uploads", exist_ok=True)
for _d in ["voice", "dashcam"]:
    try:
        os.makedirs(f"web/uploads/{_d}", exist_ok=True)
    except OSError:
        pass
app.mount("/uploads", StaticFiles(directory="web/uploads"), name="uploads")
app.mount("/", StaticFiles(directory="web"), name="static")


def run_server():
    server = uvicorn.Server(uvicorn.Config(
        app,
        host="0.0.0.0",
        port=8000,
        loop="uvloop",
        timeout_graceful_shutdown=2,
    ))

    def handle_exit(*args):
        server.should_exit = True

    signal.signal(signal.SIGINT,  handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)
    server.run()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    # FCM library logs ConnectionResetError at ERROR level on routine MCS reconnects; suppress it.
    logging.getLogger("firebase_messaging.fcmpushclient").setLevel(logging.CRITICAL)
    run_server()
