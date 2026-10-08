# Desktop app updates

The updater is available only in the packaged, Developer ID signed macOS app. The standalone server and `npm run desktop` development run can check GitHub for a release, but they cannot download or install it.

## Release source and verification

- The installed version comes from `package.json`; electron-builder copies that version into the app bundle and updater metadata.
- Stable releases use tags of the form `vX.Y.Z`. The tag must match `package.json` exactly. Drafts, prereleases, malformed tags, and downgrades are rejected.
- Releases are read from `arinaggarwal1/FireStickRemote` over HTTPS.
- macOS updates are limited to the matching `arm64` or `x64` ZIP archive. The matching DMG must also be published for first installs and recovery.
- The updater requires the GitHub release API SHA-256 digest for the DMG, ZIP, and `latest-mac.yml`. It verifies the downloaded update manifest against GitHub’s digest, checks the expected version, archive filename, size, and SHA-512, then electron-updater verifies the downloaded archive against the manifest checksum and macOS code signature.
- Downloads are limited to 1 GiB. The app stages the update first. It installs only after the user selects **Install and restart**.

## Publish a release

1. Bump `package.json` `version` to the next stable `X.Y.Z` value.
2. Commit the version and updater changes, then push a matching tag `vX.Y.Z`.
3. Add these GitHub Actions repository secrets before tagging:
   - `CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate.
   - `CSC_KEY_PASSWORD`: certificate password.
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`: credentials for notarizing the signed app.
4. The `Publish signed macOS release` workflow builds arm64 and x64 DMG and ZIP assets, plus electron-builder’s `latest-mac.yml`, and publishes the stable GitHub release.
5. Confirm all assets are present and the macOS app is signed and notarized before distributing the release.

The asset names are `Fire-TV-Remote-X.Y.Z-arm64.dmg`, `Fire-TV-Remote-X.Y.Z-arm64-mac.zip`, and the corresponding `x64` names, plus `latest-mac.yml`.

## First updater-capable installation

Previously distributed or development builds may be unsigned and do not contain the updater feed configuration. Install the first signed release from its DMG manually. After that, supported signed installations in a writable Applications folder can check, download, and install future stable updates in the app.

The repository’s existing `Arin-1.0` release does not use a stable `X.Y.Z` tag or contain updater metadata, so it is not considered an installable update. The first updater release must have a version greater than the installed app version.
