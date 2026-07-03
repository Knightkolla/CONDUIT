/**
 * LLM-to-API Bridge — Popup Script
 *
 * Reads connection state and cached selector data from chrome.storage.local,
 * renders status / domain list / recent requests, and wires up user actions.
 * Auto-refreshes every 2 seconds.
 */

"use strict";

const LOG_PREFIX = "[LLM Bridge Popup]";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const statusDot      = document.getElementById("status-dot");
const statusText     = document.getElementById("status-text");
const serverUrl      = document.getElementById("server-url");
const lastConnected  = document.getElementById("last-connected");
const domainsList    = document.getElementById("domains-list");
const requestsList   = document.getElementById("requests-list");
const btnClearAll    = document.getElementById("btn-clear-all");
const btnLinkTab     = document.getElementById("btn-link-tab");
const linkedTabText  = document.getElementById("linked-tab-text");

// Internal system keys that should NOT be rendered as cached domains
const SYSTEM_KEYS = new Set([
  "ws_connected",
  "last_connected",
  "recent_requests",
  "linked_tab_id",
  "linked_domain"
]);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Refresh all popup UI from chrome.storage.local.
 */
async function refreshUI() {
  try {
    const all = await chrome.storage.local.get(null);

    // --- Connection status ---
    const connected = !!all.ws_connected;
    statusDot.className = connected
      ? "status-dot status-dot--connected"
      : "status-dot";
    statusText.textContent = connected ? "Connected" : "Disconnected";

    if (all.last_connected) {
      lastConnected.textContent = formatTimestamp(all.last_connected);
    } else {
      lastConnected.textContent = "—";
    }

    // --- Cached domains ---
    renderDomains(all);

    // --- Tab Linking ---
    if (all.linked_domain && all.linked_tab_id) {
      linkedTabText.textContent = `Linked to: ${all.linked_domain} (Tab ${all.linked_tab_id})`;
      btnLinkTab.textContent = "🔗 Re-link Current Tab";
    } else {
      linkedTabText.textContent = "No tab linked";
      btnLinkTab.textContent = "🔗 Calibrate & Link Current Tab";
    }

    // --- Recent requests ---
    renderRequests(all.recent_requests || []);
  } catch (err) {
    console.error(LOG_PREFIX, "Failed to refresh UI", err);
  }
}

/**
 * Render the list of cached domains.
 * Any key in storage that isn't a system key and has a `.selectors` property
 * is treated as a cached domain entry.
 * @param {object} storageData
 */
function renderDomains(storageData) {
  const domains = [];

  for (const [key, value] of Object.entries(storageData)) {
    if (SYSTEM_KEYS.has(key)) continue;
    if (value && typeof value === "object" && value.selectors) {
      domains.push({ domain: key, data: value });
    }
  }

  if (domains.length === 0) {
    domainsList.innerHTML = '<p class="empty-state">No cached domains</p>';
    return;
  }

  domainsList.innerHTML = domains
    .map(({ domain, data }) => {
      const calibratedAt = data.calibrated_at
        ? `Calibrated ${formatTimestamp(data.calibrated_at)}`
        : "Hardcoded fallback";
      return `
        <div class="domain-card">
          <div>
            <div class="domain-card__name">${escapeHtml(domain)}</div>
            <div class="domain-card__meta">${escapeHtml(calibratedAt)}</div>
          </div>
          <div class="domain-card__actions">
            <button class="btn btn--small btn--accent" data-domain="${escapeHtml(domain)}" title="Recalibrate selectors">Recalibrate</button>
          </div>
        </div>
      `;
    })
    .join("");

  // Wire up recalibrate buttons
  domainsList.querySelectorAll("[data-domain]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const domain = btn.getAttribute("data-domain");
      recalibrateDomain(domain);
    });
  });
}

/**
 * Render the list of recent requests.
 * @param {Array<object>} requests
 */
function renderRequests(requests) {
  if (!requests || requests.length === 0) {
    requestsList.innerHTML = '<p class="empty-state">No recent requests</p>';
    return;
  }

  requestsList.innerHTML = requests
    .map((req) => {
      const statusClass = req.status === "error"
        ? "request-entry--error"
        : req.status === "completed"
          ? "request-entry--completed"
          : "";

      const statusLabelClass = `request-entry__status--${req.status || "received"}`;

      const shortId = req.request_id
        ? req.request_id.substring(0, 8)
        : "—";

      let details = "";
      if (req.message) {
        details += `<div class="request-entry__message">${escapeHtml(req.message)}</div>`;
      }
      if (req.error) {
        details += `<div class="request-entry__error">⚠ ${escapeHtml(req.error)}</div>`;
      }

      return `
        <div class="request-entry ${statusClass}">
          <div class="request-entry__header">
            <span class="request-entry__id">${escapeHtml(shortId)}${req.domain ? " · " + escapeHtml(req.domain) : ""}</span>
            <span class="request-entry__status ${statusLabelClass}">${escapeHtml(req.status || "unknown")}</span>
          </div>
          ${details}
          <div class="request-entry__time">${req.timestamp ? formatTimestamp(req.timestamp) : ""}</div>
        </div>
      `;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Remove a cached domain's selectors and request re-calibration.
 * @param {string} domain
 */
async function recalibrateDomain(domain) {
  try {
    await chrome.storage.local.remove(domain);
    console.log(LOG_PREFIX, `Cleared cache for ${domain}`);
    await refreshUI();
  } catch (err) {
    console.error(LOG_PREFIX, "Recalibrate failed", err);
  }
}

/**
 * Clear all cached domains and recent requests.
 */
async function clearAllCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = [];

    for (const key of Object.keys(all)) {
      if (!SYSTEM_KEYS.has(key) || key === "recent_requests") {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }

    console.log(LOG_PREFIX, "Cleared all cached data");
    await refreshUI();
  } catch (err) {
    console.error(LOG_PREFIX, "Clear all failed", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a unix timestamp (ms) into a short human-readable string.
 * @param {number} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  const date = new Date(ts);
  const now = new Date();

  // If today, show time only
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // Otherwise show date + time
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Basic HTML escaping to prevent XSS in rendered content.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Wire up buttons
btnClearAll.addEventListener("click", clearAllCache);
btnLinkTab.addEventListener("click", () => {
  btnLinkTab.textContent = "⏳ Calibrating... (Takes ~3-5s)";
  btnLinkTab.disabled = true;
  btnLinkTab.style.opacity = "0.7";
  btnLinkTab.style.cursor = "wait";
  
  chrome.runtime.sendMessage({ type: "link_active_tab" }, (response) => {
    btnLinkTab.disabled = false;
    btnLinkTab.style.opacity = "1";
    btnLinkTab.style.cursor = "pointer";
    
    if (response && response.ok) {
      btnLinkTab.textContent = "✅ Calibration Successful!";
      btnLinkTab.style.background = "#22c55e"; // Success green
      
      setTimeout(() => {
        btnLinkTab.style.background = ""; // Reset to default
        refreshUI();
      }, 2000);
    } else {
      btnLinkTab.textContent = "❌ Calibration Failed";
      btnLinkTab.style.background = "#ef4444"; // Error red
      console.error(LOG_PREFIX, "Link active tab failed", response);
      
      setTimeout(() => {
        btnLinkTab.style.background = ""; // Reset to default
        refreshUI();
      }, 3000);
    }
  });
});

// Initial render
refreshUI();

// Auto-refresh every 2 seconds
setInterval(refreshUI, 2000);
