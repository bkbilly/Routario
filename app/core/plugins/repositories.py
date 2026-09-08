"""
Plugin Repository Manager
Handles repository validation, GitHub subfolder resolution, and catalog aggregation.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy import select, update

from core.database import get_db
from core.plugins.models import PluginManifest, RepositoryConfig
from models import SystemSetting

logger = logging.getLogger(__name__)

DEFAULT_OFFICIAL_REPO_URL = "https://raw.githubusercontent.com/bkbilly/Routario/main/plugins/manifest.json"
DEFAULT_OFFICIAL_REPO_NAME = "Routario Official Repository"
SETTING_KEY_REPOSITORIES = "plugin_repositories"


def normalize_manifest_url(base_url: str, subfolder: Optional[str] = None) -> str:
    """
    Normalizes a repository or raw URL into a direct manifest.json fetch URL.
    Handles standard URLs, raw URLs, and GitHub tree/blob subfolder URLs.
    
    Examples:
      - https://github.com/user/repo -> https://raw.githubusercontent.com/user/repo/main/manifest.json
      - https://github.com/user/repo/tree/main/subfolder -> https://raw.githubusercontent.com/user/repo/main/subfolder/manifest.json
      - https://raw.githubusercontent.com/user/repo/main/subfolder -> https://raw.githubusercontent.com/user/repo/main/subfolder/manifest.json
      - https://example.com/plugins -> https://example.com/plugins/manifest.json
    """
    url = (base_url or "").strip()
    if not url:
        raise ValueError("Repository URL cannot be empty")

    sub = (subfolder or "").strip().strip("/")

    # Handle GitHub web URLs: https://github.com/owner/repo/tree/branch/subfolder
    github_tree_match = re.match(
        r"^https?://github\.com/([^/]+)/([^/]+)/tree/([^/]+)(?:/(.*))?$", url, re.IGNORECASE
    )
    if github_tree_match:
        owner, repo, branch, path = github_tree_match.groups()
        full_path = "/".join(filter(None, [path, sub]))
        if not full_path.endswith(".json"):
            full_path = f"{full_path}/manifest.json" if full_path else "manifest.json"
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{full_path.lstrip('/')}"

    # Handle GitHub blob URLs: https://github.com/owner/repo/blob/branch/path/manifest.json
    github_blob_match = re.match(
        r"^https?://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.*)$", url, re.IGNORECASE
    )
    if github_blob_match:
        owner, repo, branch, path = github_blob_match.groups()
        return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"

    # Handle standard GitHub repo root: https://github.com/owner/repo
    github_repo_match = re.match(
        r"^https?://github\.com/([^/]+)/([^/]+)/?$", url, re.IGNORECASE
    )
    if github_repo_match:
        owner, repo = github_repo_match.groups()
        repo = repo.rstrip("/")
        full_path = f"{sub}/manifest.json" if sub else "manifest.json"
        return f"https://raw.githubusercontent.com/{owner}/{repo}/main/{full_path.lstrip('/')}"

    # Standard raw or custom HTTP URL
    if sub:
        url = url.rstrip("/") + "/" + sub

    if not url.lower().endswith(".json"):
        url = url.rstrip("/") + "/manifest.json"

    return url


async def validate_and_fetch_manifest(
    url: str, subfolder: Optional[str] = None
) -> Tuple[Dict[str, Any], str, str]:
    """
    Validates a repository URL by fetching its manifest.json.
    Raises ValueError with a descriptive error message if not found or invalid.
    Returns (manifest_data, normalized_manifest_url, repo_name).
    """
    manifest_url = normalize_manifest_url(url, subfolder)

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(manifest_url)
            if resp.status_code == 404:
                # Check local fallback if official repository hasn't been pushed upstream yet
                local_fallback = Path("plugins/manifest.json")
                if (manifest_url == DEFAULT_OFFICIAL_REPO_URL or "bkbilly/Routario" in manifest_url) and local_fallback.is_file():
                    try:
                        data = json.loads(local_fallback.read_text(encoding="utf-8"))
                        repo_name = data.get("name") or DEFAULT_OFFICIAL_REPO_NAME
                        return data, manifest_url, repo_name
                    except Exception:
                        pass
                raise ValueError(
                    f"Manifest file not found at '{manifest_url}'. Please ensure manifest.json exists in this repository or subfolder."
                )
            elif resp.status_code != 200:
                # Check local fallback on other HTTP errors
                local_fallback = Path("plugins/manifest.json")
                if (manifest_url == DEFAULT_OFFICIAL_REPO_URL or "bkbilly/Routario" in manifest_url) and local_fallback.is_file():
                    try:
                        data = json.loads(local_fallback.read_text(encoding="utf-8"))
                        repo_name = data.get("name") or DEFAULT_OFFICIAL_REPO_NAME
                        return data, manifest_url, repo_name
                    except Exception:
                        pass
                raise ValueError(
                    f"Failed to fetch manifest from '{manifest_url}' (HTTP {resp.status_code}: {resp.reason_phrase})"
                )

            try:
                data = resp.json()
            except Exception as e:
                raise ValueError(
                    f"Invalid JSON returned from '{manifest_url}': {e}"
                )

    except httpx.RequestError as exc:
        local_fallback = Path("plugins/manifest.json")
        if (manifest_url == DEFAULT_OFFICIAL_REPO_URL or "bkbilly/Routario" in manifest_url) and local_fallback.is_file():
            try:
                data = json.loads(local_fallback.read_text(encoding="utf-8"))
                repo_name = data.get("name") or DEFAULT_OFFICIAL_REPO_NAME
                return data, manifest_url, repo_name
            except Exception:
                pass
        raise ValueError(f"Could not connect to repository at '{manifest_url}': {exc}")

    # Validate structure
    if isinstance(data, list):
        data = {"name": "Custom Repository", "plugins": data}
    elif not isinstance(data, dict):
        raise ValueError(
            f"Invalid manifest structure at '{manifest_url}'. Must be a JSON object containing a 'plugins' array."
        )

    plugins = data.get("plugins")
    if plugins is None or not isinstance(plugins, list):
        raise ValueError(
            f"Invalid manifest structure at '{manifest_url}': missing 'plugins' list."
        )

    repo_name = data.get("name") or "Custom Plugin Repository"
    return data, manifest_url, repo_name


async def get_configured_repositories() -> List[RepositoryConfig]:
    """Load all configured repositories from DB (or initialize with defaults)."""
    raw_json = None

    try:
        db = get_db()
        async with db.get_session() as session:
            result = await session.execute(
                select(SystemSetting).where(SystemSetting.key == SETTING_KEY_REPOSITORIES)
            )
            record = result.scalar_one_or_none()
            if record and record.value:
                raw_json = record.value
    except Exception as e:
        logger.warning("Could not load repositories from system_settings: %s", e)

    if raw_json:
        try:
            items = json.loads(raw_json)
            if isinstance(items, list):
                return [RepositoryConfig(**item) for item in items if isinstance(item, dict)]
        except Exception as e:
            logger.error("Failed to parse plugin_repositories JSON: %s", e)

    return []


async def save_configured_repositories(repos: List[RepositoryConfig]) -> None:
    """Save repositories list to DB."""
    payload = json.dumps([r.model_dump() for r in repos])

    try:
        db = get_db()
        async with db.get_session() as session:
            result = await session.execute(
                select(SystemSetting).where(SystemSetting.key == SETTING_KEY_REPOSITORIES)
            )
            record = result.scalar_one_or_none()
            if record:
                record.value = payload
                record.updated_at = datetime.now(timezone.utc)
            else:
                new_record = SystemSetting(
                    key=SETTING_KEY_REPOSITORIES,
                    value=payload,
                    updated_at=datetime.now(timezone.utc),
                )
                session.add(new_record)
            await session.commit()
    except Exception as e:
        logger.error("Failed to save configured repositories: %s", e)


async def add_repository(
    url: str, subfolder: Optional[str] = None, name: Optional[str] = None
) -> RepositoryConfig:
    """Validate, fetch, and register a new repository URL."""
    manifest_data, manifest_url, detected_name = await validate_and_fetch_manifest(
        url, subfolder
    )

    repos = await get_configured_repositories()

    # Check for existing repository with the same manifest URL
    for r in repos:
        if r.manifest_url.lower() == manifest_url.lower():
            r.enabled = True
            r.name = name or detected_name or r.name
            r.last_synced_at = datetime.now(timezone.utc).isoformat()
            r.plugin_count = len(manifest_data.get("plugins", []))
            r.error = None
            await save_configured_repositories(repos)
            return r

    new_repo = RepositoryConfig(
        id=str(uuid.uuid4())[:8],
        name=name or detected_name or "Custom Repository",
        url=url,
        subfolder=subfolder,
        manifest_url=manifest_url,
        enabled=True,
        last_synced_at=datetime.now(timezone.utc).isoformat(),
        plugin_count=len(manifest_data.get("plugins", [])),
    )
    repos.append(new_repo)
    await save_configured_repositories(repos)
    return new_repo


async def remove_repository(repo_id: str) -> bool:
    """Remove a configured repository by ID."""
    repos = await get_configured_repositories()
    initial_count = len(repos)
    repos = [r for r in repos if r.id != repo_id]

    if len(repos) == initial_count:
        return False

    await save_configured_repositories(repos)
    return True


async def fetch_aggregated_catalog() -> List[PluginManifest]:
    """
    Queries all active repositories in parallel and returns the merged list of available plugins.
    """
    repos = await get_configured_repositories()
    active_repos = [r for r in repos if r.enabled]

    if not active_repos:
        return []

    async def _fetch_single_repo(repo: RepositoryConfig) -> List[PluginManifest]:
        try:
            data, _, _ = await validate_and_fetch_manifest(repo.url, repo.subfolder)
            plugins_raw = data.get("plugins", [])
            manifests = []
            for item in plugins_raw:
                if isinstance(item, dict) and item.get("id") and item.get("name"):
                    item["repository_name"] = repo.name
                    item["repository_url"] = repo.manifest_url
                    manifests.append(PluginManifest(**item))
            repo.plugin_count = len(manifests)
            repo.last_synced_at = datetime.now(timezone.utc).isoformat()
            repo.error = None
            return manifests
        except Exception as e:
            repo.error = str(e)
            logger.warning("Failed to fetch catalog from %s: %s", repo.manifest_url, e)
            return []

    results = await asyncio.gather(*[_fetch_single_repo(r) for r in active_repos], return_exceptions=True)

    catalog_by_id: Dict[str, PluginManifest] = {}
    for res in results:
        if isinstance(res, list):
            for p in res:
                # If plugin exists in multiple repos, keep highest version or first
                if p.id not in catalog_by_id:
                    catalog_by_id[p.id] = p

    # Update repo last synced info in background
    try:
        await save_configured_repositories(repos)
    except Exception:
        pass

    return list(catalog_by_id.values())
