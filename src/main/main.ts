/**
 * Pi Agent Desktop v2 — Electron main process
 * Responsibilities: window lifecycle, menus, tray/badge, deep link,
 * Host supervision, system IPC. No business logic.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  nativeTheme,
  nativeImage,
  net,
  Notification,
  shell,
} from "electron";
import fs from "node:fs";
import path from "path";
import { HostManager, getUserDataPath, resolveHostEntry } from "./host-manager";
import { appendMainLog } from "./logger";
import { installAppMenu } from "./menu";
import { handleAppProtocol, registerAppProtocol, rendererRootPath } from "./protocol";
import { acquireSingleInstanceLock } from "./single-instance";
import { loadUiState } from "./window-state";
import { createTray, destroyTray, setTrayRunningCount } from "./tray";
import { createMainWindow } from "./window";
import { installDesktopIpc } from "./ipc";
import { createProductionUpdateAdapter, isProductionUpdatePlatformEnabled } from "./update-adapter";
import { createUpdateManager, redactUpdateError, type UpdateManager } from "./update-manager";
import { CredentialVault } from "./credential-vault";
import { projectIdentityCredentialKey } from "./credential-key";
import { ToolchainManager } from "./toolchains/manager";
import { resolveRuntimeCatalogPath } from "./toolchains/catalog";
import { resolveBundledCorePaths } from "./toolchains/bundled-core";
import { isExecutionIntent, type ToolchainSnapshot } from "../shared/toolchains/types";
import { readLegacyNpmCommand } from "./toolchains/legacy-npm-command";
import { createElectronRuntimeFetch } from "./toolchains/electron-runtime-fetch";
import { AgentBrowserCliDriver, MainTestCoordinator, TestCoordinatorError } from "./test-coordinator";
import { readBrowserState, TestWorkbenchService, TestWorkbenchStore } from "./test-workbench-service";
import { createElectronZentaoFetch } from "./zentao-fetch";
import { getSurfaceReadiness, surfaceNames } from "../../packages/pi-test/core/project";
import {
  openChromeExtensionManager,
  prepareTestBrowserAssets,
  unavailableTestBrowserAssets,
} from "./test-browser-assets";
import {
  createFixedAndroidArtifactFetch,
  installPlatformTools,
  prepareTestAndroidAssets,
  unavailableTestAndroidAssets,
} from "./test-android-assets";
import { HandsetsMobileDriver } from "./test-mobile-driver";
import { defaultProbeExecutor } from "./toolchains/process-runner";
import { DeviceLicenseService } from "./device-license";
import { createElectronDeviceLicenseFetch } from "./device-license-fetch";

// Must run before app ready
registerAppProtocol();
crashReporter.start({
  productName: "Pi Agent Desktop",
  uploadToServer: false,
  compress: false,
});

const isDev = !app.isPackaged;
const packagedStartupValidation = app.isPackaged && process.argv.includes("--validate-packaged-startup");
const expectedPiVersion = process.env.PI_DESKTOP_EXPECTED_PI_VERSION;
const testLicenseBaseUrl = process.env.PI_TEST_LICENSE_BASE_URL;
const testLicensePublicKey = process.env.PI_TEST_LICENSE_PUBLIC_KEY;
const androidToolsBaseUrl = process.env.PI_TEST_ANDROID_TOOLS_BASE_URL;
const TOOLCHAIN_FOCUS_RESCAN_TTL_MS = 60_000;

let mainWindow: BrowserWindow | null = null;
let hostManager: HostManager | null = null;
let updateManager: UpdateManager | null = null;
let toolchainManager: ToolchainManager | null = null;
let testWorkbench: TestWorkbenchService | null = null;
let deviceLicense: DeviceLicenseService | null = null;
let isQuitting = false;
let unreadBadge = 0;
let pendingDeepLink: string | null = null;
let lastNotifiedUpdateVersion: string | null = null;
let lastToolchainFocusScanAt = 0;
let runningAgentSessionCount = 0;
let startupRendererReady = false;
let startupHostReady = false;
let startupToolchainSnapshot: ToolchainSnapshot | null = null;
let startupTestBrowserAssetsReady = false;
let startupTestBrowserCliVersion: string | null = null;
let startupTestBrowserExtensionVersion: string | null = null;
let startupTestAndroidAssetsReady = false;
let startupTestAndroidSupported = false;
let startupTestHandsetsVersion: string | null = null;
let startupTestPlatformToolsVersion: string | null = null;
let startupTestPlatformToolsInstalled = false;
let startupCheckFinished = false;
let startupCheckTimer: ReturnType<typeof setTimeout> | null = null;

function finishPackagedStartupValidation(error?: string): void {
  if (!packagedStartupValidation || startupCheckFinished) return;
  if (!error) {
    const snapshot = startupToolchainSnapshot;
    if (
      !startupRendererReady ||
      !startupHostReady ||
      !snapshot?.publicState.coreReady ||
      !startupTestBrowserAssetsReady ||
      !startupTestAndroidAssetsReady
    ) {
      return;
    }
    if (!expectedPiVersion || hostManager?.getPiVersion() !== expectedPiVersion) {
      error = `Agent Host Pi version mismatch: expected ${expectedPiVersion ?? "unknown"}, got ${hostManager?.getPiVersion() ?? "unknown"}`;
    }
    if ((hostManager?.getToolchainAckRevision() ?? -1) < snapshot.revision) return;
    for (const capability of ["search.rg", "search.fd"] as const) {
      const candidates = snapshot.publicState.capabilities[capability]?.candidates ?? [];
      if (!candidates.some((candidate) => candidate.provider === "bundled" && candidate.health === "healthy")) return;
    }
  }

  startupCheckFinished = true;
  if (startupCheckTimer) clearTimeout(startupCheckTimer);
  try {
    const report = error
      ? { ok: false, error }
      : {
          ok: true,
          appVersion: app.getVersion(),
          piVersion: hostManager?.getPiVersion(),
          platformArch: `${process.platform}-${process.arch}`,
          revision: startupToolchainSnapshot?.revision,
          rendererReady: startupRendererReady,
          hostReady: startupHostReady,
          hostAckRevision: hostManager?.getToolchainAckRevision(),
          bundledSearch: ["search.rg", "search.fd"],
          testBrowserCliVersion: startupTestBrowserCliVersion,
          testBrowserExtensionVersion: startupTestBrowserExtensionVersion,
          testAndroidSupported: startupTestAndroidSupported,
          testHandsetsVersion: startupTestHandsetsVersion,
          testPlatformToolsVersion: startupTestPlatformToolsVersion,
          testPlatformToolsInstalled: startupTestPlatformToolsInstalled,
        };
    fs.mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(app.getPath("userData"), "packaged-startup-check.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (writeError) {
    error ??= writeError instanceof Error ? writeError.message : "Could not write packaged startup report";
  }
  isQuitting = true;
  updateManager?.stopAutomaticChecks();
  hostManager?.stop();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.exit(error ? 1 : 0);
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function applyBadgeCount(count: number): void {
  unreadBadge = Math.max(0, Number(count) || 0);
  if (process.platform === "win32") {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (unreadBadge === 0) {
      win.setOverlayIcon(null, "No unread completed sessions");
      return;
    }
    const overlay = nativeImage
      .createFromPath(path.join(app.getAppPath(), "build", "icon.png"))
      .resize({ width: 16, height: 16 });
    win.setOverlayIcon(overlay, `${unreadBadge} unread completed session${unreadBadge === 1 ? "" : "s"}`);
    return;
  }
  app.setBadgeCount(unreadBadge);
}

function parseDeepLink(url: string): { sessionId?: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "pi-agent-desktop:") return null;
    // pi-agent-desktop://session/<id>
    if (u.hostname === "session" || u.pathname.startsWith("/session/")) {
      const id = u.hostname === "session" ? u.pathname.replace(/^\//, "") : u.pathname.replace(/^\/session\//, "");
      return id ? { sessionId: id } : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function handleDeepLink(url: string): void {
  appendMainLog(`deep link: ${url}`);
  const parsed = parseDeepLink(url);
  if (!parsed?.sessionId) return;
  const win = getMainWindow();
  if (win) {
    win.webContents.send("deep-link:session", parsed.sessionId);
    win.show();
    win.focus();
  } else {
    pendingDeepLink = parsed.sessionId;
  }
}

if (
  !acquireSingleInstanceLock(getMainWindow, (argv) => {
    const url = argv.find((a) => a.startsWith("pi-agent-desktop://"));
    if (url) handleDeepLink(url);
  })
) {
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function createWindow(): BrowserWindow {
  const win = createMainWindow({
    isDev,
    consumePendingDeepLink: () => {
      const sessionId = pendingDeepLink;
      pendingDeepLink = null;
      return sessionId;
    },
    shouldHideOnClose: () => !isQuitting && loadUiState().backgroundMode !== false,
    onClosed: (closedWindow) => {
      if (mainWindow === closedWindow) {
        mainWindow = null;
      }
    },
  });
  mainWindow = win;
  win.on("focus", () => {
    const manager = toolchainManager;
    const now = Date.now();
    if (!manager || now - lastToolchainFocusScanAt < TOOLCHAIN_FOCUS_RESCAN_TTL_MS) return;
    lastToolchainFocusScanAt = now;
    void manager.rescan().catch((error) => {
      appendMainLog(`toolchain focus rescan failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  if (packagedStartupValidation) {
    win.webContents.once("did-finish-load", () => {
      startupRendererReady = true;
      finishPackagedStartupValidation();
    });
    win.webContents.once("did-fail-load", (_event, code, description) => {
      finishPackagedStartupValidation(`Renderer failed to load (${code}): ${description}`);
    });
  }
  if (unreadBadge > 0) applyBadgeCount(unreadBadge);
  return win;
}

function openUpdateSettings(checkForUpdates: boolean): void {
  const win = getMainWindow() ?? createWindow();
  win.show();
  win.focus();
  const send = () => {
    if (!win.isDestroyed()) {
      win.webContents.send(checkForUpdates ? "menu:check-for-updates" : "menu:show-update");
    }
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

void app.whenReady().then(async () => {
  appendMainLog(`app ready packaged=${app.isPackaged}`);
  if (packagedStartupValidation) {
    startupCheckTimer = setTimeout(
      () => finishPackagedStartupValidation("Packaged startup validation timed out"),
      45_000,
    );
  }

  // The packaged asset probe must not invoke interactive OS credential storage.
  const credentialVault = packagedStartupValidation
    ? { has: () => false, get: () => null, set: () => undefined, delete: () => undefined }
    : new CredentialVault(getUserDataPath("channels.secrets.json"));
  deviceLicense = new DeviceLicenseService({
    vault: credentialVault,
    baseUrl: packagedStartupValidation ? "" : (testLicenseBaseUrl ?? ""),
    publicKey: packagedStartupValidation ? "" : (testLicensePublicKey ?? ""),
    cachePath: getUserDataPath("device-license-cache.json"),
    appVersion: app.getVersion(),
    fetchImpl: createElectronDeviceLicenseFetch((options) => net.request(options)),
    bypass: !app.isPackaged && process.env.PI_TEST_LICENSE_BYPASS === "1",
    log: (message) => appendMainLog(message),
  });
  void deviceLicense.start();
  const browserAssetOptions = {
    platform: process.platform,
    arch: process.arch,
    userDataDir: app.getPath("userData"),
    resourcesRoot: process.resourcesPath,
    applicationRoot: app.getAppPath(),
    env: process.env,
    isPackaged: app.isPackaged,
  };
  let testBrowserAssets;
  try {
    testBrowserAssets = prepareTestBrowserAssets(browserAssetOptions);
    startupTestBrowserAssetsReady = true;
    startupTestBrowserCliVersion = testBrowserAssets.cliVersion;
    startupTestBrowserExtensionVersion = testBrowserAssets.productExtensionVersion;
    appendMainLog(
      `test browser assets ready cli=${testBrowserAssets.cliVersion} extension=${testBrowserAssets.productExtensionVersion}`,
    );
  } catch (error) {
    testBrowserAssets = unavailableTestBrowserAssets(browserAssetOptions, error);
    appendMainLog(`test browser assets unavailable: ${testBrowserAssets.error}`);
    if (packagedStartupValidation) {
      finishPackagedStartupValidation(`Test browser assets unavailable: ${testBrowserAssets.error}`);
    }
  }
  const androidAssetOptions = {
    platform: process.platform,
    arch: process.arch,
    userDataDir: app.getPath("userData"),
    resourcesRoot: process.resourcesPath,
    applicationRoot: app.getAppPath(),
    env: process.env,
    isPackaged: app.isPackaged,
    productBaseUrl: androidToolsBaseUrl ?? "",
    fetchArtifact: createFixedAndroidArtifactFetch((options) => net.request(options)),
    executor: defaultProbeExecutor,
  };
  let testAndroidAssets;
  try {
    testAndroidAssets = await prepareTestAndroidAssets(androidAssetOptions);
    startupTestAndroidAssetsReady = true;
    startupTestAndroidSupported = testAndroidAssets.supported;
    startupTestHandsetsVersion = testAndroidAssets.handsetsVersion;
    startupTestPlatformToolsVersion = testAndroidAssets.platformToolsVersion;
    startupTestPlatformToolsInstalled = testAndroidAssets.platformToolsInstalled;
    appendMainLog(
      `test Android assets supported=${testAndroidAssets.supported} hs=${testAndroidAssets.handsetsVersion} adb=${testAndroidAssets.platformToolsInstalled}`,
    );
  } catch (error) {
    testAndroidAssets = unavailableTestAndroidAssets(androidAssetOptions, error);
    appendMainLog(`test Android assets unavailable: ${testAndroidAssets.error}`);
    if (packagedStartupValidation && process.platform === "win32") {
      finishPackagedStartupValidation(`Test Android assets unavailable: ${testAndroidAssets.error}`);
    } else {
      startupTestAndroidAssetsReady = true;
    }
  }
  const assertTestLicensed = () => deviceLicense!.assertLicensed();
  const testBrowserDriver = new AgentBrowserCliDriver(testBrowserAssets.cliPath, defaultProbeExecutor);
  const testWorkbenchStore = new TestWorkbenchStore(getUserDataPath("test-workbench.json"));
  const testMobileDriver = testAndroidAssets.supported
    ? new HandsetsMobileDriver(testAndroidAssets, process.env, defaultProbeExecutor)
    : undefined;
  const testCoordinator = new MainTestCoordinator({
    browser: testBrowserDriver,
    mobile: testMobileDriver,
    assertLicensed: assertTestLicensed,
    assertBrowserReady: async () => {
      if (!testBrowserAssets.prepared) {
        throw new TestCoordinatorError("BROWSER_ASSETS_UNAVAILABLE", testBrowserAssets.error ?? "浏览器资产不可用");
      }
      const inspected = await testBrowserDriver.inspect();
      if (!readBrowserState(inspected.status, inspected.tabs, testBrowserAssets).ready) {
        throw new TestCoordinatorError(
          "BROWSER_NOT_READY",
          `请连接 Chrome 扩展 ${testBrowserAssets.productExtensionVersion} 并打开普通网页`,
        );
      }
    },
    resolveBrowserBinding: (projectId, projectRoot, surface) =>
      testWorkbenchStore.getBinding(projectId, projectRoot, surface),
    saveBrowserBinding: (projectId, projectRoot, surface, binding) =>
      testWorkbenchStore.setBinding(projectId, projectRoot, surface, binding),
    isConfirmed: () => false,
    identityStatus: (project) =>
      Object.entries(project.identities).map(([id, identity]) => ({
        id,
        name: identity.name,
        surfaces: identity.surfaces,
        defaultSurfaces: Object.entries(project.defaultIdentityBySurface).flatMap(([surface, identityId]) =>
          identityId === id ? [surface as keyof typeof project.surfaces] : [],
        ),
        credentialConfigured: (() => {
          try {
            return credentialVault.has(projectIdentityCredentialKey(project.id, id));
          } catch {
            return false;
          }
        })(),
      })),
    setupReadiness: async (root, project) => {
      const surfaces = [];
      for (const surface of surfaceNames(project)) {
        const configured = getSurfaceReadiness(project, surface);
        if (!configured.ready || surface === "miniprogram") {
          surfaces.push({
            ...configured,
            ready: false,
            status: "manual" as const,
            ...(surface === "miniprogram"
              ? { code: "driver_not_implemented", nextStep: "微信小程序自动化尚未实现" }
              : {}),
          });
          continue;
        }
        if (surface === "app") {
          const mobile = await testWorkbench!.getMobileState(root);
          surfaces.push({
            surface,
            ready: mobile.ready,
            status: mobile.ready ? ("ok" as const) : ("manual" as const),
            ...(mobile.ready ? {} : { code: "mobile_not_ready", nextStep: mobile.summary }),
          });
          continue;
        }
        const browser = await testWorkbench!.getBrowserState(root, surface);
        surfaces.push({
          surface,
          ready: browser.ready && browser.binding?.tabId !== undefined,
          status: browser.ready && browser.binding?.tabId !== undefined ? ("ok" as const) : ("manual" as const),
          ...(browser.ready && browser.binding?.tabId !== undefined
            ? {}
            : { code: "browser_not_ready", nextStep: "请连接固定 Chrome 扩展并绑定测试页面" }),
        });
      }
      return surfaces;
    },
    validateEvidence: (root, evidence) => testWorkbench!.validateEvidence(root, evidence),
    confirmRisk: async ({ projectName, surface, risk, scope, action }) => {
      const win = getMainWindow();
      const target = action.type === "click" || action.type === "fill" ? action.target : action.type;
      const result = await dialog.showMessageBox(win ?? undefined!, {
        type: risk === "high" ? "warning" : "question",
        title: risk === "high" ? "确认高风险测试操作" : "确认本次业务写入范围",
        message: `${projectName} · ${surface.toUpperCase()}`,
        detail:
          scope === "run"
            ? "本次执行允许在该测试端完成已声明的业务写入。高风险动作仍会单独确认。"
            : `动作：${action.type}\n目标：${target}\n风险：高风险`,
        buttons: ["取消", "继续"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  });
  testWorkbench = new TestWorkbenchService(
    testCoordinator,
    testBrowserDriver,
    testWorkbenchStore,
    assertTestLicensed,
    testBrowserAssets,
    (extensionPath) => clipboard.writeText(extensionPath),
    () => openChromeExtensionManager({ platform: process.platform, env: process.env }),
    testAndroidAssets,
    testMobileDriver,
    () => installPlatformTools(testAndroidAssets, androidAssetOptions),
    credentialVault,
    (projectRoot) => shell.trashItem(projectRoot),
    createElectronZentaoFetch(
      (options) => net.request(options),
      async (host) => (await net.resolveHost(host, { cacheUsage: "disallowed" })).endpoints.map((item) => item.address),
    ),
  );
  let testRunsRecovered = false;
  deviceLicense.subscribe((state) => {
    if (state.authorized && !testRunsRecovered) {
      testRunsRecovered = true;
      testWorkbench?.recoverStaleRuns();
    }
    if (!state.authorized && state.phase !== "checking") {
      testCoordinator.authorizationLost();
      hostManager?.stop();
    } else if (state.authorized && hostManager?.getStatus() === "stopped") {
      hostManager.start();
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("test-license:state", state);
    }
  });
  if (deviceLicense.getState().authorized) {
    testRunsRecovered = true;
    testWorkbench.recoverStaleRuns();
  }
  const ui = loadUiState();
  const updaterTestMode = !app.isPackaged && process.env.PI_DESKTOP_TEST_UPDATER === "1";
  const updaterSupported =
    isProductionUpdatePlatformEnabled(process.platform) ||
    (updaterTestMode && (process.platform === "darwin" || process.platform === "win32"));
  const updaterRequested = app.isPackaged || updaterTestMode;
  let updateAdapter = null;
  if (updaterSupported && updaterRequested) {
    try {
      updateAdapter = await createProductionUpdateAdapter({
        useDevelopmentConfig: updaterTestMode,
      });
    } catch (error) {
      appendMainLog(`updater unavailable: ${redactUpdateError(error)}`);
    }
  }
  updateManager = createUpdateManager({
    adapter: updateAdapter,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    automaticChecksEnabled: ui.automaticUpdateChecks !== false,
    prepareToInstall: () => {
      isQuitting = true;
      destroyTray();
      hostManager?.stop();
    },
    recoverFromInstallFailure: () => {
      isQuitting = false;
      createTray(getMainWindow);
      const manager = hostManager;
      if (manager) {
        let remainingAttempts = 12;
        const restartHost = () => {
          if (isQuitting) return;
          manager.start();
          if (manager.getStatus() === "stopped" && remainingAttempts-- > 0) {
            const restartTimer = setTimeout(restartHost, 250);
            restartTimer.unref();
          }
        };
        restartHost();
      }
    },
    log: (level, message) => appendMainLog(`updater[${level}] ${message}`),
  });
  const bundledCorePaths = resolveBundledCorePaths({
    isPackaged: app.isPackaged,
    resourcesRoot: process.resourcesPath,
  });
  const toolchainHome = app.getPath("home");
  toolchainManager = new ToolchainManager({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: toolchainHome,
    tempRoot: app.getPath("temp"),
    userDataRoot: app.getPath("userData"),
    resourcesRoot: process.resourcesPath,
    catalogPath: resolveRuntimeCatalogPath({
      isPackaged: app.isPackaged,
      resourcesRoot: process.resourcesPath,
    }),
    coreCatalogPath: bundledCorePaths.catalogPath,
    bundledCoreRoot: bundledCorePaths.coreRoot,
    // Chromium networking follows the user's system proxy/PAC and OS trust
    // configuration. Redirects are synchronously allowlisted before following.
    fetchImpl: createElectronRuntimeFetch((options) => net.request(options)),
    legacyNpmCommand: readLegacyNpmCommand({ homeDir: toolchainHome, env: process.env }),
    isRuntimeInUse: () => runningAgentSessionCount > 0,
  });
  toolchainManager.subscribe((snapshot) => {
    if (packagedStartupValidation) startupToolchainSnapshot = snapshot;
    appendMainLog(
      `toolchain scan revision=${snapshot.revision} candidates=${snapshot.candidates.length} ready=${snapshot.publicState.coreReady}`,
    );
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("toolchains:state", snapshot.publicState);
    }
    hostManager?.setToolchainSnapshot(snapshot);
    finishPackagedStartupValidation();
  });
  updateManager.subscribe((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("update:state", state);
    }
    if (state.phase === "available") {
      const notificationKey = state.availableVersion ?? "unknown";
      if (lastNotifiedUpdateVersion !== notificationKey) {
        lastNotifiedUpdateVersion = notificationKey;
        const win = getMainWindow();
        const shouldNotify = !win || !win.isVisible() || !win.isFocused();
        if (shouldNotify && Notification.isSupported()) {
          const notification = new Notification({
            title: "Pi Agent Desktop update available",
            body: state.availableVersion
              ? `Version ${state.availableVersion} is ready to download.`
              : "A new version is ready to download.",
          });
          notification.on("click", () => {
            openUpdateSettings(false);
          });
          notification.show();
        }
      }
    }
  });

  // Always register app:// so we can load the built renderer without Vite
  // (npm start after build, or dev fallback when VITE_DEV_SERVER_URL is unset).
  handleAppProtocol(rendererRootPath());

  installDesktopIpc({
    getHostManager: () => hostManager,
    getMainWindow,
    getUnreadBadge: () => unreadBadge,
    applyBadgeCount,
    getToolchainState: (cwd) =>
      cwd ? toolchainManager!.getPublicStateForProject(cwd) : toolchainManager!.getPublicState(),
    rescanToolchains: async (cwd) => {
      await toolchainManager!.rescan({ cwd });
      return cwd ? toolchainManager!.getPublicStateForProject(cwd) : toolchainManager!.getPublicState();
    },
    performToolchainAction: (request) => toolchainManager!.performAction(request),
    chooseCustomTool: (capability, executable) => toolchainManager!.registerCustomTool(capability, executable),
    getTestWorkbench: () => testWorkbench,
    getDeviceLicense: () => deviceLicense,
    updateManager,
  });
  installAppMenu(getMainWindow, () => openUpdateSettings(true));

  createTray(getMainWindow);

  // Apply persisted theme preference
  if (ui.theme === "light" || ui.theme === "dark" || ui.theme === "system") {
    nativeTheme.themeSource = ui.theme;
  }

  hostManager = new HostManager(resolveHostEntry());
  hostManager.setToolchainSnapshot(toolchainManager.getSnapshot());
  hostManager.setRequestHandler(async (method, params) => {
    if (method === "toolchain.getSnapshot") return toolchainManager!.getSnapshot();
    if (method === "toolchain.resolve") {
      const body = (params ?? {}) as { cwd?: unknown; intent?: unknown; trusted?: unknown };
      if (
        typeof body.cwd !== "string" ||
        !path.isAbsolute(body.cwd) ||
        body.cwd.length > 4_096 ||
        /[\0\r\n]/.test(body.cwd) ||
        !isExecutionIntent(body.intent) ||
        typeof body.trusted !== "boolean"
      ) {
        throw new Error("Invalid Host toolchain resolution request");
      }
      return toolchainManager!.resolveForProject(body.cwd, { intent: body.intent, trusted: body.trusted });
    }
    if (
      method === "test.authorizeSession" ||
      method === "test.setup" ||
      method === "test.run" ||
      method === "test.map" ||
      method === "test.case" ||
      method === "test.finding" ||
      method === "test.play" ||
      method === "test.observe" ||
      method === "test.act" ||
      method === "test.sessionEnded"
    ) {
      return testCoordinator.call(method, params as never);
    }
    throw new Error(`Unsupported Host request: ${method}`);
  });
  hostManager.setStatusListener((status, detail) => {
    appendMainLog(`host status=${status} ${detail ?? ""}`);
    if (packagedStartupValidation) {
      startupHostReady = status === "ready";
      if (status === "crashed") finishPackagedStartupValidation(detail ?? "Agent Host crashed");
      else finishPackagedStartupValidation();
    }
    if (status !== "ready") {
      testCoordinator.hostStopped();
      runningAgentSessionCount = 0;
      setTrayRunningCount(0, getMainWindow);
      updateManager?.setRunningSessionCount(0);
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("host:status", { status, detail });
      if (status === "ready" && detail?.includes("restart")) {
        win.webContents.send("host:restarted", { reason: detail });
      }
      if (status === "crashed") {
        win.webContents.send("host:crashed", { detail });
      }
    }
  });

  hostManager.setMessageListener((msg) => {
    if (packagedStartupValidation && msg.type === "toolchain:ack") finishPackagedStartupValidation();
    if (msg.type === "running-sessions") {
      const ids = (msg.sessionIds as string[]) ?? [];
      runningAgentSessionCount = ids.length;
      setTrayRunningCount(ids.length, getMainWindow);
      updateManager?.setRunningSessionCount(ids.length);
    } else if (msg.type === "agent-end") {
      const sessionId = String(msg.sessionId ?? "");
      // Notify if no focused window or window is hidden (desktop value-add)
      const win = getMainWindow();
      const shouldNotify = !win || !win.isVisible() || !win.isFocused();
      if (shouldNotify && Notification.isSupported() && sessionId) {
        const n = new Notification({
          title: "Agent finished",
          body: "A session completed in the background",
        });
        n.on("click", () => {
          const w = getMainWindow();
          if (w) {
            w.show();
            w.focus();
            w.webContents.send("deep-link:session", sessionId);
          }
        });
        n.show();
        applyBadgeCount(unreadBadge + 1);
      }
    } else if (msg.type === "host-restarted") {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("host:restarted", { reason: String(msg.reason ?? "restart") });
      }
    }
  });

  if (deviceLicense.getState().authorized || packagedStartupValidation) hostManager.start();

  createWindow();
  void toolchainManager.initialize();
  updateManager.startAutomaticChecks();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      getMainWindow()?.show();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  updateManager?.stopAutomaticChecks();
  deviceLicense?.stop();
  destroyTray();
  hostManager?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Deep link registration
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("pi-agent-desktop", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("pi-agent-desktop");
}
