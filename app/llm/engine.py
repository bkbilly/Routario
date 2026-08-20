"""
app/llm/engine.py

Core execution engine for Routario LLM Copilot and AI Reports.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from llm.registry import LLMRegistry
from models import AlertHistory, Device, DeviceState, Driver, SystemSetting

logger = logging.getLogger(__name__)


SYSTEM_COPILOT_INSTRUCTION = """
You are Routario AI Copilot, an intelligent assistant embedded inside the Routario Telematics & Fleet Management Platform.
Your purpose is to answer fleet managers' and dispatchers' questions accurately, concisely, and professionally using the fleet telemetry context provided.

Guidelines:
1. Use markdown formatting (bullet points, bold text, code tags, tables).
2. Refer to vehicles by their Name or ID as provided in the context.
3. Examine all sections in the context: [Current Vehicle Status & Telemetry], [Recent Historical Telemetry & Sensor Time-Series Logs], [Recent Fleet Alert & Event Logs], and [Recent Vehicle Trips & Movements].
4. Analyze all sensor readings, voltage levels (e.g. `external_voltage`), battery statuses, speed, ignition, and historical timestamps.
5. Do NOT state that historical telemetry, voltage, or sensor data is unavailable if sensor attributes or time-series logs are listed in the prompt context.
6. Be helpful, direct, and actionable.
"""

SYSTEM_REPORT_INSTRUCTION = """
You are Routario AI Fleet Analytics Engine.
Generate a structured, professional Fleet Analysis Report in Markdown format based on the telemetry, alerts, and vehicle data provided.

Required Report Structure:
1. Executive Summary & Key Highlights
2. Tabular Data Summary (ALWAYS include a Markdown data table with column headers e.g. `| Vehicle | Driver | Metric / Event | Value | Status |`)
3. Detailed Analysis & Specific Observations
4. Operational Recommendations

Ensure tables use valid Markdown table syntax (`| Header 1 | Header 2 |`) so the platform can automatically convert them into exportable CSV/PDF report tables.
"""


async def get_llm_settings(session) -> tuple[bool, str, dict[str, Any]]:
    """Returns (enabled, active_provider, provider_config)."""
    keys = ["llm_enabled", "llm_active_provider", "llm_gemini_api_key", "llm_gemini_model", "llm_temperature"]
    stmt = select(SystemSetting).where(SystemSetting.key.in_(keys))
    res = await session.execute(stmt)
    db_settings = {row.key: row.value for row in res.scalars().all()}

    enabled_val = db_settings.get("llm_enabled", "false")
    enabled = str(enabled_val).lower() in ("true", "1", "yes", "on")

    active_provider = db_settings.get("llm_active_provider", "gemini")

    provider_config = {
        "api_key": db_settings.get("llm_gemini_api_key", ""),
        "model_name": db_settings.get("llm_gemini_model", "gemini-1.5-flash"),
        "temperature": db_settings.get("llm_temperature", 0.2),
    }

    return enabled, str(active_provider), provider_config


async def build_fleet_context(session, user: Any, max_devices: int = 50) -> str:
    """Build a rich text summary of the user's accessible fleet, alert history, trips, and position time-series logs for the LLM prompt."""
    from reports.common import accessible_devices
    from models import PositionRecord, Trip

    base_devices = await accessible_devices(session, user)
    if not base_devices:
        return "No vehicles accessible in fleet."

    dev_ids = [d.id for d in base_devices]

    stmt = (
        select(Device)
        .where(Device.id.in_(dev_ids))
        .options(
            selectinload(Device.state).selectinload(DeviceState.current_driver)
        )
    )
    res = await session.execute(stmt)
    devices = res.scalars().all()

    device_map = {d.id: d.name for d in devices}

    # Fetch recent alert history logs
    stmt_alerts = (
        select(AlertHistory)
        .where(AlertHistory.device_id.in_(dev_ids))
        .order_by(AlertHistory.created_at.desc())
        .limit(30)
    )
    res_alerts = await session.execute(stmt_alerts)
    recent_alerts = res_alerts.scalars().all()

    # Fetch recent trip records
    stmt_trips = (
        select(Trip)
        .where(Trip.device_id.in_(dev_ids))
        .order_by(Trip.start_time.desc())
        .limit(20)
    )
    res_trips = await session.execute(stmt_trips)
    recent_trips = res_trips.scalars().all()

    # Fetch recent historical position & sensor time-series logs (per vehicle)
    stmt_positions = (
        select(PositionRecord)
        .where(PositionRecord.device_id.in_(dev_ids))
        .order_by(PositionRecord.device_time.desc())
        .limit(100)
    )
    res_positions = await session.execute(stmt_positions)
    all_positions = res_positions.scalars().all()

    # Group positions by device_id
    pos_by_device = {}
    for p in all_positions:
        pos_by_device.setdefault(p.device_id, []).append(p)

    lines = [
        "=== ROUTARIO FLEET TELEMETRY & EVENT LOG CONTEXT ===",
        f"Total Accessible Vehicles: {len(devices)}",
        "\n[Current Vehicle Status & Telemetry]"
    ]

    for d in devices[:max_devices]:
        state_info = "Unknown"
        driver_info = "Unassigned"
        if d.state:
            st = d.state
            status_str = "Online" if st.is_online else "Offline"
            speed_val = getattr(st, "last_speed", None)
            speed_str = f"{speed_val:.1f} km/h" if speed_val is not None else "0 km/h"
            ignition_str = "ON" if st.ignition_on else "OFF"
            state_info = f"Status: {status_str}, Speed: {speed_str}, Ignition: {ignition_str}, Odometer: {st.total_odometer:.1f} km"
            if st.current_driver:
                driver_info = st.current_driver.name

        # Include custom attributes & live sensors (e.g. external_voltage, battery, sensors)
        sensor_details = {}
        if d.custom_attributes and isinstance(d.custom_attributes, dict):
            sensor_details.update(d.custom_attributes)

        if d.state and d.state.sensors and isinstance(d.state.sensors, dict):
            sensor_details.update(d.state.sensors)

        attr_str = ""
        if sensor_details:
            formatted_attrs = [f"{k}: {v}" for k, v in sensor_details.items() if v is not None and v != ""]
            if formatted_attrs:
                attr_str = f" | Sensors/Attributes: [{', '.join(formatted_attrs)}]"

        v_type = getattr(d, "vehicle_type", None) or "vehicle"
        plate_str = f" | Plate: '{d.license_plate}'" if getattr(d, "license_plate", None) else ""
        lines.append(
            f"- Vehicle ID #{d.id} | Name: '{d.name}'{plate_str} | Type: '{v_type}' | "
            f"Driver: '{driver_info}' | Telemetry: ({state_info}){attr_str}"
        )

    lines.append("\n[Recent Historical Telemetry & Sensor Time-Series Logs]")
    has_time_series = False
    for d in devices[:max_devices]:
        dev_positions = pos_by_device.get(d.id, [])
        if dev_positions:
            has_time_series = True
            for p in dev_positions[:10]:
                p_ts = p.device_time.strftime("%Y-%m-%d %H:%M:%S") if p.device_time else "N/A"
                ign = "ON" if p.ignition else "OFF"
                sp = f"{p.speed:.1f} km/h" if p.speed is not None else "0 km/h"

                sens_items = []
                if p.sensors and isinstance(p.sensors, dict):
                    for sk, sv in p.sensors.items():
                        if sv is not None and sv != "":
                            sens_items.append(f"{sk}: {sv}")

                # Also pull external_voltage if present on device custom attributes
                if d.custom_attributes and isinstance(d.custom_attributes, dict):
                    for attr_k, attr_v in d.custom_attributes.items():
                        if "voltage" in attr_k.lower() and attr_k not in [x.split(":")[0] for x in sens_items]:
                            sens_items.append(f"{attr_k}: {attr_v}")

                sens_str = f" | Sensors: [{', '.join(sens_items)}]" if sens_items else ""
                lines.append(
                    f"- [{p_ts}] Vehicle: '{d.name}' (ID #{d.id}) | Speed: {sp} | Ignition: {ign}{sens_str}"
                )

    if not has_time_series:
        lines.append("No historical position logs recorded.")

    if recent_alerts:
        lines.append("\n[Recent Fleet Alert & Event Logs]")
        for a in recent_alerts:
            dev_name = device_map.get(a.device_id, f"Device #{a.device_id}")
            ts_str = a.created_at.strftime("%Y-%m-%d %H:%M:%S") if a.created_at else "N/A"
            sev = (a.severity or "info").upper()
            lines.append(
                f"- [{ts_str}] [{sev}] Vehicle: '{dev_name}' | Type: '{a.alert_type}' | Event: {a.message}"
            )
    else:
        lines.append("\n[Recent Fleet Alert & Event Logs]\nNo recent alerts logged.")

    if recent_trips:
        lines.append("\n[Recent Vehicle Trips & Movements]")
        for t in recent_trips:
            dev_name = device_map.get(t.device_id, f"Device #{t.device_id}")
            t_start = t.start_time.strftime("%Y-%m-%d %H:%M") if t.start_time else "N/A"
            t_end = t.end_time.strftime("%Y-%m-%d %H:%M") if t.end_time else "Ongoing"
            lines.append(
                f"- Trip #{t.id} | Vehicle: '{dev_name}' | Time: {t_start} to {t_end} | "
                f"Distance: {t.distance_km:.1f} km | Max Speed: {t.max_speed:.1f} km/h | Duration: {t.duration_minutes:.0f} mins"
            )

    return "\n".join(lines)


async def execute_llm_chat(session, user: Any, prompt: str, history: Optional[list] = None) -> str:
    """Process a Copilot chat query."""
    enabled, active_provider_id, config = await get_llm_settings(session)
    if not enabled:
        raise RuntimeError("AI Assistant is currently disabled in System Settings.")

    provider = LLMRegistry.get(active_provider_id)
    if not provider:
        raise RuntimeError(f"Configured LLM Provider '{active_provider_id}' is not registered.")

    fleet_ctx = await build_fleet_context(session, user)

    full_prompt = f"""
[Current Fleet State]
{fleet_ctx}

[User Query]
{prompt}
"""
    return await provider.generate_response(
        prompt=full_prompt,
        system_instruction=SYSTEM_COPILOT_INSTRUCTION,
        config=config,
    )


async def execute_llm_report(
    session,
    user: Any,
    prompt: str,
    device_ids: Optional[list[int]] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> str:
    """Generate a custom AI Fleet Report."""
    enabled, active_provider_id, config = await get_llm_settings(session)
    if not enabled:
        raise RuntimeError("AI Assistant is currently disabled in System Settings.")

    provider = LLMRegistry.get(active_provider_id)
    if not provider:
        raise RuntimeError(f"Configured LLM Provider '{active_provider_id}' is not registered.")

    fleet_ctx = await build_fleet_context(session, user)

    report_prompt = f"""
[Report Parameters]
User Custom Request: {prompt}
Time Range: {start_time or 'All Time'} to {end_time or 'Present'}
Specified Device IDs: {device_ids or 'Entire Fleet'}

[Fleet Telemetry Context]
{fleet_ctx}

Please generate the structured AI Fleet Analysis Report.
"""
    return await provider.generate_response(
        prompt=report_prompt,
        system_instruction=SYSTEM_REPORT_INSTRUCTION,
        config=config,
    )
