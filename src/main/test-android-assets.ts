import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ClientRequest, ClientRequestConstructorOptions } from "electron";
import { extractRuntimeArchive } from "./toolchains/secure-extractor.ts";
import { hashFile } from "./toolchains/downloader.ts";
import { runProbeCommand, type ProbeExecutor } from "./toolchains/process-runner.ts";

const HANDSETS_VERSION = "0.1.38";
const PLATFORM_TOOLS_VERSION = "37.0.1";
const PLATFORM_TOOLS_BYTES = 8_044_989;
const PLATFORM_TOOLS_SHA256 = "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99";
const PLATFORM_TOOLS_PRODUCT_PATH = "tools/windows-x64/platform-tools-37.0.1.zip";
const REQUIRED_HANDSETS_FILES = ["LICENSE", "VERSION", "hs.exe", "hs.jar"] as const;

interface FileManifest {
  path: string;
  sha256: string;
  bytes: number;
}

const REQUIRED_PLATFORM_FILES: readonly FileManifest[] = [
  {
    path: "AdbWinApi.dll",
    bytes: 108184,
    sha256: "c1d653030b4bde65d3e07e4d0b0979e17be56df1436cdd15528630f27808050d",
  },
  {
    path: "AdbWinUsbApi.dll",
    bytes: 73368,
    sha256: "0710e894d9b40f71a670c13c694079d564c92c1279da382cfe4850983aaebe1b",
  },
  {
    path: "NOTICE.txt",
    bytes: 1154131,
    sha256: "38ec8c6f5b7799c223ffeab1f9e81c2d5fc67b5e56d6424f649630ca1ee1a811",
  },
  {
    path: "adb.exe",
    bytes: 8273560,
    sha256: "b4a6b455702684652cccf7b46258b29e653538904359a58fd4931cf3ef286b3f",
  },
  {
    path: "source.properties",
    bytes: 38,
    sha256: "2dccd788c0234d8cf7f7457377e57f57527a86a629c6ed54feb8af0f549dac38",
  },
] as const;

interface AndroidManifest {
  schemaVersion: 1;
  platform: "win32";
  arch: "x64";
  handsetsVersion: string;
  sourceCommit: string;
  sourceArchiveSha256: string;
  platformTools: {
    version: string;
    windowsX64: {
      sourceUrl: string;
      productPath: string;
      bytes: number;
      sha1: string;
      sha256: string;
    };
  };
  files: FileManifest[];
}

export interface TestAndroidAssetsState {
  supported: boolean;
  error: string | null;
  root: string;
  hsPath: string;
  hsJarPath: string;
  handsetsVersion: string;
  platformToolsPath: string;
  adbPath: string;
  platformToolsVersion: string;
  platformToolsInstalled: boolean;
  platformToolsDownloadAvailable: boolean;
}

export type TestAndroidFetch = (
  url: string,
  destination: string,
  expectedBytes: number,
  expectedSha256: string,
) => Promise<void>;

export interface TestAndroidAssetOptions {
  platform: NodeJS.Platform;
  arch: string;
  userDataDir: string;
  resourcesRoot: string;
  applicationRoot: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  productBaseUrl: string;
  fetchArtifact: TestAndroidFetch;
  executor?: ProbeExecutor;
  privateRoot?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields are invalid`);
  }
}

function parseFiles(value: unknown): FileManifest[] {
  if (!Array.isArray(value) || value.length !== REQUIRED_HANDSETS_FILES.length) {
    throw new Error("Handsets file manifest is invalid");
  }
  const files = value.map((entry, index) => {
    const file = record(entry, `Handsets file ${index}`);
    exactKeys(file, ["path", "sha256", "bytes"], `Handsets file ${index}`);
    if (
      typeof file.path !== "string" ||
      !REQUIRED_HANDSETS_FILES.includes(file.path as (typeof REQUIRED_HANDSETS_FILES)[number]) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) <= 0 ||
      (file.bytes as number) > 2 * 1024 * 1024
    ) {
      throw new Error(`Handsets file ${index} is invalid`);
    }
    return { path: file.path, sha256: file.sha256, bytes: file.bytes as number };
  });
  if (new Set(files.map((file) => file.path)).size !== REQUIRED_HANDSETS_FILES.length) {
    throw new Error("Handsets file manifest contains duplicates");
  }
  return files;
}

function parseManifest(value: unknown): AndroidManifest {
  const manifest = record(value, "Android asset manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "platform",
      "arch",
      "handsetsVersion",
      "sourceCommit",
      "sourceArchiveSha256",
      "platformTools",
      "files",
    ],
    "Android asset manifest",
  );
  const platformTools = record(manifest.platformTools, "platform-tools manifest");
  exactKeys(platformTools, ["version", "windowsX64"], "platform-tools manifest");
  const windows = record(platformTools.windowsX64, "platform-tools Windows manifest");
  exactKeys(windows, ["sourceUrl", "productPath", "bytes", "sha1", "sha256"], "platform-tools Windows manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== "win32" ||
    manifest.arch !== "x64" ||
    manifest.handsetsVersion !== HANDSETS_VERSION ||
    typeof manifest.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    typeof manifest.sourceArchiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceArchiveSha256) ||
    platformTools.version !== PLATFORM_TOOLS_VERSION ||
    windows.productPath !== PLATFORM_TOOLS_PRODUCT_PATH ||
    windows.bytes !== PLATFORM_TOOLS_BYTES ||
    windows.sha256 !== PLATFORM_TOOLS_SHA256 ||
    typeof windows.sourceUrl !== "string" ||
    windows.sourceUrl !== "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip" ||
    windows.sha1 !== "e03e78b1d80b396f1c3358e31251cb31740e1110"
  ) {
    throw new Error("Android asset manifest does not match the fixed product baseline");
  }
  return {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    handsetsVersion: HANDSETS_VERSION,
    sourceCommit: manifest.sourceCommit,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    platformTools: {
      version: PLATFORM_TOOLS_VERSION,
      windowsX64: {
        sourceUrl: windows.sourceUrl,
        productPath: PLATFORM_TOOLS_PRODUCT_PATH,
        bytes: PLATFORM_TOOLS_BYTES,
        sha1: windows.sha1,
        sha256: PLATFORM_TOOLS_SHA256,
      },
    },
    files: parseFiles(manifest.files),
  };
}

async function verifyFile(filePath: string, expected: FileManifest): Promise<void> {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Android asset is not a regular file: ${filePath}`);
  const actual = await hashFile(filePath);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`Android asset integrity check failed: ${filePath}`);
  }
}

async function verifyHandsets(directory: string, manifest: AndroidManifest): Promise<void> {
  const entries = fs.readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...REQUIRED_HANDSETS_FILES, "manifest.json"].sort())) {
    throw new Error("Handsets directory contains unexpected files");
  }
  for (const file of manifest.files) await verifyFile(path.join(directory, file.path), file);
  if (fs.readFileSync(path.join(directory, "VERSION"), "utf8").trim() !== `v${HANDSETS_VERSION}`) {
    throw new Error("Handsets VERSION mismatch");
  }
}

async function verifyPlatformTools(directory: string): Promise<void> {
  const entries = fs.readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(REQUIRED_PLATFORM_FILES.map((file) => file.path).sort())) {
    throw new Error("platform-tools directory contains unexpected files");
  }
  for (const file of REQUIRED_PLATFORM_FILES) await verifyFile(path.join(directory, file.path), file);
  const sourceProperties = fs.readFileSync(path.join(directory, "source.properties"), "utf8");
  if (!sourceProperties.includes(`Pkg.Revision=${PLATFORM_TOOLS_VERSION}`)) {
    throw new Error("platform-tools version mismatch");
  }
}

async function replaceDirectory(
  source: string,
  destination: string,
  verify: (directory: string) => Promise<void>,
): Promise<void> {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.staging`);
  const previous = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.previous`);
  try {
    fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    await verify(staging);
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    try {
      fs.rmSync(previous, { recursive: true, force: true });
    } catch {
      // Windows may keep the replaced Handsets executable locked; the verified new directory is already active.
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function productBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    return null;
  }
}

function androidRoot(
  options: Pick<TestAndroidAssetOptions, "platform" | "userDataDir" | "env" | "privateRoot">,
): string {
  if (options.privateRoot) {
    if (!path.isAbsolute(options.privateRoot)) throw new Error("private Android root must be absolute");
    return options.privateRoot;
  }
  if (options.platform !== "win32") return path.join(options.userDataDir, "test-android");
  const localAppData = options.env.LOCALAPPDATA;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA must be an absolute path");
  }
  return path.win32.join(localAppData, "PiTestDesktop", "test-android");
}

function unsupported(options: TestAndroidAssetOptions, error: string): TestAndroidAssetsState {
  const root = androidRoot(options);
  return {
    supported: false,
    error,
    root,
    hsPath: path.join(root, "handsets", "hs.exe"),
    hsJarPath: path.join(root, "handsets", "hs.jar"),
    handsetsVersion: HANDSETS_VERSION,
    platformToolsPath: path.join(root, "platform-tools", PLATFORM_TOOLS_VERSION),
    adbPath: path.join(root, "platform-tools", PLATFORM_TOOLS_VERSION, "adb.exe"),
    platformToolsVersion: PLATFORM_TOOLS_VERSION,
    platformToolsInstalled: false,
    platformToolsDownloadAvailable: false,
  };
}

export function unavailableTestAndroidAssets(options: TestAndroidAssetOptions, error: unknown): TestAndroidAssetsState {
  return unsupported(options, error instanceof Error ? error.message : String(error));
}

export async function prepareTestAndroidAssets(options: TestAndroidAssetOptions): Promise<TestAndroidAssetsState> {
  if (options.platform !== "win32" || options.arch !== "x64") {
    return unsupported(options, "Android 驱动当前仅支持 Windows x64");
  }
  const sourceRoot = options.isPackaged ? options.resourcesRoot : path.join(options.applicationRoot, "build");
  const source = path.join(sourceRoot, "test-android", "win32-x64");
  const manifest = parseManifest(JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")) as unknown);
  await verifyHandsets(source, manifest);
  const root = androidRoot(options);
  const handsets = path.join(root, "handsets");
  let handsetsReady = false;
  try {
    const installedManifest = parseManifest(
      JSON.parse(fs.readFileSync(path.join(handsets, "manifest.json"), "utf8")) as unknown,
    );
    if (JSON.stringify(installedManifest) !== JSON.stringify(manifest))
      throw new Error("installed Handsets manifest mismatch");
    await verifyHandsets(handsets, manifest);
    handsetsReady = true;
  } catch {
    // Missing or modified private assets are repaired from packaged resources.
  }
  if (!handsetsReady) await replaceDirectory(source, handsets, (directory) => verifyHandsets(directory, manifest));

  const platformToolsPath = path.join(root, "platform-tools", PLATFORM_TOOLS_VERSION);
  let platformToolsInstalled = false;
  try {
    await verifyPlatformTools(platformToolsPath);
    const probe = await (options.executor ?? { run: runProbeCommand }).run({
      executable: path.join(platformToolsPath, "adb.exe"),
      args: ["version"],
      env: options.env,
      timeoutMs: 10_000,
      outputLimitBytes: 16 * 1024,
    });
    platformToolsInstalled = probe.exitCode === 0 && probe.stdout.includes("Android Debug Bridge version");
  } catch {
    platformToolsInstalled = false;
  }
  return {
    supported: true,
    error: null,
    root,
    hsPath: path.join(handsets, "hs.exe"),
    hsJarPath: path.join(handsets, "hs.jar"),
    handsetsVersion: HANDSETS_VERSION,
    platformToolsPath,
    adbPath: path.join(platformToolsPath, "adb.exe"),
    platformToolsVersion: PLATFORM_TOOLS_VERSION,
    platformToolsInstalled,
    platformToolsDownloadAvailable: productBaseUrl(options.productBaseUrl) !== null,
  };
}

export async function installPlatformTools(
  state: TestAndroidAssetsState,
  options: Pick<TestAndroidAssetOptions, "productBaseUrl" | "fetchArtifact" | "env" | "executor">,
): Promise<TestAndroidAssetsState> {
  if (!state.supported) throw new Error("ANDROID_UNSUPPORTED: Android 驱动当前仅支持 Windows x64");
  const baseUrl = productBaseUrl(options.productBaseUrl);
  if (!baseUrl) throw new Error("ANDROID_TOOLS_UNAVAILABLE: 此构建尚未配置 Android 工具下载地址");
  const archive = path.join(state.root, "downloads", `platform-tools-${PLATFORM_TOOLS_VERSION}.zip`);
  fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
  await options.fetchArtifact(
    new URL(PLATFORM_TOOLS_PRODUCT_PATH, baseUrl).href,
    archive,
    PLATFORM_TOOLS_BYTES,
    PLATFORM_TOOLS_SHA256,
  );
  const extraction = fs.mkdtempSync(path.join(state.root, ".platform-tools-extract-"));
  const staging = fs.mkdtempSync(path.join(state.root, ".platform-tools-staging-"));
  try {
    await extractRuntimeArchive(archive, extraction, "zip", { maxEntries: 64, maxExtractedBytes: 64 * 1024 * 1024 });
    const source = path.join(extraction, "platform-tools");
    await verifyPlatformTools(source);
    for (const file of REQUIRED_PLATFORM_FILES) {
      fs.copyFileSync(path.join(source, file.path), path.join(staging, file.path));
    }
    await verifyPlatformTools(staging);
    const previous = `${state.platformToolsPath}.previous-${randomUUID()}`;
    fs.mkdirSync(path.dirname(state.platformToolsPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(state.platformToolsPath)) fs.renameSync(state.platformToolsPath, previous);
    try {
      fs.renameSync(staging, state.platformToolsPath);
      fs.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(state.platformToolsPath) && fs.existsSync(previous))
        fs.renameSync(previous, state.platformToolsPath);
      throw error;
    }
  } finally {
    fs.rmSync(extraction, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const probe = await (options.executor ?? { run: runProbeCommand }).run({
    executable: state.adbPath,
    args: ["version"],
    env: options.env,
    timeoutMs: 10_000,
    outputLimitBytes: 16 * 1024,
  });
  if (probe.exitCode !== 0 || !probe.stdout.includes("Android Debug Bridge version")) {
    throw new Error("ANDROID_TOOLS_INVALID: adb.exe 启动验证失败");
  }
  return { ...state, platformToolsInstalled: true };
}

export function createFixedAndroidArtifactFetch(
  requestFactory: (options: ClientRequestConstructorOptions) => ClientRequest,
): TestAndroidFetch {
  return (url, destination, expectedBytes, expectedSha256) =>
    new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
        reject(new Error("ANDROID_DOWNLOAD_REJECTED: Android 工具下载地址无效"));
        return;
      }
      const request = requestFactory({ method: "GET", url, redirect: "error", bypassCustomProtocolHandlers: true });
      request.on("response", (response) => {
        void (async () => {
          if (response.statusCode !== 200) {
            reject(new Error(`ANDROID_DOWNLOAD_REJECTED: Android 工具下载失败 (${response.statusCode})`));
            return;
          }
          const temporary = `${destination}.${randomUUID()}.partial`;
          const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
          let bytes = 0;
          try {
            const body = response as unknown as AsyncIterable<Uint8Array>;
            for await (const value of body) {
              const chunk = Buffer.from(value);
              bytes += chunk.length;
              if (bytes > expectedBytes) throw new Error("Android tool archive exceeds fixed size");
              if (!output.write(chunk)) await new Promise<void>((done) => output.once("drain", done));
            }
            output.end();
            await new Promise<void>((done, fail) => {
              output.once("close", done);
              output.once("error", fail);
            });
            const digest = await hashFile(temporary);
            if (digest.bytes !== expectedBytes || digest.sha256 !== expectedSha256) {
              throw new Error("Android tool archive integrity check failed");
            }
            fs.rmSync(destination, { force: true });
            fs.renameSync(temporary, destination);
            resolve();
          } catch (error) {
            output.destroy();
            fs.rmSync(temporary, { force: true });
            reject(error);
          }
        })();
      });
      request.on("error", reject);
      request.end();
    });
}
