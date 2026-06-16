"""
Database Models - Routario Platform
Optimized for async SQLAlchemy 2.0.
Spatial operations are handled by Shapely (pure-Python) so any
SQLAlchemy-supported database can be used.
"""
from datetime import datetime
from typing import Optional, Dict, Any, List

from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, Float,
    ForeignKey, Table, Text, BigInteger,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from core.db_types import JsonType


class Base(DeclarativeBase):
    pass


# Many-to-Many: Users <-> Devices
user_device_association = Table(
    'user_device_access',
    Base.metadata,
    Column('user_id',    Integer, ForeignKey('users.id',    ondelete='CASCADE'), primary_key=True),
    Column('device_id',  Integer, ForeignKey('devices.id',  ondelete='CASCADE'), primary_key=True),
    Column('access_level', String(20), default='viewer'),
    Column('created_at', DateTime, default=datetime.utcnow),
)


class Company(Base):
    __tablename__ = 'companies'

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True)
    name:       Mapped[str]      = mapped_column(String(200), unique=True, nullable=False)
    app_name:   Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    login_slug: Mapped[Optional[str]] = mapped_column(String(100), unique=True, nullable=True, index=True)
    icon_filename:  Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    badge_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    branding_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    billing_plan_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('billing_plans.id', ondelete='SET NULL'), nullable=True)
    billing_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    billing_status: Mapped[str] = mapped_column(String(30), default='active', nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    users:   Mapped[List["User"]]   = relationship(back_populates="company")
    devices: Mapped[List["Device"]] = relationship(back_populates="company")
    billing_plan: Mapped[Optional["BillingPlan"]] = relationship("BillingPlan")

    @property
    def icon_url(self) -> Optional[str]:
        if not self.icon_filename:
            return None
        return f"/branding/company/{self.id}/icon-192.png?v={self.branding_version or 1}"

    @property
    def badge_url(self) -> Optional[str]:
        if not self.badge_filename:
            return None
        return f"/branding/company/{self.id}/badge-96.png?v={self.branding_version or 1}"


class User(Base):
    __tablename__ = 'users'

    id:               Mapped[int]           = mapped_column(Integer, primary_key=True)
    username:         Mapped[str]           = mapped_column(String(100), unique=True, nullable=False)
    email:            Mapped[str]           = mapped_column(String(255), unique=True, nullable=False)
    password_hash:    Mapped[str]           = mapped_column(String(255), nullable=False)
    is_admin:         Mapped[bool]          = mapped_column(Boolean, default=False, nullable=False)
    company_id:       Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('companies.id', ondelete='SET NULL'), nullable=True)
    is_company_admin: Mapped[bool]          = mapped_column(Boolean, default=False, nullable=False)

    notification_channels: Mapped[Dict] = mapped_column(JsonType, default={})
    webhook_urls:          Mapped[Optional[list]] = mapped_column(JsonType, nullable=True, default=list)
    permissions:           Mapped[Optional[list]] = mapped_column(JsonType, nullable=True, default=None)

    timezone:   Mapped[str] = mapped_column(String(50),  default='UTC')
    language:   Mapped[str] = mapped_column(String(10),  default='en')
    units:      Mapped[str] = mapped_column(String(10),  default='metric')
    currency:   Mapped[str] = mapped_column(String(3),   default='EUR')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_activity: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    mfa_secret: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    mfa_recovery_codes: Mapped[Optional[list]] = mapped_column(JsonType, nullable=True, default=list)

    company:       Mapped[Optional["Company"]]  = relationship(back_populates="users")
    devices:       Mapped[List["Device"]]       = relationship(secondary=user_device_association, back_populates="users")
    alert_history: Mapped[List["AlertHistory"]] = relationship(back_populates="user")


class Driver(Base):
    __tablename__ = 'drivers'

    id:             Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id:     Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=True, index=True)
    user_id:        Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True, unique=True, index=True)
    name:           Mapped[str]           = mapped_column(String(100), nullable=False)
    phone:          Mapped[Optional[str]] = mapped_column(String(30),  nullable=True)
    license_number: Mapped[Optional[str]] = mapped_column(String(50),  nullable=True)
    notes:          Mapped[Optional[str]] = mapped_column(Text,        nullable=True)
    assignment_rule:         Mapped[Optional[str]]  = mapped_column(Text,        nullable=True)
    assignment_vehicles:     Mapped[Optional[list]] = mapped_column(JsonType,    nullable=True)
    assignment_mode:         Mapped[Optional[str]]  = mapped_column(String(20),  nullable=True)
    assignment_grace_period: Mapped[Optional[int]]  = mapped_column(Integer,     nullable=True)
    assignment_clear:        Mapped[Optional[str]]  = mapped_column(String(20),  nullable=True)
    created_at:     Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)

    company: Mapped[Optional["Company"]] = relationship("Company")
    user:    Mapped[Optional["User"]]    = relationship("User")
    trips:   Mapped[List["Trip"]]        = relationship(back_populates="driver")


class Device(Base):
    __tablename__ = 'devices'

    id:            Mapped[int]           = mapped_column(Integer, primary_key=True)
    imei:          Mapped[str]           = mapped_column(String(64), unique=True, nullable=False, index=True)
    name:          Mapped[str]           = mapped_column(String(100), nullable=False)
    protocol:      Mapped[str]           = mapped_column(String(50),  nullable=False)
    vehicle_type:  Mapped[Optional[str]] = mapped_column(String(50),  nullable=True)
    license_plate: Mapped[Optional[str]] = mapped_column(String(20),  nullable=True)
    custom_attributes: Mapped[Dict]      = mapped_column(JsonType, default={})
    is_active:     Mapped[bool]           = mapped_column(Boolean, default=True)
    config:        Mapped[Dict]           = mapped_column(JsonType, default={})
    created_at:    Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)
    company_id:    Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('companies.id', ondelete='SET NULL'), nullable=True)

    company:       Mapped[Optional["Company"]]     = relationship(back_populates="devices")
    state:         Mapped[Optional["DeviceState"]] = relationship(back_populates="device", uselist=False)
    users:         Mapped[List["User"]]            = relationship(secondary=user_device_association, back_populates="devices")
    positions:     Mapped[List["PositionRecord"]]  = relationship(back_populates="device")
    trips:         Mapped[List["Trip"]]            = relationship(back_populates="device")
    geofences:     Mapped[List["Geofence"]]        = relationship(back_populates="device")
    alert_history: Mapped[List["AlertHistory"]]    = relationship(back_populates="device")
    commands:      Mapped[List["CommandQueue"]]    = relationship(back_populates="device")
    fuel_logs:     Mapped[List["FuelLog"]]         = relationship(back_populates="device")
    clips:         Mapped[List["VideoClip"]]       = relationship(back_populates="device", cascade="all, delete-orphan")


class DeviceState(Base):
    __tablename__ = 'device_states'

    device_id:      Mapped[int]            = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), primary_key=True)
    last_latitude:  Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_altitude:  Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_speed:     Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_course:    Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_address:   Mapped[Optional[str]]   = mapped_column(String(500), nullable=True)
    ignition_on:    Mapped[Optional[bool]]  = mapped_column(Boolean, nullable=True, default=None)
    is_moving:      Mapped[bool]            = mapped_column(Boolean, default=False)
    is_online:      Mapped[bool]            = mapped_column(Boolean, default=False)
    total_odometer: Mapped[float]           = mapped_column(Float, default=0.0)
    trip_odometer:  Mapped[float]           = mapped_column(Float, default=0.0)
    last_update:    Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    alert_states:   Mapped[Dict]            = mapped_column(JsonType, default={})
    sensors:        Mapped[Dict]            = mapped_column(JsonType, default={})

    active_trip_id:    Mapped[Optional[int]]      = mapped_column(Integer, ForeignKey('trips.id', ondelete='SET NULL'), nullable=True)
    last_trip_id:      Mapped[Optional[int]]      = mapped_column(Integer, ForeignKey('trips.id', ondelete='SET NULL'), nullable=True)
    last_ignition_on:  Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_ignition_off: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    current_driver_id: Mapped[Optional[int]]      = mapped_column(Integer, ForeignKey('drivers.id', ondelete='SET NULL'), nullable=True)

    device:         Mapped["Device"]           = relationship(back_populates="state")
    current_driver: Mapped[Optional["Driver"]] = relationship("Driver", foreign_keys=[current_driver_id])

    @property
    def current_driver_name(self) -> "Optional[str]":
        return self.current_driver.name if self.current_driver else None


class PositionRecord(Base):
    __tablename__ = 'position_records'

    id:          Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id:   Mapped[int]            = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    device_time: Mapped[datetime]       = mapped_column(DateTime, nullable=False, index=True)
    server_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    latitude:    Mapped[float]          = mapped_column(Float, nullable=False)
    longitude:   Mapped[float]          = mapped_column(Float, nullable=False)
    altitude:    Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    speed:       Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    course:      Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    satellites:  Mapped[Optional[int]]  = mapped_column(Integer, nullable=True)
    ignition:    Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    sensors:     Mapped[Dict]           = mapped_column(JsonType, default={})
    driver_id:   Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('drivers.id', ondelete='SET NULL'), nullable=True)

    device: Mapped["Device"] = relationship(back_populates="positions")


class Trip(Base):
    __tablename__ = 'trips'

    id:               Mapped[int]            = mapped_column(Integer, primary_key=True)
    device_id:        Mapped[int]            = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    start_time:       Mapped[datetime]       = mapped_column(DateTime, nullable=False)
    end_time:         Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    start_latitude:   Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    start_longitude:  Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    end_latitude:     Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    end_longitude:    Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    distance_km:      Mapped[float]          = mapped_column(Float, default=0.0)
    max_speed:        Mapped[float]          = mapped_column(Float, default=0.0)
    avg_speed:        Mapped[float]          = mapped_column(Float, default=0.0)
    duration_minutes: Mapped[float]          = mapped_column(Float, default=0.0)
    start_address:    Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    end_address:      Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    driver_id:        Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('drivers.id', ondelete='SET NULL'), nullable=True)

    device: Mapped["Device"]           = relationship(back_populates="trips")
    driver: Mapped[Optional["Driver"]] = relationship(back_populates="trips")

    @property
    def driver_name(self) -> Optional[str]:
        return self.driver.name if self.driver else None


class Geofence(Base):
    """
    Geofence zone.
    The geometry is stored as a plain WKT string (polygon_wkt column)
    so no PostGIS extension is required.  Spatial checks are performed
    in Python via Shapely.
    """
    __tablename__ = 'geofences'

    id:             Mapped[int]           = mapped_column(Integer, primary_key=True)
    user_id:        Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
    device_id:      Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), nullable=True)
    name:           Mapped[str]           = mapped_column(String(100), nullable=False)
    description:    Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # WKT geometry string, e.g. "POLYGON((lon lat, ...))"
    polygon_wkt:    Mapped[str]           = mapped_column(Text, nullable=False)
    alert_on_enter: Mapped[bool]          = mapped_column(Boolean, default=False)
    alert_on_exit:  Mapped[bool]          = mapped_column(Boolean, default=False)
    is_active:      Mapped[bool]          = mapped_column(Boolean, default=True)
    color:          Mapped[str]           = mapped_column(String(20), default='#3388ff')
    geometry_type:  Mapped[str]           = mapped_column(String(20), default='polygon')
    buffer_meters:  Mapped[int]           = mapped_column(Integer, default=50)
    created_at:     Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)

    device: Mapped[Optional["Device"]] = relationship(back_populates="geofences")


class AlertHistory(Base):
    __tablename__ = 'alert_history'

    id:               Mapped[int]           = mapped_column(Integer, primary_key=True)
    user_id:          Mapped[int]           = mapped_column(Integer, ForeignKey('users.id',   ondelete='CASCADE'), index=True)
    device_id:        Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), nullable=True, index=True)
    alert_type:       Mapped[str]           = mapped_column(String(50), nullable=False)
    severity:         Mapped[str]           = mapped_column(String(20), default='info')
    message:          Mapped[str]           = mapped_column(Text, nullable=False)
    latitude:         Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude:        Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    address:          Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    alert_metadata:   Mapped[Dict]          = mapped_column(JsonType, default={})
    is_read:          Mapped[bool]          = mapped_column(Boolean, default=False)
    read_at:          Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    is_acknowledged:  Mapped[bool]          = mapped_column(Boolean, default=False)
    created_at:       Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)

    user:   Mapped["User"]   = relationship(back_populates="alert_history")
    device: Mapped["Device"] = relationship(back_populates="alert_history")


class CommandQueue(Base):
    __tablename__ = 'command_queue'

    id:           Mapped[int]           = mapped_column(Integer, primary_key=True)
    device_id:    Mapped[int]           = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    command_type: Mapped[str]           = mapped_column(String(50), nullable=False)
    payload:      Mapped[str]           = mapped_column(Text, nullable=False)
    status:       Mapped[str]           = mapped_column(String(20), default='pending')
    created_at:   Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)
    sent_at:      Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    acked_at:     Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    retry_count:  Mapped[int]           = mapped_column(Integer, default=0)
    max_retries:  Mapped[int]           = mapped_column(Integer, default=3)
    response:     Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    device: Mapped["Device"] = relationship(back_populates="commands")


class FuelLog(Base):
    __tablename__ = 'fuel_logs'

    id:              Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id:       Mapped[int]            = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    date:            Mapped[datetime]       = mapped_column(DateTime, nullable=False)
    liters:          Mapped[float]          = mapped_column(Float, nullable=False)
    odometer_km:     Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price_per_liter: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    currency:        Mapped[str]             = mapped_column(String(3), default='EUR', nullable=False)
    exchange_rate:   Mapped[float]           = mapped_column(Float, default=1.0, nullable=False)
    full_tank:       Mapped[bool]           = mapped_column(Boolean, default=True)
    notes:           Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    created_at:      Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)

    device: Mapped["Device"] = relationship(back_populates="fuel_logs")


class VoiceMessage(Base):
    __tablename__ = 'voice_messages'

    id:               Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    sender_id:        Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
    company_id:       Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=True)
    recipient_ids:    Mapped[Optional[list]] = mapped_column(JsonType, default=list)
    file_path:        Mapped[str]            = mapped_column(String(256), nullable=False)
    duration_seconds: Mapped[float]          = mapped_column(Float, default=0.0)
    created_at:       Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow, index=True)

    sender: Mapped[Optional["User"]] = relationship("User", foreign_keys=[sender_id])


class VoiceMessageRead(Base):
    __tablename__ = 'voice_message_reads'

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    message_id: Mapped[int]      = mapped_column(Integer, ForeignKey('voice_messages.id', ondelete='CASCADE'), nullable=False)
    user_id:    Mapped[int]      = mapped_column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    read_at:    Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LocationShare(Base):
    __tablename__ = 'location_shares'

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True)
    token:      Mapped[str]      = mapped_column(String(64), unique=True, nullable=False, index=True)
    device_id:  Mapped[int]      = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), nullable=False)
    created_by: Mapped[int]      = mapped_column(Integer, ForeignKey('users.id',   ondelete='CASCADE'), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    is_active:  Mapped[bool]     = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    device:  Mapped["Device"] = relationship("Device")
    creator: Mapped["User"]   = relationship("User")


class ScheduledReport(Base):
    __tablename__ = 'scheduled_reports'

    id:                 Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:            Mapped[int]           = mapped_column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    name:               Mapped[str]           = mapped_column(String(200), nullable=False)
    report_type:        Mapped[str]           = mapped_column(String(20), nullable=False)
    filter_device_ids:  Mapped[Optional[list]] = mapped_column(JsonType, nullable=True, default=list)
    filter_user_ids:    Mapped[Optional[list]] = mapped_column(JsonType, nullable=True, default=list)
    sensors_historical: Mapped[bool]          = mapped_column(Boolean, default=False)
    date_range:         Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    frequency:          Mapped[str]           = mapped_column(String(20), nullable=False)
    run_time:           Mapped[str]           = mapped_column(String(5), nullable=False)
    day_of_week:        Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    day_of_month:       Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    user_timezone:      Mapped[str]           = mapped_column(String(50), default='UTC')
    keep_runs:          Mapped[int]           = mapped_column(Integer, default=10)
    is_active:          Mapped[bool]          = mapped_column(Boolean, default=True)
    next_run:           Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    last_run:           Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at:         Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"]                     = relationship("User")
    runs: Mapped[List["ScheduledReportRun"]] = relationship(back_populates="schedule", cascade="all, delete-orphan")


class ScheduledReportRun(Base):
    __tablename__ = 'scheduled_report_runs'

    id:            Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    schedule_id:   Mapped[int]           = mapped_column(Integer, ForeignKey('scheduled_reports.id', ondelete='CASCADE'), nullable=False, index=True)
    run_at:        Mapped[datetime]      = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    status:        Mapped[str]           = mapped_column(String(20), nullable=False)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_json:   Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    schedule: Mapped["ScheduledReport"] = relationship(back_populates="runs")


class VideoClip(Base):
    __tablename__ = 'video_clips'

    id:             Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id:      Mapped[int]            = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    timestamp:      Mapped[datetime]       = mapped_column(DateTime, nullable=False, index=True)
    event_type:     Mapped[str]            = mapped_column(String(50), nullable=False, default='manual')
    camera:         Mapped[str]            = mapped_column(String(20), nullable=False, default='front')
    latitude:       Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude:      Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    speed:          Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    file_path:      Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    thumbnail_path: Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    file_size:      Mapped[Optional[int]]  = mapped_column(Integer, nullable=True)
    duration:       Mapped[Optional[int]]  = mapped_column(Integer, nullable=True)
    created_at:     Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)

    device: Mapped["Device"] = relationship(back_populates="clips")


class AuditLog(Base):
    __tablename__ = 'audit_logs'

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True, index=True)
    company_id: Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('companies.id', ondelete='SET NULL'), nullable=True, index=True)
    action:      Mapped[str]           = mapped_column(String(100), nullable=False, index=True)
    target_type: Mapped[Optional[str]]  = mapped_column(String(100), nullable=True)
    target_id:   Mapped[Optional[str]]  = mapped_column(String(100), nullable=True)
    ip_address:  Mapped[Optional[str]]  = mapped_column(String(64), nullable=True)
    user_agent:  Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    metadata_json: Mapped[Dict]         = mapped_column(JsonType, default={})
    created_at:  Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)

    actor:  Mapped[Optional["User"]]    = relationship("User")
    company: Mapped[Optional["Company"]] = relationship("Company")


class ApiKey(Base):
    __tablename__ = 'api_keys'

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:     Mapped[int]           = mapped_column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    company_id:  Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=True, index=True)
    name:        Mapped[str]           = mapped_column(String(120), nullable=False)
    key_prefix:  Mapped[str]           = mapped_column(String(24), nullable=False, index=True)
    key_hash:    Mapped[str]           = mapped_column(String(128), nullable=False, unique=True)
    scopes:      Mapped[list]          = mapped_column(JsonType, default=list)
    is_active:   Mapped[bool]          = mapped_column(Boolean, default=True, nullable=False)
    expires_at:  Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_used_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at:  Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)
    revoked_at:  Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    user:    Mapped["User"]            = relationship("User")
    company: Mapped[Optional["Company"]] = relationship("Company")


class BillingPlan(Base):
    __tablename__ = 'billing_plans'

    id:          Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    name:        Mapped[str]      = mapped_column(String(120), nullable=False, unique=True)
    currency:    Mapped[str]      = mapped_column(String(3), default='EUR', nullable=False)
    base_price_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    included_devices: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    included_positions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    included_api_calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    price_per_device_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    price_per_1000_positions_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    price_per_1000_api_calls_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active:   Mapped[bool]     = mapped_column(Boolean, default=True, nullable=False)
    created_at:  Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UsageEvent(Base):
    __tablename__ = 'usage_events'

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id:  Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=True, index=True)
    metric:      Mapped[str]           = mapped_column(String(80), nullable=False, index=True)
    quantity:    Mapped[int]           = mapped_column(Integer, default=1, nullable=False)
    source:      Mapped[Optional[str]]  = mapped_column(String(80), nullable=True)
    metadata_json: Mapped[Dict]         = mapped_column(JsonType, default={})
    created_at:  Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)

    company: Mapped[Optional["Company"]] = relationship("Company")


class BillingInvoice(Base):
    __tablename__ = 'billing_invoices'

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id:  Mapped[int]           = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=False, index=True)
    period_start: Mapped[datetime]     = mapped_column(DateTime, nullable=False, index=True)
    period_end: Mapped[datetime]       = mapped_column(DateTime, nullable=False)
    currency:    Mapped[str]           = mapped_column(String(3), default='EUR', nullable=False)
    exchange_rate: Mapped[float]        = mapped_column(Float, default=1.0, nullable=False)
    amount_cents: Mapped[int]          = mapped_column(Integer, default=0, nullable=False)
    amount_display_cents: Mapped[int]   = mapped_column(Integer, default=0, nullable=False)
    status:      Mapped[str]           = mapped_column(String(30), default='draft', nullable=False)
    line_items:  Mapped[list]          = mapped_column(JsonType, default=list)
    created_at:  Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)

    company: Mapped["Company"] = relationship("Company")


class PlannedRoute(Base):
    __tablename__ = 'planned_routes'

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id:  Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=True, index=True)
    name:        Mapped[str]           = mapped_column(String(200), nullable=False)
    device_id:   Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('devices.id', ondelete='SET NULL'), nullable=True, index=True)
    driver_id:   Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('drivers.id', ondelete='SET NULL'), nullable=True, index=True)
    status:      Mapped[str]           = mapped_column(String(30), default='draft', nullable=False)
    route_geometry: Mapped[Optional[Dict]] = mapped_column(JsonType, nullable=True)
    distance_km: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    duration_minutes: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    created_by:  Mapped[Optional[int]]  = mapped_column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
    created_at:  Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at:  Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)

    company: Mapped[Optional["Company"]] = relationship("Company")
    device:  Mapped[Optional["Device"]] = relationship("Device")
    driver:  Mapped[Optional["Driver"]] = relationship("Driver")
    stops:   Mapped[List["RouteStop"]]  = relationship(back_populates="route", cascade="all, delete-orphan", order_by="RouteStop.sequence")


class RouteStop(Base):
    __tablename__ = 'route_stops'

    id:          Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    route_id:    Mapped[int]      = mapped_column(Integer, ForeignKey('planned_routes.id', ondelete='CASCADE'), nullable=False, index=True)
    sequence:    Mapped[int]      = mapped_column(Integer, nullable=False)
    name:        Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    address:     Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    latitude:    Mapped[float]    = mapped_column(Float, nullable=False)
    longitude:   Mapped[float]    = mapped_column(Float, nullable=False)
    planned_arrival: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    service_minutes: Mapped[int]  = mapped_column(Integer, default=0, nullable=False)
    stop_kind:    Mapped[str]      = mapped_column(String(30), default='stop', nullable=False)
    arrival_radius_m: Mapped[int]  = mapped_column(Integer, default=50, nullable=False)
    dwell_seconds: Mapped[int]     = mapped_column(Integer, default=0, nullable=False)
    status:      Mapped[str]      = mapped_column(String(30), default='pending', nullable=False)
    arrived_at:  Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    notes:       Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    route: Mapped["PlannedRoute"] = relationship(back_populates="stops")
