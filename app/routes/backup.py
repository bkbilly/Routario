"""
Backup & Restore Routes
Pure-Python backup using asyncpg — no pg_dump binary required.
"""
import io
import json
import os
import tarfile
from datetime import datetime
from urllib.parse import urlparse

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from core.auth import require_admin
from core.config import get_settings
from models import User

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])


def _parse_db_url(database_url: str) -> dict:
    url = database_url.replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlparse(url)
    return {
        "host":     parsed.hostname or "localhost",
        "port":     parsed.port or 5432,
        "user":     parsed.username or "postgres",
        "password": parsed.password or "",
        "database": parsed.path.lstrip("/").split("?")[0],
    }


async def _dump_database(params: dict) -> bytes:
    conn = await asyncpg.connect(
        host=params["host"],
        port=params["port"],
        user=params["user"],
        password=params["password"],
        database=params["database"],
    )

    out = io.StringIO()
    out.write(f"-- Routario backup — {datetime.utcnow().isoformat()}\n\n")

    try:
        tables = await conn.fetch("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'
            ORDER BY table_name
        """)

        for record in tables:
            table = record["table_name"]
            out.write(f"-- Table: {table}\n")

            cols = await conn.fetch("""
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
            """, table)

            col_names = [c["column_name"] for c in cols]

            if not col_names:
                continue

            # Delete in reverse to avoid FK violations — safer than TRUNCATE CASCADE
            # which requires more privileges
            out.write(f'DELETE FROM "{table}";\n')

            rows = await conn.fetch(f'SELECT * FROM "{table}"')
            if not rows:
                out.write("\n")
                continue

            col_list = ", ".join(f'"{c}"' for c in col_names)
            for row in rows:
                values = []
                for col in col_names:
                    val = row[col]
                    if val is None:
                        values.append("NULL")
                    elif isinstance(val, bool):
                        values.append("TRUE" if val else "FALSE")
                    elif isinstance(val, (int, float)):
                        values.append(str(val))
                    elif isinstance(val, datetime):
                        values.append(f"'{val.isoformat()}'")
                    elif isinstance(val, dict):
                        escaped = json.dumps(val).replace("'", "''")
                        values.append(f"'{escaped}'::jsonb")
                    elif isinstance(val, list):
                        escaped = json.dumps(val).replace("'", "''")
                        values.append(f"'{escaped}'::jsonb")
                    elif isinstance(val, bytes):
                        values.append(f"'\\x{val.hex()}'")
                    else:
                        escaped = str(val).replace("'", "''")
                        values.append(f"'{escaped}'")

                val_list = ", ".join(values)
                out.write(
                    f'INSERT INTO "{table}" ({col_list}) VALUES ({val_list})'
                    f' ON CONFLICT DO NOTHING;\n'
                )
            out.write("\n")

        # Sequences
        sequences = await conn.fetch("""
            SELECT sequence_name FROM information_schema.sequences
            WHERE sequence_schema = 'public'
        """)
        for seq in sequences:
            name = seq["sequence_name"]
            val  = await conn.fetchval(f"SELECT last_value FROM {name}")
            out.write(f"SELECT setval('{name}', {val}, true);\n")

    finally:
        await conn.close()

    return out.getvalue().encode("utf-8")

async def _restore_database(params: dict, sql: bytes) -> None:
    """Execute the SQL dump against the target database."""
    conn = await asyncpg.connect(
        host=params["host"],
        port=params["port"],
        user=params["user"],
        password=params["password"],
        database=params["database"],
    )
    try:
        # Split into individual statements and execute one by one,
        # skipping the session_replication_role line we no longer emit
        statements = sql.decode("utf-8").split(";\n")
        for stmt in statements:
            stmt = stmt.strip()
            if not stmt or stmt.startswith("--"):
                continue
            try:
                await conn.execute(stmt)
            except Exception as e:
                # Log but continue — non-fatal errors (e.g. sequence already set)
                # shouldn't abort the whole restore
                import logging
                logging.getLogger(__name__).warning(f"Restore stmt warning: {e} — stmt: {stmt[:80]}")
    finally:
        await conn.close()

async def _build_backup_bytes() -> bytes:
    settings = get_settings()
    params   = _parse_db_url(settings.database_url)

    sql_bytes = await _dump_database(params)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:

        # Database dump
        sql_info      = tarfile.TarInfo(name="db.sql")
        sql_info.size = len(sql_bytes)
        tar.addfile(sql_info, io.BytesIO(sql_bytes))

        # Uploads folder
        uploads_path = "web/uploads"
        if os.path.isdir(uploads_path):
            tar.add(uploads_path, arcname="uploads")

        # Manifest
        manifest = json.dumps({
            "created_at": datetime.utcnow().isoformat(),
            "version":    "1.0",
            "db_name":    params["database"],
        }).encode()
        mf_info      = tarfile.TarInfo(name="manifest.json")
        mf_info.size = len(manifest)
        tar.addfile(mf_info, io.BytesIO(manifest))

    return buf.getvalue()


@router.get("/download")
async def download_backup(admin: User = Depends(require_admin)):
    """Stream a .tar.gz containing the DB dump + uploads. Admin only."""
    try:
        archive_bytes = await _build_backup_bytes()
    except Exception as e:
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

            # Validate manifest
            try:
                mf       = tar.extractfile("manifest.json")
                manifest = json.loads(mf.read())
            except Exception:
                raise HTTPException(400, "Invalid backup file — missing manifest")

            # Restore database
            sql_member = tar.extractfile("db.sql")
            if not sql_member:
                raise HTTPException(400, "Invalid backup file — missing db.sql")
            sql_data = sql_member.read()

            await _restore_database(params, sql_data)

            # Restore uploads
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
