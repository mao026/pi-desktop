import type { BrowserWindow } from "electron";
import type { HostManager } from "../main/host-manager";
import { appendMainLog } from "../main/logger";

export async function runSmokeHostChecks(
  manager: HostManager,
  createWindow: (onConsoleError: (message: string) => void) => BrowserWindow,
): Promise<void> {
  let rendererSecurityViolation: string | null = null;
  const { port1 } = manager.createRendererChannel();
  let requestId = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  port1.on("message", (event) => {
    const message = event.data as {
      kind?: string;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: string; message?: string; detail?: unknown };
    };
    if (message.kind !== "response" || !message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? "Smoke RPC failed") as Error & {
        code?: string;
        detail?: unknown;
      };
      error.code = message.error?.code;
      error.detail = message.error?.detail;
      entry.reject(error);
    }
  });
  port1.start();

  const call = <T>(method: string, params?: unknown): Promise<T> => {
    const id = `smoke-${++requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Smoke RPC timed out: ${method}`));
      }, 10_000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      port1.postMessage({ kind: "request", id, method, params });
    });
  };

  try {
    await call("host.ping");
    const ackDeadline = Date.now() + 5_000;
    while (manager.getToolchainAckRevision() < 0 && Date.now() < ackDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const acknowledgedRevision = manager.getToolchainAckRevision();
    if (acknowledgedRevision < 0) throw new Error("Agent Host did not acknowledge its toolchain snapshot");
    const hostToolchain = await call<{
      inventoryRevision?: number;
      resolutionId?: string;
      capabilities?: Record<string, { provider?: string; version?: string }>;
    }>("host.toolchain", { cwd: process.cwd() });
    if (
      hostToolchain.inventoryRevision !== acknowledgedRevision ||
      !hostToolchain.resolutionId ||
      !hostToolchain.capabilities?.["vcs.git"]?.provider
    ) {
      throw new Error(`Agent Host toolchain snapshot mismatch: ${JSON.stringify(hostToolchain)}`);
    }
    await call("sessions.list");

    const smokeWindow = createWindow((message) => {
      if (/Content Security Policy/i.test(message)) rendererSecurityViolation = message;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Renderer smoke load timed out")), 15_000);
        const loaded = () => {
          clearTimeout(timer);
          resolve();
        };
        if (!smokeWindow.webContents.isLoadingMainFrame()) loaded();
        else smokeWindow.webContents.once("did-finish-load", loaded);
      });
      const rendererResult = (await smokeWindow.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const check = async () => {
            try {
              const root = document.getElementById("root");
              if (window.piBridge && root && root.childElementCount > 0) {
                const license = await window.piBridge.getTestLicenseState();
                const projects = await window.piBridge.listRecentProjects();
                resolve({
                  bridge:
                    typeof window.piBridge.startRun === "function" &&
                    typeof window.piBridge.observe === "function" &&
                    typeof window.piBridge.playCases === "function" &&
                    typeof window.piBridge.setCaseStatus === "function",
                  rendered: root.childElementCount > 0,
                  readOnly: license.readOnly === true && license.authorized === false,
                  projects: Array.isArray(projects),
                  title: document.body.textContent?.includes("最近项目") === true,
                });
                return;
              }
            } catch (error) {
              reject(error);
              return;
            }
            if (Date.now() >= deadline) reject(new Error("Renderer did not become ready"));
            else setTimeout(check, 50);
          };
          void check();
        })
      `)) as {
        bridge?: boolean;
        rendered?: boolean;
        readOnly?: boolean;
        projects?: boolean;
        title?: boolean;
      };
      if (
        !rendererResult.bridge ||
        !rendererResult.rendered ||
        !rendererResult.readOnly ||
        !rendererResult.projects ||
        !rendererResult.title
      ) {
        throw new Error(`Renderer smoke returned invalid result: ${JSON.stringify(rendererResult)}`);
      }
      if (rendererSecurityViolation) {
        throw new Error(`Renderer security violation: ${rendererSecurityViolation}`);
      }
    } finally {
      if (!smokeWindow.isDestroyed()) smokeWindow.destroy();
    }
    appendMainLog(
      `smoke: test workbench/Renderer/RPC/session/toolchain revision=${acknowledgedRevision} checks passed`,
    );
  } finally {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Smoke port closed"));
    }
    pending.clear();
    port1.close();
  }
}
