"""
Protocol Package
Exports the ProtocolRegistry and BaseProtocolDecoder
Automatically discovers and registers protocols in this directory
"""
from typing import Dict, Optional, Any, Tuple, Union
from abc import ABC, abstractmethod
import logging
import pkgutil
import importlib
import os
from models.schemas import NormalizedPosition

logger = logging.getLogger(__name__)

class BaseProtocolDecoder(ABC):
    """Base class for all protocol decoders"""
    
    # Default port for the protocol (Must be overridden by subclasses)
    PORT: int = 0
    PROTOCOL_TYPES: list = ['tcp']  # default to TCP, override in subclass
    
    @abstractmethod
    async def decode(self, data: bytes, client_info: Dict[str, Any], known_imei: Optional[str] = None) -> Tuple[Union[NormalizedPosition, Dict[str, Any], None], int]:
        """
        Decode raw bytes into normalized position
        Returns: (Result, ConsumedBytes)
        """
        pass
    
    @abstractmethod
    async def encode_command(self, command_type: str, params: Dict[str, Any]) -> bytes:
        """Encode command for device"""
        pass

class ProtocolRegistry:
    """Registry for GPS protocol decoders"""
    _decoders: Dict[str, BaseProtocolDecoder] = {}
    
    @classmethod
    def register(cls, protocol_name: str):
        """Decorator to register a protocol class"""
        def decorator(decoder_class):
            try:
                instance = decoder_class()
                cls._decoders[protocol_name.lower()] = instance
                logger.info(f"Registered protocol: {protocol_name} on port {instance.PORT}")
            except Exception as e:
                logger.error(f"Failed to register protocol {protocol_name}: {e}")
            return decoder_class
        return decorator
    
    @classmethod
    def get_decoder(cls, protocol_name: str) -> Optional[BaseProtocolDecoder]:
        return cls._decoders.get(protocol_name.lower())
    
    @classmethod
    def list_protocols(cls) -> list:
        return list(cls._decoders.keys())

    @classmethod
    def get_all(cls) -> Dict[str, BaseProtocolDecoder]:
        return cls._decoders

# ==================== Automatic Protocol Discovery ====================

def load_protocols():
    """
    Dynamically import all modules in the current package directory.
    This triggers the decorators that register the protocols.
    """
    package_dir = os.path.dirname(__file__)
    
    # Iterate over all files in the directory
    for module_info in pkgutil.iter_modules([package_dir]):
        if module_info.name == "__init__":
            continue
            
        try:
            # Import the module (e.g., protocols.gt06)
            importlib.import_module(f".{module_info.name}", package=__name__)
        except Exception as e:
            logger.error(f"Failed to load protocol module {module_info.name}: {e}")

# Execute discovery on import
load_protocols()
