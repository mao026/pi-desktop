#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainBundle = readFileSync(path.join(root, "out", "main", "main.js"), "utf8");
const builderConfig = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const deviceLicensePublic = JSON.parse(readFileSync(path.join(root, "config", "device-license-public.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const updaterVersion = packageJson.dependencies?.["electron-updater"];
const lockedUpdaterVersion = packageLock.packages?.["node_modules/electron-updater"]?.version;
const updaterDependencyIsValid =
  typeof updaterVersion === "string" &&
  /^\d+\.\d+\.\d+$/.test(updaterVersion) &&
  updaterVersion === lockedUpdaterVersion &&
  packageJson.devDependencies?.["electron-updater"] === undefined;
const requiredMarkers = [
  "electron-updater",
  "update:state",
  "desktop:update:check",
  "--validate-packaged-startup",
  "packaged-startup-check.json",
  "device-license-cache.json",
  "desktop:test:refresh-license",
  "desktop:test:copy-browser-extension-path",
  "2.1-pi-test.2",
  "agent-browser-cli",
  "test-android",
  "0.1.38",
  "37.0.1",
  "desktop:test:install-android-tools",
  "DEVICE_LICENSE_REQUIRED",
  "desktop-testing",
];
const missing = requiredMarkers.filter((marker) => !mainBundle.includes(marker));
const licenseTrustRootIsEmbedded =
  typeof deviceLicensePublic.baseUrl === "string" &&
  typeof deviceLicensePublic.publicKey === "string" &&
  mainBundle.includes(deviceLicensePublic.baseUrl) &&
  mainBundle.includes(deviceLicensePublic.publicKey);
const forbiddenMarkers = [
  "runSmokeHostChecks",
  "Smoke RPC timed out",
  "pi-desktop-smoke-",
  "PI_SMOKE_TEST",
  "dev-app-update.yml",
  "setFeedURL",
  "GH_TOKEN",
  "MAC_CSC_LINK",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "PI_TEST_LICENSE_BASE_URL",
  "PI_TEST_LICENSE_PUBLIC_KEY",
  "BEGIN PRIVATE KEY",
];
const found = forbiddenMarkers.filter((marker) => mainBundle.includes(marker));
const leakedCredentials = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
].filter((pattern) => pattern.test(mainBundle));
const requiredPackageExclusions = [
  '"!**/*.map"',
  '"!**/*.{md,markdown,ts,tsx}"',
  '"!**/*.d.{mts,cts}"',
  '"!node_modules/@earendil-works/pi-coding-agent/docs/**/*"',
  '"!node_modules/@earendil-works/pi-coding-agent/examples/**/*"',
];
const missingPackageExclusions = requiredPackageExclusions.filter((pattern) => !builderConfig.includes(pattern));
const requiredPiAuthoringAssetMarkers = [
  "from: node_modules/@earendil-works/pi-coding-agent",
  "to: node_modules/@earendil-works/pi-coding-agent",
  "- README.md",
  '- "docs/**/*"',
  '- "examples/**/*"',
  '- "dist/**/*.d.ts"',
  "from: node_modules/@earendil-works/pi-ai/dist",
  "to: node_modules/@earendil-works/pi-ai/dist",
  "from: node_modules/@earendil-works/pi-telemetry",
  "to: node_modules/@earendil-works/pi-telemetry",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol",
  "from: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry",
  "to: node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry",
  "- CHANGELOG.md",
  "- package.json",
  '- "dist/**/*.js"',
  '- "dist/**/*.json"',
  '- "**/*.d.ts"',
  '- "dist/**/*.d.ts"',
  '- "native/**/*"',
];
const missingPiAuthoringAssets = requiredPiAuthoringAssetMarkers.filter((marker) => !builderConfig.includes(marker));
const toolchainCatalogPackagingIsValid =
  builderConfig.includes("from: THIRD_PARTY_NOTICES.md") &&
  builderConfig.includes("to: THIRD_PARTY_NOTICES.md") &&
  builderConfig.includes("from: build/toolchains/runtime-catalog.json") &&
  builderConfig.includes("to: toolchains/runtime-catalog.json") &&
  builderConfig.includes("from: build/toolchains/core-catalog.json") &&
  builderConfig.includes("to: toolchains/core-catalog.json") &&
  builderConfig.includes("from: build/toolchains/core/darwin-${arch}") &&
  builderConfig.includes("to: toolchains/core/darwin-${arch}") &&
  builderConfig.includes("from: build/test-browser/darwin-${arch}") &&
  builderConfig.includes("to: test-browser/darwin-${arch}") &&
  builderConfig.includes("from: build/toolchains/core/win32-x64") &&
  builderConfig.includes("to: toolchains/core/win32-x64") &&
  builderConfig.includes("from: build/test-browser/win32-x64") &&
  builderConfig.includes("to: test-browser/win32-x64") &&
  builderConfig.includes("from: build/toolchains/core/linux-x64") &&
  builderConfig.includes("to: toolchains/core/linux-x64") &&
  builderConfig.includes("from: build/test-browser/linux-x64") &&
  builderConfig.includes("to: test-browser/linux-x64") &&
  !builderConfig.includes("from: build/toolchains/core/${platform}-${arch}") &&
  !builderConfig.includes("from: build/test-browser/${platform}-${arch}") &&
  builderConfig.includes("from: build/chrome-extension") &&
  builderConfig.includes("to: chrome-extension") &&
  builderConfig.includes("from: build/test-android/win32-x64") &&
  builderConfig.includes("to: test-android/win32-x64") &&
  !builderConfig.includes("from: build/test-android/${platform}-${arch}") &&
  builderConfig.includes("executableName: pi-agent-desktop") &&
  !/from:\s*build\/toolchains\/(?:archives|downloads|runtimes)/i.test(builderConfig);

if (
  !updaterDependencyIsValid ||
  !licenseTrustRootIsEmbedded ||
  !toolchainCatalogPackagingIsValid ||
  missing.length > 0 ||
  found.length > 0 ||
  leakedCredentials.length > 0 ||
  missingPackageExclusions.length > 0 ||
  missingPiAuthoringAssets.length > 0
) {
  if (!updaterDependencyIsValid) {
    console.error("FAIL: electron-updater must be an exact production dependency matching package-lock.json");
  }
  if (!licenseTrustRootIsEmbedded) {
    console.error("FAIL: production main bundle must embed the fixed device license origin and public key");
  }
  for (const marker of missing) console.error(`FAIL: production main bundle is missing updater marker: ${marker}`);
  for (const marker of found) console.error(`FAIL: production main bundle contains forbidden marker: ${marker}`);
  for (const pattern of leakedCredentials) {
    console.error(`FAIL: production main bundle contains a credential matching ${pattern}`);
  }
  for (const pattern of missingPackageExclusions) {
    console.error(`FAIL: electron-builder.yml is missing production exclusion: ${pattern}`);
  }
  for (const pattern of missingPiAuthoringAssets) {
    console.error(`FAIL: electron-builder.yml is missing Pi authoring asset: ${pattern}`);
  }
  if (!toolchainCatalogPackagingIsValid) {
    console.error(
      "FAIL: production packaging must include third-party notices, target-specific core/browser tools, the fixed Chrome extension, and Windows-only Handsets assets",
    );
  }
  process.exit(1);
}

console.log(
  `OK: electron-updater ${updaterVersion} is locked for production; the fixed device license trust root is embedded; main bundle contains ${requiredMarkers.length} product markers, excludes ${forbiddenMarkers.length} forbidden markers, packaging retains ${requiredPackageExclusions.length} source exclusions and explicit Pi authoring asset FileSets, and fixed target assets are packaged without managed runtime archives`,
);
