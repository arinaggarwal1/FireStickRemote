import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compareStableVersions,
  inspectLatestRelease,
  isTrustedUpdateSession,
  parseStableVersion,
  UPDATE_RELEASE_API,
  validateUpdaterInfo,
  validateUpdateManifest,
} from "./updateUtils.js";

const validSha512 = `${"A".repeat(86)}==`;
const sha256 = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const archiveName = "Fire-TV-Remote-1.0.10-arm64-mac.zip";
const dmgName = "Fire-TV-Remote-1.0.10-arm64.dmg";
const tag = "v1.0.10";
const githubAsset = name => `https://github.com/arinaggarwal1/FireStickRemote/releases/download/${tag}/${name}`;

function manifestText(overrides = {}) {
  return `version: ${overrides.version || "1.0.10"}\nfiles:\n  - url: ${overrides.url || archiveName}\n    sha512: ${overrides.sha512 || validSha512}\n    size: ${overrides.size ?? 1200}\n`;
}

function makeRelease({ overrides = {}, manifestOverrides = {} } = {}) {
  const text = manifestText(manifestOverrides);
  const manifestBytes = new TextEncoder().encode(text);
  const assets = [
    { name: archiveName, size: 1200, digest: sha256("archive"), browser_download_url: githubAsset(archiveName) },
    { name: dmgName, size: 1600, digest: sha256("dmg"), browser_download_url: githubAsset(dmgName) },
    { name: "latest-mac.yml", size: manifestBytes.byteLength, digest: sha256(manifestBytes), browser_download_url: githubAsset("latest-mac.yml") },
  ];
  return {
    release: { tag_name: tag, draft: false, prerelease: false, assets, ...overrides },
    manifestBytes,
  };
}

function fakeFetch(release, manifestBytes) {
  return async url => {
    if (url === UPDATE_RELEASE_API) return { ok: true, status: 200, json: async () => release };
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => String(manifestBytes.byteLength) },
      arrayBuffer: async () => manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength),
    };
  };
}

test("stable versions compare numerically and reject prereleases or malformed tags", () => {
  assert.deepEqual(parseStableVersion("v1.0.10"), [1, 0, 10]);
  assert.equal(parseStableVersion("1.0.1-beta.1"), null);
  assert.equal(parseStableVersion("Arin-1.0"), null);
  assert.equal(compareStableVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareStableVersions("1.2.0", "1.2.0"), 0);
});

test("release checks reject prereleases and never offer a downgrade", async () => {
  const prerelease = await inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v2.0.0-beta.1", prerelease: true }) }) });
  assert.equal(prerelease.status, "unavailable");

  const older = await inspectLatestRelease({ currentVersion: "1.0.10", platform: "darwin", arch: "arm64", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v1.0.9", assets: [] }) }) });
  assert.equal(older.status, "current");
  assert.match(older.message, /newer than the latest stable release/);
});

test("release check reports the current platform as unsupported when it has no installer", async () => {
  const result = await inspectLatestRelease({ currentVersion: "1.0.0", platform: "win32", arch: "x64", fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /only for macOS/);
});

test("release verification requires the exact repository URL, digest, size, and manifest checksum", async () => {
  const { release, manifestBytes } = makeRelease();
  const result = await inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(release, manifestBytes) });
  assert.equal(result.status, "available");
  assert.equal(result.availableVersion, "1.0.10");
  assert.equal(result.manifest.sha512, validSha512);

  const untrusted = makeRelease({ overrides: { assets: makeRelease().release.assets.map(asset => asset.name === archiveName
    ? { ...asset, browser_download_url: "https://evil.example/update.zip" }
    : asset) } });
  await assert.rejects(inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(untrusted.release, untrusted.manifestBytes) }), /hosted outside/);

  const badDigest = makeRelease({ overrides: { assets: makeRelease().release.assets.map(asset => asset.name === archiveName ? { ...asset, digest: "" } : asset) } });
  await assert.rejects(inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(badDigest.release, badDigest.manifestBytes) }), /no trusted GitHub SHA-256 digest/);
});

test("release verification rejects missing platform assets, invalid manifest checksums, and oversized downloads", async () => {
  const missingAsset = makeRelease({ overrides: { assets: [{ name: "latest-mac.yml", size: 1, digest: sha256("x"), browser_download_url: githubAsset("latest-mac.yml") }] } });
  await assert.rejects(inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(missingAsset.release, missingAsset.manifestBytes) }), /missing or hosted/);

  const badManifest = makeRelease({ manifestOverrides: { sha512: "bad" } });
  await assert.rejects(inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(badManifest.release, badManifest.manifestBytes) }), /valid checksum/);

  const oversized = makeRelease({ overrides: { assets: makeRelease().release.assets.map(asset => asset.name === archiveName ? { ...asset, size: 1024 * 1024 * 1024 + 1 } : asset) } });
  await assert.rejects(inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(oversized.release, oversized.manifestBytes) }), /unsupported size/);
});

test("update manifest rejects mismatched versions, URLs, sizes, and missing checksum", () => {
  const archiveAsset = { name: archiveName, size: 1200 };
  assert.throws(() => validateUpdateManifest({ version: "2.0.0", files: [] }, { version: "1.0.10", tag, archiveAsset }), /version does not match/);
  assert.throws(() => validateUpdateManifest({ version: "1.0.10", files: [{ url: "https://evil.example/file.zip", sha512: validSha512, size: 1200 }] }, { version: "1.0.10", tag, archiveAsset }), /valid checksum/);
  assert.throws(() => validateUpdateManifest({ version: "1.0.10", files: [{ url: archiveName, sha512: validSha512, size: 1199 }] }, { version: "1.0.10", tag, archiveAsset }), /size does not match/);
});

test("the packaged updater feed must match the independently verified artifact", async () => {
  const { release, manifestBytes } = makeRelease();
  const verified = await inspectLatestRelease({ currentVersion: "1.0.0", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(release, manifestBytes) });
  const info = {
    version: "1.0.10",
    files: [{ url: archiveName, sha512: validSha512, size: 1200 }],
  };
  assert.equal(validateUpdaterInfo(info, verified).size, 1200);
  assert.throws(() => validateUpdaterInfo({ ...info, files: [{ ...info.files[0], sha512: "bad" }] }, verified), /URL, size, or checksum/);
  assert.throws(() => validateUpdaterInfo({ ...info, version: "1.0.9" }, verified), /does not match the verified stable release/);
});

test("update IPC is limited to the active app window and its local origin", () => {
  assert.equal(isTrustedUpdateSession({ senderMatchesWindow: true, senderUrl: "http://127.0.0.1:1234/", appUrl: "http://127.0.0.1:1234" }), true);
  assert.equal(isTrustedUpdateSession({ senderMatchesWindow: false, senderUrl: "http://127.0.0.1:1234/", appUrl: "http://127.0.0.1:1234" }), false);
  assert.equal(isTrustedUpdateSession({ senderMatchesWindow: true, senderUrl: "http://127.0.0.1:4321/", appUrl: "http://127.0.0.1:1234" }), false);
  assert.equal(isTrustedUpdateSession({ senderMatchesWindow: true, senderUrl: "http://127.0.0.1:1234/other", appUrl: "http://127.0.0.1:1234" }), false);
});
