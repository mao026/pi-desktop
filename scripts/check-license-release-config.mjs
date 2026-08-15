#!/usr/bin/env node
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`[license-release] ${message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(new URL("../config/device-license-public.json", import.meta.url), "utf8"));
} catch {
  fail("config/device-license-public.json is required for pack/dist");
}
const baseUrl = config?.baseUrl;
const publicKey = config?.publicKey;
if (!baseUrl || !publicKey || Object.keys(config).sort().join(",") !== "baseUrl,publicKey") {
  fail("device license public config must contain only baseUrl and publicKey");
}

try {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail("device license baseUrl must be a credential-free HTTPS base URL");
  }
} catch {
  fail("device license baseUrl is invalid");
}

try {
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") fail("device license publicKey must be an Ed25519 SPKI key");
} catch {
  fail("device license publicKey is invalid");
}

console.log("[license-release] fixed HTTPS origin and Ed25519 trust root are configured");
