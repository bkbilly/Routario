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

    # VoIP & SIP Voice Calls
    voip_enabled: bool = False
    voip_server: str = ""
    voip_port: int = 5060
    voip_username: str = ""
    voip_password: str = ""
    voip_from_extension: str = ""
    voip_repeat: int = 2
    voip_pause_seconds: int = 2
    voip_tts_engine: str = "gtts"

    # gTTS Settings
    voip_gtts_language: str = "en"

    # eSpeak Settings
    voip_espeak_voice: str = "en"
    voip_espeak_speed: int = 150
    voip_espeak_pitch: int = 50

    # Gemini Audio Settings
    voip_gemini_api_key: str = ""
    voip_gemini_model: str = "gemini-2.5-flash-preview-tts"
    voip_gemini_voice: str = "Aoede"
    voip_gemini_language: str = "en"

    # TTS Cache & Audio Storage
    voip_tts_cache_retention_days: int = 30

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


GTTS_LANGUAGES = [
    {"value": "af", "label": "Afrikaans"},
    {"value": "sq", "label": "Albanian"},
    {"value": "am", "label": "Amharic"},
    {"value": "ar", "label": "Arabic"},
    {"value": "eu", "label": "Basque"},
    {"value": "bn", "label": "Bengali"},
    {"value": "bs", "label": "Bosnian"},
    {"value": "bg", "label": "Bulgarian"},
    {"value": "yue", "label": "Cantonese"},
    {"value": "ca", "label": "Catalan"},
    {"value": "zh-CN", "label": "Chinese (Simplified)"},
    {"value": "zh-TW", "label": "Chinese (Traditional)"},
    {"value": "hr", "label": "Croatian"},
    {"value": "cs", "label": "Czech"},
    {"value": "da", "label": "Danish"},
    {"value": "nl", "label": "Dutch"},
    {"value": "en", "label": "English"},
    {"value": "et", "label": "Estonian"},
    {"value": "tl", "label": "Filipino"},
    {"value": "fi", "label": "Finnish"},
    {"value": "fr", "label": "French"},
    {"value": "fr-CA", "label": "French (Canada)"},
    {"value": "gl", "label": "Galician"},
    {"value": "de", "label": "German"},
    {"value": "el", "label": "Greek"},
    {"value": "gu", "label": "Gujarati"},
    {"value": "ha", "label": "Hausa"},
    {"value": "iw", "label": "Hebrew"},
    {"value": "hi", "label": "Hindi"},
    {"value": "hu", "label": "Hungarian"},
    {"value": "is", "label": "Icelandic"},
    {"value": "id", "label": "Indonesian"},
    {"value": "it", "label": "Italian"},
    {"value": "ja", "label": "Japanese"},
    {"value": "jw", "label": "Javanese"},
    {"value": "kn", "label": "Kannada"},
    {"value": "km", "label": "Khmer"},
    {"value": "ko", "label": "Korean"},
    {"value": "la", "label": "Latin"},
    {"value": "lv", "label": "Latvian"},
    {"value": "lt", "label": "Lithuanian"},
    {"value": "ms", "label": "Malay"},
    {"value": "ml", "label": "Malayalam"},
    {"value": "mr", "label": "Marathi"},
    {"value": "my", "label": "Myanmar (Burmese)"},
    {"value": "ne", "label": "Nepali"},
    {"value": "no", "label": "Norwegian"},
    {"value": "pl", "label": "Polish"},
    {"value": "pt", "label": "Portuguese (Brazil)"},
    {"value": "pt-PT", "label": "Portuguese (Portugal)"},
    {"value": "pa", "label": "Punjabi (Gurmukhi)"},
    {"value": "ro", "label": "Romanian"},
    {"value": "ru", "label": "Russian"},
    {"value": "sr", "label": "Serbian"},
    {"value": "si", "label": "Sinhala"},
    {"value": "sk", "label": "Slovak"},
    {"value": "es", "label": "Spanish"},
    {"value": "su", "label": "Sundanese"},
    {"value": "sw", "label": "Swahili"},
    {"value": "sv", "label": "Swedish"},
    {"value": "ta", "label": "Tamil"},
    {"value": "te", "label": "Telugu"},
    {"value": "th", "label": "Thai"},
    {"value": "tr", "label": "Turkish"},
    {"value": "uk", "label": "Ukrainian"},
    {"value": "ur", "label": "Urdu"},
    {"value": "vi", "label": "Vietnamese"},
    {"value": "cy", "label": "Welsh"},
]

ESPEAK_VOICES = [
    {"value": "af", "label": "Afrikaans"},
    {"value": "sq", "label": "Albanian"},
    {"value": "am", "label": "Amharic"},
    {"value": "ar", "label": "Arabic"},
    {"value": "hy", "label": "Armenian"},
    {"value": "az", "label": "Azerbaijani"},
    {"value": "eu", "label": "Basque"},
    {"value": "bn", "label": "Bengali"},
    {"value": "bs", "label": "Bosnian"},
    {"value": "bg", "label": "Bulgarian"},
    {"value": "my", "label": "Burmese"},
    {"value": "ca", "label": "Catalan"},
    {"value": "zh", "label": "Chinese (Mandarin)"},
    {"value": "zh-yue", "label": "Chinese (Cantonese)"},
    {"value": "hr", "label": "Croatian"},
    {"value": "cs", "label": "Czech"},
    {"value": "da", "label": "Danish"},
    {"value": "nl", "label": "Dutch"},
    {"value": "en", "label": "English (Default)"},
    {"value": "en-us", "label": "English (US)"},
    {"value": "en-uk", "label": "English (UK)"},
    {"value": "en-sc", "label": "English (Scotland)"},
    {"value": "eo", "label": "Esperanto"},
    {"value": "et", "label": "Estonian"},
    {"value": "tl", "label": "Filipino"},
    {"value": "fi", "label": "Finnish"},
    {"value": "fr", "label": "French"},
    {"value": "fr-be", "label": "French (Belgium)"},
    {"value": "gl", "label": "Galician"},
    {"value": "ka", "label": "Georgian"},
    {"value": "de", "label": "German"},
    {"value": "el", "label": "Greek"},
    {"value": "gu", "label": "Gujarati"},
    {"value": "ha", "label": "Hausa"},
    {"value": "he", "label": "Hebrew"},
    {"value": "hi", "label": "Hindi"},
    {"value": "hu", "label": "Hungarian"},
    {"value": "is", "label": "Icelandic"},
    {"value": "id", "label": "Indonesian"},
    {"value": "ga", "label": "Irish"},
    {"value": "it", "label": "Italian"},
    {"value": "ja", "label": "Japanese"},
    {"value": "kn", "label": "Kannada"},
    {"value": "kk", "label": "Kazakh"},
    {"value": "ko", "label": "Korean"},
    {"value": "la", "label": "Latin"},
    {"value": "lv", "label": "Latvian"},
    {"value": "lt", "label": "Lithuanian"},
    {"value": "ms", "label": "Malay"},
    {"value": "ml", "label": "Malayalam"},
    {"value": "mr", "label": "Marathi"},
    {"value": "ne", "label": "Nepali"},
    {"value": "no", "label": "Norwegian"},
    {"value": "fa", "label": "Persian (Farsi)"},
    {"value": "pl", "label": "Polish"},
    {"value": "pt", "label": "Portuguese (Brazil)"},
    {"value": "pt-pt", "label": "Portuguese (Portugal)"},
    {"value": "pa", "label": "Punjabi"},
    {"value": "ro", "label": "Romanian"},
    {"value": "ru", "label": "Russian"},
    {"value": "sr", "label": "Serbian"},
    {"value": "si", "label": "Sinhala"},
    {"value": "sk", "label": "Slovak"},
    {"value": "es", "label": "Spanish"},
    {"value": "es-la", "label": "Spanish (Latin America)"},
    {"value": "sw", "label": "Swahili"},
    {"value": "sv", "label": "Swedish"},
    {"value": "ta", "label": "Tamil"},
    {"value": "te", "label": "Telugu"},
    {"value": "th", "label": "Thai"},
    {"value": "tr", "label": "Turkish"},
    {"value": "uk", "label": "Ukrainian"},
    {"value": "ur", "label": "Urdu"},
    {"value": "uz", "label": "Uzbek"},
    {"value": "vi", "label": "Vietnamese"},
    {"value": "cy", "label": "Welsh"},
]

GEMINI_TTS_LANGUAGES = [
    {"value": "en", "label": "English (Original / Default)"},
    {"value": "sq", "label": "Albanian"},
    {"value": "ar", "label": "Arabic"},
    {"value": "bg", "label": "Bulgarian"},
    {"value": "zh", "label": "Chinese"},
    {"value": "hr", "label": "Croatian"},
    {"value": "cs", "label": "Czech"},
    {"value": "da", "label": "Danish"},
    {"value": "nl", "label": "Dutch"},
    {"value": "et", "label": "Estonian"},
    {"value": "fi", "label": "Finnish"},
    {"value": "fr", "label": "French"},
    {"value": "de", "label": "German"},
    {"value": "el", "label": "Greek"},
    {"value": "he", "label": "Hebrew"},
    {"value": "hi", "label": "Hindi"},
    {"value": "hu", "label": "Hungarian"},
    {"value": "id", "label": "Indonesian"},
    {"value": "it", "label": "Italian"},
    {"value": "ja", "label": "Japanese"},
    {"value": "ko", "label": "Korean"},
    {"value": "no", "label": "Norwegian"},
    {"value": "pl", "label": "Polish"},
    {"value": "pt", "label": "Portuguese"},
    {"value": "ro", "label": "Romanian"},
    {"value": "ru", "label": "Russian"},
    {"value": "sr", "label": "Serbian"},
    {"value": "sk", "label": "Slovak"},
    {"value": "es", "label": "Spanish"},
    {"value": "sv", "label": "Swedish"},
    {"value": "th", "label": "Thai"},
    {"value": "tr", "label": "Turkish"},
    {"value": "uk", "label": "Ukrainian"},
    {"value": "vi", "label": "Vietnamese"},
]


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

    # VoIP & SIP Voice Calls
    "voip_enabled": {"type": "bool", "category": "VoIP & SIP Voice Calls", "label": "VoIP Calling Enabled", "description": "Enable placing automated SIP / VoIP voice call alarms for critical alerts", "secret": False, "default": False},
    "voip_server": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "SIP Server Host", "description": "SIP PBX server host address or IP (e.g. 192.168.1.100 or sip.example.com)", "secret": False, "default": ""},
    "voip_port": {"type": "int", "category": "VoIP & SIP Voice Calls", "label": "SIP Server Port", "description": "SIP signaling port (default 5060 for UDP/TCP, 5061 for TLS)", "secret": False, "default": 5060},
    "voip_username": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "SIP Username", "description": "SIP account username or registration ID", "secret": False, "default": ""},
    "voip_password": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "SIP Password", "description": "SIP account authentication password", "secret": True, "default": ""},
    "voip_from_extension": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "Caller ID / Extension", "description": "Outbound caller extension / ID (optional, defaults to username)", "secret": False, "default": ""},
    "voip_repeat": {"type": "int", "category": "VoIP & SIP Voice Calls", "label": "Message Repeat Count", "description": "Number of times voice alarm message repeats on answer", "secret": False, "default": 2},
    "voip_pause_seconds": {"type": "int", "category": "VoIP & SIP Voice Calls", "label": "Repeat Pause Duration (Seconds)", "description": "Seconds of silence between voice message repetitions", "secret": False, "default": 2},
    "voip_tts_engine": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "TTS Engine", "description": "Text-to-speech generation engine for voice alarms", "secret": False, "options": ["gtts", "espeak", "gemini"], "default": "gtts"},

    # gTTS Settings
    "voip_gtts_language": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "gTTS Language", "description": "Voice language for Google Translate TTS synthesis", "secret": False, "options": GTTS_LANGUAGES, "default": "en"},

    # eSpeak Settings
    "voip_espeak_voice": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "eSpeak Voice / Language", "description": "Voice language variant for eSpeak synthesis", "secret": False, "options": ESPEAK_VOICES, "default": "en"},
    "voip_espeak_speed": {"type": "int", "category": "VoIP & SIP Voice Calls", "label": "eSpeak Speech Speed (WPM)", "description": "Speech speed in words per minute (50 to 300, default 150)", "secret": False, "default": 150},
    "voip_espeak_pitch": {"type": "int", "category": "VoIP & SIP Voice Calls", "label": "eSpeak Voice Pitch", "description": "Voice pitch level from 0 to 99 (default 50)", "secret": False, "default": 50},

    # Gemini Audio Settings
    "voip_gemini_api_key": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "Gemini API Key (Optional)", "description": "Leave blank to use the platform's Gemini API key configured in AI Copilot", "secret": True, "default": ""},
    "voip_gemini_model": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "Gemini Audio Model", "description": "Google Gemini Text-to-Speech audio model", "secret": False, "options": ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-pro-preview-tts"], "default": "gemini-2.5-flash-preview-tts"},
    "voip_gemini_voice": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "Gemini Neural Voice", "description": "Persona and voice timbre for audio synthesis", "secret": False, "options": ["Aoede", "Puck", "Charon", "Kore", "Fenrir"], "default": "Aoede"},
    "voip_gemini_language": {"type": "str", "category": "VoIP & SIP Voice Calls", "label": "Gemini Voice Language", "description": "Voice language for synthesis (alerts will be automatically translated if not in English)", "secret": False, "options": GEMINI_TTS_LANGUAGES, "default": "en"},
    "voip_tts_cache_retention_days": {"type": "int", "category": "VoIP & SIP Voice Calls", "label": "TTS Audio Cache Retention (Days)", "description": "Number of days to keep cached TTS audio files in uploads/tts before auto-purging unused files (0 to disable purge)", "secret": False, "default": 30},

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

