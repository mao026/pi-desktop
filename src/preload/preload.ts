/**
 * Preload — expose piBridge only (sandbox + contextIsolation).
 *
 * MessagePort MUST NOT cross contextBridge via Promise resolve — that silently
 * breaks the port. Use window.postMessage transfer instead (Electron docs).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopMenuEvent, DesktopUpdateState, HostStatus, PiBridge } from "../contract/desktop";
import type { TestLicenseState } from "../contract/test-workbench";

// Deliver MessagePort to the page via window.postMessage (transferable).
ipcRenderer.on("desktop:host-port", (event) => {
  const port = event.ports[0];
  if (!port) return;
  // preload: MessagePort transfer to the page
  const g = globalThis as unknown as {
    postMessage: (message: unknown, targetOrigin: string, transfer?: unknown[]) => void;
  };
  g.postMessage({ channel: "pi-desktop-host-port" }, "*", [port]);
});

// ISSUE-016: buffer deep-link until renderer subscribes
let pendingDeepLinkSession: string | null = null;
const deepLinkListeners = new Set<(sessionId: string) => void>();
const menuEvents = [
  "new-session",
  "settings",
  "check-for-updates",
  "show-update",
  "switch-session",
  "export-diagnostics",
] as const satisfies readonly DesktopMenuEvent[];
const menuEventSet = new Set<string>(menuEvents);
const menuListeners = new Map<DesktopMenuEvent, Set<() => void>>();
const pendingMenuEvents = new Set<DesktopMenuEvent>();

ipcRenderer.on("deep-link:session", (_e, sessionId: string) => {
  if (deepLinkListeners.size === 0) {
    pendingDeepLinkSession = sessionId;
    return;
  }
  for (const cb of deepLinkListeners) {
    try {
      cb(sessionId);
    } catch {
      /* ignore */
    }
  }
});

// Main can send a menu command as soon as a newly created page finishes
// loading, before React effects subscribe. Buffer one pending command per
// fixed event so notification/menu navigation is not lost during startup.
for (const event of menuEvents) {
  ipcRenderer.on(`menu:${event}`, () => {
    const listeners = menuListeners.get(event);
    if (!listeners || listeners.size === 0) {
      pendingMenuEvents.add(event);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* ignore renderer listener failures */
      }
    }
  });
}

const bridge: PiBridge = {
  platform: process.platform,
  isDesktop: true,
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),
  getUpdateState: () => ipcRenderer.invoke("desktop:update:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:update:check"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:update:download"),
  installUpdate: () => ipcRenderer.invoke("desktop:update:install"),
  setAutomaticUpdateChecks: (enabled) => ipcRenderer.invoke("desktop:update:set-automatic-checks", enabled),
  getHostStatus: () => ipcRenderer.invoke("desktop:get-host-status"),
  getToolchainState: (cwd) => ipcRenderer.invoke("desktop:toolchains:get-state", cwd),
  rescanToolchains: (cwd) => ipcRenderer.invoke("desktop:toolchains:rescan", cwd),
  performToolchainAction: (request) => ipcRenderer.invoke("desktop:toolchains:action", request),
  requestHostPort: () => {
    ipcRenderer.send("desktop:connect-host");
  },
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  showItemInFolder: (fsPath) => ipcRenderer.invoke("desktop:show-item-in-folder", fsPath),
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  getTestLicenseState: () => ipcRenderer.invoke("desktop:test:get-license-state"),
  refreshTestLicense: () => ipcRenderer.invoke("desktop:test:refresh-license"),
  listRecentProjects: () => ipcRenderer.invoke("desktop:test:list-projects"),
  createProject: (input) => ipcRenderer.invoke("desktop:test:create-project", input),
  updateProject: (input) => ipcRenderer.invoke("desktop:test:update-project", input),
  openProject: (root) => ipcRenderer.invoke("desktop:test:open-project", root),
  setProjectArchived: (projectRoot, archived) =>
    ipcRenderer.invoke("desktop:test:set-project-archived", projectRoot, archived),
  removeProject: (projectRoot) => ipcRenderer.invoke("desktop:test:remove-project", projectRoot),
  deleteProjectData: (projectRoot, confirmationName) =>
    ipcRenderer.invoke("desktop:test:delete-project-data", projectRoot, confirmationName),
  saveIdentity: (input) => ipcRenderer.invoke("desktop:test:save-identity", input),
  deleteIdentity: (projectRoot, identityId) =>
    ipcRenderer.invoke("desktop:test:delete-identity", projectRoot, identityId),
  listZentaoConnections: () => ipcRenderer.invoke("desktop:test:list-zentao-connections"),
  saveZentaoConnection: (input) => ipcRenderer.invoke("desktop:test:save-zentao-connection", input),
  deleteZentaoConnection: (connectionId) => ipcRenderer.invoke("desktop:test:delete-zentao-connection", connectionId),
  getZentaoCatalog: (connectionId, productId) =>
    ipcRenderer.invoke("desktop:test:get-zentao-catalog", connectionId, productId),
  setProjectZentao: (input) => ipcRenderer.invoke("desktop:test:set-project-zentao", input),
  prepareZentaoBug: (projectRoot, findingId) =>
    ipcRenderer.invoke("desktop:test:prepare-zentao-bug", projectRoot, findingId),
  submitZentaoBug: (input) => ipcRenderer.invoke("desktop:test:submit-zentao-bug", input),
  refreshZentaoBug: (projectRoot, findingId) =>
    ipcRenderer.invoke("desktop:test:refresh-zentao-bug", projectRoot, findingId),
  openZentaoBug: (projectRoot, findingId) => ipcRenderer.invoke("desktop:test:open-zentao-bug", projectRoot, findingId),
  appendZentaoRetest: (input) => ipcRenderer.invoke("desktop:test:append-zentao-retest", input),
  getBrowserState: (projectRoot, surface) => ipcRenderer.invoke("desktop:test:get-browser-state", projectRoot, surface),
  copyBrowserExtensionPath: () => ipcRenderer.invoke("desktop:test:copy-browser-extension-path"),
  openBrowserExtensionManager: () => ipcRenderer.invoke("desktop:test:open-browser-extension-manager"),
  getMobileState: (projectRoot) => ipcRenderer.invoke("desktop:test:get-mobile-state", projectRoot),
  installAndroidTools: (projectRoot) => ipcRenderer.invoke("desktop:test:install-android-tools", projectRoot),
  connectMobile: (projectRoot, serial) => ipcRenderer.invoke("desktop:test:connect-mobile", projectRoot, serial),
  confirmForegroundApp: (projectRoot, serial) =>
    ipcRenderer.invoke("desktop:test:confirm-foreground-app", projectRoot, serial),
  bindBrowser: (projectRoot, surface, profileId, tabId) =>
    ipcRenderer.invoke("desktop:test:bind-browser", projectRoot, surface, profileId, tabId),
  setCaseStatus: (projectRoot, caseId, status) =>
    ipcRenderer.invoke("desktop:test:set-case-status", projectRoot, caseId, status),
  playCases: (projectRoot, sessionId, caseIds) =>
    ipcRenderer.invoke("desktop:test:play-cases", projectRoot, sessionId, caseIds),
  startRun: (projectRoot, sessionId, surface, title) =>
    ipcRenderer.invoke("desktop:test:start-run", projectRoot, sessionId, surface, title),
  controlRun: (projectRoot, sessionId, request) =>
    ipcRenderer.invoke("desktop:test:control-run", projectRoot, sessionId, request),
  finishRun: (projectRoot, sessionId, status, summaryText) =>
    ipcRenderer.invoke("desktop:test:finish-run", projectRoot, sessionId, status, summaryText),
  observe: (projectRoot, sessionId, surface, mode) =>
    ipcRenderer.invoke("desktop:test:observe", projectRoot, sessionId, surface, mode),
  act: (projectRoot, sessionId, surface, risk, action) =>
    ipcRenderer.invoke("desktop:test:act", projectRoot, sessionId, surface, risk, action),
  readEvidence: (projectRoot, evidence) => ipcRenderer.invoke("desktop:test:read-evidence", projectRoot, evidence),
  createFinding: (input) => ipcRenderer.invoke("desktop:test:create-finding", input),
  saveFile: (opts) => ipcRenderer.invoke("desktop:save-file", opts),
  saveBinaryFile: (opts) => ipcRenderer.invoke("desktop:save-binary-file", opts),
  createHtmlPreview: (content, filePath, sourceSessionId) =>
    ipcRenderer.invoke("desktop:create-html-preview", content, filePath, sourceSessionId),
  releaseHtmlPreview: (previewUrl) => ipcRenderer.invoke("desktop:release-html-preview", previewUrl),
  notifyAgentEnd: (payload) => {
    ipcRenderer.send("desktop:notify-agent-end", payload);
  },
  setBadgeCount: (n) => {
    ipcRenderer.send("desktop:set-badge-count", n);
  },
  getUiState: () => ipcRenderer.invoke("desktop:get-ui-state"),
  setUiState: (patch) => ipcRenderer.invoke("desktop:set-ui-state", patch),
  getThemeSource: () => ipcRenderer.invoke("desktop:get-theme-source"),
  setThemeSource: (source) => ipcRenderer.invoke("desktop:set-theme-source", source),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  clearBadge: () => {
    ipcRenderer.send("desktop:set-badge-count", 0);
  },
  onHostStatus: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: { status: HostStatus; detail?: string }) => cb(data);
    ipcRenderer.on("host:status", handler);
    return () => ipcRenderer.removeListener("host:status", handler);
  },
  onHostRestarted: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: { reason: string }) => cb(data);
    ipcRenderer.on("host:restarted", handler);
    return () => ipcRenderer.removeListener("host:restarted", handler);
  },
  onHostCrashed: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, data: { detail?: string }) => cb(data);
    ipcRenderer.on("host:crashed", handler);
    return () => ipcRenderer.removeListener("host:crashed", handler);
  },
  onUpdateState: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, state: DesktopUpdateState) => cb(state);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
  onToolchainState: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
    ipcRenderer.on("toolchains:state", handler);
    return () => ipcRenderer.removeListener("toolchains:state", handler);
  },
  onTestLicenseState: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, state: TestLicenseState) => cb(state);
    ipcRenderer.on("test-license:state", handler);
    return () => ipcRenderer.removeListener("test-license:state", handler);
  },
  onDeepLinkSession: (cb) => {
    deepLinkListeners.add(cb);
    if (pendingDeepLinkSession) {
      const id = pendingDeepLinkSession;
      pendingDeepLinkSession = null;
      try {
        cb(id);
      } catch {
        /* ignore */
      }
    }
    return () => {
      deepLinkListeners.delete(cb);
    };
  },
  onMenu: (event, cb) => {
    if (!menuEventSet.has(event)) return () => undefined;
    const fixedEvent = event as DesktopMenuEvent;
    const listeners = menuListeners.get(fixedEvent) ?? new Set<() => void>();
    listeners.add(cb);
    menuListeners.set(fixedEvent, listeners);
    if (pendingMenuEvents.delete(fixedEvent)) {
      try {
        cb();
      } catch {
        /* ignore renderer listener failures */
      }
    }
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) menuListeners.delete(fixedEvent);
    };
  },
};

contextBridge.exposeInMainWorld("piBridge", bridge);

contextBridge.exposeInMainWorld("piDesktop", {
  platform: bridge.platform,
  isDesktop: true as const,
  getVersion: bridge.getVersion,
  notifyAgentEnd: bridge.notifyAgentEnd,
  setBadgeCount: bridge.setBadgeCount,
  openExternal: bridge.openExternal,
  showItemInFolder: bridge.showItemInFolder,
});
