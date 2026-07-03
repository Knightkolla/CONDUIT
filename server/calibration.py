"""
LLM-based calibration for discovering CSS selectors on chat UIs.

Given a DOM snapshot of a chat page, this module asks an LLM to identify
the relevant selectors (input field, send button, response container, etc.)
and returns a validated ``SelectorSet``.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from openai import AsyncOpenAI
from pydantic import ValidationError

from config import get_settings
from models import SelectorSet

logger = logging.getLogger(__name__)

# ── Prompt ───────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are an advanced AI browser automation agent employing the "Reframe" methodology. Instead of relying on brittle DOM structure or generic CSS class names, you must understand the page semantically through its accessibility tree and explicit intent attributes.

You will receive a compressed DOM snapshot of an LLM chat UI. Your goal is to identify robust CSS selectors that describe functional concepts (e.g. "the message input", "the submit action", "the assistant's response").

Return ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:
{
  "input_selector": "<CSS selector for the message input element>",
  "input_type": "textarea" | "contenteditable",
  "send_mechanism": {
    "type": "click" | "key",
    "selector": "<CSS selector of send button, or null>",
    "key": "<key name like 'Enter', or null>"
  },
  "response_container_selector": "<CSS selector for the last AI response>",
  "generating_indicator_selector": "<CSS selector for the 'typing' indicator, or null>"
}

CRITICAL RULES:
1. **NO HALLUCINATIONS:** You MUST ONLY use selectors that exactly match elements in the provided DOM Snapshot. Do not invent `data-testid` or any other attribute that is not present.
2. **Message Input:** Look for an element with `contenteditable="true"` or `role="textbox"` or `<textarea>`. Use its exact attributes (e.g., `[contenteditable="true"]` or `[aria-label="Write your prompt"]`).
3. **Send Button:** Look for a button with an `aria-label` like "Send message". Use its exact `aria-label`. If no send button exists, set type to "key" and key to "Enter".
4. **Response Container:** Find the container that holds the AI's response (e.g., `[data-message-author-role="assistant"]` or a specific class).
5. **MINIMAL SELECTORS:** DO NOT use long, brittle selector chains (e.g. `div > span > button`). Use the shortest, most direct attribute available. NEVER use class names containing brackets like `[...]` as they break CSS selectors.
6. Only output JSON.
"""

_MAX_RETRIES = 2


# ── Public API ───────────────────────────────────────────────────────


async def calibrate_selectors(dom_snapshot: str, domain: str) -> SelectorSet:
    """Send *dom_snapshot* to the calibration LLM and return a validated SelectorSet.

    Args:
        dom_snapshot: Simplified HTML / DOM string of the target page.
        domain: The domain being calibrated (included for context).

    Returns:
        A validated ``SelectorSet`` instance.

    Raises:
        ValueError: If the LLM fails to return valid JSON after retries.
        openai.OpenAIError: On upstream API errors.
    """
    settings = get_settings()

    client = AsyncOpenAI(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
    )

    user_message = (
        f"Domain: {domain}\n\n"
        f"DOM Snapshot:\n```\n{dom_snapshot}\n```"
    )

    last_error: Optional[Exception] = None

    for attempt in range(1, _MAX_RETRIES + 2):  # attempts 1 … MAX_RETRIES+1
        logger.info(
            "Calibration attempt %d/%d for domain=%s",
            attempt,
            _MAX_RETRIES + 1,
            domain,
        )

        response = await client.chat.completions.create(
            model=settings.llm_model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.0,
        )

        raw_text = (response.choices[0].message.content or "").strip()
        logger.debug("LLM raw response: %s", raw_text)

        try:
            parsed = _parse_json(raw_text)
            selector_set = SelectorSet.model_validate(parsed)
            logger.info("Calibration succeeded for domain=%s", domain)
            return selector_set
        except (json.JSONDecodeError, ValidationError) as exc:
            last_error = exc
            logger.warning(
                "Calibration attempt %d failed: %s", attempt, exc
            )

    raise ValueError(
        f"Calibration failed after {_MAX_RETRIES + 1} attempts for "
        f"domain={domain}: {last_error}"
    )


# ── Helpers ──────────────────────────────────────────────────────────


def _parse_json(text: str) -> dict[str, Any]:
    """Extract and parse JSON from LLM output, stripping markdown fences if present."""
    cleaned = text.strip()

    # Strip ```json ... ``` wrappers that LLMs sometimes add despite instructions
    if cleaned.startswith("```"):
        # Remove opening fence (with optional language tag)
        first_newline = cleaned.index("\n")
        cleaned = cleaned[first_newline + 1 :]
        # Remove closing fence
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3].strip()

    return json.loads(cleaned)
