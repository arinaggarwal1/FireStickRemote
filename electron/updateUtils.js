import { createHash } from "node:crypto";
import { load as parseYaml } from "js-yaml";

export const UPDATE_REPOSITORY = "arinaggarwal1/FireStickRemote";
export const UPDATE_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const UPDATE_RELEASE_PAGE = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
export const MAX_UPDATE_SIZE = 1024 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 256 * 1024;
const GITHUB_ASSET_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com"]);

export function parseStableVersion(value) {
  const match = String(value || "").match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new TypeError("Expected stable x.y.z version strings.");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function isTrustedUpdateSession({ senderMatchesWindow, senderUrl, appUrl }) {
  if (!senderMatchesWindow || !senderUrl || !appUrl) return false;
  try {
    const sender = new URL(senderUrl);
    const app = new URL(appUrl);
    return sender.origin === app.origin && sender.pathname === app.pathname && !sender.search;
  }
  catch { return false; }
}

function unavailable(message, currentVersion, latestVersion = null) {
  return {
    status: "unavailable",
    currentVersion,
    availableVersion: latestVersion,
    message,
    releaseUrl: UPDATE_RELEASE_PAGE,
    asset: null,
  };
}

function expectedAssetUrl(asset, tag, assetName) {
  if (!asset || asset.name !== assetName || typeof asset.browser_download_url !== "string") return false;
  let url;
  try { url = new URL(asset.browser_download_url); } catch { return false; }
  const expectedPath = `/${UPDATE_REPOSITORY}/releases/download/${tag}/${assetName}`;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  return url.protocol === "https:" && url.hostname === "github.com" && pathname === expectedPath;
}

function verifyAssetMetadata(asset, tag, name, maxSize) {
  if (!expectedAssetUrl(asset, tag, name)) throw new Error(`The release asset ${name} is missing or hosted outside the configured GitHub repository.`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxSize) {
    throw new Error(`The release asset ${name} has an unsupported size.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) {
    throw new Error(`The release asset ${name} has no trusted GitHub SHA-256 digest.`);
  }
  return asset;
}

function manifestFileUrlMatches(fileUrl, tag, assetName) {
  if (typeof fileUrl !== "string" || !fileUrl) return false;
  if (!fileUrl.includes("://")) {
    try { return decodeURIComponent(fileUrl.replace(/^\.\//, "")) === assetName; } catch { return false; }
  }
  try {
    const url = new URL(fileUrl);
    const path = decodeURIComponent(url.pathname);
    return url.protocol === "https:" && url.hostname === "github.com"
      && path === `/${UPDATE_REPOSITORY}/releases/download/${tag}/${assetName}`;
  } catch { return false; }
}

export function validateUpdateManifest(manifest, { version, tag, archiveAsset }) {
  if (!manifest || parseStableVersion(manifest.version)?.join(".") !== version) {
    throw new Error("The update manifest version does not match the GitHub release.");
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const file = files.find((entry) => manifestFileUrlMatches(entry?.url, tag, archiveAsset.name));
  if (!file || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 || "")) {
    throw new Error("The update manifest does not contain a valid checksum for this Mac’s update archive.");
  }
  if (file.size !== archiveAsset.size) {
    throw new Error("The update archive size does not match the trusted GitHub release metadata.");
  }
  return { sha512: file.sha512, size: file.size, name: archiveAsset.name };
}

export function validateUpdaterInfo(updateInfo, validatedRelease) {
  const expectedVersion = validatedRelease.availableVersion || validatedRelease.version;
  if (!updateInfo || parseStableVersion(updateInfo.version)?.join(".") !== expectedVersion
      || compareStableVersions(updateInfo.version, validatedRelease.currentVersion) <= 0) {
    throw new Error("The updater feed returned a version that does not match the verified stable release.");
  }
  const files = Array.isArray(updateInfo.files) ? updateInfo.files : [];
  const file = files.find((entry) => {
    if (typeof entry?.url !== "string") return false;
    try {
      const url = new URL(entry.url, validatedRelease.asset.browser_download_url);
      return GITHUB_ASSET_HOSTS.has(url.hostname)
        && decodeURIComponent(url.pathname.split("/").pop() || "") === validatedRelease.asset.name;
    } catch { return false; }
  });
  if (!file || file.sha512 !== validatedRelease.manifest.sha512 || file.size !== validatedRelease.asset.size) {
    throw new Error("The updater feed’s archive URL, size, or checksum did not match the verified release.");
  }
  return file;
}

async function fetchBytes(fetchImpl, url, maxBytes) {
  const response = await fetchImpl(url, { headers: { Accept: "application/octet-stream", "User-Agent": "FireTVRemote-Updater" } });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} while verifying update metadata.`);
  const finalUrl = new URL(response.url || url);
  if (response.url && !GITHUB_ASSET_HOSTS.has(finalUrl.hostname)) throw new Error("GitHub redirected update metadata to an untrusted host.");
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("The update metadata exceeds the supported size.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("The update metadata exceeds the supported size.");
  return bytes;
}

export async function inspectLatestRelease({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  maxUpdateSize = MAX_UPDATE_SIZE,
} = {}) {
  if (!parseStableVersion(currentVersion)) throw new TypeError("The installed app version is not a stable x.y.z version.");
  if (platform !== "darwin") return unavailable("In-app updates are currently supported only for macOS.", currentVersion);
  if (!["arm64", "x64"].includes(arch)) return unavailable("This Mac processor is not supported by the current update release.", currentVersion);

  const response = await fetchImpl(UPDATE_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "FireTVRemote-Updater" },
  });
  if (response.status === 404) return unavailable("No stable desktop release is published yet.", currentVersion);
  if (response.status === 403 || response.status === 429) throw new Error("GitHub is limiting update checks. Please try again later.");
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} while checking for updates.`);
  const release = await response.json();
  if (release?.draft || release?.prerelease) return unavailable("No stable desktop release is published yet.", currentVersion);

  const tag = String(release?.tag_name || "");
  const parsedVersion = parseStableVersion(tag);
  if (!parsedVersion) return unavailable("The latest GitHub release does not use a supported stable x.y.z version.", currentVersion);
  const version = parsedVersion.join(".");
  const ordering = compareStableVersions(version, currentVersion);
  if (ordering <= 0) {
    const message = ordering === 0
      ? `You’re up to date (v${currentVersion}).`
      : `This build (v${currentVersion}) is newer than the latest stable release (v${version}).`;
    return { status: "current", currentVersion, availableVersion: null, latestVersion: version, message, releaseUrl: UPDATE_RELEASE_PAGE, asset: null };
  }

  const archiveName = `Fire-TV-Remote-${version}-${arch}-mac.zip`;
  const dmgName = `Fire-TV-Remote-${version}-${arch}.dmg`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archiveAsset = verifyAssetMetadata(assets.find((asset) => asset.name === archiveName), tag, archiveName, maxUpdateSize);
  verifyAssetMetadata(assets.find((asset) => asset.name === dmgName), tag, dmgName, maxUpdateSize);
  const metadataAsset = verifyAssetMetadata(assets.find((asset) => asset.name === "latest-mac.yml"), tag, "latest-mac.yml", MAX_MANIFEST_SIZE);

  const metadataBytes = await fetchBytes(fetchImpl, metadataAsset.browser_download_url, MAX_MANIFEST_SIZE);
  const actualManifestDigest = createHash("sha256").update(metadataBytes).digest("hex");
  if (metadataAsset.digest !== `sha256:${actualManifestDigest}`) throw new Error("The update manifest failed GitHub SHA-256 verification.");

  let manifest;
  try { manifest = parseYaml(new TextDecoder().decode(metadataBytes)); }
  catch { throw new Error("The GitHub update manifest is malformed."); }
  const validatedManifest = validateUpdateManifest(manifest, { version, tag, archiveAsset });

  return {
    status: "available",
    currentVersion,
    availableVersion: version,
    latestVersion: version,
    message: `Version ${version} is available.`,
    releaseUrl: UPDATE_RELEASE_PAGE,
    asset: archiveAsset,
    manifest: validatedManifest,
    tag,
  };
}
