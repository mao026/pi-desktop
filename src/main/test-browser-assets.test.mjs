import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openChromeExtensionManager,
  prepareTestBrowserAssets,
  resolveChromeExecutable,
} from "./test-browser-assets.ts";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-browser-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const sourceCli = path.join(resources, "test-browser", "linux-x64");
  const sourceExtensionRoot = path.join(resources, "chrome-extension");
  const sourceExtension = path.join(sourceExtensionRoot, "tmwd_cdp_bridge");
  fs.mkdirSync(sourceCli, { recursive: true });
  fs.mkdirSync(sourceExtension, { recursive: true });
  const executable = Buffer.from("fixed browser cli");
  fs.writeFileSync(path.join(sourceCli, "agent-browser-cli"), executable, { mode: 0o755 });
  fs.writeFileSync(
    path.join(sourceCli, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      cliVersion: "0.3.7",
      platform: "linux",
      arch: "x64",
      executable: "agent-browser-cli",
      sha256: digest(executable),
      bytes: executable.length,
      sourcePackage: "@sleepinsummer/agent-browser-cli-linux-x64",
      sourceArchiveSha256: "a".repeat(64),
    }),
  );
  const extensionFiles = {
    "background.js": 'const extensionVersion = "2.1-pi-test.2";',
    "manifest.json": JSON.stringify({ version: "2.1", version_name: "2.1-pi-test.2" }),
    "popup.html": '<html><script src="popup.js"></script></html>',
    "popup.js": "document.body.dataset.ready = 'yes';",
  };
  for (const [name, content] of Object.entries(extensionFiles)) {
    fs.writeFileSync(path.join(sourceExtension, name), content);
  }
  fs.writeFileSync(
    path.join(sourceExtensionRoot, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionVersion: "2.1",
      productExtensionVersion: "2.1-pi-test.2",
      sourceCommit: "b".repeat(40),
      files: Object.entries(extensionFiles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, content]) => ({ path: name, sha256: digest(content), bytes: Buffer.byteLength(content) })),
    }),
  );
  return { root, resources };
}

test("prepares fixed browser assets and replaces tampered private copies", (t) => {
  const { root, resources } = fixture(t);
  const options = {
    platform: "linux",
    arch: "x64",
    userDataDir: path.join(root, "data"),
    resourcesRoot: resources,
    applicationRoot: root,
    env: {},
    isPackaged: true,
  };
  const first = prepareTestBrowserAssets(options);
  assert.equal(fs.readFileSync(first.cliPath, "utf8"), "fixed browser cli");
  assert.equal(fs.existsSync(first.extensionBackupPath), false);
  assert.equal(first.productExtensionVersion, "2.1-pi-test.2");
  assert.doesNotMatch(fs.readFileSync(path.join(first.extensionPath, "popup.js"), "utf8"), /cookie|clipboard/i);

  const daemonLock = path.join(path.dirname(first.cliPath), ".agent-browser-cli.lock");
  fs.writeFileSync(daemonLock, "");
  const reused = prepareTestBrowserAssets(options);
  assert.equal(reused.cliPath, first.cliPath);
  assert.equal(fs.existsSync(daemonLock), true);

  fs.writeFileSync(first.cliPath, "tampered");
  const tamperedManifestPath = path.join(path.dirname(first.cliPath), "manifest.json");
  const tamperedManifest = JSON.parse(fs.readFileSync(tamperedManifestPath, "utf8"));
  tamperedManifest.sha256 = digest("tampered");
  tamperedManifest.bytes = Buffer.byteLength("tampered");
  fs.writeFileSync(tamperedManifestPath, JSON.stringify(tamperedManifest));
  fs.writeFileSync(path.join(first.extensionPath, "popup.js"), "old extension");
  const originalRmSync = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (fs.existsSync(file) && String(file).includes(".linux-x64.") && String(file).endsWith(".previous")) {
      throw Object.assign(new Error("locked previous CLI"), { code: "EPERM" });
    }
    return originalRmSync(file, options);
  };
  let repaired;
  try {
    repaired = prepareTestBrowserAssets(options);
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(fs.readFileSync(repaired.cliPath, "utf8"), "fixed browser cli");
  assert.equal(fs.readFileSync(path.join(repaired.extensionPath, "popup.js"), "utf8"), extensionFilesPopup());
  assert.equal(fs.readFileSync(path.join(repaired.extensionBackupPath, "popup.js"), "utf8"), "old extension");
  assert.ok(fs.readdirSync(path.dirname(path.dirname(repaired.cliPath))).some((name) => name.endsWith(".previous")));
});

function extensionFilesPopup() {
  return "document.body.dataset.ready = 'yes';";
}

test("resolves Chrome from fixed platform locations and launches only chrome://extensions", () => {
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(
    resolveChromeExecutable({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files" },
      exists: (file) => file === chrome,
    }),
    chrome,
  );
  const launches = [];
  openChromeExtensionManager({
    platform: "win32",
    env: { PROGRAMFILES: "C:\\Program Files" },
    exists: (file) => file === chrome,
    launch: (executable, args) => launches.push([executable, args]),
  });
  assert.deepEqual(launches, [[chrome, ["chrome://extensions"]]]);
});
