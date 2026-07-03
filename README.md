# Conduit — LLM UI to API Bridge

Conduit turns any LLM chat website (ChatGPT, Claude, Gemini, etc.) into a programmable API by driving the web user interface in your own logged-in browser session. 

It consists of:
1. A **FastAPI Backend** that exposes a standard HTTP API (`POST /v1/chat`).
2. A **Chrome Extension** that connects to the backend over WebSockets, receives prompts, injects them into the web UI of active LLM tabs, monitors the response streams, and forwards the completed response back to the backend.

Under the hood, Conduit uses a **self-healing selector engine** that dynamically identifies chat boxes, send buttons, and response streams on LLM sites. If a provider modifies their frontend, Conduit automatically re-derives the selectors (falling back to a structured LLM DOM analyzer only when necessary) to keep your pipelines running without manual code edits.

---

## Architecture

```
   Caller (curl / Python / HTTP client)
              │  HTTP request { provider, prompt }
              ▼
        ┌──────────────┐
        │  FastAPI      │   holds pending request, matches response by ID
        │  backend      │
        └──────┬───────┘
               │  WebSocket (bidirectional)
               ▼
        ┌──────────────┐
        │  Chrome       │   content script / service worker
        │  extension    │
        └──────┬───────┘
               │  DOM injection + MutationObserver
               ▼
   LLM website (ChatGPT, Claude, Gemini, etc. in a logged-in tab)
```

---

## Setup & Running

### 1. Run the FastAPI Backend

1. Navigate to the backend directory:
   ```bash
   cd conduit/backend
   ```
2. Create and activate a Python virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install the dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Configure your environment variables:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to specify your `OPENAI_API_KEY` (used as a fallback mechanism for self-healing selector derivation if the frontends change layout).
5. Start the backend:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
   The backend will start running on `http://localhost:8765`.

### 2. Install the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `conduit/extension` directory from this repository.

### 3. Wire Up LLM Outlets

1. Open a new browser tab and navigate to any of the supported LLM providers (e.g., [ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), or [Gemini](https://gemini.google.com)).
2. Make sure you are logged in to your account.
3. The Chrome Extension will automatically inject its content scripts, connect to the backend, and register the tab as an active **outlet**.
4. Click the Conduit extension icon in your toolbar to see the status of the connection and the wired outlets.

---

## API Usage

### List Available Outlets
Retrieve the list of LLM providers currently connected and ready to route prompts:
```bash
curl http://localhost:8765/v1/providers
```

### Send a Prompt
Send a chat prompt to a specific provider:
```bash
curl -X POST http://localhost:8765/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"provider": "chatgpt", "prompt": "Who is the Prime Minister of the UK?"}'
```

#### Request Body Schema
* `provider` (string): The target provider (`chatgpt`, `claude`, or `gemini`).
* `prompt` (string): The message content to inject.

#### Response Body Schema
```json
{
  "id": "d61f863b-630d-4aa1-94e8-85025feedd7a",
  "provider": "chatgpt",
  "response": "The Prime Minister of the United Kingdom is Keir Starmer...",
  "status": "success"
}
```

---

## Design and Self-Healing Engine

* **Cheapest Path First**: Selector discovery queries cached selectors first. If they fail to resolve, it tries ARIA roles, stable class names/IDs, and structural cues.
* **LLM Fallback**: If standard heuristics fail, the page's trimmed DOM structure is sent to a local or remote model to find the correct DOM input, submit, and stream indicators.
* **Verification Before Use**: Selectors are validated prior to every message execution, triggering healing only upon detection of broken selectors.
