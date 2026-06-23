"""
Report registry.

Automatically discovers modules in this package that expose a module-level
`report` object with a `definition`.
"""
from importlib import import_module
from pathlib import Path

from reports.base import Report

REPORT_REGISTRY: dict[str, Report] = {}


def _discover() -> None:
    pkg_dir = Path(__file__).parent
    for path in sorted(pkg_dir.glob("*.py")):
        if path.name in {"__init__.py", "base.py", "common.py"}:
            continue
        mod = import_module(f"{__name__}.{path.stem}")
        report = getattr(mod, "report", None)
        if isinstance(report, Report):
            REPORT_REGISTRY[report.definition.key] = report


_discover()


def get_report(key: str) -> Report | None:
    return REPORT_REGISTRY.get(key)


def get_report_definitions(user) -> list[dict]:
    order = ["summary", "trips", "daily", "drivers", "billing", "logbook", "geofences", "users", "sensors", "alerts"]
    definitions = []
    for report in REPORT_REGISTRY.values():
        public = report.definition.public(user)
        if public:
            definitions.append(public)
    return sorted(definitions, key=lambda d: order.index(d["key"]) if d["key"] in order else len(order))


def valid_report_types() -> set[str]:
    return set(REPORT_REGISTRY)
