const $ = (sel) => document.querySelector(sel);

const QUICK_LAUNCH_STORAGE_KEY = "firetv.quickLaunchApps";
const MAX_QUICK_LAUNCH_APPS = 12;
const KNOWN_APP_NAMES = {
  "com.amazon.firebat": "Prime Video",
  "com.netflix.ninja": "Netflix",
  "com.amazon.firetv.youtube.tv": "YouTube TV",
  "com.hulu.plus": "Hulu",
  "com.amazon.tv.launcher": "Fire TV Home",
  "tv.twitch.android.app": "Twitch",
  "com.google.android.youtube.tv": "YouTube",
  "com.spotify.tv.android": "Spotify",
  "com.disney.disneyplus": "Disney+",
  "com.espn.score_center": "ESPN",
  "com.peacocktv.peacockandroid": "Peacock",
  "com.cbs.ca": "Paramount+",
  "com.max.viewer": "Max",
};

let savedDevices = [];
let editingDeviceId = null;
let connectedHost = "";
let isConnected = false;
let isSendingText = false;
let isConnecting = false;
let isDeviceModalOpen = false;
let allApps = [];
let quickLaunchApps = [];
let isQuickLaunchEditMode = false;
let quickLaunchSelectionMissing = false;
let appSearchQuery = "";
let isLoadingApps = false;
let quickLaunchError = "";

function normalizeHostValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.includes(":") ? raw : `${raw}:5555`;
}

function getDraftHost() {
  return $("#hostInput").value.trim();
}

function getNormalizedDraftHost() {
  return normalizeHostValue(getDraftHost());
}

function currentTargetMatchesConnection() {
  const draftHost = getNormalizedDraftHost();
  return Boolean(connectedHost) && draftHost === connectedHost;
}

function canControlCurrentTarget() {
  return isConnected && currentTargetMatchesConnection();
}

function getFriendlyAppName(pkg) {
  if (KNOWN_APP_NAMES[pkg]) return KNOWN_APP_NAMES[pkg];

  const raw = String(pkg || "").split(".").pop() || String(pkg || "");
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b(tv|app|android|launcher|firetv)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || pkg;
}

function sortPackages(packages) {
  return [...packages].sort((a, b) => getFriendlyAppName(a).localeCompare(getFriendlyAppName(b)));
}

function createEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "saved-devices-empty";
  empty.textContent = message;
  return empty;
}

function readQuickLaunchSelection() {
  try {
    const raw = localStorage.getItem(QUICK_LAUNCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function persistQuickLaunchSelection() {
  localStorage.setItem(QUICK_LAUNCH_STORAGE_KEY, JSON.stringify(quickLaunchApps));
}

function flashIndicator() {
  try {
    const indicator = $("#indicator");
    if (indicator) {
      indicator.classList.add("active");
      setTimeout(() => indicator.classList.remove("active"), 200);
    }
  } catch (_) {}
}

function openDeviceModal() {
  const modal = $("#deviceModal");
  modal.hidden = false;
  isDeviceModalOpen = true;
  $("#openDeviceManagerBtn").setAttribute("aria-expanded", "true");
}

function closeDeviceModal() {
  const modal = $("#deviceModal");
  modal.hidden = true;
  isDeviceModalOpen = false;
  $("#openDeviceManagerBtn").setAttribute("aria-expanded", "false");
}

function setConnectionStatus(message, tone) {
  const status = $("#connectionStatus");
  status.textContent = message;
  status.classList.remove("success", "error", "connecting");
  if (tone) status.classList.add(tone);
}

function setTextStatus(message, tone) {
  const textStatus = $("#textStatus");
  textStatus.textContent = message;
  textStatus.classList.remove("success", "error", "sending");
  if (tone) textStatus.classList.add(tone);
}

function setQuickLaunchStatus(message, tone) {
  const status = $("#quickLaunchStatus");
  status.textContent = message;
  status.classList.remove("success", "error");
  if (tone) status.classList.add(tone);
}

function syncConnectButton() {
  const connectBtn = $("#connectBtn");
  connectBtn.classList.remove("connected", "disconnected", "connecting");

  if (isConnecting) {
    connectBtn.classList.add("connecting");
    connectBtn.textContent = "Connecting...";
    connectBtn.disabled = true;
    return;
  }

  connectBtn.disabled = !getDraftHost();

  if (canControlCurrentTarget()) {
    connectBtn.classList.add("connected");
    connectBtn.textContent = "Connected";
    return;
  }

  connectBtn.classList.add("disconnected");
  connectBtn.textContent = "Connect";
}

function updateControllerAvailability() {
  const ready = canControlCurrentTarget();
  const canEditQuickLaunch = isConnected && Boolean(connectedHost);

  document.querySelectorAll("button[data-key]").forEach((button) => {
    button.disabled = !ready;
  });

  const textInput = $("#textInput");
  const sendTextBtn = $("#sendTextBtn");
  const clearTextBtn = $("#clearTextBtn");
  const backspaceTextBtn = $("#backspaceTextBtn");
  const editQuickLaunchBtn = $("#editQuickLaunchBtn");
  const charCount = textInput.value.length;

  $("#textCharCount").textContent = `${charCount} character${charCount === 1 ? "" : "s"}`;
  sendTextBtn.disabled = isSendingText || !ready || charCount === 0;
  backspaceTextBtn.disabled = isSendingText || !ready;
  clearTextBtn.disabled = isSendingText || charCount === 0;
  editQuickLaunchBtn.disabled = !canEditQuickLaunch;
  sendTextBtn.textContent = isSendingText ? "Sending..." : "Send Text";

  syncConnectButton();
  renderQuickLaunchGrid();
  renderAllAppsGrid();
}

function syncTextHint() {
  if (isSendingText) return;

  const draftHost = getDraftHost();
  if (!draftHost) {
    setTextStatus("Enter a Fire TV address and connect before sending text.", null);
    return;
  }

  if (!isConnected) {
    setTextStatus("Connect before sending text.", null);
    return;
  }

  if (!currentTargetMatchesConnection()) {
    setTextStatus("Press Connect to switch this panel to the current address.", null);
    return;
  }

  setTextStatus("Ready to send", null);
}

function resetDeviceForm() {
  editingDeviceId = null;
  $("#deviceFormTitle").textContent = "Add Device";
  $("#saveDeviceBtn").textContent = "Save Device";
  $("#cancelEditBtn").hidden = true;
  $("#deviceNameInput").value = "";
  $("#deviceHostInput").value = "";
}

function beginEditingDevice(device) {
  editingDeviceId = device.id;
  $("#deviceFormTitle").textContent = "Edit Device";
  $("#saveDeviceBtn").textContent = "Update Device";
  $("#cancelEditBtn").hidden = false;
  $("#deviceNameInput").value = device.name;
  $("#deviceHostInput").value = device.host;
}

function loadHostIntoDraft(host) {
  $("#hostInput").value = host;
  syncConnectButton();
  syncTextHint();
  renderSavedDevices();
}

function renderSavedDevices() {
  const list = $("#savedDevicesList");
  const draftHost = getNormalizedDraftHost();

  $("#savedDevicesCount").textContent = `${savedDevices.length} saved`;
  list.innerHTML = "";

  if (savedDevices.length === 0) {
    list.appendChild(createEmptyState("No saved devices yet. Add one with a name and address above."));
    return;
  }

  savedDevices.forEach((device) => {
    const card = document.createElement("article");
    card.className = "saved-device-card";
    if (device.host === draftHost) card.classList.add("is-current");
    if (device.host === connectedHost) card.classList.add("is-connected");

    const meta = document.createElement("div");
    meta.className = "saved-device-meta";

    const titleRow = document.createElement("div");
    titleRow.className = "saved-device-title-row";

    const title = document.createElement("strong");
    title.textContent = device.name;
    titleRow.appendChild(title);

    if (device.host === connectedHost) {
      const badge = document.createElement("span");
      badge.className = "device-badge";
      badge.textContent = "Connected";
      titleRow.appendChild(badge);
    } else if (device.host === draftHost) {
      const badge = document.createElement("span");
      badge.className = "device-badge ghost";
      badge.textContent = "Loaded";
      titleRow.appendChild(badge);
    }

    const subtitle = document.createElement("span");
    subtitle.textContent = device.host;

    meta.appendChild(titleRow);
    meta.appendChild(subtitle);

    const actions = document.createElement("div");
    actions.className = "saved-device-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "btn secondary small-action";
    useBtn.textContent = "Use";
    useBtn.addEventListener("click", () => {
      loadHostIntoDraft(device.host);
      setConnectionStatus(`Loaded ${device.name}. Press Connect when you're ready.`, null);
      closeDeviceModal();
    });

    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.className = "btn small-action";
    connectBtn.textContent = "Connect";
    connectBtn.addEventListener("click", async () => {
      loadHostIntoDraft(device.host);
      closeDeviceModal();
      await connect();
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn secondary small-action";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => beginEditingDevice(device));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn secondary small-action danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete ${device.name}?`);
      if (!confirmed) return;

      const response = await fetch(`/api/devices/${device.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setConnectionStatus(data.error || "Failed to delete device.", "error");
        return;
      }

      if (editingDeviceId === device.id) resetDeviceForm();
      await loadSavedDevices();
      setConnectionStatus(`${device.name} removed from saved devices.`, null);
    });

    actions.appendChild(useBtn);
    actions.appendChild(connectBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(meta);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

function getRenderedQuickLaunchApps() {
  const installedSet = new Set(allApps);
  return quickLaunchApps.filter((pkg) => installedSet.has(pkg));
}

function setQuickLaunchEditMode(nextState) {
  isQuickLaunchEditMode = nextState;
  if (!nextState) {
    appSearchQuery = "";
    $("#appSearchInput").value = "";
  }
  $("#quickLaunchEditPanel").hidden = !nextState;
  $("#editQuickLaunchBtn").textContent = nextState ? "Close Editor" : "Edit Quick Launch";
  renderAllAppsGrid();
  if (nextState) {
    window.requestAnimationFrame(() => {
      $("#appSearchInput").focus();
    });
  }
}

function createAppTile(pkg, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "app-btn";
  if (options.selected) button.classList.add("selected");
  if (options.editing) button.classList.add("editing");
  if (options.disabled) button.disabled = true;
  if (options.title) button.title = options.title;

  const content = document.createElement("div");
  content.className = "app-btn-content";

  const title = document.createElement("div");
  title.className = "app-btn-title";
  title.textContent = getFriendlyAppName(pkg);

  const packageLabel = document.createElement("div");
  packageLabel.className = "app-btn-package";
  packageLabel.textContent = pkg;

  content.appendChild(title);
  content.appendChild(packageLabel);

  if (options.badge) {
    const badge = document.createElement("span");
    badge.className = "app-btn-badge";
    badge.textContent = options.badge;
    content.appendChild(badge);
  }

  button.appendChild(content);
  return button;
}

function renderQuickLaunchGrid() {
  const grid = $("#quickLaunchGrid");
  const editBtn = $("#editQuickLaunchBtn");
  const ready = canControlCurrentTarget();
  const visibleApps = getRenderedQuickLaunchApps();

  grid.innerHTML = "";
  editBtn.disabled = !(isConnected && Boolean(connectedHost));

  if (!connectedHost || !isConnected) {
    quickLaunchError = "";
    setQuickLaunchStatus("Connect to your Fire TV to discover installed apps.", null);
  } else if (quickLaunchError) {
    setQuickLaunchStatus(quickLaunchError, "error");
  } else if (isLoadingApps) {
    setQuickLaunchStatus("Loading installed apps...", null);
  } else if (allApps.length === 0) {
    setQuickLaunchStatus("No user-installed apps were found on this Fire TV.", null);
  } else if (visibleApps.length === 0) {
    setQuickLaunchStatus("No quick-launch apps selected yet. Open edit mode to choose some.", null);
  } else {
    setQuickLaunchStatus(
      `${visibleApps.length} pinned · ${allApps.length} installed app${allApps.length === 1 ? "" : "s"} found`,
      "success",
    );
  }

  if (visibleApps.length === 0) {
    grid.appendChild(
      createEmptyState(
        isLoadingApps
          ? "Scanning installed apps on this Fire TV..."
          : allApps.length === 0
          ? "No installed apps are loaded yet for this Fire TV."
          : "Pick apps in Edit Quick Launch to build your launcher grid.",
      ),
    );
    return;
  }

  visibleApps.forEach((pkg) => {
    const tile = createAppTile(pkg, {
      disabled: !ready,
      title: ready ? `Launch ${getFriendlyAppName(pkg)}` : "Connect before launching apps",
    });
    tile.addEventListener("click", () => {
      launchApp(pkg);
    });
    grid.appendChild(tile);
  });
}

function renderAllAppsGrid() {
  const grid = $("#allAppsGrid");
  const filteredApps = sortPackages(allApps).filter((pkg) => {
    if (!appSearchQuery) return true;
    const haystack = `${getFriendlyAppName(pkg)} ${pkg}`.toLowerCase();
    return haystack.includes(appSearchQuery.toLowerCase());
  });

  grid.innerHTML = "";
  if (!isQuickLaunchEditMode) return;

  if (!isConnected || !connectedHost) {
    grid.appendChild(createEmptyState("Connect to a Fire TV first to discover installed apps."));
    return;
  }

  if (isLoadingApps) {
    grid.appendChild(createEmptyState("Scanning installed apps..."));
    return;
  }

  if (allApps.length === 0) {
    grid.appendChild(createEmptyState("No installed apps were found for this Fire TV yet."));
    return;
  }

  if (filteredApps.length === 0) {
    grid.appendChild(createEmptyState("No installed apps matched your search."));
    return;
  }

  filteredApps.forEach((pkg) => {
    const selected = quickLaunchApps.includes(pkg);
    const tile = createAppTile(pkg, {
      editing: true,
      selected,
      badge: selected ? "Selected" : "Tap to add",
      title: selected ? "Remove from Quick Launch" : "Add to Quick Launch",
    });
    tile.addEventListener("click", () => toggleQuickLaunch(pkg));
    grid.appendChild(tile);
  });
}

function toggleQuickLaunch(pkg) {
  if (quickLaunchApps.includes(pkg)) {
    quickLaunchApps = quickLaunchApps.filter((item) => item !== pkg);
    persistQuickLaunchSelection();
    renderQuickLaunchGrid();
    renderAllAppsGrid();
    setQuickLaunchStatus(`${getFriendlyAppName(pkg)} removed from Quick Launch.`, null);
    return;
  }

  if (quickLaunchApps.length >= MAX_QUICK_LAUNCH_APPS) {
    setQuickLaunchStatus(`Quick Launch is limited to ${MAX_QUICK_LAUNCH_APPS} apps.`, "error");
    return;
  }

  quickLaunchApps = [...quickLaunchApps, pkg];
  persistQuickLaunchSelection();
  renderQuickLaunchGrid();
  renderAllAppsGrid();
  setQuickLaunchStatus(`${getFriendlyAppName(pkg)} added to Quick Launch.`, "success");
}

async function loadSavedDevices() {
  const response = await fetch("/api/devices");
  const data = await response.json();
  savedDevices = Array.isArray(data.devices) ? data.devices : [];
  renderSavedDevices();
}

function seedQuickLaunchSelectionIfNeeded() {
  if (!quickLaunchSelectionMissing || allApps.length === 0) return;

  const preferredDefaults = [
    "com.amazon.firebat",
    "com.netflix.ninja",
    "com.amazon.firetv.youtube.tv",
    "com.hulu.plus",
  ];

  const installedSet = new Set(allApps);
  const seeded = preferredDefaults.filter((pkg) => installedSet.has(pkg)).slice(0, 4);

  quickLaunchApps = seeded;
  persistQuickLaunchSelection();
  quickLaunchSelectionMissing = false;
}

async function loadInstalledApps(host = connectedHost) {
  if (!host) {
    isLoadingApps = false;
    quickLaunchError = "";
    allApps = [];
    renderQuickLaunchGrid();
    renderAllAppsGrid();
    return;
  }

  isLoadingApps = true;
  quickLaunchError = "";
  renderQuickLaunchGrid();
  renderAllAppsGrid();

  try {
    const response = await fetch(`/api/apps?host=${encodeURIComponent(host)}`);
    const raw = await response.text();
    const isJson = (response.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? JSON.parse(raw) : null;

    if (!response.ok) {
      if (response.status === 404 || /Cannot GET \/api\/apps/i.test(raw)) {
        throw new Error("Installed-app discovery is unavailable. Restart the Fire TV remote server and reconnect.");
      }

      throw new Error((data && data.error) || raw || "Failed to load installed apps.");
    }

    if (!isJson || !data) {
      throw new Error("Installed-app discovery returned an unexpected response. Restart the Fire TV remote server.");
    }

    allApps = Array.isArray(data.packages) ? data.packages : [];
    quickLaunchError = "";
    seedQuickLaunchSelectionIfNeeded();
    renderQuickLaunchGrid();
    renderAllAppsGrid();
  } catch (e) {
    allApps = [];
    quickLaunchError = e.message || "Failed to discover installed apps.";
  } finally {
    isLoadingApps = false;
    renderQuickLaunchGrid();
    renderAllAppsGrid();
  }
}

async function disconnectHost(host) {
  try {
    await fetch("/api/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(host ? { host } : {}),
    });
  } catch (e) {
    console.error("Disconnect failed:", e);
  }
}

async function connect() {
  const draftHost = getDraftHost();
  const normalizedHost = getNormalizedDraftHost();

  if (!draftHost) {
    setConnectionStatus("Enter a Fire TV IP address or IP:PORT first.", "error");
    syncConnectButton();
    return;
  }

  isConnecting = true;
  syncConnectButton();
  setConnectionStatus(`Connecting to ${normalizedHost}...`, "connecting");

  try {
    if (connectedHost && connectedHost !== normalizedHost) {
      await disconnectHost(connectedHost);
      connectedHost = "";
      isConnected = false;
    }

    const response = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: draftHost }),
    });
    const data = await response.json();
    const output = `${data.stdout || ""} ${data.stderr || ""}`;
    const success = response.ok && data.code === 0 && /connected to|already connected/i.test(output);

    if (!success) {
      throw new Error(data.stderr || data.stdout || data.error || "Connection failed.");
    }

    connectedHost = data.host || normalizedHost;
    isConnected = true;
    $("#hostInput").value = connectedHost;
    setConnectionStatus(`Connected to ${connectedHost}`, "success");
    flashIndicator();
    await loadInstalledApps(connectedHost);
  } catch (e) {
    connectedHost = "";
    isConnected = false;
    isLoadingApps = false;
    quickLaunchError = "";
    allApps = [];
    setConnectionStatus(e.message || "Connection failed.", "error");
    renderQuickLaunchGrid();
    renderAllAppsGrid();
    console.error("Connection failed:", e);
  } finally {
    isConnecting = false;
    updateControllerAvailability();
    syncTextHint();
    renderSavedDevices();
  }
}

function requireActiveHost(message) {
  if (!getDraftHost()) {
    setConnectionStatus("Enter a Fire TV address first.", "error");
    return null;
  }

  if (!isConnected || !connectedHost) {
    setConnectionStatus("Connect to the Fire TV before using the remote.", "error");
    return null;
  }

  if (!currentTargetMatchesConnection()) {
    setConnectionStatus("Press Connect to switch the remote to this address first.", "error");
    return null;
  }

  if (message) setConnectionStatus(message, "success");
  return connectedHost;
}

async function sendKey(code) {
  const host = requireActiveHost();
  if (!host) return;

  try {
    const response = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, host }),
    });
    if (!response.ok) {
      throw new Error("Remote command failed.");
    }
    flashIndicator();
  } catch (e) {
    setConnectionStatus("Failed to send remote command.", "error");
  }
}

async function launchApp(pkg) {
  const host = requireActiveHost();
  if (!host) return;

  try {
    const response = await fetch("/api/app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        package: pkg,
        host,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const success = response.ok && data.code === 0;

    if (!success) {
      throw new Error(data.error || "App launch failed.");
    }
    flashIndicator();
    setQuickLaunchStatus(`Launching ${getFriendlyAppName(pkg)}...`, "success");
  } catch (e) {
    setQuickLaunchStatus(e.message || "Failed to launch app.", "error");
  }
}

async function sendText(text) {
  const host = requireActiveHost();
  if (!host) return null;

  const response = await fetch("/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, host }),
  });

  return await response.json();
}

async function handleTextBackspace() {
  if (!requireActiveHost()) {
    syncTextHint();
    return;
  }

  await sendKey(89);
  setTextStatus("Backspace sent using Fire TV rewind.", "success");
}

async function handleSendText() {
  const textInput = $("#textInput");
  const rawText = textInput.value;

  if (!rawText.trim()) {
    setTextStatus("Enter some text before sending.", "error");
    updateControllerAvailability();
    return;
  }

  if (!requireActiveHost()) {
    syncTextHint();
    return;
  }

  isSendingText = true;
  setTextStatus("Sending text to Fire TV...", "sending");
  updateControllerAvailability();

  try {
    const data = await sendText(rawText);
    const success = data && data.code === 0;

    if (!success) {
      throw new Error((data && (data.stderr || data.stdout || data.error)) || "Text send failed.");
    }

    setTextStatus("Text sent to Fire TV.", "success");
    flashIndicator();
  } catch (e) {
    setTextStatus(e.message || "Text send failed.", "error");
    console.error("Text send failed:", e);
  } finally {
    isSendingText = false;
    updateControllerAvailability();
  }
}

async function handleDeviceSave(event) {
  event.preventDefault();

  const name = $("#deviceNameInput").value.trim();
  const host = $("#deviceHostInput").value.trim();
  const wasEditing = Boolean(editingDeviceId);

  if (!name || !host) {
    setConnectionStatus("Add both a device name and an IP address.", "error");
    return;
  }

  const method = editingDeviceId ? "PUT" : "POST";
  const endpoint = editingDeviceId ? `/api/devices/${editingDeviceId}` : "/api/devices";

  try {
    const response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, host }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to save device.");
    }

    await loadSavedDevices();
    loadHostIntoDraft(data.device.host);
    resetDeviceForm();
    setConnectionStatus(
      wasEditing ? `${data.device.name} updated.` : `${data.device.name} saved.`,
      "success",
    );
  } catch (e) {
    setConnectionStatus(e.message || "Failed to save device.", "error");
  }
}

function wireUI() {
  $("#connectBtn").addEventListener("click", connect);
  $("#openDeviceManagerBtn").addEventListener("click", openDeviceModal);
  $("#closeDeviceModalBtn").addEventListener("click", closeDeviceModal);
  $("#deviceModal").addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.closeModal === "true") {
      closeDeviceModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isDeviceModalOpen) {
      closeDeviceModal();
      return;
    }

    if (event.key === "Escape" && isQuickLaunchEditMode) {
      setQuickLaunchEditMode(false);
    }
  });

  $("#hostInput").addEventListener("input", () => {
    updateControllerAvailability();
    syncTextHint();
    renderSavedDevices();
  });
  $("#hostInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connect();
    }
  });

  $("#deviceForm").addEventListener("submit", handleDeviceSave);
  $("#cancelEditBtn").addEventListener("click", resetDeviceForm);

  $("#sendTextBtn").addEventListener("click", handleSendText);
  $("#backspaceTextBtn").addEventListener("click", handleTextBackspace);
  $("#clearTextBtn").addEventListener("click", () => {
    $("#textInput").value = "";
    syncTextHint();
    updateControllerAvailability();
    $("#textInput").focus();
  });
  $("#textInput").addEventListener("input", () => {
    syncTextHint();
    updateControllerAvailability();
  });

  $("#editQuickLaunchBtn").addEventListener("click", async () => {
    if (!isConnected || !connectedHost) {
      setQuickLaunchStatus("Connect to a Fire TV first to edit Quick Launch.", "error");
      return;
    }

    if (allApps.length === 0) {
      await loadInstalledApps(connectedHost);
    }

    setQuickLaunchEditMode(!isQuickLaunchEditMode);
  });

  $("#closeQuickLaunchEditorBtn").addEventListener("click", () => {
    setQuickLaunchEditMode(false);
  });

  $("#appSearchInput").addEventListener("input", (event) => {
    appSearchQuery = event.target.value.trim();
    renderAllAppsGrid();
  });

  document.querySelectorAll("button[data-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sendKey(Number(btn.dataset.key));
    });
  });
}

async function init() {
  const storedQuickLaunch = readQuickLaunchSelection();
  quickLaunchSelectionMissing = storedQuickLaunch === null;
  quickLaunchApps = storedQuickLaunch || [];

  wireUI();
  resetDeviceForm();
  renderQuickLaunchGrid();
  renderAllAppsGrid();
  updateControllerAvailability();
  syncTextHint();
  await loadSavedDevices();
}

init();
