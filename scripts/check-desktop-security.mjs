#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("src/main/main.ts");
const windowFactory = read("src/main/window.ts");
const protocol = read("src/main/protocol.ts");
const html = read("src/renderer/index.html");
const preload = read("src/preload/preload.ts");
const globals = read("src/renderer/global.d.ts");
const diagnostics = read("src/main/diagnostics.ts");
const diagnosticsRedaction = read("src/main/diagnostics-redaction.ts");
const credentialVault = read("src/main/credential-vault.ts");
const credentialKey = read("src/main/credential-key.ts");
const testWorkbenchService = read("src/main/test-workbench-service.ts");
const deviceLicense = read("src/main/device-license.ts");
const deviceLicenseFetch = read("src/main/device-license-fetch.ts");
const testWorkbenchContract = read("src/contract/test-workbench.ts");
const rpcManager = read("src/agent-host/rpc-manager.ts");
const desktopContract = read("src/contract/desktop.ts");
const desktopIpc = read("src/main/ipc.ts");
const updateAdapter = read("src/main/update-adapter.ts");
const updateManager = read("src/main/update-manager.ts");
const electronBuilderConfig = read("electron-builder.yml");
const desktopBuildWorkflow = read(".github/workflows/build-desktop.yml");
const toolchainContractCheck = read("scripts/check-toolchain-contract.mjs");
const upstreamToolchainCatalogCheck = read("scripts/verify-toolchain-catalog-upstream.mjs");
const bundledToolsBuild = read("scripts/prepare-bundled-tools.mjs");
const browserAssetCatalog = read("config/test-browser-assets.json");
const androidAssetCatalog = read("config/test-android-assets.json");
const browserPopup = `${read("config/chrome-extension-patch/popup.js")}\n${read("config/chrome-extension-patch/popup.html")}`;
const testBrowserAssets = read("src/main/test-browser-assets.ts");
const testAndroidAssets = read("src/main/test-android-assets.ts");
const testMobileDriver = read("src/main/test-mobile-driver.ts");
const testCoordinator = read("src/main/test-coordinator.ts");
const testExtension = read("packages/pi-test/extension/index.ts");
const testCaseCore = read("packages/pi-test/core/case.ts");
const testCaptureCore = read("packages/pi-test/core/capture.ts");
const testFindingCore = read("packages/pi-test/core/finding.ts");
const zentaoClient = read("src/main/zentao-client.ts");
const zentaoFetch = read("src/main/zentao-fetch.ts");
const testProjectCore = read("packages/pi-test/core/project.ts");
const packagedToolchainVerifier = read("scripts/verify-packaged-toolchains.mjs");
const toolchainSearch = read("src/agent-host/toolchain-search.ts");
const toolchainInstaller = read("src/main/toolchains/installer.ts");
const toolchainManager = read("src/main/toolchains/manager.ts");
const electronRuntimeFetch = read("src/main/toolchains/electron-runtime-fetch.ts");
const legacyNpmCommand = read("src/main/toolchains/legacy-npm-command.ts");
const toolchainStateStore = read("src/main/toolchains/state-store.ts");
const verifyScript = read("scripts/verify.mjs");
const rendererCsp = protocol.slice(protocol.indexOf("const CSP ="), protocol.indexOf("const HTML_PREVIEW_CSP ="));

const checks = [
  [windowFactory.includes("sandbox: true"), "BrowserWindow sandbox must remain enabled"],
  [windowFactory.includes("contextIsolation: true"), "context isolation must remain enabled"],
  [windowFactory.includes("nodeIntegration: false"), "renderer Node integration must remain disabled"],
  [main.includes("crashReporter.start"), "local crash reporting must be started"],
  [
    main.includes("createElectronRuntimeFetch") &&
      main.includes("net.request") &&
      !main.includes("net.fetch") &&
      electronRuntimeFetch.includes("request.followRedirect()") &&
      electronRuntimeFetch.includes("assertRuntimeRedirectUrl") &&
      main.includes("fetchImpl:") &&
      toolchainInstaller.includes("fetchImpl: options.fetchImpl"),
    "managed downloads must use Electron networking with synchronous redirect checks so system proxy and trust settings remain effective",
  ],
  [main.includes("setOverlayIcon"), "Windows taskbar overlay badges must remain implemented"],
  [
    diagnostics.includes('app.getPath("crashDumps")') &&
      diagnostics.includes("collectCrashMetadata") &&
      diagnostics.includes("MAX_LOG_BYTES") &&
      !diagnostics.includes("fs.cpSync") &&
      diagnosticsRedaction.includes("redactDiagnosticText") &&
      diagnosticsRedaction.includes("<redacted-token>") &&
      diagnosticsRedaction.includes("buildToolchainDiagnosticSummary"),
    "diagnostic export must redact bounded logs, summarize toolchains, and exclude raw crash process memory",
  ],
  [!/script-src[^;]*unsafe-inline/.test(rendererCsp), "renderer script-src must not allow unsafe-inline"],
  [
    protocol.includes("\"object-src 'none'; \"") && protocol.includes("\"form-action 'none'\""),
    "HTML preview CSP must block plugins and forms",
  ],
  [
    desktopBuildWorkflow.includes("check:toolchain-catalog:upstream") &&
      upstreamToolchainCatalogCheck.includes("SHASUMS256.txt") &&
      upstreamToolchainCatalogCheck.includes("asset.digest") &&
      upstreamToolchainCatalogCheck.includes("asset.size"),
    "tag releases must verify managed runtime checksums and sizes against official upstream metadata",
  ],
  [
    rpcManager.includes("createDesktopSearchToolDefinitions") &&
      toolchainSearch.includes("allowUpstreamDownload: false") &&
      !toolchainSearch.includes("ensureTool") &&
      !toolchainSearch.includes("releases/latest") &&
      bundledToolsBuild.includes("downloadRuntimeArtifact") &&
      bundledToolsBuild.includes("verifyDownloadedArtifact"),
    "Desktop grep/find must use injected rg/fd descriptors and fixed build-time assets without upstream dynamic downloads",
  ],
  [
    browserAssetCatalog.includes('"cliVersion": "0.3.7"') &&
      browserAssetCatalog.includes('"productExtensionVersion": "2.1-pi-test.2"') &&
      bundledToolsBuild.includes("prepareBrowserAssets") &&
      bundledToolsBuild.includes("verifyDownloadedArtifact") &&
      bundledToolsBuild.includes("rawSendCount !== 10") &&
      bundledToolsBuild.includes("function sendWs(message)") &&
      bundledToolsBuild.includes("socket.readyState !== WebSocket.OPEN") &&
      bundledToolsBuild.includes('replaceAll("ws.send(", "sendWs(")') &&
      testBrowserAssets.includes("prepareTestBrowserAssets") &&
      testBrowserAssets.includes("asset integrity check failed") &&
      testBrowserAssets.includes('const lockName = ".agent-browser-cli.lock"') &&
      testBrowserAssets.includes("lock.size !== 0") &&
      testBrowserAssets.includes('path.win32.join(localAppData, "PiTestDesktop")') &&
      !/cookie|clipboard/i.test(browserPopup),
    "test browser CLI and patched Chrome extension must be fixed build-time assets, guard every WebSocket send, verify private installation, and expose no popup cookie or clipboard access",
  ],
  [
    androidAssetCatalog.includes('"version": "0.1.38"') &&
      androidAssetCatalog.includes('"version": "37.0.1"') &&
      bundledToolsBuild.includes("prepareWindowsHandsets") &&
      testAndroidAssets.includes("prepareTestAndroidAssets") &&
      testAndroidAssets.includes("installPlatformTools") &&
      testAndroidAssets.includes("Android asset integrity check failed") &&
      testAndroidAssets.includes('path.win32.join(localAppData, "PiTestDesktop", "test-android")') &&
      testMobileDriver.includes("PATH: assets.platformToolsPath") &&
      testMobileDriver.includes("executable: this.assets.adbPath") &&
      testMobileDriver.includes("executable: this.assets.hsPath") &&
      !testMobileDriver.includes("process.env.PATH") &&
      !testCoordinator.includes('action.type === "shell"'),
    "Android testing must use fixed private Handsets/platform-tools assets and expose no arbitrary shell action",
  ],
  [
    testCoordinator.includes('request.action === "pause"') &&
      testCoordinator.includes('request.action === "takeover"') &&
      testCoordinator.includes('request.action === "resume"') &&
      testCoordinator.includes("completePendingControl") &&
      testCoordinator.includes('control.state !== "running"') &&
      testCoordinator.includes("businessWriteConfirmedSurfaces") &&
      testCoordinator.includes("RUN_SCOPE_CONFIRMATION_REQUIRED") &&
      testCoordinator.includes('scope: "run"') &&
      testCoordinator.includes('scope: "action"') &&
      testCoordinator.includes('project.environment === "production" && request.risk === "business_write"'),
    "pause, takeover, resume, run-scoped business-write confirmation, and production read-only gates must remain Main-owned",
  ],
  [
    testExtension.includes('"test_setup"') &&
      testExtension.includes('"test_map"') &&
      testExtension.includes('"test_case"') &&
      testExtension.includes('"test_play"') &&
      testExtension.includes('"test_finding"') &&
      testExtension.includes('method === "test.play" ? 30 * 60_000 : 40_000') &&
      main.includes('method === "test.setup"') &&
      main.includes('method === "test.map"') &&
      main.includes('method === "test.case"') &&
      main.includes('method === "test.play"') &&
      main.includes('method === "test.finding"') &&
      testCoordinator.includes('request.trigger ?? "manual"') &&
      testCoordinator.includes('throw new TestCoordinatorError("CASE_NOT_STABLE"') &&
      testCoordinator.includes("caseHasProductionUnsafeAction") &&
      testCoordinator.includes("compileCapturePattern") &&
      testCaseCore.includes("hasSuccessfulRun") &&
      testCaseCore.includes("miniprogram case 不能晋级 stable") &&
      testCaptureCore.includes("capture pattern 必须且只能有一个捕获组") &&
      testWorkbenchService.includes("jpe?g|txt") &&
      !testExtension.includes('Type.Literal("shell")'),
    "domain tools and deterministic playback must remain Main-owned, stable-gated, capture-bounded, and free of arbitrary script or shell inputs",
  ],
  [
    testProjectCore.includes("visualModel?: VisualModelRef") &&
      testProjectCore.includes("visualCheck: opts.visualCheck ?? false") &&
      desktopIpc.includes('title: "明显视觉异常检查"') &&
      desktopIpc.includes("截图只发送给当前选择的视觉模型") &&
      testExtension.includes("analyzeVisual") &&
      testExtension.includes("if (!value.visualModel) throw new Error") &&
      testExtension.includes("delete details.image") &&
      rpcManager.includes("analyzeVisualScreenshot") &&
      testCoordinator.includes("SENSITIVE_VISUAL_PAGE") &&
      testCoordinator.includes("project.defaults?.visualCheck !== true") &&
      testCoordinator.includes('throw new TestCoordinatorError("VISUAL_MODEL_REQUIRED"') &&
      testCoordinator.indexOf("SENSITIVE_VISUAL_PAGE.test(observed.text)") <
        testCoordinator.indexOf('captureEvidence(root, project, request.surface as SupportedSurface, "visual-check")'),
    "visual checks must be project opt-in, image-model gated, sensitive-page blocked before capture, and keep screenshot base64 out of tool details",
  ],
  [
    main.includes("shell.trashItem(projectRoot)") &&
      desktopIpc.includes('"desktop:test:set-project-archived"') &&
      desktopIpc.includes('"desktop:test:remove-project"') &&
      desktopIpc.includes('"desktop:test:delete-project-data"') &&
      desktopIpc.includes("getProjectDeletionSummary") &&
      testWorkbenchService.includes("confirmationName !== project.name") &&
      testWorkbenchService.includes("await this.trashProject(root)") &&
      !testWorkbenchService.includes("rmSync(projectRoot"),
    "project archive, registration removal, and local-data deletion must be separate Main-owned operations using the system trash and name confirmation",
  ],
  [
    main.includes('app.isPackaged && process.argv.includes("--validate-packaged-startup")') &&
      main.includes("packaged-startup-check.json") &&
      main.includes("getToolchainAckRevision") &&
      main.includes("startupTestBrowserAssetsReady") &&
      main.includes("startupTestAndroidAssetsReady") &&
      main.includes("testBrowserExtensionVersion") &&
      main.includes("testHandsetsVersion") &&
      main.includes('candidate.provider === "bundled"') &&
      main.includes('candidate.health === "healthy"'),
    "the production startup probe must be packaged-only and require Renderer, Host revision ack, healthy bundled search tools, and verified test browser/Android assets",
  ],
  [
    packagedToolchainVerifier.includes("darwin-arm64|darwin-x64|win32-x64|linux-x64") &&
      packagedToolchainVerifier.includes(
        'assertExact(entries, ["core", "core-catalog.json", "runtime-catalog.json"]',
      ) &&
      packagedToolchainVerifier.includes("verifyManifestFile") &&
      packagedToolchainVerifier.includes("verifyTestBrowserAssets") &&
      packagedToolchainVerifier.includes("verifyTestAndroidAssets") &&
      packagedToolchainVerifier.includes("2\\.1-pi-test") &&
      packagedToolchainVerifier.includes("verifyLinuxSandbox") &&
      packagedToolchainVerifier.includes("stat.uid !== 0") &&
      packagedToolchainVerifier.includes('spawnSync(byComponent.get("ripgrep")') &&
      packagedToolchainVerifier.includes("runPackagedStartup") &&
      packagedToolchainVerifier.includes("verifyLinuxAppImageDesktopEntry") &&
      packagedToolchainVerifier.includes('APPIMAGE_EXTRACT_AND_RUN: "1"') &&
      packagedToolchainVerifier.includes("hostAckRevision !== report.revision") &&
      packagedToolchainVerifier.includes('report.testBrowserCliVersion !== "0.3.7"') &&
      packagedToolchainVerifier.includes('report.testHandsetsVersion !== "0.1.38"'),
    "the packaged E2E must enforce the release matrix, exact resources, hashes, functional rg/fd, and production startup ack",
  ],
  [
    ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"].every((target) => desktopBuildWorkflow.includes(target)) &&
      desktopBuildWorkflow.includes("check:packaged-toolchains") &&
      desktopBuildWorkflow.includes("release-linux") &&
      desktopBuildWorkflow.includes("xvfb-run --auto-servernum") &&
      desktopBuildWorkflow.includes("sudo chown root:root dist/linux-unpacked/chrome-sandbox") &&
      desktopBuildWorkflow.includes("sudo chmod 4755 dist/linux-unpacked/chrome-sandbox") &&
      electronBuilderConfig.includes("executableName: pi-agent-desktop") &&
      electronBuilderConfig.includes("--appimage-desktop-launch") &&
      !electronBuilderConfig.includes("--no-sandbox") &&
      desktopBuildWorkflow.includes("Pi-Agent-Desktop-${version}-x86_64.AppImage"),
    "CI and tag releases must run packaged toolchain E2E for every supported target, including Linux under Xvfb",
  ],
  [
    toolchainInstaller.includes("previousRoot") &&
      toolchainInstaller.includes("fs.renameSync(finalRoot, previousRoot)") &&
      toolchainInstaller.includes("this.stateStore.update") &&
      toolchainInstaller.includes("fs.renameSync(previousRoot, finalRoot)") &&
      toolchainInstaller.indexOf("this.stateStore.update") < toolchainInstaller.indexOf("fs.rmSync(previousRoot"),
    "managed activation must preserve the previous same-version runtime until the new state is durable",
  ],
  [
    toolchainInstaller.includes("recoverInterruptedOperations") &&
      toolchainInstaller.includes("cleanupPartialDownloads") &&
      toolchainInstaller.includes("recoverPreviousRuntimeDirectories") &&
      toolchainInstaller.includes("TOOLCHAIN_CANCELLED") &&
      toolchainManager.includes("cancelComponentInstall") &&
      toolchainManager.includes("isRuntimeInUse()"),
    "managed installs must support cancellation, crash-residue recovery, and in-use removal protection",
  ],
  [
    main.includes("readLegacyNpmCommand") &&
      legacyNpmCommand.includes("MAX_SETTINGS_BYTES") &&
      legacyNpmCommand.includes("validateLegacyNpmCommand") &&
      !legacyNpmCommand.includes("writeFile") &&
      toolchainManager.includes('intent === "plugin-install"') &&
      toolchainManager.includes('candidate.discovery === "legacy-npm-command"'),
    "legacy npmCommand migration must remain bounded, read-only, probed, and scoped to plugin compatibility",
  ],
  [
    toolchainStateStore.includes("hasFutureSchema") &&
      toolchainStateStore.includes("compatibilityReadOnly") &&
      toolchainStateStore.includes("primaryHasFutureSchema") &&
      toolchainStateStore.includes("written by a newer Pi Desktop"),
    "future toolchain state must remain read-only so application rollback cannot overwrite managed runtime ownership",
  ],
  [!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "renderer HTML must not contain inline scripts"],
  [preload.includes("../contract/desktop"), "preload must use the shared desktop bridge contract"],
  [globals.includes("../contract/desktop"), "renderer globals must use the shared desktop bridge contract"],
  [credentialVault.includes("safeStorage.encryptString"), "credentials must use Electron safeStorage"],
  [credentialVault.includes("safeStorage.isEncryptionAvailable"), "credential persistence must fail closed"],
  [
    credentialKey.includes('"device:license:identity"') &&
      credentialKey.includes("projectIdentityCredentialKey") &&
      credentialKey.includes("test:project:${projectId}:identity:${identityId}") &&
      credentialVault.includes("validateCredentialKey(key)") &&
      credentialVault.includes("has(key: string)") &&
      testWorkbenchService.includes("credentialConfigured") &&
      testWorkbenchService.includes("this.identityVault.set") &&
      !testWorkbenchContract.includes("getIdentityCredential") &&
      !testWorkbenchContract.includes("readIdentityCredential") &&
      deviceLicense.includes('const IDENTITY_KEY = "device:license:identity"') &&
      deviceLicense.includes('const IDENTITY_KEY = "device:license:identity"') &&
      deviceLicense.includes('generateKeyPairSync("ed25519")') &&
      deviceLicense.includes('privateKey.export({ format: "der", type: "pkcs8" })'),
    "device and project identities must persist only through allowlisted safeStorage keys, with project credentials exposed as write-only configured state",
  ],
  [
    credentialKey.includes("zentaoTokenCredentialKey") &&
      credentialKey.includes("test:zentao:${connectionId}:token") &&
      testProjectCore.includes("connectionId: string") &&
      !testProjectCore.includes("token:") &&
      testFindingCore.includes("FindingRemoteSyncStatus") &&
      testFindingCore.includes("setFindingRemote") &&
      testWorkbenchService.includes("value.baseUrl !== baseUrl") &&
      testWorkbenchService.includes("ZENTAO_REAUTH_REQUIRED") &&
      zentaoClient.includes('headers.set("Token", this.token)') &&
      zentaoClient.includes('redirect: "error"') &&
      zentaoClient.includes("MAX_JSON_BYTES") &&
      zentaoClient.includes("findBugByMarker") &&
      zentaoClient.includes("Pi-Test:") &&
      zentaoFetch.includes('redirect: "manual"') &&
      zentaoFetch.includes("MAX_RESPONSE_BYTES") &&
      zentaoFetch.includes("isUnsafeZentaoHost") &&
      desktopIpc.includes('title: "提交禅道 Bug"') &&
      desktopIpc.includes('title: "使用未加密的禅道连接"') &&
      desktopIpc.includes('"desktop:test:open-zentao-bug"') &&
      desktopIpc.includes("workbench.getZentaoBugUrl") &&
      !testWorkbenchContract.includes("token: string") &&
      !testExtension.includes("zentao"),
    "ZenTao must keep tokens in the Main vault, bound and redirect-free network access, stable-marker deduplication, Main confirmations, and no Agent tool surface",
  ],
  [
    deviceLicense.includes('cache: "no-store"') &&
      deviceLicense.includes('redirect: "error"') &&
      deviceLicenseFetch.includes('redirect: "manual"') &&
      deviceLicenseFetch.includes("Device license redirect rejected") &&
      deviceLicense.includes("MAX_LICENSE_BYTES") &&
      deviceLicense.includes("verify(null,") &&
      deviceLicense.includes("Cached licenses never authorize") &&
      testWorkbenchContract.includes("deviceFingerprint: string | null"),
    "online device authorization must be bounded, signed, redirect-free, and fail closed without cache authorization",
  ],
  [
    toolchainContractCheck.includes("ToolchainActionRequest") &&
      toolchainContractCheck.includes("forbiddenPattern") &&
      toolchainContractCheck.includes("url|uri|sha|hash|path|executable|argv|command") &&
      verifyScript.includes('run("toolchain contract safety"'),
    "renderer toolchain actions must retain the URL/hash/path/executable/argv/command safety gate",
  ],
  [
    desktopContract.includes("getToolchainState") &&
      desktopContract.includes("rescanToolchains") &&
      desktopContract.includes("performToolchainAction") &&
      desktopContract.includes("onToolchainState") &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:get-state"') &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:rescan"') &&
      preload.includes('ipcRenderer.invoke("desktop:toolchains:action"') &&
      preload.includes('ipcRenderer.on("toolchains:state"') &&
      desktopIpc.includes('ipcMain.handle("desktop:toolchains:get-state"') &&
      desktopIpc.includes('ipcMain.handle("desktop:toolchains:rescan"') &&
      desktopIpc.includes('ipcMain.handle("desktop:toolchains:action"') &&
      desktopIpc.includes("isToolchainActionRequest") &&
      desktopIpc.includes("assertTrustedToolchainSender(event)") &&
      desktopIpc.includes("event.senderFrame !== win.webContents.mainFrame") &&
      desktopIpc.includes("toolchainActionConfirmation(request)") &&
      desktopIpc.includes("dialog.showMessageBox") &&
      desktopIpc.includes("validateOptionalToolchainCwd"),
    "toolchain bridge must validate senders/actions/workspaces and keep download/destructive consent in Main",
  ],
  [
    main.includes('method === "toolchain.resolve"') &&
      main.includes('typeof body.trusted !== "boolean"') &&
      !desktopContract.includes("trustedProject") &&
      !desktopContract.includes("projectTrusted"),
    "project-local tool trust must come from the app-owned Host and never from the Renderer bridge",
  ],
  [
    desktopContract.includes("getUpdateState") &&
      desktopContract.includes("checkForUpdates") &&
      desktopContract.includes("downloadUpdate") &&
      desktopContract.includes("installUpdate") &&
      !/(?:setFeedURL|feedUrl|feedURL)/.test(desktopContract),
    "renderer updater contract must expose fixed actions without a configurable feed",
  ],
  [
    preload.includes('ipcRenderer.invoke("desktop:update:check")') &&
      preload.includes('ipcRenderer.invoke("desktop:update:download")') &&
      preload.includes('ipcRenderer.invoke("desktop:update:install")') &&
      preload.includes('ipcRenderer.on("update:state"'),
    "preload updater bridge must use fixed IPC channels",
  ],
  [
    desktopIpc.includes('ipcMain.handle("desktop:update:set-automatic-checks"') &&
      desktopIpc.includes('typeof enabled !== "boolean"') &&
      !/(?:setFeedURL|feedUrl|feedURL)/.test(desktopIpc),
    "updater IPC must validate its only mutable preference and reject feed configuration",
  ],
  [
    updateAdapter.includes("updater.autoDownload = false") &&
      updateAdapter.includes("updater.autoInstallOnAppQuit = true") &&
      updateAdapter.includes("updater.allowPrerelease = false") &&
      updateAdapter.includes("updater.allowDowngrade = false") &&
      updateAdapter.includes("updater.disableWebInstaller = true") &&
      updateAdapter.includes("updater.logger = null") &&
      updateAdapter.includes('platform === "darwin"') &&
      updateAdapter.includes('platform === "win32"') &&
      !updateAdapter.includes("WINDOWS_UPDATES_RELEASE_READY") &&
      !updateAdapter.includes("process.env"),
    "production updater must support macOS and Windows while remaining stable-only, consent-first, and using redacted application logging",
  ],
  [
    !/^\s*publisherName\s*:/im.test(electronBuilderConfig) &&
      desktopBuildWorkflow.includes("publisherName field in an unsigned Windows release") &&
      desktopBuildWorkflow.includes("/^\\s*publisherName\\s*:/im"),
    "unsigned Windows updates must omit publisher verification in both build configuration and packaged release checks",
  ],
  [
    updateManager.includes('platform === "darwin" || platform === "win32"') &&
      updateManager.includes("options.isPackaged || explicitlyEnabledForDevelopment") &&
      updateManager.includes("redactUpdateError") &&
      updateManager.includes("setRunningSessionCount"),
    "updater manager must retain platform/package gating, redaction, and active-session protection",
  ],
  [
    main.includes("createProductionUpdateAdapter") &&
      main.includes('win.webContents.send("update:state", state)') &&
      main.includes("updateManager?.setRunningSessionCount(ids.length)") &&
      main.includes("updateManager.startAutomaticChecks()"),
    "main process must own updater initialization, state publication, and session-aware scheduling",
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`OK: ${checks.length} desktop security invariants hold`);
