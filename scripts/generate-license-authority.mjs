#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) {
  console.error("Usage: node scripts/generate-license-authority.mjs <absolute-private-directory>");
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(output, { recursive: true, mode: 0o700 });
const privateKeyPath = path.join(output, "license-ed25519-private.pem");
const publicKeyPath = path.join(output, "license-ed25519-public.pem");
writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644, flag: "wx" });
console.log(`privateKey=${privateKeyPath}`);
console.log(`publicKey=${publicKeyPath}`);
console.log(`PI_TEST_LICENSE_PUBLIC_KEY=${publicKey.export({ format: "der", type: "spki" }).toString("base64")}`);
