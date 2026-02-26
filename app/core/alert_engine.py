"""
Alert Engine
Rule-based alerting with temporal logic and notifications
"""
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Callable
import logging
from concurrent.futures import ThreadPoolExecutor
import re

import rule_engine

from models import Device, DeviceState, User, AlertHistory
from models.schemas import AlertCreate, AlertType, Severity, NormalizedPosition
from core.database import get_db
from alerts import ALERT_REGISTRY
from core.push_notifications import get_push_service
from notifications import get_channel


logger = logging.getLogger(__name__)


class AlertEngine:
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=5)
        self.rule_cache = {} 
        self.alert_callback: Optional[Callable[[AlertHistory], Any]] = None 
        
    def set_alert_callback(self, callback: Callable):
        self.alert_callback = callback
    
    def _is_alert_active(self, alert_key: str, device, rule_name: str = None) -> bool:
        """Return True if this alert should fire right now per its schedule.

        For system alerts  : _is_alert_active('speed_tolerance', device)
        For custom rules   : _is_alert_active('__custom__', device, rule_name='My Rule')

        Schedule shape (set by the frontend):
            { "days": [0,1,2,3,4], "hourStart": 8, "hourEnd": 17 }
        Days follow ISO / Python weekday(): 0 = Monday, 6 = Sunday.
        No schedule (or empty days list) means "always active".
        """
        alert_rows = device.config.get('alert_rows', [])

        if alert_key == '__custom__' and rule_name:
            row = next(
                (r for r in alert_rows
                 if isinstance(r, dict)
                 and r.get('alertKey') == '__custom__'
                 and r.get('name') == rule_name),
                None,
            )
        else:
            row = next(
                (r for r in alert_rows
                 if isinstance(r, dict) and r.get('alertKey') == alert_key),
                None,
            )

        if not row:
            return True  # no row → no restriction → always active

        schedule = row.get('schedule')
        if not schedule or not schedule.get('days'):
            return True  # no schedule set → always active

        now       = datetime.now(timezone.utc)
        today_dow = now.weekday()   # Monday = 0, Sunday = 6
        current_h = now.hour

        if today_dow not in schedule['days']:
            return False
        if not (schedule.get('hourStart', 0) <= current_h <= schedule.get('hourEnd', 23)):
            return False
        return True

    async def process_position_alerts(self, position, device, state):
        try:
            users = device.users
            if not users:
                return

            if state.alert_states is None:
                state.alert_states = {}

            alerts = []
            alert_rows = device.config.get("alert_rows", [])

            for row in alert_rows:
                if not isinstance(row, dict):
                    continue

                alert_key = row.get("alertKey")
                if not alert_key:
                    continue

                alert_cls = ALERT_REGISTRY.get(alert_key)
                if not alert_cls:
                    continue

                rule_name = row.get("name") if alert_key == "__custom__" else None
                if not self._is_alert_active(alert_key, device, rule_name=rule_name):
                    continue

                # For custom rows, params come from the row's top-level name/rule/channels fields
                if alert_key == "__custom__":
                    params = {
                        "name":     row.get("name", ""),
                        "rule":     row.get("rule", ""),
                        "channels": row.get("channels", []),
                    }
                else:
                    params = row.get("params", {})

                results = await alert_cls().check_many(position, device, state, params)
                alerts.extend(results)

            if state.alert_states is not None:
                db = get_db()
                await db.update_device_alert_state(device.id, state.alert_states)

            for alert_data in alerts:
                alert_data.setdefault("latitude",  position.latitude)
                alert_data.setdefault("longitude", position.longitude)
                await self._dispatch_alert(users, device, alert_data)

        except Exception as e:
            logger.error(f"Alert processing error: {e}")

    async def _dispatch_alert(self, users: List[User], device: Device, alert_data: Dict[str, Any]):
        """
        Handles database creation, real-time broadcasting, and external notifications.
        Ensures WebSocket broadcast only happens ONCE per alert event.
        """
        broadcasted = False
        
        for user in users:
            db = get_db()
            # 1. Create personal alert history record
            alert = await db.create_alert(AlertCreate(
                user_id=user.id, 
                device_id=device.id, 
                alert_type=alert_data['type'], 
                severity=alert_data['severity'], 
                message=alert_data['message'], 
                latitude=alert_data.get('latitude'), 
                longitude=alert_data.get('longitude'), 
                alert_metadata=alert_data.get('alert_metadata', {})
            ))
            
            # 2. Real-time broadcast (ONLY ONCE)
            if not broadcasted and self.alert_callback:
                await self.alert_callback(alert)
                broadcasted = True
                
            # 3. External notifications (Email, Telegram, SIP call, etc. per user)
            await self._send_notification(user, device, alert_data)

    async def _send_notification(self, user: User, device: Device, alert_data: Dict[str, Any]):
        try:
            metadata = alert_data.get('alert_metadata', {})
            selected_names = None
            
            # 1. Determine which channel names are selected
            if 'selected_channels' in metadata:
                # Direct selection (usually from custom rules)
                selected_names = metadata['selected_channels']
            elif 'config_key' in metadata:
                # Keyed configuration (Speeding, Idling, etc)
                config_key = metadata['config_key']
                alert_channels = device.config.get('alert_channels', {})
                if config_key in alert_channels:
                    selected_names = alert_channels[config_key]
                else:
                    selected_names = None  # Not configured, use fallback

            user_ch = user.notification_channels or []

            # 2. Filter channels by selected names
            if selected_names is not None:
                active_channels = [c for c in user_ch if c['name'] in selected_names and c.get('url')]
            else:
                active_channels = [c for c in user_ch if c.get('url')]

            if not active_channels:
                # Still send push notification even with no channels
                push = get_push_service()
                await push.notify_user(
                    db_service=get_db(),
                    user_id=user.id,
                    alert_type=alert_data['type'].value,
                    message=alert_data['message'],
                    severity=alert_data.get('severity', 'info'),
                    device_name=device.name,
                )
                return

            # 3. Dispatch each URL to the matching channel handler
            title = f"🚗 {device.name} - {alert_data['type'].value.upper()}"
            message = f"{device.name}. {alert_data['message']}"
            await asyncio.gather(
                *[
                    ch.send(c['url'], title, message)
                    for c in active_channels
                    if (ch := get_channel(c['url'])) is not None
                ],
                return_exceptions=True
            )

            # 4. Push notification (browser/PWA)
            push = get_push_service()
            await push.notify_user(
                db_service=get_db(),
                user_id=user.id,
                alert_type=alert_data['type'].value,
                message=alert_data['message'],
                severity=alert_data.get('severity', 'info'),
                device_name=device.name,
            )

        except Exception as e: 
            logger.error(f"Notify error: {e}")
    



async def periodic_alert_task():
    """
    Background task that runs every 60 seconds and checks all time-based alert
    modules that can't be triggered by incoming positions (e.g. offline detection).
    
    Any alert module that implements check_device() will be called here for
    every active device.
    """
    engine = get_alert_engine()
    while True:
        try:
            await asyncio.sleep(60)
            db = get_db()
            devices = await db.get_all_active_devices_with_state()
            for device, state in devices:
                for alert_key, alert_cls in ALERT_REGISTRY.items():
                    if not hasattr(alert_cls, 'check_device'):
                        continue
                    if not engine._is_alert_active(alert_key, device):
                        continue
                    try:
                        alert_rows = device.config.get('alert_rows', [])
                        row = next(
                            (r for r in alert_rows
                             if isinstance(r, dict) and r.get('alertKey') == alert_key),
                            None
                        )
                        params = row.get('params', {}) if row else {}

                        if state.alert_states is None:
                            state.alert_states = {}

                        result = await alert_cls().check_device(device, state, params)

                        # Always persist alert_states — check_device() may have mutated
                        # it (e.g. setting offline_alerted=True or resetting it to False)
                        # even when no alert is returned. Without this the flag is lost
                        # on the next tick and the alert fires again every minute.
                        await db.update_device_alert_state(device.id, state.alert_states)

                        if result:
                            result.setdefault('latitude',  state.last_latitude)
                            result.setdefault('longitude', state.last_longitude)
                            await engine._dispatch_alert(device.users, device, result)
                    except Exception as e:
                        logger.error(f"Periodic alert check error ({alert_key}): {e}")
        except Exception as e:
            logger.error(f"Periodic alert task error: {e}")


# Global singleton
_alert_engine: Optional[AlertEngine] = None

def get_alert_engine() -> AlertEngine:
    global _alert_engine
    if _alert_engine is None:
        _alert_engine = AlertEngine()
    return _alert_engine