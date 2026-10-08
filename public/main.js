const $ = (sel) => document.querySelector(sel);

const QUICK_LAUNCH_STORAGE_KEY = "firetv.quickLaunchApps";
const MAX_QUICK_LAUNCH_APPS = 12;
const PAIRING_FRIENDLY_NAME = "Fire TV Remote Desktop";
const DEFAULT_THEME_MODE = "dark";
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
  appCatalogByHost: {},
  quickLaunchApps: [],
  quickLaunchSelectionMissing: false,
  quickLaunchError: "",
  appDisplayNames: {},
  themeMode: DEFAULT_THEME_MODE,
  appSearchQuery: "",
  renameEditorAppId: null,
  renameDraft: "",
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

function mergeAppCatalogs(existingApps = [], nextApps = []) {
  const merged = new Map();

  [...existingApps, ...nextApps].forEach((app) => {
    if (!app?.id) return;
    const existing = merged.get(app.id);
    if (!existing) {
      merged.set(app.id, { ...app });
      return;
    }

    merged.set(app.id, {
      ...existing,
      ...app,
      name: app?.name && app.name !== app.id ? app.name : existing.name,
      sourceTransport:
        existing.sourceTransport && app?.sourceTransport && existing.sourceTransport !== app.sourceTransport
          ? "hybrid"
          : (app?.sourceTransport || existing.sourceTransport),
    });
  });

  return [...merged.values()];
}

function getCachedAppsForHost(host = getCurrentHost()) {
  const normalizedHost = normalizeHostValue(host);
  return normalizedHost ? state.appCatalogByHost[normalizedHost] || [] : [];
}

function cacheAppsForHost(host, apps) {
  const normalizedHost = normalizeHostValue(host);
  if (!normalizedHost) return;
  state.appCatalogByHost[normalizedHost] = mergeAppCatalogs(getCachedAppsForHost(normalizedHost), apps);
}

function getKnownAppById(appId, host = getCurrentHost()) {
  return state.allApps.find((app) => app.id === appId)
    || getCachedAppsForHost(host).find((app) => app.id === appId)
    || null;
}

function normalizeThemeMode(value) {
  return value === "light" ? "light" : DEFAULT_THEME_MODE;
}

function sanitizeAppDisplayNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .map(([appId, displayName]) => [String(appId || "").trim(), String(displayName || "").trim()])
      .filter(([appId, displayName]) => Boolean(appId) && Boolean(displayName)),
  );
}

function applyThemeMode(themeMode) {
  state.themeMode = normalizeThemeMode(themeMode);
  document.body.dataset.theme = state.themeMode;
  document.documentElement.style.colorScheme = state.themeMode;

  const toggleButton = $("#themeToggleBtn");
  if (!toggleButton) return;

  const isLight = state.themeMode === "light";
  toggleButton.setAttribute("aria-pressed", String(isLight));
  toggleButton.setAttribute("aria-label", isLight ? "Switch to dark mode" : "Switch to light mode");
  toggleButton.title = isLight ? "Switch to dark mode" : "Switch to light mode";
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

function syncModalAccessibility() {
  const isOpen = state.isDeviceModalOpen || state.isQuickLaunchEditMode;
  $(".app-header").inert = isOpen;
  $(".app-shell").inert = isOpen;
  document.body.style.overflow = isOpen ? "hidden" : "";
}

function openDeviceModal() {
  $("#deviceModal").hidden = false;
  state.isDeviceModalOpen = true;
  $("#openDeviceManagerBtn").setAttribute("aria-expanded", "true");
  syncModalAccessibility();
  $("#deviceNameInput").focus();
}

function closeDeviceModal() {
  $("#deviceModal").hidden = true;
  state.isDeviceModalOpen = false;
  $("#openDeviceManagerBtn").setAttribute("aria-expanded", "false");
  syncModalAccessibility();
  $("#openDeviceManagerBtn").focus();
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
  try {
    localStorage.setItem(QUICK_LAUNCH_STORAGE_KEY, JSON.stringify(state.quickLaunchApps));
  } catch (_) {}
}

async function persistQuickLaunchSelectionRemote() {
  await apiRequest("/api/preferences/quick-launch", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quickLaunchApps: state.quickLaunchApps }),
  });
}

async function persistThemeModeRemote() {
  await apiRequest("/api/preferences/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ themeMode: state.themeMode }),
  });
}

async function persistAppDisplayNamesRemote() {
  await apiRequest("/api/preferences/app-names", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appDisplayNames: state.appDisplayNames }),
  });
}

async function setThemeMode(themeMode) {
  const nextThemeMode = normalizeThemeMode(themeMode);
  if (nextThemeMode === state.themeMode) return;

  applyThemeMode(nextThemeMode);

  try {
    await persistThemeModeRemote();
  } catch (error) {
    applyThemeMode(DEFAULT_THEME_MODE);
    throw error;
  }
}

async function loadPreferences() {
  try {
    const data = await apiRequest("/api/preferences");
    applyThemeMode(data?.preferences?.themeMode);
    state.appDisplayNames = sanitizeAppDisplayNames(data?.preferences?.appDisplayNames);
    const remoteSelection = Array.isArray(data?.preferences?.quickLaunchApps)
      ? data.preferences.quickLaunchApps
      : null;

    if (remoteSelection && remoteSelection.length > 0) {
      state.quickLaunchSelectionMissing = false;
      state.quickLaunchApps = remoteSelection;
      persistQuickLaunchSelection();
      return;
    }

    const storedQuickLaunch = readQuickLaunchSelection();
    state.quickLaunchSelectionMissing = storedQuickLaunch === null;
    state.quickLaunchApps = storedQuickLaunch || [];

    if (storedQuickLaunch && storedQuickLaunch.length > 0) {
      await persistQuickLaunchSelectionRemote();
    }
  } catch (_) {
    applyThemeMode(DEFAULT_THEME_MODE);
    state.appDisplayNames = {};
    const storedQuickLaunch = readQuickLaunchSelection();
    state.quickLaunchSelectionMissing = storedQuickLaunch === null;
    state.quickLaunchApps = storedQuickLaunch || [];
  }
}

function getBaseFriendlyAppName(appId) {
  const matched = getKnownAppById(appId);
  if (matched?.name && matched.name !== appId) return matched.name;
  if (KNOWN_APP_NAMES[appId]) return KNOWN_APP_NAMES[appId];

  const parts = String(appId || "").split(".");
  const raw = parts.filter(part => !/^(com|org|net|tv|app|android|launcher|firetv)$/i.test(part)).pop() || String(appId || "");
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b(tv|app|android|launcher|firetv)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || appId;
}

function getFriendlyAppName(appId) {
  const customDisplayName = state.appDisplayNames[String(appId || "").trim()];
  if (customDisplayName) return customDisplayName;
  return getBaseFriendlyAppName(appId);
}

function sortApps(apps) {
  return [...apps].sort((a, b) => getFriendlyAppName(a.id).localeCompare(getFriendlyAppName(b.id)));
}

function getAppInitials(app) {
  const words = getFriendlyAppName(app.id)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.map((word) => word[0].toUpperCase()).join("");
}

function getAppAvatarHue(appId) {
  let hash = 0;
  for (const char of String(appId || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

function createAppAvatar(app, className = "app-avatar") {
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.textContent = getAppInitials(app);
  avatar.style.setProperty("--app-avatar-hue", String(getAppAvatarHue(app.id)));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
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
  if (options.listMode) button.classList.add("list-mode");
  if (options.disabled) button.disabled = true;
  if (options.title) button.title = options.title;

  const content = document.createElement("div");
  content.className = "app-btn-content";

  const header = document.createElement("div");
  header.className = "app-btn-header";
  header.appendChild(createAppAvatar(app));

  const title = document.createElement("div");
  title.className = "app-btn-title";
  title.textContent = getFriendlyAppName(app.id);

  const packageLabel = document.createElement("div");
  packageLabel.className = "app-btn-package";
  packageLabel.textContent = app.id;

  const meta = document.createElement("div");
  meta.className = "app-btn-meta";
  meta.appendChild(title);
  meta.appendChild(packageLabel);

  content.appendChild(header);
  content.appendChild(meta);

  if (options.badge) {
    const badge = document.createElement("span");
    badge.className = "app-btn-badge";
    badge.textContent = options.badge;
    header.appendChild(badge);
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
  return state.quickLaunchApps
    .map((appId) => getKnownAppById(appId) || { id: appId, name: getBaseFriendlyAppName(appId), sourceTransport: "cached" })
    .filter(Boolean);
}

function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tagName = element.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function getQuickLaunchShortcutApp(index) {
  if (!Number.isInteger(index) || index < 0 || index > 8) return null;
  return getRenderedQuickLaunchApps()[index] || null;
}

function handleGlobalShortcut(descriptor) {
  const activeElement = document.activeElement;
  if (state.isDeviceModalOpen || state.isQuickLaunchEditMode || isEditableElement(activeElement) || (descriptor === "select" && activeElement?.closest("button, a, [role=button]"))) {
    return false;
  }

  switch (descriptor) {
    case "dpad_up":
    case "dpad_down":
    case "dpad_left":
    case "dpad_right":
    case "select":
    case "play_pause":
    case "home":
    case "back":
    case "rewind":
    case "fast_forward":
      void sendRemoteAction(descriptor);
      return true;
    default:
      break;
  }

  if (descriptor.startsWith("quick_launch_")) {
    const index = Number.parseInt(descriptor.slice("quick_launch_".length), 10) - 1;
    const app = getQuickLaunchShortcutApp(index);
    if (!app) return false;
    void launchApp(app.id);
    return true;
  }

  return false;
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getFilteredAvailableApps() {
  const selectedSet = new Set(state.quickLaunchApps);
  return sortApps(state.allApps).filter((app) => {
    if (selectedSet.has(app.id)) return false;
    if (!state.appSearchQuery) return true;
    const haystack = `${getFriendlyAppName(app.id)} ${app.id}`.toLowerCase();
    return haystack.includes(state.appSearchQuery.toLowerCase());
  });
}

function setQuickLaunchEditMode(nextState) {
  state.isQuickLaunchEditMode = nextState;
  if (!nextState) {
    state.appSearchQuery = "";
    state.renameEditorAppId = null;
    state.renameDraft = "";
    $("#appSearchInput").value = "";
  }
  $("#quickLaunchEditPanel").hidden = !nextState;
  syncModalAccessibility();
  if (!nextState) $("#editQuickLaunchBtn").focus();
  $("#editQuickLaunchBtn").textContent = nextState ? "Close Editor" : "Edit Quick Launch";
  renderQuickLaunchEditor();
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

  chunkItems(visibleApps, 4).forEach((rowApps) => {
    const row = document.createElement("div");
    row.className = "quick-launch-row";
    row.style.setProperty("--quick-launch-columns", String(rowApps.length));

    rowApps.forEach((app) => {
      const tile = createAppTile(app, {
        disabled: !hasActiveCapability("appLaunch"),
        title: hasActiveCapability("appLaunch")
          ? `Launch ${getFriendlyAppName(app.id)}`
          : "Connect to this Fire TV before launching apps",
      });
      tile.addEventListener("click", () => launchApp(app.id));
      row.appendChild(tile);
    });

    grid.appendChild(row);
  });
}

function createQuickLaunchSelectionItem(app) {
  const item = document.createElement("div");
  item.className = "quick-launch-item quick-launch-item-selected";
  item.draggable = true;
  item.dataset.appId = app.id;
  if (state.renameEditorAppId === app.id) {
    item.classList.add("is-renaming");
  }

  const handle = document.createElement("div");
  handle.className = "quick-launch-item-handle";
  handle.setAttribute("aria-hidden", "true");
  const grip = document.createElement("span");
  grip.className = "quick-launch-grip";
  handle.appendChild(grip);

  const meta = document.createElement("div");
  meta.className = "quick-launch-item-meta";

  const titleRow = document.createElement("div");
  titleRow.className = "quick-launch-item-title-row";
  titleRow.appendChild(createAppAvatar(app, "app-avatar quick-launch-avatar"));

  const title = document.createElement("div");
  title.className = "quick-launch-item-title";
  title.textContent = getFriendlyAppName(app.id);
  titleRow.appendChild(title);

  const packageLabel = document.createElement("div");
  packageLabel.className = "quick-launch-item-package";
  packageLabel.textContent = app.id;

  meta.appendChild(titleRow);
  meta.appendChild(packageLabel);

  const actions = document.createElement("div");
  actions.className = "app-manage-actions";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "btn app-manage-primary";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => {
    void removeQuickLaunchApp(app.id);
  });

  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "btn secondary small-action app-manage-secondary";
  renameButton.textContent = state.renameEditorAppId === app.id ? "Editing" : "Rename";
  renameButton.disabled = state.renameEditorAppId === app.id;
  renameButton.addEventListener("click", () => {
    beginAppRename(app.id);
  });

  const revertButton = document.createElement("button");
  revertButton.type = "button";
  revertButton.className = "btn secondary small-action app-manage-secondary";
  revertButton.textContent = "Revert";
  revertButton.disabled = !state.appDisplayNames[app.id];
  revertButton.addEventListener("click", () => {
    void revertAppRename(app.id);
  });

  item.addEventListener("dragstart", (event) => {
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", app.id);
  });

  item.addEventListener("dragend", () => {
    item.classList.remove("is-dragging");
    clearQuickLaunchDropState();
  });

  item.appendChild(handle);
  item.appendChild(meta);
  actions.appendChild(removeButton);
  actions.appendChild(renameButton);
  actions.appendChild(revertButton);
  item.appendChild(actions);

  if (state.renameEditorAppId === app.id) {
    item.appendChild(createRenameEditor(app));
  }
  return item;
}

function clearQuickLaunchDropState() {
  document.querySelectorAll(".quick-launch-item.is-drop-before, .quick-launch-item.is-drop-after").forEach((element) => {
    element.classList.remove("is-drop-before", "is-drop-after");
  });
}

function getQuickLaunchDropPlacement(list, clientY) {
  const items = [...list.querySelectorAll(".quick-launch-item-selected:not(.is-dragging)")];
  if (items.length === 0) {
    return { targetAppId: null, insertAfter: true };
  }

  let closestItem = items[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const distance = Math.abs(clientY - midpoint);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = item;
    }
  }

  const rect = closestItem.getBoundingClientRect();
  const insertAfter = clientY >= rect.top + rect.height / 2;
  return {
    targetAppId: closestItem.dataset.appId || null,
    insertAfter,
  };
}

function updateQuickLaunchDropState(list, clientY) {
  clearQuickLaunchDropState();
  const { targetAppId, insertAfter } = getQuickLaunchDropPlacement(list, clientY);
  if (!targetAppId) return { targetAppId: null, insertAfter: true };

  const targetItem = list.querySelector(`.quick-launch-item-selected[data-app-id="${CSS.escape(targetAppId)}"]`);
  if (targetItem) {
    targetItem.classList.add(insertAfter ? "is-drop-after" : "is-drop-before");
  }

  return { targetAppId, insertAfter };
}

function renderSelectedQuickLaunchList() {
  const list = $("#selectedQuickLaunchList");
  if (!list) return;

  const selectedApps = getRenderedQuickLaunchApps();
  list.innerHTML = "";
  $("#selectedQuickLaunchCount").textContent = `${selectedApps.length} pinned`;

  if (!state.isQuickLaunchEditMode) return;

  if (!state.activeSession || !getCurrentHost()) {
    list.appendChild(createEmptyState("Connect to a Fire TV first to manage Quick Launch."));
    return;
  }

  if (state.isLoadingApps) {
    list.appendChild(createEmptyState("Loading pinned apps..."));
    return;
  }

  if (selectedApps.length === 0) {
    list.appendChild(createEmptyState("No pinned apps yet. Add some from the library on the right."));
    return;
  }

  list.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateQuickLaunchDropState(list, event.clientY);
  });

  list.addEventListener("dragleave", (event) => {
    if (!(event.relatedTarget instanceof Node) || !list.contains(event.relatedTarget)) {
      clearQuickLaunchDropState();
    }
  });

  list.addEventListener("drop", (event) => {
    event.preventDefault();
    const draggedAppId = event.dataTransfer.getData("text/plain");
    const { targetAppId, insertAfter } = updateQuickLaunchDropState(list, event.clientY);
    clearQuickLaunchDropState();
    if (draggedAppId && targetAppId) {
      void reorderQuickLaunchApps(draggedAppId, targetAppId, insertAfter);
    }
  });

  selectedApps.forEach((app) => {
    list.appendChild(createQuickLaunchSelectionItem(app));
  });
}

function renderAllAppsGrid() {
  const grid = $("#allAppsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  $("#availableAppsCount").textContent = "0 available";
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

  const filteredApps = getFilteredAvailableApps();
  $("#availableAppsCount").textContent = `${filteredApps.length} available`;

  if (filteredApps.length === 0) {
    grid.appendChild(
      createEmptyState(state.appSearchQuery ? "No available apps matched your search." : "All discovered apps are already pinned."),
    );
    return;
  }

  filteredApps.forEach((app) => {
    grid.appendChild(createAvailableAppItem(app));
  });
}

function renderQuickLaunchEditor() {
  renderSelectedQuickLaunchList();
  renderAllAppsGrid();
}

async function updateQuickLaunchApps(nextApps, statusMessage, statusTone = null) {
  state.quickLaunchApps = nextApps;
  state.quickLaunchSelectionMissing = false;
  persistQuickLaunchSelection();
  await persistQuickLaunchSelectionRemote();
  renderQuickLaunchGrid();
  renderQuickLaunchEditor();
  if (statusMessage) {
    setQuickLaunchStatus(statusMessage, statusTone);
  }
}

async function updateAppDisplayNames(nextNames, statusMessage, statusTone = "success") {
  state.appDisplayNames = sanitizeAppDisplayNames(nextNames);
  await persistAppDisplayNamesRemote();
  renderQuickLaunchGrid();
  renderQuickLaunchEditor();
  if (statusMessage) {
    setQuickLaunchStatus(statusMessage, statusTone);
  }
}

function beginAppRename(appId) {
  state.renameEditorAppId = appId;
  state.renameDraft = state.appDisplayNames[appId] || getBaseFriendlyAppName(appId);
  renderQuickLaunchEditor();
  window.requestAnimationFrame(() => {
    const input = document.querySelector(`[data-rename-input-for="${CSS.escape(appId)}"]`);
    input?.focus();
    input?.select?.();
  });
}

function cancelAppRename() {
  state.renameEditorAppId = null;
  state.renameDraft = "";
  renderQuickLaunchEditor();
}

async function saveAppRename(appId) {
  const nextName = state.renameDraft.trim();
  if (!nextName) {
    setQuickLaunchStatus("Enter a name before saving it.", "error");
    return;
  }

  const baseName = getBaseFriendlyAppName(appId);
  const nextNames = { ...state.appDisplayNames };
  if (nextName === baseName) {
    delete nextNames[appId];
  } else {
    nextNames[appId] = nextName;
  }

  state.renameEditorAppId = null;
  state.renameDraft = "";
  await updateAppDisplayNames(
    nextNames,
    nextName === baseName ? `${baseName} restored.` : `${nextName} saved.`,
    "success",
  );
}

async function revertAppRename(appId) {
  if (!state.appDisplayNames[appId]) return;
  const nextNames = { ...state.appDisplayNames };
  delete nextNames[appId];
  if (state.renameEditorAppId === appId) {
    state.renameEditorAppId = null;
    state.renameDraft = "";
  }
  await updateAppDisplayNames(nextNames, `${getBaseFriendlyAppName(appId)} restored.`, "success");
}

function createRenameEditor(app) {
  const editor = document.createElement("div");
  editor.className = "app-rename-editor";

  const label = document.createElement("label");
  label.className = "sr-only";
  label.htmlFor = `rename-${app.id}`;
  label.textContent = `Rename ${getFriendlyAppName(app.id)}`;

  const input = document.createElement("input");
  input.id = `rename-${app.id}`;
  input.className = "app-rename-input";
  input.type = "text";
  input.maxLength = 80;
  input.value = state.renameDraft;
  input.placeholder = getBaseFriendlyAppName(app.id);
  input.dataset.renameInputFor = app.id;
  input.addEventListener("input", (event) => {
    state.renameDraft = event.target.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveAppRename(app.id);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelAppRename();
    }
  });

  const actionRow = document.createElement("div");
  actionRow.className = "app-rename-actions";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "btn app-manage-primary compact";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => {
    void saveAppRename(app.id);
  });

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn secondary small-action app-manage-secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", cancelAppRename);

  actionRow.appendChild(saveButton);
  actionRow.appendChild(cancelButton);
  editor.appendChild(label);
  editor.appendChild(input);
  editor.appendChild(actionRow);
  return editor;
}

function createAvailableAppItem(app) {
  const item = document.createElement("div");
  item.className = "quick-launch-item quick-launch-item-available";
  item.dataset.appId = app.id;
  if (state.renameEditorAppId === app.id) {
    item.classList.add("is-renaming");
  }

  const avatar = createAppAvatar(app, "app-avatar quick-launch-avatar");
  const meta = document.createElement("div");
  meta.className = "quick-launch-item-meta";

  const titleRow = document.createElement("div");
  titleRow.className = "quick-launch-item-title-row";
  titleRow.appendChild(avatar);

  const title = document.createElement("div");
  title.className = "quick-launch-item-title";
  title.textContent = getFriendlyAppName(app.id);
  titleRow.appendChild(title);

  const packageLabel = document.createElement("div");
  packageLabel.className = "quick-launch-item-package";
  packageLabel.textContent = app.id;

  meta.appendChild(titleRow);
  meta.appendChild(packageLabel);

  const actions = document.createElement("div");
  actions.className = "app-manage-actions";

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "btn app-manage-primary";
  addButton.textContent = "Add";
  addButton.addEventListener("click", () => {
    void addQuickLaunchApp(app.id);
  });

  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.className = "btn secondary small-action app-manage-secondary";
  renameButton.textContent = state.renameEditorAppId === app.id ? "Editing" : "Rename";
  renameButton.disabled = state.renameEditorAppId === app.id;
  renameButton.addEventListener("click", () => {
    beginAppRename(app.id);
  });

  const revertButton = document.createElement("button");
  revertButton.type = "button";
  revertButton.className = "btn secondary small-action app-manage-secondary";
  revertButton.textContent = "Revert";
  revertButton.disabled = !state.appDisplayNames[app.id];
  revertButton.addEventListener("click", () => {
    void revertAppRename(app.id);
  });

  actions.appendChild(addButton);
  actions.appendChild(renameButton);
  actions.appendChild(revertButton);
  item.appendChild(meta);
  item.appendChild(actions);

  if (state.renameEditorAppId === app.id) {
    item.appendChild(createRenameEditor(app));
  }

  return item;
}

async function removeQuickLaunchApp(appId) {
  if (!state.quickLaunchApps.includes(appId)) return;
  await updateQuickLaunchApps(
    state.quickLaunchApps.filter((item) => item !== appId),
    `${getFriendlyAppName(appId)} removed from Quick Launch.`,
    null,
  );
}

async function addQuickLaunchApp(appId) {
  if (state.quickLaunchApps.includes(appId)) return;
  if (state.quickLaunchApps.length >= MAX_QUICK_LAUNCH_APPS) {
    setQuickLaunchStatus(`Quick Launch is limited to ${MAX_QUICK_LAUNCH_APPS} apps.`, "error");
    return;
  }

  await updateQuickLaunchApps(
    [...state.quickLaunchApps, appId],
    `${getFriendlyAppName(appId)} added to Quick Launch.`,
    "success",
  );
}

async function reorderQuickLaunchApps(draggedAppId, targetAppId, insertAfter = false) {
  if (!draggedAppId || !targetAppId) return;

  const currentIndex = state.quickLaunchApps.indexOf(draggedAppId);
  const targetIndex = state.quickLaunchApps.indexOf(targetAppId);
  if (currentIndex === -1 || targetIndex === -1) return;

  const nextApps = state.quickLaunchApps.filter((appId) => appId !== draggedAppId);
  const insertionBaseIndex = nextApps.indexOf(targetAppId);
  const insertionIndex = insertionBaseIndex === -1 ? nextApps.length : insertionBaseIndex + (insertAfter ? 1 : 0);
  nextApps.splice(insertionIndex, 0, draggedAppId);

  if (nextApps.every((appId, index) => appId === state.quickLaunchApps[index])) return;
  await updateQuickLaunchApps(nextApps, "Quick Launch order updated.", "success");
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
  void persistQuickLaunchSelectionRemote();
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
    renderQuickLaunchEditor();
    return;
  }

  state.isLoadingApps = true;
  state.quickLaunchError = "";
  renderQuickLaunchGrid();
  renderQuickLaunchEditor();

  try {
    const deviceId = getActiveDeviceId();
    const query = new URLSearchParams({ host });
    if (deviceId) query.set("deviceId", deviceId);
    const data = await apiRequest(`/api/apps?${query.toString()}`);
    applySession(data.device, data.session);
    const discoveredApps = Array.isArray(data.apps) ? data.apps : [];
    cacheAppsForHost(host, discoveredApps);
    state.allApps = getCachedAppsForHost(host);
    state.quickLaunchError = "";
    seedQuickLaunchSelectionIfNeeded();
  } catch (error) {
    const cachedApps = getCachedAppsForHost(host);
    state.allApps = cachedApps;
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
      renderQuickLaunchEditor();
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
    const data = await apiRequest("/api/adb/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, deviceId }),
    });

    const adbOffline = data?.result?.probe?.adbState === "offline";
    if (!data?.result?.ok) {
      setConnectionStatus(
        adbOffline
          ? "ADB is still offline on the Fire TV. Restart ADB debugging on the Fire TV, then press Repair ADB again."
          : "ADB repair did not finish. Try Connect again, or restart ADB debugging on the Fire TV if it stays unavailable.",
        "error",
      );
      setSideloadStatus(
        adbOffline
          ? "Restart ADB debugging on the Fire TV before sideloading or launching apps."
          : "ADB is still unavailable for sideloading.",
        "error",
      );
      return;
    }

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
  renderQuickLaunchEditor();
}

let desktopUpdateSnapshot = null;
let stopDesktopUpdateListener = null;

function renderDesktopUpdateState(update) {
  desktopUpdateSnapshot = update;
  const version = update?.currentVersion ? `Desktop app · v${update.currentVersion}` : "Desktop app updates";
  $("#desktopAppVersion").textContent = version;
  $("#updateMessage").textContent = update?.message || "";

  const busy = ["checking", "downloading", "installing"].includes(update?.status);
  const staged = update?.status === "ready";
  const canDownload = update?.status === "available" && Boolean(update?.canInstall);
  $("#checkUpdatesBtn").disabled = busy || staged || !window.fireTvDesktopUpdates;
  $("#checkUpdatesBtn").textContent = update?.status === "checking" ? "Checking…" : "Check for updates";
  $("#downloadUpdateBtn").hidden = !canDownload;
  $("#downloadUpdateBtn").disabled = busy;
  $("#downloadUpdateBtn").textContent = update?.availableVersion ? `Download v${update.availableVersion}` : "Download update";
  $("#installUpdateBtn").hidden = !staged;
  $("#installUpdateBtn").disabled = busy || !update?.canInstall;
  $("#updateProgressRow").hidden = update?.status !== "downloading";
  const progress = Math.max(0, Math.min(100, Number(update?.progress) || 0));
  $("#updateProgress").value = progress;
  $("#updateProgressLabel").textContent = `${Math.round(progress)}%`;
}

async function runDesktopUpdateAction(action) {
  const bridge = window.fireTvDesktopUpdates;
  if (!bridge) return;
  try {
    const result = action === "check" ? await bridge.check()
      : action === "download" ? await bridge.download()
      : await bridge.install();
    if (result) renderDesktopUpdateState(result);
  } catch (error) {
    renderDesktopUpdateState({
      ...(desktopUpdateSnapshot || {}),
      status: "error",
      message: error?.message || "The update request failed. Please try again.",
    });
  }
}

async function initializeDesktopUpdates() {
  const bridge = window.fireTvDesktopUpdates;
  if (!bridge) {
    renderDesktopUpdateState({ status: "unsupported", message: "Update controls are available in the installed desktop app." });
    return;
  }
  stopDesktopUpdateListener?.();
  stopDesktopUpdateListener = bridge.onState(renderDesktopUpdateState);
  try {
    renderDesktopUpdateState(await bridge.getStatus());
  } catch (error) {
    renderDesktopUpdateState({ status: "error", message: error?.message || "Could not connect to the desktop update service." });
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
  $("#quickLaunchEditPanel").addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.closeQuickLaunch === "true") {
      setQuickLaunchEditMode(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    const modal = state.isQuickLaunchEditMode ? $("#quickLaunchEditPanel") : state.isDeviceModalOpen ? $("#deviceModal") : null;
    if (event.key === "Tab" && modal) {
      const items = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
      return;
    }
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
      return;
    }

    const shortcutMap = {
      Enter: "select",
      Backspace: "back",
      ArrowUp: "dpad_up",
      ArrowDown: "dpad_down",
      ArrowLeft: "dpad_left",
      ArrowRight: "dpad_right",
      " ": "select",
    };

    if (shortcutMap[event.key] && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const handled = handleGlobalShortcut(shortcutMap[event.key]);
      if (handled) {
        event.preventDefault();
      }
      return;
    }

    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "ArrowLeft") {
        const handled = handleGlobalShortcut("rewind");
        if (handled) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "ArrowRight") {
        const handled = handleGlobalShortcut("fast_forward");
        if (handled) {
          event.preventDefault();
        }
        return;
      }

      if (event.key.toLowerCase() === "h") {
        const handled = handleGlobalShortcut("home");
        if (handled) {
          event.preventDefault();
        }
        return;
      }

      if (event.key.toLowerCase() === "p") {
        const handled = handleGlobalShortcut("play_pause");
        if (handled) {
          event.preventDefault();
        }
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        const handled = handleGlobalShortcut(`quick_launch_${event.key}`);
        if (handled) {
          event.preventDefault();
        }
      }
    }
  });

  window.__fireTvHandleShortcut = (descriptor) => handleGlobalShortcut(String(descriptor || ""));

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

  $("#themeToggleBtn").addEventListener("click", () => {
    const nextTheme = state.themeMode === "light" ? "dark" : "light";
    void setThemeMode(nextTheme).catch((error) => {
      console.error("Failed to save theme preference:", error);
    });
  });

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
  $("#checkUpdatesBtn").addEventListener("click", () => void runDesktopUpdateAction("check"));
  $("#downloadUpdateBtn").addEventListener("click", () => void runDesktopUpdateAction("download"));
  $("#installUpdateBtn").addEventListener("click", () => void runDesktopUpdateAction("install"));

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
    renderQuickLaunchEditor();
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
  applyThemeMode(DEFAULT_THEME_MODE);
  wireUI();
  resetDeviceForm();
  updateApkMeta();
  await loadPreferences();
  refreshUi();
  await loadSavedDevices();
  await initializeDesktopUpdates();
  await tryAutoConnectDefaultDevice();
}

init().catch((error) => {
  console.error("Failed to initialize app:", error);
  setConnectionStatus(error.message || "Failed to initialize app.", "error");
});
