"""
Backup & Restore Routes
Pure SQLAlchemy backup — works with PostgreSQL, MySQL, and SQLite.
"""
import io
import json
import os
import tarfile
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import inspect, text

from core.auth import require_admin
from core.database import get_db
from models import User

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])


async def _dump_database() -> bytes:
    """
    Export every table to a JSON-lines file (one JSON object per row).
    Works with any SQLAlchemy-supported database.
    """
    db = get_db()
    output: dict = {}

    async with db.engine.connect() as conn:
        # Reflect table names
        table_names = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_table_names()
        )
        for table in table_names:
            result = await conn.execute(text(f'SELECT * FROM "{table}"'))
            rows = result.mappings().all()
            output[table] = [dict(row) for row in rows]

    def _serialise(obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, (bytes, bytearray)):
            return obj.hex()
        raise TypeError(f"Not serialisable: {type(obj)}")

    return json.dumps(output, default=_serialise, indent=2).encode("utf-8")


async def _restore_database(data: bytes) -> None:
    """
    Restore tables from the JSON dump produced by _dump_database.
    Existing rows are cleared before inserting.
    """
    import logging
    logger = logging.getLogger(__name__)

    payload: dict = json.loads(data.decode("utf-8"))
    db = get_db()

    async with db.engine.begin() as conn:
        # Disable FK checks where possible (SQLite / MySQL)
        try:
            await conn.execute(text("PRAGMA foreign_keys = OFF"))   # SQLite
        except Exception:
            pass
        try:
            await conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))  # MySQL
        except Exception:
            pass

        for table, rows in payload.items():
            try:
                await conn.execute(text(f'DELETE FROM "{table}"'))
            except Exception as exc:
                logger.warning("Could not clear table %s: %s", table, exc)
                continue

            for row in rows:
                if not row:
                    continue
                cols   = ", ".join(f'"{c}"' for c in row.keys())
                params = ", ".join(f":{c}" for c in row.keys())
                try:
                    await conn.execute(
                        text(f'INSERT INTO "{table}" ({cols}) VALUES ({params})'),
                        row,
                    )
                except Exception as exc:
                    logger.warning("Insert failed in %s: %s", table, exc)

        # Re-enable FK checks
        try:
            await conn.execute(text("PRAGMA foreign_keys = ON"))
        except Exception:
            pass
        try:
            await conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        except Exception:
            pass


async def _build_backup_bytes() -> bytes:
    sql_bytes = await _dump_database()

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        db_info      = tarfile.TarInfo(name="db.json")
        db_info.size = len(sql_bytes)
        tar.addfile(db_info, io.BytesIO(sql_bytes))

        if os.path.isdir("web/uploads"):
            tar.add("web/uploads", arcname="uploads")

        manifest = json.dumps({
            "created_at": datetime.utcnow().isoformat(),
            "version":    "2.0",
            "format":     "json",
        }).encode()
        mf_info      = tarfile.TarInfo(name="manifest.json")
        mf_info.size = len(manifest)
        tar.addfile(mf_info, io.BytesIO(manifest))

    return buf.getvalue()


@router.get("/download")
async def download_backup(admin: User = Depends(require_admin)):
    try:
        archive = await _build_backup_bytes()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    filename = f"routario_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.tar.gz"
    return StreamingResponse(
        io.BytesIO(archive),
        media_type="application/gzip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
):
    contents = await file.read()
    buf = io.BytesIO(contents)

    try:
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            try:
                mf      = tar.extractfile("manifest.json")
                manifest = json.loads(mf.read())
            except Exception:
                raise HTTPException(400, "Invalid backup — missing manifest.json")

            # Support both old (db.sql) and new (db.json) formats
            db_member_name = "db.json" if "db.json" in tar.getnames() else "db.sql"
            db_member = tar.extractfile(db_member_name)
            if not db_member:
                raise HTTPException(400, "Invalid backup — missing database dump")
            db_data = db_member.read()

            await _restore_database(db_data)

            for member in tar.getmembers():
                if member.name.startswith("uploads/"):
                    member.name = "web/" + member.name
                    tar.extract(member, path=".", filter="data")

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Restore failed: {exc}")

    return {
        "status":     "restored",
        "created_at": manifest.get("created_at"),
    }
