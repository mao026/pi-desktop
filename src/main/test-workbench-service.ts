import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listCases, setCaseStatus } from "../../packages/pi-test/core/case.ts";
import {
  createFinding,
  listFindings,
  loadFinding,
  setFindingRemote,
  type Finding,
  type FindingRemote,
} from "../../packages/pi-test/core/finding.ts";
import { mapPath, runsDir } from "../../packages/pi-test/core/paths.ts";
import {
  createProject,
  deleteProjectIdentity,
  getSurfaceReadiness,
  loadProject,
  requireSurfaceReady,
  setProjectIdentity,
  setProjectZentao,
  surfaceNames,
  updateAppSurface,
  updateProjectConfiguration,
  type SurfaceName,
  type VisualModelRef,
} from "../../packages/pi-test/core/project.ts";
import { abortStaleRun, loadRun, readActiveRunName } from "../../packages/pi-test/core/run.ts";
import type { TestActRequest } from "../../packages/pi-test/contract.ts";
import type {
  TestWorkbenchBrowserState,
  TestWorkbenchBrowserTab,
  TestWorkbenchCreateProjectInput,
  TestWorkbenchFindingInput,
  TestWorkbenchIdentityInput,
  TestWorkbenchMobileState,
  TestWorkbenchProject,
  TestWorkbenchUpdateProjectInput,
  TestWorkbenchZentaoBugDraft,
  TestWorkbenchZentaoConnection,
  TestWorkbenchZentaoConnectionInput,
  TestWorkbenchZentaoProjectInput,
  TestWorkbenchZentaoRetestInput,
  TestWorkbenchZentaoSubmitBugInput,
} from "../contract/test-workbench.ts";
import {
  AgentBrowserCliDriver,
  MainTestCoordinator,
  TestCoordinatorError,
  type BrowserDriverBinding,
} from "./test-coordinator.ts";
import type { TestBrowserAssetsState } from "./test-browser-assets.ts";
import type { TestAndroidAssetsState } from "./test-android-assets.ts";
import type { HandsetsMobileDriver } from "./test-mobile-driver.ts";
import { projectIdentityCredentialKey, zentaoTokenCredentialKey } from "./credential-key.ts";
import {
  ZentaoClient,
  ZentaoError,
  normalizeZentaoBaseUrl,
  type ZentaoCapabilities,
  type ZentaoCatalog,
  type ZentaoFetch,
} from "./zentao-client.ts";

interface IdentityVault {
  has(key: string): boolean;
  get(key: string): Record<string, unknown> | null;
  set(key: string, value: Record<string, unknown>): void;
  delete(key: string): void;
}

interface PersistedBinding extends BrowserDriverBinding {
  projectId: string;
  projectRoot: string;
  surface: "h5" | "admin";
}

interface PersistedProject {
  root: string;
  archived: boolean;
}

interface PersistedZentaoConnection {
  id: string;
  name: string;
  baseUrl: string;
  connected: boolean;
  version: string | null;
  edition: string | null;
  products: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string }>;
  capabilities: ZentaoCapabilities | null;
  checkedAt: string | null;
  error: string | null;
}

interface WorkbenchState {
  version: 1;
  recentProjects: PersistedProject[];
  bindings: PersistedBinding[];
  zentaoConnections: PersistedZentaoConnection[];
}

const EMPTY_STATE: WorkbenchState = { version: 1, recentProjects: [], bindings: [], zentaoConnections: [] };
const MAX_RECENT_PROJECTS = 20;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_ZENTAO_EVIDENCE = 20;
const MAX_ZENTAO_EVIDENCE_BYTES = 50 * 1024 * 1024;
const EVIDENCE_RE = /^runs\/([0-9A-Za-z-]+)\/evidence\/([0-9A-Za-z._-]+\.(?:png|jpe?g|txt))$/i;
const WORKBENCH_SURFACES = new Set<SurfaceName>(["h5", "admin", "app"]);

function absoluteRoot(value: string): string {
  if (!path.isAbsolute(value) || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", "项目目录必须是绝对路径");
  }
  return path.normalize(value);
}

function workbenchSurface(value: string): "h5" | "admin" | "app" {
  if (!WORKBENCH_SURFACES.has(value as SurfaceName)) throw new TestCoordinatorError("BAD_REQUEST", "请选择测试端");
  return value as "h5" | "admin" | "app";
}

function webSurface(value: string): "h5" | "admin" {
  const surface = workbenchSurface(value);
  if (surface === "app") throw new TestCoordinatorError("BAD_REQUEST", "请选择 Web 测试端");
  return surface;
}

function plainId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", `${label} 无效`);
  }
  return value;
}

function projectIdentityId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new TestCoordinatorError("BAD_REQUEST", "identity id 无效");
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /\0/.test(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", `${label} 无效`);
  }
  return value.trim();
}

function boundedSecret(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /\0/.test(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", `${label} 无效`);
  }
  return value;
}

function optionalUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048 || /[\0\r\n]/.test(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", `${label} 无效`);
  }
  return value.trim() || null;
}

function visualModelInput(value: unknown): VisualModelRef | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", "视觉模型无效");
  }
  const provider = (value as Record<string, unknown>).provider;
  const modelId = (value as Record<string, unknown>).modelId;
  if (typeof provider !== "string" || !provider.trim() || provider.length > 256 || /[\0\r\n]/.test(provider)) {
    throw new TestCoordinatorError("BAD_REQUEST", "视觉模型服务商无效");
  }
  if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 256 || /[\0\r\n]/.test(modelId)) {
    throw new TestCoordinatorError("BAD_REQUEST", "视觉模型 ID 无效");
  }
  return { provider: provider.trim(), modelId: modelId.trim() };
}

function validBinding(value: unknown): value is PersistedBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<PersistedBinding>;
  return (
    typeof item.projectId === "string" &&
    typeof item.projectRoot === "string" &&
    path.isAbsolute(item.projectRoot) &&
    (item.surface === "h5" || item.surface === "admin") &&
    typeof item.profileId === "string" &&
    (item.tabId === undefined || typeof item.tabId === "string")
  );
}

function connectionId(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(value)) throw new TestCoordinatorError("BAD_REQUEST", "禅道连接 ID 无效");
  return value;
}

function validZentaoConnection(value: unknown): value is PersistedZentaoConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<PersistedZentaoConnection>;
  try {
    if (typeof item.id !== "string" || connectionId(item.id) !== item.id) return false;
    if (typeof item.name !== "string" || !item.name || item.name.length > 80) return false;
    if (typeof item.baseUrl !== "string" || normalizeZentaoBaseUrl(item.baseUrl) !== item.baseUrl) return false;
  } catch {
    return false;
  }
  return (
    typeof item.connected === "boolean" &&
    (item.version === null || typeof item.version === "string") &&
    (item.edition === null || typeof item.edition === "string") &&
    Array.isArray(item.products) &&
    Array.isArray(item.users) &&
    (item.capabilities === null || (typeof item.capabilities === "object" && !Array.isArray(item.capabilities))) &&
    (item.checkedAt === null || typeof item.checkedAt === "string") &&
    (item.error === null || typeof item.error === "string")
  );
}

function parseState(value: unknown): WorkbenchState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const state = value as Partial<WorkbenchState>;
  if (state.version !== 1) return structuredClone(EMPTY_STATE);
  return {
    version: 1,
    recentProjects: Array.isArray(state.recentProjects)
      ? state.recentProjects
          .flatMap((item): PersistedProject[] => {
            if (typeof item === "string" && path.isAbsolute(item)) return [{ root: item, archived: false }];
            if (!item || typeof item !== "object" || Array.isArray(item)) return [];
            const project = item as Partial<PersistedProject>;
            return typeof project.root === "string" &&
              path.isAbsolute(project.root) &&
              typeof project.archived === "boolean"
              ? [{ root: project.root, archived: project.archived }]
              : [];
          })
          .slice(0, MAX_RECENT_PROJECTS)
      : [],
    bindings: Array.isArray(state.bindings) ? state.bindings.filter(validBinding) : [],
    zentaoConnections: Array.isArray(state.zentaoConnections)
      ? state.zentaoConnections.filter(validZentaoConnection)
      : [],
  };
}

function findArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => findArray(item, key));
  const record = value as Record<string, unknown>;
  if (Array.isArray(record[key])) return record[key];
  return Object.values(record).flatMap((item) => findArray(item, key));
}

export function readBrowserState(
  status: unknown,
  tabsResult: unknown,
  assets: TestBrowserAssetsState,
): Omit<TestWorkbenchBrowserState, "binding"> {
  const statusRecord = status && typeof status === "object" ? (status as Record<string, unknown>) : {};
  const connection =
    statusRecord.connection && typeof statusRecord.connection === "object"
      ? (statusRecord.connection as Record<string, unknown>)
      : {};
  const profiles = Array.isArray(connection.profiles) ? connection.profiles : [];
  const extensionVersion =
    profiles.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const version = (item as Record<string, unknown>).extension_version;
      return typeof version === "string" ? [version] : [];
    })[0] ?? null;
  const tabs = findArray(tabsResult, "tabs").flatMap((item): TestWorkbenchBrowserTab[] => {
    if (!item || typeof item !== "object") return [];
    const tab = item as Record<string, unknown>;
    const browserId = tab.browser_id;
    const profileId = tab.profile_id;
    const tabId = tab.tab_id ?? tab.id;
    const title = tab.title;
    const url = tab.url;
    if (
      typeof browserId !== "string" ||
      typeof profileId !== "string" ||
      (typeof tabId !== "string" && typeof tabId !== "number") ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      !/^https?:\/\//i.test(url)
    ) {
      return [];
    }
    return [
      {
        browserId,
        profileId,
        profileLabel: typeof tab.profile_label === "string" ? tab.profile_label : null,
        tabId: String(tabId),
        title,
        url,
      },
    ];
  });
  const uniqueTabs = [...new Map(tabs.map((tab) => [`${tab.profileId}:${tab.tabId}`, tab])).values()];
  const extensionConnected = connection.extension_connected === true;
  const expectedExtensionVersion = assets.productExtensionVersion;
  if (extensionConnected && extensionVersion === expectedExtensionVersion) {
    fs.rmSync(assets.extensionBackupPath, { recursive: true, force: true });
  }
  return {
    ready:
      assets.prepared &&
      statusRecord.ready === true &&
      extensionConnected &&
      extensionVersion === expectedExtensionVersion &&
      uniqueTabs.length > 0,
    summary: typeof statusRecord.summary === "string" ? statusRecord.summary : "unavailable",
    extensionConnected,
    extensionVersion,
    expectedExtensionVersion,
    assetsPrepared: assets.prepared,
    assetError: assets.error,
    extensionPath: assets.extensionPath,
    tabs: uniqueTabs,
  };
}

function runSummaries(root: string): TestWorkbenchProject["runs"] {
  const directory = runsDir(root);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const doc = loadRun(root, entry.name);
        return [
          {
            dirName: entry.name,
            id: doc.id,
            title: doc.title,
            status: doc.status,
            startedAt: doc.startedAt,
            finishedAt: doc.finishedAt,
            evidence: [
              ...new Set([
                ...doc.journal.flatMap((item) => item.evidence),
                ...doc.cases.flatMap((item) => item.evidence),
              ]),
            ],
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function projectSummary(root: string, vault?: IdentityVault, archived = false): TestWorkbenchProject {
  const project = loadProject(root);
  const activeRunName = readActiveRunName(root);
  return {
    root,
    id: project.id,
    archived,
    name: project.name,
    environment: project.environment,
    surfaces: surfaceNames(project).flatMap((name) => {
      if (!WORKBENCH_SURFACES.has(name)) return [];
      const configured = project.surfaces[name] as { url?: string | null; package?: string | null };
      return [
        {
          name,
          url: configured.url ?? configured.package ?? null,
          readiness: getSurfaceReadiness(project, name),
        },
      ];
    }),
    identities: Object.entries(project.identities).map(([id, identity]) => ({
      id,
      name: identity.name,
      surfaces: identity.surfaces.filter((surface) => WORKBENCH_SURFACES.has(surface)) as Array<"h5" | "admin" | "app">,
      defaultSurfaces: (Object.entries(project.defaultIdentityBySurface) as Array<[SurfaceName, string]>).flatMap(
        ([surface, identityId]) => (identityId === id && WORKBENCH_SURFACES.has(surface) ? [surface] : []),
      ) as Array<"h5" | "admin" | "app">,
      credentialConfigured: (() => {
        try {
          return vault?.has(projectIdentityCredentialKey(project.id, id)) === true;
        } catch {
          return false;
        }
      })(),
    })),
    activeRun: activeRunName ? { activeRun: activeRunName, run: loadRun(root, activeRunName) } : null,
    runs: runSummaries(root),
    cases: listCases(root),
    findings: listFindings(root).map((summary) => {
      try {
        const finding = loadFinding(root, summary.id, project);
        return {
          ...summary,
          evidence: finding.evidence,
          remote: finding.remote
            ? {
                connectionId: finding.remote.connectionId,
                syncStatus: finding.remote.syncStatus,
                bugId: finding.remote.bugId ?? null,
                url: finding.remote.url ?? null,
                status: finding.remote.status ?? null,
                lastError: finding.remote.lastError ?? null,
              }
            : null,
        };
      } catch {
        return { ...summary, evidence: [], remote: null };
      }
    }),
    map: fs.existsSync(mapPath(root)) ? fs.readFileSync(mapPath(root), "utf8") : "",
    visualCheckEnabled: project.defaults?.visualCheck === true,
    visualModel: project.defaults?.visualModel ?? null,
    zentao: project.zentao ?? null,
  };
}

export class TestWorkbenchStore {
  constructor(private readonly filePath: string) {}

  load(): WorkbenchState {
    try {
      return parseState(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown);
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  save(state: WorkbenchState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(parseState(state), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  addRecent(projectRoot: string): void {
    const root = absoluteRoot(projectRoot);
    const state = this.load();
    const existing = state.recentProjects.find((item) => item.root === root);
    state.recentProjects = [
      { root, archived: existing?.archived ?? false },
      ...state.recentProjects.filter((item) => item.root !== root),
    ].slice(0, MAX_RECENT_PROJECTS);
    this.save(state);
  }

  setArchived(projectRoot: string, archived: boolean): void {
    const root = absoluteRoot(projectRoot);
    const state = this.load();
    const existing = state.recentProjects.find((item) => item.root === root);
    state.recentProjects = [{ root, archived }, ...state.recentProjects.filter((item) => item.root !== root)].slice(
      0,
      MAX_RECENT_PROJECTS,
    );
    if (!existing && !fs.existsSync(root)) throw new TestCoordinatorError("BAD_REQUEST", "项目目录不存在");
    this.save(state);
  }

  removeProject(projectRoot: string): void {
    const root = absoluteRoot(projectRoot);
    const state = this.load();
    state.recentProjects = state.recentProjects.filter((item) => item.root !== root);
    state.bindings = state.bindings.filter((item) => item.projectRoot !== root);
    this.save(state);
  }

  getBinding(projectId: string, projectRoot: string, surface: "h5" | "admin"): BrowserDriverBinding | null {
    const root = absoluteRoot(projectRoot);
    const found = this.load().bindings.find(
      (item) => item.projectId === projectId && item.projectRoot === root && item.surface === surface,
    );
    return found ? { profileId: found.profileId, ...(found.tabId ? { tabId: found.tabId } : {}) } : null;
  }

  clearBinding(projectId: string, projectRoot: string, surface: "h5" | "admin"): void {
    const root = absoluteRoot(projectRoot);
    const state = this.load();
    state.bindings = state.bindings.filter(
      (item) => !(item.projectId === projectId && item.projectRoot === root && item.surface === surface),
    );
    this.save(state);
  }

  setBinding(projectId: string, projectRoot: string, surface: "h5" | "admin", binding: BrowserDriverBinding): void {
    const root = absoluteRoot(projectRoot);
    const state = this.load();
    state.bindings = state.bindings.filter(
      (item) => !(item.projectId === projectId && item.projectRoot === root && item.surface === surface),
    );
    state.bindings.push({
      projectId,
      projectRoot: root,
      surface,
      profileId: binding.profileId,
      ...(binding.tabId ? { tabId: binding.tabId } : {}),
    });
    this.save(state);
  }

  listZentaoConnections(): PersistedZentaoConnection[] {
    return this.load().zentaoConnections;
  }

  getZentaoConnection(id: string): PersistedZentaoConnection | null {
    const validated = connectionId(id);
    return this.load().zentaoConnections.find((connection) => connection.id === validated) ?? null;
  }

  setZentaoConnection(connection: PersistedZentaoConnection): void {
    if (!validZentaoConnection(connection)) throw new TestCoordinatorError("BAD_REQUEST", "禅道连接无效");
    const state = this.load();
    state.zentaoConnections = [
      connection,
      ...state.zentaoConnections.filter((current) => current.id !== connection.id),
    ];
    this.save(state);
  }

  deleteZentaoConnection(id: string): void {
    const validated = connectionId(id);
    const state = this.load();
    state.zentaoConnections = state.zentaoConnections.filter((connection) => connection.id !== validated);
    this.save(state);
  }
}

export class TestWorkbenchService {
  constructor(
    private readonly coordinator: MainTestCoordinator,
    private readonly browser: AgentBrowserCliDriver,
    private readonly store: TestWorkbenchStore,
    private readonly assertLicensed: () => Promise<void> | void,
    private readonly browserAssets: TestBrowserAssetsState,
    private readonly copyBrowserExtensionPath: (extensionPath: string) => void,
    private readonly openBrowserExtensionManager: () => void,
    private androidAssets?: TestAndroidAssetsState,
    private readonly mobile?: HandsetsMobileDriver,
    private readonly installAndroidAssets?: () => Promise<TestAndroidAssetsState>,
    private readonly identityVault?: IdentityVault,
    private readonly trashProject?: (projectRoot: string) => Promise<void>,
    private readonly zentaoFetch?: ZentaoFetch,
  ) {}

  recoverStaleRuns(): void {
    for (const { root } of this.store.load().recentProjects) {
      try {
        abortStaleRun(root);
      } catch {
        // A missing or invalid recent project must not block application startup.
      }
    }
  }

  listRecentProjects(): TestWorkbenchProject[] {
    return this.store.load().recentProjects.flatMap(({ root, archived }) => {
      try {
        return [projectSummary(root, this.identityVault, archived)];
      } catch {
        return [];
      }
    });
  }

  async setProjectArchived(projectRoot: string, archived: boolean): Promise<void> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    if (readActiveRunName(root)) throw new TestCoordinatorError("TEST_BUSY", "当前测试结束后才能归档项目");
    loadProject(root);
    this.store.setArchived(root, archived);
  }

  async removeProject(projectRoot: string): Promise<void> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    if (readActiveRunName(root)) throw new TestCoordinatorError("TEST_BUSY", "当前测试结束后才能移除项目");
    loadProject(root);
    this.store.removeProject(root);
  }

  getProjectDeletionSummary(projectRoot: string): {
    name: string;
    cases: number;
    runs: number;
    findings: number;
    evidenceFiles: number;
    evidenceBytes: number;
  } {
    const root = absoluteRoot(projectRoot);
    const project = projectSummary(root, this.identityVault);
    const evidence = [...new Set(project.runs.flatMap((run) => run.evidence))];
    let evidenceFiles = 0;
    let evidenceBytes = 0;
    for (const relative of evidence) {
      const match = EVIDENCE_RE.exec(relative);
      if (!match) continue;
      try {
        const stat = fs.lstatSync(path.join(root, "runs", match[1], "evidence", match[2]));
        if (stat.isFile() && !stat.isSymbolicLink()) {
          evidenceFiles += 1;
          evidenceBytes += stat.size;
        }
      } catch {
        // Missing evidence stays represented in the run, but contributes no local bytes.
      }
    }
    return {
      name: project.name,
      cases: project.cases.length,
      runs: project.runs.length,
      findings: project.findings.length,
      evidenceFiles,
      evidenceBytes,
    };
  }

  async deleteProjectData(projectRoot: string, confirmationName: string): Promise<void> {
    await this.assertLicensed();
    if (!this.identityVault || !this.trashProject) {
      throw new TestCoordinatorError("PROJECT_DELETE_UNAVAILABLE", "项目删除不可用");
    }
    const root = absoluteRoot(projectRoot);
    if (readActiveRunName(root)) throw new TestCoordinatorError("TEST_BUSY", "当前测试结束后才能删除项目");
    const project = loadProject(root);
    if (confirmationName !== project.name) throw new TestCoordinatorError("CONFIRMATION_MISMATCH", "项目名称不匹配");
    await this.trashProject(root);
    for (const identityId of Object.keys(project.identities)) {
      try {
        this.identityVault.delete(projectIdentityCredentialKey(project.id, identityId));
      } catch {
        // The project is already in the system trash; continue removing stale app registration.
      }
    }
    this.store.removeProject(root);
  }

  async createProject(input: TestWorkbenchCreateProjectInput): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(input.root);
    if (input.visualCheck !== undefined && typeof input.visualCheck !== "boolean") {
      throw new TestCoordinatorError("BAD_REQUEST", "视觉检查设置无效");
    }
    const visualModel = visualModelInput(input.visualModel);
    if (input.visualCheck === true && !visualModel) {
      throw new TestCoordinatorError("BAD_REQUEST", "启用视觉检查需要选择视觉模型");
    }
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) {
      throw new TestCoordinatorError("BAD_REQUEST", "项目名称无效");
    }
    if (!["test", "staging", "production"].includes(input.environment)) {
      throw new TestCoordinatorError("BAD_REQUEST", "项目环境无效");
    }
    if (!Array.isArray(input.surfaces) || input.surfaces.length === 0 || input.surfaces.length > 3) {
      throw new TestCoordinatorError("BAD_REQUEST", "项目测试端无效");
    }
    const surfaces = [...new Set(input.surfaces.map(workbenchSurface))];
    fs.mkdirSync(root, { recursive: true });
    createProject(root, {
      id: `project-${randomUUID()}`,
      name: input.name.trim(),
      environment: input.environment,
      surfaces,
      ...(surfaces.includes("h5") ? { h5Url: optionalUrl(input.h5Url, "H5 地址") } : {}),
      ...(surfaces.includes("admin") ? { adminUrl: optionalUrl(input.adminUrl, "管理后台地址") } : {}),
      ...(surfaces.includes("app") ? { appPackage: null } : {}),
      visualCheck: input.visualCheck === true,
      visualModel,
    });
    this.store.addRecent(root);
    return projectSummary(root, this.identityVault);
  }

  async updateProject(input: TestWorkbenchUpdateProjectInput): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(input.root);
    if (input.visualCheck !== undefined && typeof input.visualCheck !== "boolean") {
      throw new TestCoordinatorError("BAD_REQUEST", "视觉检查设置无效");
    }
    const visualModel = visualModelInput(input.visualModel);
    const effectiveVisualCheck =
      typeof input.visualCheck === "boolean" ? input.visualCheck : loadProject(root).defaults?.visualCheck === true;
    if (effectiveVisualCheck && !visualModel) {
      throw new TestCoordinatorError("BAD_REQUEST", "启用视觉检查需要选择视觉模型");
    }
    if (readActiveRunName(root)) throw new TestCoordinatorError("TEST_BUSY", "当前测试结束后才能修改项目");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) {
      throw new TestCoordinatorError("BAD_REQUEST", "项目名称无效");
    }
    if (!["test", "staging", "production"].includes(input.environment)) {
      throw new TestCoordinatorError("BAD_REQUEST", "项目环境无效");
    }
    if (!Array.isArray(input.surfaces) || input.surfaces.length === 0 || input.surfaces.length > 3) {
      throw new TestCoordinatorError("BAD_REQUEST", "项目测试端无效");
    }
    const surfaces = [...new Set(input.surfaces.map(workbenchSurface))];
    const project = loadProject(root);
    updateProjectConfiguration(root, {
      name: input.name.trim(),
      environment: input.environment,
      surfaces,
      h5Url: optionalUrl(input.h5Url, "H5 地址"),
      adminUrl: optionalUrl(input.adminUrl, "管理后台地址"),
      visualCheck: typeof input.visualCheck === "boolean" ? input.visualCheck : project.defaults?.visualCheck === true,
      visualModel,
    });
    for (const web of ["h5", "admin"] as const) {
      if (project.surfaces[web] && !surfaces.includes(web)) this.store.clearBinding(project.id, root, web);
    }
    this.store.addRecent(root);
    return projectSummary(root, this.identityVault);
  }

  openProject(projectRoot: string): TestWorkbenchProject {
    const root = absoluteRoot(projectRoot);
    const project = projectSummary(root, this.identityVault);
    this.store.addRecent(root);
    return project;
  }

  async saveIdentity(input: TestWorkbenchIdentityInput): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    if (!this.identityVault) throw new TestCoordinatorError("CREDENTIAL_VAULT_UNAVAILABLE", "凭据存储不可用");
    const root = absoluteRoot(input.projectRoot);
    const project = loadProject(root);
    const id = projectIdentityId(input.id);
    const name = boundedText(input.name, "身份名称", 80);
    if (!Array.isArray(input.surfaces) || input.surfaces.length > 3 || !Array.isArray(input.defaultSurfaces)) {
      throw new TestCoordinatorError("BAD_REQUEST", "身份适用端无效");
    }
    const surfaces = [...new Set(input.surfaces.map(workbenchSurface))];
    const defaultSurfaces = [...new Set(input.defaultSurfaces.map(workbenchSurface))];
    if (surfaces.length === 0 || defaultSurfaces.some((surface) => !surfaces.includes(surface))) {
      throw new TestCoordinatorError("BAD_REQUEST", "身份适用端或默认端无效");
    }
    const configuredSurfaces = new Set(surfaceNames(project));
    if (surfaces.some((surface) => !configuredSurfaces.has(surface))) {
      throw new TestCoordinatorError("BAD_REQUEST", "身份引用了项目未配置的测试端");
    }
    const username = input.username === undefined ? undefined : boundedSecret(input.username, "账号", 500);
    const password = input.password === undefined ? undefined : boundedSecret(input.password, "密码", 2_000);
    if ((username === undefined) !== (password === undefined)) {
      throw new TestCoordinatorError("BAD_REQUEST", "账号和密码必须同时填写");
    }
    setProjectIdentity(root, id, { name, surfaces }, defaultSurfaces);
    if (username !== undefined && password !== undefined) {
      this.identityVault.set(projectIdentityCredentialKey(project.id, id), { version: 1, username, password });
    }
    this.store.addRecent(root);
    return projectSummary(root, this.identityVault);
  }

  async deleteIdentity(projectRoot: string, identityId: string): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    if (!this.identityVault) throw new TestCoordinatorError("CREDENTIAL_VAULT_UNAVAILABLE", "凭据存储不可用");
    const root = absoluteRoot(projectRoot);
    const project = loadProject(root);
    const id = projectIdentityId(identityId);
    if (!project.identities[id]) throw new TestCoordinatorError("BAD_REQUEST", "identity 不存在");
    this.identityVault.delete(projectIdentityCredentialKey(project.id, id));
    deleteProjectIdentity(root, id);
    return projectSummary(root, this.identityVault);
  }

  listZentaoConnections(): TestWorkbenchZentaoConnection[] {
    return this.store.listZentaoConnections().map((connection) => ({
      ...connection,
      credentialConfigured: this.hasZentaoCredential(connection.id),
    }));
  }

  async saveZentaoConnection(input: TestWorkbenchZentaoConnectionInput): Promise<TestWorkbenchZentaoConnection> {
    await this.assertLicensed();
    if (!this.identityVault || !this.zentaoFetch) {
      throw new TestCoordinatorError("ZENTAO_UNAVAILABLE", "禅道连接不可用");
    }
    const id = connectionId(input.id);
    const name = boundedText(input.name, "禅道连接名称", 80);
    const baseUrl = normalizeZentaoBaseUrl(input.baseUrl);
    const hasToken = typeof input.token === "string" && input.token.length > 0;
    const hasAccount = typeof input.account === "string" && input.account.length > 0;
    const hasPassword = typeof input.password === "string" && input.password.length > 0;
    if (hasAccount !== hasPassword || (hasToken && hasAccount)) {
      throw new TestCoordinatorError("BAD_REQUEST", "请使用 Token，或同时填写账号和密码");
    }
    const existing = this.store.getZentaoConnection(id);
    if (existing && existing.baseUrl !== baseUrl && !hasToken && !hasAccount) {
      throw new TestCoordinatorError("ZENTAO_REAUTH_REQUIRED", "禅道地址已变化，请重新输入 Token 或账号密码");
    }
    let token: string;
    if (hasToken) {
      token = boundedSecret(input.token, "禅道 Token", 4_096);
    } else if (hasAccount && hasPassword) {
      token = await ZentaoClient.exchangeToken(
        baseUrl,
        boundedSecret(input.account, "禅道账号", 200),
        boundedSecret(input.password, "禅道密码", 4_096),
        this.zentaoFetch,
      );
    } else {
      token = this.zentaoCredential(id, baseUrl);
    }
    const probe = await new ZentaoClient({ baseUrl, token }, this.zentaoFetch).probe();
    const connection: PersistedZentaoConnection = {
      id,
      name,
      baseUrl,
      connected: true,
      version: probe.version,
      edition: probe.edition,
      products: probe.products,
      users: probe.users,
      capabilities: probe.capabilities,
      checkedAt: new Date().toISOString(),
      error: null,
    };
    this.identityVault.set(zentaoTokenCredentialKey(id), { version: 1, baseUrl, token });
    this.store.setZentaoConnection(connection);
    return { ...connection, credentialConfigured: true };
  }

  async deleteZentaoConnection(connectionIdValue: string): Promise<void> {
    await this.assertLicensed();
    if (!this.identityVault) throw new TestCoordinatorError("CREDENTIAL_VAULT_UNAVAILABLE", "凭据存储不可用");
    const id = connectionId(connectionIdValue);
    const referenced = this.store.load().recentProjects.some(({ root }) => {
      try {
        const project = loadProject(root);
        return (
          project.zentao?.connectionId === id ||
          listFindings(root).some((summary) => {
            try {
              return loadFinding(root, summary.id, project).remote?.connectionId === id;
            } catch {
              return false;
            }
          })
        );
      } catch {
        return false;
      }
    });
    if (referenced) throw new TestCoordinatorError("ZENTAO_IN_USE", "仍有项目映射或远端 finding 使用该连接");
    this.identityVault.delete(zentaoTokenCredentialKey(id));
    this.store.deleteZentaoConnection(id);
  }

  async getZentaoCatalog(connectionIdValue: string, productId: number): Promise<ZentaoCatalog> {
    await this.assertLicensed();
    return this.zentaoClient(connectionIdValue).catalog(productId);
  }

  async setProjectZentao(input: TestWorkbenchZentaoProjectInput): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(input.projectRoot);
    if (readActiveRunName(root)) throw new TestCoordinatorError("TEST_BUSY", "当前测试结束后才能修改禅道映射");
    if (input.connectionId === null) {
      setProjectZentao(root, null);
      return projectSummary(root, this.identityVault);
    }
    const id = connectionId(input.connectionId);
    if (!Number.isSafeInteger(input.productId) || input.productId! < 1) {
      throw new TestCoordinatorError("BAD_REQUEST", "请选择禅道产品");
    }
    const catalog = await this.zentaoClient(id).catalog(input.productId!);
    if (!catalog.products.some((item) => item.id === String(input.productId))) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道产品不在当前账号目录中");
    }
    if (input.moduleId != null && !catalog.modules.some((item) => item.id === String(input.moduleId))) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道模块不在当前产品中");
    }
    if (input.openedBuild && !catalog.builds.some((item) => item.id === input.openedBuild)) {
      throw new TestCoordinatorError("BAD_REQUEST", "影响版本必须来自 Bug 选项目录");
    }
    if (input.assignedTo && !catalog.users.some((item) => item.id === input.assignedTo)) {
      throw new TestCoordinatorError("BAD_REQUEST", "默认指派人不在当前账号目录中");
    }
    setProjectZentao(root, {
      connectionId: id,
      productId: input.productId!,
      moduleId: input.moduleId ?? null,
      openedBuild: input.openedBuild ?? null,
      assignedTo: input.assignedTo ?? null,
    });
    return projectSummary(root, this.identityVault);
  }

  async prepareZentaoBug(projectRoot: string, findingId: string): Promise<TestWorkbenchZentaoBugDraft> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    const project = loadProject(root);
    const mapping = project.zentao;
    if (!mapping) throw new TestCoordinatorError("ZENTAO_NOT_CONFIGURED", "请先配置项目禅道映射");
    const finding = loadFinding(root, plainId(findingId, "findingId"), project);
    const catalog = await this.zentaoClient(mapping.connectionId).catalog(mapping.productId);
    this.assertZentaoCreateCapability(catalog, mapping);
    const marker = `Pi-Test: ${project.id}/${finding.id}`;
    const severity = ({ p0: 1, p1: 2, p2: 3, p3: 4 } as const)[finding.severity];
    return {
      projectRoot: root,
      findingId: finding.id,
      title: finding.title,
      description: this.zentaoBugDescription(project, finding),
      severity,
      priority: severity,
      type: catalog.bugTypes[0]?.id ?? "codeerror",
      bugTypes: catalog.bugTypes,
      evidence: finding.evidence,
      marker,
      connectionId: mapping.connectionId,
      productId: mapping.productId,
      moduleId: mapping.moduleId ?? null,
      openedBuild: mapping.openedBuild ?? null,
      assignedTo: mapping.assignedTo ?? null,
    };
  }

  async getZentaoBugConfirmation(input: TestWorkbenchZentaoSubmitBugInput): Promise<{ title: string; detail: string }> {
    await this.assertLicensed();
    const root = absoluteRoot(input?.projectRoot);
    const project = loadProject(root);
    const finding = loadFinding(root, plainId(input?.findingId, "findingId"), project);
    const marker = `Pi-Test: ${project.id}/${finding.id}`;
    if (input.marker !== marker) throw new TestCoordinatorError("BAD_REQUEST", "禅道来源标识不可修改");
    const title = boundedText(input.title, "Bug 标题", 120);
    if (!Number.isInteger(input.severity) || input.severity < 1 || input.severity > 4) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道严重程度无效");
    }
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 4) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道优先级无效");
    }
    boundedText(input.type, "Bug 类型", 100);
    boundedText(input.description, "Bug 描述", 20_000);
    if (!Array.isArray(input.evidence) || input.evidence.length > MAX_ZENTAO_EVIDENCE) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道证据列表无效");
    }
    return {
      title,
      detail: `严重程度 ${input.severity} · 优先级 ${input.priority} · 类型 ${input.type}\n证据 ${input.evidence.length} 个\n${marker}`,
    };
  }

  async submitZentaoBug(input: TestWorkbenchZentaoSubmitBugInput): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(input.projectRoot);
    const project = loadProject(root);
    const mapping = project.zentao;
    if (!mapping || mapping.connectionId !== input.connectionId || mapping.productId !== input.productId) {
      throw new TestCoordinatorError("ZENTAO_MAPPING_CHANGED", "项目禅道映射已变化，请重新打开预填表单");
    }
    const finding = loadFinding(root, plainId(input.findingId, "findingId"), project);
    if (finding.remote?.bugId) {
      throw new TestCoordinatorError("ZENTAO_ALREADY_SUBMITTED", `该问题已关联禅道 Bug #${finding.remote.bugId}`);
    }
    const marker = `Pi-Test: ${project.id}/${finding.id}`;
    if (input.marker !== marker) throw new TestCoordinatorError("BAD_REQUEST", "禅道来源标识不可修改");
    if (!Number.isInteger(input.severity) || input.severity < 1 || input.severity > 4) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道严重程度无效");
    }
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 4) {
      throw new TestCoordinatorError("BAD_REQUEST", "禅道优先级无效");
    }
    const title = boundedText(input.title, "Bug 标题", 120);
    const description = boundedText(input.description, "Bug 描述", 20_000);
    const type = boundedText(input.type, "Bug 类型", 100);
    if (!Array.isArray(input.evidence)) throw new TestCoordinatorError("BAD_REQUEST", "禅道证据列表无效");
    const evidence = [...new Set(input.evidence)];
    if (evidence.length > MAX_ZENTAO_EVIDENCE) {
      throw new TestCoordinatorError("BAD_REQUEST", `一次最多提交 ${MAX_ZENTAO_EVIDENCE} 个证据`);
    }
    if (evidence.some((item) => !finding.evidence.includes(item))) {
      throw new TestCoordinatorError("BAD_REQUEST", "只能提交 finding 已保存的证据");
    }
    const remoteBase: FindingRemote = {
      provider: "zentao",
      connectionId: mapping.connectionId,
      marker,
      syncStatus: "submitting",
      bugId: finding.remote?.bugId ?? null,
      url: finding.remote?.url ?? null,
      status: finding.remote?.status ?? null,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    };
    setFindingRemote(root, project, finding.id, remoteBase);
    const client = this.zentaoClient(mapping.connectionId);
    try {
      const catalog = await client.catalog(mapping.productId);
      this.assertZentaoCreateCapability(catalog, mapping);
      if (!catalog.bugTypes.some((item) => item.id === type)) {
        throw new TestCoordinatorError("BAD_REQUEST", "Bug 类型不在当前禅道选项目录中");
      }
      if (mapping.moduleId != null && !catalog.modules.some((item) => item.id === String(mapping.moduleId))) {
        throw new TestCoordinatorError("ZENTAO_MAPPING_CHANGED", "项目禅道模块已不可用，请重新配置映射");
      }
      if (mapping.openedBuild && !catalog.builds.some((item) => item.id === mapping.openedBuild)) {
        throw new TestCoordinatorError("ZENTAO_MAPPING_CHANGED", "项目影响版本已不可用，请重新配置映射");
      }
      if (mapping.assignedTo && !catalog.users.some((item) => item.id === mapping.assignedTo)) {
        throw new TestCoordinatorError("ZENTAO_MAPPING_CHANGED", "项目默认指派人已不可用，请重新配置映射");
      }
      const result = await client.createBug({
        productId: mapping.productId,
        title,
        steps: description,
        severity: input.severity,
        priority: input.priority,
        type,
        moduleId: mapping.moduleId,
        openedBuild: mapping.openedBuild,
        assignedTo: mapping.assignedTo,
        marker,
      });
      let lastError: string | null = null;
      if (evidence.length > 0) {
        try {
          await client.attachFiles(result.bug.id, this.evidenceAttachments(root, evidence));
          this.updateZentaoCapability(mapping.connectionId, "attachments", "supported");
        } catch (error) {
          if (this.isUnavailableZentaoAttachment(error)) {
            this.updateZentaoCapability(mapping.connectionId, "attachments", "unavailable");
          }
          lastError = `Bug 已创建，但证据附件失败：${this.zentaoError(error)}`;
        }
      }
      setFindingRemote(root, project, finding.id, {
        ...remoteBase,
        syncStatus: result.bug.status === "closed" ? "remote_closed" : "submitted",
        bugId: result.bug.id,
        url: result.bug.url,
        status: result.bug.status,
        lastSyncedAt: new Date().toISOString(),
        lastError,
      });
      return projectSummary(root, this.identityVault);
    } catch (error) {
      setFindingRemote(root, project, finding.id, {
        ...remoteBase,
        syncStatus: "failed",
        lastSyncedAt: new Date().toISOString(),
        lastError: this.zentaoError(error),
      });
      throw error;
    }
  }

  getZentaoBugUrl(projectRoot: string, findingId: string): string {
    const root = absoluteRoot(projectRoot);
    const project = loadProject(root);
    const finding = loadFinding(root, plainId(findingId, "findingId"), project);
    if (!finding.remote?.bugId) throw new TestCoordinatorError("ZENTAO_NOT_SUBMITTED", "该问题尚未提交禅道");
    const connection = this.requireZentaoConnection(finding.remote.connectionId);
    return `${connection.baseUrl}/index.php?m=bug&f=view&bugID=${finding.remote.bugId}`;
  }

  async refreshZentaoBug(projectRoot: string, findingId: string): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    const project = loadProject(root);
    const finding = loadFinding(root, plainId(findingId, "findingId"), project);
    if (!finding.remote?.bugId) throw new TestCoordinatorError("ZENTAO_NOT_SUBMITTED", "该问题尚未提交禅道");
    const bug = await this.zentaoClient(finding.remote.connectionId).getBug(finding.remote.bugId);
    setFindingRemote(root, project, finding.id, {
      ...finding.remote,
      syncStatus: bug.status === "closed" ? "remote_closed" : "submitted",
      url: bug.url,
      status: bug.status,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    return projectSummary(root, this.identityVault);
  }

  async getZentaoRetestConfirmation(
    input: TestWorkbenchZentaoRetestInput,
  ): Promise<{ message: string; detail: string }> {
    await this.assertLicensed();
    const root = absoluteRoot(input?.projectRoot);
    const project = loadProject(root);
    const finding = loadFinding(root, plainId(input?.findingId, "findingId"), project);
    if (!finding.remote?.bugId) throw new TestCoordinatorError("ZENTAO_NOT_SUBMITTED", "该问题尚未提交禅道");
    boundedText(input.note, "复测备注", 20_000);
    if (!Array.isArray(input.evidence) || input.evidence.length > MAX_ZENTAO_EVIDENCE) {
      throw new TestCoordinatorError("BAD_REQUEST", "复测证据列表无效");
    }
    return {
      message: `向禅道 Bug #${finding.remote.bugId} 追加复测记录？`,
      detail: `证据 ${input.evidence.length} 个。远端 Bug 状态不会被自动关闭。`,
    };
  }

  async appendZentaoRetest(input: TestWorkbenchZentaoRetestInput): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(input.projectRoot);
    const project = loadProject(root);
    const finding = loadFinding(root, plainId(input.findingId, "findingId"), project);
    if (!finding.remote?.bugId) throw new TestCoordinatorError("ZENTAO_NOT_SUBMITTED", "该问题尚未提交禅道");
    const connection = this.requireZentaoConnection(finding.remote.connectionId);
    if (connection.capabilities?.comments === "unavailable") {
      throw new TestCoordinatorError("ZENTAO_COMMENT_UNAVAILABLE", "当前禅道现代 REST API 未通过备注写入验证");
    }
    const note = boundedText(input.note, "复测备注", 20_000);
    if (!Array.isArray(input.evidence)) throw new TestCoordinatorError("BAD_REQUEST", "复测证据列表无效");
    const evidence = [...new Set(input.evidence)];
    if (evidence.length > MAX_ZENTAO_EVIDENCE) {
      throw new TestCoordinatorError("BAD_REQUEST", `一次最多追加 ${MAX_ZENTAO_EVIDENCE} 个证据`);
    }
    if (evidence.some((item) => !finding.evidence.includes(item))) {
      throw new TestCoordinatorError("BAD_REQUEST", "只能追加 finding 已保存的证据");
    }
    const client = this.zentaoClient(finding.remote.connectionId);
    if (evidence.length > 0) {
      if (connection.capabilities?.attachments === "unavailable") {
        throw new TestCoordinatorError("ZENTAO_ATTACHMENT_UNAVAILABLE", "当前禅道未通过附件关联验证");
      }
      await client.attachFiles(finding.remote.bugId, this.evidenceAttachments(root, evidence));
      this.updateZentaoCapability(finding.remote.connectionId, "attachments", "supported");
    }
    let bug;
    try {
      bug = await client.appendComment(finding.remote.bugId, note);
      this.updateZentaoCapability(finding.remote.connectionId, "comments", "supported");
    } catch (error) {
      this.updateZentaoCapability(finding.remote.connectionId, "comments", "unavailable");
      throw error;
    }
    setFindingRemote(root, project, finding.id, {
      ...finding.remote,
      syncStatus: bug.status === "closed" ? "remote_closed" : "submitted",
      status: bug.status,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    return projectSummary(root, this.identityVault);
  }

  private assertZentaoCreateCapability(
    catalog: ZentaoCatalog,
    mapping: NonNullable<ReturnType<typeof loadProject>["zentao"]>,
  ): void {
    const missingConfigured = catalog.capabilities.bugRequiredFields.filter(
      (field) => (field === "module" && !mapping.moduleId) || (field === "assignedTo" && !mapping.assignedTo),
    );
    const fields = [...catalog.capabilities.unsupportedBugFields, ...missingConfigured];
    if (!catalog.capabilities.createBug || fields.length > 0) {
      throw new TestCoordinatorError(
        "ZENTAO_CREATE_UNAVAILABLE",
        fields.length
          ? `当前禅道有未满足的 Bug 必填字段：${[...new Set(fields)].join("、")}`
          : "当前禅道未通过 Bug 创建能力探测",
      );
    }
  }

  private hasZentaoCredential(id: string): boolean {
    try {
      const connection = this.store.getZentaoConnection(id);
      if (!connection || !this.identityVault?.has(zentaoTokenCredentialKey(id))) return false;
      const value = this.identityVault.get(zentaoTokenCredentialKey(id));
      return value?.version === 1 && value.baseUrl === connection.baseUrl && typeof value.token === "string";
    } catch {
      return false;
    }
  }

  private zentaoCredential(id: string, baseUrl: string): string {
    if (!this.identityVault) throw new TestCoordinatorError("CREDENTIAL_VAULT_UNAVAILABLE", "凭据存储不可用");
    const value = this.identityVault.get(zentaoTokenCredentialKey(connectionId(id)));
    if (value?.version !== 1 || value.baseUrl !== baseUrl || typeof value.token !== "string") {
      throw new TestCoordinatorError("ZENTAO_CREDENTIAL_MISSING", "禅道 Token 缺失或与连接地址不匹配");
    }
    return value.token;
  }

  private requireZentaoConnection(id: string): PersistedZentaoConnection {
    const connection = this.store.getZentaoConnection(id);
    if (!connection) throw new TestCoordinatorError("ZENTAO_CONNECTION_MISSING", "禅道连接不存在");
    return connection;
  }

  private zentaoClient(id: string): ZentaoClient {
    if (!this.zentaoFetch) throw new TestCoordinatorError("ZENTAO_UNAVAILABLE", "禅道连接不可用");
    const connection = this.requireZentaoConnection(id);
    return new ZentaoClient(
      { baseUrl: connection.baseUrl, token: this.zentaoCredential(id, connection.baseUrl) },
      this.zentaoFetch,
    );
  }

  private updateZentaoCapability(
    id: string,
    capability: "attachments" | "comments",
    value: "supported" | "unavailable",
  ): void {
    const connection = this.requireZentaoConnection(id);
    if (!connection.capabilities) return;
    this.store.setZentaoConnection({
      ...connection,
      capabilities: { ...connection.capabilities, [capability]: value },
      checkedAt: new Date().toISOString(),
    });
  }

  private zentaoError(error: unknown): string {
    if (error instanceof ZentaoError || error instanceof TestCoordinatorError) return error.message.slice(0, 1_000);
    return "禅道请求失败";
  }

  private isUnavailableZentaoAttachment(error: unknown): boolean {
    return (
      error instanceof ZentaoError &&
      (error.code === "ATTACHMENT_UNSUPPORTED" ||
        (error.code === "HTTP_ERROR" && (error.status === 404 || error.status === 405)))
    );
  }

  private zentaoBugDescription(project: ReturnType<typeof loadProject>, finding: Finding): string {
    return [
      `运行环境：${project.environment} / ${finding.surface}`,
      `问题摘要：${finding.summary}`,
      `重现步骤：\n${finding.stepsToReproduce.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
      `期望结果：${finding.expected}`,
      `实际结果：${finding.actual}`,
      `本地来源：case ${finding.caseId ?? "无"} / run ${finding.runIds.join(", ")}`,
    ].join("\n\n");
  }

  private evidenceAttachments(
    root: string,
    evidence: string[],
  ): Array<{ name: string; type: string; bytes: Uint8Array }> {
    const files = evidence.map((item) => this.evidenceAttachment(root, item));
    if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > MAX_ZENTAO_EVIDENCE_BYTES) {
      throw new TestCoordinatorError("BAD_REQUEST", "一次提交的证据总量不能超过 50 MB");
    }
    return files;
  }

  private evidenceAttachment(root: string, evidence: string): { name: string; type: string; bytes: Uint8Array } {
    this.readEvidence(root, evidence);
    const match = EVIDENCE_RE.exec(evidence)!;
    const filePath = fs.realpathSync(path.join(root, "runs", match[1], "evidence", match[2]));
    const extension = path.extname(filePath).toLowerCase();
    return {
      name: path.basename(filePath),
      type: extension === ".png" ? "image/png" : extension === ".txt" ? "text/plain" : "image/jpeg",
      bytes: fs.readFileSync(filePath),
    };
  }

  async getBrowserState(projectRoot: string, surfaceName: string): Promise<TestWorkbenchBrowserState> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    const surface = webSurface(surfaceName);
    const project = loadProject(root);
    requireSurfaceReady(project, surface);
    if (!this.browserAssets.prepared) {
      return {
        ready: false,
        summary: "browser assets unavailable",
        extensionConnected: false,
        extensionVersion: null,
        expectedExtensionVersion: this.browserAssets.productExtensionVersion,
        assetsPrepared: false,
        assetError: this.browserAssets.error,
        extensionPath: this.browserAssets.extensionPath,
        tabs: [],
        binding: null,
      };
    }
    const inspected = await this.browser.inspect();
    const state = readBrowserState(inspected.status, inspected.tabs, this.browserAssets);
    const storedBinding = this.store.getBinding(project.id, root, surface);
    let binding = storedBinding;
    if (binding) {
      const { profileId, tabId } = binding;
      const profileTabs = state.tabs.filter((tab) => tab.profileId === profileId);
      if (profileTabs.length === 0) {
        this.store.clearBinding(project.id, root, surface);
        binding = null;
      } else if (tabId && !profileTabs.some((tab) => tab.tabId === tabId)) {
        binding = { profileId };
        this.store.setBinding(project.id, root, surface, binding);
      }
    }
    if (!binding && !storedBinding) {
      const profiles = [...new Set(state.tabs.map((tab) => tab.profileId))];
      if (profiles.length === 1) {
        const profileTabs = state.tabs.filter((tab) => tab.profileId === profiles[0]);
        binding = { profileId: profiles[0], ...(profileTabs.length === 1 ? { tabId: profileTabs[0].tabId } : {}) };
        this.store.setBinding(project.id, root, surface, binding);
      }
    }
    return { ...state, binding };
  }

  async getMobileState(projectRoot: string): Promise<TestWorkbenchMobileState> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    const project = loadProject(root);
    if (!project.surfaces.app) throw new TestCoordinatorError("BAD_REQUEST", "项目未选择 App 测试端");
    const assets = this.androidAssets;
    if (!assets?.supported || !this.mobile) {
      return {
        supported: false,
        ready: false,
        summary: "Android 驱动不可用",
        error: assets?.error ?? "Android 驱动当前仅支持 Windows x64",
        handsetsVersion: assets?.handsetsVersion ?? "0.1.38",
        platformToolsVersion: assets?.platformToolsVersion ?? "37.0.1",
        platformToolsInstalled: false,
        platformToolsDownloadAvailable: false,
        devices: [],
        selectedSerial: project.surfaces.app.serial ?? null,
        packageName: project.surfaces.app.package,
        foregroundPackageName: null,
        foregroundActivity: null,
        previewDataUrl: null,
      };
    }
    if (!assets.platformToolsInstalled) {
      return {
        supported: true,
        ready: false,
        summary: "需要准备 Android platform-tools",
        error: null,
        handsetsVersion: assets.handsetsVersion,
        platformToolsVersion: assets.platformToolsVersion,
        platformToolsInstalled: false,
        platformToolsDownloadAvailable: assets.platformToolsDownloadAvailable,
        devices: [],
        selectedSerial: project.surfaces.app.serial ?? null,
        packageName: project.surfaces.app.package,
        foregroundPackageName: null,
        foregroundActivity: null,
        previewDataUrl: null,
      };
    }
    const devices = await this.mobile.devices();
    const readyDevices = devices.filter((device) => device.state === "device");
    let selectedSerial = project.surfaces.app.serial ?? null;
    if (!selectedSerial && readyDevices.length === 1) selectedSerial = readyDevices[0].serial;
    const selected = devices.find((device) => device.serial === selectedSerial);
    let foregroundPackageName: string | null = null;
    let foregroundActivity: string | null = null;
    if (selected?.state === "device") {
      try {
        const foreground = await this.mobile.foreground(selected.serial);
        foregroundPackageName = foreground.packageName;
        foregroundActivity = foreground.activity;
      } catch {
        // The daemon may not be connected yet; device diagnosis remains available.
      }
    }
    const ready = selected?.state === "device" && project.surfaces.app.package !== null;
    return {
      supported: true,
      ready,
      summary:
        devices.length === 0
          ? "未检测到 Android 设备"
          : selected?.state === "unauthorized"
            ? "等待手机允许 USB 调试"
            : selected?.state === "offline"
              ? "Android 设备 offline"
              : ready
                ? "Android App 可测"
                : "请选择设备并确认当前 App",
      error: null,
      handsetsVersion: assets.handsetsVersion,
      platformToolsVersion: assets.platformToolsVersion,
      platformToolsInstalled: true,
      platformToolsDownloadAvailable: assets.platformToolsDownloadAvailable,
      devices,
      selectedSerial,
      packageName: project.surfaces.app.package,
      foregroundPackageName,
      foregroundActivity,
      previewDataUrl: null,
    };
  }

  async installMobileTools(projectRoot: string): Promise<TestWorkbenchMobileState> {
    await this.assertLicensed();
    absoluteRoot(projectRoot);
    if (!this.installAndroidAssets) {
      throw new TestCoordinatorError("ANDROID_TOOLS_UNAVAILABLE", "此构建尚未配置 Android 工具安装");
    }
    const installed = await this.installAndroidAssets();
    if (this.androidAssets) Object.assign(this.androidAssets, installed);
    else this.androidAssets = installed;
    return this.getMobileState(projectRoot);
  }

  async connectMobile(projectRoot: string, serialValue: string): Promise<TestWorkbenchMobileState> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    if (!this.mobile) throw new TestCoordinatorError("MOBILE_DRIVER_UNAVAILABLE", "移动端驱动不可用");
    const selectedSerial = plainId(serialValue, "device serial");
    await this.mobile.connect(selectedSerial);
    updateAppSurface(root, { serial: selectedSerial });
    const previewPath = path.join(this.androidAssets?.root ?? path.dirname(root), `preview-${randomUUID()}.png`);
    try {
      await this.mobile.screenshot({ serial: selectedSerial, out: previewPath });
      return {
        ...(await this.getMobileState(root)),
        previewDataUrl: `data:image/png;base64,${fs.readFileSync(previewPath).toString("base64")}`,
      };
    } finally {
      fs.rmSync(previewPath, { force: true });
    }
  }

  async confirmForegroundApp(projectRoot: string, serialValue: string): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    if (!this.mobile) throw new TestCoordinatorError("MOBILE_DRIVER_UNAVAILABLE", "移动端驱动不可用");
    const selectedSerial = plainId(serialValue, "device serial");
    await this.mobile.connect(selectedSerial);
    const foreground = await this.mobile.foreground(selectedSerial);
    updateAppSurface(root, {
      package: foreground.packageName,
      activity: foreground.activity,
      serial: selectedSerial,
    });
    this.store.addRecent(root);
    return projectSummary(root, this.identityVault);
  }

  async copyExtensionPath(): Promise<{ path: string }> {
    await this.assertLicensed();
    if (!this.browserAssets.prepared) {
      throw new TestCoordinatorError("BROWSER_ASSETS_UNAVAILABLE", this.browserAssets.error ?? "浏览器资产不可用");
    }
    this.copyBrowserExtensionPath(this.browserAssets.extensionPath);
    return { path: this.browserAssets.extensionPath };
  }

  async openExtensionManager(): Promise<void> {
    await this.assertLicensed();
    if (!this.browserAssets.prepared) {
      throw new TestCoordinatorError("BROWSER_ASSETS_UNAVAILABLE", this.browserAssets.error ?? "浏览器资产不可用");
    }
    this.openBrowserExtensionManager();
  }

  async bindBrowser(
    projectRoot: string,
    surfaceName: string,
    profileIdValue: string,
    tabIdValue?: string,
  ): Promise<TestWorkbenchBrowserState> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    const surface = webSurface(surfaceName);
    const project = loadProject(root);
    requireSurfaceReady(project, surface);
    const profileId = plainId(profileIdValue, "profileId");
    const tabId = tabIdValue === undefined ? undefined : plainId(tabIdValue, "tabId");
    if (!this.browserAssets.prepared) {
      throw new TestCoordinatorError("BROWSER_ASSETS_UNAVAILABLE", this.browserAssets.error ?? "浏览器资产不可用");
    }
    const inspected = await this.browser.inspect();
    const state = readBrowserState(inspected.status, inspected.tabs, this.browserAssets);
    if (!state.tabs.some((tab) => tab.profileId === profileId)) {
      throw new TestCoordinatorError("BROWSER_BINDING_REQUIRED", "所选 Chrome Profile 已不可用");
    }
    if (tabId && !state.tabs.some((tab) => tab.profileId === profileId && tab.tabId === tabId)) {
      throw new TestCoordinatorError("BROWSER_TAB_REQUIRED", "所选 Chrome 页面已不可用");
    }
    const binding = { profileId, ...(tabId ? { tabId } : {}) };
    this.store.setBinding(project.id, root, surface, binding);
    return { ...state, binding };
  }

  async setCaseStatus(
    projectRoot: string,
    caseId: string,
    status: "draft" | "stable" | "disabled",
  ): Promise<TestWorkbenchProject> {
    await this.assertLicensed();
    const root = absoluteRoot(projectRoot);
    if (readActiveRunName(root)) throw new TestCoordinatorError("TEST_BUSY", "当前测试结束后才能修改用例状态");
    const project = loadProject(root);
    setCaseStatus(root, plainId(caseId, "caseId"), status, project);
    return projectSummary(root, this.identityVault);
  }

  playCases(projectRoot: string, sessionId: string, caseIds: string[]) {
    const root = absoluteRoot(projectRoot);
    if (!Array.isArray(caseIds) || caseIds.length < 1 || caseIds.length > 100) {
      throw new TestCoordinatorError("BAD_REQUEST", "请选择 stable 用例");
    }
    return this.coordinator.call("test.play", {
      projectRoot: root,
      sessionId: plainId(sessionId, "sessionId"),
      action: "run",
      caseIds: caseIds.map((id) => plainId(id, "caseId")),
      title: `稳定用例回归 (${caseIds.length})`,
      slug: `regression-${Date.now().toString(36)}`,
      trigger: "regression",
    });
  }

  startRun(projectRoot: string, sessionId: string, surfaceName: string, title: string) {
    const root = absoluteRoot(projectRoot);
    const surface = workbenchSurface(surfaceName);
    return this.coordinator.call("test.run", {
      projectRoot: root,
      sessionId: plainId(sessionId, "sessionId"),
      action: "start",
      title: typeof title === "string" && title.trim() ? title.trim() : "功能测试",
      slug: `${surface}-${Date.now().toString(36)}`,
      trigger: "manual",
      surface,
      risk: "read",
      note: `${surface} 最小技术闭环`,
    });
  }

  controlRun(
    projectRoot: string,
    sessionId: string,
    request:
      | { action: "pause"; surface: "h5" | "admin" | "app"; sensitive?: boolean }
      | {
          action: "takeover";
          surface: "h5" | "admin" | "app";
          reason: "login" | "verification" | "scan" | "authorization" | "judgment";
          sensitive?: boolean;
        }
      | { action: "resume" },
  ) {
    return this.coordinator.call("test.run", {
      projectRoot: absoluteRoot(projectRoot),
      sessionId: plainId(sessionId, "sessionId"),
      ...request,
    });
  }

  finishRun(
    projectRoot: string,
    sessionId: string,
    status: "passed" | "failed" | "blocked" | "aborted",
    summaryText?: string,
  ) {
    return this.coordinator.call("test.run", {
      projectRoot: absoluteRoot(projectRoot),
      sessionId: plainId(sessionId, "sessionId"),
      action: "finish",
      status,
      ...(summaryText?.trim() ? { summaryText: summaryText.trim() } : {}),
    });
  }

  observe(projectRoot: string, sessionId: string, surfaceName: string, mode: "text" | "snapshot" | "visual") {
    return this.coordinator.call("test.observe", {
      projectRoot: absoluteRoot(projectRoot),
      sessionId: plainId(sessionId, "sessionId"),
      surface: workbenchSurface(surfaceName),
      mode,
    });
  }

  act(
    projectRoot: string,
    sessionId: string,
    surfaceName: string,
    risk: "read" | "business_write" | "high",
    action: TestActRequest["action"],
  ) {
    return this.coordinator.call("test.act", {
      projectRoot: absoluteRoot(projectRoot),
      sessionId: plainId(sessionId, "sessionId"),
      surface: workbenchSurface(surfaceName),
      risk,
      action,
    });
  }

  validateEvidence(projectRoot: string, evidence: string): void {
    this.readEvidence(projectRoot, evidence);
  }

  readEvidence(projectRoot: string, evidence: string): { dataUrl: string | null; text: string | null } {
    const root = absoluteRoot(projectRoot);
    const match = EVIDENCE_RE.exec(evidence);
    if (!match) throw new TestCoordinatorError("BAD_REQUEST", "证据路径无效");
    const filePath = path.join(root, "runs", match[1], "evidence", match[2]);
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TestCoordinatorError("BAD_REQUEST", "证据路径越界");
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) {
      throw new TestCoordinatorError("BAD_REQUEST", "证据文件无效或过大");
    }
    const realRoot = fs.realpathSync(root);
    const realFilePath = fs.realpathSync(filePath);
    const realRelative = path.relative(realRoot, realFilePath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new TestCoordinatorError("BAD_REQUEST", "证据路径越界");
    }
    if (realFilePath.toLowerCase().endsWith(".txt")) {
      return { dataUrl: null, text: fs.readFileSync(realFilePath, "utf8") };
    }
    const mime = realFilePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    return { dataUrl: `data:${mime};base64,${fs.readFileSync(realFilePath).toString("base64")}`, text: null };
  }

  async createFinding(input: TestWorkbenchFindingInput) {
    const root = absoluteRoot(input.projectRoot);
    const surface = workbenchSurface(input.surface);
    const { project } = await this.coordinator.assertActiveLease({
      projectRoot: root,
      sessionId: plainId(input.sessionId, "sessionId"),
    });
    this.readEvidence(root, input.evidence);
    if (!["p0", "p1", "p2", "p3"].includes(input.severity)) {
      throw new TestCoordinatorError("BAD_REQUEST", "severity 无效");
    }
    if (
      !Array.isArray(input.stepsToReproduce) ||
      input.stepsToReproduce.length < 1 ||
      input.stepsToReproduce.length > 50
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "复现步骤无效");
    }
    const stepsToReproduce = input.stepsToReproduce.map((step) => boundedText(step, "复现步骤", 1_000));
    const id = `finding-${randomUUID()}`;
    const finding = createFinding(root, project, {
      id,
      title: boundedText(input.title, "问题标题", 120),
      summary: boundedText(input.summary, "问题摘要", 5_000),
      stepsToReproduce,
      expected: boundedText(input.expected, "预期结果", 5_000),
      actual: boundedText(input.actual, "实际结果", 5_000),
      evidence: [input.evidence],
      surface,
      severity: input.severity,
      confidence: "observed",
    });
    return { id: finding.id, status: finding.status, title: finding.title, severity: finding.severity };
  }
}
