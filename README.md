# Fire TV Remote

A desktop-first Fire TV remote built with Electron, Express, and ADB.

It gives you:
- a full Fire TV remote layout with D-pad, playback, volume, power, home, menu, and back
- explicit text send with a compose box and a dedicated `Send Text` button
- a persistent saved-device manager with named Fire TV targets
- a dynamic Quick Launch grid built from the apps actually installed on your Fire TV, including sideloaded apps
- a packaged macOS app + DMG build flow

## What It Is

The app runs in an Electron window, not just a browser tab.

Inside the desktop app:
- Electron starts a private local Express server
- the frontend talks to that server over localhost
- the server runs `adb` commands against your Fire TV

The same Express server can still be run by itself for local development or server-style deployment, but the primary workflow is now the desktop app.

## Requirements

- macOS
- Node.js 18+
- ADB installed

The app tries several common ADB locations automatically, including:
- `/opt/homebrew/bin/adb`
- `/usr/local/bin/adb`
- Android SDK `platform-tools`

You can also force a specific binary with:

```bash
ADB_PATH=/absolute/path/to/adb
```

## Fire TV Setup

On the Fire TV:

1. Open `Settings -> My Fire TV -> Developer options`
2. Turn on `ADB debugging`
3. Make sure you know the device IP address
4. Default ADB TCP port is `5555`

## Install

```bash
npm install
```

## Run

### Desktop dev mode

```bash
npm run desktop
```

This launches the Electron desktop app directly.

### Standalone server mode

```bash
npm run dev
```

or

```bash
npm run start
```

By default the standalone server listens on:

```text
http://localhost:9090
```

## Package a macOS App

To build a fresh drag-to-Applications DMG:

```bash
npm run desktop:package
```

This command:
- deletes the previous `dist/` output first
- builds a real macOS `.app`
- creates a DMG you can distribute or install locally

Output files:
- [`dist/Fire TV Remote-1.0.0-arm64.dmg`](/Users/arinaggarwal/Documents/Software Dev/FireStickRemote/dist/Fire TV Remote-1.0.0-arm64.dmg)
- [`dist/mac-arm64/Fire TV Remote.app`](/Users/arinaggarwal/Documents/Software Dev/FireStickRemote/dist/mac-arm64/Fire TV Remote.app)

Note:
- the packaged app is currently unsigned
- macOS may require `Right click -> Open` the first time you launch it

## Persistence

The app keeps user data outside the packaged app bundle.

### Desktop app data

When running through Electron, app data is stored under:

```text
~/Library/Application Support/Fire TV Remote
```

That means your data survives:
- rebuilding the DMG
- reinstalling the app
- dragging a new `.app` into Applications

### Saved devices

Saved devices are persisted in:

```text
devices.json
```

In Electron, that file lives under the Application Support folder above.

### Quick Launch selections

Quick Launch selections are stored in the app’s browser storage inside the Electron user-data directory, so they also survive rebuilds and reinstallations.

### Legacy config seeding

If a legacy [`config.yml`](/Users/arinaggarwal/Documents/Software Dev/FireStickRemote/config.yml) exists, the server can use it as a one-time seed source for saved devices. Ongoing edits happen in persisted app data, not in `config.yml`.

## Main Features

### Saved device manager

The app uses a popup saved-device manager instead of always showing device configuration on the main screen.

You can:
- add a Fire TV by name
- edit saved devices
- delete saved devices
- load a device into the connection field
- connect directly from the saved-device modal

### Full remote controls

The remote includes:
- Power `26`
- Home `3`
- Back `4`
- Menu `82`
- D-pad Up `19`
- D-pad Down `20`
- D-pad Left `21`
- D-pad Right `22`
- Select `23`
- Play/Pause `85`
- Rewind `89`
- Forward `90`
- Volume Up `24`
- Volume Down `25`
- Mute `164`

### Text sending

Text is only sent when you press `Send Text`.

The backend sends:

```bash
adb -s HOST shell input text "YOUR_TEXT"
```

Spaces are encoded for ADB, and newlines are normalized to spaces.

The text panel also includes a `Backspace` button. On Fire TV that is mapped to the rewind key code:

```text
89
```

### Dynamic Quick Launch

Quick Launch is package-driven and user-configurable.

The app:
1. queries installed packages from the Fire TV
2. renders a launcher grid dynamically
3. lets you pick which installed apps should be pinned
4. persists those pinned selections locally

The edit panel includes:
- installed-app discovery
- search
- selected/unselected states
- immediate add/remove feedback

The backend does not depend on hardcoded app IDs. Launching works off package names.

## Installed App Discovery

The backend route is:

```text
GET /api/apps?host=HOST
```

It tries multiple discovery paths and returns:

```json
{
  "packages": ["com.netflix.ninja", "org.xbmc.kodi"]
}
```

This allows Quick Launch to include:
- Appstore apps
- sideloaded apps
- launcher-visible apps discovered from the connected Fire TV

## App Launching

The launch endpoint is:

```text
POST /api/app
```

Payload:

```json
{
  "package": "com.netflix.ninja",
  "host": "10.194.20.230:5555"
}
```

Launches use:

```bash
adb -s HOST shell monkey -p PACKAGE -c CATEGORY 1
```

Special handling remains in place for packages that need:

```text
android.intent.category.LEANBACK_LAUNCHER
```

Prime Video is the main built-in special case.

## API

Current backend routes:

- `GET /api/devices`
- `POST /api/devices`
- `PUT /api/devices/:id`
- `DELETE /api/devices/:id`
- `GET /api/apps?host=HOST`
- `POST /api/connect`
- `POST /api/disconnect`
- `POST /api/pair`
- `POST /api/key`
- `POST /api/text`
- `POST /api/swipe`
- `POST /api/app`

## Project Structure

```text
FireStickRemote/
├── electron/
│   ├── icon.icns
│   ├── main.js
│   └── open-built-app.js
├── public/
│   ├── favicon_io/
│   ├── icons/
│   ├── index.html
│   ├── main.js
│   └── styles.css
├── server/
│   └── index.js
├── config.yml
├── firetv-remote.service
└── package.json
```

## Development Notes

- The frontend is plain HTML/CSS/JS with no bundler.
- The desktop shell is Electron.
- The backend is a small Express server that wraps ADB subprocesses.
- Static assets are served with no-cache headers so the desktop shell pulls fresh frontend code after changes.
- The packaged app uses a custom rounded icon and proper app metadata (`Fire TV Remote`) instead of showing the stock Electron app name.

## Troubleshooting

### `spawn adb ENOENT`

This usually means the packaged app cannot see your shell PATH.

The app now checks common ADB locations automatically, but if needed you can still force it:

```bash
ADB_PATH=/opt/homebrew/bin/adb npm run desktop
```

### Quick Launch shows no apps

Check:

1. the Fire TV is connected over ADB
2. the app is connected to the correct `IP:PORT`
3. ADB debugging is enabled on the Fire TV

You can verify from the terminal:

```bash
adb devices -l
adb -s 10.194.20.230:5555 shell pm list packages -3
```

### Packaged app opens but macOS warns about it

The app is not code-signed right now. On first launch:

1. Right click the app
2. Click `Open`
3. Confirm the prompt

### Rebuilding the DMG

`npm run desktop:package` removes the previous `dist/` folder first, so rebuilding replaces the old package output instead of accumulating stale DMGs.

## Optional System Service

The repo still includes [`firetv-remote.service`](/Users/arinaggarwal/Documents/Software Dev/FireStickRemote/firetv-remote.service) if you want to run the standalone Express server as a systemd service on a Linux box, but that is separate from the Electron desktop app workflow.
