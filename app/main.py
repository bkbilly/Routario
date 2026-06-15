# app/main.py
"""
FastAPI Application - Routario Platform
"""
import asyncio
import json
import logging
import mimetypes
import os
import signal
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
import jwt
import uvicorn
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from core.alert_engine import get_alert_engine, periodic_alert_task
from core.schedule_runner import periodic_schedule_task
from core.config import get_settings
from core.database import get_db, init_database
from core.gateway import TCPServer, UDPServer, connection_manager
from core.push_notifications import get_push_service
from core.valhalla import check_valhalla_health, set_valhalla_url
from integrations.engine import integration_poll_task
from models import AlertHistory, Company, Device, User
from models.schemas import NormalizedPosition, UserCreate, WSMessageType
from protocols import ProtocolRegistry
from routes import ROUTE_REGISTRY
from routes.integrations import router as integrations_router
from routes.share import page_router
import integrations  # triggers autodiscover()

logger = logging.getLogger(__name__)

DEFAULT_APP_NAME = "Routario"
DEFAULT_MANIFEST_NAME = "Routario Platform"
BRANDING_DIR = Path("web/uploads/company-branding")
DEFAULT_ICON_PATHS = {
    "favicon": Path("web/icons/favicon.ico"),
    "apple-touch-icon": Path("web/icons/apple-touch-icon.png"),
    "icon-192": Path("web/icons/icon-192.png"),
    "icon-192-full": Path("web/icons/icon-192-full.png"),
    "icon-512": Path("web/icons/icon-512.png"),
    "badge-96": Path("web/icons/badge-96.png"),
}


async def _get_company_for_branding(company_id: Optional[int]) -> Optional[Company]:
    if not company_id:
        return None
    db = get_db()
    async with db.get_session() as session:
        return await session.get(Company, company_id)


async def _get_company_for_login_slug(login_slug: Optional[str]) -> Optional[Company]:
    if not login_slug:
        return None
    db = get_db()
    async with db.get_session() as session:
        result = await session.execute(
            select(Company).where(Company.login_slug == login_slug.strip().lower())
        )
        return result.scalar_one_or_none()


def _company_file_path(company: Optional[Company], attr: str) -> Optional[Path]:
    filename = getattr(company, attr, None) if company else None
    if not filename:
        return None
    path = BRANDING_DIR / filename
    return path if path.exists() else None


def _file_response(path: Path) -> FileResponse:
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


def _branding_url(company: Company, asset: str) -> str:
    version = company.branding_version or 1
    return f"/branding/company/{company.id}/{asset}?v={version}"


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
    description=(
        "High-performance GPS tracking and IoT platform.\n\n"
        "Authentication: create an API key in User Settings -> API Keys, "
        "click Authorize in Swagger, and paste the `rt_...` key. "
        "Swagger adds the Bearer prefix automatically."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
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

@app.get("/login/{company_slug}")
async def company_login_page(company_slug: str):
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

@app.get("/docs", include_in_schema=False)
async def swagger_docs_page():
    return HTMLResponse("""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Routario REST API</title>
    <link rel="icon" href="/icons/favicon.ico">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css">
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0e1a;
            --bg-secondary: #131825;
            --bg-tertiary: #1a2035;
            --bg-hover: #202842;
            --text-primary: #e5e7eb;
            --text-secondary: #9ca3af;
            --text-muted: #6b7280;
            --accent-primary: #3b82f6;
            --accent-secondary: #06b6d4;
            --accent-success: #22c55e;
            --accent-warning: #f59e0b;
            --accent-danger: #ef4444;
            --border-color: #374151;
            --font-display: 'Outfit', sans-serif;
            --font-mono: 'JetBrains Mono', monospace;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: var(--font-display);
        }
        .rt-docs-nav {
            position: sticky;
            top: 0;
            z-index: 20;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            padding: 1rem 1.5rem;
            background: rgba(10, 14, 26, 0.86);
            border-bottom: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        .rt-docs-title {
            display: flex;
            align-items: center;
            gap: 0.65rem;
            min-width: 0;
            font-weight: 800;
            font-size: 1.25rem;
        }
        .rt-docs-title i { color: var(--accent-primary); font-size: 1.45rem; }
        .rt-docs-title span {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .rt-docs-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; }
        .rt-docs-btn {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.55rem 0.75rem;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            background: var(--bg-tertiary);
            color: var(--text-primary);
            text-decoration: none;
            font-size: 0.875rem;
            font-weight: 600;
        }
        .rt-docs-btn:hover {
            border-color: var(--accent-primary);
            color: var(--accent-primary);
            background: var(--bg-hover);
        }
        #swagger-ui { max-width: 1320px; margin: 0 auto; padding: 1rem 1.5rem 2rem; }
        .swagger-ui { color: var(--text-primary); font-family: var(--font-display); }
        .swagger-ui .topbar { display: none; }
        .swagger-ui .info { margin: 1rem 0 1.25rem; }
        .swagger-ui .info .title {
            color: var(--text-primary);
            font-family: var(--font-display);
            font-size: 1.8rem;
        }
        .swagger-ui .info p,
        .swagger-ui .info li,
        .swagger-ui .opblock-description-wrapper p,
        .swagger-ui .opblock-external-docs-wrapper p,
        .swagger-ui .opblock-title_normal p,
        .swagger-ui .response-col_description__inner div,
        .swagger-ui .response-col_description__inner p,
        .swagger-ui table thead tr td,
        .swagger-ui table thead tr th,
        .swagger-ui .parameter__name,
        .swagger-ui .parameter__type,
        .swagger-ui .prop-format,
        .swagger-ui .model-title,
        .swagger-ui .model {
            color: var(--text-secondary);
            font-family: var(--font-display);
        }
        .swagger-ui .scheme-container,
        .swagger-ui section.models,
        .swagger-ui .opblock,
        .swagger-ui .dialog-ux .modal-ux {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            box-shadow: none;
        }
        .swagger-ui .scheme-container { padding: 1rem; }
        .swagger-ui .opblock .opblock-summary {
            border-color: var(--border-color);
        }
        .swagger-ui .opblock-tag {
            color: var(--text-primary);
            border-bottom-color: var(--border-color);
            font-family: var(--font-display);
        }
        .swagger-ui .opblock-tag:hover { background: var(--bg-hover); }
        .swagger-ui .opblock .opblock-summary-operation-id,
        .swagger-ui .opblock .opblock-summary-path,
        .swagger-ui .opblock .opblock-summary-path__deprecated {
            color: var(--text-primary);
            font-family: var(--font-mono);
        }
        .swagger-ui .opblock .opblock-summary-description { color: var(--text-secondary); }
        .swagger-ui .opblock.opblock-get { border-color: rgba(34, 197, 94, 0.45); background: rgba(34, 197, 94, 0.06); }
        .swagger-ui .opblock.opblock-post { border-color: rgba(59, 130, 246, 0.45); background: rgba(59, 130, 246, 0.06); }
        .swagger-ui .opblock.opblock-put { border-color: rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.06); }
        .swagger-ui .opblock.opblock-delete { border-color: rgba(239, 68, 68, 0.45); background: rgba(239, 68, 68, 0.06); }
        .swagger-ui .opblock-body,
        .swagger-ui .responses-inner,
        .swagger-ui .opblock-section-header {
            background: transparent !important;
            box-shadow: none !important;
        }
        .swagger-ui .opblock-section-header,
        .swagger-ui .opblock .opblock-section-header {
            background: var(--bg-secondary) !important;
            border-color: var(--border-color) !important;
        }
        .swagger-ui .opblock-section-header h4,
        .swagger-ui .responses-inner h4,
        .swagger-ui .responses-inner h5,
        .swagger-ui .tab li button.tablinks,
        .swagger-ui label {
            color: var(--text-primary);
            font-family: var(--font-display);
        }
        .swagger-ui input,
        .swagger-ui textarea,
        .swagger-ui select {
            background: var(--bg-tertiary) !important;
            color: var(--text-primary) !important;
            border: 1px solid var(--border-color) !important;
            border-radius: 8px !important;
            font-family: var(--font-mono);
        }
        .swagger-ui textarea.curl,
        .swagger-ui .highlight-code,
        .swagger-ui pre,
        .swagger-ui code {
            background: #070b14 !important;
            color: #dbeafe !important;
            font-family: var(--font-mono) !important;
        }
        .swagger-ui .json-schema-2020-12,
        .swagger-ui .json-schema-2020-12-accordion,
        .swagger-ui .json-schema-2020-12-accordion__children,
        .swagger-ui .json-schema-2020-12-body,
        .swagger-ui .json-schema-2020-12-keyword,
        .swagger-ui .json-schema-2020-12-property,
        .swagger-ui .json-schema-2020-12-property-name,
        .swagger-ui .json-schema-2020-12__attribute,
        .swagger-ui .json-schema-2020-12__attribute--primary,
        .swagger-ui .model-box,
        .swagger-ui .model-container,
        .swagger-ui .model-example,
        .swagger-ui .model-example__section,
        .swagger-ui .model-toggle,
        .swagger-ui .model-title,
        .swagger-ui .prop-type,
        .swagger-ui .property-row {
            background: transparent !important;
            color: var(--text-secondary) !important;
            border-color: var(--border-color) !important;
        }
        .swagger-ui .json-schema-2020-12-accordion {
            background: var(--bg-tertiary) !important;
            border: 1px solid var(--border-color) !important;
            border-radius: 8px !important;
            margin: 0.35rem 0 !important;
        }
        .swagger-ui .json-schema-2020-12-accordion__children {
            background: var(--bg-secondary) !important;
            border-left: 1px solid var(--border-color) !important;
        }
        .swagger-ui .json-schema-2020-12-expand-deep-button,
        .swagger-ui button.json-schema-2020-12-expand-deep-button {
            background: var(--bg-tertiary) !important;
            color: var(--text-primary) !important;
            border: 1px solid var(--border-color) !important;
            border-radius: 8px !important;
            box-shadow: none !important;
            font-family: var(--font-display) !important;
        }
        .swagger-ui .json-schema-2020-12-expand-deep-button:hover,
        .swagger-ui button.json-schema-2020-12-expand-deep-button:hover {
            background: var(--bg-hover) !important;
            border-color: var(--accent-primary) !important;
            color: var(--accent-primary) !important;
        }
        .swagger-ui .json-schema-2020-12-accordion svg,
        .swagger-ui .json-schema-2020-12-expand-deep-button svg,
        .swagger-ui .model-toggle::after {
            color: var(--text-secondary) !important;
            fill: var(--text-secondary) !important;
        }
        .swagger-ui .json-schema-2020-12__title,
        .swagger-ui .json-schema-2020-12-property-name,
        .swagger-ui .json-schema-2020-12__attribute--primary,
        .swagger-ui .prop-name {
            color: var(--text-primary) !important;
        }
        .swagger-ui .btn,
        .swagger-ui .btn.authorize,
        .swagger-ui .btn.execute,
        .swagger-ui .btn.try-out__btn {
            border-radius: 8px;
            border-color: var(--border-color);
            background: var(--bg-tertiary);
            color: var(--text-primary);
            font-family: var(--font-display);
            box-shadow: none;
        }
        .swagger-ui .btn:hover,
        .swagger-ui .btn.authorize:hover {
            border-color: var(--accent-primary);
            color: var(--accent-primary);
            background: var(--bg-hover);
        }
        .swagger-ui .btn.execute {
            background: var(--accent-primary);
            border-color: var(--accent-primary);
            color: white;
        }
        .swagger-ui .authorization__btn svg,
        .swagger-ui .btn.authorize svg { fill: var(--accent-primary); }
        .swagger-ui .dialog-ux .modal-ux-header,
        .swagger-ui .dialog-ux .modal-ux-content {
            background: var(--bg-secondary);
            border-color: var(--border-color);
            color: var(--text-primary);
        }
        .swagger-ui .dialog-ux .modal-ux-header h3 { color: var(--text-primary); }
        .swagger-ui .response-col_status,
        .swagger-ui .response-col_links,
        .swagger-ui .parameters-col_name,
        .swagger-ui .parameters-col_description {
            color: var(--text-secondary);
        }
        .swagger-ui table tbody tr td { border-color: var(--border-color); }
        .swagger-ui svg { fill: currentColor; }
        @media (max-width: 720px) {
            .rt-docs-nav { align-items: flex-start; flex-direction: column; }
            #swagger-ui { padding: 0.75rem; }
        }
    </style>
</head>
<body>
    <div class="rt-docs-nav">
        <div class="rt-docs-title"><i class="mdi mdi-api"></i><span>Routario REST API</span></div>
        <div class="rt-docs-actions">
            <a class="rt-docs-btn" href="/user-settings.html#apiKeys"><i class="mdi mdi-key-variant"></i> API Keys</a>
            <a class="rt-docs-btn" href="/openapi.json"><i class="mdi mdi-code-json"></i> OpenAPI JSON</a>
            <a class="rt-docs-btn" href="/"><i class="mdi mdi-view-dashboard"></i> App</a>
        </div>
    </div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
        window.ui = SwaggerUIBundle({
            url: '/openapi.json',
            dom_id: '#swagger-ui',
            deepLinking: true,
            persistAuthorization: true,
            displayRequestDuration: true,
            filter: true,
            tryItOutEnabled: false,
            syntaxHighlight: { activate: true, theme: 'agate' },
            layout: 'BaseLayout',
        });
    </script>
</body>
</html>
    """)

@app.get("/api-docs", include_in_schema=False)
async def api_docs_shortcut():
    return RedirectResponse("/docs")

@app.get("/api-docs.html", include_in_schema=False)
async def api_docs_page():
    return RedirectResponse("/docs")


@app.get("/branding/company/{company_id}/metadata")
async def company_branding_metadata(company_id: int):
    company = await _get_company_for_branding(company_id)
    if not company:
        return {
            "app_name": None,
            "branding_version": 1,
            "icon_url": None,
            "badge_url": None,
        }
    return {
        "app_name": company.app_name,
        "login_slug": company.login_slug,
        "branding_version": company.branding_version or 1,
        "icon_url": _branding_url(company, "icon-192.png") if company.icon_filename else None,
        "badge_url": _branding_url(company, "badge-96.png") if company.badge_filename else None,
    }


@app.get("/branding/login/{company_slug}/metadata")
async def company_login_branding_metadata(company_slug: str):
    company = await _get_company_for_login_slug(company_slug)
    if not company:
        return {
            "company_id": None,
            "app_name": None,
            "branding_version": 1,
            "icon_url": None,
            "badge_url": None,
        }
    return {
        "company_id": company.id,
        "app_name": company.app_name,
        "login_slug": company.login_slug,
        "branding_version": company.branding_version or 1,
        "icon_url": _branding_url(company, "icon-192.png") if company.icon_filename else None,
        "badge_url": _branding_url(company, "badge-96.png") if company.badge_filename else None,
    }


@app.get("/branding/company/{company_id}/{asset_name}")
async def company_branding_asset(company_id: int, asset_name: str):
    company = await _get_company_for_branding(company_id)
    if asset_name == "badge-96.png":
        custom = _company_file_path(company, "badge_filename")
        return _file_response(custom or DEFAULT_ICON_PATHS["badge-96"])

    default_key = asset_name.rsplit(".", 1)[0]
    if default_key not in DEFAULT_ICON_PATHS:
        return _file_response(DEFAULT_ICON_PATHS["icon-192"])

    custom = _company_file_path(company, "icon_filename")
    return _file_response(custom or DEFAULT_ICON_PATHS[default_key])


@app.get("/manifest.json")
async def web_manifest(company_id: Optional[int] = Query(None), company_slug: Optional[str] = Query(None)):
    company = await _get_company_for_branding(company_id)
    if company is None and company_slug:
        company = await _get_company_for_login_slug(company_slug)
    app_name = (company.app_name if company and company.app_name else None)
    name = app_name or DEFAULT_MANIFEST_NAME
    short_name = app_name or DEFAULT_APP_NAME
    if company and company.icon_filename:
        icon_192 = _branding_url(company, "icon-192.png")
        icon_512 = _branding_url(company, "icon-512.png")
    else:
        icon_192 = "icons/icon-192.png"
        icon_512 = "icons/icon-512.png"

    return {
        "id": f"/routario/company/{company.id}" if company and app_name else "/routario",
        "name": name,
        "short_name": short_name,
        "description": "Real-time GPS device tracking and alerts",
        "start_url": "/gps-dashboard.html",
        "display": "standalone",
        "background_color": "#0f172a",
        "theme_color": "#170b1c",
        "orientation": "natural",
        "icons": [
            {"src": icon_192, "sizes": "192x192", "purpose": "any"},
            {"src": icon_192, "sizes": "192x192", "purpose": "maskable"},
            {"src": icon_512, "sizes": "512x512", "purpose": "any"},
            {"src": icon_512, "sizes": "512x512", "purpose": "maskable"},
        ],
        "categories": ["navigation", "utilities"],
        "shortcuts": [
            {
                "name": "Dashboard",
                "url": "/gps-dashboard.html",
                "description": "Open live map dashboard",
                "icons": [{"src": "icons/shortcut-dashboard.png", "sizes": "96x96", "type": "image/png"}],
            },
            {
                "name": "Devices",
                "url": "/device-management.html",
                "description": "Manage tracked devices",
                "icons": [{"src": "icons/shortcut-devices.png", "sizes": "96x96", "type": "image/png"}],
            },
            {
                "name": "User Settings",
                "url": "/user-settings.html",
                "description": "Manage your account and notifications",
                "icons": [{"src": "icons/shortcut-settings.png", "sizes": "96x96", "type": "image/png"}],
            },
        ],
    }


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
for _d in ["voice", "dashcam", "company-branding"]:
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
