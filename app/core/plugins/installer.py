"""
Plugin Installer
Handles ZIP archive validation, safe extraction, repository download, and uninstallation.
"""
from __future__ import annotations

import io
import json
import logging
import os
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

from core.plugins.manager import get_plugin_manager
from core.plugins.models import PluginInfo, PluginManifest
from core.plugins.repositories import fetch_aggregated_catalog

logger = logging.getLogger(__name__)


def _is_safe_path(base_dir: Path, path: Path) -> bool:
    """Ensure path is contained within base_dir (prevent zip slip)."""
    try:
        base_dir.resolve()
        path.resolve().relative_to(base_dir.resolve())
        return True
    except (ValueError, RuntimeError):
        return False


async def install_plugin_from_zip(zip_bytes: bytes) -> PluginInfo:
    """Extracts a ZIP archive into the plugins directory and hot-loads it."""
    mgr = get_plugin_manager()
    plugins_dir = mgr.plugins_dir

    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except Exception as e:
        raise ValueError(f"Invalid ZIP archive: {e}")

    # Search for manifest in ZIP
    manifest_info: Optional[zipfile.ZipInfo] = None
    for name in archive.namelist():
        basename = os.path.basename(name)
        if basename in ("plugin.json", "manifest.json"):
            manifest_info = archive.getinfo(name)
            break

    if not manifest_info:
        raise ValueError("Archive is missing 'plugin.json' or 'manifest.json' manifest file.")

    try:
        manifest_raw = archive.read(manifest_info).decode("utf-8")
        manifest_data = json.loads(manifest_raw)
        manifest = PluginManifest(**manifest_data)
        plugin_id = manifest.id
        if not plugin_id:
            raise ValueError("Manifest is missing 'id' field.")
    except Exception as e:
        raise ValueError(f"Failed to parse plugin manifest: {e}")

    # Target directory: plugins/<plugin_id>
    target_dir = plugins_dir / plugin_id
    if target_dir.exists():
        # Unload existing if loaded
        await mgr.unload_plugin(plugin_id)
        shutil.rmtree(target_dir, ignore_errors=True)

    target_dir.mkdir(parents=True, exist_ok=True)

    # Determine common prefix if zipped inside a folder
    manifest_parent = os.path.dirname(manifest_info.filename)

    for item in archive.infolist():
        if item.is_dir():
            continue

        filename = item.filename
        if manifest_parent and filename.startswith(manifest_parent + "/"):
            rel_name = filename[len(manifest_parent) + 1 :]
        elif manifest_parent and filename == manifest_parent:
            continue
        else:
            rel_name = filename

        if not rel_name or rel_name.startswith("__MACOSX") or rel_name.endswith(".DS_Store"):
            continue

        dest_file = target_dir / rel_name
        if not _is_safe_path(target_dir, dest_file):
            raise ValueError(f"Illegal path in ZIP archive: {filename}")

        dest_file.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(item) as src, open(dest_file, "wb") as dst:
            shutil.copyfileobj(src, dst)

    plugin_info = PluginInfo(
        id=plugin_id,
        manifest=manifest,
        path=str(target_dir.resolve()),
        enabled=True,
        is_loaded=False,
        requires_restart=manifest.requires_restart,
        installed_at=datetime.now(timezone.utc).isoformat(),
    )

    # Hot-load plugin
    loaded = await mgr.load_plugin(plugin_info)
    if not loaded:
        logger.warning("Plugin '%s' installed but hot-load reported an issue: %s", plugin_id, plugin_info.load_error)

    mgr.loaded_plugins[plugin_id] = plugin_info

    # Save state
    stored_states = await mgr._get_stored_states()
    stored_states[plugin_id] = {
        "enabled": True,
        "installed_at": plugin_info.installed_at,
    }
    await mgr._save_stored_states(stored_states)

    try:
        from core.gateway import sync_active_protocol_servers
        await sync_active_protocol_servers()
    except Exception:
        pass

    logger.info("Plugin '%s' installed and activated successfully", plugin_id)
    return plugin_info


async def install_plugin_from_url(download_url: str) -> PluginInfo:
    """Downloads a plugin ZIP archive from a URL and installs it."""
    if not download_url:
        raise ValueError("Download URL cannot be empty")

    logger.info("Downloading plugin from %s", download_url)
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(download_url)
            if resp.status_code != 200:
                raise ValueError(
                    f"Failed to download plugin archive (HTTP {resp.status_code}: {resp.reason_phrase})"
                )
            zip_bytes = resp.content
    except httpx.RequestError as exc:
        raise ValueError(f"Could not connect to download URL '{download_url}': {exc}")

    return await install_plugin_from_zip(zip_bytes)


async def install_plugin_by_id(plugin_id: str) -> PluginInfo:
    """Finds a plugin by ID in the aggregated repository catalog and installs it."""
    catalog = await fetch_aggregated_catalog()
    target = next((p for p in catalog if p.id == plugin_id), None)
    if not target:
        raise ValueError(f"Plugin '{plugin_id}' not found in any configured repository catalog.")

    if not target.download_url:
        raise ValueError(f"Plugin '{plugin_id}' has no download_url in repository manifest.")

    return await install_plugin_from_url(target.download_url)


async def uninstall_plugin(plugin_id: str) -> bool:
    """Unloads and completely removes an installed plugin from disk."""
    mgr = get_plugin_manager()
    plugin_info = mgr.loaded_plugins.get(plugin_id)
    if plugin_info:
        usage = await mgr.get_plugin_usage(plugin_info)
        if usage.in_use:
            raise ValueError(
                f"Cannot uninstall plugin '{plugin_info.manifest.name or plugin_id}' while it is currently in use: {usage.summary_text}. Please remove or reassign associated devices, alerts, or reports first."
            )

    # 1. Unload from registries
    await mgr.unload_plugin(plugin_id)

    # 2. Delete directory
    target_dir = Path(plugin_info.path) if plugin_info else (mgr.plugins_dir / plugin_id)
    if target_dir.exists():
        shutil.rmtree(target_dir, ignore_errors=True)

    # 3. Clean in-memory and stored state
    mgr.loaded_plugins.pop(plugin_id, None)
    stored_states = await mgr._get_stored_states()
    if plugin_id in stored_states:
        stored_states.pop(plugin_id, None)
        await mgr._save_stored_states(stored_states)

    try:
        from core.gateway import sync_active_protocol_servers
        await sync_active_protocol_servers()
    except Exception:
        pass

    logger.info("Plugin '%s' uninstalled successfully", plugin_id)
    return True
