"""
Plugin Management Routes
Superadmin management for plugins, repositories, and hot-loading extensions.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from pydantic import BaseModel

from core.audit import write_audit_log
from core.auth import require_admin
from core.plugins.installer import (
    install_plugin_by_id,
    install_plugin_from_url,
    install_plugin_from_zip,
    uninstall_plugin,
)
from core.plugins.manager import get_plugin_manager
from core.plugins.models import (
    PluginInfo,
    PluginInstallRequest,
    PluginManifest,
    PluginUsageSummary,
    RepositoryConfig,
    RepositoryCreateRequest,
)
from core.plugins.repositories import (
    add_repository,
    fetch_aggregated_catalog,
    get_configured_repositories,
    remove_repository,
)
from models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class TogglePluginRequest(BaseModel):
    enabled: bool


@router.get("/installed", response_model=List[PluginInfo])
async def list_installed_plugins(
    current_user: User = Depends(require_admin),
):
    """List all locally installed plugins with live database usage and update info."""
    mgr = get_plugin_manager()
    return await mgr.get_all_installed_with_usage()


@router.get("/{plugin_id}/usage", response_model=PluginUsageSummary)
async def get_plugin_usage(
    plugin_id: str,
    current_user: User = Depends(require_admin),
):
    """Retrieve detailed usage metrics for a specific installed plugin."""
    mgr = get_plugin_manager()
    plugin_info = mgr.loaded_plugins.get(plugin_id)
    if not plugin_info:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")
    return await mgr.get_plugin_usage(plugin_info)


@router.post("/{plugin_id}/toggle", response_model=PluginInfo)
async def toggle_plugin(
    plugin_id: str,
    body: TogglePluginRequest,
    request: Request,
    current_user: User = Depends(require_admin),
):
    """Enable or disable a plugin live without server restart."""
    mgr = get_plugin_manager()
    try:
        plugin_info = await mgr.toggle_plugin(plugin_id, body.enabled)
        action = "plugin.enabled" if body.enabled else "plugin.disabled"
        await write_audit_log(
            action,
            actor=current_user,
            target_type="plugin",
            target_id=plugin_id,
            request=request,
            metadata={"enabled": body.enabled, "name": plugin_info.manifest.name},
        )
        return plugin_info
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to toggle plugin '%s': %s", plugin_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error toggling plugin: {e}")


@router.post("/install", response_model=PluginInfo)
async def install_plugin(
    body: PluginInstallRequest,
    request: Request,
    current_user: User = Depends(require_admin),
):
    """Install a plugin from repository by plugin_id or direct download_url."""
    try:
        if body.download_url:
            plugin_info = await install_plugin_from_url(body.download_url)
        elif body.plugin_id:
            plugin_info = await install_plugin_by_id(body.plugin_id)
        else:
            raise HTTPException(status_code=400, detail="Must provide plugin_id or download_url")

        await write_audit_log(
            "plugin.installed",
            actor=current_user,
            target_type="plugin",
            target_id=plugin_info.id,
            request=request,
            metadata={"name": plugin_info.manifest.name, "version": plugin_info.manifest.version},
        )
        return plugin_info
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Plugin installation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Plugin installation failed: {e}")


@router.post("/upload", response_model=PluginInfo)
async def upload_plugin_zip(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(require_admin),
):
    """Upload and install a plugin from a .zip archive."""
    if not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a .zip archive")

    try:
        contents = await file.read()
        plugin_info = await install_plugin_from_zip(contents)
        await write_audit_log(
            "plugin.uploaded",
            actor=current_user,
            target_type="plugin",
            target_id=plugin_info.id,
            request=request,
            metadata={"filename": file.filename, "name": plugin_info.manifest.name},
        )
        return plugin_info
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Plugin upload installation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Plugin upload failed: {e}")


@router.post("/{plugin_id}/uninstall")
async def delete_plugin(
    plugin_id: str,
    request: Request,
    current_user: User = Depends(require_admin),
):
    """Uninstall and remove a plugin from disk."""
    mgr = get_plugin_manager()
    plugin_info = mgr.loaded_plugins.get(plugin_id)
    if not plugin_info:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found")

    try:
        await uninstall_plugin(plugin_id)
        await write_audit_log(
            "plugin.uninstalled",
            actor=current_user,
            target_type="plugin",
            target_id=plugin_id,
            request=request,
            metadata={"name": plugin_info.manifest.name},
        )
        return {"status": "uninstalled", "plugin_id": plugin_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to uninstall plugin '%s': %s", plugin_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to uninstall plugin: {e}")


@router.get("/catalog", response_model=List[PluginManifest])
async def get_plugin_catalog(
    current_user: User = Depends(require_admin),
):
    """Fetch merged plugin store catalog from all configured active repositories."""
    try:
        return await fetch_aggregated_catalog()
    except Exception as e:
        logger.error("Failed to fetch plugin catalog: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to fetch catalog: {e}")


@router.get("/repositories", response_model=List[RepositoryConfig])
async def list_repositories(
    current_user: User = Depends(require_admin),
):
    """List all configured plugin repository sources."""
    return await get_configured_repositories()


@router.post("/repositories", response_model=RepositoryConfig, status_code=status.HTTP_201_CREATED)
async def add_plugin_repository(
    body: RepositoryCreateRequest,
    request: Request,
    current_user: User = Depends(require_admin),
):
    """Add a new plugin repository (validates manifest.json immediately and errors if unreachable)."""
    try:
        repo = await add_repository(url=body.url, subfolder=body.subfolder, name=body.name)
        await write_audit_log(
            "plugin_repository.added",
            actor=current_user,
            target_type="plugin_repository",
            target_id=repo.id,
            request=request,
            metadata={"name": repo.name, "url": repo.url, "manifest_url": repo.manifest_url},
        )
        return repo
    except ValueError as e:
        # Returns clear user-facing error message (e.g. Manifest not found or Invalid JSON)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to add repository: %s", e)
        raise HTTPException(status_code=500, detail=f"Error validating repository: {e}")


@router.delete("/repositories/{repo_id}")
async def delete_plugin_repository(
    repo_id: str,
    request: Request,
    current_user: User = Depends(require_admin),
):
    """Remove a configured plugin repository."""
    success = await remove_repository(repo_id)
    if not success:
        raise HTTPException(status_code=404, detail="Repository not found")

    await write_audit_log(
        "plugin_repository.deleted",
        actor=current_user,
        target_type="plugin_repository",
        target_id=repo_id,
        request=request,
    )
    return {"status": "deleted", "repo_id": repo_id}
