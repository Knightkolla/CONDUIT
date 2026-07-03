"""
FastAPI server for the LLM-to-API Bridge.

This module exposes an HTTP API that accepts chat messages and forwards
them to a Chrome extension over a single persistent WebSocket connection.
The extension interacts with an LLM chat UI in the browser and streams the
response back.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState

from calibration import calibrate_selectors
from config import get_settings
from models import (
    CalibrateRequest,
    CalibrateResponse,
    ChatRequest,
    ChatResponse,
)

# ── Logging ──────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("llm_bridge")

# ── Global state ─────────────────────────────────────────────────────

# Only one extension connects at a time.
_ws_client: Optional[WebSocket] = None

# Maps request_id → Future that will be resolved when the extension responds.
_pending_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}

# Background task handle for the keepalive pinger.
_keepalive_task: Optional[asyncio.Task] = None

# ── Lifespan ─────────────────────────────────────────────────────────


@asynccontextmanager
async def _lifespan(app: FastAPI):  # noqa: ANN001
    """Startup / shutdown hooks."""
    settings = get_settings()
    logger.info(
        "Server starting — host=%s port=%d timeout=%ds",
        settings.host,
        settings.port,
        settings.request_timeout,
    )
    yield
    # Cancel any lingering keepalive task on shutdown.
    global _keepalive_task  # noqa: PLW0603
    if _keepalive_task is not None:
        _keepalive_task.cancel()
        _keepalive_task = None
    # Reject all pending futures so callers don't hang.
    for rid, fut in list(_pending_requests.items()):
        if not fut.done():
            fut.set_exception(RuntimeError("Server shutting down"))
        _pending_requests.pop(rid, None)
    logger.info("Server shutdown complete")


# ── App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="LLM-to-API Bridge",
    version="1.0.0",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health ───────────────────────────────────────────────────────────


@app.get("/")
async def health_check() -> dict[str, Any]:
    """Return basic health status and whether a WebSocket client is connected."""
    return {"status": "ok", "connected": _ws_client is not None}


# ── Chat ─────────────────────────────────────────────────────────────


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    """Accept a chat message and bridge it to the Chrome extension.

    The request is forwarded over the WebSocket to the extension, which
    interacts with the target LLM UI in the browser.  The response is
    awaited via an ``asyncio.Future`` with a configurable timeout.
    """
    if _ws_client is None:
        from fastapi.responses import JSONResponse

        return JSONResponse(  # type: ignore[return-value]
            status_code=503,
            content={"detail": "No Chrome extension connected"},
        )

    request_id = str(uuid.uuid4())
    settings = get_settings()
    start = time.monotonic()

    logger.info(
        "Chat request received  request_id=%s domain=%s tab_id=%s",
        request_id,
        req.domain,
        req.tab_id,
    )

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending_requests[request_id] = future

    # Send the request to the extension over WebSocket.
    payload = {
        "request_id": request_id,
        "domain": req.domain,
        "message": req.message,
        "tab_id": req.tab_id,
    }

    try:
        await _ws_client.send_json(payload)
        logger.info("Payload sent to extension  request_id=%s", request_id)
    except Exception as exc:
        _pending_requests.pop(request_id, None)
        logger.error("Failed to send to extension: %s", exc)
        from fastapi.responses import JSONResponse

        return JSONResponse(  # type: ignore[return-value]
            status_code=503,
            content={"detail": f"WebSocket send failed: {exc}"},
        )

    # Wait for the extension to respond (or timeout).
    try:
        result = await asyncio.wait_for(future, timeout=settings.request_timeout)
    except asyncio.TimeoutError:
        _pending_requests.pop(request_id, None)
        logger.warning("Request timed out  request_id=%s", request_id)
        from fastapi.responses import JSONResponse

        return JSONResponse(  # type: ignore[return-value]
            status_code=504,
            content={"detail": "Request timed out waiting for extension response"},
        )

    duration = round(time.monotonic() - start, 3)
    
    if "error" in result:
        logger.error("Chat request failed  request_id=%s error=%s", request_id, result["error"])
        from fastapi.responses import JSONResponse
        return JSONResponse(  # type: ignore[return-value]
            status_code=502,
            content={"detail": f"Extension error: {result['error']}"},
        )

    logger.info(
        "Chat response received  request_id=%s duration=%.3fs", request_id, duration
    )

    return ChatResponse(
        request_id=request_id,
        response=result.get("response_text", ""),
        duration=duration,
    )


# ── Calibrate ────────────────────────────────────────────────────────


@app.post("/calibrate")
async def calibrate_endpoint(req: CalibrateRequest) -> dict:
    """Run LLM-based calibration on the provided DOM snapshot."""
    logger.info("Calibration requested for domain=%s", req.domain)

    # Debug: Save the snapshot to a file to inspect real-world Claude DOM
    with open("claude_dom.txt", "w", encoding="utf-8") as f:
        f.write(req.dom_snapshot)

    try:
        selector_set = await calibrate_selectors(req.dom_snapshot, req.domain)
        return {"selectors": selector_set.model_dump()}
    except Exception as exc:
        logger.error("Calibration failed for domain=%s: %s", req.domain, exc)
        from fastapi.responses import JSONResponse

        return JSONResponse(  # type: ignore[return-value]
            status_code=500,
            content={"detail": f"Calibration failed: {exc}"},
        )




# ── WebSocket ────────────────────────────────────────────────────────


async def _keepalive(ws: WebSocket, interval: float = 20.0) -> None:
    """Send a WebSocket ping every *interval* seconds to keep the connection alive."""
    try:
        while True:
            await asyncio.sleep(interval)
            if ws.client_state == WebSocketState.CONNECTED:
                await ws.send_json({"type": "ping"})
            else:
                break
    except asyncio.CancelledError:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.debug("Keepalive stopped: %s", exc)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """Handle the persistent WebSocket connection from the Chrome extension.

    Protocol (extension → server):
        • ``{"request_id": "…", "response_text": "…"}``  — successful response
        • ``{"request_id": "…", "error": "…"}``          — error response
    """
    global _ws_client, _keepalive_task  # noqa: PLW0603

    await ws.accept()
    _ws_client = ws
    logger.info("Chrome extension connected  client=%s", ws.client)

    # Start keepalive pinger.
    _keepalive_task = asyncio.create_task(_keepalive(ws))

    try:
        while True:
            raw = await ws.receive_text()

            try:
                msg: dict[str, Any] = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Received non-JSON message from extension: %s", raw[:200])
                continue

            request_id = msg.get("request_id")
            if not request_id:
                logger.debug("Message without request_id ignored: %s", msg)
                continue

            future = _pending_requests.pop(request_id, None)
            if future is None:
                logger.warning(
                    "Received response for unknown request_id=%s (may have timed out)",
                    request_id,
                )
                continue

            if future.done():
                logger.debug("Future already resolved for request_id=%s", request_id)
                continue

            # Resolve the future (errors are handled by the /chat endpoint checking for 'error')
            if msg.get("error"):
                logger.error(
                    "Extension reported error  request_id=%s error=%s",
                    request_id,
                    msg["error"],
                )
            
            future.set_result(msg)
            logger.debug("Future resolved  request_id=%s", request_id)

    except WebSocketDisconnect:
        logger.info("Chrome extension disconnected")
    except Exception as exc:  # noqa: BLE001
        logger.error("WebSocket error: %s", exc)
    finally:
        # Clean up.
        if _keepalive_task is not None:
            _keepalive_task.cancel()
            _keepalive_task = None
        _ws_client = None
        logger.info("WebSocket cleanup complete")


# ── Entrypoint ───────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
        log_level="info",
    )
