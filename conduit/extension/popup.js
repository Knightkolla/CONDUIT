"use strict";

// Known outlets, always shown on the spine so the path reads consistently.
// Active ones (returned by the backend) light up; the rest sit dim/unwired.
const KNOWN = [
  { id: "chatgpt", host: "chatgpt.com" },
  { id: "claude", host: "claude.ai" },
  { id: "gemini", host: "gemini.google.com" },
];

const ENDPOINT = "http://localhost:8765/v1/chat";

const curlFor = (provider) =>
  `curl -X POST ${ENDPOINT} \\\n  -H "Content-Type: application/json" \\\n  -d '{"provider":"${provider}","prompt":"Hello!"}'`;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render({ connected, providers }) {
  providers = providers || [];
  const active = new Set(providers);
  const wrap = document.getElementById("wrap");
  const pill = document.getElementById("pillLabel");
  const readout = document.getElementById("readout");
  const inletNode = document.getElementById("inletNode");
  const rail = document.getElementById("rail");

  // Merge known outlets with any extra active ones the backend reports.
  const outlets = KNOWN.slice();
  providers.forEach((p) => { if (!outlets.some((o) => o.id === p)) outlets.push({ id: p, host: p }); });

  // State: live = routing with outlets, idle = backend up but nothing wired, offline = backend down.
  let state;
  if (!connected) state = "offline";
  else if (active.size > 0) state = "live";
  else state = "idle";
  wrap.setAttribute("data-state", state);

  // Header pill + readout copy (direction, not mood).
  if (state === "live") {
    pill.textContent = "Live";
    const n = active.size;
    readout.innerHTML = `Routing on <b>:8765</b> &middot; ${n} outlet${n === 1 ? "" : "s"} wired`;
  } else if (state === "idle") {
    pill.textContent = "Idle";
    readout.innerHTML = `Backend up on <b>:8765</b> &middot; open an LLM tab to wire an outlet`;
  } else {
    pill.textContent = "Offline";
    readout.innerHTML = `Backend down &middot; run <b>start.sh</b> to open the conduit`;
  }

  // Inlet node lit whenever the backend is reachable.
  inletNode.classList.toggle("lit", !!connected);

  // Rebuild outlet stops (remove old ones, keep inlet).
  rail.querySelectorAll(".stop.outlet").forEach((el) => el.remove());
  outlets.forEach((o) => {
    const on = active.has(o.id);
    const row = document.createElement("div");
    row.className = "stop outlet " + (on ? "on" : "off");
    row.innerHTML =
      `<span class="node ${on ? "lit" : ""}"></span>` +
      `<span class="pname">${esc(o.id)}</span>` +
      `<span class="phost">${esc(o.host)}</span>` +
      `<span class="tag">${on ? "wired" : "open"}</span>`;
    rail.appendChild(row);
  });

  // Quick-start curl targets the first live outlet, else a sensible default.
  const target = providers[0] || "chatgpt";
  const block = document.getElementById("curlBlock");
  const hint = block.querySelector(".hint");
  block.innerHTML = curlFor(target)
    .replace(/^curl/, '<span class="k">curl</span>')
    .replace(/POST/, '<span class="k">POST</span>');
  if (hint) {
    block.appendChild(hint);
  } else {
    const newHint = document.createElement("span");
    newHint.className = "hint";
    newHint.textContent = "click to copy";
    block.appendChild(newHint);
  }
  block.dataset.copy = curlFor(target);
}

function copyText(str, btn) {
  navigator.clipboard.writeText(str).then(() => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.classList.add("ok");
    btn.textContent = "✓";
    setTimeout(() => { btn.classList.remove("ok"); btn.textContent = prev; }, 1400);
  });
}

function fetchStatus() {
  // Inside the extension: ask the background worker. Outside it (preview/dev): demo state.
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    // In preview mode, allow the body/html to expand and fill the screen
    document.documentElement.style.width = "auto";
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.minHeight = "100vh";

    // Show preview controls in browser preview mode
    const previewSwitch = document.getElementById("switch");
    if (previewSwitch) previewSwitch.style.display = "flex";
    document.querySelectorAll(".caption").forEach((el) => el.style.display = "block");

    const STATES = {
      live: { connected: true, providers: ["chatgpt", "claude"] },
      idle: { connected: true, providers: [] },
      offline: { connected: false, providers: [] },
    };

    const switchEl = document.getElementById("switch");
    if (switchEl && !switchEl.dataset.wired) {
      switchEl.dataset.wired = "true";
      switchEl.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        document.querySelectorAll("#switch button").forEach((x) => x.classList.toggle("active", x === b));
        render(STATES[b.dataset.s]);
      });
    }

    render(STATES.live);
    return;
  }

  // Hide preview controls in actual extension context
  const previewSwitch = document.getElementById("switch");
  if (previewSwitch) previewSwitch.style.display = "none";
  document.querySelectorAll(".caption").forEach((el) => el.style.display = "none");

  chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
    if (chrome.runtime.lastError || !resp) render({ connected: false, providers: [] });
    else render(resp);
  });
}

document.getElementById("copyEndpoint").addEventListener("click", (e) => {
  e.stopPropagation();
  copyText(ENDPOINT, e.currentTarget);
});

const curlBlock = document.getElementById("curlBlock");
function copyCurl() {
  copyText(curlBlock.dataset.copy || curlBlock.innerText);
  const hint = curlBlock.querySelector(".hint");
  if (hint) { hint.textContent = "copied"; setTimeout(() => { hint.textContent = "click to copy"; }, 1400); }
}
curlBlock.addEventListener("click", copyCurl);
curlBlock.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyCurl(); } });

fetchStatus();