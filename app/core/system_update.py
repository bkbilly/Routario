"""
core/system_update.py - Routario Platform System Update & Version Manager
Handles dynamic version detection, GitHub release update checking,
and web-triggered in-place updates & service restarts.
"""

import asyncio
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from time import monotonic
from typing import Any, Dict, List, Optional, Tuple

import httpx

from core.audit import write_audit_log

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_GITHUB_REPO = os.getenv("ROUTARIO_GITHUB_REPO", "bkbilly/Routario")

# In-memory cache for update check
_UPDATE_CACHE: Dict[str, Any] = {}
_LAST_CHECKED_MONOTONIC: float = 0.0
_CACHE_TTL_SECONDS: float = 1800.0  # 30 minutes

# Live update execution state
_UPDATE_LOCK = asyncio.Lock()
_UPDATE_STATE: Dict[str, Any] = {
    "status": "idle",        # idle, in_progress, restarting, success, failed
    "stage": "",             # fetching, checking_out, installing, restarting, complete
    "progress": 0,           # 0 to 100
    "target_version": "",
    "logs": [],
    "error": None,
    "started_at": None,
    "finished_at": None,
}


def _add_log(message: str) -> None:
    now_str = datetime.now(timezone.utc).strftime("%H:%M:%S")
    entry = f"[{now_str}] {message}"
    logger.info("[SystemUpdate] %s", message)
    _UPDATE_STATE["logs"].append(entry)
    if len(_UPDATE_STATE["logs"]) > 200:
        _UPDATE_STATE["logs"] = _UPDATE_STATE["logs"][-200:]


def parse_version_tuple(v: Optional[str]) -> Tuple[int, ...]:
    """Parse version string like '2026.10.0', 'v2026.8.1', '1.0.0' into a tuple of integers."""
    if not v:
        return (0, 0, 0)
    cleaned = v.strip().lstrip("v")
    # Take the portion before any dash/metadata (e.g. 2026.10.0-6-g96377a3 -> 2026.10.0)
    base = cleaned.split("-")[0]
    nums = re.findall(r"\d+", base)
    if not nums:
        return (0, 0, 0)
    return tuple(int(n) for n in nums)


def is_version_newer(candidate: Optional[str], current: Optional[str]) -> bool:
    """Return True if candidate version is strictly newer than current version."""
    c_tuple = parse_version_tuple(candidate)
    curr_tuple = parse_version_tuple(current)
    return c_tuple > curr_tuple


def get_git_commit() -> Optional[str]:
    """Return short git commit hash if available."""
    commit = os.getenv("GIT_COMMIT") or os.getenv("ROUTARIO_COMMIT")
    if commit:
        return commit.strip()
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=_PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=1,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


def get_app_version() -> str:
    """
    Resolve the running Routario version.
    1. Check ROUTARIO_VERSION or APP_VERSION env var.
    2. Try git describe --tags --abbrev=0 or --always.
    3. Fallback to default base version.
    """
    env_ver = os.getenv("ROUTARIO_VERSION") or os.getenv("APP_VERSION")
    if env_ver and env_ver.strip():
        return env_ver.strip().lstrip("v")

    git_dir = _PROJECT_ROOT / ".git"
    if git_dir.exists() and shutil.which("git"):
        try:
            # First try clean tag
            res = subprocess.run(
                ["git", "describe", "--tags", "--abbrev=0"],
                cwd=_PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
            if res.returncode == 0 and res.stdout.strip():
                return res.stdout.strip().lstrip("v")

            # Fallback to describe --always
            res2 = subprocess.run(
                ["git", "describe", "--tags", "--always"],
                cwd=_PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
            if res2.returncode == 0 and res2.stdout.strip():
                out = res2.stdout.strip().lstrip("v")
                match = re.search(r"(\d+\.\d+(?:\.\d+)?)", out)
                if match:
                    return match.group(1)
                return out
        except Exception:
            pass

    return "2026.10.0"


def get_version_details() -> Dict[str, Any]:
    """Return detailed version information including git commit, tag, and describe string."""
    version = get_app_version()
    commit = get_git_commit()
    git_describe = None
    git_branch = None

    if (_PROJECT_ROOT / ".git").exists() and shutil.which("git"):
        try:
            res = subprocess.run(
                ["git", "describe", "--tags", "--always"],
                cwd=_PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
            if res.returncode == 0:
                git_describe = res.stdout.strip()

            res_branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=_PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
            if res_branch.returncode == 0:
                git_branch = res_branch.stdout.strip()
        except Exception:
            pass

    return {
        "version": version,
        "commit": commit,
        "git_describe": git_describe or version,
        "git_branch": git_branch or "main",
    }


def get_deployment_info() -> Dict[str, Any]:
    """
    Detect running deployment environment (Git repo vs Docker vs standalone).
    """
    is_docker = (
        Path("/.dockerenv").exists()
        or bool(os.getenv("ROUTARIO_DOCKER"))
        or bool(os.getenv("DOCKER_CONTAINER"))
    )

    has_git = (_PROJECT_ROOT / ".git").is_dir() and shutil.which("git") is not None
    watchtower_url = os.getenv("WATCHTOWER_HTTP_URL") or os.getenv("WATCHTOWER_URL") or ""

    if has_git:
        mode = "git"
        can_auto_update = True
        desc = "Running from Git repository (live in-app update supported)"
    elif is_docker:
        mode = "docker"
        can_auto_update = bool(watchtower_url)
        desc = (
            "Running in Docker with Watchtower webhook"
            if can_auto_update
            else "Running in Docker container"
        )
    else:
        mode = "standalone"
        can_auto_update = False
        desc = "Standalone Python installation"

    return {
        "mode": mode,
        "is_docker": is_docker,
        "has_git": bool(has_git),
        "can_auto_update": can_auto_update,
        "description": desc,
        "watchtower_configured": bool(watchtower_url),
        "manual_command": "docker compose pull && docker compose up -d" if is_docker else "git pull && pip install -r requirements.txt",
    }


async def check_for_updates(force: bool = False) -> Dict[str, Any]:
    """
    Check GitHub Releases for newer releases.
    Results are cached for _CACHE_TTL_SECONDS unless force=True.
    """
    global _UPDATE_CACHE, _LAST_CHECKED_MONOTONIC

    current_ver = get_app_version()
    ver_details = get_version_details()
    dep_info = get_deployment_info()

    now_mono = monotonic()
    if not force and _UPDATE_CACHE and (now_mono - _LAST_CHECKED_MONOTONIC) < _CACHE_TTL_SECONDS:
        cached = dict(_UPDATE_CACHE)
        cached["cached"] = True
        return cached

    url = f"https://api.github.com/repos/{_GITHUB_REPO}/releases"
    headers = {
        "User-Agent": "Routario-Platform-Updater",
        "Accept": "application/vnd.github.v3+json",
    }
    github_token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    latest_tag = None
    release_name = None
    release_url = None
    release_body = ""
    published_at = None
    all_releases = []
    error = None

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                releases_data = resp.json()
                if isinstance(releases_data, list) and releases_data:
                    for rel in releases_data:
                        tag = rel.get("tag_name", "").lstrip("v")
                        if not rel.get("draft", False):
                            rel_item = {
                                "tag": tag,
                                "name": rel.get("name") or tag,
                                "html_url": rel.get("html_url"),
                                "published_at": rel.get("published_at"),
                                "prerelease": rel.get("prerelease", False),
                                "body": rel.get("body") or "",
                            }
                            all_releases.append(rel_item)
                            if latest_tag is None and not rel.get("prerelease", False):
                                latest_tag = tag
                                release_name = rel.get("name") or tag
                                release_url = rel.get("html_url")
                                release_body = rel.get("body") or ""
                                published_at = rel.get("published_at")

                    if latest_tag is None and all_releases:
                        first = all_releases[0]
                        latest_tag = first["tag"]
                        release_name = first["name"]
                        release_url = first["html_url"]
                        release_body = first["body"]
                        published_at = first["published_at"]
            elif resp.status_code == 403:
                error = "GitHub API rate limit exceeded. Please try again later."
            else:
                error = f"GitHub API returned HTTP {resp.status_code}"
    except Exception as exc:
        error = f"Failed to connect to GitHub: {str(exc)}"

    if not latest_tag:
        latest_tag = current_ver

    update_available = is_version_newer(latest_tag, current_ver)

    # In git mode, also check for remote commits ahead/behind
    commits_behind = 0
    if dep_info["has_git"]:
        try:
            # Check if origin/main has newer commits
            fetch_check = subprocess.run(
                ["git", "rev-list", "--count", "HEAD..origin/main"],
                cwd=_PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            if fetch_check.returncode == 0 and fetch_check.stdout.strip().isdigit():
                commits_behind = int(fetch_check.stdout.strip())
        except Exception:
            pass

    # Identify all newer releases between current_version and latest_version
    newer_releases = [
        rel for rel in all_releases
        if is_version_newer(rel["tag"], current_ver)
    ]

    # If no newer releases (e.g. up to date or dev build), provide the latest release
    display_releases = newer_releases if newer_releases else ([all_releases[0]] if all_releases else [])

    result = {
        "current_version": current_ver,
        "latest_version": latest_tag,
        "update_available": update_available or (commits_behind > 0),
        "has_newer_release": update_available,
        "commits_behind": commits_behind,
        "release_name": release_name or latest_tag,
        "release_url": release_url or f"https://github.com/{_GITHUB_REPO}/releases",
        "release_notes": release_body,
        "published_at": published_at,
        "newer_releases": display_releases,
        "newer_count": len(newer_releases),
        "available_releases": all_releases[:10],
        "deployment": dep_info,
        "version_details": ver_details,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "error": error,
        "cached": False,
    }

    _UPDATE_CACHE = result
    _LAST_CHECKED_MONOTONIC = now_mono
    return result


def get_update_status() -> Dict[str, Any]:
    """Return live execution state of the updater."""
    return dict(_UPDATE_STATE)


async def _run_command_async(cmd: List[str], cwd: Path) -> Tuple[int, str, str]:
    """Run an external command asynchronously and capture output."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode or 0, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")


async def _restart_server_task() -> None:
    """Gracefully restart the server process."""
    _add_log("Preparing process restart...")
    await asyncio.sleep(1.5)

    # 1. Try systemd service restart if systemd unit is present
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "is-active", "routario",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        if proc.returncode == 0 and "active" in out.decode():
            _add_log("Triggering systemctl restart routario...")
            await asyncio.create_subprocess_exec("systemctl", "restart", "routario")
            return
    except Exception:
        pass

    # 2. Standalone or Docker: Send SIGTERM to process group so supervisor / docker restarts it
    _add_log("Signaling process restart...")
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception as exc:
        _add_log(f"SIGTERM error: {exc}. Attempting execv fallback...")
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e2:
            _add_log(f"Restart failed: {e2}")


async def _perform_git_update(target_version: Optional[str]) -> None:
    """Execute update in git repository mode."""
    try:
        # Check for dirty working tree
        _UPDATE_STATE["stage"] = "checking_worktree"
        _UPDATE_STATE["progress"] = 10
        _add_log("Verifying working directory status...")

        code, stdout, stderr = await _run_command_async(["git", "status", "--porcelain"], _PROJECT_ROOT)
        if code != 0:
            raise RuntimeError(f"git status failed: {stderr.strip()}")

        # Filter out untracked files in uploads or sqlite database
        dirty_lines = [
            line for line in stdout.splitlines()
            if not line.strip().endswith(".db")
            and "uploads/" not in line
            and "routario.db" not in line
            and ".venv" not in line
        ]
        if any(line.startswith((" M", "M ", "D ", " D", "A ")) for line in dirty_lines):
            raise RuntimeError("Working directory has uncommitted local tracked modifications. Please commit or stash changes before updating.")

        # Stage 1: Fetch
        _UPDATE_STATE["stage"] = "fetching"
        _UPDATE_STATE["progress"] = 30
        _add_log("Fetching latest tags and commits from origin...")
        code, stdout, stderr = await _run_command_async(["git", "fetch", "--tags", "origin"], _PROJECT_ROOT)
        if code != 0:
            raise RuntimeError(f"git fetch failed: {stderr.strip() or stdout.strip()}")
        _add_log("Repository fetch completed successfully.")

        # Stage 2: Checkout / Pull
        _UPDATE_STATE["stage"] = "checking_out"
        _UPDATE_STATE["progress"] = 55

        if target_version and target_version != "latest":
            target_ref = target_version if target_version.startswith("refs/") else f"refs/tags/{target_version.lstrip('v')}"
            _add_log(f"Checking out target tag '{target_version}'...")
            code, stdout, stderr = await _run_command_async(["git", "checkout", target_version], _PROJECT_ROOT)
            if code != 0:
                _add_log(f"Tag checkout direct failed, trying ref '{target_ref}'...")
                code, stdout, stderr = await _run_command_async(["git", "checkout", target_ref], _PROJECT_ROOT)
                if code != 0:
                    raise RuntimeError(f"git checkout failed: {stderr.strip() or stdout.strip()}")
        else:
            # Pull main or checkout latest tag
            _add_log("Pulling latest commits from origin/main...")
            code, stdout, stderr = await _run_command_async(["git", "pull", "--ff-only", "origin", "main"], _PROJECT_ROOT)
            if code != 0:
                _add_log("Fast-forward pull failed, trying merge pull...")
                code, stdout, stderr = await _run_command_async(["git", "pull", "origin", "main"], _PROJECT_ROOT)
                if code != 0:
                    raise RuntimeError(f"git pull failed: {stderr.strip() or stdout.strip()}")

        _add_log("Codebase successfully updated to latest revision.")

        # Stage 3: Dependencies
        _UPDATE_STATE["stage"] = "installing_dependencies"
        _UPDATE_STATE["progress"] = 75
        req_file = _PROJECT_ROOT / "requirements.txt"
        if req_file.exists():
            _add_log("Updating python package dependencies (pip install)...")
            pip_cmd = [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]
            code, stdout, stderr = await _run_command_async(pip_cmd, _PROJECT_ROOT)
            if code != 0:
                _add_log(f"pip warning/error: {stderr.strip()}")
            else:
                _add_log("Dependencies successfully verified and updated.")

        # Stage 4: Restart
        _UPDATE_STATE["stage"] = "restarting"
        _UPDATE_STATE["progress"] = 90
        _UPDATE_STATE["status"] = "restarting"
        _add_log("Update applied! Restarting Routario server...")

        asyncio.create_task(_restart_server_task())

    except Exception as exc:
        logger.error("[SystemUpdate] Update failed: %s", exc, exc_info=True)
        _UPDATE_STATE["status"] = "failed"
        _UPDATE_STATE["error"] = str(exc)
        _add_log(f"ERROR: {str(exc)}")


async def _perform_watchtower_update() -> None:
    """Trigger Docker update via Watchtower HTTP webhook."""
    watchtower_url = os.getenv("WATCHTOWER_HTTP_URL") or os.getenv("WATCHTOWER_URL") or ""
    token = os.getenv("WATCHTOWER_TOKEN") or os.getenv("WATCHTOWER_HTTP_TOKEN") or ""

    if not watchtower_url:
        raise RuntimeError("WATCHTOWER_HTTP_URL is not configured.")

    _UPDATE_STATE["stage"] = "calling_watchtower"
    _UPDATE_STATE["progress"] = 50
    _add_log(f"Calling Watchtower update webhook at {watchtower_url}...")

    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    endpoint = watchtower_url.rstrip("/") + "/v1/update"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(endpoint, headers=headers)
        if resp.status_code not in (200, 204):
            raise RuntimeError(f"Watchtower webhook failed with status {resp.status_code}: {resp.text}")

    _UPDATE_STATE["stage"] = "restarting"
    _UPDATE_STATE["progress"] = 95
    _UPDATE_STATE["status"] = "restarting"
    _add_log("Watchtower successfully triggered. Container will be recreated.")


async def start_system_update(target_version: Optional[str] = None) -> Dict[str, Any]:
    """
    Initiate the update process in a background task.
    """
    async with _UPDATE_LOCK:
        if _UPDATE_STATE["status"] in ("in_progress", "restarting"):
            return {
                "ok": False,
                "error": "An update is already in progress.",
                "status": _UPDATE_STATE,
            }

        dep = get_deployment_info()
        if not dep["can_auto_update"]:
            return {
                "ok": False,
                "error": f"Automatic in-app update is not supported in this environment: {dep['description']}",
                "manual_command": dep["manual_command"],
                "status": _UPDATE_STATE,
            }

        _UPDATE_STATE["status"] = "in_progress"
        _UPDATE_STATE["stage"] = "starting"
        _UPDATE_STATE["progress"] = 5
        _UPDATE_STATE["target_version"] = target_version or "latest"
        _UPDATE_STATE["logs"] = []
        _UPDATE_STATE["error"] = None
        _UPDATE_STATE["started_at"] = datetime.now(timezone.utc).isoformat()
        _UPDATE_STATE["finished_at"] = None

        _add_log(f"Starting system update to {target_version or 'latest'} ({dep['mode']} mode)...")

        if dep["mode"] == "git":
            asyncio.create_task(_perform_git_update(target_version))
        elif dep["mode"] == "docker":
            asyncio.create_task(_perform_watchtower_update())

        return {
            "ok": True,
            "message": "System update initiated successfully.",
            "status": _UPDATE_STATE,
        }
