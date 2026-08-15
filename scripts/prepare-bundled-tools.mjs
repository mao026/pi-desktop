#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimeCatalog } from "../src/shared/toolchains/catalog-schema.ts";
import { findComponentEntrypoint } from "../src/main/toolchains/component-entrypoint.ts";
import { downloadRuntimeArtifact, hashFile, verifyDownloadedArtifact } from "../src/main/toolchains/downloader.ts";
import { extractRuntimeArchive } from "../src/main/toolchains/secure-extractor.ts";
import { darwinCodeDigest } from "../src/main/toolchains/darwin-binary-integrity.ts";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "build", "toolchains", "core-catalog.json");
const browserCatalogPath = path.join(root, "config", "test-browser-assets.json");
const androidCatalogPath = path.join(root, "config", "test-android-assets.json");
const browserPatchRoot = path.join(root, "config", "chrome-extension-patch");
const lockfilePath = path.join(root, "package-lock.json");
const outputRoot = path.join(root, "build", "toolchains", "core");
const nativeOutputRoot = path.join(root, "build", "toolchains", "native");
const browserOutputRoot = path.join(root, "build", "test-browser");
const extensionOutputRoot = path.join(root, "build", "chrome-extension");
const androidOutputRoot = path.join(root, "build", "test-android");
const cacheRoot = path.join(root, "build", "toolchains", ".core-cache");
const browserCacheRoot = path.join(root, "build", ".test-browser-cache");
const androidCacheRoot = path.join(root, "build", ".test-android-cache");
const clipboardPackage = "@mariozechner/clipboard-win32-x64-msvc";
const clipboardLockKey = `node_modules/@earendil-works/pi-coding-agent/node_modules/${clipboardPackage}`;
const releasedTargets = new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
const licenseFiles = {
  ripgrep: [
    {
      name: "ripgrep-LICENSE-MIT",
      url: "https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/LICENSE-MIT",
      bytes: 1081,
      sha256: "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    },
    {
      name: "ripgrep-UNLICENSE",
      url: "https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/UNLICENSE",
      bytes: 1211,
      sha256: "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
    },
  ],
  fd: [
    {
      name: "fd-LICENSE-MIT",
      url: "https://raw.githubusercontent.com/sharkdp/fd/v10.3.0/LICENSE-MIT",
      bytes: 1082,
      sha256: "322cfc7aa0c774d0eca3b2610f1d414de3ddbd7d8dd4b9dea941a13a6eb07455",
    },
    {
      name: "fd-LICENSE-APACHE",
      url: "https://raw.githubusercontent.com/sharkdp/fd/v10.3.0/LICENSE-APACHE",
      bytes: 10838,
      sha256: "73c83c60d817e7df1943cb3f0af81e4939a8352c9a96c2fd00451b1116fa635c",
    },
  ],
};

function fail(message) {
  throw new Error(`[bundled-tools] ${message}`);
}

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) fail(`${label} changed upstream`);
  return source.replace(before, after);
}

function parseTargets(argv) {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const target = argv[index + 1];
      if (!target) fail("--target requires platform-arch");
      targets.push(target);
      index += 1;
    } else if (argument === "--all") {
      targets.push(...releasedTargets);
    } else if (argument === "--release") {
      targets.push(...(process.platform === "darwin" ? ["darwin-arm64", "darwin-x64"] : [`${process.platform}-x64`]));
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (targets.length === 0) targets.push(`${process.platform}-${process.arch}`);
  const unique = [...new Set(targets)];
  for (const target of unique) {
    if (!releasedTargets.has(target)) fail(`unsupported release target: ${target}`);
  }
  return unique;
}

async function downloadFixedFile(definition, destination) {
  try {
    const existing = await hashFile(destination);
    if (existing.bytes === definition.bytes && existing.sha256 === definition.sha256) return;
  } catch {
    // Missing or stale cache entries are replaced below.
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await globalThis.fetch(definition.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Pi-Agent-Desktop-Bundled-Tools-Build" },
    });
    if (!response.ok) fail(`${definition.url} returned HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.length !== definition.bytes || digest !== definition.sha256) {
      fail(`${definition.name} failed fixed license verification`);
    }
    const temporary = `${destination}.${randomUUID()}.partial`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    clearTimeout(timer);
  }
}

function walkRegularFiles(directory, rootDirectory = directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`unexpected symlink in browser assets: ${entryPath}`);
      if (entry.isDirectory()) return walkRegularFiles(entryPath, rootDirectory);
      if (!entry.isFile()) fail(`unexpected browser asset: ${entryPath}`);
      return [{ absolute: entryPath, relative: path.relative(rootDirectory, entryPath).split(path.sep).join("/") }];
    });
}

async function prepareBrowserAssets(browserCatalog, targets) {
  if (
    browserCatalog.schemaVersion !== 1 ||
    browserCatalog.cliVersion !== "0.3.7" ||
    browserCatalog.extensionVersion !== "2.1" ||
    !/^2\.1-pi-test\.\d+$/.test(browserCatalog.productExtensionVersion) ||
    !/^[a-f0-9]{40}$/.test(browserCatalog.sourceCommit) ||
    !Array.isArray(browserCatalog.variants)
  ) {
    fail("invalid fixed test browser asset catalog");
  }
  fs.mkdirSync(browserCacheRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(browserOutputRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(extensionOutputRoot), { recursive: true, mode: 0o755 });

  const baseArchive = path.join(browserCacheRoot, `agent-browser-cli-${browserCatalog.cliVersion}.tgz`);
  await downloadFixedFile({ ...browserCatalog.basePackage, name: browserCatalog.basePackage.name }, baseArchive);
  const baseExtraction = fs.mkdtempSync(path.join(browserCacheRoot, "base-extract-"));
  const extensionStaging = fs.mkdtempSync(path.join(path.dirname(extensionOutputRoot), ".chrome-extension-staging-"));
  try {
    await extractRuntimeArchive(baseArchive, baseExtraction, "tar.gz", { maxExtractedBytes: 4 * 1024 * 1024 });
    const packageRoot = path.join(baseExtraction, "package");
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== browserCatalog.basePackage.name || metadata.version !== browserCatalog.cliVersion) {
      fail("agent-browser-cli base package metadata mismatch");
    }
    const upstreamExtension = path.join(packageRoot, "assets", "tmwd_cdp_bridge");
    const extensionRoot = path.join(extensionStaging, "tmwd_cdp_bridge");
    fs.cpSync(upstreamExtension, extensionRoot, { recursive: true, errorOnExist: true, force: false });
    fs.copyFileSync(path.join(browserPatchRoot, "popup.js"), path.join(extensionRoot, "popup.js"));
    fs.copyFileSync(path.join(browserPatchRoot, "popup.html"), path.join(extensionRoot, "popup.html"));

    const manifestPath = path.join(extensionRoot, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== browserCatalog.extensionVersion) fail("Chrome extension version mismatch");
    manifest.version_name = browserCatalog.productExtensionVersion;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const backgroundPath = path.join(extensionRoot, "background.js");
    let background = fs.readFileSync(backgroundPath, "utf8");
    background = replaceOnce(
      background,
      "const extensionVersion = chrome.runtime.getManifest().version;",
      "const extensionVersion = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;",
      "Chrome extension version marker",
    );
    background = replaceOnce(
      background,
      "let ws = null;\n\nfunction normalizePort",
      `let ws = null;

function sendWs(message) {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(message);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizePort`,
      "Chrome extension WebSocket state",
    );
    const rawSendCount = background.split("ws.send(").length - 1;
    if (rawSendCount !== 10) fail("Chrome extension WebSocket send sites changed upstream");
    background = background.replaceAll("ws.send(", "sendWs(");
    fs.writeFileSync(backgroundPath, background);
    const popupSource = `${fs.readFileSync(path.join(extensionRoot, "popup.js"), "utf8")}\n${fs.readFileSync(path.join(extensionRoot, "popup.html"), "utf8")}`;
    if (/cookie|clipboard/i.test(popupSource)) fail("patched Chrome popup must not expose cookies or clipboard access");

    const files = [];
    for (const file of walkRegularFiles(extensionRoot)) {
      const digest = await hashFile(file.absolute);
      files.push({ path: file.relative, sha256: digest.sha256, bytes: digest.bytes });
    }
    fs.writeFileSync(
      path.join(extensionStaging, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          extensionVersion: browserCatalog.extensionVersion,
          productExtensionVersion: browserCatalog.productExtensionVersion,
          sourceCommit: browserCatalog.sourceCommit,
          files,
        },
        null,
        2,
      )}\n`,
    );
    fs.rmSync(extensionOutputRoot, { recursive: true, force: true });
    fs.renameSync(extensionStaging, extensionOutputRoot);
  } finally {
    fs.rmSync(baseExtraction, { recursive: true, force: true });
    fs.rmSync(extensionStaging, { recursive: true, force: true });
  }

  for (const target of targets) {
    const separator = target.lastIndexOf("-");
    const platform = target.slice(0, separator);
    const arch = target.slice(separator + 1);
    const variant = browserCatalog.variants.find((item) => item.platform === platform && item.arch === arch);
    if (!variant) fail(`${target} is missing an agent-browser-cli variant`);
    const archive = path.join(browserCacheRoot, `agent-browser-cli-${browserCatalog.cliVersion}-${target}.tgz`);
    await downloadFixedFile({ ...variant, name: variant.packageName }, archive);
    const extraction = fs.mkdtempSync(path.join(browserCacheRoot, `${target}-extract-`));
    const staging = fs.mkdtempSync(path.join(browserOutputRoot, `.${target}-staging-`));
    try {
      await extractRuntimeArchive(archive, extraction, "tar.gz", { maxExtractedBytes: 32 * 1024 * 1024 });
      const packageRoot = path.join(extraction, "package");
      const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      if (metadata.name !== variant.packageName || metadata.version !== browserCatalog.cliVersion) {
        fail(`${target} agent-browser-cli package metadata mismatch`);
      }
      const executable = path.join(staging, variant.executable);
      fs.copyFileSync(path.join(packageRoot, "bin", variant.executable), executable, fs.constants.COPYFILE_EXCL);
      if (platform !== "win32") fs.chmodSync(executable, 0o755);
      const digest = await hashFile(executable);
      const darwinCode = platform === "darwin" ? darwinCodeDigest(fs.readFileSync(executable)) : undefined;
      if (platform === "darwin" && !darwinCode)
        fail(`${target} agent-browser-cli is not a supported Mach-O executable`);
      fs.writeFileSync(
        path.join(staging, "manifest.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            cliVersion: browserCatalog.cliVersion,
            platform,
            arch,
            executable: variant.executable,
            sha256: digest.sha256,
            bytes: digest.bytes,
            ...(darwinCode ? { darwinCodeSha256: darwinCode.sha256, darwinCodeBytes: darwinCode.bytes } : {}),
            sourcePackage: variant.packageName,
            sourceArchiveSha256: variant.sha256,
          },
          null,
          2,
        )}\n`,
      );
      const destination = path.join(browserOutputRoot, target);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(staging, destination);
      console.log(`[bundled-tools] prepared agent-browser-cli@${browserCatalog.cliVersion} for ${target}`);
    } finally {
      fs.rmSync(extraction, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  console.log(`[bundled-tools] prepared Chrome extension ${browserCatalog.productExtensionVersion}`);
}

async function prepareWindowsHandsets(androidCatalog, targets) {
  if (!targets.includes("win32-x64")) return;
  if (
    androidCatalog.schemaVersion !== 1 ||
    androidCatalog.handsets?.version !== "0.1.38" ||
    !/^[a-f0-9]{40}$/.test(androidCatalog.handsets.sourceCommit) ||
    androidCatalog.platformTools?.version !== "37.0.1"
  ) {
    fail("invalid fixed Android asset catalog");
  }
  fs.mkdirSync(androidCacheRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(androidOutputRoot, { recursive: true, mode: 0o755 });
  const definition = {
    ...androidCatalog.handsets.windowsX64,
    name: `handsets-${androidCatalog.handsets.version}-windows-x64`,
  };
  const archive = path.join(androidCacheRoot, `handsets-${androidCatalog.handsets.version}-windows-x64.zip`);
  await downloadFixedFile(definition, archive);

  const expected = new Set(["hs.exe", "hs.jar", "LICENSE", "VERSION"]);
  const staging = fs.mkdtempSync(path.join(androidOutputRoot, ".win32-x64-staging-"));
  const zip = await yauzl.openPromise(archive, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false,
  });
  try {
    for await (const entry of zip.eachEntry()) {
      const parts = entry.fileName.split(/[\\/]/);
      if (parts.length !== 2 || parts[0] !== "handsets" || !expected.has(parts[1])) continue;
      if (entry.isEncrypted() || !entry.canDecodeFileData() || entry.uncompressedSize > 2 * 1024 * 1024) {
        fail(`unsafe Handsets archive entry: ${entry.fileName}`);
      }
      const destination = path.join(staging, parts[1]);
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(
        stream,
        fs.createWriteStream(destination, { flags: "wx", mode: parts[1].endsWith(".exe") ? 0o755 : 0o644 }),
      );
      expected.delete(parts[1]);
    }
  } finally {
    zip.close();
  }
  if (expected.size > 0) fail(`Handsets archive is missing: ${[...expected].join(", ")}`);
  if (fs.readFileSync(path.join(staging, "VERSION"), "utf8").trim() !== `v${androidCatalog.handsets.version}`) {
    fail("Handsets VERSION does not match the fixed catalog");
  }
  const files = [];
  for (const file of walkRegularFiles(staging)) {
    const digest = await hashFile(file.absolute);
    files.push({ path: file.relative, sha256: digest.sha256, bytes: digest.bytes });
  }
  fs.writeFileSync(
    path.join(staging, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        platform: "win32",
        arch: "x64",
        handsetsVersion: androidCatalog.handsets.version,
        sourceCommit: androidCatalog.handsets.sourceCommit,
        sourceArchiveSha256: definition.sha256,
        platformTools: androidCatalog.platformTools,
        files,
      },
      null,
      2,
    )}\n`,
  );
  const destination = path.join(androidOutputRoot, "win32-x64");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(staging, destination);
  console.log(`[bundled-tools] prepared Handsets@${androidCatalog.handsets.version} for win32-x64`);
}

async function prepareWindowsClipboard(lockfile) {
  const locked = lockfile.packages?.[clipboardLockKey];
  if (
    locked?.version !== "0.3.9" ||
    typeof locked.resolved !== "string" ||
    !locked.resolved.startsWith("https://registry.npmjs.org/") ||
    typeof locked.integrity !== "string" ||
    !locked.integrity.startsWith("sha512-")
  ) {
    fail(`missing fixed ${clipboardPackage}@0.3.9 lockfile entry`);
  }

  const archive = path.join(cacheRoot, `${clipboardPackage.split("/").pop()}-${locked.version}.tgz`);
  let valid = false;
  try {
    const digest = createHash("sha512").update(fs.readFileSync(archive)).digest("base64");
    valid = `sha512-${digest}` === locked.integrity;
  } catch {
    // Missing or stale cache entries are replaced below.
  }
  if (!valid) {
    const response = await globalThis.fetch(locked.resolved, {
      headers: { "User-Agent": "Pi-Agent-Desktop-Bundled-Tools-Build" },
    });
    if (!response.ok) fail(`${locked.resolved} returned HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`;
    if (integrity !== locked.integrity) fail(`${clipboardPackage} failed lockfile integrity verification`);
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    const temporary = `${archive}.${randomUUID()}.partial`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.rmSync(archive, { force: true });
    fs.renameSync(temporary, archive);
  }

  const extractionRoot = fs.mkdtempSync(path.join(cacheRoot, "clipboard-extract-"));
  const destination = path.join(nativeOutputRoot, "win32-x64", clipboardPackage);
  fs.mkdirSync(nativeOutputRoot, { recursive: true, mode: 0o755 });
  const staging = fs.mkdtempSync(path.join(nativeOutputRoot, ".win32-x64-staging-"));
  try {
    await extractRuntimeArchive(archive, extractionRoot, "tar.gz", { maxExtractedBytes: 4 * 1024 * 1024 });
    const packageRoot = path.join(extractionRoot, "package");
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== clipboardPackage || metadata.version !== locked.version) {
      fail(`${clipboardPackage} archive metadata mismatch`);
    }
    fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(staging, "package.json"));
    fs.copyFileSync(
      path.join(packageRoot, "clipboard.win32-x64-msvc.node"),
      path.join(staging, "clipboard.win32-x64-msvc.node"),
    );
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.renameSync(staging, destination);
    console.log(`[bundled-tools] prepared ${clipboardPackage}@${locked.version} for win32-x64`);
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function prepareTarget(catalog, target) {
  const separator = target.lastIndexOf("-");
  const platform = target.slice(0, separator);
  const arch = target.slice(separator + 1);
  const selected = catalog.components.map((component) => ({
    component,
    variant: component.variants.find((variant) => variant.platform === platform && variant.arch === arch),
  }));
  if (selected.some(({ variant }) => !variant)) fail(`${target} is missing a core tool variant`);

  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(outputRoot, `.${target}-staging-`));
  const extractionRoots = [];
  try {
    fs.mkdirSync(path.join(staging, "manifests"), { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(staging, "licenses"), { recursive: true, mode: 0o755 });
    const tools = [];
    const licenses = [];
    for (const { component, variant } of selected) {
      const artifact = path.join(cacheRoot, `${component.id}-${component.version}-${target}.artifact`);
      if (!(await verifyDownloadedArtifact(artifact, variant))) {
        console.log(`[bundled-tools] downloading ${component.id}@${component.version} for ${target}`);
        await downloadRuntimeArtifact(component.id, variant, artifact);
      }
      if (!(await verifyDownloadedArtifact(artifact, variant))) fail(`${component.id} artifact verification failed`);

      const extractionRoot = fs.mkdtempSync(path.join(cacheRoot, `${component.id}-extract-`));
      extractionRoots.push(extractionRoot);
      await extractRuntimeArchive(artifact, extractionRoot, variant.archive, {
        maxExtractedBytes: 128 * 1024 * 1024,
      });
      const source = findComponentEntrypoint(component.id, extractionRoot).executable;
      const executableName = `${component.id === "ripgrep" ? "rg" : "fd"}${platform === "win32" ? ".exe" : ""}`;
      const destination = path.join(staging, executableName);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      if (platform !== "win32") fs.chmodSync(destination, 0o755);
      const binary = await hashFile(destination);
      const darwinCode = platform === "darwin" ? darwinCodeDigest(fs.readFileSync(destination)) : undefined;
      if (platform === "darwin" && !darwinCode) fail(`${component.id} is not a supported Mach-O executable`);

      const componentLicenses = licenseFiles[component.id];
      if (!componentLicenses) fail(`missing license definition for ${component.id}`);
      for (const license of componentLicenses) {
        const cachedLicense = path.join(cacheRoot, "licenses", license.name);
        await downloadFixedFile(license, cachedLicense);
        fs.copyFileSync(cachedLicense, path.join(staging, "licenses", license.name), fs.constants.COPYFILE_EXCL);
        licenses.push({
          componentId: component.id,
          path: `licenses/${license.name}`,
          sourceUrl: license.url,
          sha256: license.sha256,
        });
      }
      tools.push({
        componentId: component.id,
        capability: component.provides[0],
        version: component.version,
        executable: executableName,
        sha256: binary.sha256,
        bytes: binary.bytes,
        ...(darwinCode ? { darwinCodeSha256: darwinCode.sha256, darwinCodeBytes: darwinCode.bytes } : {}),
        artifactSha256: variant.sha256,
      });
    }
    const manifest = {
      schemaVersion: 1,
      catalogRevision: catalog.revision,
      platform,
      arch,
      tools,
      licenses,
    };
    fs.writeFileSync(path.join(staging, "manifests", "core-tools.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const destination = path.join(outputRoot, target);
    const previous = `${destination}.previous-${randomUUID()}`;
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try {
      fs.renameSync(staging, destination);
      fs.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    console.log(
      `[bundled-tools] prepared ${target}: ${tools.map((tool) => `${tool.componentId}@${tool.version}`).join(", ")}`,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const extractionRoot of extractionRoots) fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

const catalog = parseRuntimeCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
const browserCatalog = JSON.parse(fs.readFileSync(browserCatalogPath, "utf8"));
const androidCatalog = JSON.parse(fs.readFileSync(androidCatalogPath, "utf8"));
const targets = parseTargets(process.argv.slice(2));
for (const target of targets) await prepareTarget(catalog, target);
await prepareBrowserAssets(browserCatalog, targets);
await prepareWindowsHandsets(androidCatalog, targets);
if (targets.includes("win32-x64")) {
  await prepareWindowsClipboard(JSON.parse(fs.readFileSync(lockfilePath, "utf8")));
}
