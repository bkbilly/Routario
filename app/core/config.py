"""
Configuration Management
Environment-based configuration using Pydantic Settings
"""
from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """Application settings"""
    
    # Database
    database_url: str = "sqlite://./routario.db"
    db_pool_size: int = 20
    db_max_overflow: int = 40
    
    # Redis
    redis_url: str = "redis://localhost:6379"
    redis_cache_ttl: int = 3600  # seconds
    
    # Network Servers - Protocol Specific Ports
    tcp_host: str = "0.0.0.0"
    udp_host: str = "0.0.0.0"
    
    # API Server
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_workers: int = 4
    
    # Security
    secret_key: str = "your-secret-key-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    passkey_rp_id: Optional[str] = None
    passkey_rp_name: str = "Routario"
    passkey_origin: Optional[str] = None

    # Single Sign-On (OIDC)
    sso_enabled: bool = False
    sso_provider_name: str = "SSO"
    sso_issuer_url: Optional[str] = None
    sso_client_id: Optional[str] = None
    sso_client_secret: Optional[str] = None
    sso_redirect_uri: Optional[str] = None
    sso_scopes: str = "openid email profile"
    sso_allowed_domains: str = ""
    sso_require_verified_email: bool = True
    
    # Logging
    log_level: str = "INFO"
    log_format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    
    # Alert Engine
    offline_check_interval_seconds: int = 300  # 5 minutes
    
    # Geocoding (optional)
    geocoding_enabled: bool = True
    geocoding_provider: str = "nominatim"  # nominatim, google, mapbox
    geocoding_api_key: Optional[str] = None
    
    # AI & LLM Integration
    llm_enabled: bool = False
    llm_active_provider: str = "gemini"
    llm_gemini_api_key: Optional[str] = None
    llm_gemini_model: str = "gemini-2.5-flash-lite"
    llm_temperature: float = 0.2
    
    # Feature Flags
    enable_websockets: bool = True
    enable_notifications: bool = True
    enable_command_queue: bool = True

    # Push Notifications (VAPID)
    vapid_private_key: str = ""
    vapid_public_key: str = ""
    vapid_mailto: str = "mailto:admin@example.com"

    # Admin User (for initial setup)
    admin_username: str = "admin"
    admin_email: str = "admin@example.com"
    admin_password: str = "admin_password"

    # Valhalla (road speed limit lookups)
    # Set VALHALLA_URL in .env to point at your Docker container, e.g.:
    #   VALHALLA_URL=http://valhalla:8002
    valhalla_url: str = "http://localhost:8002"
    # Set to false in .env to disable Valhalla entirely without removing config.
    valhalla_enabled: bool = True

    # History & Tracking Limits
    history_batch_size: int = 2000
    history_max_api_limit: int = 10000
    history_retention_enabled: bool = False
    history_retention_days: int = 90

    # Fleet & Trip Rules
    trip_min_distance_km: float = 0.1
    trip_min_duration_seconds: int = 60

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # Allow unknown .env keys (e.g. vapid_*, custom app keys)


# Global settings instance
settings = Settings()


def get_settings() -> Settings:
    """Get application settings"""
    return settings


SYSTEM_SETTINGS_METADATA = {
    # Feature Flags
    "enable_websockets": {"type": "bool", "category": "Feature Flags", "label": "WebSockets Enabled", "description": "Enable live WebSocket connection server", "secret": False},
    "enable_notifications": {"type": "bool", "category": "Feature Flags", "label": "Notifications Enabled", "description": "Enable push notification delivery system", "secret": False},
    "enable_command_queue": {"type": "bool", "category": "Feature Flags", "label": "Command Queue Enabled", "description": "Enable background queueing for device commands", "secret": False},

    # Maps & Geocoding
    "geocoding_enabled": {"type": "bool", "category": "Geocoding & Maps", "label": "Geocoding Enabled", "description": "Enable reverse geocoding on incoming GPS coordinates (Nominatim)", "secret": False},
    "geocoding_provider": {"type": "str", "category": "Geocoding & Maps", "label": "Geocoding Provider", "description": "Reverse geocoding provider (Nominatim supported)", "secret": False, "readonly": True},

    # Valhalla Routing
    "valhalla_enabled": {"type": "bool", "category": "Routing & Speed Limits", "label": "Valhalla Enabled", "description": "Enable Valhalla road-snapping & speed limits engine", "secret": False},
    "valhalla_url": {"type": "str", "category": "Routing & Speed Limits", "label": "Valhalla Service URL", "description": "URL of the Valhalla routing service (e.g. http://localhost:8002)", "secret": False},

    # Single Sign-On (SSO)
    "sso_enabled": {"type": "bool", "category": "Single Sign-On (SSO)", "label": "SSO Enabled", "description": "Master switch for OpenID Connect SSO authentication", "secret": False},
    "sso_provider_name": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Provider Display Name", "description": "SSO provider name shown on login page", "secret": False},
    "sso_issuer_url": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Issuer URL", "description": "OpenID Connect Issuer URL (e.g. Keycloak / Okta)", "secret": False},
    "sso_client_id": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Client ID", "description": "OAuth2 / OIDC Client ID", "secret": False},
    "sso_client_secret": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Client Secret", "description": "OAuth2 / OIDC Client Secret", "secret": True},
    "sso_redirect_uri": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Redirect Callback URI", "description": "Explicit SSO Callback Redirect URI", "secret": False},
    "sso_scopes": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Requested Scopes", "description": "OIDC scopes requested", "secret": False},
    "sso_allowed_domains": {"type": "str", "category": "Single Sign-On (SSO)", "label": "Allowed Email Domains", "description": "Comma-separated list of allowed email domains", "secret": False},
    "sso_require_verified_email": {"type": "bool", "category": "Single Sign-On (SSO)", "label": "Require Verified Email", "description": "Enforce verified email check from OIDC provider", "secret": False},

    # AI & LLM Configuration
    "llm_enabled": {"type": "bool", "category": "AI & LLM Integration", "label": "LLM Enabled", "description": "Enable or disable platform-wide AI Copilot and custom LLM reports", "secret": False, "default": False},
    "llm_active_provider": {"type": "str", "category": "AI & LLM Integration", "label": "Active LLM Provider", "description": "Active LLM provider plugin", "secret": False, "options": ["gemini", "openai", "anthropic", "ollama"], "default": "gemini"},

    # Gemini
    "llm_gemini_api_key": {"type": "str", "category": "AI & LLM Integration", "label": "Gemini API Key", "description": "Google AI Studio API key (starts with AIzaSy...)", "secret": True, "default": ""},
    "llm_gemini_model": {"type": "str", "category": "AI & LLM Integration", "label": "Gemini Model", "description": "Select Gemini model version", "secret": False, "options": ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"], "default": "gemini-2.5-flash-lite"},

    # OpenAI
    "llm_openai_api_key": {"type": "str", "category": "AI & LLM Integration", "label": "OpenAI API Key", "description": "OpenAI API secret key (starts with sk-proj-...)", "secret": True, "default": ""},
    "llm_openai_model": {"type": "str", "category": "AI & LLM Integration", "label": "OpenAI Model", "description": "Select OpenAI model version", "secret": False, "options": ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "o3-mini"], "default": "gpt-4o-mini"},

    # Anthropic Claude
    "llm_anthropic_api_key": {"type": "str", "category": "AI & LLM Integration", "label": "Anthropic API Key", "description": "Anthropic API key (starts with sk-ant-...)", "secret": True, "default": ""},
    "llm_anthropic_model": {"type": "str", "category": "AI & LLM Integration", "label": "Anthropic Model", "description": "Select Claude model version", "secret": False, "options": ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-opus-latest"], "default": "claude-3-5-haiku-latest"},

    # Ollama / Local LLM
    "llm_ollama_base_url": {"type": "str", "category": "AI & LLM Integration", "label": "Ollama Base URL", "description": "Base URL of local Ollama or OpenAI-compatible server", "secret": False, "default": "http://localhost:11434"},
    "llm_ollama_model": {"type": "str", "category": "AI & LLM Integration", "label": "Ollama Model Name", "description": "Model name (e.g. llama3.2, mistral, qwen2.5)", "secret": False, "default": "llama3.2"},
    "llm_ollama_api_key": {"type": "str", "category": "AI & LLM Integration", "label": "Ollama API Key (Optional)", "description": "Optional bearer authorization key", "secret": True, "default": ""},
    "llm_temperature": {"type": "float", "category": "AI & LLM Integration", "label": "Temperature", "description": "Controls output randomness (0.0 to 1.0)", "secret": False, "default": 0.2},

    # Alert Engine & System
    "offline_check_interval_seconds": {"type": "int", "category": "Alerts & Engine", "label": "Offline Check Interval (s)", "description": "Offline device detection check frequency in seconds", "secret": False},
    "log_level": {"type": "str", "category": "Alerts & Engine", "label": "System Log Level", "description": "Global logging verbosity level", "secret": False, "options": ["DEBUG", "INFO", "WARNING", "ERROR"]},

    # Push Notifications
    "vapid_mailto": {"type": "str", "category": "Push Notifications", "label": "VAPID Admin Email", "description": "Contact email header for Web Push subscriptions", "secret": False},
    "vapid_public_key": {"type": "str", "category": "Push Notifications", "label": "VAPID Public Key", "description": "Web Push VAPID Public Key", "secret": False},
    "vapid_private_key": {"type": "str", "category": "Push Notifications", "label": "VAPID Private Key", "description": "Web Push VAPID Private Key", "secret": True},

    # Security & Tokens
    "secret_key": {"type": "str", "category": "Security & Tokens", "label": "JWT Secret Key", "description": "Secret key used for signing JWT authentication tokens", "secret": True},
    "algorithm": {"type": "str", "category": "Security & Tokens", "label": "JWT Algorithm", "description": "Cryptographic algorithm used for signing tokens", "secret": False, "readonly": True},
    "access_token_expire_minutes": {"type": "int", "category": "Security & Tokens", "label": "Token Expiry (minutes)", "description": "JWT Access Token lifetime in minutes", "secret": False},
    "passkey_rp_name": {"type": "str", "category": "Security & Tokens", "label": "Passkey RP Name", "description": "WebAuthn / Passkey Relying Party Name", "secret": False},
    "passkey_rp_id": {"type": "str", "category": "Security & Tokens", "label": "Passkey RP ID", "description": "WebAuthn / Passkey Relying Party ID", "secret": False},
    "passkey_origin": {"type": "str", "category": "Security & Tokens", "label": "Passkey Origin", "description": "WebAuthn / Passkey Expected Origin URL", "secret": False},

    # History & Tracking Limits
    "history_batch_size": {"type": "int", "category": "History & Tracking Limits", "label": "History Batch Size (Map Points)", "description": "Number of GPS history points loaded per map page/batch", "secret": False},
    "history_max_api_limit": {"type": "int", "category": "History & Tracking Limits", "label": "History Max API Limit", "description": "Maximum GPS history points allowed in a single API query", "secret": False},
    "history_retention_enabled": {"type": "bool", "category": "History & Tracking Limits", "label": "Auto Truncation Enabled", "description": "Automatically purge old historical position data past retention period", "secret": False},
    "history_retention_days": {"type": "int", "category": "History & Tracking Limits", "label": "History Retention (Days)", "description": "Number of days to keep historical position records before truncation", "secret": False},

    # Fleet & Trip Rules
    "trip_min_distance_km": {"type": "float", "category": "Fleet & Trip Rules", "label": "Trip Min Distance (km)", "description": "Minimum distance threshold to classify a movement as a valid trip (filters GPS drift)", "secret": False},
    "trip_min_duration_seconds": {"type": "int", "category": "Fleet & Trip Rules", "label": "Trip Min Duration (s)", "description": "Minimum duration in seconds required for a valid trip", "secret": False},

    # Infrastructure (Read-Only)
    "database_url": {"type": "str", "category": "Infrastructure", "label": "Database Connection URL", "description": "Active database connection string", "secret": False, "readonly": True},
    "db_pool_size": {"type": "int", "category": "Infrastructure", "label": "DB Pool Size", "description": "Database connection pool size", "secret": False, "readonly": True},
    "db_max_overflow": {"type": "int", "category": "Infrastructure", "label": "DB Max Overflow", "description": "Database connection pool overflow limit", "secret": False, "readonly": True},
    "redis_url": {"type": "str", "category": "Infrastructure", "label": "Redis Server URL", "description": "Redis connection URL", "secret": False, "readonly": True},
    "redis_cache_ttl": {"type": "int", "category": "Infrastructure", "label": "Redis Cache TTL (s)", "description": "Default cache expiration in seconds", "secret": False, "readonly": True},
    "api_host": {"type": "str", "category": "Infrastructure", "label": "API Host", "description": "Server listening network interface", "secret": False, "readonly": True},
    "api_port": {"type": "int", "category": "Infrastructure", "label": "API Port", "description": "Server listening network port", "secret": False, "readonly": True},
    "api_workers": {"type": "int", "category": "Infrastructure", "label": "API Workers", "description": "Server worker process count", "secret": False, "readonly": True},
}


def apply_setting_to_runtime(key: str, value: any):
    """Dynamically update attribute on the global `settings` instance."""
    if hasattr(settings, key):
        meta = SYSTEM_SETTINGS_METADATA.get(key, {})
        val_type = meta.get("type", "str")
        if val_type == "bool":
            if isinstance(value, str):
                value = value.lower() in ("true", "1", "yes", "on")
            else:
                value = bool(value)
        elif val_type == "int":
            value = int(value) if value is not None and str(value).strip() != "" else 0
        elif val_type == "float":
            value = float(value) if value is not None and str(value).strip() != "" else 0.0
        elif val_type == "str":
            value = str(value) if value is not None else ""
        setattr(settings, key, value)

