# ... existing imports ...
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    create_async_engine,
    AsyncSession,
    async_sessionmaker,
    AsyncEngine
)
from sqlalchemy import select, update, delete, and_, or_, func, text
from sqlalchemy.orm import selectinload
from geoalchemy2 import Geography
from geoalchemy2.functions import ST_Distance, ST_MakePoint, ST_Contains, ST_SetSRID
import bcrypt

from models import (
    Base, User, Device, DeviceState, PositionRecord, 
    Trip, Geofence, AlertHistory, CommandQueue
)
from models.schemas import NormalizedPosition, AlertCreate, CommandCreate, DeviceCreate, GeofenceCreate, UserCreate, UserUpdate
import logging

logger = logging.getLogger(__name__)


class DatabaseService:
    # ... existing __init__ and init_db methods ...
    def __init__(self, database_url: str):
        self.engine: AsyncEngine = create_async_engine(
            database_url,
            echo=False,
            pool_size=20,
            max_overflow=40,
            pool_pre_ping=True,
        )
        
        self.async_session_maker = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False
        )
    
    async def init_db(self):
        """Initialize database schema"""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
            logger.info("Database initialized")
    
    @asynccontextmanager
    async def get_session(self) -> AsyncSession:
        async with self.async_session_maker() as session:
            try:
                yield session
                await session.commit()
            except Exception as e:
                await session.rollback()
                logger.error(f"Database error: {e}", exc_info=True)
                raise
    
    async def close(self):
        await self.engine.dispose()

    # ... existing Device Operations ...
    async def get_device_by_imei(self, imei: str) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.imei == imei)
                .options(
                    selectinload(Device.state),
                    selectinload(Device.users)
                )
            )
            return result.scalar_one_or_none()
    
    async def get_device_by_id(self, device_id: int) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Device)
                .where(Device.id == device_id)
                .options(
                    selectinload(Device.state),
                    selectinload(Device.users)
                )
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

    # ... existing Position Processing ...
    async def process_position(self, position: NormalizedPosition) -> bool:
        # Ensure device_time is naive UTC
        device_time = position.device_time
        if device_time.tzinfo is not None:
            device_time = device_time.astimezone(timezone.utc).replace(tzinfo=None)
        
        async with self.get_session() as session:
            device = await self._get_device_by_imei_internal(session, position.imei)
            if not device:
                logger.warning(f"Unknown device: {position.imei}")
                return False
            
            state = await self._get_or_create_state(session, device.id)
            
            distance_km = 0.0
            if state.last_latitude:
                distance_km = await self._calculate_distance(
                    session, state.last_latitude, state.last_longitude,
                    position.latitude, position.longitude
                )
                # Sanity check: ignore jumps > 50 km between consecutive points
                # (catches GPS glitches and stale positions after long offline periods)
                if distance_km > 50.0:
                    distance_km = 0.0

            await self._handle_trip_logic(session, device, state, position, device_time)
            
            state.total_odometer += distance_km
            if state.active_trip_id:
                state.trip_odometer += distance_km
            
            state.last_latitude = position.latitude
            state.last_longitude = position.longitude
            state.last_altitude = position.altitude
            state.last_speed = position.speed
            state.last_course = position.course
            state.last_update = datetime.utcnow()
            if position.ignition is not None:
                state.ignition_on = position.ignition
            state.is_moving = (position.speed or 0) > 1.0
            state.is_online = True
            
            position_record = PositionRecord(
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
            )

            
            session.add(position_record)
            await session.flush()
            return True
            
    async def _get_device_by_imei_internal(self, session: AsyncSession, imei: str) -> Optional[Device]:
        result = await session.execute(select(Device).where(Device.imei == imei))
        return result.scalar_one_or_none()
    
    async def _get_or_create_state(self, session: AsyncSession, device_id: int) -> DeviceState:
        result = await session.execute(select(DeviceState).where(DeviceState.device_id == device_id))
        state = result.scalar_one_or_none()
        if not state:
            state = DeviceState(device_id=device_id)
            session.add(state)
            await session.flush()
        return state
    
    async def _calculate_distance(self, session: AsyncSession, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        query = select(
            func.ST_Distance(
                func.ST_MakePoint(lon1, lat1).cast(Geography),
                func.ST_MakePoint(lon2, lat2).cast(Geography)
            )
        )
        result = await session.execute(query)
        distance_meters = result.scalar() or 0.0
        return distance_meters / 1000.0
    
    async def _handle_trip_logic(self, session: AsyncSession, device: Device, state: DeviceState, position: NormalizedPosition, device_time: datetime):
        if position.ignition is None: return
        
        if position.ignition and not state.active_trip_id:
            trip = Trip(
                device_id=device.id,
                start_time=device_time,
                start_latitude=position.latitude,
                start_longitude=position.longitude,
                distance_km=0.0
            )
            session.add(trip)
            await session.flush()
            state.active_trip_id = trip.id
            state.last_ignition_on = device_time
            state.trip_odometer = 0.0
        
        elif not position.ignition and state.active_trip_id:
            trip = await session.get(Trip, state.active_trip_id)
            if trip:
                trip.end_time = device_time
                trip.end_latitude = position.latitude
                trip.end_longitude = position.longitude
                trip.distance_km = state.trip_odometer
                start_time = trip.start_time
                if start_time.tzinfo and not device_time.tzinfo:
                    start_time = start_time.replace(tzinfo=None)
                elif not start_time.tzinfo and device_time.tzinfo:
                    device_time = device_time.replace(tzinfo=None)
                    
                trip.duration_minutes = int((device_time - start_time).total_seconds() / 60)
                if trip.duration_minutes > 0:
                    trip.avg_speed = (trip.distance_km / trip.duration_minutes) * 60
            state.active_trip_id = None
            state.last_ignition_off = device_time

    async def get_position_history(self, device_id: int, start_time: datetime, end_time: datetime, max_points: int = 1000, order: str = 'asc') -> List[PositionRecord]:
        if start_time.tzinfo: start_time = start_time.astimezone(timezone.utc).replace(tzinfo=None)
        if end_time.tzinfo: end_time = end_time.astimezone(timezone.utc).replace(tzinfo=None)
        
        sort_order = PositionRecord.device_time.desc() if order == 'desc' else PositionRecord.device_time.asc()
        
        async with self.get_session() as session:
            result = await session.execute(
                select(PositionRecord)
                .where(and_(PositionRecord.device_id == device_id, PositionRecord.device_time >= start_time, PositionRecord.device_time <= end_time))
                .order_by(sort_order)
                .limit(max_points)
            )
            return result.scalars().all()

    async def check_geofence_violations(self, device_id: int, latitude: float, longitude: float) -> List[Dict[str, Any]]:
        async with self.get_session() as session:
            result = await session.execute(
                select(Geofence)
                .where(and_(
                    or_(Geofence.device_id == device_id, Geofence.device_id.is_(None)),
                    Geofence.is_active == True
                ))
            )
            geofences = result.scalars().all()
            violations = []
            
            for geofence in geofences:
                point = func.ST_SetSRID(func.ST_MakePoint(longitude, latitude), 4326)
                
                contains_query = select(func.ST_Contains(geofence.polygon, point))
                result = await session.execute(contains_query)
                is_inside = result.scalar()
                
                if is_inside and geofence.alert_on_enter:
                    violations.append({"type": "enter", "geofence_id": geofence.id, "geofence_name": geofence.name})
                elif not is_inside and geofence.alert_on_exit:
                    violations.append({"type": "exit", "geofence_id": geofence.id, "geofence_name": geofence.name})
            return violations

    async def create_geofence(self, geofence_data: Dict[str, Any]) -> Geofence:
        async with self.get_session() as session:
            coords = geofence_data['polygon']
            geometry_type = geofence_data.get('geometry_type', 'polygon')
            wkt_coords = ', '.join([f"{lon} {lat}" for lon, lat in coords])

            if geometry_type == 'polyline':
                polygon_wkt = f"LINESTRING({wkt_coords})"
            else:
                polygon_wkt = f"POLYGON(({wkt_coords}))"

            geofence = Geofence(
                device_id=geofence_data.get('device_id'),
                name=geofence_data['name'],
                description=geofence_data.get('description'),
                polygon=f'SRID=4326;{polygon_wkt}',
                alert_on_enter=geofence_data.get('alert_on_enter', False),
                alert_on_exit=geofence_data.get('alert_on_exit', False),
                color=geofence_data.get('color', '#3388ff'),
                geometry_type=geometry_type,
            )
            session.add(geofence)
            await session.flush()
            return geofence

    async def update_geofence(self, geofence_id: int, update_data: dict) -> Optional[Geofence]:
        async with self.get_session() as session:
            result = await session.execute(select(Geofence).where(Geofence.id == geofence_id))
            geofence = result.scalar_one_or_none()
            if not geofence:
                return None

            if 'name' in update_data and update_data['name'] is not None:
                geofence.name = update_data['name']
            if 'description' in update_data:
                geofence.description = update_data['description']
            if 'color' in update_data and update_data['color'] is not None:
                geofence.color = update_data['color']
            if 'alert_on_enter' in update_data and update_data['alert_on_enter'] is not None:
                geofence.alert_on_enter = update_data['alert_on_enter']
            if 'alert_on_exit' in update_data and update_data['alert_on_exit'] is not None:
                geofence.alert_on_exit = update_data['alert_on_exit']
            if 'geometry_type' in update_data and update_data['geometry_type'] is not None:
                geofence.geometry_type = update_data['geometry_type']
            if 'polygon' in update_data and update_data['polygon'] is not None:
                coords = update_data['polygon']
                wkt_coords = ', '.join([f"{lon} {lat}" for lon, lat in coords])
                gtype = update_data.get('geometry_type') or geofence.geometry_type or 'polygon'
                if gtype == 'polyline':
                    geofence.polygon = f'SRID=4326;LINESTRING({wkt_coords})'
                else:
                    geofence.polygon = f'SRID=4326;POLYGON(({wkt_coords}))'

            await session.flush()
            return geofence

    async def create_user(self, user_data: UserCreate) -> User:
        async with self.get_session() as session:
            password_hash = bcrypt.hashpw(user_data.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
            user = User(
                username=user_data.username,
                email=user_data.email,
                password_hash=password_hash,
                is_admin=user_data.is_admin,
                notification_channels=user_data.notification_channels
            )
            session.add(user)
            await session.flush()
            await session.refresh(user)
            return user
    
    # New method for authentication
    async def authenticate_user(self, username: str, password: str) -> Optional[User]:
        async with self.get_session() as session:
            # Allow login by username or email
            result = await session.execute(
                select(User).where(or_(User.username == username, User.email == username))
            )
            user = result.scalar_one_or_none()
            
            if not user:
                return None
            
            if bcrypt.checkpw(password.encode('utf-8'), user.password_hash.encode('utf-8')):
                return user
            
            return None

    async def update_user(self, user_id: int, user_data: UserUpdate) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if not user: return None
            
            if user_data.email: user.email = user_data.email
            if user_data.password:
                user.password_hash = bcrypt.hashpw(user_data.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
            if user_data.notification_channels is not None:
                user.notification_channels = user_data.notification_channels
            if user_data.language: user.language = user_data.language
            
            await session.flush()
            await session.refresh(user)
            return user

    async def get_user(self, user_id: int) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            return result.scalar_one_or_none()

    async def create_device(self, device_data: DeviceCreate) -> Device:
        async with self.get_session() as session:
            device = Device(
                imei=device_data.imei,
                name=device_data.name,
                protocol=device_data.protocol,
                vehicle_type=device_data.vehicle_type,
                license_plate=device_data.license_plate,
                vin=device_data.vin,
                config=device_data.config.model_dump()
            )
            session.add(device)
            await session.flush()
            await session.refresh(device)
            state = DeviceState(device_id=device.id)
            session.add(state)
            await session.flush()
            return device

    async def get_device(self, device_id: int) -> Optional[Device]:
        return await self.get_device_by_id(device_id)

    async def update_device(self, device_id: int, device_data: DeviceCreate) -> Optional[Device]:
        async with self.get_session() as session:
            result = await session.execute(select(Device).where(Device.id == device_id))
            device = result.scalar_one_or_none()
            if not device: return None
            
            device.name = device_data.name
            device.imei = device_data.imei
            device.protocol = device_data.protocol
            device.vehicle_type = device_data.vehicle_type
            device.license_plate = device_data.license_plate
            device.vin = device_data.vin
            device.config = device_data.config.model_dump()
            
            await session.flush()
            await session.refresh(device)
            return device

    async def delete_device(self, device_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(delete(Device).where(Device.id == device_id))
            return result.rowcount > 0

    async def add_device_to_user(self, user_id: int, device_id: int, access_level: str = "admin"):
        async with self.get_session() as session:
            from models import user_device_association
            await session.execute(user_device_association.insert().values(user_id=user_id, device_id=device_id, access_level=access_level))

    async def get_device_state(self, device_id: int) -> Optional[DeviceState]:
        async with self.get_session() as session:
            result = await session.execute(select(DeviceState).where(DeviceState.device_id == device_id))
            return result.scalar_one_or_none()

    async def save_position(self, device_id: int, position: NormalizedPosition) -> DeviceState:
        await self.process_position(position)
        return await self.get_device_state(device_id)

    async def get_device_trips(self, device_id: int, start_date: datetime, end_date: datetime) -> List[Trip]:
        if start_date.tzinfo: start_date = start_date.astimezone(timezone.utc).replace(tzinfo=None)
        if end_date.tzinfo: end_date = end_date.astimezone(timezone.utc).replace(tzinfo=None)
        
        async with self.get_session() as session:
            result = await session.execute(select(Trip).where(and_(Trip.device_id == device_id, Trip.start_time >= start_date, Trip.start_time <= end_date)).order_by(Trip.start_time.desc()))
            return result.scalars().all()
            
    async def get_trip(self, trip_id: int) -> Optional[Trip]:
        async with self.get_session() as session:
            result = await session.execute(select(Trip).where(Trip.id == trip_id))
            return result.scalar_one_or_none()

    async def get_geofences(self, device_id: Optional[int] = None) -> List[dict]:
        async with self.get_session() as session:
            # Use ST_AsGeoJSON to get coordinates as JSON from PostGIS
            query = select(
                Geofence.id,
                Geofence.device_id,
                Geofence.name,
                Geofence.description,
                Geofence.alert_on_enter,
                Geofence.alert_on_exit,
                Geofence.is_active,
                Geofence.color,
                Geofence.geometry_type,
                Geofence.created_at,
                func.ST_AsGeoJSON(Geofence.polygon).label('geojson'),
            ).where(Geofence.is_active == True)

            if device_id is not None:
                query = query.where(or_(Geofence.device_id == device_id, Geofence.device_id.is_(None)))

            result = await session.execute(query)
            rows = result.mappings().all()

            geofences = []
            for row in rows:
                import json as _json
                coords = []
                if row['geojson']:
                    geojson = _json.loads(row['geojson'])
                    # GeoJSON polygon: coordinates[0] is the outer ring [[lng,lat],...]
                    if geojson.get('type') == 'Polygon':
                        coords = geojson['coordinates'][0]
                    elif geojson.get('type') == 'LineString':
                        coords = geojson['coordinates']

                geofences.append({
                    'id': row['id'],
                    'device_id': row['device_id'],
                    'name': row['name'],
                    'description': row['description'],
                    'alert_on_enter': row['alert_on_enter'],
                    'alert_on_exit': row['alert_on_exit'],
                    'is_active': row['is_active'],
                    'color': row['color'],
                    'geometry_type': row['geometry_type'] or 'polygon',
                    'created_at': row['created_at'],
                    'coordinates': coords,
                })

            return geofences

    async def delete_geofence(self, geofence_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(delete(Geofence).where(Geofence.id == geofence_id))
            return result.rowcount > 0

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
                alert_metadata=alert_data.alert_metadata
            )
            session.add(alert)
            await session.flush()
            return alert

    async def delete_alert(self, alert_id: int) -> bool:
        """Delete an alert from history"""
        async with self.get_session() as session:
            result = await session.execute(delete(AlertHistory).where(AlertHistory.id == alert_id))
            return result.rowcount > 0

    async def get_user_alerts(self, user_id: int, unread_only: bool = False, device_id: Optional[int] = None, limit: int = 50) -> List[AlertHistory]:
        async with self.get_session() as session:
            query = select(AlertHistory).where(AlertHistory.user_id == user_id)
            if unread_only: query = query.where(AlertHistory.is_read == False)
            if device_id: query = query.where(AlertHistory.device_id == device_id)
            query = query.order_by(AlertHistory.created_at.desc()).limit(limit)
            result = await session.execute(query)
            return result.scalars().all()
    
    async def get_unread_alerts(self, user_id: int, limit: int = 50) -> List[AlertHistory]:
        return await self.get_user_alerts(user_id, unread_only=True, limit=limit)

    async def mark_alert_read(self, alert_id: int) -> bool:
        async with self.get_session() as session:
            result = await session.execute(update(AlertHistory).where(AlertHistory.id == alert_id).values(is_read=True, read_at=datetime.utcnow()))
            return result.rowcount > 0

    async def delete_alert(self, alert_id: int) -> bool:
        """Delete an alert from history permanently"""
        async with self.get_session() as session:
            result = await session.execute(
                delete(AlertHistory).where(AlertHistory.id == alert_id)
            )
            return result.rowcount > 0

    async def enqueue_command(self, command_data: CommandCreate) -> CommandQueue:
        async with self.get_session() as session:
            command = CommandQueue(
                device_id=command_data.device_id,
                command_type=command_data.command_type,
                payload=command_data.payload,
                max_retries=command_data.max_retries
            )
            session.add(command)
            await session.flush()
            return command
            
    async def create_command(self, command_data: CommandCreate) -> CommandQueue:
        return await self.enqueue_command(command_data)

    async def get_pending_commands(self, device_id: int) -> List[CommandQueue]:
        async with self.get_session() as session:
            result = await session.execute(select(CommandQueue).where(and_(CommandQueue.device_id == device_id, CommandQueue.status == 'pending')).order_by(CommandQueue.created_at))
            return result.scalars().all()

    async def mark_command_sent(self, command_id: int):
        async with self.get_session() as session:
            await session.execute(update(CommandQueue).where(CommandQueue.id == command_id).values(status='sent', sent_at=datetime.utcnow()))
            
    async def get_command(self, command_id: int) -> Optional[CommandQueue]:
        async with self.get_session() as session:
            result = await session.execute(select(CommandQueue).where(CommandQueue.id == command_id))
            return result.scalar_one_or_none()

    async def get_device_commands(self, device_id: int, status: Optional[str] = None) -> List[CommandQueue]:
        """
        Get command history for a device, optionally filtered by status.
        
        Args:
            device_id: The device ID
            status: Optional status filter ('pending', 'sent', 'acked', 'failed', 'timeout')
        
        Returns:
            List of CommandQueue objects ordered by creation time (newest first)
        """
        async with self.get_session() as session:
            query = select(CommandQueue).where(CommandQueue.device_id == device_id)
            
            if status:
                query = query.where(CommandQueue.status == status)
            
            query = query.order_by(CommandQueue.created_at.desc())
            
            result = await session.execute(query)
            return result.scalars().all()

    async def get_all_active_devices_with_state(self) -> List[tuple[Device, DeviceState]]:
        """Returns all active devices alongside their state, regardless of online status."""
        async with self.get_session() as session:
            result = await session.execute(
                select(Device, DeviceState)
                .join(DeviceState, Device.id == DeviceState.device_id)
                .where(Device.is_active == True)
                .options(selectinload(Device.users))
            )
            return [(device, state) for device, state in result.all()]

    async def mark_device_offline(self, device_id: int):
        async with self.get_session() as session:
            await session.execute(update(DeviceState).where(DeviceState.device_id == device_id).values(is_online=False))

    async def get_device_statistics(self, device_id: int, start_date: datetime, end_date: datetime) -> Optional[Dict[str, Any]]:
        device = await self.get_device(device_id)
        if not device: return None
        
        if start_date.tzinfo: start_date = start_date.astimezone(timezone.utc).replace(tzinfo=None)
        if end_date.tzinfo: end_date = end_date.astimezone(timezone.utc).replace(tzinfo=None)
        
        trips = await self.get_device_trips(device_id, start_date, end_date)
        total_dist = sum(t.distance_km for t in trips)
        avg_speeds = [t.avg_speed for t in trips if t.avg_speed]
        max_speeds = [t.max_speed for t in trips if t.max_speed]
        
        async with self.get_session() as session:
            idle_count = await session.execute(select(func.count(PositionRecord.id)).where(and_(PositionRecord.device_id == device_id, PositionRecord.device_time >= start_date, PositionRecord.device_time <= end_date, PositionRecord.ignition == True, PositionRecord.speed < 1.0)))
            total_idle = idle_count.scalar() or 0
        
        return {
            "device_id": device_id,
            "total_distance_km": round(total_dist, 2),
            "total_trips": len(trips),
            "avg_speed": round(sum(avg_speeds)/len(avg_speeds), 1) if avg_speeds else 0,
            "max_speed": round(max(max_speeds), 1) if max_speeds else 0,
            "total_idle_time_minutes": total_idle,
            "total_driving_time_minutes": sum(t.duration_minutes for t in trips if t.duration_minutes),
            "period_start": start_date,
            "period_end": end_date
        }

    async def update_device_alert_state(self, device_id: int, alert_states: Dict[str, Any]):
        async with self.get_session() as session:
            await session.execute(
                update(DeviceState)
                .where(DeviceState.device_id == device_id)
                .values(alert_states=alert_states)
            )

    async def get_user_by_username(self, username: str) -> Optional[User]:
        async with self.get_session() as session:
            result = await session.execute(
                select(User).where(User.username == username)
            )
            return result.scalar_one_or_none()


# Global instances
db_service: Optional[DatabaseService] = None

async def init_database(database_url: str) -> DatabaseService:
    global db_service
    db_service = DatabaseService(database_url)
    await db_service.init_db()
    return db_service

def get_db() -> DatabaseService:
    if db_service is None:
        raise RuntimeError("Database not initialized.")
    return db_service


