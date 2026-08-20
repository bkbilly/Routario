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

    # Email & SMTP Notifications
    smtp_enabled: bool = False
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    smtp_from_email: str = ""
    smtp_from_name: str = "Routario Telematics"

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
    # Core System & Operations
    "log_level": {"type": "str", "category": "Core System & Operations", "label": "System Log Level", "description": "Global logging verbosity level", "secret": False, "options": ["DEBUG", "INFO", "WARNING", "ERROR"]},
    "offline_check_interval_seconds": {"type": "int", "category": "Core System & Operations", "label": "Offline Check Interval (s)", "description": "Offline device detection check frequency in seconds", "secret": False},
    "enable_websockets": {"type": "bool", "category": "Core System & Operations", "label": "WebSockets Enabled", "description": "Enable live WebSocket connection server", "secret": False},
    "enable_notifications": {"type": "bool", "category": "Core System & Operations", "label": "Notifications Enabled", "description": "Enable push notification delivery system", "secret": False},
    "enable_command_queue": {"type": "bool", "category": "Core System & Operations", "label": "Command Queue Enabled", "description": "Enable background queueing for device commands", "secret": False},

    # Email & SMTP Notifications
    "smtp_enabled": {"type": "bool", "category": "Email & SMTP Notifications", "label": "SMTP Email Enabled", "description": "Enable sending platform system emails for alerts and ticket assignments", "secret": False, "default": False},
    "smtp_host": {"type": "str", "category": "Email & SMTP Notifications", "label": "SMTP Server Host", "description": "SMTP server host address (e.g. smtp.gmail.com)", "secret": False, "default": "smtp.gmail.com"},
    "smtp_port": {"type": "int", "category": "Email & SMTP Notifications", "label": "SMTP Server Port", "description": "SMTP server port (usually 587 for TLS, 465 for SSL)", "secret": False, "default": 587},
    "smtp_username": {"type": "str", "category": "Email & SMTP Notifications", "label": "SMTP Username / Email", "description": "Authentication username or email address", "secret": False, "default": ""},
    "smtp_password": {"type": "str", "category": "Email & SMTP Notifications", "label": "SMTP Password", "description": "SMTP authentication password or app password", "secret": True, "default": ""},
    "smtp_use_tls": {"type": "bool", "category": "Email & SMTP Notifications", "label": "Use STARTTLS", "description": "Enable TLS encryption for outgoing emails", "secret": False, "default": True},
    "smtp_from_email": {"type": "str", "category": "Email & SMTP Notifications", "label": "Sender Email (From)", "description": "Email address shown as the sender (e.g. noreply@example.com)", "secret": False, "default": ""},
    "smtp_from_name": {"type": "str", "category": "Email & SMTP Notifications", "label": "Sender Display Name", "description": "Display name shown in recipient email clients", "secret": False, "default": "Routario Telematics"},

    # AI Copilot & LLM Engine
    "llm_enabled": {"type": "bool", "category": "AI Copilot & LLM Engine", "label": "LLM Enabled", "description": "Enable or disable platform-wide AI Copilot and custom LLM reports", "secret": False, "default": False},
    "llm_active_provider": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Active LLM Provider", "description": "Active LLM provider plugin", "secret": False, "options": ["gemini", "openai", "anthropic", "ollama"], "default": "gemini"},
    "llm_gemini_api_key": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Gemini API Key", "description": "Google AI Studio API key (starts with AIzaSy...)", "secret": True, "default": ""},
    "llm_gemini_model": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Gemini Model", "description": "Select Gemini model version", "secret": False, "options": ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"], "default": "gemini-2.5-flash-lite"},
    "llm_openai_api_key": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "OpenAI API Key", "description": "OpenAI API secret key (starts with sk-proj-...)", "secret": True, "default": ""},
    "llm_openai_model": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "OpenAI Model", "description": "Select OpenAI model version", "secret": False, "options": ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "o3-mini"], "default": "gpt-4o-mini"},
    "llm_anthropic_api_key": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Anthropic API Key", "description": "Anthropic API key (starts with sk-ant-...)", "secret": True, "default": ""},
    "llm_anthropic_model": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Anthropic Model", "description": "Select Claude model version", "secret": False, "options": ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-opus-latest"], "default": "claude-3-5-haiku-latest"},
    "llm_ollama_base_url": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Ollama Base URL", "description": "Base URL of local Ollama or OpenAI-compatible server", "secret": False, "default": "http://localhost:11434"},
    "llm_ollama_model": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Ollama Model Name", "description": "Model name (e.g. llama3.2, mistral, qwen2.5)", "secret": False, "default": "llama3.2"},
    "llm_ollama_api_key": {"type": "str", "category": "AI Copilot & LLM Engine", "label": "Ollama API Key (Optional)", "description": "Optional bearer authorization key", "secret": True, "default": ""},
    "llm_temperature": {"type": "float", "category": "AI Copilot & LLM Engine", "label": "Temperature", "description": "Controls output randomness (0.0 to 1.0)", "secret": False, "default": 0.2},

    # Web Push Notifications
    "vapid_mailto": {"type": "str", "category": "Web Push Notifications", "label": "VAPID Admin Email", "description": "Contact email header for Web Push subscriptions", "secret": False},
    "vapid_public_key": {"type": "str", "category": "Web Push Notifications", "label": "VAPID Public Key", "description": "Web Push VAPID Public Key", "secret": False},
    "vapid_private_key": {"type": "str", "category": "Web Push Notifications", "label": "VAPID Private Key", "description": "Web Push VAPID Private Key", "secret": True},

    # Telematics & Trip Rules
    "trip_min_distance_km": {"type": "float", "category": "Telematics & Trip Rules", "label": "Trip Min Distance (km)", "description": "Minimum distance threshold to classify a movement as a valid trip (filters GPS drift)", "secret": False},
    "trip_min_duration_seconds": {"type": "int", "category": "Telematics & Trip Rules", "label": "Trip Min Duration (s)", "description": "Minimum duration in seconds required for a valid trip", "secret": False},

    # Maps, Geocoding & Routing
    "geocoding_enabled": {"type": "bool", "category": "Maps, Geocoding & Routing", "label": "Geocoding Enabled", "description": "Enable reverse geocoding on incoming GPS coordinates (Nominatim)", "secret": False},
    "geocoding_provider": {"type": "str", "category": "Maps, Geocoding & Routing", "label": "Geocoding Provider", "description": "Reverse geocoding provider (Nominatim supported)", "secret": False, "readonly": True},
    "valhalla_enabled": {"type": "bool", "category": "Maps, Geocoding & Routing", "label": "Valhalla Enabled", "description": "Enable Valhalla road-snapping & speed limits engine", "secret": False},
    "valhalla_url": {"type": "str", "category": "Maps, Geocoding & Routing", "label": "Valhalla Service URL", "description": "URL of the Valhalla routing service (e.g. http://localhost:8002)", "secret": False},

    # History Data & Retention
    "history_batch_size": {"type": "int", "category": "History Data & Retention", "label": "History Batch Size (Map Points)", "description": "Number of GPS history points loaded per map page/batch", "secret": False},
    "history_max_api_limit": {"type": "int", "category": "History Data & Retention", "label": "History Max API Limit", "description": "Maximum GPS history points allowed in a single API query", "secret": False},
    "history_retention_enabled": {"type": "bool", "category": "History Data & Retention", "label": "Auto Truncation Enabled", "description": "Automatically purge old historical position data past retention period", "secret": False},
    "history_retention_days": {"type": "int", "category": "History Data & Retention", "label": "History Retention (Days)", "description": "Number of days to keep historical position records before truncation", "secret": False},

    # Security & Token Policies
    "secret_key": {"type": "str", "category": "Security & Token Policies", "label": "JWT Secret Key", "description": "Secret key used for signing JWT authentication tokens", "secret": True},
    "algorithm": {"type": "str", "category": "Security & Token Policies", "label": "JWT Algorithm", "description": "Cryptographic algorithm used for signing tokens", "secret": False, "readonly": True},
    "access_token_expire_minutes": {"type": "int", "category": "Security & Token Policies", "label": "Token Expiry (minutes)", "description": "JWT Access Token lifetime in minutes", "secret": False},
    "passkey_rp_name": {"type": "str", "category": "Security & Token Policies", "label": "Passkey RP Name", "description": "WebAuthn / Passkey Relying Party Name", "secret": False},
    "passkey_rp_id": {"type": "str", "category": "Security & Token Policies", "label": "Passkey RP ID", "description": "WebAuthn / Passkey Relying Party ID", "secret": False},
    "passkey_origin": {"type": "str", "category": "Security & Token Policies", "label": "Passkey Origin", "description": "WebAuthn / Passkey Expected Origin URL", "secret": False},

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

    # Infrastructure Diagnostics
    "database_url": {"type": "str", "category": "Infrastructure Diagnostics", "label": "Database Connection URL", "description": "Active database connection string", "secret": False, "readonly": True},
    "db_pool_size": {"type": "int", "category": "Infrastructure Diagnostics", "label": "DB Pool Size", "description": "Database connection pool size", "secret": False, "readonly": True},
    "db_max_overflow": {"type": "int", "category": "Infrastructure Diagnostics", "label": "DB Max Overflow", "description": "Database connection pool overflow limit", "secret": False, "readonly": True},
    "redis_url": {"type": "str", "category": "Infrastructure Diagnostics", "label": "Redis Server URL", "description": "Redis connection URL", "secret": False, "readonly": True},
    "redis_cache_ttl": {"type": "int", "category": "Infrastructure Diagnostics", "label": "Redis Cache TTL (s)", "description": "Default cache expiration in seconds", "secret": False, "readonly": True},
    "api_host": {"type": "str", "category": "Infrastructure Diagnostics", "label": "API Host", "description": "Server listening network interface", "secret": False, "readonly": True},
    "api_port": {"type": "int", "category": "Infrastructure Diagnostics", "label": "API Port", "description": "Server listening network port", "secret": False, "readonly": True},
    "api_workers": {"type": "int", "category": "Infrastructure Diagnostics", "label": "API Workers", "description": "Server worker process count", "secret": False, "readonly": True},
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

