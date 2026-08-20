"""
app/llm/providers/anthropic.py

Anthropic Claude LLM Provider integration.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from llm.base import BaseLLMProvider, LLMField
from llm.registry import LLMRegistry

logger = logging.getLogger(__name__)


@LLMRegistry.register("anthropic")
class AnthropicProvider(BaseLLMProvider):
    PROVIDER_ID = "anthropic"
    DISPLAY_NAME = "Anthropic Claude"
    FIELDS = [
        LLMField(
            key="api_key",
            label="Anthropic API Key",
            field_type="password",
            required=True,
            placeholder="sk-ant-...",
            help_text="Anthropic API key.",
        ),
        LLMField(
            key="model_name",
            label="Model",
            field_type="select",
            default="claude-3-5-haiku-latest",
            options=["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-opus-latest"],
            help_text="Select Claude model version.",
        ),
        LLMField(
            key="temperature",
            label="Temperature",
            field_type="number",
            default=0.2,
            placeholder="0.2",
            help_text="Controls randomness (0.0 to 1.0).",
        ),
    ]

    async def generate_response(
        self,
        prompt: str,
        system_instruction: str = "",
        config: dict[str, Any] = None,
        history: Optional[list[dict[str, str]]] = None,
    ) -> str:
        config = config or {}
        api_key = config.get("api_key") or ""
        if not api_key:
            raise ValueError("Anthropic API key is missing in system settings")

        model_name = config.get("model_name") or "claude-3-5-haiku-latest"
        try:
            temperature = float(config.get("temperature", 0.2))
        except (ValueError, TypeError):
            temperature = 0.2

        messages = []
        if history and isinstance(history, list):
            for item in history:
                if isinstance(item, dict):
                    role = item.get("role", "user")
                    a_role = "assistant" if role in ("assistant", "bot", "model") else "user"
                    txt = item.get("content", "")
                    if txt:
                        messages.append({"role": a_role, "content": txt})

        messages.append({"role": "user", "content": prompt})

        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        body: dict[str, Any] = {
            "model": model_name,
            "max_tokens": 4096,
            "messages": messages,
            "temperature": temperature,
        }
        if system_instruction:
            body["system"] = system_instruction

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post("https://api.anthropic.com/v1/messages", headers=headers, json=body)
            if resp.status_code != 200:
                logger.error(f"Anthropic API error ({resp.status_code}): {resp.text}")
                raise RuntimeError(f"Anthropic API returned HTTP {resp.status_code}: {resp.text}")
            data = resp.json()

        try:
            content_blocks = data.get("content", [])
            text_bits = [block.get("text", "") for block in content_blocks if block.get("type") == "text"]
            return "\n".join(text_bits).strip() or "No content returned."
        except Exception as err:
            logger.error(f"Error parsing Anthropic response: {err}")
            raise RuntimeError(f"Failed to parse Anthropic response: {err}")
