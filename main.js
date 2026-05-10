// HA10 controller remap tool.
// Wire-format reverse-engineered against fk2.varmilo.com:
//   READ  request  : 55 1b 70 a9 00 00
//   READ  response : 55 1b 70 29 <27 role bytes> <padding>
//   WRITE request  : 55 1b 70 29 <27 role bytes> 1c
//   WRITE response : 55 00 55 f2 00 ...   (ACK)
// Firmware does not enforce uniqueness; duplicate role IDs persist.

const VID = 0x3783;
const PID = 0x0044;
const NUM_SLOTS = 27;

const SYNC = 0x55;
const TRAILER = 0x1c;
const READ_HEADER = [SYNC, 0x1b, 0x70, 0xa9, 0x00, 0x00];
const WRITE_HEADER = [SYNC, 0x1b, 0x70, 0x29];

// Button positions and slot indices extracted from fk2.varmilo.com Controller Mode page
// while the HA10 was connected. Each entry: slot index in the 27-byte payload (0-indexed)
// and absolute coords from the configurator viewport. We normalize x/y inside renderVisual().
//
// In the configurator DOM, each button has a `key-number` attribute (1-indexed). The
// corresponding slot index is `key-number - 1`. Default role at slot N is N+1, so a slot
// with its default value is "unswapped."
//
// 22 buttons total: 18 face panel buttons (slots 0-17) and 4 system buttons up top (slots
// 18-21). Slots 22-26 are phantom (no physical button).
const BUTTONS = [
  // Face panel — 18 buttons (configurator class keypadHA10 HA10Key1..HA10Key18)
  { slot: 0,  x: 463, y: 340, w: 47, group: "face" },
  { slot: 1,  x: 545, y: 341, w: 47, group: "face" },
  { slot: 2,  x: 348, y: 420, w: 50, group: "face" },
  { slot: 3,  x: 401, y: 392, w: 47, group: "face" },
  { slot: 4,  x: 451, y: 392, w: 47, group: "face" },
  { slot: 5,  x: 496, y: 414, w: 47, group: "face" },
  { slot: 6,  x: 543, y: 393, w: 47, group: "face" },
  { slot: 7,  x: 588, y: 374, w: 47, group: "face" },
  { slot: 8,  x: 639, y: 375, w: 47, group: "face" },
  { slot: 9,  x: 689, y: 380, w: 47, group: "face" },
  { slot: 10, x: 538, y: 444, w: 47, group: "face" },
  { slot: 11, x: 585, y: 425, w: 47, group: "face" },
  { slot: 12, x: 638, y: 425, w: 47, group: "face" },
  { slot: 13, x: 688, y: 431, w: 47, group: "face" },
  { slot: 14, x: 474, y: 484, w: 47, group: "face" },
  { slot: 15, x: 520, y: 514, w: 50, group: "face" },
  { slot: 16, x: 574, y: 492, w: 47, group: "face" },
  { slot: 17, x: 736, y: 488, w: 50, group: "face" },
  // Top row — 4 system buttons (configurator class topLeftCircle, key-numbers 19-22)
  { slot: 18, x: 296, y: 210, w: 52, group: "top" },
  { slot: 19, x: 432, y: 210, w: 52, group: "top" },
  { slot: 20, x: 568, y: 210, w: 52, group: "top" },
  { slot: 21, x: 704, y: 210, w: 52, group: "top" },
];

const slotName = (slot) => state.slots[slot]?.label || `slot ${slot}`;

// Layout bounding box derived from BUTTONS.
const VIS_BB = (() => {
  const xs = BUTTONS.map((b) => b.x);
  const ys = BUTTONS.map((b) => b.y);
  const ws = BUTTONS.map((b) => b.x + b.w);
  const hs = BUTTONS.map((b) => b.y + b.w);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...ws),
    maxY: Math.max(...hs),
  };
})();

const PHANTOM_SLOTS = (() => {
  const known = new Set(BUTTONS.map((b) => b.slot));
  return Array.from({ length: NUM_SLOTS }, (_, i) => i).filter((i) => !known.has(i));
})();

const LABEL_KEY = "ha10-remap-labels-v1";
const MAX_LOG_LINES = 200;
const MAX_INPUT_LINES = 30;

const $ = (sel) => document.querySelector(sel);
const els = {
  connect: $("#connect"),
  disconnect: $("#disconnect"),
  forget: $("#forget"),
  read: $("#read"),
  apply: $("#apply"),
  reset: $("#reset"),
  exportBtn: $("#export"),
  importBtn: $("#import"),
  deviceStatus: $("#device-status"),
  slotsBody: $("#slots tbody"),
  log: $("#log"),
  inputLog: $("#input-test-log"),

  tabs: document.querySelectorAll(".tab"),
  panels: document.querySelectorAll(".tab-panel"),

  visLayout: $("#visual-layout"),
  visEmpty: $("#visual-empty"),
  visDetail: $("#visual-detail"),
  detailSlots: $("#detail-slots"),
  detailLabelRow: $("#detail-label-row"),
  detailLabelInput: $("#detail-label-input"),
  detailCurrentRole: $("#detail-current-role"),
  detailDefaultRole: $("#detail-default-role"),
  detailRoleInput: $("#detail-role-input"),
  detailApply: $("#detail-apply"),
  detailReset: $("#detail-reset"),
  detailClear: $("#detail-clear"),
  detailCopyFrom: $("#detail-copy-from"),
  detailCopyApply: $("#detail-copy-apply"),
};

let device = null;
const state = {
  slots: Array.from({ length: NUM_SLOTS }, (_, i) => ({ label: "", value: i + 1 })),
  selectedSlots: new Set(), // slot indices currently selected on the visual layout
};

const hex = (data) => {
  const arr = data instanceof Uint8Array ? data
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join(" ");
};

const ts = () => new Date().toISOString().slice(11, 23);

function log(line) {
  const existing = els.log.textContent.split("\n").slice(0, MAX_LOG_LINES).join("\n");
  els.log.textContent = `[${ts()}] ${line}\n` + existing;
}

function logInput(line) {
  const existing = els.inputLog.textContent.split("\n").slice(0, MAX_INPUT_LINES).join("\n");
  els.inputLog.textContent = `[${ts()}] ${line}\n` + existing;
}

function loadLabels() {
  try {
    const labels = JSON.parse(localStorage.getItem(LABEL_KEY) || "[]");
    labels.forEach((l, i) => {
      if (state.slots[i]) state.slots[i].label = l || "";
    });
  } catch {}
}

function saveLabels() {
  localStorage.setItem(LABEL_KEY, JSON.stringify(state.slots.map((s) => s.label)));
}

// Returns map: roleId → count.
function roleCounts() {
  const counts = new Map();
  state.slots.forEach((s) => counts.set(s.value, (counts.get(s.value) || 0) + 1));
  return counts;
}

function renderSlots() {
  const counts = roleCounts();
  const rows = state.slots.map((slot, i) => {
    const isDup = counts.get(slot.value) > 1;
    const labelEsc = slot.label.replace(/"/g, "&quot;");
    return `
      <tr class="${isDup ? "duplicate" : ""}">
        <td class="col-i">${i}</td>
        <td class="col-label"><input type="text" data-i="${i}" data-field="label" value="${labelEsc}" placeholder="(unlabeled)" /></td>
        <td class="col-value"><input type="number" data-i="${i}" data-field="value" min="0" max="255" value="${slot.value}" /></td>
        <td class="col-hex">0x${slot.value.toString(16).padStart(2, "0")}</td>
      </tr>`;
  });
  els.slotsBody.innerHTML = rows.join("");
}

function onSlotInput(e) {
  const t = e.target;
  if (!t.matches("input")) return;
  const i = +t.dataset.i;
  const field = t.dataset.field;
  if (Number.isNaN(i) || !state.slots[i]) return;

  if (field === "label") {
    state.slots[i].label = t.value;
    saveLabels();
  } else if (field === "value") {
    const v = Math.max(0, Math.min(255, parseInt(t.value, 10) || 0));
    state.slots[i].value = v;
    const activeIdx = i;
    renderSlots();
    renderVisual();
    const refocus = els.slotsBody.querySelector(
      `input[data-i="${activeIdx}"][data-field="value"]`,
    );
    if (refocus) {
      refocus.focus();
      refocus.setSelectionRange(refocus.value.length, refocus.value.length);
    }
  }
}

// === Visual layout ===

function renderVisual() {
  const counts = roleCounts();
  const padding = 16;
  const w = VIS_BB.maxX - VIS_BB.minX;
  const h = VIS_BB.maxY - VIS_BB.minY;
  els.visLayout.style.width = `${w + padding * 2}px`;
  els.visLayout.style.height = `${h + padding * 2}px`;

  els.visLayout.innerHTML = BUTTONS.map((b) => {
    const slot = state.slots[b.slot];
    const isDefault = slot.value === b.slot + 1;
    const isDup = counts.get(slot.value) > 1;
    const isSelected = state.selectedSlots.has(b.slot);
    let kind = "default";
    if (isDup) kind = "duplicate";
    else if (!isDefault) kind = "modified";

    const left = b.x - VIS_BB.minX + padding;
    const top = b.y - VIS_BB.minY + padding;

    const name = slotName(b.slot);
    return `
      <button class="vbtn vbtn-${b.group} vbtn-${kind} ${isSelected ? "vbtn-selected" : ""}"
              data-slot="${b.slot}"
              style="left: ${left}px; top: ${top}px; width: ${b.w}px; height: ${b.w}px"
              title="slot ${b.slot} (${name}) — K${slot.value}">
        <span class="vbtn-name">${name}</span>
        <span class="vbtn-meta">K${slot.value}</span>
      </button>`;
  }).join("");

  renderVisualSidePanel();
  renderCopyFromOptions();
}

function renderVisualSidePanel() {
  const slots = Array.from(state.selectedSlots).sort((a, b) => a - b);
  if (slots.length === 0) {
    els.visEmpty.hidden = false;
    els.visDetail.hidden = true;
    return;
  }
  els.visEmpty.hidden = true;
  els.visDetail.hidden = false;

  const named = slots.map((s) => `${s} (${slotName(s)})`);
  els.detailSlots.textContent = named.join(", ");

  // Show inline label editor when exactly one slot is selected.
  if (slots.length === 1) {
    els.detailLabelRow.hidden = false;
    els.detailLabelInput.value = state.slots[slots[0]].label || "";
  } else {
    els.detailLabelRow.hidden = true;
  }

  const values = slots.map((s) => state.slots[s].value);
  const distinct = [...new Set(values)];
  els.detailCurrentRole.textContent =
    distinct.length === 1
      ? `K${distinct[0]} (0x${distinct[0].toString(16).padStart(2, "0")})`
      : `mixed: ${distinct.map((v) => `K${v}`).join(", ")}`;

  const defaults = slots.map((s) => `K${s + 1}`);
  els.detailDefaultRole.textContent = defaults.join(", ");

  if (distinct.length === 1) {
    els.detailRoleInput.value = distinct[0];
  } else {
    els.detailRoleInput.value = "";
    els.detailRoleInput.placeholder = "(mixed)";
  }
}

function renderCopyFromOptions() {
  const opts = ['<option value="">(choose source)</option>'];
  BUTTONS.forEach((b) => {
    const slot = state.slots[b.slot];
    opts.push(
      `<option value="${b.slot}">${slotName(b.slot)} — slot ${b.slot}, K${slot.value}</option>`,
    );
  });
  const cur = els.detailCopyFrom.value;
  els.detailCopyFrom.innerHTML = opts.join("");
  if (cur) els.detailCopyFrom.value = cur;
}

function onVisualClick(e) {
  const btn = e.target.closest(".vbtn");
  if (!btn) return;
  const slot = +btn.dataset.slot;
  if (!e.shiftKey) state.selectedSlots.clear();
  if (state.selectedSlots.has(slot)) state.selectedSlots.delete(slot);
  else state.selectedSlots.add(slot);
  renderVisual();
}

function applySelectionRole(value) {
  const v = Math.max(0, Math.min(255, parseInt(value, 10) || 0));
  state.selectedSlots.forEach((slot) => {
    state.slots[slot].value = v;
  });
  renderVisual();
  renderSlots();
}

function resetSelectionToDefault() {
  state.selectedSlots.forEach((slot) => {
    state.slots[slot].value = slot + 1;
  });
  renderVisual();
  renderSlots();
}

function copyRoleFromTarget(targetSlotIdx) {
  const targetVal = state.slots[targetSlotIdx].value;
  state.selectedSlots.forEach((slot) => {
    state.slots[slot].value = targetVal;
  });
  renderVisual();
  renderSlots();
}

// === Device communication ===

// macOS WebHID is flaky: open() often rejects on the first attempt even when no
// other process holds the device, then succeeds on a retry. Retry with backoff
// so the user doesn't see spurious failures.
async function openWithRetry(d, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      if (d.opened) return;
      await d.open();
      if (i > 0) log(`open() succeeded on attempt ${i + 1}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`open() attempt ${i + 1}/${attempts} failed: ${e.message}`);
      if (i < attempts - 1) {
        const delay = 250 * (i + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function describeCollections(d) {
  return d.collections
    .map((c) => `usagePage=0x${c.usagePage.toString(16).padStart(4, "0")} usage=0x${c.usage.toString(16).padStart(2, "0")}`)
    .join(" | ");
}

async function tryUseDevice(d) {
  log(`device collections (${d.collections.length}): ${describeCollections(d)}`);
  await openWithRetry(d);
  device = d;
  device.addEventListener("inputreport", onInputReport);
  setStatus(
    `Connected: ${device.productName} (vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)})`,
    "connected",
  );
  els.connect.disabled = true;
  els.disconnect.disabled = false;
  els.forget.disabled = false;
  els.read.disabled = false;
  els.apply.disabled = false;
  els.reset.disabled = false;
  log("connected");
  await readMapping();
}

async function connect() {
  if (!navigator.hid) {
    setStatus("WebHID not available in this browser", "error");
    return;
  }
  try {
    // Try the vendor-defined collection first. Chrome refuses to open() a device
    // when any granted collection is "protected" (keyboard usage 0x01:0x06,
    // mouse usage 0x01:0x02, etc.) — a broad VID/PID-only pairing would grant
    // access to the keyboard interface and break open(). Filtering by usagePage
    // restricts the grant to non-protected collections.
    log("requesting device with usagePage=0xFF00 filter");
    let devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VID, productId: PID, usagePage: 0xff00 }],
    });
    if (devices.length === 0) {
      log("no device matched 0xFF00; retrying with broad VID/PID filter");
      devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: VID, productId: PID }],
      });
    }
    if (devices.length === 0) {
      log("no device selected");
      return;
    }
    await tryUseDevice(devices[0]);
  } catch (e) {
    handleOpenError(e);
  }
}

function handleOpenError(e) {
  log("connect failed after retries: " + e.message);
  let suggestion = "";
  if (/open|access|busy/i.test(e.message)) {
    suggestion =
      " — try: (1) click Forget then Connect to fully re-pair, (2) close any other Varmilo tab, or (3) unplug + replug the controller.";
  }
  setStatus("Connect failed: " + e.message + suggestion, "error");
}

async function disconnect() {
  if (!device) return;
  try {
    if (device.opened) await device.close();
  } catch (e) {
    log("disconnect close() failed: " + e.message);
  }
  device.removeEventListener?.("inputreport", onInputReport);
  device = null;
  setStatus("Disconnected", "");
  els.connect.disabled = false;
  els.disconnect.disabled = true;
  els.forget.disabled = true;
  els.read.disabled = true;
  els.apply.disabled = true;
  els.reset.disabled = true;
  log("disconnected");
}

// Revoke the WebHID permission for this device on this origin. Useful when the
// permission state is wedged (paired but open() keeps failing).
async function forget() {
  if (!navigator.hid) return;
  try {
    // Forget the currently-attached device if there is one.
    if (device?.forget) {
      await device.forget();
      log("device.forget() called on attached device");
    }
    // Also forget any other paired matching devices.
    const devices = await navigator.hid.getDevices();
    for (const d of devices) {
      if (d.vendorId === VID && d.productId === PID && d.forget) {
        try {
          await d.forget();
          log(`device.forget() called on paired ${d.productName || ""}`);
        } catch (e) {
          log("forget() failed for one device: " + e.message);
        }
      }
    }
  } catch (e) {
    log("forget() error: " + e.message);
  }
  device = null;
  setStatus("Forgotten — click Connect to re-pair", "");
  els.connect.disabled = false;
  els.disconnect.disabled = true;
  els.forget.disabled = true;
  els.read.disabled = true;
  els.apply.disabled = true;
  els.reset.disabled = true;
}

// On page load, try to silently re-attach to a previously-paired device.
async function tryAutoReconnect() {
  if (!navigator.hid) {
    setStatus("WebHID not available in this browser", "error");
    return;
  }
  log("auto-reconnect: checking origin's paired-device list");
  try {
    const devices = await navigator.hid.getDevices();
    const summary = devices
      .map((d) => `0x${d.vendorId.toString(16)}:0x${d.productId.toString(16)} ${d.productName || ""}`)
      .join(", ") || "(none)";
    log(`auto-reconnect: this origin has ${devices.length} paired device(s): ${summary}`);
    const ha10 = devices.find((d) => d.vendorId === VID && d.productId === PID);
    if (!ha10) {
      setStatus(
        "Not paired with this origin — click Connect to pair the HA10 with localhost:5173",
        "",
      );
      return;
    }
    // The device is paired — enable Forget even if open() fails below.
    els.forget.disabled = false;
    log("auto-reconnect: HA10 in paired list, attempting open()");
    await tryUseDevice(ha10);
  } catch (e) {
    handleOpenError(e);
  }
}

function setStatus(text, cls) {
  els.deviceStatus.textContent = text;
  els.deviceStatus.className = cls || "";
}

function onInputReport(event) {
  const data = new Uint8Array(event.data.buffer);
  const h = hex(data);
  const trimmed = h.replace(/( 00)+$/, "");

  if (
    data[0] === SYNC &&
    data[1] === 0x1b &&
    data[2] === 0x70 &&
    data[3] === 0x29 &&
    data.byteLength >= 4 + NUM_SLOTS
  ) {
    log(`IN  ${trimmed}  → mapping read`);
    const payload = data.slice(4, 4 + NUM_SLOTS);
    payload.forEach((v, i) => {
      state.slots[i].value = v;
    });
    renderSlots();
    renderVisual();
    return;
  }

  if (data[0] === SYNC && data[1] === 0x00 && data[2] === 0x55 && data[3] === 0xf2) {
    log(`IN  ${trimmed}  → ACK`);
    return;
  }

  log(`IN  ${trimmed}`);
  logInput(trimmed);
}

async function readMapping() {
  if (!device) return;
  const packet = new Uint8Array(READ_HEADER);
  await device.sendReport(0, packet);
  log(`OUT ${hex(packet)}  → read request`);
}

async function applyMapping() {
  if (!device) return;
  const payload = state.slots.map((s) => s.value);
  const packet = new Uint8Array([...WRITE_HEADER, ...payload, TRAILER]);
  await device.sendReport(0, packet);
  log(`OUT ${hex(packet)}  → write request`);
  setTimeout(() => readMapping(), 250);
}

function resetSlots() {
  state.slots.forEach((s, i) => {
    s.value = i + 1;
  });
  renderSlots();
  renderVisual();
}

// === Import / export ===

function exportLayout() {
  const data = {
    version: 1,
    device: "HA10",
    exportedAt: new Date().toISOString(),
    values: state.slots.map((s) => s.value),
    labels: state.slots.map((s) => s.label),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.download = `ha10-layout-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`exported layout (${a.download})`);
}

function importLayout() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.values) || data.values.length !== NUM_SLOTS) {
        throw new Error(`expected "values" array of length ${NUM_SLOTS}, got ${data.values?.length ?? "none"}`);
      }
      data.values.forEach((v, i) => {
        const n = parseInt(v, 10);
        if (Number.isNaN(n) || n < 0 || n > 255) {
          throw new Error(`invalid value at index ${i}: ${v}`);
        }
        state.slots[i].value = n;
      });
      if (Array.isArray(data.labels)) {
        data.labels.forEach((l, i) => {
          if (state.slots[i]) state.slots[i].label = typeof l === "string" ? l : "";
        });
        saveLabels();
      }
      renderVisual();
      renderSlots();
      log(`imported layout from ${file.name}`);
    } catch (err) {
      log("import failed: " + err.message);
      alert("Import failed: " + err.message);
    }
  });
  input.click();
}

// === Tabs ===

function switchTab(name) {
  els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  els.panels.forEach((p) => {
    const isActive = p.id === `tab-${name}`;
    p.classList.toggle("active", isActive);
    p.hidden = !isActive;
  });
}

els.tabs.forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

// === Init ===

els.connect.addEventListener("click", connect);
els.disconnect.addEventListener("click", disconnect);
els.forget.addEventListener("click", forget);
els.read.addEventListener("click", readMapping);
els.apply.addEventListener("click", applyMapping);
els.reset.addEventListener("click", resetSlots);
els.exportBtn.addEventListener("click", exportLayout);
els.importBtn.addEventListener("click", importLayout);
els.slotsBody.addEventListener("input", onSlotInput);
els.visLayout.addEventListener("click", onVisualClick);
els.visLayout.addEventListener("contextmenu", (e) => {
  const btn = e.target.closest(".vbtn");
  if (!btn) return;
  e.preventDefault();
  const slot = +btn.dataset.slot;
  const current = state.slots[slot].label || "";
  const next = window.prompt(`Rename slot ${slot}:`, current);
  if (next === null) return;
  state.slots[slot].label = next;
  saveLabels();
  renderVisual();
  renderSlots();
});

// Watch for plug/unplug while the page is open.
if (navigator.hid) {
  navigator.hid.addEventListener("connect", (e) => {
    if (e.device.vendorId === VID && e.device.productId === PID && !device) {
      log("HID connect event — attempting auto-reconnect");
      tryUseDevice(e.device).catch(handleOpenError);
    }
  });
  navigator.hid.addEventListener("disconnect", (e) => {
    if (device && e.device === device) {
      log("HID disconnect event");
      disconnect();
    }
  });
}

// Best-effort release of the device handle when the user navigates away,
// so other tabs (or our own next reload) can re-open.
window.addEventListener("beforeunload", () => {
  if (device?.opened) {
    try { device.close(); } catch {}
  }
});

els.detailApply.addEventListener("click", () => applySelectionRole(els.detailRoleInput.value));
els.detailRoleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applySelectionRole(els.detailRoleInput.value);
  }
});
els.detailReset.addEventListener("click", resetSelectionToDefault);
els.detailClear.addEventListener("click", () => {
  state.selectedSlots.clear();
  renderVisual();
});
els.detailCopyApply.addEventListener("click", () => {
  const v = els.detailCopyFrom.value;
  if (v === "") return;
  copyRoleFromTarget(+v);
});

els.detailLabelInput.addEventListener("input", (e) => {
  const slots = Array.from(state.selectedSlots);
  if (slots.length !== 1) return;
  state.slots[slots[0]].label = e.target.value;
  saveLabels();
  // Update the visible button name without rebuilding the whole layout (which would
  // steal focus from the input).
  const btn = els.visLayout.querySelector(`.vbtn[data-slot="${slots[0]}"] .vbtn-name`);
  if (btn) btn.textContent = e.target.value || `slot ${slots[0]}`;
  renderSlots();
  renderCopyFromOptions();
});

loadLabels();
renderSlots();
renderVisual();
tryAutoReconnect();
