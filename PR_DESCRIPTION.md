# PR Title

Fire TV Remote: convert browser remote into a desktop app with persistent devices, dynamic Quick Launch, and a modernized control surface

## Summary

This PR transforms the original browser-first Fire TV remote into a desktop-first Electron app with a redesigned interface, package-driven Quick Launch, persistent saved devices, explicit text sending, and packaged macOS distribution.

The old version centered on a simple web page with hardcoded app buttons and a more limited connection model. The new version keeps the existing ADB-driven command pipeline, but wraps it in a native desktop shell and expands the product into a fuller Fire TV control experience.

## What Changed

### Desktop app conversion

- Added an Electron shell that launches the existing Express server in a private local app environment
- Set the runtime app name to `Fire TV Remote`
- Added a rounded custom app icon for the desktop shell
- Added macOS packaging with `electron-builder`
- Added a one-command DMG build flow
- Kept `npm run desktop` as the fast dev-mode desktop launcher

### Persistence and app data

- Moved desktop app data to `~/Library/Application Support/Fire TV Remote`
- Kept saved devices out of the packaged `.app` bundle
- Kept Quick Launch selections persistent across app relaunches and packaged installs
- Preserved support for one-time seeding from legacy `config.yml`

### Connection and device management

- Removed the old dropdown/manual-toggle connection UX
- Replaced it with a direct IP/IP:PORT connection field
- Added a saved-device manager with named device entries
- Added create, edit, delete, load, and connect actions for saved devices
- Moved saved-device management into a popup modal instead of leaving it always visible on the page

### Remote UI/UX overhaul

- Rebuilt the interface into a modern, desktop-style remote experience
- Added a much fuller Fire TV control surface
- Fixed the D-pad interaction model by moving away from the buggy overlapping layout
- Added missing Fire TV controls including power, menu, volume, mute, playback, and transport keys
- Updated button styling and polish, including improved button fills and stronger Select styling
- Fixed connection-bar visual issues such as mismatched button radius

### Text sending workflow

- Added an explicit text composer with a dedicated `Send Text` button
- Ensured text is only sent when the button is pressed, not while typing
- Added clear UI feedback for ready, sending, and error states
- Added a dedicated `Backspace` action mapped to Fire TV rewind (`keyevent 89`)
- Updated backend text sending to use device-targeted `adb -s HOST shell input text ...`

### Dynamic Quick Launch

- Removed the old hardcoded quick-launch mapping model
- Added backend app discovery via `GET /api/apps?host=HOST`
- Built a dynamic quick-launch grid from installed package names
- Added an edit mode with a searchable installed-app grid
- Allowed users to pin and unpin their own launcher apps
- Persisted pinned app selections locally
- Kept app launches package-driven and compatible with sideloaded apps
- Preserved LEANBACK launcher handling for Fire TV-specific packages such as Prime Video

### Backend improvements

- Added host-targeted ADB execution across remote, text, swipe, and app-launch actions
- Added persistent saved-device CRUD endpoints
- Added installed-app discovery endpoint
- Improved ADB resolution for packaged-app environments by checking common absolute binary locations
- Improved static asset delivery so frontend changes are not masked by stale cached files

### Packaging and distribution

- Added a real macOS `.app` build
- Added a DMG build flow that recreates `dist/` from scratch on every package run
- Ensured rebuilds replace the previous packaged output instead of accumulating stale DMGs

### Documentation

- Rewrote the README to match the current app architecture and workflows
- Documented desktop dev mode, DMG packaging, persistence behavior, installed-app discovery, and troubleshooting

## Backend/API Changes

### Added

- `GET /api/devices`
- `POST /api/devices`
- `PUT /api/devices/:id`
- `DELETE /api/devices/:id`
- `GET /api/apps?host=HOST`

### Updated

- `POST /api/connect`
- `POST /api/disconnect`
- `POST /api/key`
- `POST /api/text`
- `POST /api/swipe`
- `POST /api/app`

These routes are now consistently host-targeted, and app launching is package-based rather than relying on frontend-defined app IDs.

## User-Facing Impact

### Before

- Browser-only experience
- Hardcoded app launch buttons
- More limited remote layout
- Less polished connection flow
- No desktop packaging
- No persistent saved-device manager in the current app model

### After

- Native-feeling desktop app workflow
- Full remote layout with more complete control coverage
- Dynamic Quick Launch based on real installed apps
- Saved devices with persistence and management UI
- Explicit text sending with backspace support
- DMG packaging for drag-to-Applications installs

## Breaking / Behavioral Changes

- The primary recommended workflow is now the Electron desktop app rather than using the app only through a browser tab
- Quick Launch is no longer defined by a hardcoded frontend app list
- Saved devices now persist in application data instead of being managed through the old browser-oriented config flow
- Packaged builds are unsigned, so first-launch behavior on macOS may still require `Right click -> Open`

## Testing

### Verified during development

- `node --check server/index.js`
- `node --check public/main.js`
- `node --check electron/main.js`
- `node --check electron/open-built-app.js`
- `npm run desktop`
- `npm run desktop:package`

### Smoke-tested behaviors

- Live `/api/apps` app discovery against a connected Fire TV
- Dynamic Quick Launch package population
- Electron desktop shell startup
- Packaged macOS app metadata and icon wiring
- Fresh DMG rebuild behavior

## Notes for Reviewers

- The scope is intentionally broad because this is a product-level shift from the old browser remote into a desktop application
- The ADB command model remains the backbone of the app, but the UI, persistence, and desktop runtime layers have been significantly expanded
- The packaged app is designed so user data survives rebuilds and reinstallations
