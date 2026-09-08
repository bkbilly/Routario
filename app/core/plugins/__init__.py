"""
Routario Plugin System
"""
from core.plugins.models import (
    PluginManifest,
    PluginInfo,
    PluginComponents,
    PluginUsageSummary,
    RepositoryConfig,
)
from core.plugins.manager import get_plugin_manager, load_all_plugins
from core.plugins.repositories import (
    get_configured_repositories,
    add_repository,
    remove_repository,
    fetch_aggregated_catalog,
)
from core.plugins.installer import (
    install_plugin_from_zip,
    install_plugin_from_url,
    install_plugin_by_id,
    uninstall_plugin,
)

__all__ = [
    "PluginManifest",
    "PluginInfo",
    "PluginComponents",
    "PluginUsageSummary",
    "RepositoryConfig",
    "get_plugin_manager",
    "load_all_plugins",
    "get_configured_repositories",
    "add_repository",
    "remove_repository",
    "fetch_aggregated_catalog",
    "install_plugin_from_zip",
    "install_plugin_from_url",
    "install_plugin_by_id",
    "uninstall_plugin",
]
