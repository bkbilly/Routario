"""
Plugin Core Manager
Discovers, dynamically hot-loads/unloads plugins, tracks live usage, and installs dependencies.
"""
from __future__ import annotations

import asyncio
import importlib
import importlib.util
import inspect
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from alerts import (
    ALERT_REGISTRY,
    register_alert_class,
    unregister_alert_class,
)
from alerts.base import BaseAlert
from core.database import get_db
from core.plugins.models import (
    PluginComponents,
    PluginInfo,
    PluginManifest,
    PluginUsageAlertRule,
    PluginUsageDevice,
    PluginUsageIntegration,
    PluginUsageReport,
    PluginUsageSummary,
)
from core.plugins.repositories import fetch_aggregated_catalog
from integrations.base import BaseIntegration
from integrations.integration_model import IntegrationAccount
from integrations.registry import IntegrationRegistry
from models import Device, ScheduledReport, SystemSetting, User
from protocols import BaseProtocolDecoder, ProtocolRegistry
from reports import REPORT_REGISTRY, register_report, unregister_report
from reports.base import Report

logger = logging.getLogger(__name__)

SETTING_KEY_PLUGIN_STATES = "plugin_states"
DEFAULT_PLUGINS_DIR = Path("plugins")


class PluginManager:
    """Singleton manager for Routario plugins."""

    def __init__(self, plugins_dir: Optional[Path] = None):
        self.plugins_dir = plugins_dir or DEFAULT_PLUGINS_DIR
        self.plugins_dir.mkdir(parents=True, exist_ok=True)
        self.loaded_plugins: Dict[str, PluginInfo] = {}
        # plugin_id -> {"protocols": set(), "alerts": set(), "reports": set(), "integrations": set(), "modules": set()}
        self._registered_components: Dict[str, Dict[str, Set[str]]] = {}
        self._app_instance = None

    def set_app(self, app):
        """Set FastAPI app reference for dynamic router mounting."""
        self._app_instance = app

    async def _get_stored_states(self) -> Dict[str, Dict[str, Any]]:
        """Load plugin states (enabled/disabled, installed_at) from system_settings."""
        try:
            db = get_db()
            async with db.get_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == SETTING_KEY_PLUGIN_STATES)
                )
                record = result.scalar_one_or_none()
                if record and record.value:
                    return json.loads(record.value)
        except Exception as e:
            logger.warning("Could not read plugin states from database: %s", e)
        return {}

    async def _save_stored_states(self, states: Dict[str, Dict[str, Any]]) -> None:
        """Persist plugin states to system_settings."""
        payload = json.dumps(states)
        try:
            db = get_db()
            async with db.get_session() as session:
                result = await session.execute(
                    select(SystemSetting).where(SystemSetting.key == SETTING_KEY_PLUGIN_STATES)
                )
                record = result.scalar_one_or_none()
                if record:
                    record.value = payload
                    record.updated_at = datetime.now(timezone.utc)
                else:
                    session.add(
                        SystemSetting(
                            key=SETTING_KEY_PLUGIN_STATES,
                            value=payload,
                            updated_at=datetime.now(timezone.utc),
                        )
                    )
                await session.commit()
        except Exception as e:
            logger.error("Failed to save plugin states: %s", e)

    async def install_dependencies(self, dependencies: List[str]) -> bool:
        """Check and install missing pip dependencies asynchronously."""
        if not dependencies:
            return True

        missing = []
        for dep in dependencies:
            pkg_name = dep.split("==")[0].split(">=")[0].split("<=")[0].split("~=")[0].strip()
            # Test if package is importable
            try:
                importlib.import_module(pkg_name.replace("-", "_"))
            except ImportError:
                missing.append(dep)

        if not missing:
            return True

        logger.info("Installing missing plugin dependencies: %s", missing)
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "pip",
                "install",
                "--no-cache-dir",
                *missing,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                logger.error("Failed to install plugin dependencies: %s", stderr.decode())
                return False
            logger.info("Successfully installed plugin dependencies: %s", missing)
            return True
        except Exception as e:
            logger.error("Error running pip install: %s", e)
            return False

    async def discover_and_load_all(self, app=None) -> Dict[str, PluginInfo]:
        """Scans plugins_dir and hot-loads all enabled plugins."""
        if app:
            self._app_instance = app

        stored_states = await self._get_stored_states()
        discovered: Dict[str, PluginInfo] = {}

        if not self.plugins_dir.is_dir():
            return {}

        for entry in self.plugins_dir.iterdir():
            if not entry.is_dir() or entry.name.startswith((".", "_")) or entry.name in ("examples", "zips", "__pycache__", ".git"):
                continue

            manifest_file = None
            for candidate in ("plugin.json", "manifest.json"):
                p = entry / candidate
                if p.is_file():
                    manifest_file = p
                    break

            if not manifest_file:
                continue

            try:
                manifest_data = json.loads(manifest_file.read_text(encoding="utf-8"))
                manifest = PluginManifest(**manifest_data)
                plugin_id = manifest.id or entry.name

                state_info = stored_states.get(plugin_id, {})
                enabled = state_info.get("enabled", True)
                installed_at = state_info.get("installed_at", datetime.now(timezone.utc).isoformat())

                plugin_info = PluginInfo(
                    id=plugin_id,
                    manifest=manifest,
                    path=str(entry.resolve()),
                    enabled=enabled,
                    is_loaded=False,
                    requires_restart=manifest.requires_restart,
                    installed_at=installed_at,
                )

                if enabled:
                    await self.load_plugin(plugin_info)
                else:
                    plugin_info.is_loaded = False

                discovered[plugin_id] = plugin_info

            except Exception as e:
                logger.error("Failed to load plugin manifest in '%s': %s", entry.name, e, exc_info=True)

        self.loaded_plugins = discovered

        # Trigger protocol server sync in gateway
        try:
            from core.gateway import sync_active_protocol_servers
            await sync_active_protocol_servers()
        except Exception:
            pass

        return self.loaded_plugins

    async def load_plugin(self, plugin_info: PluginInfo) -> bool:
        """Dynamically hot-loads a single plugin and registers all its components."""
        plugin_dir = Path(plugin_info.path)
        manifest = plugin_info.manifest
        plugin_id = plugin_info.id

        # 1. Install missing dependencies if needed
        if manifest.dependencies:
            deps_ok = await self.install_dependencies(manifest.dependencies)
            if not deps_ok:
                plugin_info.load_error = "Failed to install required Python dependencies"
                plugin_info.is_loaded = False
                return False

        # 2. Add plugin directory to sys.path so intra-plugin imports work
        resolved_path = str(plugin_dir.resolve())
        if resolved_path not in sys.path:
            sys.path.insert(0, resolved_path)

        reg_entry = self._registered_components.setdefault(
            plugin_id,
            {"protocols": set(), "alerts": set(), "reports": set(), "integrations": set(), "modules": set()},
        )

        components = PluginComponents()

        try:
            # 3. Find python files to import
            py_files = sorted(plugin_dir.glob("*.py"))
            for py_file in py_files:
                if py_file.name.startswith("."):
                    continue

                mod_name = f"routario_plugin_{plugin_id}_{py_file.stem}"
                spec = importlib.util.spec_from_file_location(mod_name, str(py_file))
                if not spec or not spec.loader:
                    continue

                mod = importlib.util.module_from_spec(spec)
                sys.modules[mod_name] = mod
                reg_entry["modules"].add(mod_name)
                spec.loader.exec_module(mod)

                # Inspect module for components
                for name, obj in inspect.getmembers(mod):
                    # A. Protocols
                    if inspect.isclass(obj) and issubclass(obj, BaseProtocolDecoder) and obj is not BaseProtocolDecoder:
                        # Check if registered in ProtocolRegistry
                        for p_name, p_inst in ProtocolRegistry.get_all().items():
                            if isinstance(p_inst, obj):
                                components.protocols.append(p_name)
                                reg_entry["protocols"].add(p_name)

                    # B. Alerts
                    if inspect.isclass(obj) and issubclass(obj, BaseAlert) and obj is not BaseAlert:
                        try:
                            key = register_alert_class(obj)
                            components.alerts.append(key)
                            reg_entry["alerts"].add(key)
                        except Exception as exc:
                            logger.warning("Could not register alert class %s: %s", name, exc)

                    # C. Reports
                    if isinstance(obj, Report):
                        try:
                            key = register_report(obj)
                            components.reports.append(key)
                            reg_entry["reports"].add(key)
                        except Exception as exc:
                            logger.warning("Could not register report %s: %s", name, exc)
                    elif inspect.isclass(obj) and issubclass(obj, Report) and obj is not Report:
                        try:
                            instance = obj()
                            key = register_report(instance)
                            components.reports.append(key)
                            reg_entry["reports"].add(key)
                        except Exception as exc:
                            logger.warning("Could not instantiate and register report class %s: %s", name, exc)

                    # D. Integrations
                    if inspect.isclass(obj) and issubclass(obj, BaseIntegration) and obj is not BaseIntegration:
                        provider_id = getattr(obj, "PROVIDER_ID", None)
                        if provider_id:
                            IntegrationRegistry.register(provider_id)(obj)
                            components.integrations.append(provider_id)
                            reg_entry["integrations"].add(provider_id)

                    # E. FastAPI Router
                    if hasattr(obj, "routes") and hasattr(obj, "tags") and self._app_instance:
                        try:
                            self._app_instance.include_router(obj)
                            logger.info("Mounted router from plugin '%s'", plugin_id)
                        except Exception as exc:
                            logger.debug("Could not mount router from plugin %s: %s", plugin_id, exc)

            # Deduplicate components
            components.protocols = list(set(components.protocols))
            components.alerts = list(set(components.alerts))
            components.reports = list(set(components.reports))
            components.integrations = list(set(components.integrations))

            plugin_info.components = components
            plugin_info.is_loaded = True
            plugin_info.load_error = None
            logger.info(
                "Successfully loaded plugin '%s' (Protocols: %s, Alerts: %s, Reports: %s, Integrations: %s)",
                plugin_id,
                components.protocols,
                components.alerts,
                components.reports,
                components.integrations,
            )
            return True

        except Exception as e:
            plugin_info.is_loaded = False
            plugin_info.load_error = str(e)
            logger.error("Failed to load plugin '%s': %s", plugin_id, e, exc_info=True)
            return False

    async def unload_plugin(self, plugin_id: str) -> None:
        """Dynamically unregisters all components associated with a plugin."""
        reg_entry = self._registered_components.pop(plugin_id, None)
        if not reg_entry:
            return

        # 1. Unregister protocols
        for p in reg_entry.get("protocols", set()):
            ProtocolRegistry.unregister(p)

        # 2. Unregister alerts
        for a in reg_entry.get("alerts", set()):
            unregister_alert_class(a)

        # 3. Unregister reports
        for r in reg_entry.get("reports", set()):
            unregister_report(r)

        # 4. Unregister integrations
        for i in reg_entry.get("integrations", set()):
            IntegrationRegistry.unregister(i)

        # 5. Clean sys.modules
        for mod_name in reg_entry.get("modules", set()):
            sys.modules.pop(mod_name, None)

        if plugin_id in self.loaded_plugins:
            self.loaded_plugins[plugin_id].is_loaded = False
            self.loaded_plugins[plugin_id].components = PluginComponents()

        try:
            from core.gateway import sync_active_protocol_servers
            await sync_active_protocol_servers()
        except Exception:
            pass

        logger.info("Unloaded plugin '%s'", plugin_id)

    async def toggle_plugin(self, plugin_id: str, enable: bool) -> PluginInfo:
        """Enable or disable an installed plugin live without server restart."""
        plugin_info = self.loaded_plugins.get(plugin_id)
        if not plugin_info:
            # Re-discover in case it was installed externally
            await self.discover_and_load_all()
            plugin_info = self.loaded_plugins.get(plugin_id)
            if not plugin_info:
                raise ValueError(f"Plugin '{plugin_id}' is not installed")

        stored_states = await self._get_stored_states()
        state_data = stored_states.setdefault(plugin_id, {})
        state_data["enabled"] = enable

        if enable:
            plugin_info.enabled = True
            await self.load_plugin(plugin_info)
        else:
            usage = await self.get_plugin_usage(plugin_info)
            if usage.in_use:
                raise ValueError(
                    f"Cannot disable plugin '{plugin_info.manifest.name or plugin_id}' while it is currently in use: {usage.summary_text}. Please remove or reassign associated devices, alerts, or reports first."
                )
            plugin_info.enabled = False
            await self.unload_plugin(plugin_id)

        await self._save_stored_states(stored_states)

        try:
            from core.gateway import sync_active_protocol_servers
            await sync_active_protocol_servers()
        except Exception:
            pass

        return plugin_info

    async def get_plugin_usage(self, plugin_info: PluginInfo) -> PluginUsageSummary:
        """
        Calculates real-time usage for a plugin by inspecting database records.
        Identifies devices, alert rules, reports, users, and companies using it.
        """
        summary = PluginUsageSummary()
        components = plugin_info.components

        try:
            db = get_db()
            async with db.get_session() as session:
                # 1. Protocols Usage
                if components.protocols:
                    res = await session.execute(
                        select(Device)
                        .options(selectinload(Device.users), selectinload(Device.company))
                        .where(Device.protocol.in_(components.protocols))
                    )
                    devices = res.scalars().all()
                    for dev in devices:
                        user_names = [u.username for u in (dev.users or [])]
                        company_name = dev.company.name if dev.company else None
                        summary.devices.append(
                            PluginUsageDevice(
                                id=dev.id,
                                name=dev.name,
                                imei=dev.imei,
                                protocol=dev.protocol,
                                company_id=dev.company_id,
                                company_name=company_name,
                                user_names=user_names,
                            )
                        )
                    summary.total_devices += len(devices)

                # 2. Alerts Usage
                if components.alerts:
                    # Scan all devices' alert_rows
                    res = await session.execute(
                        select(Device).options(selectinload(Device.users), selectinload(Device.company))
                    )
                    all_devices = res.scalars().all()
                    for dev in all_devices:
                        rows = (dev.config or {}).get("alert_rows", [])
                        for row in rows:
                            if isinstance(row, dict) and row.get("alertKey") in components.alerts:
                                user_names = [u.username for u in (dev.users or [])]
                                company_name = dev.company.name if dev.company else None
                                summary.alert_rules.append(
                                    PluginUsageAlertRule(
                                        device_id=dev.id,
                                        device_name=dev.name,
                                        alert_key=row.get("alertKey"),
                                        company_name=company_name,
                                        user_names=user_names,
                                        params=row.get("params", {}),
                                    )
                                )
                                summary.total_alerts += 1

                # 3. Reports Usage
                if components.reports:
                    res = await session.execute(
                        select(ScheduledReport).where(
                            ScheduledReport.report_type.in_(components.reports)
                        )
                    )
                    schedules = res.scalars().all()
                    for sch in schedules:
                        user = await session.get(User, sch.user_id) if sch.user_id else None
                        summary.report_schedules.append(
                            PluginUsageReport(
                                schedule_id=sch.id,
                                schedule_name=sch.name,
                                report_type=sch.report_type,
                                user_id=sch.user_id,
                                user_name=user.username if user else None,
                            )
                        )
                    summary.total_reports += len(schedules)

                # 4. Integrations Usage
                if components.integrations:
                    res = await session.execute(
                        select(IntegrationAccount).where(
                            IntegrationAccount.provider_id.in_(components.integrations)
                        )
                    )
                    accounts = res.scalars().all()
                    for acc in accounts:
                        user = await session.get(User, acc.user_id) if acc.user_id else None
                        # Find devices using this integration account
                        dev_res = await session.execute(
                            select(Device).where(Device.protocol == acc.provider_id)
                        )
                        linked_devs = len(dev_res.scalars().all())
                        summary.integrations.append(
                            PluginUsageIntegration(
                                account_id=acc.id,
                                account_label=acc.account_label,
                                provider_id=acc.provider_id,
                                user_name=user.username if user else None,
                                device_count=linked_devs,
                            )
                        )
                    summary.total_integrations += len(accounts)

        except Exception as e:
            logger.error("Error calculating plugin usage for '%s': %s", plugin_info.id, e)

        # Build readable summary string
        usage_parts = []
        if summary.total_devices > 0:
            usage_parts.append(f"{summary.total_devices} {'device' if summary.total_devices == 1 else 'devices'}")
        if summary.total_alerts > 0:
            usage_parts.append(f"{summary.total_alerts} {'alert rule' if summary.total_alerts == 1 else 'alert rules'}")
        if summary.total_reports > 0:
            usage_parts.append(f"{summary.total_reports} {'scheduled report' if summary.total_reports == 1 else 'scheduled reports'}")
        if summary.total_integrations > 0:
            usage_parts.append(f"{summary.total_integrations} {'integration account' if summary.total_integrations == 1 else 'integration accounts'}")

        if usage_parts:
            summary.summary_text = f"In use by {', '.join(usage_parts)}"
            summary.in_use = True
        else:
            summary.summary_text = "Not in use"
            summary.in_use = False

        return summary

    async def get_all_installed_with_usage(self) -> List[PluginInfo]:
        """Returns all installed plugins with live usage metrics and repository update status."""
        catalog = []
        try:
            catalog = await fetch_aggregated_catalog()
        except Exception:
            pass

        catalog_by_id = {p.id: p for p in catalog}

        result = []
        for plugin_info in self.loaded_plugins.values():
            # Refresh usage stats
            plugin_info.usage = await self.get_plugin_usage(plugin_info)

            # Check update availability
            latest = catalog_by_id.get(plugin_info.id)
            if latest and latest.version and latest.version != plugin_info.manifest.version:
                plugin_info.update_available = latest.version
                plugin_info.latest_manifest = latest
            else:
                plugin_info.update_available = None
                plugin_info.latest_manifest = None

            result.append(plugin_info)

        return sorted(result, key=lambda p: p.manifest.name.casefold())


# Global singleton instance
_plugin_manager: Optional[PluginManager] = None


def get_plugin_manager() -> PluginManager:
    global _plugin_manager
    if _plugin_manager is None:
        _plugin_manager = PluginManager()
    return _plugin_manager


async def load_all_plugins(app=None) -> Dict[str, PluginInfo]:
    """Helper for app startup lifespan."""
    mgr = get_plugin_manager()
    return await mgr.discover_and_load_all(app)
