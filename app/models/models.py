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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    users:   Mapped[List["User"]]   = relationship(back_populates="company")
    devices: Mapped[List["Device"]] = relationship(back_populates="company")


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

    timezone:   Mapped[str] = mapped_column(String(50),  default='UTC')
    language:   Mapped[str] = mapped_column(String(10),  default='en')
    units:      Mapped[str] = mapped_column(String(10),  default='metric')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    company:       Mapped[Optional["Company"]]  = relationship(back_populates="users")
    devices:       Mapped[List["Device"]]       = relationship(secondary=user_device_association, back_populates="users")
    alert_history: Mapped[List["AlertHistory"]] = relationship(back_populates="user")


class Driver(Base):
    __tablename__ = 'drivers'

    id:             Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id:     Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('companies.id', ondelete='CASCADE'), nullable=True, index=True)
    name:           Mapped[str]           = mapped_column(String(100), nullable=False)
    phone:          Mapped[Optional[str]] = mapped_column(String(30),  nullable=True)
    license_number: Mapped[Optional[str]] = mapped_column(String(50),  nullable=True)
    notes:          Mapped[Optional[str]] = mapped_column(Text,        nullable=True)
    created_at:     Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)

    company: Mapped[Optional["Company"]] = relationship("Company")
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
    full_tank:       Mapped[bool]           = mapped_column(Boolean, default=True)
    notes:           Mapped[Optional[str]]  = mapped_column(String(500), nullable=True)
    created_at:      Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow)

    device: Mapped["Device"] = relationship(back_populates="fuel_logs")


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
