import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopUpdateState, SaveBinaryFileOptions, SaveTextFileOptions } from "../contract/desktop";
import type {
  TestWorkbenchCreateProjectInput,
  TestWorkbenchFindingInput,
  TestWorkbenchIdentityInput,
  TestWorkbenchUpdateProjectInput,
  TestWorkbenchZentaoConnectionInput,
  TestWorkbenchZentaoProjectInput,
  TestWorkbenchZentaoRetestInput,
  TestWorkbenchZentaoSubmitBugInput,
} from "../contract/test-workbench";
import { exportDiagnostics } from "./diagnostics";
import type { HostManager } from "./host-manager";
import { appendMainLog, getMainLogPath } from "./logger";
import { createHtmlPreviewUrl, releaseHtmlPreviewUrl } from "./protocol";
import { loadUiState, saveUiState } from "./window-state";
import path from "node:path";
import {
  isToolchainActionRequest,
  type PublicToolchainState,
  type ToolchainActionRequest,
} from "../shared/toolchains/types";
import { ToolchainError } from "../shared/toolchains/errors";
import type { TestWorkbenchService } from "./test-workbench-service";
import type { DeviceLicenseService } from "./device-license";

export type DesktopIpcOptions = {
  getHostManager: () => HostManager | null;
  getMainWindow: () => BrowserWindow | null;
  getUnreadBadge: () => number;
  applyBadgeCount: (count: number) => void;
  getToolchainState: (cwd?: string) => PublicToolchainState | Promise<PublicToolchainState>;
  rescanToolchains: (cwd?: string) => Promise<PublicToolchainState>;
  performToolchainAction: (request: ToolchainActionRequest) => Promise<PublicToolchainState>;
  chooseCustomTool: (
    capability: Extract<ToolchainActionRequest, { action: "choose-custom-tool" }>["capability"],
    executable: string,
  ) => Promise<PublicToolchainState>;
  getTestWorkbench: () => TestWorkbenchService | null;
  getDeviceLicense: () => DeviceLicenseService | null;
  updateManager: {
    getState: () => DesktopUpdateState;
    checkForUpdates: () => Promise<DesktopUpdateState>;
    downloadUpdate: () => Promise<DesktopUpdateState>;
    installUpdate: () => Promise<void>;
    setAutomaticChecksEnabled: (enabled: boolean) => DesktopUpdateState;
  };
};

export function installDesktopIpc(options: DesktopIpcOptions): void {
  const {
    getHostManager,
    getMainWindow,
    getUnreadBadge,
    applyBadgeCount,
    getToolchainState,
    rescanToolchains,
    performToolchainAction,
    chooseCustomTool,
    getTestWorkbench,
    getDeviceLicense,
    updateManager,
  } = options;
  const assertTrustedToolchainSender = (event: IpcMainInvokeEvent): void => {
    const win = getMainWindow();
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    ) {
      throw new Error("Untrusted toolchain IPC sender");
    }
  };
  const requireTrustedTestWorkbench = (event: IpcMainInvokeEvent): TestWorkbenchService => {
    assertTrustedToolchainSender(event);
    const workbench = getTestWorkbench();
    if (!workbench) throw new Error("TEST_WORKBENCH_UNAVAILABLE: 测试工作台不可用");
    return workbench;
  };
  const testHandler = <T extends unknown[], R>(
    channel: string,
    handler: (workbench: TestWorkbenchService, ...args: T) => R | Promise<R>,
  ): void => {
    ipcMain.handle(channel, async (event, ...args: T) => {
      try {
        return await handler(requireTrustedTestWorkbench(event), ...args);
      } catch (error) {
        if (error instanceof Error && "code" in error) {
          throw new Error(`${String((error as { code?: unknown }).code)}: ${error.message}`);
        }
        throw error;
      }
    });
  };
  ipcMain.handle("desktop:get-version", () => app.getVersion());
  ipcMain.handle("desktop:update:get-state", () => updateManager.getState());
  ipcMain.handle("desktop:update:check", () => updateManager.checkForUpdates());
  ipcMain.handle("desktop:update:download", () => updateManager.downloadUpdate());
  ipcMain.handle("desktop:update:install", () => updateManager.installUpdate());
  ipcMain.handle("desktop:update:set-automatic-checks", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Automatic update checks must be a boolean");
    saveUiState({ automaticUpdateChecks: enabled });
    return updateManager.setAutomaticChecksEnabled(enabled);
  });
  ipcMain.handle("desktop:get-host-status", () => getHostManager()?.getStatus() ?? "stopped");
  ipcMain.handle("desktop:toolchains:get-state", (event, cwd: unknown) => {
    assertTrustedToolchainSender(event);
    return getToolchainState(validateOptionalToolchainCwd(cwd));
  });
  ipcMain.handle("desktop:toolchains:rescan", (event, cwd: unknown) => {
    assertTrustedToolchainSender(event);
    const validatedCwd = validateOptionalToolchainCwd(cwd);
    return rescanToolchains(validatedCwd);
  });
  ipcMain.handle("desktop:toolchains:action", async (event, request: unknown) => {
    assertTrustedToolchainSender(event);
    if (!isToolchainActionRequest(request)) throw new Error("Invalid toolchain action request");
    if (request.action === "choose-custom-tool") {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        title: `Choose executable for ${request.capability}`,
        properties: ["openFile", "dontAddToRecent"],
      });
      if (result.canceled || !result.filePaths[0]) {
        throw new Error("TOOLCHAIN_CANCELLED: Custom tool selection was cancelled");
      }
      return chooseCustomTool(request.capability, result.filePaths[0]);
    }
    const confirmation = toolchainActionConfirmation(request);
    if (confirmation) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showMessageBox(win ?? undefined!, confirmation);
      if (result.response !== 1) throw new Error("TOOLCHAIN_CANCELLED: Toolchain action was cancelled");
    }
    try {
      return await performToolchainAction(request);
    } catch (error) {
      if (error instanceof ToolchainError) {
        appendMainLog(
          `toolchain action=${request.action} failed code=${error.code}${error.causeCode ? ` cause=${error.causeCode}` : ""}`,
        );
        throw new Error(`${error.code}: ${error.message}`);
      }
      appendMainLog(`toolchain action=${request.action} failed code=TOOLCHAIN_INTERNAL`);
      throw new Error("TOOLCHAIN_INTERNAL: Developer tool operation failed");
    }
  });

  ipcMain.on("desktop:connect-host", (event) => {
    if (!getDeviceLicense()?.getState().authorized) return;
    const manager = getHostManager();
    if (!manager) return;
    const { port1 } = manager.createRendererChannel();
    event.sender.postMessage("desktop:host-port", null, [port1]);
  });

  ipcMain.handle("desktop:open-external", async (_event, url: string) => {
    if (typeof url !== "string") return;
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Blocked non-http(s)/mailto URL");
    await shell.openExternal(url);
  });

  ipcMain.handle("desktop:show-item-in-folder", async (_event, fsPath: string) => {
    if (typeof fsPath === "string") shell.showItemInFolder(fsPath);
  });

  ipcMain.handle("desktop:select-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ui = loadUiState();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: ui.recentCwds?.[0],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = result.filePaths[0];
    const recent = [directory, ...(ui.recentCwds ?? []).filter((entry) => entry !== directory)].slice(0, 12);
    saveUiState({ recentCwds: recent });
    return directory;
  });

  ipcMain.handle("desktop:test:get-license-state", (event) => {
    assertTrustedToolchainSender(event);
    const license = getDeviceLicense();
    if (!license) throw new Error("DEVICE_LICENSE_UNAVAILABLE: 设备授权服务不可用");
    return license.getState();
  });
  ipcMain.handle("desktop:test:refresh-license", (event) => {
    assertTrustedToolchainSender(event);
    const license = getDeviceLicense();
    if (!license) throw new Error("DEVICE_LICENSE_UNAVAILABLE: 设备授权服务不可用");
    return license.refresh();
  });
  testHandler("desktop:test:list-projects", (workbench) => workbench.listRecentProjects());
  testHandler("desktop:test:create-project", (workbench, input: TestWorkbenchCreateProjectInput) =>
    workbench.createProject(input),
  );
  testHandler("desktop:test:update-project", async (workbench, input: TestWorkbenchUpdateProjectInput) => {
    const current = workbench.openProject(input.root);
    const visualProviderChanged =
      Boolean(current.visualModel?.provider) &&
      Boolean(input.visualModel?.provider) &&
      current.visualModel?.provider !== input.visualModel?.provider;
    if ((input.visualCheck === true && !current.visualCheckEnabled) || visualProviderChanged) {
      const win = getMainWindow();
      const result = await dialog.showMessageBox(win ?? undefined!, {
        type: "warning",
        title: "明显视觉异常检查",
        message: visualProviderChanged
          ? `将视觉分析模型切换为 ${input.visualModel?.provider ?? ""}，允许把截图发送给该服务商？`
          : "允许将非敏感页面截图发送给视觉模型？",
        detail:
          "用于检查明显错位、遮挡、截断、空白页、图片加载失败和弹窗溢出。密码、验证码、支付、证件和银行卡页面会被阻止。截图只发送给当前选择的视觉模型，主对话模型不会收到图片。该设置按项目保存，可随时关闭。",
        buttons: ["取消", "启用"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) throw new Error("VISUAL_CHECK_CANCELLED: 已取消启用视觉检查");
    }
    return workbench.updateProject(input);
  });
  testHandler("desktop:test:open-project", (workbench, root: string) => workbench.openProject(root));
  testHandler("desktop:test:set-project-archived", (workbench, projectRoot: string, archived: boolean) => {
    if (typeof archived !== "boolean") throw new Error("BAD_REQUEST: archived 必须是布尔");
    return workbench.setProjectArchived(projectRoot, archived);
  });
  testHandler("desktop:test:remove-project", (workbench, projectRoot: string) => workbench.removeProject(projectRoot));
  testHandler("desktop:test:delete-project-data", async (workbench, projectRoot: string, confirmationName: string) => {
    const summary = workbench.getProjectDeletionSummary(projectRoot);
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "warning",
      title: "删除本地项目数据",
      message: `将 ${summary.name} 移到系统回收站？`,
      detail: `用例 ${summary.cases} · 执行 ${summary.runs} · 问题 ${summary.findings} · 证据 ${summary.evidenceFiles} 个（${summary.evidenceBytes} bytes）\n已提交到禅道的 Bug 不会删除。`,
      buttons: ["取消", "移到回收站"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("PROJECT_DELETE_CANCELLED: 已取消删除项目");
    return workbench.deleteProjectData(projectRoot, confirmationName);
  });
  testHandler("desktop:test:save-identity", (workbench, input: TestWorkbenchIdentityInput) =>
    workbench.saveIdentity(input),
  );
  testHandler("desktop:test:delete-identity", async (workbench, projectRoot: string, identityId: string) => {
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "warning",
      title: "删除测试身份",
      message: "删除该测试身份及其已保存凭据？",
      detail: "项目中的身份配置和 OS 加密凭据将同时删除。已有执行记录不会修改。",
      buttons: ["取消", "删除"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("IDENTITY_DELETE_CANCELLED: 已取消删除身份");
    return workbench.deleteIdentity(projectRoot, identityId);
  });
  testHandler("desktop:test:list-zentao-connections", (workbench) => workbench.listZentaoConnections());
  testHandler("desktop:test:save-zentao-connection", async (workbench, input: TestWorkbenchZentaoConnectionInput) => {
    if (typeof input?.baseUrl === "string" && /^http:\/\//i.test(input.baseUrl.trim())) {
      const win = getMainWindow();
      const result = await dialog.showMessageBox(win ?? undefined!, {
        type: "warning",
        title: "使用未加密的禅道连接",
        message: "该地址使用 HTTP，Token 和 Bug 内容可能被网络中的其他设备读取。",
        detail: "仅在受信任的公司内网且无法启用 HTTPS 时继续。",
        buttons: ["取消", "仍然连接"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) throw new Error("ZENTAO_HTTP_CANCELLED: 已取消未加密的禅道连接");
    }
    return workbench.saveZentaoConnection(input);
  });
  testHandler("desktop:test:delete-zentao-connection", async (workbench, connectionId: string) => {
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "warning",
      title: "删除禅道连接",
      message: "删除该连接及其 OS 加密 Token？",
      detail: "已提交 Bug 和项目中的本地 finding 不受影响。仍被项目引用的连接不能删除。",
      buttons: ["取消", "删除"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("ZENTAO_DELETE_CANCELLED: 已取消删除禅道连接");
    return workbench.deleteZentaoConnection(connectionId);
  });
  testHandler("desktop:test:get-zentao-catalog", (workbench, connectionId: string, productId: number) =>
    workbench.getZentaoCatalog(connectionId, productId),
  );
  testHandler("desktop:test:set-project-zentao", (workbench, input: TestWorkbenchZentaoProjectInput) =>
    workbench.setProjectZentao(input),
  );
  testHandler("desktop:test:prepare-zentao-bug", (workbench, projectRoot: string, findingId: string) =>
    workbench.prepareZentaoBug(projectRoot, findingId),
  );
  testHandler("desktop:test:submit-zentao-bug", async (workbench, input: TestWorkbenchZentaoSubmitBugInput) => {
    const confirmation = await workbench.getZentaoBugConfirmation(input);
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "warning",
      title: "提交禅道 Bug",
      message: confirmation.title,
      detail: confirmation.detail,
      buttons: ["取消", "确认提交"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("ZENTAO_SUBMIT_CANCELLED: 已取消提交禅道 Bug");
    return workbench.submitZentaoBug(input);
  });
  testHandler("desktop:test:refresh-zentao-bug", (workbench, projectRoot: string, findingId: string) =>
    workbench.refreshZentaoBug(projectRoot, findingId),
  );
  testHandler("desktop:test:open-zentao-bug", async (workbench, projectRoot: string, findingId: string) => {
    await shell.openExternal(workbench.getZentaoBugUrl(projectRoot, findingId));
  });
  testHandler("desktop:test:append-zentao-retest", async (workbench, input: TestWorkbenchZentaoRetestInput) => {
    const confirmation = await workbench.getZentaoRetestConfirmation(input);
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "question",
      title: "追加禅道复测记录",
      message: confirmation.message,
      detail: confirmation.detail,
      buttons: ["取消", "确认追加"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("ZENTAO_RETEST_CANCELLED: 已取消追加复测记录");
    return workbench.appendZentaoRetest(input);
  });
  testHandler("desktop:test:get-browser-state", (workbench, projectRoot: string, surface: "h5" | "admin") =>
    workbench.getBrowserState(projectRoot, surface),
  );
  testHandler("desktop:test:copy-browser-extension-path", (workbench) => workbench.copyExtensionPath());
  testHandler("desktop:test:open-browser-extension-manager", (workbench) => workbench.openExtensionManager());
  testHandler("desktop:test:get-mobile-state", (workbench, projectRoot: string) =>
    workbench.getMobileState(projectRoot),
  );
  testHandler("desktop:test:install-android-tools", async (workbench, projectRoot: string) => {
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: "question",
      title: "准备 Android 测试组件",
      message: "下载固定版本 Android platform-tools 37.0.1？",
      detail:
        "将从产品固定 HTTPS 地址下载约 8 MB，校验大小和 SHA-256 后安装到应用私有目录。不会修改系统 PATH，也不会安装 USB 驱动。",
      buttons: ["取消", "下载并安装"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) throw new Error("ANDROID_INSTALL_CANCELLED: 已取消 Android 组件安装");
    return workbench.installMobileTools(projectRoot);
  });
  testHandler("desktop:test:connect-mobile", (workbench, projectRoot: string, serial: string) =>
    workbench.connectMobile(projectRoot, serial),
  );
  testHandler("desktop:test:confirm-foreground-app", (workbench, projectRoot: string, serial: string) =>
    workbench.confirmForegroundApp(projectRoot, serial),
  );
  testHandler(
    "desktop:test:bind-browser",
    (workbench, projectRoot: string, surface: "h5" | "admin", profileId: string, tabId?: string) =>
      workbench.bindBrowser(projectRoot, surface, profileId, tabId),
  );
  testHandler(
    "desktop:test:set-case-status",
    (workbench, projectRoot: string, caseId: string, status: "draft" | "stable" | "disabled") =>
      workbench.setCaseStatus(projectRoot, caseId, status),
  );
  testHandler("desktop:test:play-cases", (workbench, projectRoot: string, sessionId: string, caseIds: string[]) =>
    workbench.playCases(projectRoot, sessionId, caseIds),
  );
  testHandler(
    "desktop:test:start-run",
    (workbench, projectRoot: string, sessionId: string, surface: "h5" | "admin" | "app", title: string) =>
      workbench.startRun(projectRoot, sessionId, surface, title),
  );
  testHandler(
    "desktop:test:control-run",
    (workbench, projectRoot: string, sessionId: string, request: Parameters<TestWorkbenchService["controlRun"]>[2]) =>
      workbench.controlRun(projectRoot, sessionId, request),
  );
  testHandler(
    "desktop:test:finish-run",
    (
      workbench,
      projectRoot: string,
      sessionId: string,
      status: "passed" | "failed" | "blocked" | "aborted",
      summaryText?: string,
    ) => workbench.finishRun(projectRoot, sessionId, status, summaryText),
  );
  testHandler(
    "desktop:test:observe",
    (
      workbench,
      projectRoot: string,
      sessionId: string,
      surface: "h5" | "admin" | "app",
      mode: "text" | "snapshot" | "visual",
    ) => workbench.observe(projectRoot, sessionId, surface, mode),
  );
  testHandler(
    "desktop:test:act",
    (
      workbench,
      projectRoot: string,
      sessionId: string,
      surface: "h5" | "admin" | "app",
      risk: "read" | "business_write" | "high",
      action: Parameters<TestWorkbenchService["act"]>[4],
    ) => workbench.act(projectRoot, sessionId, surface, risk, action),
  );
  testHandler("desktop:test:read-evidence", (workbench, projectRoot: string, evidence: string) =>
    workbench.readEvidence(projectRoot, evidence),
  );
  testHandler("desktop:test:create-finding", (workbench, input: TestWorkbenchFindingInput) =>
    workbench.createFinding(input),
  );

  ipcMain.handle("desktop:save-file", async (event, saveOptions: SaveTextFileOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: saveOptions.defaultPath,
      filters: saveOptions.filters ?? [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const fs = await import("fs");
    fs.writeFileSync(result.filePath, saveOptions.content, "utf8");
    return result.filePath;
  });

  ipcMain.handle("desktop:save-binary-file", async (event, saveOptions: SaveBinaryFileOptions) => {
    if (!saveOptions || typeof saveOptions.base64 !== "string") throw new Error("Invalid binary save payload");
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined!, { defaultPath: saveOptions.defaultPath });
    if (result.canceled || !result.filePath) return null;
    const fs = await import("fs");
    fs.writeFileSync(result.filePath, Buffer.from(saveOptions.base64, "base64"));
    return result.filePath;
  });

  ipcMain.handle(
    "desktop:create-html-preview",
    (_event, content: string, filePath: string, sourceSessionId?: string | null) =>
      createHtmlPreviewUrl(content, filePath, async (assetPath) => {
        const manager = getHostManager();
        if (!manager) throw new Error("Agent Host is unavailable");
        const meta = await manager.call<{ size: number }>("files.meta", {
          path: assetPath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
        if (meta.size > 20 * 1024 * 1024) throw new Error("HTML preview asset is too large");
        return manager.call<{ base64: string; size: number; mime?: string }>("files.download", {
          path: assetPath,
          sourceSessionId: sourceSessionId ?? undefined,
        });
      }),
  );
  ipcMain.handle("desktop:release-html-preview", (_event, previewUrl: string) => {
    releaseHtmlPreviewUrl(previewUrl);
  });

  ipcMain.on("desktop:notify-agent-end", (_event, payload: { sessionId: string; title?: string }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: payload.title || "Agent finished",
      body: "Session completed",
    });
    notification.on("click", () => {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send("deep-link:session", payload.sessionId);
      }
    });
    notification.show();
    applyBadgeCount(getUnreadBadge() + 1);
  });

  ipcMain.on("desktop:set-badge-count", (_event, count: number) => applyBadgeCount(count));
  ipcMain.handle("desktop:get-ui-state", () => loadUiState());
  ipcMain.handle("desktop:set-ui-state", (_event, patch: Record<string, unknown>) => saveUiState(patch));
  ipcMain.handle("desktop:get-theme-source", () => nativeTheme.themeSource);
  ipcMain.handle("desktop:set-theme-source", (_event, source: "system" | "light" | "dark") => {
    nativeTheme.themeSource = source;
    saveUiState({ theme: source });
  });
  ipcMain.handle("desktop:open-logs", () => shell.showItemInFolder(getMainLogPath()));
  ipcMain.handle("desktop:export-diagnostics", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return exportDiagnostics(win, {
      toolchainState: await getToolchainState(),
    });
  });
  ipcMain.handle("desktop:clear-badge", () => applyBadgeCount(0));
}

function toolchainActionConfirmation(request: ToolchainActionRequest): Electron.MessageBoxOptions | undefined {
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  if (
    request.action === "install-profile" ||
    request.action === "install-component" ||
    request.action === "repair-component"
  ) {
    return {
      type: "warning",
      title: chinese ? "安装开发工具" : "Install developer tools",
      message: chinese
        ? "Pi Desktop 将从界面所示的官方来源下载固定版本。来源会收到你的 IP 地址、平台和架构；文件仅保存在应用私有数据中，也不会修改系统 PATH。是否继续？"
        : "Pi Desktop will download fixed releases from the official sources shown in Developer Tools. The sources receive your IP address, platform, and architecture. Files stay in private app data and system PATH is not changed.",
      buttons: chinese ? ["取消", "继续"] : ["Cancel", "Continue"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
  }
  if (request.action === "remove-component") {
    return {
      type: "warning",
      title: chinese ? "移除托管工具" : "Remove managed tool",
      message: chinese
        ? "移除此 Pi Desktop 托管运行时？系统工具和自定义工具不会受影响。"
        : "Remove this Pi Desktop-managed runtime? System and custom tools are not affected.",
      buttons: chinese ? ["取消", "移除"] : ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  if (request.action === "clear-cache") {
    return {
      type: "question",
      title: chinese ? "清理工具缓存" : "Clear tool cache",
      message: chinese
        ? "清除此应用私有缓存？已安装的运行时不会被移除。"
        : "Clear this private app cache? Installed runtimes are not removed.",
      buttons: chinese ? ["取消", "清理"] : ["Cancel", "Clear"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  return undefined;
}

function validateOptionalToolchainCwd(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4_096 || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) {
    throw new Error("Invalid toolchain workspace path");
  }
  return path.normalize(value);
}
