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

import httpx

import rule_engine

from models import Device, DeviceState, User, AlertHistory
from models.schemas import AlertCreate, AlertType, Severity, NormalizedPosition
from core.database import get_db
from core.runtime_health import mark_task_error, mark_task_success
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
            users = device.users or []

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
                        "duration": row.get("duration"),
                    }
                else:
                    params = row.get("params", {})

                results = await alert_cls().check_many(position, device, state, params)
                notify_ids = row.get('notify_user_ids')
                send_push = row.get('send_push', True)
                send_email = row.get('send_email', False)
                send_voip = row.get('send_voip', False)
                action_cmd = row.get('action_command')
                action_cmd_payload = row.get('action_command_payload')
                for r in results:
                    r.setdefault('send_push', send_push)
                    r.setdefault('send_email', send_email)
                    r.setdefault('send_voip', send_voip)
                    if action_cmd and action_cmd != 'disabled':
                        r.setdefault('action_command', action_cmd)
                        if action_cmd_payload:
                            r.setdefault('action_command_payload', action_cmd_payload)
                    if notify_ids is not None:
                        r.setdefault('notify_user_ids', notify_ids)
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

    async def _execute_alert_command(self, device: Device, command_type: str, payload: Optional[str], users: List[User]):
        """Execute an automated device command triggered by an alert."""
        try:
            from routes.commands import send_command, CommandCreate
            db = get_db()
            executor = None
            if users:
                executor = users[0]
            else:
                db_users = await db.get_all_users()
                executor = next((u for u in db_users if u.is_admin), db_users[0] if db_users else None)
            if not executor:
                logger.warning("No user context available to execute alert command '%s' for device %s", command_type, device.id)
                return
            cmd_payload = CommandCreate(device_id=device.id, command_type=command_type, payload=payload or "")
            await send_command(device_id=device.id, command=cmd_payload, caller=executor, _=executor)
            logger.info("Successfully executed alert action command '%s' (payload: '%s') for device %s", command_type, payload or "", device.name)
        except Exception as e:
            logger.error("Failed to execute alert action command '%s' for device %s: %s", command_type, device.name, e)

    async def _dispatch_alert(self, users: List[User], device: Device, alert_data: Dict[str, Any]):
        """
        Handles database creation, real-time broadcasting, and external notifications.
        Ensures WebSocket broadcast only happens ONCE per alert event.
        """
        action_cmd = alert_data.get("action_command")
        if action_cmd and action_cmd != "disabled":
            action_payload = alert_data.get("action_command_payload")
            asyncio.create_task(self._execute_alert_command(device, action_cmd, action_payload, users))
        alert_type = alert_data.get("type")
        alert_type_value = alert_type.value if hasattr(alert_type, "value") else str(alert_type or "")
        try:
            from core.schedule_runner import trigger_report_schedules_for_alert
            if alert_type_value != "route_completed":
                def _log_schedule_trigger_result(task: asyncio.Task) -> None:
                    if task.cancelled():
                        return
                    exc = task.exception()
                    if exc:
                        logger.error(
                            "Alert-triggered report schedule failed: %s",
                            exc,
                            exc_info=(type(exc), exc, exc.__traceback__),
                        )

                task = asyncio.create_task(trigger_report_schedules_for_alert(
                    alert_type_value,
                    device.id,
                    alert_data=alert_data,
                    allowed_user_ids=[u.id for u in users if getattr(u, "id", None) is not None],
                ))
                task.add_done_callback(_log_schedule_trigger_result)
        except Exception as exc:
            logger.error("Alert-triggered report schedule failed: %s", exc, exc_info=True)

        notify_ids = alert_data.get('notify_user_ids')
        db = get_db()
        if notify_ids is not None:
            users = await db.get_users_by_ids(notify_ids)

        broadcasted = False

        for user in users:
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
                await self.alert_callback(alert, notify_user_ids=notify_ids)
                broadcasted = True
                
            # 3. External notifications (Email, Telegram, SIP call, etc. per user)
            await self._send_notification(user, device, alert_data, alert_id=alert.id)

    async def _send_notification(self, user: User, device: Device, alert_data: Dict[str, Any], alert_id: Optional[int] = None):
        channel_status = []
        try:
            metadata = alert_data.get('alert_metadata', {})
            selected_names = None
            send_push = alert_data.get('send_push', True)

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

            # 2. Filter channels by selected IDs / names
            if selected_names is not None:
                selected_keys = set(selected_names)
                active_channels = [
                    c for c in user_ch
                    if isinstance(c, dict) and c.get('url') and (
                        (c.get('id') and c.get('id') in selected_keys) or
                        (c.get('name') and c.get('name') in selected_keys)
                    )
                ]
                found_keys = set()
                for c in active_channels:
                    if c.get('id'):
                        found_keys.add(c['id'])
                    if c.get('name'):
                        found_keys.add(c['name'])
                missing_keys = [k for k in selected_names if k not in found_keys]

                # Fallback: if selected channel was created by admin/superadmin and not in target user's channels
                if missing_keys:
                    db = get_db()
                    additional_channels = await db.get_notification_channels_by_names(
                        names=missing_keys,
                        company_id=device.company_id,
                    )
                    active_channels.extend(additional_channels)
            else:
                active_channels = []

            # 3. Dispatch each URL to the matching channel handler
            if active_channels:
                rule_title = alert_data.get('alert_metadata', {}).get('rule_name')
                alert_label = rule_title if rule_title else alert_data['type'].value.upper()
                title = f"🚗 {device.name} - {alert_label}"
                message = alert_data['message']

                async def _send_single(c):
                    c_name = c.get('name', 'Channel')
                    url = c.get('url', '')
                    ch = get_channel(url)
                    if not ch:
                        return {"name": c_name, "status": "failed", "error": "Unsupported channel type"}
                    try:
                        ok = await ch.send(url, title, message)
                        return {"name": c_name, "status": "sent" if ok else "failed"}
                    except Exception as err:
                        return {"name": c_name, "status": "failed", "error": str(err)}

                results = await asyncio.gather(
                    *[_send_single(c) for c in active_channels],
                    return_exceptions=True
                )
                for r in results:
                    if isinstance(r, dict):
                        channel_status.append(r)

            # 4. Push notification (browser/PWA)
            if send_push:
                try:
                    push = get_push_service()
                    ok = await push.notify_user(
                        db_service=get_db(),
                        user_id=user.id,
                        alert_type=alert_data['type'].value,
                        message=alert_data['message'],
                        severity=alert_data.get('severity', 'info'),
                        device_name=device.name,
                    )
                    if ok:
                        channel_status.append({"name": "Web Push", "status": "sent"})
                    else:
                        channel_status.append({"name": "Web Push", "status": "failed", "error": "No active browser subscription or push disabled"})
                except Exception as e:
                    channel_status.append({"name": "Web Push", "status": "failed", "error": str(e)})

            # 5. System Email notification
            send_email = alert_data.get('send_email', False)
            if send_email:
                user_email = getattr(user, 'email', None)
                if not user_email or not user_email.strip():
                    logger.debug("System email alert skipped for user '%s' — no email address configured.", getattr(user, 'username', user.id))
                    channel_status.append({"name": "System Email", "status": "skipped", "error": "No email address configured for user"})
                else:
                    try:
                        from core.config import get_settings
                        from core.email import send_email_async

                        settings = get_settings()
                        smtp_enabled = getattr(settings, 'smtp_enabled', False)
                        if isinstance(smtp_enabled, str):
                            smtp_enabled = smtp_enabled.lower() in ('true', '1', 'yes', 'on')

                        if not smtp_enabled:
                            logger.debug("System email alert skipped — email notifications are disabled on system settings.")
                        else:
                            rule_title = alert_data.get('alert_metadata', {}).get('rule_name')
                            alert_type_label = alert_data['type'].value.upper() if hasattr(alert_data['type'], 'value') else str(alert_data['type']).upper()
                            alert_label = rule_title if rule_title else alert_type_label
                            subject = f"⚠️ Alert: {device.name} - {alert_label}"
                            body = (
                                f"Hello {user.username},\n\n"
                                f"An alert was triggered for vehicle '{device.name}':\n\n"
                                f"- Vehicle: {device.name}\n"
                                f"- Alert Type: {alert_label}\n"
                                f"- Severity: {alert_data.get('severity', 'info')}\n"
                                f"- Message: {alert_data['message']}\n"
                                f"- Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
                                f"Best regards,\n"
                                f"Routario Telematics Platform"
                            )
                            ok = await send_email_async([user_email.strip()], subject, body)
                            if ok:
                                channel_status.append({"name": "System Email", "status": "sent"})
                            else:
                                channel_status.append({"name": "System Email", "status": "skipped", "error": "Email disabled or SMTP not configured"})
                    except Exception as e:
                        channel_status.append({"name": "System Email", "status": "failed", "error": str(e)})

            # 6. VoIP Voice Call Alarm notification
            send_voip = alert_data.get('send_voip', False)
            if send_voip:
                user_phone = getattr(user, 'phone_number', None)
                if not user_phone or not user_phone.strip():
                    logger.debug("VoIP voice call alarm skipped for user '%s' — no phone number configured.", getattr(user, 'username', user.id))
                    channel_status.append({"name": "VoIP Call", "status": "skipped", "error": "No phone number configured for user"})
                else:
                    try:
                        from core.config import get_settings
                        from core.voip import send_voip_call_async

                        settings = get_settings()
                        voip_enabled = getattr(settings, 'voip_enabled', False)
                        if isinstance(voip_enabled, str):
                            voip_enabled = voip_enabled.lower() in ('true', '1', 'yes', 'on')

                        if not voip_enabled:
                            logger.debug("VoIP voice call alarm skipped — VoIP calling is disabled on system settings.")
                        else:
                            rule_title = alert_data.get('alert_metadata', {}).get('rule_name')
                            alert_type_label = alert_data['type'].value.upper() if hasattr(alert_data['type'], 'value') else str(alert_data['type']).upper()
                            alert_label = rule_title if rule_title else alert_type_label
                            tts_msg = f"Alert warning for vehicle {device.name}. {alert_label}. {alert_data['message']}."
                            ok = await send_voip_call_async(user_phone.strip(), tts_msg)
                            if ok:
                                channel_status.append({"name": "VoIP Call", "status": "sent"})
                            else:
                                channel_status.append({"name": "VoIP Call", "status": "failed", "error": "Call failed or server unreachable"})
                    except Exception as e:
                        channel_status.append({"name": "VoIP Call", "status": "failed", "error": str(e)})

            # 7. Alert webhooks
            wh_status = await self._send_alert_webhooks(user, device, alert_data)
            if wh_status is not None:
                channel_status.append({"name": "Webhooks", "status": "sent" if wh_status else "failed"})

            # 8. Save channel_status into AlertHistory record if alert_id is provided
            if alert_id and channel_status:
                db = get_db()
                await db.update_alert_channel_status(alert_id, channel_status)

        except Exception as e:
            logger.error(f"Notify error: {e}")


    @staticmethod
    async def _send_alert_webhooks(user, device, alert_data: dict) -> Optional[bool]:
        """Dispatch JSON alert payload to any configured user webhook URLs."""
        webhooks = getattr(user, 'webhook_urls', None)
        if not webhooks:
            return None

        clean_urls = [u.strip() for u in webhooks if isinstance(u, str) and u.strip()]
        if not clean_urls:
            return None

        rule_title = alert_data.get('alert_metadata', {}).get('rule_name')
        alert_type_label = alert_data['type'].value if hasattr(alert_data['type'], 'value') else str(alert_data['type'])

        payload = {
            "custom_attributes": device.custom_attributes or {},
            "alert_type":    alert_data['type'].value,
            "severity":      alert_data.get('severity', Severity.WARNING).value
                             if hasattr(alert_data.get('severity'), 'value')
                             else str(alert_data.get('severity', 'warning')),
            "message":       alert_data['message'],
            "latitude":      alert_data.get('latitude'),
            "longitude":     alert_data.get('longitude'),
            "timestamp":     datetime.now(timezone.utc).isoformat(),
            "metadata":      alert_data.get('alert_metadata', {}),
        }
        any_success = False
        async with httpx.AsyncClient(timeout=5) as client:
            for url in clean_urls:
                try:
                    res = await client.post(url, json=payload)
                    if res.is_success:
                        any_success = True
                except Exception as exc:
                    logger.warning("Alert webhook failed %s: %s", url, exc)
        return any_success
    



async def periodic_alert_task():
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

                    alert_rows = device.config.get('alert_rows', [])
                    row = next(
                        (r for r in alert_rows
                         if isinstance(r, dict) and r.get('alertKey') == alert_key),
                        None,
                    )

                    # ← Only run if the user has actually configured this alert
                    if not row:
                        continue

                    if not engine._is_alert_active(alert_key, device):
                        continue

                    try:
                        params = row.get('params', {})

                        if state.alert_states is None:
                            state.alert_states = {}

                        result = await alert_cls().check_device(device, state, params)
                        await db.update_device_alert_state(device.id, state.alert_states)

                        if result:
                            result.setdefault('latitude',  state.last_latitude)
                            result.setdefault('longitude', state.last_longitude)
                            result.setdefault('send_push', row.get('send_push', True))
                            result.setdefault('send_email', row.get('send_email', False))
                            result.setdefault('send_voip', row.get('send_voip', False))
                            action_cmd = row.get('action_command')
                            if action_cmd and action_cmd != 'disabled':
                                result.setdefault('action_command', action_cmd)
                            notify_ids = row.get('notify_user_ids')
                            if notify_ids is not None:
                                result.setdefault('notify_user_ids', notify_ids)
                            await engine._dispatch_alert(device.users, device, result)
                    except Exception as e:
                        logger.error(f"Periodic alert check error ({alert_key}): {e}")
            mark_task_success("alert_engine")
        except Exception as e:
            mark_task_error("alert_engine", e)
            logger.error(f"Periodic alert task error: {e}")

# Global singleton
_alert_engine: Optional[AlertEngine] = None

def get_alert_engine() -> AlertEngine:
    global _alert_engine
    if _alert_engine is None:
        _alert_engine = AlertEngine()
    return _alert_engine
