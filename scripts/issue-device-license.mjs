#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalizeLicensePayload } from "../src/main/device-license.ts";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function fail(message) {
  console.error(`[issue-license] ${message}`);
  process.exit(1);
}

const valueOptions = new Set(["--fingerprint", "--private-key", "--output", "--minimum-version", "--license-id"]);
const args = new Map();
const rawArgs = process.argv.slice(2);
for (let index = 0; index < rawArgs.length; index += 1) {
  const option = rawArgs[index];
  if (option === "--revoked") {
    if (args.has(option)) fail(`${option} was provided more than once`);
    args.set(option, true);
    continue;
  }
  if (!valueOptions.has(option)) fail(`unknown option: ${option}`);
  const value = rawArgs[++index];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  if (args.has(option)) fail(`${option} was provided more than once`);
  args.set(option, value);
}
const fingerprint = args.get("--fingerprint");
const privateKeyPath = args.get("--private-key");
const outputRoot = args.get("--output");
const minimumDesktopVersion = args.get("--minimum-version") ?? packageJson.version;
const licenseId = args.get("--license-id") ?? `lic-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;

if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
  fail("--fingerprint must be 64 lowercase hex characters");
if (typeof privateKeyPath !== "string" || !path.isAbsolute(privateKeyPath))
  fail("--private-key must be an absolute path");
if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) fail("--output must be an absolute path");
if (typeof minimumDesktopVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(minimumDesktopVersion))
  fail("--minimum-version must be x.y.z");
if (typeof licenseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(licenseId))
  fail("--license-id is invalid");

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") fail("private key must be Ed25519");
} catch (error) {
  fail(`could not read Ed25519 private key: ${error instanceof Error ? error.message : String(error)}`);
}

const payload = {
  version: 1,
  licenseId,
  deviceFingerprint: fingerprint,
  status: args.get("--revoked") === true ? "revoked" : "active",
  issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  features: ["desktop-testing"],
  minimumDesktopVersion,
};
const license = {
  ...payload,
  signature: sign(null, canonicalizeLicensePayload(payload), privateKey).toString("base64"),
};
const outputPath = path.join(outputRoot, "licenses", `${fingerprint}.json`);
mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify(license, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(outputPath);
