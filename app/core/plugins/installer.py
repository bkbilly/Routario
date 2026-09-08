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
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import httpx

from core.plugins.manager import get_plugin_manager
from core.plugins.models import PluginInfo, PluginManifest
from core.plugins.repositories import fetch_aggregated_catalog

logger = logging.getLogger(__name__)


def _parse_github_url(url: str) -> Optional[Tuple[str, str, str, str]]:
    """Extracts (owner, repo, branch, folder_path) from a GitHub web tree or raw URL."""
    # 1. https://github.com/owner/repo/tree/branch/path
    m1 = re.match(r"^https?://github\.com/([^/]+)/([^/]+)/tree/([^/]+)(?:/(.*))?$", url, re.IGNORECASE)
    if m1:
        owner, repo, branch, path = m1.groups()
        return owner, repo, branch, (path or "").strip("/")

    # 2. https://raw.githubusercontent.com/owner/repo/branch/path
    m2 = re.match(r"^https?://raw\.githubusercontent\.com/([^/]+)/([^/]+)/([^/]+)(?:/(.*))?$", url, re.IGNORECASE)
    if m2:
        owner, repo, branch, path = m2.groups()
        return owner, repo, branch, (path or "").strip("/")

    return None


def _is_safe_path(base_dir: Path, path: Path) -> bool:
    """Ensure path is contained within base_dir (prevent zip slip / traversal)."""
    try:
        base_dir.resolve()
        path.resolve().relative_to(base_dir.resolve())
        return True
    except (ValueError, RuntimeError):
        return False


async def install_plugin_from_directory(source_dir: Path) -> PluginInfo:
    """Installs and hot-loads a plugin from a local source directory."""
    mgr = get_plugin_manager()
    manifest_file = None
    for cand in ("plugin.json", "manifest.json"):
        if (source_dir / cand).is_file():
            manifest_file = source_dir / cand
            break

    if not manifest_file:
        raise ValueError(f"Directory '{source_dir}' is missing 'plugin.json' manifest.")

    try:
        manifest_data = json.loads(manifest_file.read_text(encoding="utf-8"))
        manifest = PluginManifest(**manifest_data)
        plugin_id = manifest.id or source_dir.name
    except Exception as e:
        raise ValueError(f"Failed to parse plugin manifest in '{source_dir}': {e}")

    target_dir = mgr.plugins_dir / plugin_id
    if source_dir.resolve() != target_dir.resolve():
        if target_dir.exists():
            await mgr.unload_plugin(plugin_id)
            shutil.rmtree(target_dir, ignore_errors=True)
        target_dir.mkdir(parents=True, exist_ok=True)
        for item in source_dir.rglob("*"):
            if item.is_file() and not item.name.endswith(".pyc") and "__pycache__" not in item.parts:
                rel = item.relative_to(source_dir)
                dest = target_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, dest)

    plugin_info = PluginInfo(
        id=plugin_id,
        manifest=manifest,
        path=str(target_dir.resolve()),
        enabled=True,
        is_loaded=False,
        requires_restart=manifest.requires_restart,
        installed_at=datetime.now(timezone.utc).isoformat(),
    )

    loaded = await mgr.load_plugin(plugin_info)
    if not loaded:
        logger.warning("Plugin '%s' installed but hot-load reported an issue: %s", plugin_id, plugin_info.load_error)

    mgr.loaded_plugins[plugin_id] = plugin_info

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
        await mgr.unload_plugin(plugin_id)
        shutil.rmtree(target_dir, ignore_errors=True)

    target_dir.mkdir(parents=True, exist_ok=True)

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

    loaded = await mgr.load_plugin(plugin_info)
    if not loaded:
        logger.warning("Plugin '%s' installed but hot-load reported an issue: %s", plugin_id, plugin_info.load_error)

    mgr.loaded_plugins[plugin_id] = plugin_info

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


async def install_plugin_from_url(
    download_url: str, files: Optional[List[str]] = None, plugin_id: Optional[str] = None
) -> PluginInfo:
    """
    Installs a plugin from a URL (supports raw files, GitHub folder trees, local directories, or ZIP archives).
    """
    if not download_url:
        raise ValueError("Download URL cannot be empty")

    mgr = get_plugin_manager()
    logger.info("Installing plugin from URL / path: %s", download_url)

    # 1. Local path check (if not HTTP/HTTPS URL)
    if not download_url.startswith(("http://", "https://")):
        local_cand = Path(download_url)
        for base in [Path("plugins"), Path("plugins/examples"), Path(".")]:
            p = base / download_url.strip("/")
            if p.is_dir() and ((p / "plugin.json").is_file() or (p / "manifest.json").is_file()):
                return await install_plugin_from_directory(p)
        if local_cand.is_dir() and ((local_cand / "plugin.json").is_file() or (local_cand / "manifest.json").is_file()):
            return await install_plugin_from_directory(local_cand)

    # 2. Local fallback if URL points to Routario repo
    if "bkbilly/Routario" in download_url:
        folder_name = Path(download_url.rstrip("/")).name
        for cand_dir in [
            mgr.plugins_dir / "examples" / folder_name,
            mgr.plugins_dir / folder_name,
            Path("plugins") / "examples" / folder_name,
            Path("plugins") / folder_name,
        ]:
            if cand_dir.is_dir() and ((cand_dir / "plugin.json").is_file() or (cand_dir / "manifest.json").is_file()):
                return await install_plugin_from_directory(cand_dir)

    # 3. If URL is a direct ZIP file
    if download_url.lower().endswith(".zip"):
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                resp = await client.get(download_url)
                if resp.status_code == 200:
                    return await install_plugin_from_zip(resp.content)
        except Exception as e:
            raise ValueError(f"Could not download ZIP archive from '{download_url}': {e}")

    # 4. GitHub Tree URL or Raw URL -> Download raw folder files
    gh_info = _parse_github_url(download_url)

    # Normalize github tree URL: https://github.com/owner/repo/tree/branch/path
    raw_base = download_url
    if "github.com" in download_url and "/tree/" in download_url:
        raw_base = download_url.replace("github.com", "raw.githubusercontent.com").replace("/tree/", "/")

    raw_base = raw_base.rstrip("/")
    downloaded_files: Dict[str, bytes] = {}

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, headers={"User-Agent": "Routario-Plugin-Manager"}) as client:
        # A. Try GitHub Contents API if this is a GitHub repository folder
        if gh_info:
            owner, repo_name, branch, gh_path = gh_info
            api_url = f"https://api.github.com/repos/{owner}/{repo_name}/contents/{gh_path}?ref={branch}"
            try:
                api_resp = await client.get(api_url)
                if api_resp.status_code == 200:
                    items = api_resp.json()
                    if isinstance(items, list):
                        for item in items:
                            if item.get("type") == "file" and item.get("download_url"):
                                fname = item.get("name")
                                if fname and not fname.startswith("."):
                                    fresp = await client.get(item["download_url"])
                                    if fresp.status_code == 200:
                                        downloaded_files[fname] = fresp.content
            except Exception as e:
                logger.debug("GitHub Contents API fetch failed/skipped: %s", e)

        # B. If not fetched via API, fetch plugin.json and discover standard files
        if "plugin.json" not in downloaded_files:
            manifest_url = f"{raw_base}/plugin.json"
            try:
                resp = await client.get(manifest_url)
                if resp.status_code == 200:
                    downloaded_files["plugin.json"] = resp.content
                else:
                    raise ValueError(f"Failed to fetch plugin.json from '{manifest_url}' (HTTP {resp.status_code})")
            except Exception as e:
                raise ValueError(f"Could not connect to '{manifest_url}': {e}")

            # Read optional extra files from plugin.json
            files_to_fetch = list(files or [])
            try:
                pdata = json.loads(downloaded_files["plugin.json"].decode("utf-8"))
                for ef in pdata.get("files", []):
                    if ef not in files_to_fetch:
                        files_to_fetch.append(ef)
            except Exception:
                pass

            candidate_files = set(files_to_fetch + [
                "protocols.py", "alerts.py", "reports.py", "integrations.py", "main.py", "routes.py", "__init__.py"
            ])

            for fname in candidate_files:
                if fname in downloaded_files:
                    continue
                furl = f"{raw_base}/{fname}"
                try:
                    fresp = await client.get(furl)
                    if fresp.status_code == 200:
                        downloaded_files[fname] = fresp.content
                except Exception:
                    pass

    if "plugin.json" not in downloaded_files:
        raise ValueError(f"Could not retrieve plugin.json from '{raw_base}'")

    manifest_data = json.loads(downloaded_files["plugin.json"].decode("utf-8"))
    manifest = PluginManifest(**manifest_data)
    target_id = plugin_id or manifest.id or folder_name

    target_dir = mgr.plugins_dir / target_id
    if target_dir.exists():
        await mgr.unload_plugin(target_id)
        shutil.rmtree(target_dir, ignore_errors=True)

    target_dir.mkdir(parents=True, exist_ok=True)
    for fname, content in downloaded_files.items():
        dest = target_dir / fname
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)

    plugin_info = PluginInfo(
        id=target_id,
        manifest=manifest,
        path=str(target_dir.resolve()),
        enabled=True,
        is_loaded=False,
        requires_restart=manifest.requires_restart,
        installed_at=datetime.now(timezone.utc).isoformat(),
    )

    loaded = await mgr.load_plugin(plugin_info)
    if not loaded:
        logger.warning("Plugin '%s' installed but hot-load reported an issue: %s", target_id, plugin_info.load_error)

    mgr.loaded_plugins[target_id] = plugin_info

    stored_states = await mgr._get_stored_states()
    stored_states[target_id] = {
        "enabled": True,
        "installed_at": plugin_info.installed_at,
    }
    await mgr._save_stored_states(stored_states)

    try:
        from core.gateway import sync_active_protocol_servers
        await sync_active_protocol_servers()
    except Exception:
        pass

    logger.info("Plugin '%s' installed and activated successfully", target_id)
    return plugin_info


async def install_plugin_by_id(plugin_id: str) -> PluginInfo:
    """Finds a plugin by ID in the aggregated repository catalog and installs it."""
    catalog = await fetch_aggregated_catalog()
    target = next((p for p in catalog if p.id == plugin_id), None)
    if not target:
        raise ValueError(f"Plugin '{plugin_id}' not found in any configured repository catalog.")

    if not target.download_url:
        raise ValueError(f"Plugin '{plugin_id}' has no download_url in repository manifest.")

    return await install_plugin_from_url(
        target.download_url, files=getattr(target, "files", None), plugin_id=plugin_id
    )


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
