"""
Offline Map Tile Server Routes
Enables serving and managing offline raster and vector map tiles across multiple formats:
- MBTiles (.mbtiles) — SQLite single-file tile pyramids
- GeoPackage (.gpkg) — OGC standard SQLite geospatial tile matrices
- PMTiles (.pmtiles) — Cloud-native single-file tile archives
- Zipped XYZ (.zip)   — Compressed standard {z}/{x}/{y} tile folder structures
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import sqlite3
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel

from core.audit import write_audit_log
from core.auth import get_current_user, require_admin
from models import User

try:
    from pmtiles.reader import Reader as PMTilesReader, MmapSource as PMTilesMmapSource
    from pmtiles.tile import TileType as PMTilesTileType
    HAS_PMTILES = True
except ImportError:
    HAS_PMTILES = False

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tiles", tags=["tiles"])

# Storage directory for offline map files
TILES_DIR = Path(os.getenv("OFFLINE_TILES_DIR", "data/tiles")).resolve()
MANIFEST_PATH = TILES_DIR / "manifest.json"

SUPPORTED_EXTENSIONS = {".mbtiles", ".pmtiles", ".gpkg", ".zip"}

# Thread-local storage for open read-only connections and file handles
_local = threading.local()
_manifest_lock = threading.Lock()

# 1x1 transparent PNG fallback
TRANSPARENT_1X1_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
    b"\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)


# ── Schemas ───────────────────────────────────────────────────────────────────

class MapUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None
    is_default: Optional[bool] = None


class OfflineMapPublicInfo(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    format: str
    container_type: Optional[str] = "mbtiles"
    min_zoom: Optional[int] = None
    max_zoom: Optional[int] = None
    bounds: Optional[List[float]] = None
    center: Optional[List[float]] = None
    is_default: bool = False
    tile_url: str


class OfflineMapAdminInfo(OfflineMapPublicInfo):
    filename: str
    size_bytes: int
    enabled: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ensure_tiles_dir() -> Path:
    """Ensure tiles storage directory exists."""
    TILES_DIR.mkdir(parents=True, exist_ok=True)
    return TILES_DIR


def _sanitize_id(name: str) -> str:
    """Generate safe identifier from name or filename."""
    stem = Path(name).stem.lower().strip()
    clean = re.sub(r"[^a-z0-9_-]", "_", stem)
    return clean[:50] or "map"


def _detect_container_type(path: Path) -> str:
    """Identify container type from file extension."""
    ext = path.suffix.lower()
    if ext == ".mbtiles":
        return "mbtiles"
    if ext == ".pmtiles":
        return "pmtiles"
    if ext == ".gpkg":
        return "gpkg"
    if ext == ".zip":
        return "zip"
    return "unknown"


def _web_mercator_to_wgs84(x: float, y: float) -> Tuple[float, float]:
    """Convert EPSG:3857 coordinates to EPSG:4326 (longitude, latitude)."""
    lon = (x / 20037508.342789244) * 180.0
    lat = (math.atan(math.exp(y / 20037508.342789244 * math.pi)) * 360.0 / math.pi) - 90.0
    lon = max(-180.0, min(180.0, lon))
    lat = max(-85.05112878, min(85.05112878, lat))
    return round(lon, 6), round(lat, 6)


def _load_manifest() -> Dict[str, Dict[str, Any]]:
    """Load manifest dictionary from disk."""
    _ensure_tiles_dir()
    if not MANIFEST_PATH.exists():
        return {}
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read tiles manifest: {e}")
        return {}


def _save_manifest(data: Dict[str, Dict[str, Any]]) -> None:
    """Safely persist manifest dictionary to disk."""
    _ensure_tiles_dir()
    with _manifest_lock:
        temp_path = TILES_DIR / "manifest.json.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        temp_path.replace(MANIFEST_PATH)


def _get_connection(db_path: Path) -> sqlite3.Connection:
    """Retrieve or create a thread-local read-only sqlite connection."""
    if not hasattr(_local, "connections"):
        _local.connections = {}
    path_key = str(db_path.resolve())
    conn = _local.connections.get(path_key)
    if conn is None:
        uri = f"file:{path_key}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        _local.connections[path_key] = conn
    return conn


def _get_pmtiles_reader(path: Path) -> Any:
    """Retrieve or create a thread-local memory-mapped PMTiles reader."""
    if not HAS_PMTILES:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="PMTiles support is not available on this server (pmtiles library missing)",
        )
    if not hasattr(_local, "pmtiles_readers"):
        _local.pmtiles_readers = {}
    path_key = str(path.resolve())
    entry = _local.pmtiles_readers.get(path_key)
    if entry is None:
        f = open(path, "rb")
        source = PMTilesMmapSource(f)
        reader = PMTilesReader(source)
        _local.pmtiles_readers[path_key] = (reader, f)
        return reader
    return entry[0]


def _get_zip_reader(path: Path) -> zipfile.ZipFile:
    """Retrieve or create a thread-local open ZipFile handle."""
    if not hasattr(_local, "zip_readers"):
        _local.zip_readers = {}
    path_key = str(path.resolve())
    zf = _local.zip_readers.get(path_key)
    if zf is None:
        zf = zipfile.ZipFile(path, "r")
        _local.zip_readers[path_key] = zf
    return zf


def _close_connections_for_path(path: Path) -> None:
    """Close any cached connections or file handles for a path in current thread."""
    path_key = str(path.resolve())
    if hasattr(_local, "connections"):
        conn = _local.connections.pop(path_key, None)
        if conn:
            try:
                conn.close()
            except Exception:
                pass
    if hasattr(_local, "pmtiles_readers"):
        entry = _local.pmtiles_readers.pop(path_key, None)
        if entry:
            try:
                entry[1].close()
            except Exception:
                pass
    if hasattr(_local, "zip_readers"):
        zf = _local.zip_readers.pop(path_key, None)
        if zf:
            try:
                zf.close()
            except Exception:
                pass


# ── Metadata Extraction Dispatchers ──────────────────────────────────────────

def _read_mbtiles_metadata(db_path: Path) -> Dict[str, Any]:
    """Inspect and extract metadata from an .mbtiles SQLite file."""
    metadata: Dict[str, Any] = {}
    uri = f"file:{db_path.resolve()}?mode=ro"
    with sqlite3.connect(uri, uri=True, check_same_thread=False) as conn:
        cursor = conn.cursor()

        # Integrity check
        cursor.execute("PRAGMA quick_check")
        check_result = cursor.fetchone()
        if not check_result or check_result[0] != "ok":
            raise ValueError(f"Corrupt MBTiles SQLite database: {check_result}")

        # 1. Read metadata table if present
        try:
            cursor.execute("SELECT name, value FROM metadata")
            for name, value in cursor.fetchall():
                if name:
                    metadata[name.lower().strip()] = value
        except Exception:
            pass

        # 2. Determine zoom range if missing from metadata
        if "minzoom" not in metadata or "maxzoom" not in metadata:
            try:
                cursor.execute("SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles")
                row = cursor.fetchone()
                if row and row[0] is not None:
                    metadata.setdefault("minzoom", str(row[0]))
                    metadata.setdefault("maxzoom", str(row[1]))
            except Exception:
                pass

        # 3. Format detection
        detected_format = (metadata.get("format") or "").lower().strip()
        if not detected_format:
            try:
                cursor.execute("SELECT tile_data FROM tiles LIMIT 1")
                sample = cursor.fetchone()
                if sample and sample[0]:
                    sample_bytes = bytes(sample[0])
                    if sample_bytes[:8] == b"\x89PNG\r\n\x1a\n":
                        detected_format = "png"
                    elif sample_bytes[:3] == b"\xff\xd8\xff":
                        detected_format = "jpg"
                    elif sample_bytes[:4] == b"RIFF" and sample_bytes[8:12] == b"WEBP":
                        detected_format = "webp"
                    elif sample_bytes[:2] == b"\x1f\x8b":
                        detected_format = "pbf"
            except Exception:
                pass

        metadata["format"] = detected_format or "png"

    return metadata


def _read_gpkg_metadata(db_path: Path) -> Dict[str, Any]:
    """Inspect and extract metadata from an OGC GeoPackage (.gpkg) file."""
    metadata: Dict[str, Any] = {}
    uri = f"file:{db_path.resolve()}?mode=ro"
    with sqlite3.connect(uri, uri=True, check_same_thread=False) as conn:
        cursor = conn.cursor()

        # Integrity check
        cursor.execute("PRAGMA quick_check")
        check_result = cursor.fetchone()
        if not check_result or check_result[0] != "ok":
            raise ValueError(f"Corrupt GeoPackage SQLite database: {check_result}")

        tile_table: Optional[str] = None
        srs_id: int = 4326

        # 1. Read gpkg_contents if present
        try:
            cursor.execute(
                "SELECT table_name, identifier, description, min_x, min_y, max_x, max_y, srs_id "
                "FROM gpkg_contents WHERE lower(data_type) = 'tiles' LIMIT 1"
            )
            row = cursor.fetchone()
            if row:
                tile_table, identifier, desc, min_x, min_y, max_x, max_y, srs = row
                if identifier:
                    metadata["name"] = str(identifier)
                if desc:
                    metadata["description"] = str(desc)
                srs_id = int(srs) if srs is not None else 4326

                if None not in (min_x, min_y, max_x, max_y):
                    if srs_id == 3857 or abs(min_x) > 180 or abs(max_x) > 180:
                        w_min_lon, w_min_lat = _web_mercator_to_wgs84(min_x, min_y)
                        w_max_lon, w_max_lat = _web_mercator_to_wgs84(max_x, max_y)
                        metadata["bounds"] = f"{w_min_lon},{w_min_lat},{w_max_lon},{w_max_lat}"
                    else:
                        metadata["bounds"] = f"{min_x},{min_y},{max_x},{max_y}"
        except Exception as e:
            logger.debug(f"Could not read gpkg_contents: {e}")

        # 2. Locate tile table fallback
        if not tile_table:
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = [r[0] for r in cursor.fetchall() if not r[0].startswith("gpkg_")]
            for t in tables:
                cursor.execute(f"PRAGMA table_info({t})")
                cols = {c[1].lower() for c in cursor.fetchall()}
                if {"zoom_level", "tile_column", "tile_row", "tile_data"}.issubset(cols):
                    tile_table = t
                    break

        if not tile_table:
            raise ValueError("No tile matrix table found in GeoPackage file")

        metadata["tile_table"] = tile_table

        # 3. Zoom range
        try:
            cursor.execute(f"SELECT MIN(zoom_level), MAX(zoom_level) FROM {tile_table}")
            row = cursor.fetchone()
            if row and row[0] is not None:
                metadata["minzoom"] = str(row[0])
                metadata["maxzoom"] = str(row[1])
        except Exception:
            pass

        # 4. Format detection
        detected_format = "png"
        try:
            cursor.execute(f"SELECT tile_data FROM {tile_table} LIMIT 1")
            sample = cursor.fetchone()
            if sample and sample[0]:
                sample_bytes = bytes(sample[0])
                if sample_bytes[:8] == b"\x89PNG\r\n\x1a\n":
                    detected_format = "png"
                elif sample_bytes[:3] == b"\xff\xd8\xff":
                    detected_format = "jpg"
                elif sample_bytes[:4] == b"RIFF" and sample_bytes[8:12] == b"WEBP":
                    detected_format = "webp"
                elif sample_bytes[:2] == b"\x1f\x8b":
                    detected_format = "pbf"
        except Exception:
            pass

        metadata["format"] = detected_format

    return metadata


def _read_pmtiles_metadata(pmtiles_path: Path) -> Dict[str, Any]:
    """Inspect and extract metadata from a PMTiles (.pmtiles) file."""
    if not HAS_PMTILES:
        raise ValueError("PMTiles library is not installed on this server")

    metadata: Dict[str, Any] = {}
    with open(pmtiles_path, "rb") as f:
        source = PMTilesMmapSource(f)
        reader = PMTilesReader(source)
        header = reader.header()

        metadata["minzoom"] = str(header.get("min_zoom", 0))
        metadata["maxzoom"] = str(header.get("max_zoom", 18))

        min_lon = header.get("min_lon_e7", -1800000000) / 10000000.0
        min_lat = header.get("min_lat_e7", -850000000) / 10000000.0
        max_lon = header.get("max_lon_e7", 1800000000) / 10000000.0
        max_lat = header.get("max_lat_e7", 850000000) / 10000000.0
        metadata["bounds"] = f"{min_lon:.6f},{min_lat:.6f},{max_lon:.6f},{max_lat:.6f}"

        c_lon = header.get("center_lon_e7", 0) / 10000000.0
        c_lat = header.get("center_lat_e7", 0) / 10000000.0
        c_zoom = header.get("center_zoom", 0)
        metadata["center"] = f"{c_lon:.6f},{c_lat:.6f},{c_zoom}"

        tt = header.get("tile_type")
        if tt == PMTilesTileType.MVT:
            fmt = "pbf"
        elif tt == PMTilesTileType.PNG:
            fmt = "png"
        elif tt == PMTilesTileType.JPEG:
            fmt = "jpg"
        elif tt == PMTilesTileType.WEBP:
            fmt = "webp"
        elif tt == PMTilesTileType.AVIF:
            fmt = "avif"
        else:
            fmt = "png"
        metadata["format"] = fmt

        try:
            user_meta = reader.metadata()
            if isinstance(user_meta, dict):
                if user_meta.get("name"):
                    metadata["name"] = str(user_meta["name"])
                if user_meta.get("description"):
                    metadata["description"] = str(user_meta["description"])
                if user_meta.get("format"):
                    metadata["format"] = str(user_meta["format"]).lower()
        except Exception:
            pass

    return metadata


def _read_zip_metadata(zip_path: Path) -> Dict[str, Any]:
    """Inspect and extract metadata from a zipped XYZ tile archive (.zip)."""
    metadata: Dict[str, Any] = {}
    pattern = re.compile(r"^(.*?)(?:^|/)(\d+)/(\d+)/(\d+)\.(png|jpg|jpeg|webp|pbf)$", re.IGNORECASE)

    with zipfile.ZipFile(zip_path, "r") as zf:
        bad_file = zf.testzip()
        if bad_file:
            raise ValueError(f"Corrupt member in zip archive: {bad_file}")

        namelist = zf.namelist()
        zooms: List[int] = []
        formats: set[str] = set()
        detected_prefix: str = ""

        # Check for embedded metadata.json or tilejson.json
        meta_candidates = [
            n for n in namelist if n.lower().endswith("metadata.json") or n.lower().endswith("tilejson.json")
        ]
        if meta_candidates:
            try:
                raw_json = zf.read(meta_candidates[0]).decode("utf-8")
                loaded = json.loads(raw_json)
                if isinstance(loaded, dict):
                    if loaded.get("name"):
                        metadata["name"] = str(loaded["name"])
                    if loaded.get("description"):
                        metadata["description"] = str(loaded["description"])
                    if loaded.get("format"):
                        metadata["format"] = str(loaded["format"]).lower()
                    if loaded.get("minzoom") is not None:
                        metadata["minzoom"] = str(loaded["minzoom"])
                    if loaded.get("maxzoom") is not None:
                        metadata["maxzoom"] = str(loaded["maxzoom"])
                    if loaded.get("bounds"):
                        b = loaded["bounds"]
                        if isinstance(b, list) and len(b) == 4:
                            metadata["bounds"] = ",".join(str(x) for x in b)
                        elif isinstance(b, str):
                            metadata["bounds"] = b
            except Exception:
                pass

        for name in namelist:
            m = pattern.match(name)
            if m:
                p, z_str, _, _, ext = m.groups()
                zooms.append(int(z_str))
                formats.add(ext.lower())
                if not detected_prefix and p:
                    detected_prefix = p if p.endswith("/") else f"{p}/"

        if not zooms:
            raise ValueError("No tile images matching '{z}/{x}/{y}.(png|jpg|webp|pbf)' found in zip archive")

        metadata.setdefault("minzoom", str(min(zooms)))
        metadata.setdefault("maxzoom", str(max(zooms)))
        metadata["prefix"] = detected_prefix

        if not metadata.get("format"):
            if "png" in formats:
                metadata["format"] = "png"
            elif "jpg" in formats or "jpeg" in formats:
                metadata["format"] = "jpg"
            elif "webp" in formats:
                metadata["format"] = "webp"
            elif "pbf" in formats:
                metadata["format"] = "pbf"
            else:
                metadata["format"] = "png"

    return metadata


def _read_map_metadata(path: Path, container_type: Optional[str] = None) -> Dict[str, Any]:
    """Universal dispatcher to extract metadata across all supported formats."""
    ctype = container_type or _detect_container_type(path)
    if ctype == "mbtiles":
        meta = _read_mbtiles_metadata(path)
    elif ctype == "gpkg":
        meta = _read_gpkg_metadata(path)
    elif ctype == "pmtiles":
        meta = _read_pmtiles_metadata(path)
    elif ctype == "zip":
        meta = _read_zip_metadata(path)
    else:
        raise ValueError(f"Unsupported format '{path.suffix}'. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")

    meta["container_type"] = ctype
    return meta


def _parse_bounds(bounds_str: Optional[str]) -> Optional[List[float]]:
    """Parse comma-separated 'min_lon,min_lat,max_lon,max_lat' into float list."""
    if not bounds_str:
        return None
    try:
        parts = [float(x.strip()) for x in bounds_str.split(",") if x.strip()]
        if len(parts) == 4:
            return parts
    except Exception:
        pass
    return None


def _parse_center(center_str: Optional[str]) -> Optional[List[float]]:
    """Parse comma-separated 'lon,lat,zoom' into float list."""
    if not center_str:
        return None
    try:
        parts = [float(x.strip()) for x in center_str.split(",") if x.strip()]
        if len(parts) in (2, 3):
            return parts
    except Exception:
        pass
    return None


def _media_type_for_format(fmt: str, data: Optional[bytes] = None) -> str:
    """Return matching HTTP media type for tile format."""
    if data:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return "image/png"
        if data[:3] == b"\xff\xd8\xff":
            return "image/jpeg"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        if data[:2] == b"\x1f\x8b":
            return "application/x-protobuf"
    fmt_clean = (fmt or "").lower()
    if fmt_clean in ("jpg", "jpeg"):
        return "image/jpeg"
    if fmt_clean == "webp":
        return "image/webp"
    if fmt_clean == "pbf":
        return "application/x-protobuf"
    return "image/png"


def _fetch_tile_bytes(map_info: Dict[str, Any], file_path: Path, z: int, x: int, y: int) -> Optional[bytes]:
    """Retrieve raw tile binary data across all supported container formats."""
    ctype = map_info.get("container_type") or _detect_container_type(file_path)

    # 1. MBTiles (SQLite)
    if ctype == "mbtiles":
        conn = _get_connection(file_path)
        cursor = conn.cursor()
        tms_y = (1 << z) - 1 - y
        cursor.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            (z, x, tms_y),
        )
        row = cursor.fetchone()
        if row and row[0]:
            return bytes(row[0])
        cursor.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            (z, x, y),
        )
        row = cursor.fetchone()
        if row and row[0]:
            return bytes(row[0])
        return None

    # 2. GeoPackage (SQLite)
    elif ctype == "gpkg":
        conn = _get_connection(file_path)
        cursor = conn.cursor()
        tile_table = map_info.get("tile_table") or "tiles"
        tms_y = (1 << z) - 1 - y
        try:
            # Standard GeoPackage uses top-left XYZ row
            cursor.execute(
                f"SELECT tile_data FROM {tile_table} WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
                (z, x, y),
            )
            row = cursor.fetchone()
            if row and row[0]:
                return bytes(row[0])
            # Fallback for inverted TMS row
            cursor.execute(
                f"SELECT tile_data FROM {tile_table} WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
                (z, x, tms_y),
            )
            row = cursor.fetchone()
            if row and row[0]:
                return bytes(row[0])
        except Exception as e:
            logger.error(f"[OfflineTiles] GPKG query failed on {tile_table}: {e}")
        return None

    # 3. PMTiles (Binary archive)
    elif ctype == "pmtiles":
        reader = _get_pmtiles_reader(file_path)
        tile_data = reader.get(z, x, y)
        if tile_data:
            return bytes(tile_data)
        return None

    # 4. Zipped XYZ (.zip archive)
    elif ctype == "zip":
        zf = _get_zip_reader(file_path)
        prefix = map_info.get("prefix", "")
        fmt = map_info.get("format", "png")
        tms_y = (1 << z) - 1 - y

        exts_to_try = [fmt]
        for extra in ("png", "jpg", "jpeg", "webp", "pbf"):
            if extra not in exts_to_try:
                exts_to_try.append(extra)

        for cur_ext in exts_to_try:
            # 1. Standard XYZ path: {prefix}{z}/{x}/{y}.{ext}
            key = f"{prefix}{z}/{x}/{y}.{cur_ext}"
            try:
                return zf.read(key)
            except KeyError:
                pass
            # 2. TMS inverted path: {prefix}{z}/{x}/{tms_y}.{ext}
            key_tms = f"{prefix}{z}/{x}/{tms_y}.{cur_ext}"
            try:
                return zf.read(key_tms)
            except KeyError:
                pass
        return None

    return None


def _sync_disk_files(manifest: Dict[str, Dict[str, Any]]) -> bool:
    """
    Scan TILES_DIR for supported map files (.mbtiles, .pmtiles, .gpkg, .zip).
    Auto-registers new files and cleans up deleted ones. Returns True if modified.
    """
    _ensure_tiles_dir()
    changed = False

    existing_files: Dict[str, Path] = {}
    for ext in SUPPORTED_EXTENSIONS:
        for p in TILES_DIR.glob(f"*{ext}"):
            if p.is_file():
                existing_files[p.name] = p

    # Clean up entries whose files were deleted from disk
    missing_ids = [map_id for map_id, item in manifest.items() if item.get("filename") not in existing_files]
    for mid in missing_ids:
        del manifest[mid]
        changed = True

    # Register new files found on disk
    known_filenames = {item.get("filename") for item in manifest.values()}
    for fname, fpath in existing_files.items():
        if fname in known_filenames:
            for mid, item in manifest.items():
                if item.get("filename") == fname:
                    cur_size = fpath.stat().st_size
                    if item.get("size_bytes") != cur_size:
                        item["size_bytes"] = cur_size
                        changed = True
            continue

        try:
            meta = _read_map_metadata(fpath)
            map_id = _sanitize_id(fname)
            orig_id = map_id
            counter = 1
            while map_id in manifest:
                map_id = f"{orig_id}_{counter}"
                counter += 1

            min_z = int(meta["minzoom"]) if "minzoom" in meta and str(meta["minzoom"]).isdigit() else 0
            max_z = int(meta["maxzoom"]) if "maxzoom" in meta and str(meta["maxzoom"]).isdigit() else 18
            now_iso = datetime.now(timezone.utc).isoformat()

            manifest[map_id] = {
                "id": map_id,
                "filename": fname,
                "name": meta.get("name") or Path(fname).stem.replace("_", " ").title(),
                "description": meta.get("description") or f"Offline map from {fname}",
                "format": meta.get("format", "png"),
                "container_type": meta.get("container_type", _detect_container_type(fpath)),
                "tile_table": meta.get("tile_table"),
                "prefix": meta.get("prefix", ""),
                "min_zoom": min_z,
                "max_zoom": max_z,
                "bounds": _parse_bounds(meta.get("bounds")),
                "center": _parse_center(meta.get("center")),
                "size_bytes": fpath.stat().st_size,
                "enabled": True,
                "is_default": len(manifest) == 0,
                "created_at": now_iso,
                "updated_at": now_iso,
            }
            changed = True
            logger.info(f"[OfflineTiles] Auto-registered '{fname}' as offline map '{map_id}' ({meta.get('container_type')})")
        except Exception as e:
            logger.error(f"[OfflineTiles] Could not index '{fname}': {e}")

    return changed


# ── Public Endpoints ──────────────────────────────────────────────────────────

@router.get("/maps", response_model=List[OfflineMapPublicInfo])
async def list_active_offline_maps() -> List[OfflineMapPublicInfo]:
    """
    List all enabled offline maps for the dashboard map layer switcher.
    Available to all users.
    """
    manifest = _load_manifest()
    if _sync_disk_files(manifest):
        _save_manifest(manifest)

    results: List[OfflineMapPublicInfo] = []
    for mid, item in manifest.items():
        if not item.get("enabled", True):
            continue
        fmt = item.get("format", "png")
        ext = "pbf" if fmt == "pbf" else "png"
        results.append(
            OfflineMapPublicInfo(
                id=mid,
                name=item.get("name") or mid,
                description=item.get("description"),
                format=fmt,
                container_type=item.get("container_type", "mbtiles"),
                min_zoom=item.get("min_zoom"),
                max_zoom=item.get("max_zoom"),
                bounds=item.get("bounds"),
                center=item.get("center"),
                is_default=bool(item.get("is_default", False)),
                tile_url=f"/api/tiles/{mid}/{{z}}/{{x}}/{{y}}.{ext}",
            )
        )
    return results


# ── Super Admin Management Endpoints ──────────────────────────────────────────

@router.get("/maps/admin", response_model=List[OfflineMapAdminInfo])
async def list_all_offline_maps_admin(
    current_user: User = Depends(require_admin),
) -> List[OfflineMapAdminInfo]:
    """
    List all installed offline maps with detailed administrative stats.
    Requires Super Admin access.
    """
    manifest = _load_manifest()
    if _sync_disk_files(manifest):
        _save_manifest(manifest)

    results: List[OfflineMapAdminInfo] = []
    for mid, item in manifest.items():
        fmt = item.get("format", "png")
        ext = "pbf" if fmt == "pbf" else "png"
        results.append(
            OfflineMapAdminInfo(
                id=mid,
                filename=item.get("filename", ""),
                name=item.get("name") or mid,
                description=item.get("description"),
                format=fmt,
                container_type=item.get("container_type", "mbtiles"),
                min_zoom=item.get("min_zoom"),
                max_zoom=item.get("max_zoom"),
                bounds=item.get("bounds"),
                center=item.get("center"),
                size_bytes=item.get("size_bytes", 0),
                enabled=bool(item.get("enabled", True)),
                is_default=bool(item.get("is_default", False)),
                created_at=item.get("created_at"),
                updated_at=item.get("updated_at"),
                tile_url=f"/api/tiles/{mid}/{{z}}/{{x}}/{{y}}.{ext}",
            )
        )
    results.sort(key=lambda x: x.name.lower())
    return results


@router.post("/maps/scan", response_model=List[OfflineMapAdminInfo])
async def scan_offline_maps_directory(
    request: Request,
    current_user: User = Depends(require_admin),
) -> List[OfflineMapAdminInfo]:
    """
    Rescan data/tiles directory on the host to auto-detect manually placed files.
    """
    manifest = _load_manifest()
    _sync_disk_files(manifest)
    _save_manifest(manifest)

    await write_audit_log(
        "tiles.directory_scanned",
        actor=current_user,
        target_type="offline_tiles",
        request=request,
        metadata={"total_maps": len(manifest)},
    )
    return await list_all_offline_maps_admin(current_user=current_user)


@router.post("/maps/upload", response_model=OfflineMapAdminInfo)
async def upload_offline_map(
    request: Request,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    enabled: bool = Form(True),
    is_default: bool = Form(False),
    current_user: User = Depends(require_admin),
) -> OfflineMapAdminInfo:
    """
    Upload a new offline map file (.mbtiles, .pmtiles, .gpkg, .zip).
    Streams upload in chunks to prevent large memory spikes.
    """
    filename = Path(file.filename or "").name
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{ext}'. Supported formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
        )

    _ensure_tiles_dir()
    clean_filename = re.sub(r"[^a-zA-Z0-9_.-]", "_", filename)
    target_path = TILES_DIR / clean_filename
    temp_target = TILES_DIR / f"{clean_filename}.upload.tmp"

    try:
        with open(temp_target, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                buffer.write(chunk)

        # Validate file integrity and extract metadata
        try:
            expected_ctype = _detect_container_type(Path(clean_filename))
            meta = _read_map_metadata(temp_target, container_type=expected_ctype)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"The uploaded file is not a valid {ext.upper()} offline map: {e}",
            )

        _close_connections_for_path(target_path)
        temp_target.replace(target_path)

        manifest = _load_manifest()
        map_id = _sanitize_id(clean_filename)

        min_z = int(meta["minzoom"]) if "minzoom" in meta and str(meta["minzoom"]).isdigit() else 0
        max_z = int(meta["maxzoom"]) if "maxzoom" in meta and str(meta["maxzoom"]).isdigit() else 18
        now_iso = datetime.now(timezone.utc).isoformat()

        if is_default:
            for item in manifest.values():
                item["is_default"] = False

        manifest[map_id] = {
            "id": map_id,
            "filename": clean_filename,
            "name": name.strip() if name and name.strip() else (meta.get("name") or Path(clean_filename).stem.replace("_", " ").title()),
            "description": description.strip() if description and description.strip() else (meta.get("description") or f"Offline map {clean_filename}"),
            "format": meta.get("format", "png"),
            "container_type": meta.get("container_type", _detect_container_type(target_path)),
            "tile_table": meta.get("tile_table"),
            "prefix": meta.get("prefix", ""),
            "min_zoom": min_z,
            "max_zoom": max_z,
            "bounds": _parse_bounds(meta.get("bounds")),
            "center": _parse_center(meta.get("center")),
            "size_bytes": target_path.stat().st_size,
            "enabled": enabled,
            "is_default": is_default or len(manifest) == 0,
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        _save_manifest(manifest)

        await write_audit_log(
            "tiles.map_uploaded",
            actor=current_user,
            target_type="offline_map",
            target_id=map_id,
            request=request,
            metadata={"filename": clean_filename, "format": manifest[map_id]["format"], "container": manifest[map_id]["container_type"]},
        )

        item = manifest[map_id]
        fmt = item.get("format", "png")
        ext_serve = "pbf" if fmt == "pbf" else "png"
        return OfflineMapAdminInfo(
            id=map_id,
            filename=item["filename"],
            name=item["name"],
            description=item.get("description"),
            format=fmt,
            container_type=item.get("container_type", "mbtiles"),
            min_zoom=item.get("min_zoom"),
            max_zoom=item.get("max_zoom"),
            bounds=item.get("bounds"),
            center=item.get("center"),
            size_bytes=item["size_bytes"],
            enabled=item["enabled"],
            is_default=item["is_default"],
            created_at=item["created_at"],
            updated_at=item["updated_at"],
            tile_url=f"/api/tiles/{map_id}/{{z}}/{{x}}/{{y}}.{ext_serve}",
        )
    except HTTPException:
        if temp_target.exists():
            temp_target.unlink()
        raise
    except Exception as e:
        if temp_target.exists():
            temp_target.unlink()
        logger.error(f"[OfflineTiles] Upload failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to process uploaded file: {e}",
        )


@router.patch("/maps/{map_id}", response_model=OfflineMapAdminInfo)
async def update_offline_map(
    map_id: str,
    data: MapUpdateRequest,
    request: Request,
    current_user: User = Depends(require_admin),
) -> OfflineMapAdminInfo:
    """Update offline map metadata or status."""
    manifest = _load_manifest()
    if map_id not in manifest:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Offline map '{map_id}' not found",
        )

    item = manifest[map_id]
    if data.name is not None and data.name.strip():
        item["name"] = data.name.strip()
    if data.description is not None:
        item["description"] = data.description.strip()
    if data.enabled is not None:
        item["enabled"] = bool(data.enabled)
    if data.is_default is not None:
        if data.is_default:
            for k, m in manifest.items():
                m["is_default"] = (k == map_id)
        else:
            item["is_default"] = False

    item["updated_at"] = datetime.now(timezone.utc).isoformat()
    _save_manifest(manifest)

    await write_audit_log(
        "tiles.map_updated",
        actor=current_user,
        target_type="offline_map",
        target_id=map_id,
        request=request,
        metadata={"name": item["name"], "enabled": item["enabled"], "is_default": item["is_default"]},
    )

    fmt = item.get("format", "png")
    ext = "pbf" if fmt == "pbf" else "png"
    return OfflineMapAdminInfo(
        id=map_id,
        filename=item["filename"],
        name=item["name"],
        description=item.get("description"),
        format=fmt,
        container_type=item.get("container_type", "mbtiles"),
        min_zoom=item.get("min_zoom"),
        max_zoom=item.get("max_zoom"),
        bounds=item.get("bounds"),
        center=item.get("center"),
        size_bytes=item.get("size_bytes", 0),
        enabled=item["enabled"],
        is_default=item["is_default"],
        created_at=item["created_at"],
        updated_at=item["updated_at"],
        tile_url=f"/api/tiles/{map_id}/{{z}}/{{x}}/{{y}}.{ext}",
    )


@router.delete("/maps/{map_id}")
async def delete_offline_map(
    map_id: str,
    request: Request,
    current_user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Permanently delete an offline map file and unregister it."""
    manifest = _load_manifest()
    if map_id not in manifest:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Offline map '{map_id}' not found",
        )

    item = manifest.pop(map_id)
    filename = item.get("filename")
    target_path = TILES_DIR / filename if filename else None

    if target_path and target_path.exists():
        _close_connections_for_path(target_path)
        try:
            target_path.unlink()
        except Exception as e:
            logger.warning(f"Failed to unlink file '{target_path}': {e}")

    _save_manifest(manifest)

    await write_audit_log(
        "tiles.map_deleted",
        actor=current_user,
        target_type="offline_map",
        target_id=map_id,
        request=request,
        metadata={"filename": filename},
    )

    return {"status": "ok", "deleted_map_id": map_id}


# ── Universal Tile Serving Endpoint ───────────────────────────────────────────

@router.get("/{map_id}/{z}/{x}/{y}")
@router.get("/{map_id}/{z}/{x}/{y}.png")
@router.get("/{map_id}/{z}/{x}/{y}.jpg")
@router.get("/{map_id}/{z}/{x}/{y}.jpeg")
@router.get("/{map_id}/{z}/{x}/{y}.webp")
@router.get("/{map_id}/{z}/{x}/{y}.pbf")
async def serve_tile(
    map_id: str,
    z: int,
    x: int,
    y: int,
    blank: bool = Query(False, description="Return transparent 1x1 png instead of 404"),
) -> Response:
    """
    Serve raw tile binary data from the specified offline map.
    Dispatches transparently across MBTiles, PMTiles, GeoPackage, and Zipped XYZ archives.
    """
    manifest = _load_manifest()
    map_info = manifest.get(map_id)
    if not map_info or not map_info.get("enabled", True):
        if blank:
            return Response(content=TRANSPARENT_1X1_PNG, media_type="image/png")
        raise HTTPException(status_code=404, detail="Map layer not available")

    filename = map_info.get("filename")
    if not filename:
        raise HTTPException(status_code=404, detail="Map filename missing")

    file_path = TILES_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Map file missing from disk")

    try:
        tile_data = _fetch_tile_bytes(map_info, file_path, z, x, y)
    except Exception as e:
        logger.error(f"[OfflineTiles] Fetch error for {map_id} {z}/{x}/{y}: {e}")
        if blank:
            return Response(content=TRANSPARENT_1X1_PNG, media_type="image/png")
        raise HTTPException(status_code=500, detail="Tile retrieval error")

    if not tile_data:
        if blank:
            return Response(content=TRANSPARENT_1X1_PNG, media_type="image/png")
        raise HTTPException(status_code=404, detail="Tile not found")

    fmt = map_info.get("format", "png")
    media_type = _media_type_for_format(fmt, tile_data)

    headers = {
        "Cache-Control": "public, max-age=604800, immutable",
    }
    if media_type == "application/x-protobuf" and tile_data[:2] == b"\x1f\x8b":
        headers["Content-Encoding"] = "gzip"

    return Response(content=tile_data, media_type=media_type, headers=headers)
