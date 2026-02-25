"""
Pydantic Schemas - Routario Platform
Request/Response models with validation
"""
from datetime import datetime
from typing import Optional, Dict, Any, List, Union
from pydantic import BaseModel, Field, field_validator, ConfigDict
from enum import Enum


# ==================== Enums ====================

class AlertType(str, Enum):
    SPEEDING = "speeding"
    IDLING = "idling"
    GEOFENCE_ENTER = "geofence_enter"
    GEOFENCE_EXIT = "geofence_exit"
    OFFLINE = "offline"
    TOWING = "towing"
    MAINTENANCE = "maintenance"
    LOW_BATTERY = "low_battery"
    HARSH_BRAKE = "harsh_brake"
    HARSH_ACCEL = "harsh_accel"
    CUSTOM = "custom"


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class CommandStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    ACKED = "acked"
    FAILED = "failed"
    TIMEOUT = "timeout"


# ==================== Normalized Position Schema ====================

class NormalizedPosition(BaseModel):
    """Standardized GPS position from any protocol"""
    model_config = ConfigDict(arbitrary_types_allowed=True)
    
    imei: str
    device_time: datetime
    
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    altitude: Optional[float] = None
    
    speed: Optional[float] = Field(default=None, ge=0)  # km/h
    course: Optional[float] = Field(default=None, ge=0, le=360)  # degrees
    
    satellites: Optional[int] = Field(default=None, ge=0)
    hdop: Optional[float] = None
    
    ignition: Optional[bool] = None
    
    sensors: Dict[str, Any] = Field(default_factory=dict)
    raw_data: Optional[Dict[str, Any]] = None
    
    @field_validator('speed')
    @classmethod
    def validate_speed(cls, v):
        if v is not None and v > 300: return None
        return v


# ==================== Device Schemas ====================

class AlertSchedule(BaseModel):
    """Active-window schedule for an alert rule."""
    days:      List[int] = Field(default_factory=list)
    hourStart: int       = Field(0,  ge=0, le=23)
    hourEnd:   int       = Field(23, ge=0, le=23)


class AlertRow(BaseModel):
    """One row from the frontend alert table."""
    uid:      int
    alertKey: str
    params:   Dict[str, Any]          = Field(default_factory=dict)
    name:     Optional[str]           = None
    rule:     Optional[str]           = None
    channels: List[str]               = Field(default_factory=list)
    schedule: Optional[AlertSchedule] = None


class CustomRule(BaseModel):
    """Definition for a custom alert rule"""
    name: str = Field(..., min_length=1)
    rule: str = Field(..., min_length=1)
    channels: List[str] = Field(default_factory=list)


class DeviceConfig(BaseModel):
    """Device configuration schema. ALL ALERT FIELDS ARE OPTIONAL AND DEFAULT TO None (DISABLED)."""
    offline_timeout_hours:   Optional[int]   = Field(None, ge=1, le=720)
    speed_tolerance:         Optional[float] = Field(None, ge=0)
    speed_duration_seconds:  Optional[int]   = Field(30,   ge=1)
    idle_timeout_minutes:    Optional[int]   = Field(None, ge=1)
    towing_threshold_meters: Optional[int]   = Field(None, ge=10)
    alert_channels: Dict[str, List[str]] = Field(default_factory=dict)
    alert_rows: List[AlertRow] = Field(default_factory=list)
    custom_rules: List[Union[CustomRule, str]] = Field(default_factory=list)
    sensors:     Dict[str, str] = Field(default_factory=dict)
    maintenance: Dict[str, int] = Field(default_factory=dict)


class DeviceCreate(BaseModel):
    imei: str = Field(..., min_length=15, max_length=20)
    name: str = Field(..., min_length=1, max_length=100)
    protocol: str = "teltonika"
    vehicle_type: Optional[str] = "car"
    license_plate: Optional[str] = None
    vin: Optional[str] = None
    config: DeviceConfig = Field(
        default_factory=lambda: DeviceConfig(
            offline_timeout_hours=None,
            speed_tolerance=None,
            speed_duration_seconds=30,
            idle_timeout_minutes=None,
            towing_threshold_meters=None,
            alert_channels={},
            custom_rules=[],
            sensors={},
            maintenance={}
        )
    )


class DeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    
    id: int
    imei: str
    name: str
    protocol: str
    vehicle_type: Optional[str]
    license_plate: Optional[str]
    is_active: bool
    created_at: datetime
    config: Optional[Dict[str, Any]] = None


class DeviceStateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    
    device_id: int
    last_latitude: Optional[float]
    last_longitude: Optional[float]
    last_speed: Optional[float]
    last_course: Optional[float]
    last_address: Optional[str]
    ignition_on: bool
    is_moving: bool
    is_online: bool
    total_odometer: float
    last_update: Optional[datetime]


# ==================== User Schemas ====================

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=100)
    email: str = Field(..., pattern=r'^[^@]+@[^@]+\.[^@]+$')
    password: str = Field(..., min_length=8)
    notification_channels: List[Dict[str, str]] = Field(default_factory=list)
    language: Optional[str] = "en"
    is_admin: bool = False


class UserUpdate(BaseModel):
    """Schema for updating user details"""
    email: Optional[str] = Field(None, pattern=r'^[^@]+@[^@]+\.[^@]+$')
    password: Optional[str] = Field(None, min_length=8)
    notification_channels: Optional[List[Dict[str, str]]] = None
    language: Optional[str] = None
    is_admin: Optional[bool] = None


class UserLogin(BaseModel):
    username: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str
    user_id: int
    username: str
    is_admin: bool


class UserResponse(BaseModel):
    """Schema for returning user details"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    email: str
    is_admin: bool = False
    language: Optional[str] = "en"
    notification_channels: List[Dict[str, str]] = Field(default_factory=list)
    created_at: datetime

    @field_validator('notification_channels', mode='before')
    @classmethod
    def validate_channels(cls, v):
        if isinstance(v, dict):
            return []
        if v is None:
            return []
        return v


# ==================== Position Schemas ====================

class PositionGeoJSON(BaseModel):
    """GeoJSON Point Feature for positions"""
    type: str = "Feature"
    geometry: Dict[str, Any]
    properties: Dict[str, Any]


class PositionHistoryRequest(BaseModel):
    """Request for position history"""
    device_id: int
    start_time: datetime
    end_time: datetime
    max_points: int = Field(1000, ge=1, le=10000)
    order: str = Field("asc", pattern="^(asc|desc)$")


class PositionHistoryResponse(BaseModel):
    """GeoJSON FeatureCollection for history playback"""
    type: str = "FeatureCollection"
    features: List[PositionGeoJSON]
    summary: Dict[str, Any] = Field(
        default_factory=lambda: {
            "total_distance_km": 0,
            "duration_minutes": 0,
            "max_speed": 0,
        }
    )


# ==================== Trip Schemas ====================

class TripResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    
    id: int
    device_id: int
    start_time: datetime
    end_time: Optional[datetime]
    start_latitude: Optional[float]
    start_longitude: Optional[float]
    end_latitude: Optional[float]
    end_longitude: Optional[float]
    distance_km: float
    max_speed: float
    avg_speed: float
    duration_minutes: float
    start_address: Optional[str]
    end_address: Optional[str]


class TripGeoJSON(BaseModel):
    type: str = "FeatureCollection"
    features: List[PositionGeoJSON]


# ==================== Geofence Schemas ====================

class GeofenceCreate(BaseModel):
    device_id: Optional[int] = None
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    polygon: List[List[float]]
    alert_on_enter: bool = False
    alert_on_exit: bool = False
    color: str = '#3388ff'


class GeofenceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    
    id: int
    device_id: Optional[int]
    name: str
    description: Optional[str]
    alert_on_enter: bool
    alert_on_exit: bool
    is_active: bool
    color: str
    created_at: datetime


# ==================== Alert Schemas ====================

class AlertCreate(BaseModel):
    user_id: int
    device_id: int
    alert_type: str
    severity: str = "info"
    message: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    address: Optional[str] = None
    alert_metadata: Dict[str, Any] = Field(default_factory=dict)


class AlertResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    
    id: int
    user_id: int
    device_id: int
    alert_type: str
    severity: str
    message: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    address: Optional[str] = None
    alert_metadata: Optional[Dict[str, Any]]
    is_read: bool
    is_acknowledged: bool
    created_at: datetime


# ==================== Command Schemas ====================

class CommandCreate(BaseModel):
    device_id: int
    command_type: str
    payload: str = Field(..., description="Hex or ASCII command string")
    max_retries: int = Field(3, ge=0, le=10)


class CommandResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    
    id: int
    device_id: int
    command_type: str
    payload: str
    status: str
    created_at: datetime
    sent_at: Optional[datetime]
    acked_at: Optional[datetime]
    retry_count: int
    response: Optional[str]


# ==================== WebSocket Messages ====================

class WSMessageType(str, Enum):
    POSITION_UPDATE = "position_update"
    ALERT = "alert"
    DEVICE_STATUS = "device_status"
    TRIP_START = "trip_start"
    TRIP_END = "trip_end"


class WSMessage(BaseModel):
    """WebSocket message envelope"""
    type: WSMessageType
    device_id: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    data: Dict[str, Any]


# ==================== Statistics Schemas ====================

class DeviceStatistics(BaseModel):
    """Aggregated device statistics"""
    device_id: int
    total_distance_km: float
    total_trips: int
    avg_speed: float
    max_speed: float
    total_idle_time_minutes: int
    total_driving_time_minutes: int
    period_start: datetime
    period_end: datetime
