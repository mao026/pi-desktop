import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { darwinCodeDigest } from "./toolchains/darwin-binary-integrity.ts";

const CLI_VERSION = "0.3.7";
const EXTENSION_DIRECTORY = "tmwd_cdp_bridge";
const MAX_EXTENSION_FILES = 100;
const MAX_EXTENSION_BYTES = 4 * 1024 * 1024;

export interface TestBrowserAssetsState {
  prepared: boolean;
  error: string | null;
  cliPath: string;
  cliVersion: string;
  extensionPath: string;
  extensionBackupPath: string;
  extensionVersion: string;
  productExtensionVersion: string;
}

interface CliManifest {
  schemaVersion: 1;
  cliVersion: string;
  platform: string;
  arch: string;
  executable: string;
  sha256: string;
  bytes: number;
  darwinCodeSha256?: string;
  darwinCodeBytes?: number;
  sourcePackage: string;
  sourceArchiveSha256: string;
}

interface ExtensionManifest {
  schemaVersion: 1;
  extensionVersion: string;
  productExtensionVersion: string;
  sourceCommit: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} fields are invalid`);
}

function safeFileName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function parseCliManifest(value: unknown, platform: NodeJS.Platform, arch: string): CliManifest {
  const manifest = record(value, "test browser CLI manifest");
  const keys = [
    "schemaVersion",
    "cliVersion",
    "platform",
    "arch",
    "executable",
    "sha256",
    "bytes",
    "sourcePackage",
    "sourceArchiveSha256",
  ];
  if (platform === "darwin") keys.push("darwinCodeSha256", "darwinCodeBytes");
  exactKeys(manifest, keys, "test browser CLI manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.cliVersion !== CLI_VERSION ||
    manifest.platform !== platform ||
    manifest.arch !== arch
  ) {
    throw new Error("test browser CLI target does not match the application");
  }
  return {
    schemaVersion: 1,
    cliVersion: CLI_VERSION,
    platform,
    arch,
    executable: safeFileName(manifest.executable, "test browser executable"),
    sha256: sha256(manifest.sha256, "test browser executable SHA-256"),
    bytes: positiveInteger(manifest.bytes, "test browser executable size", 64 * 1024 * 1024),
    sourcePackage:
      typeof manifest.sourcePackage === "string" &&
      /^@sleepinsummer\/agent-browser-cli-[a-z0-9-]+$/.test(manifest.sourcePackage)
        ? manifest.sourcePackage
        : (() => {
            throw new Error("test browser source package is invalid");
          })(),
    sourceArchiveSha256: sha256(manifest.sourceArchiveSha256, "test browser source archive SHA-256"),
    ...(platform === "darwin"
      ? {
          darwinCodeSha256: sha256(manifest.darwinCodeSha256, "test browser code SHA-256"),
          darwinCodeBytes: positiveInteger(manifest.darwinCodeBytes, "test browser code size", 64 * 1024 * 1024),
        }
      : {}),
  };
}

function parseExtensionManifest(value: unknown): ExtensionManifest {
  const manifest = record(value, "Chrome extension manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "extensionVersion", "productExtensionVersion", "sourceCommit", "files"],
    "Chrome extension manifest",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.extensionVersion !== "2.1" ||
    typeof manifest.productExtensionVersion !== "string" ||
    !/^2\.1-pi-test\.\d+$/.test(manifest.productExtensionVersion) ||
    typeof manifest.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > MAX_EXTENSION_FILES
  ) {
    throw new Error("Chrome extension manifest is invalid");
  }
  let totalBytes = 0;
  const files = manifest.files.map((entry, index) => {
    const file = record(entry, `Chrome extension file ${index}`);
    exactKeys(file, ["path", "sha256", "bytes"], `Chrome extension file ${index}`);
    const bytes = positiveInteger(file.bytes, `Chrome extension file ${index} size`, MAX_EXTENSION_BYTES);
    totalBytes += bytes;
    return {
      path: safeRelativePath(file.path, `Chrome extension file ${index} path`),
      sha256: sha256(file.sha256, `Chrome extension file ${index} SHA-256`),
      bytes,
    };
  });
  if (totalBytes > MAX_EXTENSION_BYTES || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Chrome extension file list is invalid");
  }
  return {
    schemaVersion: 1,
    extensionVersion: "2.1",
    productExtensionVersion: manifest.productExtensionVersion,
    sourceCommit: manifest.sourceCommit,
    files,
  };
}

function hashFile(filePath: string): { sha256: string; bytes: number } {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`asset is not a regular file: ${filePath}`);
  return { sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"), bytes: stat.size };
}

function verifyFile(filePath: string, expectedSha256: string, expectedBytes: number): void {
  const actual = hashFile(filePath);
  if (actual.bytes !== expectedBytes || actual.sha256 !== expectedSha256) {
    throw new Error(`asset integrity check failed: ${filePath}`);
  }
}

function verifyCli(directory: string, manifest: CliManifest, platform: NodeJS.Platform): string {
  const entries = fs.readdirSync(directory).sort();
  const lockName = ".agent-browser-cli.lock";
  if (entries.includes(lockName)) {
    const lock = fs.lstatSync(path.join(directory, lockName));
    if (!lock.isFile() || lock.isSymbolicLink() || lock.size !== 0) {
      throw new Error("test browser CLI lock file is invalid");
    }
  }
  const assets = entries.filter((entry) => entry !== lockName);
  if (JSON.stringify(assets) !== JSON.stringify([manifest.executable, "manifest.json"].sort())) {
    throw new Error("test browser CLI directory contains unexpected files");
  }
  const executable = path.join(directory, manifest.executable);
  if (platform === "darwin") {
    const stat = fs.lstatSync(executable);
    const digest = stat.isFile() && !stat.isSymbolicLink() ? darwinCodeDigest(fs.readFileSync(executable)) : undefined;
    if (!digest || digest.sha256 !== manifest.darwinCodeSha256 || digest.bytes !== manifest.darwinCodeBytes) {
      throw new Error("test browser CLI signed code integrity check failed");
    }
  } else {
    verifyFile(executable, manifest.sha256, manifest.bytes);
  }
  return executable;
}

function walkFiles(directory: string, root = directory): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Chrome extension contains a symlink: ${entryPath}`);
      if (entry.isDirectory()) return walkFiles(entryPath, root);
      if (!entry.isFile()) throw new Error(`Chrome extension contains an unsupported entry: ${entryPath}`);
      return [path.relative(root, entryPath).split(path.sep).join("/")];
    });
}

function verifyExtension(directory: string, manifest: ExtensionManifest): void {
  const expected = manifest.files.map((file) => file.path).sort();
  const actual = walkFiles(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Chrome extension file list mismatch");
  for (const file of manifest.files) verifyFile(path.join(directory, ...file.path.split("/")), file.sha256, file.bytes);
  const chromeManifest = record(readJson(path.join(directory, "manifest.json")), "Chrome manifest.json");
  if (
    chromeManifest.version !== manifest.extensionVersion ||
    chromeManifest.version_name !== manifest.productExtensionVersion
  ) {
    throw new Error("Chrome extension version mismatch");
  }
  const popup = `${fs.readFileSync(path.join(directory, "popup.js"), "utf8")}\n${fs.readFileSync(
    path.join(directory, "popup.html"),
    "utf8",
  )}`;
  if (/cookie|clipboard/i.test(popup)) throw new Error("Chrome extension popup security patch is missing");
}

function replaceDirectory(
  source: string,
  destination: string,
  verify: (directory: string) => void,
  retainedBackup?: string,
): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
  const previous = retainedBackup ?? path.join(parent, `.${path.basename(destination)}.${randomUUID()}.previous`);
  try {
    fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    verify(staging);
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    if (!retainedBackup) {
      try {
        fs.rmSync(previous, { recursive: true, force: true });
      } catch {
        // Windows may keep the replaced CLI executable locked; the verified new directory is already active.
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function productDataRoot(options: TestBrowserAssetOptions): string {
  if (options.platform !== "win32") return options.userDataDir;
  const localAppData = options.env.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) throw new Error("LOCALAPPDATA must be an absolute path");
  return path.win32.join(localAppData, "PiTestDesktop");
}

export interface TestBrowserAssetOptions {
  platform: NodeJS.Platform;
  arch: string;
  userDataDir: string;
  resourcesRoot: string;
  applicationRoot: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}

export function resolveChromeExecutable(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
}): string | null {
  const exists = options.exists ?? fs.existsSync;
  const candidates =
    options.platform === "win32"
      ? [
          options.env.PROGRAMFILES &&
            path.win32.join(options.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
          options.env["PROGRAMFILES(X86)"] &&
            path.win32.join(options.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
          options.env.LOCALAPPDATA &&
            path.win32.join(options.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : options.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/google-chrome"];
  return (
    candidates.find((candidate): candidate is string => typeof candidate === "string" && exists(candidate)) ?? null
  );
}

export function openChromeExtensionManager(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  launch?: (executable: string, args: string[]) => void;
}): void {
  const executable = resolveChromeExecutable(options);
  if (!executable) throw new Error("CHROME_NOT_FOUND: 未找到 Google Chrome");
  if (options.launch) {
    options.launch(executable, ["chrome://extensions"]);
    return;
  }
  const child = spawn(executable, ["chrome://extensions"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function unavailableTestBrowserAssets(
  options: Pick<TestBrowserAssetOptions, "platform" | "arch" | "userDataDir" | "env">,
  error: unknown,
): TestBrowserAssetsState {
  const target = `${options.platform}-${options.arch}`;
  const dataRoot = productDataRoot({ ...options, resourcesRoot: "", applicationRoot: "", isPackaged: false });
  const executable = options.platform === "win32" ? "agent-browser-cli.exe" : "agent-browser-cli";
  return {
    prepared: false,
    error: error instanceof Error ? error.message : String(error),
    cliPath: path.join(dataRoot, "toolchains", "agent-browser-cli", CLI_VERSION, target, executable),
    cliVersion: CLI_VERSION,
    extensionPath: path.join(dataRoot, "chrome-extension", EXTENSION_DIRECTORY),
    extensionBackupPath: path.join(dataRoot, "chrome-extension", `${EXTENSION_DIRECTORY}.previous`),
    extensionVersion: "2.1",
    productExtensionVersion: "2.1-pi-test.2",
  };
}

export function prepareTestBrowserAssets(options: TestBrowserAssetOptions): TestBrowserAssetsState {
  const target = `${options.platform}-${options.arch}`;
  const sourceRoot = options.isPackaged ? options.resourcesRoot : path.join(options.applicationRoot, "build");
  const sourceCliDirectory = path.join(sourceRoot, "test-browser", target);
  const sourceCliManifest = parseCliManifest(
    readJson(path.join(sourceCliDirectory, "manifest.json")),
    options.platform,
    options.arch,
  );
  verifyCli(sourceCliDirectory, sourceCliManifest, options.platform);

  const sourceExtensionRoot = path.join(sourceRoot, "chrome-extension");
  const extensionManifest = parseExtensionManifest(readJson(path.join(sourceExtensionRoot, "manifest.json")));
  const sourceExtensionDirectory = path.join(sourceExtensionRoot, EXTENSION_DIRECTORY);
  verifyExtension(sourceExtensionDirectory, extensionManifest);

  const dataRoot = productDataRoot(options);
  const cliDirectory = path.join(dataRoot, "toolchains", "agent-browser-cli", CLI_VERSION, target);
  let cliReady = false;
  try {
    const installedManifest = parseCliManifest(
      readJson(path.join(cliDirectory, "manifest.json")),
      options.platform,
      options.arch,
    );
    if (JSON.stringify(installedManifest) !== JSON.stringify(sourceCliManifest)) {
      throw new Error("test browser CLI manifest does not match packaged assets");
    }
    verifyCli(cliDirectory, sourceCliManifest, options.platform);
    cliReady = true;
  } catch {
    // Missing or stale private assets are replaced atomically below.
  }
  if (!cliReady)
    replaceDirectory(sourceCliDirectory, cliDirectory, (directory) =>
      verifyCli(directory, sourceCliManifest, options.platform),
    );

  const extensionDirectory = path.join(dataRoot, "chrome-extension", EXTENSION_DIRECTORY);
  const extensionBackupDirectory = path.join(dataRoot, "chrome-extension", `${EXTENSION_DIRECTORY}.previous`);
  let extensionReady = false;
  try {
    verifyExtension(extensionDirectory, extensionManifest);
    extensionReady = true;
  } catch {
    // Missing or stale extension assets are replaced atomically below.
  }
  if (!extensionReady) {
    replaceDirectory(
      sourceExtensionDirectory,
      extensionDirectory,
      (directory) => verifyExtension(directory, extensionManifest),
      extensionBackupDirectory,
    );
  }

  return {
    prepared: true,
    error: null,
    cliPath: path.join(cliDirectory, sourceCliManifest.executable),
    cliVersion: sourceCliManifest.cliVersion,
    extensionPath: extensionDirectory,
    extensionBackupPath: extensionBackupDirectory,
    extensionVersion: extensionManifest.extensionVersion,
    productExtensionVersion: extensionManifest.productExtensionVersion,
  };
}
