import fs from "fs";
import path from "path";

function sanitizeThemeMode(value) {
  return value === "light" ? "light" : "dark";
}

function sanitizeQuickLaunchApps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function sanitizeAppDisplayNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .map(([appId, displayName]) => [String(appId || "").trim(), String(displayName || "").trim()])
      .filter(([appId, displayName]) => Boolean(appId) && Boolean(displayName)),
  );
}

export function createPreferencesStore({ dataDir }) {
  const preferencesFile = path.resolve(dataDir, "preferences.json");
  const STORE_VERSION = 3;

  function ensureDataDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function writeStore(preferences) {
    ensureDataDir();
    fs.writeFileSync(
      preferencesFile,
      JSON.stringify(
        {
          version: STORE_VERSION,
          themeMode: sanitizeThemeMode(preferences?.themeMode),
          quickLaunchApps: sanitizeQuickLaunchApps(preferences?.quickLaunchApps),
          appDisplayNames: sanitizeAppDisplayNames(preferences?.appDisplayNames),
        },
        null,
        2,
      ),
    );
  }

  function readStore() {
    ensureDataDir();

    try {
      const raw = fs.readFileSync(preferencesFile, "utf8");
      const parsed = JSON.parse(raw);
      const preferences = {
        themeMode: sanitizeThemeMode(parsed?.themeMode),
        quickLaunchApps: sanitizeQuickLaunchApps(parsed?.quickLaunchApps),
        appDisplayNames: sanitizeAppDisplayNames(parsed?.appDisplayNames),
      };

      if ((parsed?.version || 1) !== STORE_VERSION) {
        writeStore(preferences);
      }

      return preferences;
    } catch (_) {
      return {
        themeMode: "dark",
        quickLaunchApps: [],
        appDisplayNames: {},
      };
    }
  }

  function getPreferences() {
    return readStore();
  }

  function getQuickLaunchApps() {
    return readStore().quickLaunchApps;
  }

  function getThemeMode() {
    return readStore().themeMode;
  }

  function getAppDisplayNames() {
    return readStore().appDisplayNames;
  }

  function setQuickLaunchApps(appIds) {
    const nextPreferences = {
      ...readStore(),
      quickLaunchApps: sanitizeQuickLaunchApps(appIds),
    };
    writeStore(nextPreferences);
    return nextPreferences.quickLaunchApps;
  }

  function setThemeMode(themeMode) {
    const nextPreferences = {
      ...readStore(),
      themeMode: sanitizeThemeMode(themeMode),
    };
    writeStore(nextPreferences);
    return nextPreferences.themeMode;
  }

  function setAppDisplayNames(appDisplayNames) {
    const nextPreferences = {
      ...readStore(),
      appDisplayNames: sanitizeAppDisplayNames(appDisplayNames),
    };
    writeStore(nextPreferences);
    return nextPreferences.appDisplayNames;
  }

  return {
    preferencesFile,
    getPreferences,
    getQuickLaunchApps,
    getThemeMode,
    getAppDisplayNames,
    setQuickLaunchApps,
    setThemeMode,
    setAppDisplayNames,
  };
}
