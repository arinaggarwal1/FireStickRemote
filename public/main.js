const $ = (sel) => document.querySelector(sel);

const QUICK_LAUNCH_STORAGE_KEY = "firetv.quickLaunchApps";
const MAX_QUICK_LAUNCH_APPS = 12;
const PAIRING_FRIENDLY_NAME = "Fire TV Remote Desktop";
const REMOTE_HOLD_INITIAL_DELAY_MS = 325;
const REMOTE_HOLD_REPEAT_INTERVAL_MS = 110;
const REPEATING_REMOTE_ACTIONS = new Set([
  "dpad_up",
  "dpad_down",
  "dpad_left",
  "dpad_right",
  "volume_up",
  "volume_down",
  "rewind",
  "fast_forward",
]);
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

const state = {
  savedDevices: [],
  editingDeviceId: null,
  activeSession: null,
  activeDevice: null,
  isConnecting: false,
  isSendingText: false,
  isLoadingApps: false,
  isInstallingApk: false,
  isRepairingAdb: false,
  isDeviceModalOpen: false,
  isQuickLaunchEditMode: false,
  allApps: [],
  quickLaunchApps: [],
  quickLaunchSelectionMissing: false,
  quickLaunchError: "",
  appSearchQuery: "",
  pairing: {
    visible: false,
    isStarting: false,
    isVerifying: false,
  },
};

const remoteHold = {
  action: null,
  button: null,
  pointerId: null,
  startTimeoutId: null,
  repeatIntervalId: null,
  inFlight: false,
  queued: false,
};

function normalizeHostValue(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function getDraftHost() {
  return $("#hostInput").value.trim();
}

function getNormalizedDraftHost() {
  return normalizeHostValue(getDraftHost());
}

function getCurrentHost() {
  return normalizeHostValue(state.activeSession?.host || "");
}

function currentTargetMatchesSession() {
  const draftHost = getNormalizedDraftHost();
  return Boolean(draftHost) && Boolean(getCurrentHost()) && draftHost === getCurrentHost();
}

function hasActiveCapability(capability) {
  return currentTargetMatchesSession() && Boolean(state.activeSession?.capabilities?.[capability]);
}

function getSelectedSavedDevice() {
  const draftHost = getNormalizedDraftHost();
  if (!draftHost) return null;
  return state.savedDevices.find((device) => normalizeHostValue(device.host) === draftHost) || null;
}

function getDefaultSavedDevice() {
  return state.savedDevices.find((device) => device.isDefault) || null;
}

function getActiveDeviceId() {
  return state.activeDevice?.id || getSelectedSavedDevice()?.id || null;
}

function setConnectionStatus(message, tone) {
  const status = $("#connectionStatus");
  status.textContent = message;
  status.classList.remove("success", "error", "connecting");
  if (tone) status.classList.add(tone);
}

function setCapabilityCopy(selector, message) {
  const el = $(selector);
  if (el) el.textContent = message;
}

function setTextStatus(message, tone) {
  const status = $("#textStatus");
  status.textContent = message;
  status.classList.remove("success", "error", "sending");
  if (tone) status.classList.add(tone);
}

function setQuickLaunchStatus(message, tone) {
  const status = $("#quickLaunchStatus");
  status.textContent = message;
  status.classList.remove("success", "error");
  if (tone) status.classList.add(tone);
}

function setSideloadStatus(message, tone) {
  const status = $("#sideloadStatus");
  status.textContent = message;
  status.classList.remove("success", "error", "installing");
  if (tone) status.classList.add(tone);
}

function setPairingStatus(message, tone) {
  const status = $("#pairingStatus");
  status.textContent = message;
  status.classList.remove("success", "error", "connecting");
  if (tone) status.classList.add(tone);
}

function getSelectedApkFile() {
  return $("#apkFileInput").files?.[0] || null;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function updateApkMeta() {
  const file = getSelectedApkFile();
  $("#apkFileMeta").textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : "No APK selected";
}

function flashIndicator() {
  try {
    const indicator = $("#indicator");
    indicator?.classList.add("active");
    setTimeout(() => indicator?.classList.remove("active"), 200);
  } catch (_) {}
}

function clearRemoteHoldTimers() {
  if (remoteHold.startTimeoutId) {
    clearTimeout(remoteHold.startTimeoutId);
    remoteHold.startTimeoutId = null;
  }

  if (remoteHold.repeatIntervalId) {
    clearInterval(remoteHold.repeatIntervalId);
    remoteHold.repeatIntervalId = null;
  }
}

function releaseRemoteHoldPointerCapture(button, pointerId) {
  try {
    if (
      button &&
      typeof button.releasePointerCapture === "function" &&
      pointerId !== null &&
      pointerId !== undefined &&
      button.hasPointerCapture?.(pointerId)
    ) {
      button.releasePointerCapture(pointerId);
    }
  } catch (_) {}
}

function stopRemoteHold(pointerId = null) {
  if (pointerId !== null && remoteHold.pointerId !== null && pointerId !== remoteHold.pointerId) {
    return;
  }

  const button = remoteHold.button;
  const activePointerId = remoteHold.pointerId;

  clearRemoteHoldTimers();
  remoteHold.action = null;
  remoteHold.button = null;
  remoteHold.pointerId = null;
  remoteHold.inFlight = false;
  remoteHold.queued = false;

  if (button) {
    button.classList.remove("is-pressed");
    releaseRemoteHoldPointerCapture(button, activePointerId);
  }
}

async function sendHeldRemoteAction(action) {
  if (!remoteHold.action || remoteHold.action !== action) {
    return;
  }

  if (remoteHold.inFlight) {
    remoteHold.queued = true;
    return;
  }

  remoteHold.inFlight = true;
  await sendRemoteAction(action, { quiet: true });
  remoteHold.inFlight = false;

  if (remoteHold.action === action && remoteHold.queued) {
    remoteHold.queued = false;
    queueMicrotask(() => {
      sendHeldRemoteAction(action);
    });
  }
}

function beginRemoteHold(action, button, pointerId) {
  stopRemoteHold();

  remoteHold.action = action;
  remoteHold.button = button;
  remoteHold.pointerId = pointerId;
  remoteHold.inFlight = false;
  remoteHold.queued = false;

  button.classList.add("is-pressed");
  button.dataset.pointerHandled = "true";

  try {
    if (typeof button.setPointerCapture === "function" && pointerId !== null && pointerId !== undefined) {
      button.setPointerCapture(pointerId);
    }
  } catch (_) {}

  void sendHeldRemoteAction(action);

  if (!REPEATING_REMOTE_ACTIONS.has(action)) {
    return;
  }

  remoteHold.startTimeoutId = setTimeout(() => {
    if (remoteHold.action !== action) {
      return;
    }

    remoteHold.repeatIntervalId = setInterval(() => {
      if (!hasActiveCapability("remoteControl") || !currentTargetMatchesSession()) {
        stopRemoteHold();
        return;
      }
      void sendHeldRemoteAction(action);
    }, REMOTE_HOLD_REPEAT_INTERVAL_MS);
  }, REMOTE_HOLD_INITIAL_DELAY_MS);
}

function openDeviceModal() {
  $("#deviceModal").hidden = false;
  state.isDeviceModalOpen = true;
  $("#openDeviceManagerBtn").setAttribute("aria-expanded", "true");
}

function closeDeviceModal() {
  $("#deviceModal").hidden = true;
  state.isDeviceModalOpen = false;
  $("#openDeviceManagerBtn").setAttribute("aria-expanded", "false");
}

function openPairingPanel(message, helpText) {
  state.pairing.visible = true;
  if (message) setPairingStatus(message, "connecting");
  if (helpText) $("#pairingHelpText").textContent = helpText;
}

function closePairingPanel() {
  state.pairing.visible = false;
  state.pairing.isStarting = false;
  state.pairing.isVerifying = false;
  $("#pairingPinInput").value = "";
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
  localStorage.setItem(QUICK_LAUNCH_STORAGE_KEY, JSON.stringify(state.quickLaunchApps));
}

function getFriendlyAppName(appId) {
  const matched = state.allApps.find((app) => app.id === appId);
  if (matched?.name && matched.name !== appId) return matched.name;
  if (KNOWN_APP_NAMES[appId]) return KNOWN_APP_NAMES[appId];

  const raw = String(appId || "").split(".").pop() || String(appId || "");
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b(tv|app|android|launcher|firetv)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || appId;
}

function sortApps(apps) {
  return [...apps].sort((a, b) => getFriendlyAppName(a.id).localeCompare(getFriendlyAppName(b.id)));
}

function createEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "saved-devices-empty";
  empty.textContent = message;
  return empty;
}

function createAppTile(app, options = {}) {
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
  title.textContent = getFriendlyAppName(app.id);

  const packageLabel = document.createElement("div");
  packageLabel.className = "app-btn-package";
  packageLabel.textContent = app.id;

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

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }

  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || text || "Request failed.");
    error.data = data;
    throw error;
  }

  return data || { ok: true };
}

function applySession(device, session, { adoptHost = false } = {}) {
  if (device) state.activeDevice = device;
  if (session) state.activeSession = session;
  if (adoptHost && device?.host) {
    $("#hostInput").value = device.host;
  }
}

function resetDeviceForm() {
  state.editingDeviceId = null;
  $("#deviceFormTitle").textContent = "Add Device";
  $("#saveDeviceBtn").textContent = "Save Device";
  $("#cancelEditBtn").hidden = true;
  $("#deviceNameInput").value = "";
  $("#deviceHostInput").value = "";
}

function beginEditingDevice(device) {
  state.editingDeviceId = device.id;
  $("#deviceFormTitle").textContent = "Edit Device";
  $("#saveDeviceBtn").textContent = "Update Device";
  $("#cancelEditBtn").hidden = false;
  $("#deviceNameInput").value = device.name;
  $("#deviceHostInput").value = device.host;
}

function loadHostIntoDraft(host) {
  $("#hostInput").value = host;
  refreshUi();
}

function renderSavedDevices() {
  const list = $("#savedDevicesList");
  const draftHost = getNormalizedDraftHost();
  const activeHost = getCurrentHost();

  $("#savedDevicesCount").textContent = `${state.savedDevices.length} saved`;
  list.innerHTML = "";

  if (state.savedDevices.length === 0) {
    list.appendChild(createEmptyState("No saved devices yet. Add one with a name and address above."));
    return;
  }

  state.savedDevices.forEach((device) => {
    const card = document.createElement("article");
    card.className = "saved-device-card";
    if (normalizeHostValue(device.host) === draftHost) card.classList.add("is-current");
    if (normalizeHostValue(device.host) === activeHost) card.classList.add("is-connected");

    const meta = document.createElement("div");
    meta.className = "saved-device-meta";

    const titleRow = document.createElement("div");
    titleRow.className = "saved-device-title-row";

    const title = document.createElement("strong");
    title.textContent = device.name;
    titleRow.appendChild(title);

    if (device.isDefault) {
      const defaultBadge = document.createElement("span");
      defaultBadge.className = "device-badge ghost";
      defaultBadge.textContent = "Default";
      titleRow.appendChild(defaultBadge);
    }

    if (normalizeHostValue(device.host) === activeHost) {
      const badge = document.createElement("span");
      badge.className = "device-badge";
      badge.textContent = state.activeSession?.statusLabel || "Connected";
      titleRow.appendChild(badge);
    } else if (normalizeHostValue(device.host) === draftHost) {
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

    const defaultBtn = document.createElement("button");
    defaultBtn.type = "button";
    defaultBtn.className = "btn secondary small-action";
    defaultBtn.textContent = device.isDefault ? "Clear Default" : "Set Default";
    defaultBtn.addEventListener("click", async () => {
      try {
        await apiRequest(`/api/devices/${device.id}/default`, {
          method: device.isDefault ? "DELETE" : "POST",
        });
        await loadSavedDevices();
        setConnectionStatus(
          device.isDefault
            ? `${device.name} will no longer auto-connect on launch.`
            : `${device.name} will auto-connect on launch.`,
          "success",
        );
      } catch (error) {
        setConnectionStatus(error.message || "Failed to update the default device.", "error");
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn secondary small-action danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete ${device.name}?`);
      if (!confirmed) return;

      try {
        await apiRequest(`/api/devices/${device.id}`, { method: "DELETE" });
        if (state.editingDeviceId === device.id) resetDeviceForm();
        await loadSavedDevices();
        setConnectionStatus(`${device.name} removed from saved devices.`, null);
      } catch (error) {
        setConnectionStatus(error.message || "Failed to delete device.", "error");
      }
    });

    actions.appendChild(useBtn);
    actions.appendChild(connectBtn);
    actions.appendChild(defaultBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(meta);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

function getRenderedQuickLaunchApps() {
  const installedSet = new Set(state.allApps.map((app) => app.id));
  return state.quickLaunchApps
    .filter((appId) => installedSet.has(appId))
    .map((appId) => state.allApps.find((app) => app.id === appId))
    .filter(Boolean);
}

function setQuickLaunchEditMode(nextState) {
  state.isQuickLaunchEditMode = nextState;
  if (!nextState) {
    state.appSearchQuery = "";
    $("#appSearchInput").value = "";
  }
  $("#quickLaunchEditPanel").hidden = !nextState;
  $("#editQuickLaunchBtn").textContent = nextState ? "Close Editor" : "Edit Quick Launch";
  renderAllAppsGrid();
  if (nextState) {
    window.requestAnimationFrame(() => $("#appSearchInput").focus());
  }
}

function renderQuickLaunchGrid() {
  const grid = $("#quickLaunchGrid");
  const visibleApps = getRenderedQuickLaunchApps();

  grid.innerHTML = "";

  if (!state.activeSession || !getCurrentHost()) {
    state.quickLaunchError = "";
    setQuickLaunchStatus("Connect to your Fire TV to discover installed apps.", null);
  } else if (state.quickLaunchError) {
    setQuickLaunchStatus(state.quickLaunchError, "error");
  } else if (state.isLoadingApps) {
    setQuickLaunchStatus("Loading installed apps...", null);
  } else if (state.allApps.length === 0) {
    setQuickLaunchStatus("No launchable apps were found on this Fire TV.", null);
  } else if (visibleApps.length === 0) {
    setQuickLaunchStatus("No quick-launch apps selected yet. Open edit mode to choose some.", null);
  } else {
    setQuickLaunchStatus(
      `${visibleApps.length} pinned · ${state.allApps.length} app${state.allApps.length === 1 ? "" : "s"} available`,
      "success",
    );
  }

  if (visibleApps.length === 0) {
    grid.appendChild(createEmptyState(
      state.isLoadingApps
        ? "Scanning installed apps on this Fire TV..."
        : state.allApps.length === 0
        ? "No installed apps are loaded yet for this Fire TV."
        : "Pick apps in Edit Quick Launch to build your launcher grid.",
    ));
    return;
  }

  visibleApps.forEach((app) => {
    const tile = createAppTile(app, {
      disabled: !hasActiveCapability("appLaunch"),
      title: hasActiveCapability("appLaunch")
        ? `Launch ${getFriendlyAppName(app.id)}`
        : "Connect to this Fire TV before launching apps",
    });
    tile.addEventListener("click", () => launchApp(app.id));
    grid.appendChild(tile);
  });
}

function renderAllAppsGrid() {
  const grid = $("#allAppsGrid");
  grid.innerHTML = "";
  if (!state.isQuickLaunchEditMode) return;

  if (!state.activeSession || !getCurrentHost()) {
    grid.appendChild(createEmptyState("Connect to a Fire TV first to discover installed apps."));
    return;
  }

  if (state.isLoadingApps) {
    grid.appendChild(createEmptyState("Scanning installed apps..."));
    return;
  }

  if (state.allApps.length === 0) {
    grid.appendChild(createEmptyState("No installed apps were found for this Fire TV yet."));
    return;
  }

  const filteredApps = sortApps(state.allApps).filter((app) => {
    if (!state.appSearchQuery) return true;
    const haystack = `${getFriendlyAppName(app.id)} ${app.id}`.toLowerCase();
    return haystack.includes(state.appSearchQuery.toLowerCase());
  });

  if (filteredApps.length === 0) {
    grid.appendChild(createEmptyState("No installed apps matched your search."));
    return;
  }

  filteredApps.forEach((app) => {
    const selected = state.quickLaunchApps.includes(app.id);
    const tile = createAppTile(app, {
      editing: true,
      selected,
      badge: selected ? "Selected" : "Tap to add",
      title: selected ? "Remove from Quick Launch" : "Add to Quick Launch",
    });
    tile.addEventListener("click", () => toggleQuickLaunch(app.id));
    grid.appendChild(tile);
  });
}

function toggleQuickLaunch(appId) {
  if (state.quickLaunchApps.includes(appId)) {
    state.quickLaunchApps = state.quickLaunchApps.filter((item) => item !== appId);
    persistQuickLaunchSelection();
    renderQuickLaunchGrid();
    renderAllAppsGrid();
    setQuickLaunchStatus(`${getFriendlyAppName(appId)} removed from Quick Launch.`, null);
    return;
  }

  if (state.quickLaunchApps.length >= MAX_QUICK_LAUNCH_APPS) {
    setQuickLaunchStatus(`Quick Launch is limited to ${MAX_QUICK_LAUNCH_APPS} apps.`, "error");
    return;
  }

  state.quickLaunchApps = [...state.quickLaunchApps, appId];
  persistQuickLaunchSelection();
  renderQuickLaunchGrid();
  renderAllAppsGrid();
  setQuickLaunchStatus(`${getFriendlyAppName(appId)} added to Quick Launch.`, "success");
}

function seedQuickLaunchSelectionIfNeeded() {
  if (!state.quickLaunchSelectionMissing || state.allApps.length === 0) return;

  const preferredDefaults = [
    "com.amazon.firebat",
    "com.netflix.ninja",
    "com.amazon.firetv.youtube.tv",
    "com.hulu.plus",
  ];

  const installedSet = new Set(state.allApps.map((app) => app.id));
  state.quickLaunchApps = preferredDefaults.filter((appId) => installedSet.has(appId)).slice(0, 4);
  persistQuickLaunchSelection();
  state.quickLaunchSelectionMissing = false;
}

async function loadSavedDevices() {
  const data = await apiRequest("/api/devices");
  state.savedDevices = Array.isArray(data.devices) ? data.devices : [];
  renderSavedDevices();
}

async function tryAutoConnectDefaultDevice() {
  const defaultDevice = getDefaultSavedDevice();
  if (!defaultDevice || getDraftHost() || state.activeSession || state.isConnecting) {
    return;
  }

  loadHostIntoDraft(defaultDevice.host);
  await connect();
}

async function loadInstalledApps(host = getCurrentHost()) {
  if (!host || !state.activeSession?.capabilities?.appList) {
    state.isLoadingApps = false;
    state.quickLaunchError = "";
    state.allApps = [];
    renderQuickLaunchGrid();
    renderAllAppsGrid();
    return;
  }

  state.isLoadingApps = true;
  state.quickLaunchError = "";
  renderQuickLaunchGrid();
  renderAllAppsGrid();

  try {
    const deviceId = getActiveDeviceId();
    const query = new URLSearchParams({ host });
    if (deviceId) query.set("deviceId", deviceId);
    const data = await apiRequest(`/api/apps?${query.toString()}`);
    applySession(data.device, data.session);
    state.allApps = Array.isArray(data.apps) ? data.apps : [];
    state.quickLaunchError = "";
    seedQuickLaunchSelectionIfNeeded();
  } catch (error) {
    state.allApps = [];
    state.quickLaunchError = error.message || "Failed to discover installed apps.";
  } finally {
    state.isLoadingApps = false;
    refreshUi();
  }
}

async function disconnectHost(host) {
  try {
    await apiRequest("/api/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(host ? { host } : {}),
    });
  } catch (error) {
    console.error("Disconnect failed:", error);
  }
}

async function connect() {
  const draftHost = getDraftHost();
  const normalizedHost = getNormalizedDraftHost();

  if (!draftHost) {
    setConnectionStatus("Enter a Fire TV IP address or IP:PORT first.", "error");
    refreshUi();
    return;
  }

  state.isConnecting = true;
  refreshUi();
  setConnectionStatus(`Connecting to ${normalizedHost}...`, "connecting");

  try {
    if (getCurrentHost() && getCurrentHost() !== normalizedHost) {
      await disconnectHost(getCurrentHost());
      state.activeSession = null;
      state.activeDevice = null;
    }

    const selectedDevice = getSelectedSavedDevice();
    const data = await apiRequest("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: draftHost,
        deviceId: selectedDevice?.id || null,
        friendlyName: PAIRING_FRIENDLY_NAME,
      }),
    });

    applySession(data.device, data.session, { adoptHost: true });
    flashIndicator();

    if (data.session?.auth?.pairingRequired) {
      openPairingPanel("Pairing required", "Show a PIN on your Fire TV, then enter it here to unlock the HTTPS remote.");
      setConnectionStatus("Pairing required", "connecting");
    } else {
      closePairingPanel();
      setConnectionStatus(data.session?.statusLabel || "Remote ready", "success");
    }

    if (data.session?.capabilities?.appList) {
      await loadInstalledApps(data.device?.host || normalizedHost);
    } else {
      state.allApps = [];
      renderQuickLaunchGrid();
      renderAllAppsGrid();
    }
  } catch (error) {
    state.activeSession = null;
    state.activeDevice = null;
    state.allApps = [];
    state.quickLaunchError = "";
    setConnectionStatus(error.message || "Connection failed.", "error");
    console.error("Connection failed:", error);
  } finally {
    state.isConnecting = false;
    refreshUi();
  }
}

function requireCurrentTarget(capability, errorMessage) {
  if (!getDraftHost()) {
    setConnectionStatus("Enter a Fire TV address first.", "error");
    return null;
  }

  if (!state.activeSession || !getCurrentHost()) {
    setConnectionStatus("Connect to the Fire TV before using the remote.", "error");
    return null;
  }

  if (!currentTargetMatchesSession()) {
    setConnectionStatus("Press Connect to switch controls to this address first.", "error");
    return null;
  }

  if (capability && !state.activeSession?.capabilities?.[capability]) {
    setConnectionStatus(errorMessage || "That feature is unavailable for this Fire TV right now.", "error");
    return null;
  }

  return {
    host: getCurrentHost(),
    deviceId: getActiveDeviceId(),
  };
}

async function sendRemoteAction(action, { quiet = false } = {}) {
  const target = requireCurrentTarget("remoteControl", "Remote control is unavailable until pairing completes or ADB connects.");
  if (!target) return;

  try {
    const data = await apiRequest("/api/remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target, action }),
    });
    applySession(data.device, data.session);
    if (!quiet) {
      setConnectionStatus(data.session?.statusLabel || "Remote ready", "success");
    }
    flashIndicator();
    if (!quiet) {
      refreshUi();
    }
  } catch (error) {
    setConnectionStatus(error.message || "Failed to send remote command.", "error");
    refreshUi();
  }
}

async function launchApp(appId) {
  const target = requireCurrentTarget("appLaunch", "App launching is unavailable until ADB connects.");
  if (!target) return;

  try {
    const data = await apiRequest("/api/app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...target,
        appId,
      }),
    });
    applySession(data.device, data.session);
    flashIndicator();
    setQuickLaunchStatus(`Launching ${getFriendlyAppName(appId)}...`, "success");
    refreshUi();
  } catch (error) {
    setQuickLaunchStatus(error.message || "Failed to launch app.", "error");
  }
}

async function sendText(text) {
  const target = requireCurrentTarget("textInput", "Text input is unavailable until pairing completes or ADB connects.");
  if (!target) return null;

  const data = await apiRequest("/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...target, text }),
  });
  applySession(data.device, data.session);
  return data;
}

async function handleTextBackspace() {
  if (!requireCurrentTarget("remoteControl")) {
    syncTextHint();
    return;
  }

  await sendRemoteAction("rewind");
  setTextStatus("Backspace sent using the Fire TV rewind/delete shortcut.", "success");
}

async function handleSendText() {
  const rawText = $("#textInput").value;

  if (!rawText.trim()) {
    setTextStatus("Enter some text before sending.", "error");
    refreshUi();
    return;
  }

  if (!requireCurrentTarget("textInput")) {
    syncTextHint();
    return;
  }

  state.isSendingText = true;
  setTextStatus("Sending text to Fire TV...", "sending");
  refreshUi();

  try {
    const data = await sendText(rawText);
    const transportUsed = data?.result?.transportUsed;
    const reason = data?.result?.reason;
    setTextStatus(
      transportUsed === "adb"
        ? reason || "Text sent using ADB fallback."
        : "Text sent to Fire TV.",
      "success",
    );
    flashIndicator();
  } catch (error) {
    setTextStatus(error.message || "Text send failed.", "error");
    console.error("Text send failed:", error);
  } finally {
    state.isSendingText = false;
    refreshUi();
  }
}

async function handleInstallApk() {
  const target = requireCurrentTarget("sideload", "ADB is required for APK sideloading.");
  const file = getSelectedApkFile();

  if (!target) {
    syncSideloadHint();
    return;
  }

  if (!file) {
    setSideloadStatus("Choose an APK file before installing.", "error");
    refreshUi();
    return;
  }

  state.isInstallingApk = true;
  setSideloadStatus(`Installing ${file.name}...`, "installing");
  refreshUi();

  try {
    const formData = new FormData();
    formData.append("apk", file);
    formData.append("host", target.host);
    if (target.deviceId) formData.append("deviceId", target.deviceId);
    formData.append("replaceExisting", $("#replaceExistingCheckbox").checked ? "true" : "false");

    const data = await apiRequest("/api/sideload", {
      method: "POST",
      body: formData,
    });
    applySession(data.device, data.session);
    setSideloadStatus(`${file.name} installed successfully.`, "success");
    $("#apkFileInput").value = "";
    updateApkMeta();
    flashIndicator();
    await loadInstalledApps(getCurrentHost());
  } catch (error) {
    setSideloadStatus(error.message || "APK install failed.", "error");
    console.error("APK install failed:", error);
  } finally {
    state.isInstallingApk = false;
    refreshUi();
  }
}

async function handleRepairAdb() {
  const host = getCurrentHost() || getNormalizedDraftHost();
  const deviceId = getActiveDeviceId();

  if (!host) {
    setConnectionStatus("Enter a Fire TV address before repairing ADB.", "error");
    refreshUi();
    return;
  }

  state.isRepairingAdb = true;
  setConnectionStatus(`Repairing ADB for ${host}...`, "connecting");
  refreshUi();

  try {
    await apiRequest("/api/adb/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, deviceId }),
    });

    state.activeSession = null;
    state.activeDevice = null;
    state.allApps = [];
    state.quickLaunchError = "";
    closePairingPanel();
    setConnectionStatus("ADB restarted. Press Connect to reconnect to your Fire TV.", "success");
    setQuickLaunchStatus("Reconnect to your Fire TV to reload installed apps.", null);
    setSideloadStatus("ADB restarted. Reconnect before sideloading another APK.", null);
  } catch (error) {
    setConnectionStatus(error.message || "ADB repair failed.", "error");
  } finally {
    state.isRepairingAdb = false;
    refreshUi();
  }
}

async function handlePairingStart() {
  const host = getNormalizedDraftHost() || getCurrentHost();
  if (!host) {
    setPairingStatus("Enter a Fire TV address first.", "error");
    return;
  }

  state.pairing.isStarting = true;
  setPairingStatus("Requesting a PIN from your Fire TV...", "connecting");
  refreshUi();

  try {
    const data = await apiRequest("/api/pair/display", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host,
        deviceId: getActiveDeviceId(),
        friendlyName: PAIRING_FRIENDLY_NAME,
      }),
    });
    applySession(data.device, data.session);
    setPairingStatus("PIN displayed on Fire TV.", "success");
    $("#pairingPinInput").focus();
  } catch (error) {
    setPairingStatus(error.message || "Failed to start pairing.", "error");
  } finally {
    state.pairing.isStarting = false;
    refreshUi();
  }
}

async function handlePairingVerify() {
  const pin = $("#pairingPinInput").value.trim();
  const host = getNormalizedDraftHost() || getCurrentHost();

  if (!pin) {
    setPairingStatus("Enter the PIN from your Fire TV.", "error");
    return;
  }

  state.pairing.isVerifying = true;
  setPairingStatus("Verifying PIN...", "connecting");
  refreshUi();

  try {
    const data = await apiRequest("/api/pair/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host,
        deviceId: getActiveDeviceId(),
        pin,
        friendlyName: PAIRING_FRIENDLY_NAME,
      }),
    });
    applySession(data.device, data.session, { adoptHost: true });
    closePairingPanel();
    setConnectionStatus(data.session?.statusLabel || "Remote ready", "success");
    setPairingStatus("Pairing complete.", "success");
    flashIndicator();
    if (data.session?.capabilities?.appList) {
      await loadInstalledApps(getCurrentHost());
    }
  } catch (error) {
    openPairingPanel("Pairing required");
    setPairingStatus(error.message || "Failed to verify PIN.", "error");
  } finally {
    state.pairing.isVerifying = false;
    refreshUi();
  }
}

async function handleDeviceSave(event) {
  event.preventDefault();

  const name = $("#deviceNameInput").value.trim();
  const host = $("#deviceHostInput").value.trim();
  const wasEditing = Boolean(state.editingDeviceId);

  if (!name || !host) {
    setConnectionStatus("Add both a device name and an IP address.", "error");
    return;
  }

  const method = state.editingDeviceId ? "PUT" : "POST";
  const endpoint = state.editingDeviceId ? `/api/devices/${state.editingDeviceId}` : "/api/devices";

  try {
    const data = await apiRequest(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, host }),
    });
    await loadSavedDevices();
    loadHostIntoDraft(data.device.host);
    resetDeviceForm();
    setConnectionStatus(wasEditing ? `${data.device.name} updated.` : `${data.device.name} saved.`, "success");
  } catch (error) {
    setConnectionStatus(error.message || "Failed to save device.", "error");
  }
}

function syncConnectButton() {
  const connectBtn = $("#connectBtn");
  connectBtn.classList.remove("connected", "disconnected", "connecting");

  if (state.isConnecting) {
    connectBtn.classList.add("connecting");
    connectBtn.textContent = "Connecting...";
    connectBtn.disabled = true;
    return;
  }

  connectBtn.disabled = !getDraftHost();

  if (currentTargetMatchesSession() && state.activeSession?.capabilities?.remoteControl) {
    connectBtn.classList.add("connected");
    connectBtn.textContent = "Connected";
    return;
  }

  connectBtn.classList.add("disconnected");
  connectBtn.textContent = "Connect";
}

function syncPairingPanel() {
  const shouldShow = state.pairing.visible || (currentTargetMatchesSession() && state.activeSession?.auth?.pairingRequired);
  $("#pairingPanel").hidden = !shouldShow;
  $("#pairingStartBtn").disabled = state.pairing.isStarting || state.pairing.isVerifying || !getDraftHost();
  $("#pairingVerifyBtn").disabled = state.pairing.isStarting || state.pairing.isVerifying || !$("#pairingPinInput").value.trim();
  $("#pairingCancelBtn").disabled = state.pairing.isStarting || state.pairing.isVerifying;
  $("#pairingStartBtn").textContent = state.pairing.isStarting ? "Requesting..." : "Show PIN on TV";
  $("#pairingVerifyBtn").textContent = state.pairing.isVerifying ? "Verifying..." : "Verify PIN";
}

function syncConnectionHint() {
  if (!getDraftHost()) {
    setConnectionStatus("Enter a Fire TV address to begin", null);
    setCapabilityCopy("#connectionHint", "HTTPS remote is preferred automatically. ADB is kept in reserve for sideloading and fallback features.");
    return;
  }

  if (!state.activeSession) {
    setCapabilityCopy("#connectionHint", "Connect to probe HTTPS first, then fall back automatically when a feature needs ADB.");
    return;
  }

  if (!currentTargetMatchesSession()) {
    setCapabilityCopy("#connectionHint", "Press Connect to switch the app to the address currently in the connection field.");
    return;
  }

  if (state.activeSession?.auth?.pairingRequired) {
    setCapabilityCopy("#connectionHint", "Pairing unlocks the HTTPS remote. ADB can still power sideloading and fallback features when available.");
    return;
  }

  if (state.activeSession?.auth?.authenticated) {
    setCapabilityCopy(
      "#connectionHint",
      state.activeSession?.capabilities?.sideload
        ? "Remote ready over HTTPS. ADB is also available when you need sideloading or launch fallback."
        : "Remote ready over HTTPS.",
    );
    return;
  }

  if (state.activeSession?.transportAvailability?.adb?.connected) {
    setCapabilityCopy("#connectionHint", "HTTPS remote is unavailable right now, so the app is using ADB fallback where it can.");
    return;
  }

  setCapabilityCopy("#connectionHint", "This Fire TV is reachable, but remote features are still limited until pairing or ADB connectivity is available.");
}

function syncTextHint() {
  if (state.isSendingText) return;

  if (!getDraftHost()) {
    setTextStatus("Enter a Fire TV address and connect before sending text.", null);
    setCapabilityCopy("#textCapabilityHint", "Text works best when the Fire TV keyboard is open. The app will fall back automatically when it can.");
    return;
  }

  if (!state.activeSession) {
    setTextStatus("Connect before sending text.", null);
    setCapabilityCopy("#textCapabilityHint", "The app prefers HTTPS text entry, then falls back if ADB is available.");
    return;
  }

  if (!currentTargetMatchesSession()) {
    setTextStatus("Press Connect to switch this panel to the current address.", null);
    return;
  }

  if (!state.activeSession?.capabilities?.textInput) {
    setTextStatus("Text input is unavailable for this Fire TV right now.", "error");
    return;
  }

  if (state.activeSession?.preferredTransports?.textInput === "https") {
    setTextStatus("Ready to send", null);
    setCapabilityCopy("#textCapabilityHint", "Open a text field on the Fire TV for the smoothest HTTPS text entry.");
    return;
  }

  setTextStatus("Ready to send", null);
  setCapabilityCopy("#textCapabilityHint", "Text will use the best fallback available for this Fire TV.");
}

function syncSideloadHint() {
  if (state.isInstallingApk) return;

  const file = getSelectedApkFile();

  if (!getDraftHost()) {
    setSideloadStatus("Enter a Fire TV address, connect, and choose an APK to sideload.", null);
    return;
  }

  if (!state.activeSession) {
    setSideloadStatus("Connect before sideloading an APK.", null);
    return;
  }

  if (!currentTargetMatchesSession()) {
    setSideloadStatus("Press Connect to switch sideloading to the current address.", null);
    return;
  }

  if (!state.activeSession?.capabilities?.sideload) {
    setSideloadStatus("ADB is required for sideloading and is not ready for this Fire TV yet.", "error");
    return;
  }

  if (!file) {
    setSideloadStatus("Choose an APK file to install on this Fire TV.", null);
    return;
  }

  setSideloadStatus("Ready to sideload", null);
}

function syncAppHint() {
  if (!state.activeSession) {
    setCapabilityCopy("#appsCapabilityHint", "Installed apps are loaded from the best available transport for the selected Fire TV.");
    return;
  }

  if (!currentTargetMatchesSession()) {
    setCapabilityCopy("#appsCapabilityHint", "Reconnect to the address in the field to refresh app availability for that Fire TV.");
    return;
  }

  const transport = state.activeSession?.preferredTransports?.appList;
  if (transport === "https") {
    setCapabilityCopy("#appsCapabilityHint", "App discovery is coming from the Fire TV HTTPS remote API.");
    return;
  }

  if (transport === "adb") {
    setCapabilityCopy("#appsCapabilityHint", "App discovery is using ADB fallback for this Fire TV.");
    return;
  }

  setCapabilityCopy("#appsCapabilityHint", "Connect to this Fire TV to discover its installed apps.");
}

function updateControllerAvailability() {
  const remoteReady = hasActiveCapability("remoteControl");
  const textReady = hasActiveCapability("textInput");
  const appListReady = hasActiveCapability("appList");
  const sideloadReady = hasActiveCapability("sideload");
  const selectedApkFile = getSelectedApkFile();
  const canRepairAdb = Boolean(getCurrentHost() || getNormalizedDraftHost());
  const charCount = $("#textInput").value.length;

  document.querySelectorAll("button[data-action]").forEach((button) => {
    button.disabled = !remoteReady;
  });

  $("#textCharCount").textContent = `${charCount} character${charCount === 1 ? "" : "s"}`;
  $("#sendTextBtn").disabled = state.isSendingText || !textReady || !currentTargetMatchesSession() || charCount === 0;
  $("#backspaceTextBtn").disabled = state.isSendingText || !remoteReady;
  $("#clearTextBtn").disabled = state.isSendingText || charCount === 0;
  $("#editQuickLaunchBtn").disabled = !(currentTargetMatchesSession() && appListReady);
  $("#sendTextBtn").textContent = state.isSendingText ? "Sending..." : "Send Text";
  $("#installApkBtn").disabled = state.isInstallingApk || !sideloadReady || !currentTargetMatchesSession() || !selectedApkFile;
  $("#clearApkBtn").disabled = state.isInstallingApk || !selectedApkFile;
  $("#repairAdbBtn").disabled = state.isRepairingAdb || !canRepairAdb;
  $("#installApkBtn").textContent = state.isInstallingApk ? "Installing..." : "Install APK";
  $("#repairAdbBtn").textContent = state.isRepairingAdb ? "Repairing..." : "Repair ADB";

  syncConnectButton();
  syncPairingPanel();
}

function refreshUi() {
  updateControllerAvailability();
  syncConnectionHint();
  syncTextHint();
  syncSideloadHint();
  syncAppHint();
  renderSavedDevices();
  renderQuickLaunchGrid();
  renderAllAppsGrid();
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
    if (event.key === "Escape" && state.isDeviceModalOpen) {
      closeDeviceModal();
      return;
    }

    if (event.key === "Escape" && state.isQuickLaunchEditMode) {
      setQuickLaunchEditMode(false);
      return;
    }

    if (event.key === "Escape" && !$("#pairingPanel").hidden) {
      closePairingPanel();
      refreshUi();
    }
  });

  $("#hostInput").addEventListener("input", refreshUi);
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
    refreshUi();
    $("#textInput").focus();
  });
  $("#textInput").addEventListener("input", refreshUi);

  $("#apkFileInput").addEventListener("change", () => {
    updateApkMeta();
    refreshUi();
  });
  $("#clearApkBtn").addEventListener("click", () => {
    $("#apkFileInput").value = "";
    updateApkMeta();
    refreshUi();
  });
  $("#installApkBtn").addEventListener("click", handleInstallApk);
  $("#repairAdbBtn").addEventListener("click", handleRepairAdb);

  $("#pairingStartBtn").addEventListener("click", handlePairingStart);
  $("#pairingVerifyBtn").addEventListener("click", handlePairingVerify);
  $("#pairingCancelBtn").addEventListener("click", () => {
    closePairingPanel();
    refreshUi();
  });
  $("#pairingPinInput").addEventListener("input", refreshUi);
  $("#pairingPinInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handlePairingVerify();
    }
  });

  $("#editQuickLaunchBtn").addEventListener("click", async () => {
    if (!state.activeSession || !getCurrentHost()) {
      setQuickLaunchStatus("Connect to a Fire TV first to edit Quick Launch.", "error");
      return;
    }

    if (state.allApps.length === 0) {
      await loadInstalledApps(getCurrentHost());
    }

    setQuickLaunchEditMode(!state.isQuickLaunchEditMode);
  });

  $("#closeQuickLaunchEditorBtn").addEventListener("click", () => {
    setQuickLaunchEditMode(false);
  });

  $("#appSearchInput").addEventListener("input", (event) => {
    state.appSearchQuery = event.target.value.trim();
    renderAllAppsGrid();
  });

  document.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || button.disabled) {
        return;
      }

      const action = button.dataset.action;
      if (!action) {
        return;
      }

      event.preventDefault();
      beginRemoteHold(action, button, event.pointerId);
    });

    button.addEventListener("pointerup", (event) => {
      stopRemoteHold(event.pointerId);
    });

    button.addEventListener("pointercancel", (event) => {
      stopRemoteHold(event.pointerId);
    });

    button.addEventListener("lostpointercapture", () => {
      stopRemoteHold();
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    button.addEventListener("click", (event) => {
      if (button.dataset.pointerHandled === "true") {
        button.dataset.pointerHandled = "";
        event.preventDefault();
        return;
      }

      void sendRemoteAction(button.dataset.action);
    });
  });

  window.addEventListener("blur", () => {
    stopRemoteHold();
  });
}

async function init() {
  const storedQuickLaunch = readQuickLaunchSelection();
  state.quickLaunchSelectionMissing = storedQuickLaunch === null;
  state.quickLaunchApps = storedQuickLaunch || [];

  wireUI();
  resetDeviceForm();
  updateApkMeta();
  refreshUi();
  await loadSavedDevices();
  await tryAutoConnectDefaultDevice();
}

init().catch((error) => {
  console.error("Failed to initialize app:", error);
  setConnectionStatus(error.message || "Failed to initialize app.", "error");
});
