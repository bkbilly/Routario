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
    Company,
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
    CompanyCreate,
    CompanyUpdate,
    DeviceCreate,
    NormalizedPosition,
    UserCreate,
    UserUpdate,
)
from core.auto_assign import handle_ignition_off, handle_trip_end, evaluate as evaluate_auto_assign

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

        # Run each migration in its own transaction so a no-op failure (column
        # already exists) on PostgreSQL doesn't abort the whole block.
        migrations = [
            "ALTER TABLE integration_accounts ADD COLUMN state TEXT",
            "ALTER TABLE geofences ADD COLUMN buffer_meters INTEGER DEFAULT 50",
            # Old schema had a 'polygon' column (NOT NULL) that was renamed to
            # 'polygon_wkt' in the model. Drop the NOT NULL so inserts don't fail.
            "ALTER TABLE geofences ALTER COLUMN polygon DROP NOT NULL",
            "ALTER TABLE users ADD COLUMN units VARCHAR(10) DEFAULT 'metric'",
            "ALTER TABLE users ADD COLUMN currency VARCHAR(3) DEFAULT 'EUR'",
            "ALTER TABLE fuel_logs ADD COLUMN currency VARCHAR(3) DEFAULT 'EUR'",
            "ALTER TABLE fuel_logs ADD COLUMN exchange_rate FLOAT DEFAULT 1.0",
            "ALTER TABLE logbook_entries ADD COLUMN currency VARCHAR(3) DEFAULT 'EUR'",
            "ALTER TABLE logbook_entries ADD COLUMN exchange_rate FLOAT DEFAULT 1.0",
            "ALTER TABLE users ADD COLUMN company_id INTEGER",
            "ALTER TABLE users ADD COLUMN is_company_admin BOOLEAN DEFAULT FALSE",
            "ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT NULL",
            "ALTER TABLE companies ADD COLUMN app_name VARCHAR(100)",
            "ALTER TABLE companies ADD COLUMN login_slug VARCHAR(100)",
            "ALTER TABLE companies ADD COLUMN icon_filename VARCHAR(255)",
            "ALTER TABLE companies ADD COLUMN badge_filename VARCHAR(255)",
            "ALTER TABLE companies ADD COLUMN branding_version INTEGER DEFAULT 1",
            "ALTER TABLE companies ADD COLUMN billing_plan_id INTEGER",
            "ALTER TABLE companies ADD COLUMN billing_email VARCHAR(255)",
            "ALTER TABLE companies ADD COLUMN billing_status VARCHAR(30) DEFAULT 'active'",
            "ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN DEFAULT FALSE",
            "ALTER TABLE users ADD COLUMN mfa_secret VARCHAR(64)",
            "ALTER TABLE users ADD COLUMN mfa_recovery_codes TEXT DEFAULT '[]'",
            "ALTER TABLE devices ADD COLUMN company_id INTEGER",
            "ALTER TABLE geofences ADD COLUMN user_id INTEGER",
            "ALTER TABLE device_states ADD COLUMN last_trip_id INTEGER",
            "ALTER TABLE devices ADD COLUMN custom_attributes JSON DEFAULT '{}'",
            "ALTER TABLE device_states ADD COLUMN current_driver_id INTEGER",
            "ALTER TABLE trips ADD COLUMN driver_id INTEGER",
            "ALTER TABLE drivers ADD COLUMN user_id INTEGER",
            "ALTER TABLE drivers ADD COLUMN assignment_rule TEXT",
            "ALTER TABLE drivers ADD COLUMN assignment_vehicles TEXT",
            "ALTER TABLE drivers ADD COLUMN assignment_mode VARCHAR(20)",
            "ALTER TABLE drivers ADD COLUMN assignment_grace_period INTEGER",
            "ALTER TABLE drivers ADD COLUMN assignment_clear VARCHAR(20)",
            "ALTER TABLE position_records ADD COLUMN driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL",
            "ALTER TABLE scheduled_reports ADD COLUMN user_timezone VARCHAR(50) DEFAULT 'UTC'",
            "ALTER TABLE scheduled_reports ADD COLUMN options JSON DEFAULT '{}'",
            "ALTER TABLE scheduled_reports ADD COLUMN notification_channels JSON DEFAULT '[]'",
            "ALTER TABLE scheduled_reports ADD COLUMN attach_results BOOLEAN DEFAULT TRUE",
            "ALTER TABLE scheduled_reports ADD COLUMN attach_documents BOOLEAN DEFAULT TRUE",
            """CREATE TABLE IF NOT EXISTS voice_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                recipient_ids TEXT DEFAULT '[]',
                file_path VARCHAR(256) NOT NULL,
                duration_seconds REAL DEFAULT 0.0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS voice_message_reads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL REFERENCES voice_messages(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, user_id)
            )""",
            """CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
                action VARCHAR(100) NOT NULL,
                target_type VARCHAR(100),
                target_id VARCHAR(100),
                ip_address VARCHAR(64),
                user_agent VARCHAR(500),
                metadata_json JSON DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(120) NOT NULL,
                key_prefix VARCHAR(24) NOT NULL,
                key_hash VARCHAR(128) NOT NULL UNIQUE,
                scopes JSON DEFAULT '[]',
                is_active BOOLEAN DEFAULT 1,
                expires_at DATETIME,
                last_used_at DATETIME,
                last_used_ip VARCHAR(64),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                revoked_at DATETIME
            )""",
            """CREATE TABLE IF NOT EXISTS billing_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(120) NOT NULL UNIQUE,
                currency VARCHAR(3) DEFAULT 'EUR',
                base_price_cents INTEGER DEFAULT 0,
                included_devices INTEGER DEFAULT 0,
                included_positions INTEGER DEFAULT 0,
                included_api_calls INTEGER DEFAULT 0,
                price_per_device_cents INTEGER DEFAULT 0,
                price_per_1000_positions_cents INTEGER DEFAULT 0,
                price_per_1000_api_calls_cents INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                metric VARCHAR(80) NOT NULL,
                quantity INTEGER DEFAULT 1,
                source VARCHAR(80),
                metadata_json JSON DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS billing_invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                period_start DATETIME NOT NULL,
                period_end DATETIME NOT NULL,
                currency VARCHAR(3) DEFAULT 'EUR',
                exchange_rate FLOAT DEFAULT 1.0,
                amount_cents INTEGER DEFAULT 0,
                amount_display_cents INTEGER DEFAULT 0,
                status VARCHAR(30) DEFAULT 'draft',
                line_items JSON DEFAULT '[]',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS currency_rates (
                currency VARCHAR(3) PRIMARY KEY,
                rate FLOAT NOT NULL DEFAULT 1.0,
                source VARCHAR(80) NOT NULL DEFAULT 'manual',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS planned_routes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(200) NOT NULL,
                device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
                status VARCHAR(30) DEFAULT 'draft',
                route_geometry JSON,
                distance_km FLOAT,
                duration_minutes FLOAT,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )""",
            """CREATE TABLE IF NOT EXISTS route_stops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                route_id INTEGER NOT NULL REFERENCES planned_routes(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL,
                name VARCHAR(200),
                address VARCHAR(500),
                latitude FLOAT NOT NULL,
                longitude FLOAT NOT NULL,
                planned_arrival DATETIME,
                service_minutes INTEGER DEFAULT 0,
                stop_kind VARCHAR(30) DEFAULT 'stop',
                arrival_radius_m INTEGER DEFAULT 50,
                dwell_seconds INTEGER DEFAULT 0,
                status VARCHAR(30) DEFAULT 'pending',
                arrived_at DATETIME,
                completed_at DATETIME,
                notes TEXT
            )""",
            "ALTER TABLE billing_plans ALTER COLUMN currency SET DEFAULT 'EUR'",
            "ALTER TABLE billing_invoices ALTER COLUMN currency SET DEFAULT 'EUR'",
            "ALTER TABLE billing_invoices ADD COLUMN exchange_rate FLOAT DEFAULT 1.0",
            "ALTER TABLE billing_invoices ADD COLUMN amount_display_cents INTEGER DEFAULT 0",
            "ALTER TABLE route_stops ADD COLUMN stop_kind VARCHAR(30) DEFAULT 'stop'",
            "ALTER TABLE route_stops ADD COLUMN arrival_radius_m INTEGER DEFAULT 50",
            "ALTER TABLE route_stops ADD COLUMN dwell_seconds INTEGER DEFAULT 0",
        ]
        if self._is_postgres:
            migrations.append("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP")
            migrations.append("ALTER TABLE devices ALTER COLUMN imei TYPE VARCHAR(64)")
            migrations.append("ALTER TABLE alert_history ALTER COLUMN device_id DROP NOT NULL")
            migrations.append("""
                ALTER TABLE drivers
                ALTER COLUMN assignment_vehicles TYPE JSONB
                USING CASE
                    WHEN assignment_vehicles IS NULL OR assignment_vehicles = 'null' THEN NULL
                    ELSE assignment_vehicles::jsonb
                END
            """)
        else:
            migrations.append("ALTER TABLE users ADD COLUMN last_activity DATETIME")

        for stmt in migrations:
            try:
                async with self.engine.begin() as conn:
                    await conn.execute(text(stmt))
            except Exception:
                pass  # column/change already applied

        # Grant all permissions to existing users who have never had permissions set.
        # NULL means "pre-permissions-feature" — give them full access so nothing breaks.
        try:
            from core.permissions import ALL_PERMISSIONS
            async with self.engine.begin() as conn:
                await conn.execute(
                    text("UPDATE users SET permissions = :p WHERE permissions IS NULL"),
                    {"p": json.dumps(ALL_PERMISSIONS)},
                )
        except Exception:
            pass

        # The billing UI now uses EUR. Normalize earlier default records so
        # existing plans and draft invoices render with the current currency.
        try:
            async with self.engine.begin() as conn:
                await conn.execute(text("UPDATE billing_plans SET currency = 'EUR' WHERE currency = 'USD'"))
                await conn.execute(text("UPDATE billing_invoices SET currency = 'EUR' WHERE currency = 'USD'"))
                await conn.execute(text("UPDATE billing_invoices SET amount_display_cents = amount_cents WHERE amount_display_cents IS NULL OR amount_display_cents = 0"))
        except Exception:
            pass

        try:
            from core.currency import DEFAULT_CURRENCY_RATES
            async with self.engine.begin() as conn:
                for currency, rate in DEFAULT_CURRENCY_RATES.items():
                    await conn.execute(
                        text(
                            "INSERT INTO currency_rates (currency, rate, source) "
                            "SELECT :currency, :rate, :source "
                            "WHERE NOT EXISTS (SELECT 1 FROM currency_rates WHERE currency = :currency)"
                        ),
                        {"currency": currency, "rate": float(rate), "source": "system" if currency == "EUR" else "default"},
                    )
        except Exception:
            pass

        # SQLite does not support ALTER COLUMN, so recreate alert_history to
        # make device_id nullable (needed for admin notifications without a device).
        if self._is_sqlite:
            try:
                async with self.engine.begin() as conn:
                    # Check if device_id is still NOT NULL by attempting a dry-run insert
                    result = await conn.execute(text(
                        "SELECT COUNT(*) FROM pragma_table_info('alert_history') "
                        "WHERE name='device_id' AND \"notnull\"=1"
                    ))
                    if result.scalar():
                        await conn.execute(text("""
                            CREATE TABLE alert_history_new (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                                device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
                                alert_type VARCHAR(50) NOT NULL,
                                severity VARCHAR(20) DEFAULT 'info',
                                message TEXT NOT NULL,
                                latitude FLOAT,
                                longitude FLOAT,
                                address VARCHAR(500),
                                alert_metadata JSON DEFAULT '{}',
                                is_read BOOLEAN DEFAULT 0,
                                read_at DATETIME,
                                is_acknowledged BOOLEAN DEFAULT 0,
                                created_at DATETIME
                            )
                        """))
                        await conn.execute(text(
                            "INSERT INTO alert_history_new SELECT * FROM alert_history"
                        ))
                        await conn.execute(text("DROP TABLE alert_history"))
                        await conn.execute(text(
                            "ALTER TABLE alert_history_new RENAME TO alert_history"
                        ))
            except Exception:
                pass

        # Clean up orphaned rows from devices that were deleted while
        # SQLite foreign-key enforcement was off (pre-fix databases).
        if self._is_sqlite:
            async with self.engine.begin() as conn:
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

    async def create_geofence(self, geofence_data: Dict[str, Any], user_id: int) -> Geofence:
        async with self.get_session() as session:
            geofence = Geofence(
                user_id=user_id,
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
        self, geofence_id: int, update_data: dict, user_id: Optional[int] = None
    ) -> Optional[Geofence]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Geofence).where(Geofence.id == geofence_id)
            )
            gf = result.scalar_one_or_none()
            if not gf:
                return None
            if user_id is not None and gf.user_id != user_id:
                return "forbidden"

            for field in ("name", "description", "color", "alert_on_enter",
                          "alert_on_exit", "geometry_type", "buffer_meters", "user_id"):
                if field in update_data and update_data[field] is not None:
                    setattr(gf, field, update_data[field])

            if update_data.get("polygon"):
                gtype = update_data.get("geometry_type") or gf.geometry_type or "polygon"
                gf.polygon_wkt = coords_to_wkt(update_data["polygon"], gtype)

            await session.flush()
            return gf

    async def get_geofences(
        self, device_id: Optional[int] = None, user_id: Optional[int] = None,
        company_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        async with self.get_session() as session:
            query = (
                select(Geofence, User.username)
                .outerjoin(User, Geofence.user_id == User.id)
                .where(Geofence.is_active == True)
            )
            if company_id is not None:
                company_user_ids = select(User.id).where(User.company_id == company_id)
                query = query.where(Geofence.user_id.in_(company_user_ids))
            elif user_id is not None:
                query = query.where(Geofence.user_id == user_id)
            if device_id is not None:
                query = query.where(
                    or_(Geofence.device_id == device_id, Geofence.device_id.is_(None))
                )
            result = await session.execute(query)
            rows = result.all()

        return [
            {
                "id":             gf.id,
                "user_id":        gf.user_id,
                "owner_username": username,
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
            for gf, username in rows
        ]

    async def delete_geofence(self, geofence_id: int, user_id: Optional[int] = None):
        async with self.get_session() as session:
            result = await session.execute(
                select(Geofence).where(Geofence.id == geofence_id)
            )
            gf = result.scalar_one_or_none()
            if not gf:
                return False
            if user_id is not None and gf.user_id != user_id:
                return "forbidden"
            await session.execute(delete(Geofence).where(Geofence.id == geofence_id))
            return True

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
                company_id=user_data.company_id,
                is_company_admin=user_data.is_company_admin,
                notification_channels=user_data.notification_channels,
                language=user_data.language or "en",
                units=user_data.units or "metric",
                currency=(user_data.currency or "EUR").upper(),
                permissions=user_data.permissions if user_data.permissions is not None else [],
            )
            session.add(user)
            await session.flush()
            await session.refresh(user)
            return user

    async def authenticate_user(self, username: str, password: str) -> Optional[User]:
        identifier = (username or "").strip()
        identifier_lower = identifier.lower()
        async with self.get_session() as session:
            result = await session.execute(
                select(User).where(
                    or_(
                        func.lower(User.username) == identifier_lower,
                        func.lower(User.email) == identifier_lower,
                    )
                )
            )
            user = result.scalar_one_or_none()
            if not user:
                return None
            if bcrypt.checkpw(password.encode(), user.password_hash.encode()):
                return user
        return None

    async def touch_user_activity(self, user_id: int, interval_minutes: int = 15) -> None:
        cutoff = datetime.utcnow() - timedelta(minutes=interval_minutes)
        async with self.get_session() as session:
            await session.execute(
                update(User)
                .where(
                    User.id == user_id,
                    or_(User.last_activity.is_(None), User.last_activity < cutoff),
                )
                .values(last_activity=datetime.utcnow())
            )

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
            if user_data.units is not None:
                user.units = user_data.units
            if user_data.currency is not None:
                user.currency = user_data.currency.upper()
            if user_data.webhook_urls is not None:
                user.webhook_urls = user_data.webhook_urls
            if user_data.is_admin is not None:
                user.is_admin = user_data.is_admin
            if user_data.is_company_admin is not None:
                user.is_company_admin = user_data.is_company_admin
            if user_data.company_id is not None:
                user.company_id = user_data.company_id
            if user_data.permissions is not None:
                user.permissions = user_data.permissions
            await session.flush()
            await session.refresh(user)
            return user

    async def get_user(self, user_id: int) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            return result.scalar_one_or_none()

    async def get_users_by_ids(self, user_ids: List[int]) -> List[User]:
        ids = [int(uid) for uid in user_ids if uid is not None]
        if not ids:
            return []
        async with self.get_session() as session:
            result = await session.execute(select(User).where(User.id.in_(ids)))
            return result.scalars().all()

    async def get_user_by_username(self, username: str) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(
                select(User).where(User.username == username)
            )
            return result.scalar_one_or_none()

    # ── Company CRUD ─────────────────────────────────────────────

    async def create_company(self, data: CompanyCreate) -> Company:
        async with self.get_session() as session:
            company = Company(
                name=data.name,
                app_name=(data.app_name or None),
                login_slug=(data.login_slug or None),
            )
            session.add(company)
            await session.flush()
            await session.refresh(company)
            return company

    async def get_company(self, company_id: int) -> Optional[Company]:
        async with self.get_session() as session:
            result = await session.execute(select(Company).where(Company.id == company_id))
            return result.scalar_one_or_none()

    async def get_all_companies(self) -> List[Company]:
        async with self.get_session() as session:
            result = await session.execute(select(Company))
            return result.scalars().all()

    async def update_company(self, company_id: int, data: CompanyUpdate) -> Optional[Company]:
        async with self.get_session() as session:
            result = await session.execute(select(Company).where(Company.id == company_id))
            company = result.scalar_one_or_none()
            if not company:
                return None
            if data.name is not None:
                company.name = data.name
            if "app_name" in data.model_fields_set:
                next_app_name = data.app_name or None
                if company.app_name != next_app_name:
                    company.app_name = next_app_name
                    company.branding_version = (company.branding_version or 1) + 1
            if "login_slug" in data.model_fields_set:
                company.login_slug = data.login_slug or None
            await session.flush()
            await session.refresh(company)
            return company

    async def delete_company(self, company_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(delete(Company).where(Company.id == company_id))
            return result.rowcount > 0

    # ── Device CRUD ───────────────────────────────────────────────

    async def create_device(self, device_data: DeviceCreate) -> Device:
        async with self.get_session() as session:
            device = Device(
                imei=device_data.imei,
                name=device_data.name,
                protocol=device_data.protocol,
                vehicle_type=device_data.vehicle_type,
                license_plate=device_data.license_plate,
                custom_attributes=device_data.custom_attributes or {},
                config=device_data.config.model_dump(),
                company_id=device_data.company_id,
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
                .options(
                    selectinload(Device.state).selectinload(DeviceState.current_driver),
                    selectinload(Device.users),
                )
            )
            return result.scalar_one_or_none()

    async def get_device_by_id(self, device_id: int) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.id == device_id)
                .options(
                    selectinload(Device.state).selectinload(DeviceState.current_driver),
                    selectinload(Device.users),
                )
            )
            return result.scalar_one_or_none()

    async def get_user_devices(self, user_id: int) -> List[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .join(Device.users)
                .where(User.id == user_id)
                .options(selectinload(Device.state).selectinload(DeviceState.current_driver))
            )
            return result.scalars().all()

    async def get_websocket_devices_for_user(self, user_id: int) -> List[Device]:
        async with self.get_session() as session:
            user = await session.get(User, user_id)
            if not user:
                return []
            q = select(Device).options(selectinload(Device.state).selectinload(DeviceState.current_driver))
            if user.is_admin:
                result = await session.execute(q)
                return result.scalars().all()
            if user.is_company_admin and user.company_id is not None:
                result = await session.execute(q.where(Device.company_id == user.company_id))
                return result.scalars().all()
            result = await session.execute(
                q.join(Device.users).where(User.id == user_id)
            )
            return result.scalars().all()

    async def update_device(
        self, device_id: int, device_data: DeviceCreate
    ) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.id == device_id)
                .options(
                    selectinload(Device.state).selectinload(DeviceState.current_driver),
                    selectinload(Device.users),
                )
            )
            device = result.scalar_one_or_none()
            if not device:
                return None
            device.name              = device_data.name
            device.imei              = device_data.imei
            device.protocol          = device_data.protocol
            device.vehicle_type      = device_data.vehicle_type
            device.license_plate     = device_data.license_plate
            device.custom_attributes = device_data.custom_attributes or {}
            device.config            = device_data.config.model_dump()
            device.company_id        = device_data.company_id
            await session.flush()
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
                trip = await session.get(Trip, state.active_trip_id)
                if trip:
                    if position.speed and position.speed > trip.max_speed:
                        trip.max_speed = position.speed

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

            await evaluate_auto_assign(session, device, state, position, device_time)

            if state.active_trip_id:
                trip = await session.get(Trip, state.active_trip_id)
                if trip and trip.driver_id != state.current_driver_id:
                    trip.driver_id = state.current_driver_id

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
                driver_id=state.current_driver_id,
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

        merge_gap_seconds = (device.config.get('trip_merge_gap_minutes') or 0) * 60

        if position.ignition and not state.active_trip_id:
            if state.last_ignition_off:
                off = state.last_ignition_off
                if off.tzinfo and not device_time.tzinfo:
                    off = off.replace(tzinfo=None)
                gap = (device_time - off).total_seconds()
                if 0 < gap < 30:
                    return
                # Merge into the previous trip if within the configured gap
                if merge_gap_seconds > 0 and 0 < gap <= merge_gap_seconds and state.last_trip_id:
                    prev_trip = await session.get(Trip, state.last_trip_id)
                    if prev_trip:
                        prev_trip.end_time = None
                        prev_trip.end_latitude = None
                        prev_trip.end_longitude = None
                        prev_trip.duration_minutes = 0
                        prev_trip.avg_speed = 0.0
                        state.active_trip_id  = prev_trip.id
                        state.last_ignition_on = device_time
                        state.trip_odometer   = prev_trip.distance_km
                        return
            trip = Trip(
                device_id=device.id,
                start_time=device_time,
                start_latitude=position.latitude,
                start_longitude=position.longitude,
                distance_km=0.0,
                driver_id=state.current_driver_id,
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
            handle_ignition_off(state)
            state.last_trip_id     = state.active_trip_id
            state.active_trip_id   = None
            state.last_ignition_off = device_time
            handle_trip_end(state)
            if device.config.get('auto_clear_driver'):
                state.current_driver_id = None

    # ── Position history ──────────────────────────────────────────

    async def get_position_history(
        self,
        device_id: int,
        start_time: datetime,
        end_time: datetime,
        max_points: int = 1000,
        offset: int = 0,
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
                .offset(offset)
                .limit(max_points + 1)
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
                .options(selectinload(Trip.driver))
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

    async def get_alerts_report(
        self,
        user_ids: List[int],
        device_ids: List[int],
        start_date: Optional[datetime],
        end_date: Optional[datetime],
        alert_type: Optional[str],
        limit: int,
        offset: int,
    ) -> List[dict]:
        async with self.get_session() as session:
            query = (
                select(AlertHistory, User.username, Device.name)
                .join(User, AlertHistory.user_id == User.id, isouter=True)
                .join(Device, AlertHistory.device_id == Device.id, isouter=True)
            )
            if user_ids:
                query = query.where(AlertHistory.user_id.in_(user_ids))
            if device_ids:
                query = query.where(AlertHistory.device_id.in_(device_ids))
            if start_date:
                query = query.where(AlertHistory.created_at >= start_date)
            if end_date:
                query = query.where(AlertHistory.created_at <= end_date)
            if alert_type:
                query = query.where(AlertHistory.alert_type == alert_type)
            query = query.order_by(AlertHistory.created_at.desc()).limit(limit).offset(offset)
            result = await session.execute(query)
            return [
                {
                    "id":          a.id,
                    "user_id":     a.user_id,
                    "username":    username,
                    "device_id":   a.device_id,
                    "device_name": device_name,
                    "alert_type":  a.alert_type,
                    "severity":    a.severity,
                    "message":     a.message,
                    "is_read":     a.is_read,
                    "created_at":  a.created_at.isoformat() if a.created_at else None,
                }
                for a, username, device_name in result.all()
            ]

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

    async def cancel_command(self, command_id: int, device_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(
                update(CommandQueue)
                .where(
                    and_(
                        CommandQueue.id == command_id,
                        CommandQueue.device_id == device_id,
                        CommandQueue.status == "pending",
                    )
                )
                .values(status="failed", response="Cancelled by user")
            )
            return result.rowcount > 0

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
