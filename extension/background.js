/**
 * LLM-to-API Bridge — Background Service Worker
 *
 * Owns the WebSocket lifecycle to the local FastAPI server and routes
 * messages between the server and the correct content-script tab.
 *
 * Key responsibilities:
 *  - Maintain a persistent WS connection to ws://localhost:8000/ws
 *  - 20-second keepalive pings to prevent MV3 worker termination
 *  - Exponential-backoff reconnect (1s → 30s cap)
 *  - Route incoming requests to the right tab based on domain
 *  - Forward content-script responses / errors back over the WS
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_URL = "ws://localhost:8000/ws";
const CALIBRATE_URL = "http://localhost:8000/calibrate";
const KEEPALIVE_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LOG_PREFIX = "[LLM Bridge BG]";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {WebSocket|null} */
let ws = null;

/** @type {number|null} */
let keepaliveTimer = null;

/** @type {number} Current reconnect delay in ms */
let reconnectDelay = RECONNECT_BASE_MS;

/** @type {number|null} */
let reconnectTimer = null;

/** @type {boolean} Whether we intentionally closed the socket */
let intentionalClose = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist connection status to chrome.storage.local so the popup can read it.
 * @param {boolean} connected
 */
async function setConnectionStatus(connected) {
  try {
    const data = { ws_connected: connected };
    if (connected) data.last_connected = Date.now();
    await chrome.storage.local.set(data);
  } catch (err) {
    console.error(LOG_PREFIX, "Failed to persist connection status", err);
  }
}

/**
 * Log a recent request/response event for the popup's "recent requests" list.
 * Keeps the last 10 entries.
 * @param {{ request_id: string, domain?: string, status: string, timestamp: number, message?: string, error?: string }} entry
 */
async function logRecentRequest(entry) {
  try {
    const { recent_requests = [] } = await chrome.storage.local.get("recent_requests");
    recent_requests.unshift(entry);
    if (recent_requests.length > 10) recent_requests.length = 10;
    await chrome.storage.local.set({ recent_requests });
  } catch (err) {
    console.error(LOG_PREFIX, "Failed to log recent request", err);
  }
}

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------

/**
 * Open (or re-open) the WebSocket connection.
 */
function connectWebSocket() {
  // Tear down any existing connection
  if (ws) {
    try { ws.close(); } catch (_) { /* noop */ }
    ws = null;
  }

  console.log(LOG_PREFIX, `Connecting to ${WS_URL} …`);

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error(LOG_PREFIX, "WebSocket constructor threw", err);
    scheduleReconnect();
    return;
  }

  // --- onopen ---
  ws.addEventListener("open", () => {
    console.log(LOG_PREFIX, "WebSocket connected ✓");
    reconnectDelay = RECONNECT_BASE_MS; // reset backoff
    setConnectionStatus(true);
    startKeepalive();
  });

  // --- onmessage ---
  ws.addEventListener("message", (event) => {
    handleServerMessage(event.data);
  });

  // --- onerror ---
  ws.addEventListener("error", (event) => {
    console.error(LOG_PREFIX, "WebSocket error", event);
  });

  // --- onclose ---
  ws.addEventListener("close", (event) => {
    console.warn(LOG_PREFIX, `WebSocket closed (code=${event.code}, reason=${event.reason})`);
    stopKeepalive();
    setConnectionStatus(false);
    ws = null;

    if (!intentionalClose) {
      scheduleReconnect();
    }
    intentionalClose = false;
  });
}

/**
 * Schedule a reconnect with exponential back-off.
 */
function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  console.log(LOG_PREFIX, `Reconnecting in ${reconnectDelay}ms …`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, reconnectDelay);

  // Exponential backoff with cap
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

/** Start the 20-second keepalive ping loop. */
function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, KEEPALIVE_INTERVAL_MS);
}

/** Stop the keepalive loop. */
function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Server → Extension message handling
// ---------------------------------------------------------------------------

/**
 * Handle a raw message string from the WebSocket server.
 * Expected shape: { request_id, domain, message }
 * @param {string} raw
 */
async function handleServerMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(LOG_PREFIX, "Failed to parse server message", raw, err);
    return;
  }

  // Ignore pong / heartbeat replies
  if (data.type === "pong" || data.type === "ping") return;

  const { request_id, domain, message } = data;

  if (!request_id || !message) {
    console.warn(LOG_PREFIX, "Malformed server message (missing fields)", data);
    return;
  }

  const targetDomain = domain || "linked tab";
  console.log(LOG_PREFIX, `Received request ${request_id} targeting ${targetDomain}`);

  await logRecentRequest({
    request_id,
    domain,
    status: "received",
    timestamp: Date.now(),
    message: message.substring(0, 80),
  });

  let tab = null;
  if (domain) {
    tab = await findTabForDomain(domain);
  } else {
    // Look up linked tab
    const storage = await chrome.storage.local.get(["linked_tab_id"]);
    if (storage.linked_tab_id) {
      try {
        tab = await chrome.tabs.get(storage.linked_tab_id);
      } catch (e) {
        console.warn(LOG_PREFIX, "Linked tab no longer exists", e);
      }
    }
  }

  if (!tab) {
    const errorMsg = domain 
      ? `No tab found for domain: ${domain}` 
      : `No linked tab found. Please click 'Link to this tab' in the popup.`;
    console.warn(LOG_PREFIX, errorMsg);
    sendToServer({ request_id, error: errorMsg });
    await logRecentRequest({
      request_id,
      domain: targetDomain,
      status: "error",
      timestamp: Date.now(),
      error: errorMsg,
    });
    return;
  }

  console.log(LOG_PREFIX, `Routing request ${request_id} → tab ${tab.id} (${tab.url})`);

  try {
    // 1. Ensure the content script is injected (bulletproof against page reloads)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });

    // 2. Send the chat request and properly handle the promise/callback
    chrome.tabs.sendMessage(tab.id, {
      type: "chat_request",
      request_id,
      message,
    }, (response) => {
       if (chrome.runtime.lastError) {
         const errorMsg = `Failed to communicate with tab: ${chrome.runtime.lastError.message}`;
         console.error(LOG_PREFIX, errorMsg);
         sendToServer({ request_id, error: errorMsg });
       }
    });
  } catch (err) {
    const errorMsg = `Failed to inject or send to content script: ${err.message}`;
    console.error(LOG_PREFIX, errorMsg);
    sendToServer({ request_id, error: errorMsg });
  }
}

/**
 * Find the first tab whose URL matches the given domain.
 * Tries several URL patterns to account for protocol and subdomain variations.
 * @param {string} domain - e.g. "chatgpt.com"
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function findTabForDomain(domain) {
  const patterns = [
    `*://${domain}/*`,
    `*://www.${domain}/*`,
  ];

  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (tabs.length > 0) {
        // Prefer the active tab if there are multiple
        const active = tabs.find((t) => t.active);
        return active || tabs[0];
      }
    } catch (err) {
      console.warn(LOG_PREFIX, `Tab query failed for pattern ${pattern}`, err);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extension → Server
// ---------------------------------------------------------------------------

/**
 * Send a JSON payload back to the FastAPI server over the WebSocket.
 * @param {object} payload
 */
function sendToServer(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error(LOG_PREFIX, "Cannot send — WebSocket not connected", payload);
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error(LOG_PREFIX, "Failed to send to server", err);
  }
}

// ---------------------------------------------------------------------------
// Content-script message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    // --- Chat response from content script ---
    case "chat_response": {
      console.log(LOG_PREFIX, `Response for ${msg.request_id} (${(msg.response_text || "").length} chars)`);
      sendToServer({ request_id: msg.request_id, response_text: msg.response_text });
      logRecentRequest({
        request_id: msg.request_id,
        status: "completed",
        timestamp: Date.now(),
      });
      sendResponse({ ok: true });
      break;
    }

    // --- Chat error from content script ---
    case "chat_error": {
      console.error(LOG_PREFIX, `Error for ${msg.request_id}: ${msg.error}`);
      sendToServer({ request_id: msg.request_id, error: msg.error });
      logRecentRequest({
        request_id: msg.request_id,
        status: "error",
        timestamp: Date.now(),
        error: msg.error,
      });
      sendResponse({ ok: true });
      break;
    }

    // --- Calibration request from content script (Phase 4 prep) ---
    case "calibrate_request": {
      console.log(LOG_PREFIX, "Calibration request received, forwarding to server");
      fetch(CALIBRATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: msg.domain,
          dom_snapshot: msg.dom_snapshot,
        }),
      })
        .then(async (res) => {
          const result = await res.json();
          if (!res.ok) {
             throw new Error(result.detail || `HTTP ${res.status}`);
          }
          return result;
        })
        .then((result) => {
          // Cache the returned selectors
          if (result && result.selectors) {
            const key = msg.domain;
            chrome.storage.local.set({
              [key]: { selectors: result.selectors, calibrated_at: Date.now() },
            });
          }
          sendResponse({ ok: true, result });
        })
        .catch((err) => {
          console.error(LOG_PREFIX, "Calibration fetch failed", err);
          sendResponse({ ok: false, error: err.message });
        });
      // Return true to keep the message channel open for the async sendResponse
      return true;
    }

    // --- Status ping from popup ---
    case "get_status": {
      sendResponse({
        ws_connected: ws && ws.readyState === WebSocket.OPEN,
        ws_url: WS_URL,
      });
      break;
    }

    // --- Link Active Tab (from popup) ---
    case "link_active_tab": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: "No active tab found" });
          return;
        }
        const activeTab = tabs[0];
        const url = new URL(activeTab.url);
        const domain = url.hostname;
        
        // Save the linked tab info
        chrome.storage.local.set({
          linked_tab_id: activeTab.id,
          linked_domain: domain,
        }, () => {
          console.log(LOG_PREFIX, `Linked tab set to ${domain} (ID: ${activeTab.id})`);
          
          // Ensure content script is injected
          chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            files: ["content.js"]
          }).then(() => {
            // Trigger calibration and WAIT for it to finish before responding to popup
            chrome.tabs.sendMessage(activeTab.id, { type: "run_calibration_if_needed", domain }, (response) => {
              if (response && response.ok) {
                sendResponse({ ok: true, domain, tabId: activeTab.id });
              } else {
                const errMsg = response?.error || "Content script did not respond";
                sendResponse({ ok: false, error: errMsg });
              }
            });
          }).catch((err) => {
             console.error(LOG_PREFIX, "Failed to inject content script", err);
             sendResponse({ ok: false, error: "Failed to inject into this page." });
          });
        });
      });
      return true; // async response
    }

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

console.log(LOG_PREFIX, "Service worker starting");
connectWebSocket();
