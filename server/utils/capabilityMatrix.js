function preferredTransport(primaryReady, fallbackReady, primary = "https", fallback = "adb") {
  if (primaryReady) return primary;
  if (fallbackReady) return fallback;
  return null;
}

export function deriveCapabilities(session) {
  const httpsReady = Boolean(session?.authenticated);
  const adbReady = Boolean(session?.adbConnected);
  const adbAvailable = Boolean(session?.adbAvailable);
  const adbListReady = adbReady || adbAvailable;
  const adbLaunchReady = adbReady || adbAvailable;
  const httpsAppListReady = Boolean(session?.authenticated && session?.httpsAppListAvailable !== false);
  const httpsTextReady = Boolean(session?.authenticated && session?.httpsTextAvailable !== false);
  const httpsAppLaunchReady = Boolean(session?.authenticated && session?.httpsAppLaunchAvailable);

  const capabilities = {
    remoteControl: httpsReady || adbReady,
    textInput: httpsTextReady || adbReady,
    appList: httpsAppListReady || adbListReady,
    appLaunch: httpsAppLaunchReady || adbLaunchReady,
    sideload: adbReady || adbAvailable,
    swipe: adbReady,
  };

  const preferredTransports = {
    remoteControl: preferredTransport(httpsReady, adbReady),
    textInput: preferredTransport(httpsTextReady, adbReady),
    appList: preferredTransport(httpsAppListReady, adbListReady),
    appLaunch: preferredTransport(httpsAppLaunchReady, adbLaunchReady),
    installApk: adbAvailable ? "adb" : null,
    swipe: adbReady ? "adb" : null,
  };

  return { capabilities, preferredTransports };
}

export function deriveStatusLabel(session) {
  if (session?.authenticated) return "Remote ready";
  if (session?.pairingRequired) return "Pairing required";
  if (session?.adbConnected) return "HTTPS remote unavailable, using ADB fallback";
  if (session?.adbAvailable) return "ADB available for sideloading";
  if (session?.httpsReachable === false && session?.adbAvailable === false) return "Device unavailable";
  return "Ready to connect";
}
