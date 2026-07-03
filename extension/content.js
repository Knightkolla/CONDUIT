/**
 * LLM-to-API Bridge — Content Script
 *
 * Performs all DOM automation on LLM chat UIs:
 *  - Injects user messages into input fields (textarea or contenteditable)
 *  - Triggers send via button click or Enter key
 *  - Detects response completion via MutationObserver (indicator + idle fallback)
 *  - Extracts the LLM's response text
 *  - Provides DOM compression for future LLM-based calibration
 *  - Ships with hardcoded fallback selectors for ChatGPT and Claude
 */

"use strict";

(function() {
if (window.__llm_bridge_injected) return;
window.__llm_bridge_injected = true;

const LOG_PREFIX = "[LLM Bridge CS]";

// ---------------------------------------------------------------------------
// Hardcoded Fallback Selectors
// ---------------------------------------------------------------------------

/**
 * Built-in selector sets for known domains.
 * These act as fallbacks when calibration data isn't cached.
 * NOTE: Selectors may drift as UIs update — Phase 4 calibration replaces these.
 * @type {Object<string, SelectorSet>}
 */
const KNOWN_SELECTORS = {
  "chatgpt.com": {
    input_selector: "#prompt-textarea",
    input_type: "contenteditable",
    send_mechanism: { type: "click", selector: '[data-testid="send-button"]' },
    response_container_selector: '[data-message-author-role="assistant"]',
    generating_indicator_selector: '[data-testid="stop-button"]',
  },
  "chat.openai.com": {
    input_selector: "#prompt-textarea",
    input_type: "contenteditable",
    send_mechanism: { type: "click", selector: '[data-testid="send-button"]' },
    response_container_selector: '[data-message-author-role="assistant"]',
    generating_indicator_selector: '[data-testid="stop-button"]',
  },
  "claude.ai": {
    input_selector: '.ProseMirror[contenteditable="true"]',
    input_type: "contenteditable",
    send_mechanism: { type: "click", selector: 'button[aria-label="Send message"]' },
    response_container_selector: '.font-claude-message',
    generating_indicator_selector: 'button[aria-label="Stop response"]',
  },
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Selector retrieval
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SendMechanism
 * @property {"click"|"key"} type
 * @property {string} [selector] - button selector when type === "click"
 */

/**
 * @typedef {object} SelectorSet
 * @property {string} input_selector
 * @property {"textarea"|"contenteditable"} input_type
 * @property {SendMechanism} send_mechanism
 * @property {string} response_container_selector
 * @property {string} generating_indicator_selector
 */

/**
 * Run LLM-based calibration for the current page.
 * Compresses the DOM, sends it to the backend /calibrate endpoint via
 * the background worker, and caches the returned selectors.
 * @param {string} domain
 * @returns {Promise<SelectorSet>}
 */
async function runCalibration(domain) {
  console.log(LOG_PREFIX, `Running LLM calibration for ${domain}…`);

  const snapshot = compressDom();
  console.log(LOG_PREFIX, `DOM snapshot: ${snapshot.length} chars`);

  // Send calibration request through background worker (keeps API key server-side)
  const result = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "calibrate_request", domain, dom_snapshot: snapshot },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok && response.result && response.result.selectors) {
          resolve(response.result.selectors);
        } else {
          const errMsg = (response && response.error) || "Unknown calibration error";
          reject(new Error(errMsg));
        }
      }
    );
  });

  // Validate that the returned selectors actually resolve on the page
  const inputEl = document.querySelector(result.input_selector);
  if (!inputEl) {
    throw new Error(
      `Calibration returned input_selector "${result.input_selector}" but it doesn't match any element on the page`
    );
  }

  // Cache the validated selectors
  await chrome.storage.local.set({
    [domain]: { selectors: result, calibrated_at: Date.now() },
  });

  console.log(LOG_PREFIX, `Calibration succeeded for ${domain}`, result);
  return result;
}

/**
 * Clear cached selectors for a domain (used during self-healing).
 * @param {string} domain
 */
async function clearCachedSelectors(domain) {
  try {
    await chrome.storage.local.remove(domain);
    console.log(LOG_PREFIX, `Cleared cached selectors for ${domain}`);
  } catch (err) {
    console.warn(LOG_PREFIX, "Failed to clear cached selectors", err);
  }
}

/**
 * Retrieve the selector set for the given domain.
 * Priority: chrome.storage.local cache → hardcoded fallbacks → LLM calibration.
 * @param {string} domain
 * @param {boolean} [forceCalibrate=false] - If true, skip cache and re-calibrate
 * @returns {Promise<SelectorSet>}
 */
async function getSelectors(domain, forceCalibrate = false) {
  if (!forceCalibrate) {
    // 1. Check chrome.storage.local cache
    try {
      const cached = await chrome.storage.local.get(domain);
      if (cached[domain] && cached[domain].selectors) {
        console.log(LOG_PREFIX, `Using cached selectors for ${domain}`);
        return cached[domain].selectors;
      }
    } catch (err) {
      console.warn(LOG_PREFIX, "Failed to read cached selectors", err);
    }

    // 2. Check hardcoded fallbacks (strip www.)
    const normalized = domain.replace(/^www\./, "");
    if (KNOWN_SELECTORS[normalized]) {
      console.log(LOG_PREFIX, `Using hardcoded fallback selectors for ${normalized}`);
      return KNOWN_SELECTORS[normalized];
    }
  }

  // 3. Run LLM calibration
  return await runCalibration(domain);
}

// ---------------------------------------------------------------------------
// DOM Compression (Phase 4 prep)
// ---------------------------------------------------------------------------

/** Tags to strip entirely during DOM compression. */
const STRIP_TAGS = new Set([
  "SCRIPT", "STYLE", "SVG", "LINK", "META", "NOSCRIPT", "IFRAME",
  "NAV", "ASIDE"
]);

/** Attributes to preserve during DOM compression. */
const KEEP_ATTRS = [
  "id", "class", "role", "aria-label", "placeholder",
  "type", "contenteditable", "data-testid", "name",
];

/**
 * Walk the DOM tree and produce a compressed string representation.
 *
 * Strips noise elements (script, style, svg, etc.), keeps only meaningful
 * attributes, truncates text, and limits both depth and total output size.
 *
 * @param {Element} [root=document.body] - Root element to start from
 * @param {number} [maxDepth=45] - Maximum tree depth
 * @param {number} [maxChars=80000] - Approximate character budget
 * @returns {string} Compressed DOM snapshot
 */
function compressDom(root = document.body, maxDepth = 45, maxChars = 80000) {
  const lines = [];
  let charCount = 0;
  let truncated = false;

  /**
   * Recursively walk a DOM node.
   * @param {Node} node
   * @param {number} depth
   */
  function walk(node, depth) {
    if (truncated || charCount >= maxChars) {
      truncated = true;
      return;
    }

    if (depth > maxDepth) return;

    // --- Text nodes ---
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || "").trim();
      if (text) {
        const truncText = text.length > 50 ? text.substring(0, 47) + "..." : text;
        const line = "  ".repeat(depth) + `"${truncText}"`;
        lines.push(line);
        charCount += line.length + 1;
      }
      return;
    }

    // --- Element nodes ---
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = /** @type {Element} */ (node);
    const tag = el.tagName;

    // Skip stripped tags
    if (STRIP_TAGS.has(tag)) return;

    // Build compact descriptor
    let descriptor = tag.toLowerCase();

    for (const attr of KEEP_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val) continue;

      if (attr === "id") {
        descriptor += `#${val}`;
      } else if (attr === "class") {
        // Keep first 2 classes only
        const classes = val.trim().split(/\s+/).slice(0, 2).join(".");
        if (classes) descriptor += `.${classes}`;
      } else {
        // Truncate long attribute values
        const truncVal = val.length > 30 ? val.substring(0, 27) + "..." : val;
        descriptor += `[${attr}="${truncVal}"]`;
      }
    }

    const indent = "  ".repeat(depth);
    const line = `${indent}${descriptor}`;
    lines.push(line);
    charCount += line.length + 1;

    // Recurse into children
    for (const child of el.childNodes) {
      if (truncated) break;
      walk(child, depth + 1);
    }
  }

  walk(root, 0);

  if (truncated) {
    lines.push("... (truncated)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Input Injection
// ---------------------------------------------------------------------------

/**
 * Inject text into a <textarea> or <input> element in a React-safe way.
 * Uses the native value setter to bypass React's synthetic event system.
 * @param {HTMLTextAreaElement|HTMLInputElement} el
 * @param {string} text
 */
function injectTextarea(el, text) {
  if (el.isContentEditable) {
    injectContentEditable(el, text);
    return;
  }

  // Attempt to use native prototype setter to bypass React
  let proto = null;
  if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
  else if (el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;

  if (proto) {
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  }

  // Fallback
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Inject text into a contenteditable element.
 * Uses Selection API + execCommand for broad compatibility with
 * frameworks that listen for input events on contenteditable divs.
 * @param {HTMLElement} el
 * @param {string} text
 */
function injectContentEditable(el, text) {
  el.focus();

  // Select all existing content
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);

  // Replace with new text via execCommand (fires input events naturally)
  document.execCommand("insertText", false, text);
}

// ---------------------------------------------------------------------------
// Send Trigger
// ---------------------------------------------------------------------------

/**
 * Trigger the "send" action — either by clicking the send button or
 * dispatching an Enter keypress.
 * Includes a small random jitter (100-300ms) for human-like timing.
 * @param {SelectorSet} selectors
 */
async function triggerSend(selectors) {
  // Random jitter for human-like delay
  await sleep(100 + Math.random() * 200);

  if (selectors.send_mechanism.type === "click") {
    const btn = document.querySelector(selectors.send_mechanism.selector);
    if (btn) {
      /** @type {HTMLElement} */ (btn).click();
    } else {
      throw new Error(
        `Send button not found: ${selectors.send_mechanism.selector}`
      );
    }
  } else if (selectors.send_mechanism.type === "key") {
    const input = document.querySelector(selectors.input_selector);
    if (!input) {
      throw new Error(
        `Input not found for Enter key dispatch: ${selectors.input_selector}`
      );
    }
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
      })
    );
  } else {
    throw new Error(`Unknown send mechanism type: ${selectors.send_mechanism.type}`);
  }
}

// ---------------------------------------------------------------------------
// Completion Detection
// ---------------------------------------------------------------------------

/**
 * Wait for a new response element to appear in the DOM.
 * Polls until the count of response containers exceeds `beforeCount`.
 * @param {SelectorSet} selectors
 * @param {number} beforeCount - Number of response elements before sending
 * @param {number} [timeout=15000] - Max wait time in ms
 * @returns {Promise<void>}
 */
async function waitForNewResponse(selectors, beforeCount, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const currentCount = document.querySelectorAll(
      selectors.response_container_selector
    ).length;
    if (currentCount > beforeCount) return;
    await sleep(250);
  }
  // Don't throw — the response might already be in an existing container
  console.warn(LOG_PREFIX, "Timed out waiting for new response element");
}

/**
 * Wait for the LLM to finish generating its response.
 *
 * Uses a two-pronged approach:
 *  1. **Primary**: Watch for the generating indicator (e.g. stop button) to
 *     appear and then disappear — this means generation is complete.
 *  2. **Fallback**: If the indicator never appears, use a MutationObserver
 *     idle heuristic — if the response container stops mutating for 800ms,
 *     assume completion.
 *
 * @param {SelectorSet} selectors
 * @param {number} [timeout=120000] - Safety timeout in ms
 * @returns {Promise<{complete: boolean, reason: string}>}
 */
async function waitForCompletion(selectors, timeout = 120000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let idleTimer = null;
    let indicatorFound = false;

    // --- Safety timeout ---
    const safetyTimeout = setTimeout(() => {
      cleanup();
      console.warn(LOG_PREFIX, "Completion detection timed out");
      resolve({ complete: false, reason: "timeout" });
    }, timeout);

    // --- Indicator observer (primary) ---
    const indicatorObserver = new MutationObserver(() => {
      const indicator = document.querySelector(
        selectors.generating_indicator_selector
      );
      if (indicator) {
        indicatorFound = true;
      } else if (indicatorFound && !indicator) {
        // Indicator appeared then disappeared → generation complete
        // Wait briefly for final render
        setTimeout(() => {
          cleanup();
          resolve({ complete: true, reason: "indicator_gone" });
        }, 300);
      }
    });

    // --- Response idle observer (fallback) ---
    // --- Response idle observer (fallback) ---
    let idleTimeoutMs = 4000; // Long initial wait for the AI to start typing (TTFB)
    
    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // Only use idle as fallback if indicator approach didn't trigger
        if (!indicatorFound) {
          cleanup();
          resolve({ complete: true, reason: "idle_timeout" });
        }
      }, idleTimeoutMs);
      
      // After the first timer reset (mutation), shorten the wait for faster completion
      idleTimeoutMs = 1500; 
    }

    const responseObserver = new MutationObserver(resetIdleTimer);
    
    // Kickoff the timer immediately in case there are no mutations!
    resetIdleTimer();

    // --- Start observing ---
    indicatorObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    const container =
      document.querySelector(selectors.response_container_selector);
    const observeTarget =
      (container && container.parentElement) || document.body;
    responseObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Also check if the indicator is already present right now
    if (document.querySelector(selectors.generating_indicator_selector)) {
      indicatorFound = true;
    }

    /**
     * Clean up all timers and observers.
     */
    function cleanup() {
      clearTimeout(safetyTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      indicatorObserver.disconnect();
      responseObserver.disconnect();
    }
  });
}

// ---------------------------------------------------------------------------
// Response Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the most recent assistant response from the page.
 * @param {SelectorSet} selectors
 * @returns {string|null}
 */
function extractResponse(selectors) {
  const responses = document.querySelectorAll(
    selectors.response_container_selector
  );
  if (responses.length === 0) return null;
  
  // Get the most recent response container
  const lastResponse = responses[responses.length - 1];
  
  // Try innerText first for clean text (only works if browser is in foreground)
  let text = lastResponse.innerText;
  if (text && text.trim()) {
    return text.trim();
  }
  
  // Fallback if innerText is empty (e.g. Chrome is in background/minimized)
  // We clone the node and remove visually hidden/auxiliary elements before getting textContent
  const clone = lastResponse.cloneNode(true);
  
  // Remove known Claude/ChatGPT auxiliary elements (thought blocks, screen reader only)
  const auxElements = clone.querySelectorAll('.sr-only, [aria-hidden="true"], details');
  auxElements.forEach(el => el.remove());
  
  text = clone.textContent;
  return text ? text.trim() : null;
}

/**
 * Maximum number of recalibration retries per request.
 * Prevents infinite loops if calibration keeps failing.
 */
const MAX_RECALIBRATE_RETRIES = 2;

/**
 * Execute the chat injection + extraction pipeline with the given selectors.
 * Throws on any selector failure so the caller can decide to recalibrate.
 *
 * @param {SelectorSet} selectors
 * @param {string} message
 * @returns {Promise<string>} The extracted response text
 */
async function executeChatPipeline(selectors, message) {
  // 1. Find and fill the input element
  const inputEl = document.querySelector(selectors.input_selector);
  if (!inputEl) {
    const err = new Error(`Input element not found: ${selectors.input_selector}`);
    err._selectorFailure = true;
    throw err;
  }

  if (selectors.input_type === "contenteditable") {
    injectContentEditable(/** @type {HTMLElement} */ (inputEl), message);
  } else {
    injectTextarea(
      /** @type {HTMLTextAreaElement|HTMLInputElement} */ (inputEl),
      message
    );
  }

  // 2. Count existing response elements (to detect the new one)
  const beforeCount = document.querySelectorAll(
    selectors.response_container_selector
  ).length;

  // 3. Trigger send
  try {
    await triggerSend(selectors);
  } catch (err) {
    err._selectorFailure = true;
    throw err;
  }

  // 4. Wait for a new response element to appear (up to 15s)
  await waitForNewResponse(selectors, beforeCount);

  // 5. Wait for generation to complete
  const completion = await waitForCompletion(selectors);
  console.log(LOG_PREFIX, `Completion: ${completion.reason}`);

  // 6. Small post-completion jitter for final rendering
  await sleep(100 + Math.random() * 200);

  // 7. Extract response
  const responseText = extractResponse(selectors);

  if (!responseText) {
    const err = new Error("Response extraction returned empty — DOM may have changed");
    err._selectorFailure = true;
    throw err;
  }

  return responseText;
}

/**
 * Handle a full chat request lifecycle with self-healing recalibration.
 *
 *  1. Resolve selectors for current domain
 *  2. Run the injection/extraction pipeline
 *  3. If a selector fails → clear cache, re-calibrate, retry (up to MAX_RECALIBRATE_RETRIES times)
 *
 * @param {string} requestId
 * @param {string} message
 * @returns {Promise<{type: string, request_id: string, response_text?: string, error?: string}>}
 */
async function handleChatRequest(requestId, message) {
  const domain = window.location.hostname;
  console.log(LOG_PREFIX, `Handling request ${requestId} on ${domain}`);

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RECALIBRATE_RETRIES; attempt++) {
    try {
      const forceCalibrate = attempt > 0; // recalibrate on retry
      const selectors = await getSelectors(domain, forceCalibrate);

      const responseText = await executeChatPipeline(selectors, message);

      console.log(
        LOG_PREFIX,
        `Response extracted (${responseText.length} chars) for ${requestId}` +
          (attempt > 0 ? ` (after ${attempt} recalibration(s))` : "")
      );

      return {
        type: "chat_response",
        request_id: requestId,
        response_text: responseText,
      };
    } catch (error) {
      lastError = error;

      if (error._selectorFailure && attempt < MAX_RECALIBRATE_RETRIES) {
        console.warn(
          LOG_PREFIX,
          `Selector failure on attempt ${attempt + 1}, recalibrating…`,
          error.message
        );
        await clearCachedSelectors(domain);
        // Brief pause before recalibration
        await sleep(500);
        continue;
      }

      // Non-selector error or max retries exceeded
      break;
    }
  }

  console.error(LOG_PREFIX, `Request ${requestId} failed after all attempts:`, lastError);
  return {
    type: "chat_error",
    request_id: requestId,
    error: lastError ? lastError.message : "Unknown error",
  };
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "chat_request": {
      console.log(LOG_PREFIX, `Received chat_request ${msg.request_id}`);

      // Run asynchronously, then respond via runtime message (not sendResponse)
      handleChatRequest(msg.request_id, msg.message).then((result) => {
        chrome.runtime.sendMessage(result);
      });

      // Acknowledge receipt immediately
      sendResponse({ ok: true, status: "processing" });
      break;
    }

    case "get_dom_snapshot": {
      // Utility: let the popup or background request a DOM snapshot
      const snapshot = compressDom();
      sendResponse({ ok: true, snapshot });
      break;
    }

    case "run_calibration_if_needed": {
      // Force getSelectors so it triggers LLM calibration if not cached/hardcoded
      console.log(LOG_PREFIX, "Link requested, running calibration if needed...");
      getSelectors(msg.domain, true).then(() => {
        console.log(LOG_PREFIX, "Calibration done/verified for linked tab.");
        sendResponse({ ok: true });
      }).catch(err => {
        console.error(LOG_PREFIX, "Failed to calibrate linked tab", err);
        sendResponse({ ok: false, error: err.message });
      });
      return true; // async response
    }

    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

console.log(
  LOG_PREFIX,
  `Content script loaded on ${window.location.hostname}`
);

})(); // End of duplicate injection guard

