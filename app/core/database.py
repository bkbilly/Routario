"""
Database Service - Routario Platform
Database-agnostic async SQLAlchemy implementation.
Spatial operations delegated to core.spatial (Shapely).
"""
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import bcrypt
from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import selectinload

from core.spatial import (
    calculate_distance_km,
    coords_to_wkt,
    point_in_geometry,
    wkt_to_geojson_coords,
)
from models.models import (
    Base,
    AlertHistory,
    CommandQueue,
    Device,
    DeviceState,
    Geofence,
    LocationShare,
    PositionRecord,
    Trip,
    User,
    user_device_association,
)
from models.schemas import (
    AlertCreate,
    CommandCreate,
    DeviceCreate,
    NormalizedPosition,
    UserCreate,
    UserUpdate,
)

logger = logging.getLogger(__name__)


def _make_async_url(database_url: str) -> str:
    """
    Convert a plain DB URL to the async-driver variant expected by
    SQLAlchemy's async engine.

    Supported mappings
    ------------------
    postgresql://   -> postgresql+asyncpg://
    postgres://     -> postgresql+asyncpg://
    mysql://        -> mysql+aiomysql://
    mariadb://      -> mariadb+aiomysql://
    sqlite:///      -> sqlite+aiosqlite:///
    """
    url = database_url
    for prefix, replacement in [
        ("postgresql+asyncpg://", "postgresql+asyncpg://"),  # already correct
        ("postgres://",           "postgresql+asyncpg://"),
        ("postgresql://",         "postgresql+asyncpg://"),
        ("mysql+aiomysql://",     "mysql+aiomysql://"),       # already correct
        ("mysql://",              "mysql+aiomysql://"),
        ("mariadb+aiomysql://",   "mariadb+aiomysql://"),
        ("mariadb://",            "mariadb+aiomysql://"),
        ("sqlite+aiosqlite:///",  "sqlite+aiosqlite:///"),    # already correct
        ("sqlite:///",            "sqlite+aiosqlite:///"),
    ]:
        if url.startswith(prefix.split("+")[0].split("://")[0]):
            # Only replace if not already the async variant
            if not any(url.startswith(p) for p in [
                "postgresql+asyncpg://", "mysql+aiomysql://",
                "mariadb+aiomysql://", "sqlite+aiosqlite://"
            ]):
                url = replacement + url.split("://", 1)[1]
                break
    return url


def _is_postgres(url: str) -> bool:
    return "postgresql" in url or "asyncpg" in url


def _is_sqlite(url: str) -> bool:
    return "sqlite" in url


class DatabaseService:

    def __init__(self, database_url: str):
        async_url = _make_async_url(database_url)
        self._db_url = async_url
        self._is_postgres = _is_postgres(async_url)
        self._is_sqlite   = _is_sqlite(async_url)

        connect_args: dict = {}
        if self._is_sqlite:
            # timeout=30 sets sqlite3's busy-wait (seconds) for every connection
            connect_args = {"check_same_thread": False, "timeout": 30}

        self.engine: AsyncEngine = create_async_engine(
            async_url,
            echo=False,
            # SQLite: single connection prevents concurrent-writer lock errors.
            # WAL mode + busy_timeout handle any remaining contention.
            pool_size=5 if self._is_sqlite else 20,
            max_overflow=0 if self._is_sqlite else 40,
            pool_pre_ping=True,
            connect_args=connect_args,
        )

        if self._is_sqlite:
            from sqlalchemy import event

            @event.listens_for(self.engine.sync_engine, "connect")
            def _set_sqlite_pragmas(dbapi_conn, _rec):
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()

        self.async_session_maker = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )

    async def init_db(self):
        """Create all tables. PostgreSQL also enables the uuid extension."""
        async with self.engine.begin() as conn:
            if self._is_postgres:
                # uuid-ossp is helpful but not strictly required — ignore failure
                try:
                    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"))
                except Exception:
                    pass
            if self._is_sqlite:
                await conn.execute(text("PRAGMA journal_mode=WAL"))
                await conn.execute(text("PRAGMA busy_timeout=30000"))
                await conn.execute(text("PRAGMA synchronous=NORMAL"))

            await conn.run_sync(Base.metadata.create_all)

            # Migration: add state column to integration_accounts for existing DBs
            try:
                await conn.execute(text("ALTER TABLE integration_accounts ADD COLUMN state TEXT"))
            except Exception:
                pass  # column already exists

            # Migration: add buffer_meters to geofences for existing DBs
            try:
                await conn.execute(text("ALTER TABLE geofences ADD COLUMN buffer_meters INTEGER DEFAULT 50"))
            except Exception:
                pass  # column already exists

            # Migration: widen devices.imei from VARCHAR(20) to VARCHAR(64)
            # Needed for integration-device synthetic IMEIs (e.g. EXT-google_find_hub-<canonic_id>).
            # PostgreSQL enforces VARCHAR width; SQLite ignores it and needs no migration.
            if self._is_postgres:
                try:
                    await conn.execute(text(
                        "ALTER TABLE devices ALTER COLUMN imei TYPE VARCHAR(64)"
                    ))
                except Exception:
                    pass  # already widened or unsupported

            # Clean up orphaned rows from devices that were deleted while
            # SQLite foreign-key enforcement was off (pre-fix databases).
            if self._is_sqlite:
                for tbl, col in [
                    ("device_states",   "device_id"),
                    ("position_records","device_id"),
                    ("trips",           "device_id"),
                    ("alert_history",   "device_id"),
                    ("command_queue",   "device_id"),
                    ("geofences",       "device_id"),
                    ("location_shares", "device_id"),
                ]:
                    try:
                        await conn.execute(text(
                            f"DELETE FROM {tbl} WHERE {col} IS NOT NULL"
                            f" AND {col} NOT IN (SELECT id FROM devices)"
                        ))
                    except Exception:
                        pass  # table may not exist in older schemas

        logger.info("Database initialised (%s)", self._db_url.split("://")[0])

    @asynccontextmanager
    async def get_session(self) -> AsyncSession:
        async with self.async_session_maker() as session:
            try:
                yield session
                await session.commit()
            except Exception as exc:
                await session.rollback()
                logger.error("Database error: %s", exc, exc_info=True)
                raise

    async def close(self):
        await self.engine.dispose()

    # ── Distance (delegated to Shapely / Haversine) ───────────────

    async def _calculate_distance(
        self,
        session: AsyncSession,  # kept for API compatibility — not used
        lat1: float, lon1: float,
        lat2: float, lon2: float,
    ) -> float:
        return calculate_distance_km(lat1, lon1, lat2, lon2)

    # ── Geofence checks ───────────────────────────────────────────

    async def check_geofence_violations(
        self, device_id: int, latitude: float, longitude: float
    ) -> List[Dict[str, Any]]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Geofence).where(
                    and_(
                        or_(Geofence.device_id == device_id, Geofence.device_id.is_(None)),
                        Geofence.is_active == True,
                    )
                )
            )
            geofences = result.scalars().all()

        violations = []
        for gf in geofences:
            is_inside = point_in_geometry(latitude, longitude, gf.polygon_wkt, gf.buffer_meters or 50)
            if is_inside and gf.alert_on_enter:
                violations.append({
                    "type": "enter",
                    "geofence_id": gf.id,
                    "geofence_name": gf.name,
                })
            elif not is_inside and gf.alert_on_exit:
                violations.append({
                    "type": "exit",
                    "geofence_id": gf.id,
                    "geofence_name": gf.name,
                })
        return violations

    # ── Geofence CRUD ─────────────────────────────────────────────

    async def create_geofence(self, geofence_data: Dict[str, Any]) -> Geofence:
        async with self.get_session() as session:
            geofence = Geofence(
                device_id=geofence_data.get("device_id"),
                name=geofence_data["name"],
                description=geofence_data.get("description"),
                polygon_wkt=coords_to_wkt(
                    geofence_data["polygon"],
                    geofence_data.get("geometry_type", "polygon"),
                ),
                alert_on_enter=geofence_data.get("alert_on_enter", False),
                alert_on_exit=geofence_data.get("alert_on_exit", False),
                color=geofence_data.get("color", "#3388ff"),
                geometry_type=geofence_data.get("geometry_type", "polygon"),
                buffer_meters=geofence_data.get("buffer_meters", 50),
            )
            session.add(geofence)
            await session.flush()
            return geofence

    async def update_geofence(
        self, geofence_id: int, update_data: dict
    ) -> Optional[Geofence]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Geofence).where(Geofence.id == geofence_id)
            )
            gf = result.scalar_one_or_none()
            if not gf:
                return None

            for field in ("name", "description", "color", "alert_on_enter",
                          "alert_on_exit", "geometry_type", "buffer_meters"):
                if field in update_data and update_data[field] is not None:
                    setattr(gf, field, update_data[field])

            if update_data.get("polygon"):
                gtype = update_data.get("geometry_type") or gf.geometry_type or "polygon"
                gf.polygon_wkt = coords_to_wkt(update_data["polygon"], gtype)

            await session.flush()
            return gf

    async def get_geofences(
        self, device_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        async with self.get_session() as session:
            query = select(Geofence).where(Geofence.is_active == True)
            if device_id is not None:
                query = query.where(
                    or_(Geofence.device_id == device_id, Geofence.device_id.is_(None))
                )
            result = await session.execute(query)
            geofences = result.scalars().all()

        return [
            {
                "id":             gf.id,
                "device_id":      gf.device_id,
                "name":           gf.name,
                "description":    gf.description,
                "alert_on_enter": gf.alert_on_enter,
                "alert_on_exit":  gf.alert_on_exit,
                "is_active":      gf.is_active,
                "color":          gf.color,
                "geometry_type":  gf.geometry_type or "polygon",
                "buffer_meters":  gf.buffer_meters or 50,
                "created_at":     gf.created_at,
                "coordinates":    wkt_to_geojson_coords(
                    gf.polygon_wkt, gf.geometry_type or "polygon"
                ),
            }
            for gf in geofences
        ]

    async def delete_geofence(self, geofence_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(
                delete(Geofence).where(Geofence.id == geofence_id)
            )
            return result.rowcount > 0

    # ── User CRUD ─────────────────────────────────────────────────

    async def create_user(self, user_data: UserCreate) -> User:
        async with self.get_session() as session:
            pw_hash = bcrypt.hashpw(
                user_data.password.encode(), bcrypt.gensalt()
            ).decode()
            user = User(
                username=user_data.username,
                email=user_data.email,
                password_hash=pw_hash,
                is_admin=user_data.is_admin,
                notification_channels=user_data.notification_channels,
            )
            session.add(user)
            await session.flush()
            await session.refresh(user)
            return user

    async def authenticate_user(self, username: str, password: str) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(
                select(User).where(
                    or_(User.username == username, User.email == username)
                )
            )
            user = result.scalar_one_or_none()
        if not user:
            return None
        if bcrypt.checkpw(password.encode(), user.password_hash.encode()):
            return user
        return None

    async def update_user(self, user_id: int, user_data: UserUpdate) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if not user:
                return None
            if user_data.email:
                user.email = user_data.email
            if user_data.password:
                user.password_hash = bcrypt.hashpw(
                    user_data.password.encode(), bcrypt.gensalt()
                ).decode()
            if user_data.notification_channels is not None:
                user.notification_channels = user_data.notification_channels
            if user_data.language:
                user.language = user_data.language
            if user_data.webhook_urls is not None:
                user.webhook_urls = user_data.webhook_urls
            if user_data.is_admin is not None:
                user.is_admin = user_data.is_admin
            await session.flush()
            await session.refresh(user)
            return user

    async def get_user(self, user_id: int) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            return result.scalar_one_or_none()

    async def get_user_by_username(self, username: str) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(
                select(User).where(User.username == username)
            )
            return result.scalar_one_or_none()

    # ── Device CRUD ───────────────────────────────────────────────

    async def create_device(self, device_data: DeviceCreate) -> Device:
        async with self.get_session() as session:
            device = Device(
                imei=device_data.imei,
                name=device_data.name,
                protocol=device_data.protocol,
                vehicle_type=device_data.vehicle_type,
                license_plate=device_data.license_plate,
                vin=device_data.vin,
                config=device_data.config.model_dump(),
            )
            session.add(device)
            await session.flush()
            await session.refresh(device)
            # Use get-or-create to avoid UNIQUE constraint crash on retry
            await self._get_or_create_state(session, device.id)
            await session.flush()
            return device

    async def get_device_by_imei(self, imei: str) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.imei == imei)
                .options(selectinload(Device.state), selectinload(Device.users))
            )
            return result.scalar_one_or_none()

    async def get_device_by_id(self, device_id: int) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.id == device_id)
                .options(selectinload(Device.state), selectinload(Device.users))
            )
            return result.scalar_one_or_none()

    async def get_user_devices(self, user_id: int) -> List[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .join(Device.users)
                .where(User.id == user_id)
                .options(selectinload(Device.state))
            )
            return result.scalars().all()

    async def update_device(
        self, device_id: int, device_data: DeviceCreate
    ) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device).where(Device.id == device_id)
            )
            device = result.scalar_one_or_none()
            if not device:
                return None
            device.name          = device_data.name
            device.imei          = device_data.imei
            device.protocol      = device_data.protocol
            device.vehicle_type  = device_data.vehicle_type
            device.license_plate = device_data.license_plate
            device.vin           = device_data.vin
            device.config        = device_data.config.model_dump()
            await session.flush()
            await session.refresh(device)
            return device

    async def delete_device(self, device_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(
                delete(Device).where(Device.id == device_id)
            )
            return result.rowcount > 0

    async def add_device_to_user(
        self, user_id: int, device_id: int, access_level: str = "admin"
    ):
        async with self.get_session() as session:
            existing = await session.execute(
                select(user_device_association).where(
                    user_device_association.c.user_id == user_id,
                    user_device_association.c.device_id == device_id,
                )
            )
            if existing.first() is None:
                await session.execute(
                    user_device_association.insert().values(
                        user_id=user_id, device_id=device_id, access_level=access_level
                    )
                )

    # ── Position processing ───────────────────────────────────────

    async def process_position(self, position: NormalizedPosition) -> bool:
        device_time = position.device_time
        if device_time.tzinfo is not None:
            device_time = device_time.astimezone(timezone.utc).replace(tzinfo=None)

        async with self.get_session() as session:
            device = await self._get_device_by_imei_internal(session, position.imei)
            if not device:
                logger.warning("Unknown device: %s", position.imei)
                return False

            state = await self._get_or_create_state(session, device.id)

            distance_km = 0.0
            if state.last_latitude is not None:
                distance_km = calculate_distance_km(
                    state.last_latitude, state.last_longitude,
                    position.latitude, position.longitude,
                )
                if distance_km > 50.0:
                    distance_km = 0.0

            await self._handle_trip_logic(session, device, state, position, device_time)

            state.total_odometer += distance_km
            if state.active_trip_id:
                state.trip_odometer += distance_km

            state.last_latitude  = position.latitude
            state.last_longitude = position.longitude
            state.last_altitude  = position.altitude
            state.last_speed     = position.speed
            state.last_course    = position.course
            state.last_update    = datetime.utcnow()
            if position.ignition is not None:
                state.ignition_on = position.ignition
            state.is_moving  = (position.speed or 0) > 1.0
            state.is_online  = True

            if position.sensors:
                state.sensors = position.sensors
            if position.satellites is not None:
                state.sensors = {**(state.sensors or {}), "last_known_satellites": position.satellites}
            state.sensors = {**(state.sensors or {}), "last_gps_time": device_time.isoformat()}

            rec = PositionRecord(
                device_id=device.id,
                latitude=position.latitude,
                longitude=position.longitude,
                altitude=position.altitude,
                speed=position.speed,
                course=position.course,
                satellites=position.satellites,
                ignition=position.ignition,
                sensors=position.sensors,
                device_time=device_time,
                server_time=(
                    position.server_time.replace(tzinfo=None)
                    if position.server_time else datetime.utcnow()
                ),
            )
            session.add(rec)
            await session.flush()
            return True

    async def _get_device_by_imei_internal(
        self, session: AsyncSession, imei: str
    ) -> Optional[Device]:
        result = await session.execute(select(Device).where(Device.imei == imei))
        return result.scalar_one_or_none()

    async def _get_or_create_state(
        self, session: AsyncSession, device_id: int
    ) -> DeviceState:
        result = await session.execute(
            select(DeviceState).where(DeviceState.device_id == device_id)
        )
        state = result.scalar_one_or_none()
        if not state:
            state = DeviceState(device_id=device_id)
            session.add(state)
            await session.flush()
        return state

    async def _handle_trip_logic(
        self,
        session: AsyncSession,
        device: Device,
        state: DeviceState,
        position: NormalizedPosition,
        device_time: datetime,
    ):
        if position.ignition is None:
            return

        if position.ignition and not state.active_trip_id:
            if state.last_ignition_off:
                off = state.last_ignition_off
                if off.tzinfo and not device_time.tzinfo:
                    off = off.replace(tzinfo=None)
                if 0 < (device_time - off).total_seconds() < 30:
                    return
            trip = Trip(
                device_id=device.id,
                start_time=device_time,
                start_latitude=position.latitude,
                start_longitude=position.longitude,
                distance_km=0.0,
            )
            session.add(trip)
            await session.flush()
            state.active_trip_id   = trip.id
            state.last_ignition_on = device_time
            state.trip_odometer    = 0.0

        elif not position.ignition and state.active_trip_id:
            trip = await session.get(Trip, state.active_trip_id)
            if trip:
                trip.end_time        = device_time
                trip.end_latitude    = position.latitude
                trip.end_longitude   = position.longitude
                trip.distance_km     = state.trip_odometer
                start = trip.start_time
                if start.tzinfo and not device_time.tzinfo:
                    start = start.replace(tzinfo=None)
                mins = int((device_time - start).total_seconds() / 60)
                trip.duration_minutes = mins
                if mins > 0:
                    trip.avg_speed = (trip.distance_km / mins) * 60
            state.active_trip_id   = None
            state.last_ignition_off = device_time

    # ── Position history ──────────────────────────────────────────

    async def get_position_history(
        self,
        device_id: int,
        start_time: datetime,
        end_time: datetime,
        max_points: int = 1000,
        order: str = "asc",
    ) -> List[PositionRecord]:
        if start_time.tzinfo:
            start_time = start_time.astimezone(timezone.utc).replace(tzinfo=None)
        if end_time.tzinfo:
            end_time = end_time.astimezone(timezone.utc).replace(tzinfo=None)

        sort_col = (
            PositionRecord.device_time.desc()
            if order == "desc"
            else PositionRecord.device_time.asc()
        )
        async with self.get_session() as session:
            result = await session.execute(
                select(PositionRecord)
                .where(
                    and_(
                        PositionRecord.device_id == device_id,
                        PositionRecord.device_time >= start_time,
                        PositionRecord.device_time <= end_time,
                    )
                )
                .order_by(sort_col)
                .limit(max_points)
            )
            return result.scalars().all()

    async def get_recent_positions(
        self, device_id: int, seconds: int = 15, max_points: int = 20
    ) -> List[PositionRecord]:
        cutoff = datetime.utcnow() - timedelta(seconds=seconds)
        try:
            async with self.get_session() as session:
                result = await session.execute(
                    select(PositionRecord)
                    .where(
                        and_(
                            PositionRecord.device_id == device_id,
                            PositionRecord.device_time >= cutoff,
                        )
                    )
                    .order_by(PositionRecord.device_time.asc())
                    .limit(max_points)
                )
                return result.scalars().all()
        except Exception as exc:
            logger.debug("get_recent_positions error: %s", exc)
            return []

    # ── Trips ─────────────────────────────────────────────────────

    async def get_device_trips(
        self, device_id: int, start_date: datetime, end_date: datetime
    ) -> List[Trip]:
        if start_date.tzinfo:
            start_date = start_date.astimezone(timezone.utc).replace(tzinfo=None)
        if end_date.tzinfo:
            end_date = end_date.astimezone(timezone.utc).replace(tzinfo=None)
        async with self.get_session() as session:
            result = await session.execute(
                select(Trip)
                .where(
                    and_(
                        Trip.device_id == device_id,
                        Trip.start_time >= start_date,
                        Trip.start_time <= end_date,
                    )
                )
                .order_by(Trip.start_time.desc())
            )
            return result.scalars().all()

    # ── Alerts ────────────────────────────────────────────────────

    async def create_alert(self, alert_data: AlertCreate) -> AlertHistory:
        async with self.get_session() as session:
            alert = AlertHistory(
                user_id=alert_data.user_id,
                device_id=alert_data.device_id,
                alert_type=alert_data.alert_type,
                severity=alert_data.severity,
                message=alert_data.message,
                latitude=alert_data.latitude,
                longitude=alert_data.longitude,
                address=alert_data.address,
                alert_metadata=alert_data.alert_metadata,
            )
            session.add(alert)
            await session.flush()
            return alert

    async def get_user_alerts(
        self,
        user_id: int,
        unread_only: bool = False,
        device_id: Optional[int] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[AlertHistory]:
        async with self.get_session() as session:
            query = select(AlertHistory).where(AlertHistory.user_id == user_id)
            if unread_only:
                query = query.where(AlertHistory.is_read == False)
            if device_id:
                query = query.where(AlertHistory.device_id == device_id)
            query = query.order_by(AlertHistory.created_at.desc()).limit(limit).offset(offset)
            result = await session.execute(query)
            return result.scalars().all()

    async def mark_alert_read(self, alert_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(
                update(AlertHistory)
                .where(AlertHistory.id == alert_id)
                .values(is_read=True, read_at=datetime.utcnow())
            )
            return result.rowcount > 0

    async def delete_alert(self, alert_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(
                delete(AlertHistory).where(AlertHistory.id == alert_id)
            )
            return result.rowcount > 0

    async def update_device_alert_state(
        self, device_id: int, alert_states: Dict[str, Any]
    ):
        async with self.get_session() as session:
            await session.execute(
                update(DeviceState)
                .where(DeviceState.device_id == device_id)
                .values(alert_states=alert_states)
            )

    # ── Commands ──────────────────────────────────────────────────

    async def create_command(self, command_data: CommandCreate) -> CommandQueue:
        async with self.get_session() as session:
            cmd = CommandQueue(
                device_id=command_data.device_id,
                command_type=command_data.command_type,
                payload=command_data.payload,
                max_retries=command_data.max_retries,
            )
            session.add(cmd)
            await session.flush()
            return cmd

    async def get_pending_commands(self, device_id: int) -> List[CommandQueue]:
        async with self.get_session() as session:
            result = await session.execute(
                select(CommandQueue)
                .where(
                    and_(
                        CommandQueue.device_id == device_id,
                        CommandQueue.status == "pending",
                    )
                )
                .order_by(CommandQueue.created_at)
            )
            return result.scalars().all()

    async def mark_command_sent(self, command_id: int):
        async with self.get_session() as session:
            await session.execute(
                update(CommandQueue)
                .where(CommandQueue.id == command_id)
                .values(status="sent", sent_at=datetime.utcnow())
            )

    async def mark_oldest_sent_command_acked(
        self, device_id: int, response_text: str = ""
    ) -> bool:
        async with self.get_session() as session:
            result = await session.execute(
                select(CommandQueue)
                .where(
                    and_(
                        CommandQueue.device_id == device_id,
                        CommandQueue.status == "sent",
                    )
                )
                .order_by(CommandQueue.sent_at.asc())
                .limit(1)
            )
            cmd = result.scalar_one_or_none()
            if not cmd:
                return False
            await session.execute(
                update(CommandQueue)
                .where(CommandQueue.id == cmd.id)
                .values(
                    status="acked",
                    acked_at=datetime.utcnow(),
                    response=response_text or None,
                )
            )
            return True

    async def get_device_commands(
        self, device_id: int, status: Optional[str] = None
    ) -> List[CommandQueue]:
        async with self.get_session() as session:
            query = select(CommandQueue).where(CommandQueue.device_id == device_id)
            if status:
                query = query.where(CommandQueue.status == status)
            result = await session.execute(
                query.order_by(CommandQueue.created_at.desc())
            )
            return result.scalars().all()

    # ── Device state helpers ──────────────────────────────────────

    async def get_device_state(self, device_id: int) -> Optional[DeviceState]:
        async with self.get_session() as session:
            result = await session.execute(
                select(DeviceState).where(DeviceState.device_id == device_id)
            )
            return result.scalar_one_or_none()

    async def get_all_active_devices_with_state(
        self,
    ) -> List[tuple[Device, DeviceState]]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device, DeviceState)
                .join(DeviceState, Device.id == DeviceState.device_id)
                .where(Device.is_active == True)
                .options(selectinload(Device.users))
            )
            return [(d, s) for d, s in result.all()]

    async def mark_device_offline(self, device_id: int):
        async with self.get_session() as session:
            await session.execute(
                update(DeviceState)
                .where(DeviceState.device_id == device_id)
                .values(is_online=False)
            )

    # ── Statistics ────────────────────────────────────────────────

    async def get_device_statistics(
        self, device_id: int, start_date: datetime, end_date: datetime
    ) -> Optional[Dict[str, Any]]:
        device = await self.get_device_by_id(device_id)
        if not device:
            return None
        if start_date.tzinfo:
            start_date = start_date.astimezone(timezone.utc).replace(tzinfo=None)
        if end_date.tzinfo:
            end_date = end_date.astimezone(timezone.utc).replace(tzinfo=None)

        trips = await self.get_device_trips(device_id, start_date, end_date)
        total_dist = sum(t.distance_km for t in trips)
        avg_speeds = [t.avg_speed for t in trips if t.avg_speed]
        max_speeds = [t.max_speed for t in trips if t.max_speed]

        async with self.get_session() as session:
            idle_count = await session.execute(
                select(func.count(PositionRecord.id)).where(
                    and_(
                        PositionRecord.device_id == device_id,
                        PositionRecord.device_time >= start_date,
                        PositionRecord.device_time <= end_date,
                        PositionRecord.ignition == True,
                        PositionRecord.speed < 1.0,
                    )
                )
            )
            total_idle = idle_count.scalar() or 0

        return {
            "device_id":                  device_id,
            "total_distance_km":          round(total_dist, 2),
            "total_trips":                len(trips),
            "avg_speed":                  round(sum(avg_speeds) / len(avg_speeds), 1) if avg_speeds else 0,
            "max_speed":                  round(max(max_speeds), 1) if max_speeds else 0,
            "total_idle_time_minutes":    total_idle,
            "total_driving_time_minutes": sum(
                t.duration_minutes for t in trips if t.duration_minutes
            ),
            "period_start": start_date,
            "period_end":   end_date,
        }

    # ── Unread alias ──────────────────────────────────────────────

    async def get_unread_alerts(
        self, user_id: int, limit: int = 50
    ) -> List[AlertHistory]:
        return await self.get_user_alerts(user_id, unread_only=True, limit=limit)


# ── Singleton ─────────────────────────────────────────────────────

db_service: Optional[DatabaseService] = None


async def init_database(database_url: str) -> DatabaseService:
    global db_service
    db_service = DatabaseService(database_url)
    await db_service.init_db()
    return db_service


def get_db() -> DatabaseService:
    if db_service is None:
        raise RuntimeError("Database not initialised — call init_database() first.")
    return db_service
