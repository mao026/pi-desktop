#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalizeLicensePayload } from "../src/main/device-license.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateKey = path.join(os.homedir(), ".pi-test-license-authority", "license-ed25519-private.pem");
const outputRoot = path.join(os.homedir(), "Desktop", "pi-test-license-upload");
const publicConfig = JSON.parse(readFileSync(path.join(root, "config", "device-license-public.json"), "utf8"));
const [fingerprint, ...options] = process.argv.slice(2);

if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) {
  console.error(
    "Usage: npm run license:make -- <64-character-device-fingerprint> [--revoked] [--license-id ID] [--minimum-version x.y.z]",
  );
  process.exit(1);
}
if (!existsSync(privateKey)) {
  console.error(`License signing key not found: ${privateKey}`);
  process.exit(1);
}

const issue = spawnSync(
  process.execPath,
  [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    path.join(root, "scripts", "issue-device-license.mjs"),
    "--fingerprint",
    fingerprint,
    "--private-key",
    privateKey,
    "--output",
    outputRoot,
    ...options,
  ],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (issue.status !== 0) process.exit(issue.status ?? 1);

const outputPath = issue.stdout.trim();
const license = JSON.parse(readFileSync(outputPath, "utf8"));
const { signature, ...payload } = license;
const publicKey = createPublicKey({ key: Buffer.from(publicConfig.publicKey, "base64"), format: "der", type: "spki" });
if (!verify(null, canonicalizeLicensePayload(payload), publicKey, Buffer.from(signature, "base64"))) {
  console.error("Generated license failed verification against config/device-license-public.json");
  process.exit(1);
}

console.log(`Generated: ${outputPath}`);
console.log(`Status: ${license.status}`);
console.log(`Upload object: licenses/${fingerprint}.json`);
console.log(`Public URL: ${new URL(`licenses/${fingerprint}.json`, publicConfig.baseUrl).href}`);
