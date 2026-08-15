#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_TYPE = "application/octet-stream";

/**
 * Build an Aliyun OSS signature version 1 Authorization header for a single
 * PUT object request with no custom x-oss headers.
 */
export function buildOssAuthorization({ accessKeyId, accessKeySecret, method, contentType, date, resource }) {
  const stringToSign = [method, "", contentType, date, resource].join("\n");
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  return { authorization: `OSS ${accessKeyId}:${signature}`, stringToSign };
}

export function parseOssConfig(baseUrl) {
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  const bucket = url.host.split(".")[0];
  const prefix = url.pathname.replace(/^\/+|\/+$/g, "");
  const resourceFor = (key) => `/${bucket}${prefix ? `/${prefix}` : ""}/${key}`;
  const uploadUrlFor = (key) => `${url.href.replace(/\/+$/, "")}/${key}`;
  return { bucket, prefix, resourceFor, uploadUrlFor };
}

const ARTIFACT_PATTERNS = [
  /^latest(?:-mac|-linux)?\.yml$/,
  /^.*-mac\.yml$/,
  /\.(?:exe|dmg|zip|AppImage)\.blockmap$/,
  /\.(?:exe|dmg|zip|AppImage)$/,
];

export function collectDistArtifacts(distDir) {
  return readdirSync(distDir)
    .filter(
      (name) =>
        statSync(path.join(distDir, name)).isFile() &&
        !/^builder[-.]/.test(name) &&
        !/-unpacked$/.test(name) &&
        ARTIFACT_PATTERNS.some((pattern) => pattern.test(name)),
    )
    .sort();
}

async function putObject({ baseUrl, accessKeyId, accessKeySecret, key, body }) {
  const { uploadUrlFor, resourceFor } = parseOssConfig(baseUrl);
  const date = new Date().toUTCString();
  const { authorization } = buildOssAuthorization({
    accessKeyId,
    accessKeySecret,
    method: "PUT",
    contentType: CONTENT_TYPE,
    date,
    resource: resourceFor(key),
  });

  const response = await globalThis.fetch(uploadUrlFor(key), {
    method: "PUT",
    headers: {
      Date: date,
      "Content-Type": CONTENT_TYPE,
      Authorization: authorization,
    },
    body,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `OSS upload failed for ${key}: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return key;
}

function requireCredential(name) {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`[publish-oss] ${name} is required`);
    process.exit(1);
  }
  return value.trim();
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.some((arg) => !["--dry-run", "--self-check"].includes(arg))) {
    console.error("Usage: publish-oss.mjs [--dry-run] [--self-check]");
    process.exit(1);
  }

  const envFile = path.join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = JSON.parse(readFileSync(path.join(root, "config", "update-oss.json"), "utf8"));
  const { baseUrl } = config;
  const artifacts = collectDistArtifacts(path.join(root, "dist"));

  if (rawArgs.includes("--self-check")) {
    const { authorization, stringToSign } = buildOssAuthorization({
      accessKeyId: "test",
      accessKeySecret: "testsecret",
      method: "PUT",
      contentType: CONTENT_TYPE,
      date: "Thu, 15 Aug 2026 00:00:00 GMT",
      resource: "/bucket/path/latest.yml",
    });
    const expectedStringToSign =
      "PUT\n\napplication/octet-stream\nThu, 15 Aug 2026 00:00:00 GMT\n/bucket/path/latest.yml";
    const expectedAuthorization = "OSS test:wFeBKk/Q8sRkWCsg5HCDThPJnk4=";
    if (stringToSign !== expectedStringToSign || authorization !== expectedAuthorization) {
      throw new Error("OSS signature self-check failed");
    }
    console.log("[publish-oss] self-check passed: OSS V1 signature matches known vector");
    return;
  }

  if (artifacts.length === 0) {
    console.error("[publish-oss] no dist artifacts to upload; run a release build first");
    process.exit(1);
  }

  if (rawArgs.includes("--dry-run")) {
    for (const artifact of artifacts)
      console.log(`would upload ${artifact} -> ${baseUrl.replace(/\/+$/, "")}/${artifact}`);
    return;
  }

  const accessKeyId = requireCredential("OSS_ACCESS_KEY_ID");
  const accessKeySecret = requireCredential("OSS_ACCESS_KEY_SECRET");
  for (const artifact of artifacts) {
    const body = readFileSync(path.join(root, "dist", artifact));
    const uploaded = await putObject({ baseUrl, accessKeyId, accessKeySecret, key: artifact, body });
    console.log(`uploaded ${uploaded}`);
  }
  console.log(`[publish-oss] published ${artifacts.length} artifact(s) to ${baseUrl.replace(/\/+$/, "")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
