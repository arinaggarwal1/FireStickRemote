const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

let currentDeviceIndex = null;
let isConnected = false;

async function getConfig() {
  const res = await fetch("/api/config");
  return await res.json();
}

async function disconnect() {
  try {
    await fetch("/api/disconnect", { method: "POST" });
  } catch (e) {
    // ignore disconnect errors
  }
}

async function connect() {
  const deviceSelect = $("#deviceSelect");
  const connectBtn = $("#connectBtn");
  const manualInput = $("#manualInput");
  const manualHost = $("#manualHost");
  const manualHostExpanded = $("#manualHostExpanded");
  
  // If switching devices, disconnect first
  if (currentDeviceIndex !== null && currentDeviceIndex !== parseInt(deviceSelect.value)) {
    await disconnect();
    isConnected = false;
  }
  
  currentDeviceIndex = parseInt(deviceSelect.value);
  
  // Set connecting state for both buttons
  connectBtn.classList.remove("connected", "disconnected");
  connectBtn.classList.add("connecting");
  connectBtn.textContent = "Connecting...";
  
  const connectBtnExpanded = $("#connectBtnExpanded");
  connectBtnExpanded.classList.remove("connected", "disconnected");
  connectBtnExpanded.classList.add("connecting");
  connectBtnExpanded.textContent = "Connecting...";
  
  try {
    let requestBody;
    
    // Check if manual input is selected
    if (deviceSelect.value === "manual") {
      const hostInput = manualHost.value.trim() || manualHostExpanded.value.trim();
      if (!hostInput) {
        throw new Error("Please enter IP:PORT");
      }
      requestBody = { manualHost: hostInput };
    } else {
      requestBody = { deviceIndex: currentDeviceIndex };
    }
    
    const res = await fetch("/api/connect", { 
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const data = await res.json();
    
    const success = data.code === 0 && /connected to|already connected/i.test(data.stdout);
    isConnected = success;
    
    // Update button state for both buttons
    connectBtn.classList.remove("connecting");
    connectBtnExpanded.classList.remove("connecting");
    if (success) {
      connectBtn.classList.add("connected");
      connectBtn.textContent = "Connected";
      connectBtnExpanded.classList.add("connected");
      connectBtnExpanded.textContent = "Connected";
    } else {
      connectBtn.classList.add("disconnected");
      connectBtn.textContent = "Connect";
      connectBtnExpanded.classList.add("disconnected");
      connectBtnExpanded.textContent = "Connect";
    }
  } catch (e) {
    connectBtn.classList.remove("connecting");
    connectBtn.classList.add("disconnected");
    connectBtn.textContent = "Connect";
    connectBtnExpanded.classList.remove("connecting");
    connectBtnExpanded.classList.add("disconnected");
    connectBtnExpanded.textContent = "Connect";
    isConnected = false;
    console.error("Connection failed:", e);
  }
}

async function sendKey(code) {
  const res = await fetch("/api/key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

function flashIndicator() {
  try {
    const indicator = document.getElementById("indicator");
    if (indicator) {
      indicator.classList.add("active");
      setTimeout(() => indicator.classList.remove("active"), 200);
    }
  } catch (_) {}
}

async function sendText(text) {
  if (!text) return;
  await fetch("/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// App package mapping for Fire TV
// To find app packages, use: adb shell pm list packages | grep <app_name>
// To launch: adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1
const APP_PACKAGES = {
  prime: "com.amazon.firebat", // Amazon Prime Video ✅ CONFIRMED WORKING
  netflix: "com.netflix.ninja", // Netflix (confirmed working)  
  youtube: "com.amazon.firetv.youtube.tv", // YouTube TV ✅ CONFIRMED WORKING
  hulu: "com.hulu.plus" // Hulu (confirmed working)
};

async function launchApp(appName) {
  const packageName = APP_PACKAGES[appName];
  if (!packageName) {
    console.error("Unknown app:", appName);
    return;
  }
  
  try {
    await fetch("/api/app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        app: appName,
        package: packageName 
      }),
    });
    flashIndicator();
  } catch (e) {
    console.error("Failed to launch app:", e);
  }
}

function wireUI() {
  const deviceSelect = $("#deviceSelect");
  const connectBtn = $("#connectBtn");
  const manualInput = $("#manualInput");
  const deviceConfig = $("#deviceConfig");
  const deviceControlsExpanded = $("#deviceControlsExpanded");
  const deviceSelectExpanded = $("#deviceSelectExpanded");
  const connectBtnExpanded = $("#connectBtnExpanded");
  const manualHostExpanded = $("#manualHostExpanded");

  // Wire up both connect buttons
  connectBtn.addEventListener("click", connect);
  connectBtnExpanded.addEventListener("click", connect);
  
  // Handle device selection changes
  deviceSelect.addEventListener("change", async () => {
    // Show/hide manual input based on selection
    if (deviceSelect.value === "manual") {
      manualInput.style.display = "flex";
      // Switch to expanded layout
      deviceConfig.style.display = "none";
      deviceControlsExpanded.style.display = "flex";
      // Sync the expanded dropdown
      deviceSelectExpanded.value = "manual";
    } else {
      manualInput.style.display = "none";
      // Switch back to header layout
      deviceConfig.style.display = "flex";
      deviceControlsExpanded.style.display = "none";
      // Sync the header dropdown
      deviceSelectExpanded.value = deviceSelect.value;
    }
    
    // Disconnect when device selection changes
    if (isConnected) {
      await disconnect();
      isConnected = false;
      connectBtn.classList.remove("connected", "connecting");
      connectBtn.classList.add("disconnected");
      connectBtn.textContent = "Connect";
      connectBtnExpanded.classList.remove("connected", "connecting");
      connectBtnExpanded.classList.add("disconnected");
      connectBtnExpanded.textContent = "Connect";
    }
  });
  
  // Handle expanded dropdown changes
  deviceSelectExpanded.addEventListener("change", async () => {
    // Sync with header dropdown
    deviceSelect.value = deviceSelectExpanded.value;
    
    // Trigger the same layout logic as the header dropdown
    if (deviceSelectExpanded.value === "manual") {
      manualInput.style.display = "flex";
      deviceConfig.style.display = "none";
      deviceControlsExpanded.style.display = "flex";
    } else {
      manualInput.style.display = "none";
      deviceConfig.style.display = "flex";
      deviceControlsExpanded.style.display = "none";
    }
    
    // Disconnect when device selection changes
    if (isConnected) {
      await disconnect();
      isConnected = false;
      connectBtn.classList.remove("connected", "connecting");
      connectBtn.classList.add("disconnected");
      connectBtn.textContent = "Connect";
      connectBtnExpanded.classList.remove("connected", "connecting");
      connectBtnExpanded.classList.add("disconnected");
      connectBtnExpanded.textContent = "Connect";
    }
  });

  document.querySelectorAll("button[data-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = Number(btn.dataset.key);
      console.log(`Button clicked: keycode ${code}`);
      if (code === 23) {
        console.log("Select button (center) clicked - sending keycode 23");
      }
      flashIndicator();
      sendKey(code);
    });
  });

  // Wire up app buttons
  document.querySelectorAll("button[data-app]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const appName = btn.dataset.app;
      launchApp(appName);
    });
  });
}

async function init() {
  const config = await getConfig();
  const deviceSelect = $("#deviceSelect");
  const deviceSelectExpanded = $("#deviceSelectExpanded");
  
  // Populate both dropdowns
  deviceSelect.innerHTML = "";
  deviceSelectExpanded.innerHTML = "";
  
  if (config.devices) {
    config.devices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = index;
      option.textContent = device.name;
      if (device.default) option.selected = true;
      deviceSelect.appendChild(option);
      
      // Clone for expanded dropdown
      const optionExpanded = option.cloneNode(true);
      deviceSelectExpanded.appendChild(optionExpanded);
    });
  }
  
  // Add manual input option to both dropdowns
  const manualOption = document.createElement("option");
  manualOption.value = "manual";
  manualOption.textContent = "Manual";
  deviceSelect.appendChild(manualOption);
  
  const manualOptionExpanded = manualOption.cloneNode(true);
  deviceSelectExpanded.appendChild(manualOptionExpanded);
  
  wireUI();
  
  // Auto-connect to default device
  const defaultDevice = config.devices && config.devices.find(d => d.default) || config.devices && config.devices[0];
  if (defaultDevice) {
    await connect();
  }
}

init();
