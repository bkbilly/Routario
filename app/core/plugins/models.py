"""
Plugin System Data Models and Schemas
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class PluginManifest(BaseModel):
    """Metadata definition from plugin.json / manifest.json"""
    id: str
    name: str
    version: str = "1.0.0"
    description: Optional[str] = ""
    author: Optional[str] = ""
    category: Optional[str] = "General"
    icon: Optional[str] = "mdi-puzzle"
    icon_url: Optional[str] = None
    dependencies: List[str] = Field(default_factory=list)
    path: Optional[str] = None
    download_url: Optional[str] = None
    files: List[str] = Field(default_factory=list)
    changelog: Optional[str] = None
    min_routario_version: Optional[str] = None
    requires_restart: bool = False
    entrypoints: Dict[str, str] = Field(default_factory=dict)
    repository_url: Optional[str] = None
    repository_name: Optional[str] = None


class PluginUsageDevice(BaseModel):
    id: int
    name: str
    imei: str
    protocol: Optional[str] = None
    company_id: Optional[int] = None
    company_name: Optional[str] = None
    user_names: List[str] = Field(default_factory=list)


class PluginUsageAlertRule(BaseModel):
    device_id: int
    device_name: str
    alert_key: str
    company_name: Optional[str] = None
    user_names: List[str] = Field(default_factory=list)
    params: Dict[str, Any] = Field(default_factory=dict)


class PluginUsageReport(BaseModel):
    schedule_id: Optional[int] = None
    schedule_name: Optional[str] = None
    report_type: str
    user_id: Optional[int] = None
    user_name: Optional[str] = None


class PluginUsageIntegration(BaseModel):
    account_id: Optional[int] = None
    account_label: Optional[str] = None
    provider_id: str
    user_name: Optional[str] = None
    device_count: int = 0


class PluginUsageSummary(BaseModel):
    total_devices: int = 0
    devices: List[PluginUsageDevice] = Field(default_factory=list)
    total_alerts: int = 0
    alert_rules: List[PluginUsageAlertRule] = Field(default_factory=list)
    total_reports: int = 0
    report_schedules: List[PluginUsageReport] = Field(default_factory=list)
    total_integrations: int = 0
    integrations: List[PluginUsageIntegration] = Field(default_factory=list)
    summary_text: str = "Not in use"
    in_use: bool = False


class PluginComponents(BaseModel):
    protocols: List[str] = Field(default_factory=list)
    alerts: List[str] = Field(default_factory=list)
    reports: List[str] = Field(default_factory=list)
    integrations: List[str] = Field(default_factory=list)


class PluginInfo(BaseModel):
    id: str
    manifest: PluginManifest
    path: str
    enabled: bool = True
    is_loaded: bool = False
    load_error: Optional[str] = None
    requires_restart: bool = False
    components: PluginComponents = Field(default_factory=PluginComponents)
    usage: Optional[PluginUsageSummary] = None
    installed_at: Optional[str] = None
    update_available: Optional[str] = None
    latest_manifest: Optional[PluginManifest] = None


class RepositoryConfig(BaseModel):
    id: str
    name: str
    url: str
    subfolder: Optional[str] = None
    manifest_url: str
    enabled: bool = True
    last_synced_at: Optional[str] = None
    error: Optional[str] = None
    plugin_count: int = 0


class RepositoryCreateRequest(BaseModel):
    name: Optional[str] = None
    url: str
    subfolder: Optional[str] = None


class PluginInstallRequest(BaseModel):
    plugin_id: Optional[str] = None
    download_url: Optional[str] = None
    repository_url: Optional[str] = None
