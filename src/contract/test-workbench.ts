import type {
  TestActRequest,
  TestActResult,
  TestObserveResult,
  TestPlayResult,
  TestRunResult,
} from "../../packages/pi-test/contract.ts";
import type {
  ProjectEnvironment,
  ProjectZentao,
  SurfaceName,
  SurfaceReadiness,
  VisualModelRef,
} from "../../packages/pi-test/core/project.ts";
import type { FindingRemoteSyncStatus } from "../../packages/pi-test/core/finding.ts";
import type { ZentaoCapabilities, ZentaoCatalog, ZentaoItem } from "../main/zentao-client.ts";

export type TestLicensePhase =
  "unconfigured" | "checking" | "authorized" | "unlicensed" | "revoked" | "offline" | "invalid" | "development_bypass";

export interface TestLicenseState {
  phase: TestLicensePhase;
  authorized: boolean;
  readOnly: boolean;
  deviceCode: string;
  deviceFingerprint: string | null;
  checkedAt: string | null;
  lastValidAt: string | null;
  licenseId: string | null;
  message: string;
}

export interface TestWorkbenchBrowserTab {
  browserId: string;
  profileId: string;
  profileLabel: string | null;
  tabId: string;
  title: string;
  url: string;
}

export interface TestWorkbenchBrowserState {
  ready: boolean;
  summary: string;
  extensionConnected: boolean;
  extensionVersion: string | null;
  expectedExtensionVersion: string;
  assetsPrepared: boolean;
  assetError: string | null;
  extensionPath: string;
  tabs: TestWorkbenchBrowserTab[];
  binding: { profileId: string; tabId?: string } | null;
}

export interface TestWorkbenchMobileDevice {
  serial: string;
  state: "device" | "unauthorized" | "offline" | "other";
  model: string | null;
  product: string | null;
}

export interface TestWorkbenchMobileState {
  supported: boolean;
  ready: boolean;
  summary: string;
  error: string | null;
  handsetsVersion: string;
  platformToolsVersion: string;
  platformToolsInstalled: boolean;
  platformToolsDownloadAvailable: boolean;
  devices: TestWorkbenchMobileDevice[];
  selectedSerial: string | null;
  packageName: string | null;
  foregroundPackageName: string | null;
  foregroundActivity: string | null;
  previewDataUrl: string | null;
}

export interface TestWorkbenchRunSummary {
  dirName: string;
  id: string;
  title: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  evidence: string[];
}

export interface TestWorkbenchFindingSummary {
  id: string;
  status: string;
  title: string;
  severity: string;
  evidence: string[];
  remote: {
    connectionId: string;
    syncStatus: FindingRemoteSyncStatus;
    bugId: number | null;
    url: string | null;
    status: string | null;
    lastError: string | null;
  } | null;
}

export type TestWorkbenchZentaoCatalog = ZentaoCatalog;

export interface TestWorkbenchZentaoConnection {
  id: string;
  name: string;
  baseUrl: string;
  credentialConfigured: boolean;
  connected: boolean;
  version: string | null;
  edition: string | null;
  products: ZentaoItem[];
  users: ZentaoItem[];
  capabilities: ZentaoCapabilities | null;
  checkedAt: string | null;
  error: string | null;
}

export interface TestWorkbenchZentaoConnectionInput {
  id: string;
  name: string;
  baseUrl: string;
  token?: string;
  account?: string;
  password?: string;
}

export interface TestWorkbenchZentaoProjectInput {
  projectRoot: string;
  connectionId: string | null;
  productId?: number;
  moduleId?: number | null;
  openedBuild?: string | null;
  assignedTo?: string | null;
}

export interface TestWorkbenchZentaoBugDraft {
  projectRoot: string;
  findingId: string;
  title: string;
  description: string;
  severity: number;
  priority: number;
  type: string;
  bugTypes: ZentaoItem[];
  evidence: string[];
  marker: string;
  connectionId: string;
  productId: number;
  moduleId: number | null;
  openedBuild: string | null;
  assignedTo: string | null;
}

export type TestWorkbenchZentaoSubmitBugInput = TestWorkbenchZentaoBugDraft;

export interface TestWorkbenchZentaoRetestInput {
  projectRoot: string;
  findingId: string;
  note: string;
  evidence: string[];
}

export interface TestWorkbenchIdentity {
  id: string;
  name: string;
  surfaces: Array<"h5" | "admin" | "app">;
  defaultSurfaces: Array<"h5" | "admin" | "app">;
  credentialConfigured: boolean;
}

export interface TestWorkbenchProject {
  root: string;
  id: string;
  archived: boolean;
  name: string;
  environment: ProjectEnvironment;
  surfaces: Array<{ name: SurfaceName; url: string | null; readiness: SurfaceReadiness }>;
  identities: TestWorkbenchIdentity[];
  activeRun: TestRunResult | null;
  runs: TestWorkbenchRunSummary[];
  cases: Array<{ id: string; status: string; title: string; surface: string }>;
  findings: TestWorkbenchFindingSummary[];
  map: string;
  visualCheckEnabled: boolean;
  visualModel: VisualModelRef | null;
  zentao: ProjectZentao | null;
}

export interface TestWorkbenchCreateProjectInput {
  root: string;
  name: string;
  environment: ProjectEnvironment;
  surfaces: Array<"h5" | "admin" | "app">;
  h5Url?: string;
  adminUrl?: string;
  visualCheck: boolean;
  visualModel: VisualModelRef | null;
}

export interface TestWorkbenchUpdateProjectInput {
  root: string;
  name: string;
  environment: ProjectEnvironment;
  surfaces: Array<"h5" | "admin" | "app">;
  h5Url?: string;
  adminUrl?: string;
  visualCheck: boolean;
  visualModel: VisualModelRef | null;
}

export interface TestWorkbenchIdentityInput {
  projectRoot: string;
  id: string;
  name: string;
  surfaces: Array<"h5" | "admin" | "app">;
  defaultSurfaces: Array<"h5" | "admin" | "app">;
  username?: string;
  password?: string;
}

export interface TestWorkbenchFindingInput {
  projectRoot: string;
  sessionId: string;
  surface: "h5" | "admin" | "app";
  title: string;
  summary: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  severity: "p0" | "p1" | "p2" | "p3";
  evidence: string;
}

export interface TestWorkbenchApi {
  getTestLicenseState: () => Promise<TestLicenseState>;
  refreshTestLicense: () => Promise<TestLicenseState>;
  listRecentProjects: () => Promise<TestWorkbenchProject[]>;
  createProject: (input: TestWorkbenchCreateProjectInput) => Promise<TestWorkbenchProject>;
  updateProject: (input: TestWorkbenchUpdateProjectInput) => Promise<TestWorkbenchProject>;
  openProject: (root: string) => Promise<TestWorkbenchProject>;
  setProjectArchived: (projectRoot: string, archived: boolean) => Promise<void>;
  removeProject: (projectRoot: string) => Promise<void>;
  deleteProjectData: (projectRoot: string, confirmationName: string) => Promise<void>;
  saveIdentity: (input: TestWorkbenchIdentityInput) => Promise<TestWorkbenchProject>;
  deleteIdentity: (projectRoot: string, identityId: string) => Promise<TestWorkbenchProject>;
  listZentaoConnections: () => Promise<TestWorkbenchZentaoConnection[]>;
  saveZentaoConnection: (input: TestWorkbenchZentaoConnectionInput) => Promise<TestWorkbenchZentaoConnection>;
  deleteZentaoConnection: (connectionId: string) => Promise<void>;
  getZentaoCatalog: (connectionId: string, productId: number) => Promise<ZentaoCatalog>;
  setProjectZentao: (input: TestWorkbenchZentaoProjectInput) => Promise<TestWorkbenchProject>;
  prepareZentaoBug: (projectRoot: string, findingId: string) => Promise<TestWorkbenchZentaoBugDraft>;
  submitZentaoBug: (input: TestWorkbenchZentaoSubmitBugInput) => Promise<TestWorkbenchProject>;
  refreshZentaoBug: (projectRoot: string, findingId: string) => Promise<TestWorkbenchProject>;
  openZentaoBug: (projectRoot: string, findingId: string) => Promise<void>;
  appendZentaoRetest: (input: TestWorkbenchZentaoRetestInput) => Promise<TestWorkbenchProject>;
  getBrowserState: (projectRoot: string, surface: "h5" | "admin") => Promise<TestWorkbenchBrowserState>;
  copyBrowserExtensionPath: () => Promise<{ path: string }>;
  openBrowserExtensionManager: () => Promise<void>;
  getMobileState: (projectRoot: string) => Promise<TestWorkbenchMobileState>;
  installAndroidTools: (projectRoot: string) => Promise<TestWorkbenchMobileState>;
  connectMobile: (projectRoot: string, serial: string) => Promise<TestWorkbenchMobileState>;
  confirmForegroundApp: (projectRoot: string, serial: string) => Promise<TestWorkbenchProject>;
  bindBrowser: (
    projectRoot: string,
    surface: "h5" | "admin",
    profileId: string,
    tabId?: string,
  ) => Promise<TestWorkbenchBrowserState>;
  setCaseStatus: (
    projectRoot: string,
    caseId: string,
    status: "draft" | "stable" | "disabled",
  ) => Promise<TestWorkbenchProject>;
  playCases: (projectRoot: string, sessionId: string, caseIds: string[]) => Promise<TestPlayResult>;
  startRun: (
    projectRoot: string,
    sessionId: string,
    surface: "h5" | "admin" | "app",
    title: string,
  ) => Promise<TestRunResult>;
  controlRun: (
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
  ) => Promise<TestRunResult>;
  finishRun: (
    projectRoot: string,
    sessionId: string,
    status: "passed" | "failed" | "blocked" | "aborted",
    summaryText?: string,
  ) => Promise<TestRunResult>;
  observe: (
    projectRoot: string,
    sessionId: string,
    surface: "h5" | "admin" | "app",
    mode: "text" | "snapshot" | "visual",
  ) => Promise<TestObserveResult>;
  act: (
    projectRoot: string,
    sessionId: string,
    surface: "h5" | "admin" | "app",
    risk: "read" | "business_write" | "high",
    action: TestActRequest["action"],
  ) => Promise<TestActResult>;
  readEvidence: (projectRoot: string, evidence: string) => Promise<{ dataUrl: string | null; text: string | null }>;
  createFinding: (input: TestWorkbenchFindingInput) => Promise<TestWorkbenchFindingSummary>;
}
