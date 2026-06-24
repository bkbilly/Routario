"""
Background task: execute due report schedules and store results.
"""
import asyncio
import csv
import json
import logging
import struct
import tempfile
import zlib
from datetime import datetime
from pathlib import Path
from textwrap import wrap
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, select

from core.database import get_db
from core.runtime_health import mark_task_error, mark_task_success
from models.models import (
    ScheduledReport,
    ScheduledReportRun,
    User,
)
from notifications import get_channel
from reports import get_report
from reports.common import date_range
from routes.report_schedules import compute_next_run

logger = logging.getLogger(__name__)

_CHECK_INTERVAL = 60  # seconds
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

# ── Report generators ─────────────────────────────────────────────────────────

async def _run_report(session, schedule: ScheduledReport, user: User) -> dict:
    report = get_report(schedule.report_type)
    if not report:
        raise ValueError(f"Unknown report type: {schedule.report_type}")
    if report.definition.super_admin_required and not user.is_admin:
        raise PermissionError(f"Report type requires super admin: {schedule.report_type}")
    if report.definition.company_admin_required and not (user.is_admin or user.is_company_admin):
        raise PermissionError(f"Report type requires company admin: {schedule.report_type}")

    start = end = None
    if report.definition.needs_date_range or schedule.sensors_historical:
        start, end = date_range(schedule.date_range)

    return await report.run(
        session=session,
        current_user=user,
        start_date=start,
        end_date=end,
        device_ids=schedule.filter_device_ids or [],
        user_ids=schedule.filter_user_ids or [],
        options=schedule.report_options or {},
        historical=schedule.sensors_historical,
    )


# ── Execute one schedule ──────────────────────────────────────────────────────

def _plain(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    return str(value)


def _pdf_escape(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _local_generated_label(timezone_name: str | None) -> str:
    tz_name = timezone_name or "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        tz_name = "UTC"
        tz = ZoneInfo("UTC")
    return datetime.now(tz).strftime(f"Generated %Y-%m-%d %H:%M {tz_name}")


def _paeth(left: int, up: int, up_left: int) -> int:
    p = left + up - up_left
    pa = abs(p - left)
    pb = abs(p - up)
    pc = abs(p - up_left)
    if pa <= pb and pa <= pc:
        return left
    if pb <= pc:
        return up
    return up_left


def _read_png_rgb(path: Path, background: tuple[int, int, int] = (255, 255, 255)) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Only PNG logos are supported by the built-in PDF renderer")

    width = height = bit_depth = color_type = None
    idat = bytearray()
    offset = 8
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk_type = data[offset + 4:offset + 8]
        chunk_data = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _compression, _filter, interlace = struct.unpack(">IIBBBBB", chunk_data)
            if bit_depth != 8 or color_type not in (2, 6) or interlace != 0:
                raise ValueError("Unsupported PNG format for PDF logo")
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        elif chunk_type == b"IEND":
            break

    if not width or not height or not idat:
        raise ValueError("Invalid PNG logo")

    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(bytes(idat))
    rows: list[bytearray] = []
    pos = 0
    prev = bytearray(stride)
    for _ in range(height):
        filter_type = raw[pos]
        pos += 1
        row = bytearray(raw[pos:pos + stride])
        pos += stride
        for i, value in enumerate(row):
            left = row[i - channels] if i >= channels else 0
            up = prev[i]
            up_left = prev[i - channels] if i >= channels else 0
            if filter_type == 1:
                row[i] = (value + left) & 0xFF
            elif filter_type == 2:
                row[i] = (value + up) & 0xFF
            elif filter_type == 3:
                row[i] = (value + ((left + up) // 2)) & 0xFF
            elif filter_type == 4:
                row[i] = (value + _paeth(left, up, up_left)) & 0xFF
            elif filter_type != 0:
                raise ValueError("Unsupported PNG filter")
        rows.append(row)
        prev = row

    rgb = bytearray(width * height * 3)
    out = 0
    for row in rows:
        for x in range(width):
            base = x * channels
            r, g, b = row[base], row[base + 1], row[base + 2]
            if channels == 4:
                alpha = row[base + 3]
                bg_r, bg_g, bg_b = background
                r = ((r * alpha) + (bg_r * (255 - alpha))) // 255
                g = ((g * alpha) + (bg_g * (255 - alpha))) // 255
                b = ((b * alpha) + (bg_b * (255 - alpha))) // 255
            rgb[out:out + 3] = bytes((r, g, b))
            out += 3
    return width, height, bytes(rgb)


def _scale_rgb(width: int, height: int, rgb: bytes, max_size: int) -> tuple[int, int, bytes]:
    if width <= max_size and height <= max_size:
        return width, height, rgb
    ratio = min(max_size / width, max_size / height)
    new_w = max(1, int(width * ratio))
    new_h = max(1, int(height * ratio))
    out = bytearray(new_w * new_h * 3)
    for y in range(new_h):
        src_y = min(height - 1, int(y / ratio))
        for x in range(new_w):
            src_x = min(width - 1, int(x / ratio))
            src = (src_y * width + src_x) * 3
            dst = (y * new_w + x) * 3
            out[dst:dst + 3] = rgb[src:src + 3]
    return new_w, new_h, bytes(out)


class _PdfDocument:
    HEADER_RGB = (15, 20, 32)

    def __init__(self, title: str, logo_path: Path | None = None, app_name: str = "Routario", timezone_name: str | None = "UTC"):
        self.title = title
        self.app_name = app_name or "Routario"
        self.timezone_name = timezone_name or "UTC"
        self.width = 792
        self.height = 612
        self.margin = 36
        self.y = self.height - self.margin
        self.pages: list[list[str]] = []
        self.current: list[str] = []
        self.images: dict[str, tuple[int, int, bytes]] = {}
        self.logo_name = self._load_image(logo_path, max_size=96) if logo_path else None

    def _load_image(self, path: Path, max_size: int = 96) -> str | None:
        try:
            if not path or not path.is_file():
                return None
            width, height, rgb = _read_png_rgb(path, self.HEADER_RGB)
            width, height, rgb = _scale_rgb(width, height, rgb, max_size)
            name = f"Im{len(self.images) + 1}"
            self.images[name] = (width, height, zlib.compress(rgb))
            return name
        except Exception as exc:
            logger.debug("PDF logo unavailable: %s", exc)
            return None

    def _cmd(self, value: str) -> None:
        self.current.append(value)

    def _color(self, color: tuple[float, float, float]) -> str:
        return f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f}"

    def new_page(self) -> None:
        if self.current:
            self._footer()
            self.pages.append(self.current)
        self.current = []
        self.y = self.height - self.margin
        self._header()

    def finish(self, path: Path) -> None:
        if not self.current:
            self.new_page()
        self._footer()
        self.pages.append(self.current)
        self._write(path)

    def ensure(self, needed: float) -> None:
        if not self.current:
            self.new_page()
        if self.y - needed < self.margin + 18:
            self.new_page()

    def rect(self, x: float, y: float, w: float, h: float, fill: tuple[float, float, float] | None = None,
             stroke: tuple[float, float, float] | None = None) -> None:
        if fill:
            self._cmd(f"{self._color(fill)} rg")
            self._cmd(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")
        if stroke:
            self._cmd(f"{self._color(stroke)} RG")
            self._cmd(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re S")

    def text(self, value: str, x: float, y: float, size: int = 9, font: str = "F1",
             color: tuple[float, float, float] = (0.067, 0.094, 0.153)) -> None:
        safe = _pdf_escape(str(value))
        self._cmd(f"{self._color(color)} rg")
        self._cmd(f"BT /{font} {size} Tf {x:.2f} {y:.2f} Td ({safe}) Tj ET")

    def image(self, name: str, x: float, y: float, w: float, h: float) -> None:
        self._cmd(f"q {w:.2f} 0 0 {h:.2f} {x:.2f} {y:.2f} cm /{name} Do Q")

    def _header(self) -> None:
        self.rect(0, self.height - 88, self.width, 88, fill=(0.059, 0.078, 0.125))
        self.rect(0, self.height - 90, self.width, 2, fill=(0.235, 0.596, 0.996))
        logo_x, logo_y = self.margin, self.height - 69
        if self.logo_name:
            self.image(self.logo_name, logo_x, logo_y, 36, 36)
        else:
            self.rect(logo_x, logo_y, 36, 36, fill=(0.235, 0.596, 0.996))
            self.text("R", logo_x + 11, logo_y + 10, size=18, font="F2", color=(1, 1, 1))
        self.text(self.app_name, logo_x + 50, self.height - 43, size=17, font="F2", color=(1, 1, 1))
        self.text(self.title, logo_x + 50, self.height - 62, size=9, color=(0.812, 0.863, 0.941))
        self.text(_local_generated_label(self.timezone_name), self.width - 235, self.height - 48, size=8, color=(0.812, 0.863, 0.941))
        self.y = self.height - 126

    def _footer(self) -> None:
        page_no = len(self.pages) + 1
        self.rect(self.margin, 25, self.width - (self.margin * 2), 0.6, fill=(0.820, 0.835, 0.859))
        self.text(f"{self.app_name} scheduled report", self.margin, 12, size=7, color=(0.420, 0.447, 0.502))
        self.text(f"Page {page_no}", self.width - self.margin - 34, 12, size=7, color=(0.420, 0.447, 0.502))

    def section(self, title: str) -> None:
        self.y -= 12
        self.ensure(48)
        self.text(title, self.margin, self.y, size=14, font="F2")
        self.rect(self.margin, self.y - 7, self.width - (self.margin * 2), 1.2, fill=(0.235, 0.596, 0.996))
        self.y -= 30

    def subsection(self, title: str) -> None:
        self.y -= 8
        self.ensure(28)
        self.text(title, self.margin, self.y, size=10, font="F2", color=(0.129, 0.161, 0.216))
        self.y -= 18

    def cards(self, items: list[tuple[str, str]]) -> None:
        if not items:
            return
        gap = 8
        cols = min(6, max(1, len(items)))
        card_w = (self.width - (self.margin * 2) - (gap * (cols - 1))) / cols
        card_h = 43
        for idx, (label, value) in enumerate(items):
            if idx % cols == 0:
                self.ensure(card_h + 8)
                row_y = self.y - card_h
            x = self.margin + (idx % cols) * (card_w + gap)
            self.rect(x, row_y, card_w, card_h, fill=(0.973, 0.980, 0.988), stroke=(0.820, 0.835, 0.859))
            self.text(label.upper(), x + 8, row_y + 25, size=6, font="F2", color=(0.420, 0.447, 0.502))
            self.text(_truncate(value, int(card_w / 5.4)), x + 8, row_y + 10, size=10, font="F2")
            if idx % cols == cols - 1 or idx == len(items) - 1:
                self.y = row_y - 10

    def table(self, headers: list[str], rows: list[list[str]], widths: list[float] | None = None, max_rows: int | None = None) -> None:
        if not headers:
            return
        rows = rows[:max_rows] if max_rows else rows
        total_w = self.width - (self.margin * 2)
        widths = widths or [total_w / len(headers)] * len(headers)
        header_h, row_h = 20, 18

        def draw_header() -> None:
            self.ensure(header_h + row_h)
            x = self.margin
            self.rect(x, self.y - header_h, total_w, header_h, fill=(0.129, 0.161, 0.216))
            for header, width in zip(headers, widths):
                self.text(_truncate(header, int(width / 4.4)), x + 5, self.y - 13, size=7, font="F2", color=(1, 1, 1))
                x += width
            self.y -= header_h

        draw_header()
        if not rows:
            self.rect(self.margin, self.y - row_h, total_w, row_h, fill=(0.984, 0.988, 0.996), stroke=(0.878, 0.894, 0.918))
            self.text("No rows", self.margin + 6, self.y - 12, size=8, color=(0.420, 0.447, 0.502))
            self.y -= row_h + 8
            return

        for idx, row in enumerate(rows):
            if self.y - row_h < self.margin + 24:
                self.new_page()
                draw_header()
            fill = (1, 1, 1) if idx % 2 == 0 else (0.973, 0.980, 0.988)
            self.rect(self.margin, self.y - row_h, total_w, row_h, fill=fill, stroke=(0.878, 0.894, 0.918))
            x = self.margin
            for value, width in zip(row, widths):
                self.text(_truncate(value, int(width / 4.7)), x + 5, self.y - 12, size=7)
                x += width
            self.y -= row_h
        self.y -= 10

    def _write(self, path: Path) -> None:
        objects: list[str] = []

        def add_object(body: str) -> int:
            objects.append(body)
            return len(objects)

        catalog_id = add_object("<< /Type /Catalog /Pages 2 0 R >>")
        pages_id = add_object("<< /Type /Pages /Kids [] /Count 0 >>")
        font_regular_id = add_object("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        font_bold_id = add_object("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
        image_ids = {
            name: add_object(
                f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB "
                f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(data)} >>\nstream\n"
                + data.decode("latin-1")
                + "\nendstream"
            )
            for name, (w, h, data) in self.images.items()
        }
        page_ids: list[int] = []
        image_resource = " ".join(f"/{name} {obj_id} 0 R" for name, obj_id in image_ids.items())
        for commands in self.pages:
            stream = "\n".join(commands)
            content_id = add_object(f"<< /Length {len(stream.encode('latin-1', 'replace'))} >>\nstream\n{stream}\nendstream")
            page_id = add_object(
                f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {self.width} {self.height}] "
                f"/Resources << /Font << /F1 {font_regular_id} 0 R /F2 {font_bold_id} 0 R >> "
                f"/XObject << {image_resource} >> >> /Contents {content_id} 0 R >>"
            )
            page_ids.append(page_id)
        objects[pages_id - 1] = f"<< /Type /Pages /Kids [{' '.join(f'{pid} 0 R' for pid in page_ids)}] /Count {len(page_ids)} >>"
        objects[catalog_id - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>"

        output = bytearray(b"%PDF-1.4\n")
        offsets = [0]
        for idx, body in enumerate(objects, start=1):
            offsets.append(len(output))
            output.extend(f"{idx} 0 obj\n".encode("latin-1"))
            output.extend(body.encode("latin-1", "replace"))
            output.extend(b"\nendobj\n")
        xref_offset = len(output)
        output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
        output.extend(b"0000000000 65535 f \n")
        for offset in offsets[1:]:
            output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
        output.extend(
            f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n".encode("ascii")
        )
        path.write_bytes(bytes(output))


def _truncate(value, max_chars: int) -> str:
    value = _plain(value).replace("\n", " ").replace("\r", " ")
    if len(value) <= max_chars:
        return value
    return value[:max(1, max_chars - 1)] + "…"


async def _pdf_branding(session, user: User) -> tuple[str, Path | None]:
    app_name = "Routario"
    default_logo = _PROJECT_ROOT / "web/icons/icon-192.png"
    if user.company_id:
        try:
            from models.models import Company

            company = await session.get(Company, user.company_id)
            if company:
                app_name = company.app_name or app_name
                if company.icon_filename:
                    custom = _PROJECT_ROOT / "web/uploads/company-branding" / company.icon_filename
                    if custom.is_file():
                        return app_name, custom
        except Exception as exc:
            logger.debug("Unable to resolve company branding for PDF: %s", exc)
    return app_name, default_logo if default_logo.is_file() else None


def _summary_items(data: dict) -> list[tuple[str, str]]:
    return [(str(card.get("label") or ""), _pdf_cell_value(card.get("value"))) for card in data.get("summary") or []]


def _pdf_cell_value(value, column: dict | None = None) -> str:
    column = column or {}
    if value is None:
        return ""
    if column.get("type") == "read_status":
        return "Read" if value else "Unread"
    if column.get("type") == "severity":
        return str(value).title()
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    return str(value)


def _report_table_rows(columns: list[dict], rows: list[dict]) -> tuple[list[str], list[list[str]]]:
    headers = [str(c.get("label") or c.get("key") or "") for c in columns]
    values = [[_pdf_cell_value(row.get(c.get("key")), c) for c in columns] for row in rows]
    return headers, values


def _billing_cards(detail: dict) -> list[tuple[str, str]]:
    company = detail.get("company") or {}
    period = detail.get("period") or {}
    currency = detail.get("currency") or "EUR"
    return [
        ("Company", company.get("name") or "-"),
        ("Period", period.get("label") or "-"),
        ("Billing Email", company.get("billing_email") or "-"),
        ("Billing Status", company.get("billing_status") or "-"),
        ("Draft Total", _fmt_money_cents(detail.get("total_display_cents"), currency)),
    ]


def _write_schedule_pdf(path: Path, schedule: ScheduledReport, user: User, data: dict, columns: list[dict],
                        rows: list[dict], billing_details: list[dict], logo_path: Path | None,
                        app_name: str = "Routario", timezone_name: str | None = "UTC") -> None:
    _write_schedule_pdf_basic(path, schedule, data, columns, rows, billing_details, logo_path, app_name, timezone_name)


def _write_schedule_pdf_basic(path: Path, schedule: ScheduledReport, data: dict, columns: list[dict],
                              rows: list[dict], billing_details: list[dict], logo_path: Path | None,
                              app_name: str = "Routario", timezone_name: str | None = "UTC") -> None:
    pdf = _PdfDocument(schedule.name, logo_path, app_name, timezone_name)
    pdf.new_page()
    pdf.section("Summary")
    pdf.cards(_summary_items(data) or [("Report", schedule.report_type), ("Rows", str(len(rows)))])
    headers, table_rows = _report_table_rows(columns, rows)
    pdf.section("Results")
    pdf.table(headers, table_rows, max_rows=500)
    if len(rows) > 500:
        pdf.text(f"Showing first 500 of {len(rows)} rows. Full results are included in the CSV attachment.", pdf.margin, pdf.y, size=8, color=(0.420, 0.447, 0.502))
        pdf.y -= 16
    for detail in billing_details:
        company = (detail.get("company") or {}).get("name") or "Company"
        pdf.new_page()
        pdf.section(f"Billing Details - {company}")
        pdf.cards(_billing_cards(detail))
        _basic_billing_tables(pdf, detail)
    pdf.finish(path)


def _basic_billing_tables(pdf: _PdfDocument, detail: dict) -> None:
    currency = detail.get("currency") or "EUR"
    plan = detail.get("plan") or {}
    usage = detail.get("usage") or {}
    if plan:
        pdf.subsection("Plan")
        pdf.table(
            ["Plan", "Base", "Included Devices", "Included Positions", "Included API Calls"],
            [[
                plan.get("name") or "-",
                _fmt_money_cents(plan.get("base_price_display_cents"), currency),
                _fmt_int(plan.get("included_devices")),
                _fmt_int(plan.get("included_positions")),
                _fmt_int(plan.get("included_api_calls")),
            ]],
        )
    pdf.subsection("Usage")
    pdf.table(
        ["Active Devices", "Positions", "API Calls", "Usage Events"],
        [[
            _fmt_int(usage.get("active_devices")),
            _fmt_int(usage.get("positions")),
            _fmt_int(usage.get("api_calls")),
            _fmt_int(len(usage.get("events") or {})),
        ]],
    )
    events = usage.get("events") or {}
    if events:
        pdf.subsection("Usage Events")
        pdf.table(["Metric", "Quantity"], [[metric, _fmt_int(qty)] for metric, qty in events.items()])
    pdf.subsection("Cost Breakdown / Billing Lines")
    pdf.table(
        ["Description", "Quantity", "Unit", "Billable Units", "Amount"],
        [[
            item.get("label") or "-",
            _fmt_int(item.get("quantity")),
            item.get("unit") or "-",
            _fmt_int(item.get("billable_units")),
            _fmt_money_cents(item.get("amount_display_cents"), currency),
        ] for item in detail.get("line_items") or []],
    )
    grain = detail.get("breakdown_grain") or "monthly"
    pdf.subsection("Daily Usage" if grain == "daily" else "Monthly Breakdown")
    pdf.table(
        ["Day" if grain == "daily" else "Month", "Devices", "Positions", "API Calls", "Total"],
        [[
            item.get("label") or "-",
            _fmt_int((item.get("usage") or {}).get("active_devices")),
            _fmt_int((item.get("usage") or {}).get("positions")),
            _fmt_int((item.get("usage") or {}).get("api_calls")),
            "" if grain == "daily" else _fmt_money_cents(item.get("amount_display_cents"), currency),
        ] for item in (detail.get("breakdown") or detail.get("monthly") or [])],
    )


def _fmt_int(value) -> str:
    try:
        return f"{int(value or 0):,}"
    except (TypeError, ValueError):
        return "0"


def _fmt_money_cents(value, currency: str) -> str:
    try:
        return f"{currency} {int(value or 0) / 100:.2f}"
    except (TypeError, ValueError):
        return f"{currency} 0.00"


def _billing_detail_pdf_lines(detail: dict) -> list[str]:
    company = detail.get("company") or {}
    period = detail.get("period") or {}
    usage = detail.get("usage") or {}
    currency = detail.get("currency") or "EUR"
    plan = detail.get("plan") or {}
    grain = detail.get("breakdown_grain") or "monthly"
    lines = [
        f"Billing Details: {company.get('name') or '-'}",
        f"Period: {period.get('label') or '-'}",
        f"Billing Email: {company.get('billing_email') or '-'}",
        f"Billing Status: {company.get('billing_status') or '-'}",
        f"Draft Total: {_fmt_money_cents(detail.get('total_display_cents'), currency)}",
        "",
        "Plan",
    ]
    if plan:
        lines.extend([
            f"- Name: {plan.get('name') or '-'}",
            f"- Base Price: {_fmt_money_cents(plan.get('base_price_display_cents'), currency)}",
            f"- Included Devices: {_fmt_int(plan.get('included_devices'))}",
            f"- Included Positions: {_fmt_int(plan.get('included_positions'))}",
            f"- Included API Calls: {_fmt_int(plan.get('included_api_calls'))}",
            f"- Extra Device: {_fmt_money_cents(plan.get('price_per_device_display_cents'), currency)}",
            f"- Extra 1,000 Positions: {_fmt_money_cents(plan.get('price_per_1000_positions_display_cents'), currency)}",
            f"- Extra 1,000 API Calls: {_fmt_money_cents(plan.get('price_per_1000_api_calls_display_cents'), currency)}",
        ])
    else:
        lines.append("- No billing plan is assigned.")
    lines.extend([
        "",
        "Usage",
        f"- Active Devices: {_fmt_int(usage.get('active_devices'))}",
        f"- Positions: {_fmt_int(usage.get('positions'))}",
        f"- API Calls: {_fmt_int(usage.get('api_calls'))}",
    ])
    events = usage.get("events") or {}
    if events:
        lines.append("- Usage Events:")
        for metric, qty in events.items():
            lines.append(f"  - {metric}: {_fmt_int(qty)}")

    lines.extend(["", "Draft Billing Lines"])
    line_items = detail.get("line_items") or []
    if line_items:
        for item in line_items:
            lines.append(
                f"- {item.get('label') or '-'}: qty {_fmt_int(item.get('quantity'))}, "
                f"billable {_fmt_int(item.get('billable_units'))}, "
                f"{_fmt_money_cents(item.get('amount_display_cents'), currency)}"
            )
    else:
        lines.append("- No draft billing lines for this period.")

    lines.extend(["", "Daily Usage" if grain == "daily" else "Monthly Breakdown"])
    breakdown = detail.get("breakdown") or detail.get("monthly") or []
    if breakdown:
        for item in breakdown:
            item_usage = item.get("usage") or {}
            row = (
                f"- {item.get('label') or '-'}: devices {_fmt_int(item_usage.get('active_devices'))}, "
                f"positions {_fmt_int(item_usage.get('positions'))}, api {_fmt_int(item_usage.get('api_calls'))}"
            )
            if grain != "daily":
                row += f", total {_fmt_money_cents(item.get('amount_display_cents'), currency)}"
            lines.append(row)
    else:
        lines.append("- No usage found.")
    lines.append("")
    return lines


async def _result_attachments(session, schedule: ScheduledReport, user: User, data: dict) -> tuple[tempfile.TemporaryDirectory | None, list[str]]:
    attachments: list[str] = []
    tempdir = tempfile.TemporaryDirectory(prefix=f"routario_schedule_{schedule.id}_")
    root = Path(tempdir.name)
    columns = [c for c in data.get("columns", []) if not c.get("hidden") and c.get("csv") is not False]
    rows = data.get("rows", [])

    if schedule.attach_results:
        csv_path = root / f"{schedule.name.replace(' ', '_')}_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.csv"
        with csv_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow([c.get("label") or c.get("key") for c in columns])
            for row in rows:
                writer.writerow([_plain(row.get(c.get("key"))) for c in columns])
        attachments.append(str(csv_path))

        pdf_path = csv_path.with_suffix(".pdf")
        billing_details: list[dict] = []
        if schedule.report_type == "billing":
            from reports.billing import billing_detail_payload

            for row in rows:
                company_id = row.get("company_id")
                period = row.get("period_key")
                if not company_id or not period:
                    continue
                detail = await billing_detail_payload(session, user, int(company_id), str(period))
                if detail:
                    billing_details.append(detail)
        app_name, logo_path = await _pdf_branding(session, user)
        _write_schedule_pdf(
            pdf_path,
            schedule,
            user,
            data,
            columns,
            rows,
            billing_details,
            logo_path,
            app_name,
            schedule.user_timezone or user.timezone or "UTC",
        )
        attachments.append(str(pdf_path))

    if schedule.attach_documents:
        upload_root = (_PROJECT_ROOT / "web").resolve()
        seen: set[str] = set()
        for row in rows:
            for url_path in row.get("documents") or []:
                fs_path = (upload_root / str(url_path).lstrip("/")).resolve()
                if str(fs_path).startswith(str(upload_root)) and fs_path.is_file() and str(fs_path) not in seen:
                    seen.add(str(fs_path))
                    attachments.append(str(fs_path))

    if not attachments:
        tempdir.cleanup()
        return None, []
    return tempdir, attachments


async def _send_schedule_notification(session, schedule: ScheduledReport, user: User, data: dict, status: str, error_msg: str | None) -> None:
    selected = set(schedule.notification_channels or [])
    if not selected:
        return
    channels = [
        c for c in (user.notification_channels or [])
        if c.get("name") in selected and c.get("url")
    ]
    if not channels:
        return

    tempdir, attachments = await _result_attachments(session, schedule, user, data) if status == "success" else (None, [])
    title = f"Routario scheduled report: {schedule.name}"
    rows = len(data.get("rows", [])) if isinstance(data, dict) else 0
    message = (
        f"Scheduled report '{schedule.name}' completed successfully with {rows} row(s)."
        if status == "success"
        else f"Scheduled report '{schedule.name}' failed: {error_msg or 'Unknown error'}"
    )
    try:
        await asyncio.gather(
            *[
                ch.send(c["url"], title, message, attachments)
                for c in channels
                if (ch := get_channel(c["url"])) is not None
            ],
            return_exceptions=True,
        )
    finally:
        if tempdir:
            tempdir.cleanup()

async def _execute(schedule_id: int) -> None:
    db = get_db()
    async with db.get_session() as session:
        # Re-fetch within this session so updates are tracked and committed
        sched_r = await session.execute(select(ScheduledReport).where(ScheduledReport.id == schedule_id))
        sched   = sched_r.scalar_one_or_none()
        if not sched:
            return

        user_r = await session.execute(select(User).where(User.id == sched.user_id))
        user   = user_r.scalar_one_or_none()
        if not user:
            logger.warning("Schedule %s: owner %s missing", sched.id, sched.user_id)
            return

        logger.info(
            "Schedule %s (%s) starting: report=%s owner=%s (%s) date_range=%s options=%s",
            sched.id,
            sched.name,
            sched.report_type,
            user.id,
            user.username,
            sched.date_range,
            sched.report_options or {},
        )

        try:
            data        = await _run_report(session, sched, user)
            result_json = json.dumps(data, default=str)
            status      = "success"
            error_msg   = None
        except Exception as exc:
            logger.error("Schedule %s run failed: %s", sched.id, exc, exc_info=True)
            result_json = None
            status      = "failed"
            error_msg   = str(exc)

        try:
            await _send_schedule_notification(session, sched, user, data if status == "success" else {}, status, error_msg)
        except Exception as exc:
            logger.error("Schedule %s notification failed: %s", sched.id, exc, exc_info=True)

        run = ScheduledReportRun(
            schedule_id=sched.id,
            run_at=datetime.utcnow(),
            status=status,
            error_message=error_msg,
            result_json=result_json,
        )
        session.add(run)
        await session.flush()

        # Prune runs exceeding keep_runs
        all_ids_r = await session.execute(
            select(ScheduledReportRun.id)
            .where(ScheduledReportRun.schedule_id == sched.id)
            .order_by(ScheduledReportRun.run_at.desc())
        )
        all_ids = [r[0] for r in all_ids_r.all()]
        if len(all_ids) > sched.keep_runs:
            await session.execute(
                delete(ScheduledReportRun).where(
                    ScheduledReportRun.id.in_(all_ids[sched.keep_runs:])
                )
            )

        sched.last_run = datetime.utcnow()
        sched.next_run = compute_next_run(
            sched.frequency, sched.run_time, sched.day_of_week, sched.day_of_month,
            sched.user_timezone or user.timezone or "UTC",
        )
        await session.commit()
        logger.info("Schedule %s (%s): %s", sched.id, sched.name, status)


# ── Periodic task ─────────────────────────────────────────────────────────────

async def periodic_schedule_task() -> None:
    logger.info("Schedule runner started")
    while True:
        try:
            now = datetime.utcnow()
            db  = get_db()
            async with db.get_session() as session:
                due_r = await session.execute(
                    select(ScheduledReport).where(
                        ScheduledReport.is_active == True,
                        ScheduledReport.next_run  <= now,
                    )
                )
                due = due_r.scalars().all()

            for schedule in due:
                await _execute(schedule.id)
            mark_task_success("schedule_runner")

        except asyncio.CancelledError:
            break
        except Exception as exc:
            mark_task_error("schedule_runner", exc)
            logger.error("Schedule runner error: %s", exc, exc_info=True)

        await asyncio.sleep(_CHECK_INTERVAL)

    logger.info("Schedule runner stopped")
