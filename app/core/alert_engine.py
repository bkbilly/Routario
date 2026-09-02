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

    @staticmethod
    def _extract_alert_thresholds(alert_data: Dict[str, Any], device: Device) -> List[tuple[str, str]]:
        """Extract and format all frontend-configured thresholds & parameters dynamically."""
        from alerts import ALERT_DEFINITIONS

        thresholds: List[tuple[str, str]] = []
        metadata = alert_data.get('alert_metadata') or {}
        params = dict(alert_data.get('params') or metadata.get('params') or {})

        alert_type_val = alert_data.get('type')
        if hasattr(alert_type_val, 'value'):
            alert_type_val = alert_type_val.value
        alert_type_str = str(alert_type_val).lower() if alert_type_val else ""

        # 1. Match the specific alert row from device.config.alert_rows
        matched_row = None
        if device and device.config:
            rule_name = metadata.get('rule_name')
            for r in device.config.get('alert_rows', []):
                if not isinstance(r, dict):
                    continue
                r_key = str(r.get('alertKey', '')).lower()
                r_name = r.get('name')
                if rule_name and r_name and r_name.strip() == rule_name.strip():
                    matched_row = r
                    break
                if not rule_name and r_key and (r_key == alert_type_str or (alert_type_str and alert_type_str in r_key)):
                    matched_row = r
                    break

        if matched_row:
            if isinstance(matched_row.get('params'), dict):
                for k, v in matched_row['params'].items():
                    if k not in params and v is not None and v != "":
                        params[k] = v
            if 'duration' in matched_row and matched_row['duration'] is not None and 'duration' not in params:
                params['duration'] = matched_row['duration']
            if 'rule' in matched_row and matched_row['rule'] and 'rule' not in params:
                params['rule'] = matched_row['rule']
            if 'action_command' in matched_row and matched_row['action_command'] and matched_row['action_command'] != 'disabled':
                params['action_command'] = matched_row['action_command']
            if 'schedule' in matched_row and matched_row['schedule']:
                params['schedule'] = matched_row['schedule']

        is_custom = (matched_row and matched_row.get('alertKey') == '__custom__') or alert_type_str in ('custom', '__custom__')
        is_device_event = (matched_row and matched_row.get('alertKey') == 'device_event') or alert_type_str in ('device_event', 'sensor')

        # Check for definition in registry
        alert_def = None
        if not is_custom:
            candidates = [
                alert_type_str,
                matched_row.get('alertKey') if matched_row else None,
                metadata.get('config_key')
            ]
            for cand in candidates:
                if not cand:
                    continue
                cand_str = str(cand).lower()
                if cand_str in ALERT_DEFINITIONS:
                    alert_def = ALERT_DEFINITIONS[cand_str]
                    break
                for k_def, v_def in ALERT_DEFINITIONS.items():
                    if cand_str == k_def or cand_str in k_def or k_def in cand_str:
                        alert_def = v_def
                        break
                if alert_def:
                    break

        rendered_keys = set()

        # 2. Extract defined fields dynamically using AlertDefinition schema (matching frontend)
        if alert_def and alert_def.fields:
            for f in alert_def.fields:
                if f.field_type == 'checkbox':
                    continue

                # Check conditional visibility (show_if)
                if f.show_if:
                    cond_key = f.show_if.get('key')
                    cur_val = str(params.get(cond_key, ''))
                    if 'values' in f.show_if:
                        allowed = [str(x) for x in f.show_if['values']]
                        if cur_val not in allowed:
                            continue
                    elif 'value' in f.show_if:
                        if cur_val != str(f.show_if['value']):
                            continue

                val = params.get(f.key)
                if val is None or str(val).strip() == "":
                    continue

                rendered_keys.add(f.key)
                display_val = str(val)

                # Special handling for Geofence name
                if f.key in ('geofence_id', 'geofence'):
                    g_name = params.get('geofence_name') or metadata.get('geofence_name')
                    if g_name:
                        display_val = str(g_name)
                    elif str(val).isdigit():
                        display_val = f"Geofence #{val}"
                    rendered_keys.add('geofence_id')
                    rendered_keys.add('geofence_name')
                    rendered_keys.add('geofence')

                # Special handling for Driver name
                elif f.key in ('driver_id', 'driver'):
                    d_name = params.get('driver_name') or metadata.get('driver_name')
                    if d_name:
                        display_val = str(d_name)
                    elif str(val).isdigit():
                        display_val = f"Driver #{val}"
                    rendered_keys.add('driver_id')
                    rendered_keys.add('driver_name')
                    rendered_keys.add('driver')

                # Format select / multiselect options
                elif f.field_type in ('select', 'multiselect', 'driver_select') and f.options:
                    if isinstance(val, list):
                        labels = []
                        for item in val:
                            match_opt = next((opt['label'] for opt in f.options if str(opt.get('value')) == str(item)), None)
                            labels.append(match_opt if match_opt else str(item))
                        display_val = ", ".join(labels)
                    else:
                        match_opt = next((opt['label'] for opt in f.options if str(opt.get('value')) == str(val)), None)
                        if match_opt:
                            display_val = match_opt

                if f.unit and not str(display_val).endswith(f.unit):
                    display_val = f"{display_val} {f.unit}"

                thresholds.append((f.label, display_val))

        elif is_custom:
            if params.get('rule'):
                thresholds.append(("Condition Rule", str(params['rule'])))
                rendered_keys.add('rule')

        elif is_device_event:
            if params.get('sensor_key'):
                thresholds.append(("Sensor Key", str(params['sensor_key'])))
                rendered_keys.add('sensor_key')
            tv = params.get('trigger_values') or params.get('trigger_value')
            if tv:
                val_str = ", ".join(str(x) for x in tv) if isinstance(tv, list) else str(tv)
                thresholds.append(("Trigger Value", val_str))
                rendered_keys.add('trigger_values')
                rendered_keys.add('trigger_value')

        # Ensure Geofence name is always displayed if present in metadata/params
        if ('geofence_name' in params or 'geofence_name' in metadata) and not any(k == 'Geofence' for k, _ in thresholds):
            g_name = params.get('geofence_name') or metadata.get('geofence_name')
            if g_name:
                thresholds.insert(0, ("Geofence", str(g_name)))
                rendered_keys.add('geofence_name')
                rendered_keys.add('geofence_id')

        # 3. Add common gates & parameters
        if params.get('duration') is not None and str(params.get('duration')).strip() != "":
            thresholds.append(("Minimum Duration", f"{params['duration']}s"))
            rendered_keys.add('duration')

        if params.get('action_command') and str(params.get('action_command')).lower() != 'disabled':
            thresholds.append(("Trigger Command", str(params['action_command']).replace('_', ' ').title()))
            rendered_keys.add('action_command')

        # 4. Add Schedule if present
        if 'schedule' in params and isinstance(params['schedule'], dict):
            sch = params['schedule']
            day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            days = sch.get('days') or []
            formatted_days = ", ".join([day_names[d] for d in sorted(days) if 0 <= d < 7]) if days else "All Days"
            hs = sch.get('hourStart', 0)
            he = sch.get('hourEnd', 24)
            time_str = f"{hs:02d}:00 - {he:02d}:00"
            thresholds.append(("Active Schedule", f"{formatted_days} ({time_str})"))
            rendered_keys.add('schedule')

        # 5. Include any extra parameters that were not part of the schema but sent in params
        skip_internal = {
            'is_test', 'triggered_by', 'channel_status', 'selected_channels',
            'config_key', 'rule_name', 'event_icon', 'notify_user_ids',
            'send_push', 'send_email', 'send_voip', 'channels'
        }
        for k, v in params.items():
            if k not in rendered_keys and k not in skip_internal and v is not None and str(v).strip() != "":
                label = k.replace('_', ' ').title()
                val_str = str(v)
                if k == 'speed_limit' and not val_str.endswith('km/h'):
                    val_str = f"{val_str} km/h"
                elif k == 'speed_tolerance' and not val_str.endswith('%'):
                    val_str = f"+{val_str}%"
                elif k in ('idle_timeout_minutes', 'timeout_minutes') and not val_str.endswith('min'):
                    val_str = f"{val_str} min"
                elif k in ('voltage_threshold', 'voltage') and not val_str.endswith('V'):
                    val_str = f"{val_str} V"
                elif k == 'offline_timeout_hours' and not val_str.endswith('hours'):
                    val_str = f"{val_str} hours"
                elif k == 'towing_threshold_meters' and not val_str.endswith('m'):
                    val_str = f"{val_str} m"
                thresholds.append((label, val_str))

        return thresholds

    async def _send_notification(self, user: User, device: Device, alert_data: Dict[str, Any], alert_id: Optional[int] = None):
        channel_status = []
        try:
            metadata = alert_data.get('alert_metadata', {})
            selected_names = None
            send_push = alert_data.get('send_push', True)

            # 1. Determine which channel names are selected
            if 'channels' in alert_data and alert_data['channels']:
                selected_names = alert_data['channels']
            elif 'selected_channels' in metadata and metadata['selected_channels']:
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
            if selected_names:
                selected_keys = set(str(k) for k in selected_names)
                active_channels = [
                    c for c in user_ch
                    if isinstance(c, dict) and c.get('url') and (
                        (c.get('id') and str(c.get('id')) in selected_keys) or
                        (c.get('name') and str(c.get('name')) in selected_keys)
                    )
                ]
                found_keys = set()
                for c in active_channels:
                    if c.get('id'):
                        found_keys.add(str(c['id']))
                    if c.get('name'):
                        found_keys.add(str(c['name']))
                missing_keys = [k for k in selected_names if str(k) not in found_keys]

                # Fallback: if selected channel was created by admin/superadmin and not in target user's channels
                if missing_keys:
                    db = get_db()
                    additional_channels = await db.get_notification_channels_by_names(
                        names=missing_keys,
                        company_id=device.company_id,
                    )
                    for ac in additional_channels:
                        if ac.get('id'):
                            found_keys.add(str(ac['id']))
                        if ac.get('name'):
                            found_keys.add(str(ac['name']))
                    active_channels.extend(additional_channels)

                # Record any unconfigured/missing channels
                for k in selected_names:
                    if str(k) not in found_keys:
                        channel_status.append({"name": str(k), "status": "failed", "error": "Channel not found or unconfigured"})
            else:
                active_channels = []

            # 3. Dispatch each URL to the matching channel handler
            if active_channels:
                rule_title = alert_data.get('alert_metadata', {}).get('rule_name')
                alert_label = rule_title if rule_title else (alert_data['type'].value.upper() if hasattr(alert_data['type'], 'value') else str(alert_data['type']).upper())
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
                    type_str = alert_data['type'].value if hasattr(alert_data['type'], 'value') else str(alert_data['type'])
                    ok = await push.notify_user(
                        db_service=get_db(),
                        user_id=user.id,
                        alert_type=type_str,
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
                            channel_status.append({"name": "System Email", "status": "skipped", "error": "Email notifications are disabled in System Settings"})
                        else:
                            rule_title = alert_data.get('alert_metadata', {}).get('rule_name')
                            alert_type_label = alert_data['type'].value.upper() if hasattr(alert_data['type'], 'value') else str(alert_data['type']).upper()
                            alert_label = rule_title if rule_title else alert_type_label
                            subject = f"⚠️ Alert: {device.name} - {alert_label}"

                            thresholds = self._extract_alert_thresholds(alert_data, device)
                            thresholds_text = ""
                            if thresholds:
                                thresholds_text = "\n\nConfigured Thresholds & Rules:\n" + "\n".join([f"• {k}: {v}" for k, v in thresholds])

                            body = (
                                f"Hello {user.username},\n\n"
                                f"An alert was triggered for vehicle '{device.name}':\n\n"
                                f"- Vehicle: {device.name}\n"
                                f"- Alert Rule: {alert_label}\n"
                                f"- Severity: {alert_data.get('severity', 'info')}\n"
                                f"- Message: {alert_data['message']}\n"
                                f"- Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}"
                                f"{thresholds_text}\n\n"
                                f"Best regards,\n"
                                f"Routario Telematics Platform"
                            )
                            sev_raw = alert_data.get('severity', 'warning')
                            sev = sev_raw.value if hasattr(sev_raw, 'value') else str(sev_raw).lower()
                            sev_color = "#ef4444" if sev in ("critical", "high") else ("#f59e0b" if sev == "warning" else "#3b82f6")

                            lat = alert_data.get('latitude')
                            lon = alert_data.get('longitude')
                            addr = alert_data.get('address') or (alert_data.get('alert_metadata') or {}).get('address')
                            loc_html = ""
                            if addr:
                                loc_html = f"""<tr>
                                    <td style="padding:5px 0;color:#94a3b8;font-size:13px;">Location:</td>
                                    <td style="padding:5px 0;color:#ffffff;font-size:13px;text-align:right;font-weight:500;">{addr}</td>
                                </tr>"""
                            elif lat is not None and lon is not None:
                                map_url = f"https://www.google.com/maps?q={lat},{lon}"
                                loc_html = f"""<tr>
                                    <td style="padding:5px 0;color:#94a3b8;font-size:13px;">Location:</td>
                                    <td style="padding:5px 0;text-align:right;"><a href="{map_url}" target="_blank" style="color:#38bdf8;text-decoration:none;font-size:13px;font-family:monospace;font-weight:600;">{lat:.5f}, {lon:.5f} ↗</a></td>
                                </tr>"""

                            thresholds_html = ""
                            if thresholds:
                                th_rows = "".join([
                                    f"""<tr>
                                        <td style="padding:6px 0;color:#94a3b8;font-size:13px;border-bottom:1px solid #232d43;width:46%;">{k}</td>
                                        <td style="padding:6px 0;font-weight:600;color:#ffffff;font-size:13px;text-align:right;border-bottom:1px solid #232d43;">{v}</td>
                                    </tr>"""
                                    for k, v in thresholds
                                ])
                                thresholds_html = f"""
                                <div style="margin-top:16px;background:#151c2e;padding:14px 16px;border-radius:10px;border:1px solid #2a3447;">
                                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                                        <span>⚙️ Configured Thresholds & Rule Details</span>
                                    </div>
                                    <table style="width:100%;border-collapse:collapse;line-height:1.45;">
                                        <tbody>
                                            {th_rows}
                                        </tbody>
                                    </table>
                                </div>
                                """

                            body_html = f"""
                            <div style="font-family:'Outfit','Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:28px 24px;background:#131825;color:#e5e7eb;border-radius:16px;border:1px solid #2a3447;box-shadow:0 12px 30px rgba(0,0,0,0.5);">
                                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                                    <h2 style="color:#ffffff;margin:0;font-size:20px;font-weight:700;display:flex;align-items:center;gap:8px;">⚠️ Vehicle Alert</h2>
                                    <span style="background:{sev_color}22;color:{sev_color};border:1px solid {sev_color}55;font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;text-transform:uppercase;letter-spacing:0.04em;">{sev.upper()}</span>
                                </div>
                                <p style="color:#9ca3af;font-size:14px;line-height:1.5;margin-top:0;">Hello <strong style="color:#ffffff;">{user.username}</strong>,</p>
                                <div style="background:#1e273e;padding:13px 16px;border-left:4px solid {sev_color};border-radius:6px;margin:14px 0 16px;font-size:14px;font-weight:500;color:#ffffff;line-height:1.5;">
                                    {alert_data['message']}
                                </div>
                                <div style="background:#1a2035;padding:14px 16px;border-radius:10px;border:1px solid #2a3447;font-size:13px;color:#cbd5e1;line-height:1.6;">
                                    <table style="width:100%;border-collapse:collapse;">
                                        <tbody>
                                            <tr>
                                                <td style="padding:4px 0;color:#94a3b8;width:40%;">Vehicle:</td>
                                                <td style="padding:4px 0;font-weight:600;color:#ffffff;text-align:right;">{device.name}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:4px 0;color:#94a3b8;">Alert Rule:</td>
                                                <td style="padding:4px 0;font-weight:600;color:#ffffff;text-align:right;">{alert_label}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:4px 0;color:#94a3b8;">Severity:</td>
                                                <td style="padding:4px 0;font-weight:600;color:{sev_color};text-align:right;">{sev.capitalize()}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:4px 0;color:#94a3b8;">Triggered At:</td>
                                                <td style="padding:4px 0;color:#cbd5e1;text-align:right;">{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</td>
                                            </tr>
                                            {loc_html}
                                        </tbody>
                                    </table>
                                </div>
                                {thresholds_html}
                                <p style="color:#6b7280;font-size:12px;margin-bottom:0;margin-top:22px;border-top:1px solid #1f2738;padding-top:14px;">Routario GPS Telematics Platform</p>
                            </div>
                            """
                            ok = await send_email_async([user_email.strip()], subject, body, body_html)
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
                    channel_status.append({"name": "VoIP Call", "status": "skipped", "error": "No phone number configured for user profile"})
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
                            channel_status.append({"name": "VoIP Call", "status": "skipped", "error": "VoIP calling is disabled in System Settings"})
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
