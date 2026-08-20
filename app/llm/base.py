"""
app/llm/base.py

Base abstract class for all LLM providers in Routario.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class LLMField:
    """Describes one configuration field for the LLM Provider System Settings form."""
    key: str
    label: str
    field_type: str = "text"  # "text" | "password" | "select" | "number" | "boolean"
    required: bool = True
    placeholder: str = ""
    help_text: str = ""
    default: Any = None
    options: list[str] = field(default_factory=list)


class BaseLLMProvider(ABC):
    PROVIDER_ID: str = ""
    DISPLAY_NAME: str = ""
    FIELDS: list[LLMField] = []

    @abstractmethod
    async def generate_response(
        self,
        prompt: str,
        system_instruction: str = "",
        config: dict[str, Any] = None,
    ) -> str:
        """Generate text response from prompt and optional system instructions."""
        pass
