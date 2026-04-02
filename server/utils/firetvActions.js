export const FIRETV_REMOTE_ACTIONS = [
  "power",
  "home",
  "menu",
  "back",
  "rewind",
  "play_pause",
  "fast_forward",
  "dpad_up",
  "dpad_left",
  "select",
  "dpad_right",
  "dpad_down",
  "volume_up",
  "mute",
  "volume_down",
];

export const ADB_KEYCODE_BY_ACTION = {
  power: 26,
  home: 3,
  menu: 82,
  back: 4,
  rewind: 89,
  play_pause: 85,
  fast_forward: 90,
  dpad_up: 19,
  dpad_left: 21,
  select: 23,
  dpad_right: 22,
  dpad_down: 20,
  volume_up: 24,
  mute: 164,
  volume_down: 25,
};

export const LEGACY_KEYCODE_TO_ACTION = Object.fromEntries(
  Object.entries(ADB_KEYCODE_BY_ACTION).map(([action, keycode]) => [String(keycode), action]),
);

export function isSemanticRemoteAction(action) {
  return FIRETV_REMOTE_ACTIONS.includes(String(action || ""));
}

export function getSemanticActionFromLegacyKeycode(keycode) {
  return LEGACY_KEYCODE_TO_ACTION[String(keycode)] || null;
}

export function getAdbKeycodeForAction(action) {
  return ADB_KEYCODE_BY_ACTION[String(action || "")] ?? null;
}

export function normalizeRemoteAction(actionOrKeycode) {
  const raw = String(actionOrKeycode || "").trim();
  if (!raw) return "";
  if (isSemanticRemoteAction(raw)) return raw;
  return getSemanticActionFromLegacyKeycode(raw) || "";
}
