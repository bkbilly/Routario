"""
Backup & Restore Routes
Admin-only endpoints to export and import platform data.
"""
import io
import json
import os
import subprocess
import tarfile
from datetime import datetime
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from core.auth import require_admin
from core.config import get_settings
from models import User

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])


def _parse_db_url(database_url: str) -> dict:
    """Robustly parse any postgresql+asyncpg:// URL into pg_dump args."""
    url = database_url.replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlparse(url)
    return {
        "host":     parsed.hostname or "localhost",
        "port":     str(parsed.port or 5432),
        "user":     parsed.username or "postgres",
        "password": parsed.password or "",
        "dbname":   parsed.path.lstrip("/").split("?")[0],  # strip ?ssl etc.
    }


def _run_pg_dump(params: dict) -> bytes:
    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]
    result = subprocess.run(
        [
            "pg_dump",
            "-U", params["user"],
            "-h", params["host"],
            "-p", params["port"],
            params["dbname"],
        ],
        capture_output=True,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pg_dump failed: {result.stderr.decode()}")
    return result.stdout


def _build_backup_bytes() -> bytes:
    """Build the full tar.gz archive in memory and return as bytes."""
    settings = get_settings()
    params   = _parse_db_url(settings.database_url)

    sql_bytes = _run_pg_dump(params)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:

        # ── Database dump ──────────────────────────────────────────────
        sql_info      = tarfile.TarInfo(name="db.sql")
        sql_info.size = len(sql_bytes)
        tar.addfile(sql_info, io.BytesIO(sql_bytes))

        # ── Uploads folder ─────────────────────────────────────────────
        uploads_path = "web/uploads"
        if os.path.isdir(uploads_path):
            tar.add(uploads_path, arcname="uploads")

        # ── Manifest ───────────────────────────────────────────────────
        manifest = json.dumps({
            "created_at": datetime.utcnow().isoformat(),
            "version":    "1.0",
            "db_name":    params["dbname"],
        }).encode()
        mf_info      = tarfile.TarInfo(name="manifest.json")
        mf_info.size = len(manifest)
        tar.addfile(mf_info, io.BytesIO(manifest))

    return buf.getvalue()


@router.get("/download")
async def download_backup(admin: User = Depends(require_admin)):
    """Stream a .tar.gz containing the DB dump + uploads. Admin only."""
    try:
        archive_bytes = _build_backup_bytes()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    filename = f"routario_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.tar.gz"

    return StreamingResponse(
        io.BytesIO(archive_bytes),
        media_type="application/gzip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    """Restore DB + uploads from a .tar.gz backup. Admin only. Overwrites all data."""
    settings = get_settings()
    params   = _parse_db_url(settings.database_url)

    contents = await file.read()
    buf      = io.BytesIO(contents)

    try:
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:

            # ── Validate manifest ──────────────────────────────────────
            try:
                mf       = tar.extractfile("manifest.json")
                manifest = json.loads(mf.read())
            except Exception:
                raise HTTPException(400, "Invalid backup file — missing manifest")

            # ── Restore database ───────────────────────────────────────
            sql_data = tar.extractfile("db.sql").read()

            env = os.environ.copy()
            env["PGPASSWORD"] = params["password"]

            base_args = ["-U", params["user"], "-h", params["host"], "-p", params["port"]]

            subprocess.run(
                ["psql", *base_args, "-d", "postgres",
                 "-c", f"DROP DATABASE IF EXISTS {params['dbname']};"],
                env=env, check=True, capture_output=True,
            )
            subprocess.run(
                ["psql", *base_args, "-d", "postgres",
                 "-c", f"CREATE DATABASE {params['dbname']};"],
                env=env, check=True, capture_output=True,
            )
            result = subprocess.run(
                ["psql", *base_args, params["dbname"]],
                input=sql_data, env=env, capture_output=True,
            )
            if result.returncode != 0:
                raise HTTPException(500, f"DB restore failed: {result.stderr.decode()}")

            # ── Restore uploads ────────────────────────────────────────
            for member in tar.getmembers():
                if member.name.startswith("uploads/"):
                    member.name = "web/" + member.name
                    tar.extract(member, path=".", filter="data")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Restore failed: {str(e)}")

    return {
        "status":     "restored",
        "created_at": manifest.get("created_at"),
        "db_name":    manifest.get("db_name"),
    }
