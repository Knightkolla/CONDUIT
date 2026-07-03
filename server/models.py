"""
Pydantic models for request / response payloads.

These models are shared between the HTTP API layer and the WebSocket
protocol that communicates with the Chrome extension.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


# ── Chat ─────────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    """Incoming chat request from an API consumer."""

    domain: Optional[str] = Field(default=None, description="Target website domain (e.g. 'chat.openai.com')")
    message: str = Field(..., description="User message to send to the LLM website")
    tab_id: Optional[int] = Field(default=None, description="Optional Chrome tab ID to reuse")


class ChatResponse(BaseModel):
    """Response returned after the extension delivers the LLM reply."""

    request_id: str = Field(..., description="Unique identifier for this request")
    response: str = Field(..., description="Text response from the target LLM")
    duration: float = Field(..., description="Round-trip time in seconds")


# ── Calibration ──────────────────────────────────────────────────────


class SendMechanism(BaseModel):
    """Describes how to trigger the 'send' action on a chat page."""

    type: Literal["click", "key"] = Field(
        ..., description="'click' a button or press a 'key'"
    )
    selector: Optional[str] = Field(
        default=None,
        description="CSS selector of the send button (when type='click')",
    )
    key: Optional[str] = Field(
        default=None,
        description="Key to press, e.g. 'Enter' (when type='key')",
    )


class SelectorSet(BaseModel):
    """Complete set of CSS selectors that describe a chat UI."""

    input_selector: str = Field(
        ..., description="CSS selector for the message input element"
    )
    input_type: Literal["textarea", "contenteditable"] = Field(
        ..., description="Whether the input is a <textarea> or a contenteditable div"
    )
    send_mechanism: SendMechanism = Field(
        ..., description="How to submit the message"
    )
    response_container_selector: str = Field(
        ..., description="CSS selector for the element that holds the AI response"
    )
    generating_indicator_selector: Optional[str] = Field(
        default=None,
        description="CSS selector for an element visible while the AI is still generating",
    )


class CalibrateRequest(BaseModel):
    """Request body for the /calibrate endpoint."""

    domain: str = Field(..., description="Website domain being calibrated")
    dom_snapshot: str = Field(..., description="Compressed / simplified DOM snapshot")


class CalibrateResponse(BaseModel):
    """Wrapper around the calibrated SelectorSet."""

    domain: str
    selectors: SelectorSet
