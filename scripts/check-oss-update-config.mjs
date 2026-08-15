#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`[oss-update] ${message}`);
  process.exit(1);
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(path.join(root, "config", "update-oss.json"), "utf8"));
  } catch {
    fail("config/update-oss.json is required for pack/dist");
  }
}

export function validateOssUpdateConfig(config = loadConfig()) {
  const baseUrl = config?.baseUrl;
  if (!baseUrl || Object.keys(config).sort().join(",") !== "baseUrl") {
    fail("update OSS config must contain only baseUrl");
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail("update OSS baseUrl is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail("update OSS baseUrl must be a credential-free HTTPS base URL");
  }
  if (!/^[a-z0-9][a-z0-9-]*\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(url.host)) {
    fail("update OSS baseUrl must be a virtual-host style Aliyun OSS endpoint");
  }

  const builderConfig = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
  const publishBlock = builderConfig.match(/\npublish:\s*\n(?:[ \t]+\S[^\n]*\n?)+/)?.[0] ?? "";
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!/^[ \t]*provider\s*:\s*generic\s*$/m.test(publishBlock) || !publishBlock.includes(`url: ${normalized}`)) {
    fail("electron-builder.yml publish must use the generic provider with the OSS update baseUrl");
  }

  return normalized;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const normalized = validateOssUpdateConfig();
  console.log(`[oss-update] fixed OSS update feed is configured: ${normalized}`);
}
