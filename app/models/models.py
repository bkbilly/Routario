"""
Database Models - Routario Platform
Optimized for PostgreSQL + PostGIS with async SQLAlchemy 2.0
"""
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from enum import Enum

from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, Float, 
    ForeignKey, Table, JSON, Index, Text, BigInteger, Interval
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import JSONB, UUID
from geoalchemy2 import Geography, Geometry
from geoalchemy2.shape import to_shape, from_shape
import uuid


class Base(DeclarativeBase):
    """Base class for all models"""
    pass


# Many-to-Many: Users <-> Devices
user_device_association = Table(
    'user_device_access',
    Base.metadata,
    Column('user_id', Integer, ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
    Column('device_id', Integer, ForeignKey('devices.id', ondelete='CASCADE'), primary_key=True),
    Column('access_level', String(20), default='viewer'),  # viewer, manager, admin
    Column('created_at', DateTime, default=datetime.utcnow)
)


class User(Base):
    """User account with notification preferences"""
    __tablename__ = 'users'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    
    # Role
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Notification channels (Apprise URLs)
    notification_channels: Mapped[Dict] = mapped_column(
        JSONB, 
        default={
            "telegram": None,  # "tgram://bot_token/chat_id"
            "email": None,     # "mailto://user:pass@smtp.server"
            "slack": None,     # "slack://token_a/token_b/token_c"
            "discord": None,   # "discord://webhook_id/webhook_token"
        }
    )
    
    # Preferences
    timezone: Mapped[str] = mapped_column(String(50), default='UTC')
    language: Mapped[str] = mapped_column(String(10), default='en')
    
    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    
    # Relationships
    devices: Mapped[List["Device"]] = relationship(
        secondary=user_device_association,
        back_populates="users"
    )
    alert_history: Mapped[List["AlertHistory"]] = relationship(back_populates="user")


class Device(Base):
    """GPS Device/Tracker configuration"""
    __tablename__ = 'devices'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    imei: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    protocol: Mapped[str] = mapped_column(String(50), nullable=False)
    vehicle_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    license_plate: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    vin: Mapped[Optional[str]] = mapped_column(String(17), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    config: Mapped[Dict] = mapped_column(JSONB, default={})
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    state: Mapped[Optional["DeviceState"]] = relationship(back_populates="device", uselist=False)
    users: Mapped[List["User"]] = relationship(
        secondary=user_device_association,
        back_populates="devices"
    )
    positions: Mapped[List["PositionRecord"]] = relationship(back_populates="device")
    trips: Mapped[List["Trip"]] = relationship(back_populates="device")
    geofences: Mapped[List["Geofence"]] = relationship(back_populates="device")
    alert_history: Mapped[List["AlertHistory"]] = relationship(back_populates="device")
    commands: Mapped[List["CommandQueue"]] = relationship(back_populates="device")


class DeviceState(Base):
    """Real-time device state"""
    __tablename__ = 'device_states'
    
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), primary_key=True)
    last_latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_altitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_speed: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_course: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    last_address: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    ignition_on: Mapped[bool] = mapped_column(Boolean, default=False)
    is_moving: Mapped[bool] = mapped_column(Boolean, default=False)
    is_online: Mapped[bool] = mapped_column(Boolean, default=False)
    total_odometer: Mapped[float] = mapped_column(Float, default=0.0)
    trip_odometer: Mapped[float] = mapped_column(Float, default=0.0)
    last_update: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    alert_states: Mapped[Dict] = mapped_column(JSONB, default={})
    sensors: Mapped[Dict] = mapped_column(JSONB, default={})
    # Trip tracking
    active_trip_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('trips.id', ondelete='SET NULL'), nullable=True)
    last_ignition_on: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_ignition_off: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    device: Mapped["Device"] = relationship(back_populates="state")


class PositionRecord(Base):
    """Historical GPS position records"""
    __tablename__ = 'position_records'
    
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    device_time: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    altitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    speed: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    course: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    satellites: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ignition: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    sensors: Mapped[Dict] = mapped_column(JSONB, default={})
    
    # Relationships
    device: Mapped["Device"] = relationship(back_populates="positions")


class Trip(Base):
    """Detected trip records"""
    __tablename__ = 'trips'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    start_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    start_latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    start_longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    end_latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    end_longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    distance_km: Mapped[float] = mapped_column(Float, default=0.0)
    max_speed: Mapped[float] = mapped_column(Float, default=0.0)
    avg_speed: Mapped[float] = mapped_column(Float, default=0.0)
    duration_minutes: Mapped[float] = mapped_column(Float, default=0.0)
    start_address: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    end_address: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Relationships
    device: Mapped["Device"] = relationship(back_populates="trips")


class Geofence(Base):
    """Geofence zones"""
    __tablename__ = 'geofences'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), nullable=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    polygon = mapped_column(Geometry(srid=4326), nullable=False)
    alert_on_enter: Mapped[bool] = mapped_column(Boolean, default=False)
    alert_on_exit: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    color: Mapped[str] = mapped_column(String(20), default='#3388ff')
    geometry_type: Mapped[str] = mapped_column(String(20), default='polygon')  # 'polygon' | 'polyline'
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    device: Mapped[Optional["Device"]] = relationship(back_populates="geofences")


class AlertHistory(Base):
    """Alert event history"""
    __tablename__ = 'alert_history'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey('users.id', ondelete='CASCADE'), index=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    alert_type: Mapped[str] = mapped_column(String(50), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), default='info')
    message: Mapped[str] = mapped_column(Text, nullable=False)
    latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    address: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    alert_metadata: Mapped[Dict] = mapped_column(JSONB, default={})
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    read_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    is_acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    # Relationships
    user: Mapped["User"] = relationship(back_populates="alert_history")
    device: Mapped["Device"] = relationship(back_populates="alert_history")


class CommandQueue(Base):
    """Command queue for device commands"""
    __tablename__ = 'command_queue'
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey('devices.id', ondelete='CASCADE'), index=True)
    command_type: Mapped[str] = mapped_column(String(50), nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default='pending')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    acked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, default=3)
    response: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    device: Mapped["Device"] = relationship(back_populates="commands")
