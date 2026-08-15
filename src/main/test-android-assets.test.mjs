import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareTestAndroidAssets } from "./test-android-assets.ts";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-android-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "resources", "test-android", "win32-x64");
  fs.mkdirSync(source, { recursive: true });
  const files = {
    LICENSE: "MIT",
    VERSION: "v0.1.38\n",
    "hs.exe": "fixed hs",
    "hs.jar": "fixed jar",
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(source, name), content);
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      handsetsVersion: "0.1.38",
      sourceCommit: "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64),
      platformTools: {
        version: "37.0.1",
        windowsX64: {
          sourceUrl: "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip",
          productPath: "tools/windows-x64/platform-tools-37.0.1.zip",
          bytes: 8044989,
          sha1: "e03e78b1d80b396f1c3358e31251cb31740e1110",
          sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99",
        },
      },
      files: Object.entries(files).map(([name, content]) => ({
        path: name,
        sha256: digest(content),
        bytes: Buffer.byteLength(content),
      })),
    }),
  );
  return { root, source, files };
}

test("prepares fixed Windows Handsets and repairs a self-consistent private tamper", async (t) => {
  const { root } = fixture(t);
  const privateRoot = path.join(root, "private");
  const options = {
    platform: "win32",
    arch: "x64",
    userDataDir: path.join(root, "user-data"),
    resourcesRoot: path.join(root, "resources"),
    applicationRoot: root,
    env: {},
    isPackaged: true,
    productBaseUrl: "https://downloads.example.test/",
    fetchArtifact: async () => {},
    privateRoot,
    executor: {
      async run(command) {
        return {
          executable: command.executable,
          args: command.args,
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          outputLimitExceeded: false,
          durationMs: 1,
        };
      },
    },
  };
  const first = await prepareTestAndroidAssets(options);
  assert.equal(fs.readFileSync(first.hsPath, "utf8"), "fixed hs");
  assert.equal(first.platformToolsInstalled, false);

  fs.writeFileSync(first.hsPath, "tampered hs");
  const manifestPath = path.join(path.dirname(first.hsPath), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const hs = manifest.files.find((file) => file.path === "hs.exe");
  hs.sha256 = digest("tampered hs");
  hs.bytes = Buffer.byteLength("tampered hs");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const originalRmSync = fs.rmSync;
  fs.rmSync = (file, rmOptions) => {
    if (String(file).includes(".handsets.") && String(file).endsWith(".previous")) {
      throw Object.assign(new Error("locked previous Handsets"), { code: "EPERM" });
    }
    return originalRmSync(file, rmOptions);
  };
  let repaired;
  try {
    repaired = await prepareTestAndroidAssets(options);
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(fs.readFileSync(repaired.hsPath, "utf8"), "fixed hs");
  assert.ok(fs.readdirSync(path.dirname(path.dirname(repaired.hsPath))).some((name) => name.endsWith(".previous")));
});

test("Android assets remain unsupported outside Windows x64", async (t) => {
  const { root } = fixture(t);
  const state = await prepareTestAndroidAssets({
    platform: "darwin",
    arch: "arm64",
    userDataDir: path.join(root, "user-data"),
    resourcesRoot: path.join(root, "resources"),
    applicationRoot: root,
    env: {},
    isPackaged: true,
    productBaseUrl: "",
    fetchArtifact: async () => {},
  });
  assert.equal(state.supported, false);
  assert.equal(state.platformToolsInstalled, false);
});
