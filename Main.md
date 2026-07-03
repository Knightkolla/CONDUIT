# Product Requirements Document: Conduit

**Working title:** Conduit (placeholder, rename freely)
**One-line:** Turn any LLM chat website into a programmable API by driving its web UI through a Chrome extension and a FastAPI backend.
**Author:** Kartikeya
**Status:** Draft v1
**Last updated:** July 2026

---

## 1. Overview

Conduit exposes a normal HTTP API that, under the hood, is answered by a real LLM chat website (ChatGPT, Claude, Gemini, and others) running in the user's own logged-in browser tab. A Chrome extension injects the prompt into the site's chatbox, waits for the reply, scrapes it, and returns it to a FastAPI backend. The backend presents this to the caller as a standard request/response API.

The core technical bet is a **self-healing selector engine**: the extension figures out where the chatbox and response area are on any given site, and when the site changes and breaks the selectors, it automatically re-derives them (via a candidate ladder, falling back to an LLM that reads the DOM) instead of failing.

This document specifies exactly the system described: init phase to discover selectors, WebSocket link between extension and backend, prompt injection, response capture, and API-style delivery, generalized across multiple LLM providers.

---

## 2. Problem statement

Consumer LLM chat interfaces are only usable by a human typing in a browser. There is no programmatic way to script them, chain them, or call them from code without using the official paid APIs. Conduit bridges that gap: it lets a developer send a prompt over HTTP and get the web UI's answer back as data, across several providers behind one unified interface.

---

## 3. Goals and non-goals

### Goals
- Convert an LLM chat website into a callable API with a single unified request/response shape.
- Support multiple providers through a pluggable adapter system.
- Survive front-end changes automatically via self-healing selectors, minimizing manual maintenance.
- Keep the LLM re-derivation step cheap: it runs only when cheaper strategies fail, not on every message.
- Reliably detect when a streamed response has finished before returning it.

### Non-goals
- Not a replacement for official provider APIs where those are acceptable.
- Not attempting to defeat bot-detection or CAPTCHA systems (see Risks).
- No headless/serverless operation in v1. Conduit runs in the user's real, logged-in browser session.
- No multi-user hosting in v1. Single user, local backend.

---

## 4. Personas

- **Builder (primary):** a developer who wants to script or chain LLM chats programmatically for personal projects, experiments, or automation.
- **Tinkerer:** someone learning browser extensions, WebSockets, and DOM automation who wants a real end-to-end system.

---

## 5. System architecture

```
   Caller (curl / Python / any HTTP client)
              │  HTTP request  { provider, prompt }
              ▼
        ┌──────────────┐
        │  FastAPI      │   holds pending request, matches response by id
        │  backend      │
        └──────┬───────┘
               │  WebSocket (bidirectional)
               ▼
        ┌──────────────┐
        │  Chrome       │   content script in the LLM tab
        │  extension    │
        └──────┬───────┘
               │  DOM injection + MutationObserver
               ▼
        LLM chat website (ChatGPT / Claude / Gemini ...)
```

Two phases:

**A. Initialization phase (per provider tab).** When the extension attaches to a supported site, it discovers the selectors for the input box, the send button, the response container, and the "generating / stop" indicator. It stores these in a per-provider cache.

**B. Runtime phase (per request).** A caller hits the backend. The backend forwards the prompt over WebSocket to the extension. The extension injects it, submits, watches for completion, scrapes the final text, and sends it back. The backend returns it to the caller.

---

## 6. Functional requirements

### 6.1 Initialization: selector discovery (self-healing engine)

The extension must locate four targets on the active site: **input element**, **submit control**, **response message container**, **completion signal**.

Discovery uses a ranked ladder, cheapest and most stable first. The LLM is the last resort, not the default.

1. **Known-selector cache.** If a working selector for this provider is cached and still resolves to a visible element, use it. No LLM call.
2. **Stable-anchor strategies.** Try, in order:
   - ARIA roles: `[role="textbox"]`, `textarea`, `[contenteditable="true"]`
   - Known stable IDs / test hooks: `#prompt-textarea`, `[data-testid*="input"]`, `[data-testid*="send"]`
   - Structural heuristics: the visible, focusable, editable element nearest the bottom of the main content column.
3. **LLM fallback.** Only if steps 1 and 2 all miss: serialize a trimmed version of the DOM (strip scripts, styles, and offscreen nodes to control token cost) and send it to an LLM with a prompt asking it to return the selector for each of the four targets as JSON. Validate that each returned selector resolves before caching.

**Self-heal trigger.** Before every runtime use, the cached selector is verified (does it resolve to a visible, editable element). If verification fails, that is the breakage signal: re-run the ladder from step 2, escalating to the LLM only if needed, then retry the operation once. This is the "rerun the LLM part when it changes" behavior, gated so it fires on breakage rather than on every message.

**Requirement:** selector discovery result is cached per provider with a version stamp, and the cache is invalidated automatically on verification failure.

### 6.2 Runtime: prompt injection

- On receiving a prompt for a provider, focus the input element, clear existing content, and insert the prompt text.
- Handle both `<textarea>` inputs and `contenteditable` divs (different insertion paths).
- Dispatch the input events the framework expects (`input`, and where needed `beforeinput`/composition events) so the site's own state registers the text.
- Trigger submit via the send button click, with Enter-key dispatch as fallback.
- Emit a `injected` confirmation back to the backend once submission is registered.

### 6.3 Runtime: response capture and completion detection

- Attach a `MutationObserver` to the response message container to watch the assistant's streamed reply grow.
- **Do not** treat "text stopped changing for N ms" as done; streaming pauses mid-reply and this fires early.
- **Primary done-signal:** the generating indicator resolves, that is, the "stop generating" button disappears or the send button becomes re-enabled. Watch that element's state transition.
- **Fallback done-signal:** text stable for a timeout AND the send control is enabled.
- On completion, extract the final assistant message text (last assistant-role node in the container) and send it to the backend.
- Capture and forward error states: rate-limit banners, login-required redirects, empty responses.

### 6.4 Multi-provider adapters

- Each provider is a small adapter object: `{ id, urlMatch, defaultSelectors, injectStrategy, doneSignalStrategy }`.
- The generic engine consumes an adapter; adding a provider means adding an adapter, not rewriting the engine.
- v1 target adapters: ChatGPT, Claude, Gemini. Each ships with default stable-anchor guesses; the self-heal engine covers drift.
- Adapters are data-driven where possible so new sites can be added without touching core logic.

### 6.5 Backend API

- `POST /v1/chat` with body `{ "provider": "chatgpt", "prompt": "..." }` returns `{ "id", "provider", "response", "status" }`.
- Backend assigns a request `id`, forwards over WebSocket, and holds the HTTP response open (or supports polling / callback) until the matching response arrives or a timeout fires.
- `GET /v1/providers` lists which providers currently have a live, initialized extension tab.
- Timeout, retry, and error-passthrough behavior defined per request.

### 6.6 WebSocket protocol

Message types (JSON), backend <-> extension:

| direction | type | payload |
|---|---|---|
| backend → ext | `prompt` | `{ id, provider, text }` |
| ext → backend | `injected` | `{ id }` |
| ext → backend | `response` | `{ id, text }` |
| ext → backend | `error` | `{ id, reason }` |
| ext → backend | `status` | `{ provider, ready: bool }` |
| backend → ext | `ping` / ext → backend `pong` | keepalive |

Every message carries the request `id` so responses match their request even if several are in flight.

---

## 7. Tech stack

- **Extension:** Manifest V3, content script + background service worker. Vanilla JS or lightweight TS. `MutationObserver` for capture, native DOM APIs for injection.
- **Backend:** FastAPI, `websockets` / FastAPI's WebSocket support, async request-matching map keyed by `id`.
- **LLM fallback for selector discovery:** any model with a JSON-mode / structured output. Provider-agnostic behind one interface so the user brings their own key (or a local model).
- **Storage:** local JSON / SQLite for the selector cache and adapter definitions.

---

## 8. Milestones

**M0 — Single-provider spike (weekend):** ChatGPT only, hardcoded selectors, inject a prompt, capture the reply via stop-button done-signal, print it in the backend. Proves the loop end to end.

**M1 — WebSocket API:** wrap M0 in the FastAPI `POST /v1/chat` + WebSocket protocol with id-matching. Now it behaves like an API.

**M2 — Self-heal engine:** add the selector ladder, verification-before-use, and LLM fallback re-derivation. Break the selector on purpose and watch it recover.

**M3 — Multi-provider adapters:** abstract into adapters, add Claude and Gemini. `GET /v1/providers`.

**M4 — Hardening:** error passthrough, timeouts, keepalive, cache versioning, basic docs and a demo GIF.

---

## 9. Success metrics

- End-to-end round trip (prompt in → response out) works on all v1 providers.
- Self-heal recovers from an induced selector break without manual edits, in under one re-derivation cycle.
- LLM fallback fires on breakage only, not on steady-state messages (measure: LLM calls per 100 requests should trend toward zero when the site is stable).
- Correct done-detection: no truncated or mid-stream responses returned.

---

## 10. Risks and realities

These do not change the build spec, but any honest PRD names them so the scope decision is deliberate.

- **Terms of service.** Driving a provider's consumer web UI programmatically generally violates that provider's terms. Treat Conduit as a personal / local tool; do not host it as a public shared service or resell access. This is a positioning decision, not a code problem.
- **Bot detection.** Providers run anti-automation (challenge pages, behavioral checks). When this triggers there is no DOM to re-read, so the self-heal engine cannot recover it. This is the main reason v1 stays in the user's real logged-in session rather than headless: a genuine human session is far less likely to be challenged. Conduit explicitly does not attempt to defeat these systems.
- **Streaming and done-detection fragility.** The completion signal depends on site-specific UI cues; capture the stop/send button state per adapter and treat it as the highest-value adapter field.
- **Selector drift is expected, not exceptional.** The self-heal engine is the answer to this and is therefore a core feature, not an add-on.

---

## 11. Open questions

- HTTP response holding: keep the request open (long-poll style) vs. return an `id` and expose `GET /v1/chat/{id}` for polling? M1 can start with the simpler open-hold and revisit under load.
- Conversation state: is each request stateless (new chat each time) or does it continue the existing thread? v1 recommendation: stateless per request for predictability, thread-continuation as a later flag.
- Concurrency: one tab per provider means requests to the same provider serialize. Acceptable for v1; note it.