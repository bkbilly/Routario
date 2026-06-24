"""
Fleet Reports Routes.

Report implementations live in app/reports/* and are dispatched through the
central report registry.
"""
import csv
import io
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from core.auth import require_permission
from core.database import get_db
from models import User
from reports import get_report, get_report_definitions
from reports.billing import billing_detail_payload
from reports.common import parse_id_csv

router = APIRouter(prefix="/api/reports", tags=["reports"])


class ReportPdfPayload(BaseModel):
    title: Optional[str] = None
    report_type: str = "report"
    payload: dict[str, Any]


async def _run_report(
    key: str,
    current_user: User,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    device_ids: Optional[str] = None,
    user_ids: Optional[str] = None,
    driver_ids: Optional[str] = None,
    options: Optional[dict] = None,
    historical: bool = False,
) -> dict:
    report = get_report(key)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    if report.definition.super_admin_required and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    if report.definition.company_admin_required and not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    if report.definition.needs_date_range and (not start_date or not end_date):
        raise HTTPException(status_code=400, detail="start_date and end_date are required")
    if historical and (not start_date or not end_date):
        raise HTTPException(status_code=400, detail="start_date and end_date are required for historical reports")

    db = get_db()
    async with db.get_session() as session:
        return await report.run(
            session=session,
            current_user=current_user,
            start_date=start_date,
            end_date=end_date,
            device_ids=parse_id_csv(device_ids),
            user_ids=parse_id_csv(user_ids),
            driver_ids=parse_id_csv(driver_ids),
            options=options or {},
            historical=historical,
        )


@router.get("/types")
async def report_types(current_user: User = Depends(require_permission("view_reports"))):
    return get_report_definitions(current_user)


@router.get("/fleet")
async def fleet_report(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    device_ids: Optional[str] = Query(None, description="Comma-separated device IDs; omit for all"),
    current_user: User = Depends(require_permission("view_reports")),
):
    return await _run_report("summary", current_user, start_date, end_date, device_ids=device_ids)


@router.get("/fleet/csv")
async def fleet_report_csv(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    device_ids: Optional[str] = Query(None),
    current_user: User = Depends(require_permission("view_reports")),
):
    report = await fleet_report(start_date, end_date, device_ids, current_user)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Device", "Plate", "Driver", "Trips", "Distance (km)", "Driving (min)", "Max Speed (km/h)", "Avg Speed (km/h)"])
    for r in report["rows"] if isinstance(report, dict) else report.rows:
        if isinstance(r, dict):
            writer.writerow([r["device_name"], r.get("license_plate") or "", r.get("driver_name") or "", r["trips"],
                             r["distance_km"], r["driving_minutes"], r["max_speed"], r["avg_speed"]])
        else:
            writer.writerow([r.device_name, r.license_plate or "", r.driver_name or "", r.trips,
                             r.distance_km, r.driving_minutes, r.max_speed, r.avg_speed])

    output.seek(0)
    filename = f"fleet_report_{start_date.date()}_{end_date.date()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/users")
async def users_report(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    user_ids: Optional[str] = Query(None, description="Comma-separated user IDs; omit for all"),
    current_user: User = Depends(require_permission("view_reports")),
):
    return await _run_report("users", current_user, start_date, end_date, user_ids=user_ids)


@router.get("/trips")
async def trips_report(
    start_date: datetime = Query(...),
    end_date: datetime = Query(...),
    device_ids: Optional[str] = Query(None),
    current_user: User = Depends(require_permission("view_reports")),
):
    return await _run_report("trips", current_user, start_date, end_date, device_ids=device_ids)


@router.get("/billing/details")
async def billing_report_details(
    company_id: int = Query(...),
    period: str = Query("this_month"),
    current_user: User = Depends(require_permission("view_reports")),
):
    if not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    db = get_db()
    async with db.get_session() as session:
        payload = await billing_detail_payload(session, current_user, company_id, period)
    if not payload:
        raise HTTPException(status_code=404, detail="Billing detail not found")
    return payload


@router.get("/billing/details/pdf")
async def billing_report_details_pdf(
    company_id: int = Query(...),
    period: str = Query("this_month"),
    current_user: User = Depends(require_permission("view_reports")),
):
    from core.schedule_runner import _pdf_branding, _write_schedule_pdf

    if not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    db = get_db()
    async with db.get_session() as session:
        detail = await billing_detail_payload(session, current_user, company_id, period)
        if not detail:
            raise HTTPException(status_code=404, detail="Billing detail not found")
        app_name, logo_path = await _pdf_branding(session, current_user)

    company = (detail.get("company") or {}).get("name") or "billing"
    period_label = (detail.get("period") or {}).get("label") or period
    safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in f"billing_{company}_{period_label}").strip("_")
    filename = f"{safe_name}.pdf"

    with tempfile.TemporaryDirectory(prefix="routario_billing_pdf_") as td:
        pdf_path = Path(td) / filename
        _write_schedule_pdf(
            pdf_path,
            SimpleNamespace(name=f"Billing Details - {company}", report_type="billing"),
            current_user,
            {
                "summary": [
                    {"label": "Company", "value": company},
                    {"label": "Period", "value": period_label},
                    {"label": "Draft Total", "value": detail.get("total_display_cents", 0)},
                ],
                "columns": [],
                "rows": [],
            },
            [],
            [],
            [detail],
            logo_path,
            app_name,
            current_user.timezone or "UTC",
        )
        pdf_bytes = pdf_path.read_bytes()

    return Response(
        pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/export/pdf")
async def report_pdf_from_payload(
    body: ReportPdfPayload,
    current_user: User = Depends(require_permission("view_reports")),
):
    from core.schedule_runner import _pdf_branding, _write_schedule_pdf

    payload = body.payload or {}
    rows = payload.get("rows", []) if isinstance(payload, dict) else []
    columns = [
        c for c in (payload.get("columns", []) if isinstance(payload, dict) else [])
        if not c.get("hidden") and c.get("csv") is not False
    ]
    db = get_db()
    async with db.get_session() as session:
        billing_details = []
        if body.report_type == "billing":
            if not (current_user.is_admin or current_user.is_company_admin):
                raise HTTPException(status_code=403, detail="Company admin access required")
            for row in rows:
                company_id = row.get("company_id")
                period = row.get("period_key")
                if not company_id or not period:
                    continue
                detail = await billing_detail_payload(session, current_user, int(company_id), str(period))
                if detail:
                    billing_details.append(detail)
        app_name, logo_path = await _pdf_branding(session, current_user)

    filename = (payload.get("csv_filename") if isinstance(payload, dict) else None) or f"{body.report_type}.csv"
    filename = Path(filename).with_suffix(".pdf").name.replace('"', "")
    with tempfile.TemporaryDirectory(prefix="routario_report_pdf_") as td:
        pdf_path = Path(td) / filename
        _write_schedule_pdf(
            pdf_path,
            SimpleNamespace(name=body.title or body.report_type, report_type=body.report_type),
            current_user,
            payload,
            columns,
            rows,
            billing_details,
            logo_path,
            app_name,
            current_user.timezone or "UTC",
        )
        pdf_bytes = pdf_path.read_bytes()

    return Response(
        pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{report_key}/pdf")
async def report_pdf_by_key(
    request: Request,
    report_key: str,
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    device_ids: Optional[str] = Query(None),
    user_ids: Optional[str] = Query(None),
    driver_ids: Optional[str] = Query(None),
    historical: bool = Query(False),
    current_user: User = Depends(require_permission("view_reports")),
):
    from core.schedule_runner import _pdf_branding, _write_schedule_pdf

    report = get_report(report_key)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    if report.definition.super_admin_required and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    if report.definition.company_admin_required and not (current_user.is_admin or current_user.is_company_admin):
        raise HTTPException(status_code=403, detail="Company admin access required")
    if report.definition.needs_date_range and (not start_date or not end_date):
        raise HTTPException(status_code=400, detail="start_date and end_date are required")
    if historical and (not start_date or not end_date):
        raise HTTPException(status_code=400, detail="start_date and end_date are required for historical reports")

    known_params = {"start_date", "end_date", "device_ids", "user_ids", "driver_ids", "historical"}
    options = {k: v for k, v in request.query_params.items() if k not in known_params and v != ""}
    db = get_db()
    async with db.get_session() as session:
        payload = await report.run(
            session=session,
            current_user=current_user,
            start_date=start_date,
            end_date=end_date,
            device_ids=parse_id_csv(device_ids),
            user_ids=parse_id_csv(user_ids),
            driver_ids=parse_id_csv(driver_ids),
            options=options,
            historical=historical,
        )
        rows = payload.get("rows", []) if isinstance(payload, dict) else []
        columns = [
            c for c in (payload.get("columns", []) if isinstance(payload, dict) else [])
            if not c.get("hidden") and c.get("csv") is not False
        ]
        billing_details = []
        if report_key == "billing":
            for row in rows:
                company_id = row.get("company_id")
                period = row.get("period_key")
                if not company_id or not period:
                    continue
                detail = await billing_detail_payload(session, current_user, int(company_id), str(period))
                if detail:
                    billing_details.append(detail)
        app_name, logo_path = await _pdf_branding(session, current_user)

    filename = (payload.get("csv_filename") if isinstance(payload, dict) else None) or f"{report_key}.csv"
    filename = Path(filename).with_suffix(".pdf").name.replace('"', "")
    with tempfile.TemporaryDirectory(prefix="routario_report_pdf_") as td:
        pdf_path = Path(td) / filename
        _write_schedule_pdf(
            pdf_path,
            SimpleNamespace(name=report.definition.label, report_type=report_key),
            current_user,
            payload,
            columns,
            rows,
            billing_details,
            logo_path,
            app_name,
            current_user.timezone or "UTC",
        )
        pdf_bytes = pdf_path.read_bytes()

    return Response(
        pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{report_key}")
async def report_by_key(
    request: Request,
    report_key: str,
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    device_ids: Optional[str] = Query(None),
    user_ids: Optional[str] = Query(None),
    driver_ids: Optional[str] = Query(None),
    historical: bool = Query(False),
    current_user: User = Depends(require_permission("view_reports")),
):
    known_params = {"start_date", "end_date", "device_ids", "user_ids", "driver_ids", "historical"}
    options = {k: v for k, v in request.query_params.items() if k not in known_params and v != ""}
    return await _run_report(report_key, current_user, start_date, end_date, device_ids, user_ids, driver_ids, options, historical)
