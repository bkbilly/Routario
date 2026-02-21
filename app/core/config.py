"""
Configuration Management
Environment-based configuration using Pydantic Settings
"""
from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """Application settings"""
    
    # Database
    database_url: str = "postgresql+asyncpg://gps_user:gps_password@localhost/gps_platform"
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
    
    # Logging
    log_level: str = "INFO"
    log_format: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    
    # Alert Engine
    offline_check_interval_seconds: int = 300  # 5 minutes
    
    # Geocoding (optional)
    geocoding_enabled: bool = False
    geocoding_provider: str = "nominatim"  # nominatim, google, mapbox
    geocoding_api_key: Optional[str] = None
    
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


    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # Allow unknown .env keys (e.g. vapid_*, custom app keys)


# Global settings instance
settings = Settings()


def get_settings() -> Settings:
    """Get application settings"""
    return settings