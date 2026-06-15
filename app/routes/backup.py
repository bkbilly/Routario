"""
Backup & Restore Routes
Pure SQLAlchemy backup — works with PostgreSQL, MySQL, and SQLite.
"""
import io
import json
import os
import tarfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import inspect, text

from core.auth import get_current_user
from core.database import get_db
from models import User

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])

SCOPED_TABLE_ORDER = [
    "companies",
    "users",
    "drivers",
    "devices",
    "user_device_access",
    "device_states",
    "position_records",
    "trips",
    "geofences",
    "alert_history",
    "command_queue",
    "fuel_logs",
    "logbook_entries",
    "voice_messages",
    "voice_message_reads",
    "location_shares",
    "scheduled_reports",
    "scheduled_report_runs",
    "video_clips",
    "audit_logs",
    "api_keys",
    "usage_events",
    "billing_invoices",
    "planned_routes",
    "route_stops",
    "integration_accounts",
]


def _require_backup_permission(user: User) -> None:
    if user.is_admin:
        return
    if not user.is_company_admin:
        raise HTTPException(status_code=403, detail="Company admin access required")
    if "manage_backups" not in (user.permissions or []):
        raise HTTPException(status_code=403, detail="Permission required: manage_backups")
    if not user.company_id:
        raise HTTPException(status_code=403, detail="Company-scoped backup requires a company")


def _serialise(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return obj.hex()
    raise TypeError(f"Not serialisable: {type(obj)}")


async def _table_names(conn) -> set[str]:
    return set(await conn.run_sync(lambda sync_conn: inspect(sync_conn).get_table_names()))


async def _rows(conn, sql: str, params: dict | None = None) -> list[dict]:
    result = await conn.execute(text(sql), params or {})
    return [dict(row) for row in result.mappings().all()]


async def _dump_database() -> bytes:
    """
    Export every table to a JSON-lines file (one JSON object per row).
    Works with any SQLAlchemy-supported database.
    """
    db = get_db()
    output: dict = {}

    async with db.engine.connect() as conn:
        # Reflect table names
        table_names = await _table_names(conn)
        for table in table_names:
            result = await conn.execute(text(f'SELECT * FROM "{table}"'))
            rows = result.mappings().all()
            output[table] = [dict(row) for row in rows]

    return json.dumps(output, default=_serialise, indent=2).encode("utf-8")


async def _dump_company_database(company_id: int) -> bytes:
    db = get_db()
    output: dict = {}

    async with db.engine.connect() as conn:
        tables = await _table_names(conn)

        users = await _rows(conn, 'SELECT id FROM "users" WHERE company_id = :company_id', {"company_id": company_id}) if "users" in tables else []
        devices = await _rows(conn, 'SELECT id FROM "devices" WHERE company_id = :company_id', {"company_id": company_id}) if "devices" in tables else []
        routes = await _rows(conn, 'SELECT id FROM "planned_routes" WHERE company_id = :company_id', {"company_id": company_id}) if "planned_routes" in tables else []
        schedules = await _rows(
            conn,
            'SELECT sr.id FROM "scheduled_reports" sr JOIN "users" u ON u.id = sr.user_id WHERE u.company_id = :company_id',
            {"company_id": company_id},
        ) if {"scheduled_reports", "users"}.issubset(tables) else []
        voice_messages = await _rows(conn, 'SELECT id FROM "voice_messages" WHERE company_id = :company_id', {"company_id": company_id}) if "voice_messages" in tables else []

        user_ids = [r["id"] for r in users]
        device_ids = [r["id"] for r in devices]
        route_ids = [r["id"] for r in routes]
        schedule_ids = [r["id"] for r in schedules]
        voice_message_ids = [r["id"] for r in voice_messages]

        def id_csv(ids: list[int]) -> str:
            return ",".join(str(int(i)) for i in ids) or "NULL"

        queries = {
            "companies": ('SELECT * FROM "companies" WHERE id = :company_id', {"company_id": company_id}),
            "users": ('SELECT * FROM "users" WHERE company_id = :company_id', {"company_id": company_id}),
            "drivers": ('SELECT * FROM "drivers" WHERE company_id = :company_id', {"company_id": company_id}),
            "devices": ('SELECT * FROM "devices" WHERE company_id = :company_id', {"company_id": company_id}),
            "voice_messages": ('SELECT * FROM "voice_messages" WHERE company_id = :company_id', {"company_id": company_id}),
            "audit_logs": ('SELECT * FROM "audit_logs" WHERE company_id = :company_id', {"company_id": company_id}),
            "api_keys": ('SELECT * FROM "api_keys" WHERE company_id = :company_id', {"company_id": company_id}),
            "usage_events": ('SELECT * FROM "usage_events" WHERE company_id = :company_id', {"company_id": company_id}),
            "billing_invoices": ('SELECT * FROM "billing_invoices" WHERE company_id = :company_id', {"company_id": company_id}),
            "planned_routes": ('SELECT * FROM "planned_routes" WHERE company_id = :company_id', {"company_id": company_id}),
            "user_device_access": (f'SELECT * FROM "user_device_access" WHERE user_id IN ({id_csv(user_ids)}) OR device_id IN ({id_csv(device_ids)})', {}),
            "device_states": (f'SELECT * FROM "device_states" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "position_records": (f'SELECT * FROM "position_records" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "trips": (f'SELECT * FROM "trips" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "geofences": (f'SELECT * FROM "geofences" WHERE device_id IN ({id_csv(device_ids)}) OR user_id IN ({id_csv(user_ids)})', {}),
            "alert_history": (f'SELECT * FROM "alert_history" WHERE device_id IN ({id_csv(device_ids)}) OR user_id IN ({id_csv(user_ids)})', {}),
            "command_queue": (f'SELECT * FROM "command_queue" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "fuel_logs": (f'SELECT * FROM "fuel_logs" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "logbook_entries": (f'SELECT * FROM "logbook_entries" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "voice_message_reads": (f'SELECT * FROM "voice_message_reads" WHERE message_id IN ({id_csv(voice_message_ids)}) OR user_id IN ({id_csv(user_ids)})', {}),
            "location_shares": (f'SELECT * FROM "location_shares" WHERE device_id IN ({id_csv(device_ids)}) OR created_by IN ({id_csv(user_ids)})', {}),
            "scheduled_reports": (f'SELECT * FROM "scheduled_reports" WHERE user_id IN ({id_csv(user_ids)})', {}),
            "scheduled_report_runs": (f'SELECT * FROM "scheduled_report_runs" WHERE schedule_id IN ({id_csv(schedule_ids)})', {}),
            "video_clips": (f'SELECT * FROM "video_clips" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "route_stops": (f'SELECT * FROM "route_stops" WHERE route_id IN ({id_csv(route_ids)})', {}),
            "integration_accounts": (f'SELECT * FROM "integration_accounts" WHERE user_id IN ({id_csv(user_ids)})', {}),
        }

        for table in SCOPED_TABLE_ORDER:
            if table in tables and table in queries:
                sql, params = queries[table]
                output[table] = await _rows(conn, sql, params)

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


async def _restore_company_database(data: bytes, company_id: int) -> None:
    """
    Restore only rows owned by company_id. Super-admin rows and rows belonging
    to other companies are never deleted or inserted by this path.
    """
    import logging
    logger = logging.getLogger(__name__)

    payload: dict = json.loads(data.decode("utf-8"))
    db = get_db()

    def id_csv(ids: list[int]) -> str:
        return ",".join(str(int(i)) for i in ids) or "NULL"

    async with db.engine.begin() as conn:
        tables = await _table_names(conn)
        current_users = await _rows(conn, 'SELECT id FROM "users" WHERE company_id = :company_id', {"company_id": company_id}) if "users" in tables else []
        current_devices = await _rows(conn, 'SELECT id FROM "devices" WHERE company_id = :company_id', {"company_id": company_id}) if "devices" in tables else []
        current_routes = await _rows(conn, 'SELECT id FROM "planned_routes" WHERE company_id = :company_id', {"company_id": company_id}) if "planned_routes" in tables else []
        current_schedules = await _rows(
            conn,
            'SELECT sr.id FROM "scheduled_reports" sr JOIN "users" u ON u.id = sr.user_id WHERE u.company_id = :company_id',
            {"company_id": company_id},
        ) if {"scheduled_reports", "users"}.issubset(tables) else []
        current_voice = await _rows(conn, 'SELECT id FROM "voice_messages" WHERE company_id = :company_id', {"company_id": company_id}) if "voice_messages" in tables else []

        user_ids = [r["id"] for r in current_users]
        device_ids = [r["id"] for r in current_devices]
        route_ids = [r["id"] for r in current_routes]
        schedule_ids = [r["id"] for r in current_schedules]
        voice_ids = [r["id"] for r in current_voice]

        deletes = {
            "companies": ('DELETE FROM "companies" WHERE id = :company_id', {"company_id": company_id}),
            "users": ('DELETE FROM "users" WHERE company_id = :company_id', {"company_id": company_id}),
            "drivers": ('DELETE FROM "drivers" WHERE company_id = :company_id', {"company_id": company_id}),
            "devices": ('DELETE FROM "devices" WHERE company_id = :company_id', {"company_id": company_id}),
            "voice_messages": ('DELETE FROM "voice_messages" WHERE company_id = :company_id', {"company_id": company_id}),
            "audit_logs": ('DELETE FROM "audit_logs" WHERE company_id = :company_id', {"company_id": company_id}),
            "api_keys": ('DELETE FROM "api_keys" WHERE company_id = :company_id', {"company_id": company_id}),
            "usage_events": ('DELETE FROM "usage_events" WHERE company_id = :company_id', {"company_id": company_id}),
            "billing_invoices": ('DELETE FROM "billing_invoices" WHERE company_id = :company_id', {"company_id": company_id}),
            "planned_routes": ('DELETE FROM "planned_routes" WHERE company_id = :company_id', {"company_id": company_id}),
            "user_device_access": (f'DELETE FROM "user_device_access" WHERE user_id IN ({id_csv(user_ids)}) OR device_id IN ({id_csv(device_ids)})', {}),
            "device_states": (f'DELETE FROM "device_states" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "position_records": (f'DELETE FROM "position_records" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "trips": (f'DELETE FROM "trips" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "geofences": (f'DELETE FROM "geofences" WHERE device_id IN ({id_csv(device_ids)}) OR user_id IN ({id_csv(user_ids)})', {}),
            "alert_history": (f'DELETE FROM "alert_history" WHERE device_id IN ({id_csv(device_ids)}) OR user_id IN ({id_csv(user_ids)})', {}),
            "command_queue": (f'DELETE FROM "command_queue" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "fuel_logs": (f'DELETE FROM "fuel_logs" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "logbook_entries": (f'DELETE FROM "logbook_entries" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "voice_message_reads": (f'DELETE FROM "voice_message_reads" WHERE message_id IN ({id_csv(voice_ids)}) OR user_id IN ({id_csv(user_ids)})', {}),
            "location_shares": (f'DELETE FROM "location_shares" WHERE device_id IN ({id_csv(device_ids)}) OR created_by IN ({id_csv(user_ids)})', {}),
            "scheduled_reports": (f'DELETE FROM "scheduled_reports" WHERE user_id IN ({id_csv(user_ids)})', {}),
            "scheduled_report_runs": (f'DELETE FROM "scheduled_report_runs" WHERE schedule_id IN ({id_csv(schedule_ids)})', {}),
            "video_clips": (f'DELETE FROM "video_clips" WHERE device_id IN ({id_csv(device_ids)})', {}),
            "route_stops": (f'DELETE FROM "route_stops" WHERE route_id IN ({id_csv(route_ids)})', {}),
            "integration_accounts": (f'DELETE FROM "integration_accounts" WHERE user_id IN ({id_csv(user_ids)})', {}),
        }

        try:
            await conn.execute(text("PRAGMA foreign_keys = OFF"))
        except Exception:
            pass
        try:
            await conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        except Exception:
            pass

        for table in reversed(SCOPED_TABLE_ORDER):
            if table in tables and table in deletes:
                sql, params = deletes[table]
                try:
                    await conn.execute(text(sql), params)
                except Exception as exc:
                    logger.warning("Could not clear company rows in %s: %s", table, exc)

        for table in SCOPED_TABLE_ORDER:
            rows = payload.get(table) or []
            if table not in tables or not rows:
                continue
            for row in rows:
                if table == "companies":
                    row["id"] = company_id
                if "company_id" in row:
                    row["company_id"] = company_id
                if table == "users":
                    row["is_admin"] = False
                if not row:
                    continue
                cols = ", ".join(f'"{c}"' for c in row.keys())
                params = ", ".join(f":{c}" for c in row.keys())
                try:
                    await conn.execute(
                        text(f'INSERT INTO "{table}" ({cols}) VALUES ({params})'),
                        row,
                    )
                except Exception as exc:
                    logger.warning("Company restore insert failed in %s: %s", table, exc)

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


def _safe_upload_paths(payload: dict) -> set[Path]:
    paths: set[Path] = set()
    root = Path("web/uploads").resolve()

    def add(candidate):
        if not candidate:
            return
        path = Path(str(candidate))
        if not path.is_absolute():
            path = Path("web/uploads") / path if not str(path).startswith("web/uploads") else path
        try:
            resolved = path.resolve()
            if resolved.exists() and root in resolved.parents:
                paths.add(resolved)
        except OSError:
            pass

    for company in payload.get("companies", []):
        add(f"web/uploads/company-branding/{company.get('icon_filename')}")
        add(f"web/uploads/company-branding/{company.get('badge_filename')}")
    for msg in payload.get("voice_messages", []):
        add(msg.get("file_path"))
    for clip in payload.get("video_clips", []):
        add(clip.get("file_path"))
        add(clip.get("thumbnail_path"))
    for entry in payload.get("logbook_entries", []):
        docs = entry.get("documents") or []
        if isinstance(docs, list):
            for doc in docs:
                add(doc.get("path") if isinstance(doc, dict) else doc)
    return paths


async def _build_company_backup_bytes(company_id: int) -> bytes:
    sql_bytes = await _dump_company_database(company_id)
    payload = json.loads(sql_bytes.decode("utf-8"))

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        db_info = tarfile.TarInfo(name="db.json")
        db_info.size = len(sql_bytes)
        tar.addfile(db_info, io.BytesIO(sql_bytes))

        for path in _safe_upload_paths(payload):
            tar.add(path, arcname=str(path.relative_to(Path("web").resolve())))

        manifest = json.dumps({
            "created_at": datetime.utcnow().isoformat(),
            "version": "2.1",
            "format": "json",
            "scope": "company",
            "company_id": company_id,
        }).encode()
        mf_info = tarfile.TarInfo(name="manifest.json")
        mf_info.size = len(manifest)
        tar.addfile(mf_info, io.BytesIO(manifest))

    return buf.getvalue()


@router.get("/download")
async def download_backup(current_user: User = Depends(get_current_user)):
    _require_backup_permission(current_user)
    try:
        archive = (
            await _build_backup_bytes()
            if current_user.is_admin
            else await _build_company_backup_bytes(current_user.company_id)
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    prefix = "routario_backup" if current_user.is_admin else f"routario_company_{current_user.company_id}_backup"
    filename = f"{prefix}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.tar.gz"
    return StreamingResponse(
        io.BytesIO(archive),
        media_type="application/gzip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    _require_backup_permission(current_user)
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

            if current_user.is_admin:
                await _restore_database(db_data)
            else:
                if manifest.get("scope") != "company":
                    raise HTTPException(400, "Only company-scoped backups can be restored here")
                if int(manifest.get("company_id") or 0) != int(current_user.company_id):
                    raise HTTPException(403, "Backup belongs to a different company")
                await _restore_company_database(db_data, current_user.company_id)

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
