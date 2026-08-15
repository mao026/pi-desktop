import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createCase,
  listCases,
  loadCase,
  setCaseStatus,
  updateCase,
  type TestCase,
} from "../../packages/pi-test/core/case.ts";
import {
  addRetest,
  createFinding,
  listFindings,
  loadFinding,
  setFindingStatus,
} from "../../packages/pi-test/core/finding.ts";
import { compileCapturePattern } from "../../packages/pi-test/core/capture.ts";
import { readMap, updateMapSection } from "../../packages/pi-test/core/map.ts";
import {
  abortStaleRun,
  appendJournal,
  finishRun,
  loadRun,
  readActiveRunName,
  requireActiveRun,
  runControl,
  startRun,
  updateRunCase,
  updateRunControl,
} from "../../packages/pi-test/core/run.ts";
import {
  getSurfaceReadiness,
  loadProject,
  requireSurfaceReady,
  surfaceNames,
  type Project,
  type SurfaceName,
} from "../../packages/pi-test/core/project.ts";
import type {
  TestActRequest,
  TestActResult,
  TestCaseRequest,
  TestCaseResult,
  TestFindingRequest,
  TestFindingResult,
  TestHostCall,
  TestMapRequest,
  TestMapResult,
  TestIdentityStatus,
  TestObserveRequest,
  TestObserveResult,
  TestPlayRequest,
  TestPlayResult,
  TestProgressCode,
  TestProgressEvent,
  TestRequestContext,
  TestRisk,
  TestRunRequest,
  TestSetupResult,
  TestRunResult,
  TestSessionEndedRequest,
} from "../../packages/pi-test/contract.ts";
import { interpolate, loadSecrets } from "../../packages/pi-test/core/interp.ts";
import { nowIso } from "../../packages/pi-test/core/time.ts";
import { probeSucceeded, type ProbeExecutor } from "./toolchains/process-runner.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_TARGET_LENGTH = 500;
const MAX_VALUE_LENGTH = 10_000;
const HIGH_RISK_TARGET = /(?:支付|退款|删除|发送|权限|审核|pay|refund|delete|send|permission|approve)/i;
const BUSINESS_WRITE_TARGET = /(?:提交|创建|保存|修改|下单|申请|submit|create|save|update|order|apply)/i;
const SENSITIVE_TARGET = /(?:密码|验证码|动态口令|api\s*key|secret|password|otp|token)/i;
const SENSITIVE_VISUAL_PAGE =
  /(?:密码|验证码|动态口令|支付|身份证|银行卡|安全码|cvv|password|one[- ]?time|otp|payment|credit card|identity card)/i;
const AGENT_BROWSER_CLI_VERSION = "0.3.7";
const PROGRESS_MESSAGES: Record<TestProgressCode, string> = {
  opening_page: "正在打开页面",
  reading_page: "正在读取页面",
  clicking: "正在点击",
  filling: "正在填写",
  waiting: "正在等待页面",
  capturing_evidence: "正在保存证据",
  waiting_for_user: "等待你完成操作",
  checking_result: "正在检查结果",
};

export interface BrowserDriverBinding {
  tabId?: string;
  profileId: string;
}

export interface TestMobileDriver {
  connect(deviceSerial: string): Promise<void>;
  foreground(deviceSerial: string): Promise<{ packageName: string; activity: string | null }>;
  observe(input: {
    serial: string;
    mode: "text" | "snapshot";
    limit: number;
  }): Promise<{ text: string; truncated: boolean }>;
  open(input: { serial: string; packageName: string; activity?: string | null }): Promise<void>;
  click(input: { serial: string; target: string }): Promise<void>;
  fill(input: { serial: string; target: string; value: string }): Promise<void>;
  swipe(input: { serial: string; direction: "up" | "down" | "left" | "right"; distance?: number }): Promise<void>;
  screenshot(input: { serial: string; out: string }): Promise<void>;
}

export interface TestBrowserDriver {
  observe(
    input: BrowserDriverBinding & { mode: "text" | "snapshot"; limit: number },
  ): Promise<{ text: string; truncated: boolean }>;
  open(input: { url: string; profileId: string; viewport?: string; mobile?: boolean }): Promise<{ tabId?: string }>;
  click(input: BrowserDriverBinding & { target: string }): Promise<void>;
  fill(input: BrowserDriverBinding & { target: string; value: string }): Promise<void>;
  currentUrl(input: BrowserDriverBinding): Promise<string>;
  screenshot(input: BrowserDriverBinding & { out: string }): Promise<void>;
}

export interface TestCoordinatorOptions {
  browser: TestBrowserDriver;
  mobile?: TestMobileDriver;
  assertLicensed: (context: TestRequestContext) => Promise<void> | void;
  assertBrowserReady?: () => Promise<void> | void;
  resolveBrowserBinding: (
    projectId: string,
    projectRoot: string,
    surface: "h5" | "admin",
  ) => BrowserDriverBinding | null;
  saveBrowserBinding?: (
    projectId: string,
    projectRoot: string,
    surface: "h5" | "admin",
    binding: BrowserDriverBinding,
  ) => void;
  isConfirmed: (input: TestRequestContext & { confirmationId: string; risk: Exclude<TestRisk, "read"> }) => boolean;
  confirmRisk?: (
    input: TestRequestContext & {
      projectName: string;
      surface: "h5" | "admin" | "app";
      risk: Exclude<TestRisk, "read">;
      scope: "run" | "action";
      action: TestActRequest["action"];
    },
  ) => Promise<boolean>;
  identityStatus?: (project: Project) => TestIdentityStatus[];
  setupReadiness?: (
    root: string,
    project: Project,
  ) => Promise<TestSetupResult["surfaces"]> | TestSetupResult["surfaces"];
  validateEvidence?: (root: string, evidence: string) => void;
  onProgress?: (event: TestProgressEvent) => void;
}

type Lease = { projectId: string; projectRoot: string; sessionId: string; runId: string };
type PendingControl = {
  root: string;
  project: Project;
  surface: "h5" | "admin" | "app";
  target: "paused" | "waiting_for_user";
  sensitive: boolean;
  resolve: (result: TestRunResult) => void;
  reject: (error: unknown) => void;
};

export class TestCoordinatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TestCoordinatorError";
  }
}

export function resolveTestBrowserCliPath(options: {
  platform: NodeJS.Platform;
  arch: string;
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): string {
  const pathApi = options.platform === "win32" ? path.win32 : path;
  const override = options.isPackaged ? undefined : options.env.PI_TEST_AGENT_BROWSER_CLI;
  if (override) {
    if (!pathApi.isAbsolute(override)) throw new Error("PI_TEST_AGENT_BROWSER_CLI must be an absolute path");
    return override;
  }

  let root = options.userDataDir;
  if (options.platform === "win32") {
    const localAppData = options.env.LOCALAPPDATA;
    if (!localAppData || !path.win32.isAbsolute(localAppData)) {
      throw new Error("LOCALAPPDATA must be an absolute path");
    }
    root = path.win32.join(localAppData, "PiTestDesktop");
  }
  return pathApi.join(
    root,
    "toolchains",
    "agent-browser-cli",
    AGENT_BROWSER_CLI_VERSION,
    `${options.platform}-${options.arch}`,
    options.platform === "win32" ? "agent-browser-cli.exe" : "agent-browser-cli",
  );
}

function assertPlainId(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", `${label} 无效`);
  }
  return value;
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TestCoordinatorError("BAD_REQUEST", "测试请求必须是对象");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TestCoordinatorError("BAD_REQUEST", `测试请求未知字段: ${unknown.join(", ")}`);
}

function validateRequestContext(value: Record<string, unknown>): void {
  if (typeof value.projectRoot !== "string" || typeof value.sessionId !== "string") {
    throw new TestCoordinatorError("BAD_REQUEST", "projectRoot 和 sessionId 必填");
  }
  assertPlainId(value.sessionId, "sessionId");
  if (value.projectId !== undefined) {
    if (typeof value.projectId !== "string") throw new TestCoordinatorError("BAD_REQUEST", "projectId 无效");
    assertPlainId(value.projectId, "projectId");
  }
}

function validateRunRequest(raw: unknown): TestRunRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  if (value.action === "status") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action"]);
  } else if (value.action === "start") {
    rejectUnknown(value, [
      "projectRoot",
      "projectId",
      "sessionId",
      "action",
      "title",
      "slug",
      "trigger",
      "caseIds",
      "note",
      "surface",
      "risk",
      "businessWriteSurfaces",
    ]);
    if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120) {
      throw new TestCoordinatorError("BAD_REQUEST", "title 无效");
    }
    if (typeof value.slug !== "string") throw new TestCoordinatorError("BAD_REQUEST", "slug 无效");
    if (value.trigger !== undefined && !["manual", "regression", "explore"].includes(String(value.trigger))) {
      throw new TestCoordinatorError("BAD_REQUEST", "trigger 无效");
    }
    if (
      value.caseIds !== undefined &&
      (!Array.isArray(value.caseIds) ||
        value.caseIds.length > 1_000 ||
        value.caseIds.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(id)))
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "caseIds 无效");
    }
    if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 2_000)) {
      throw new TestCoordinatorError("BAD_REQUEST", "note 无效");
    }
    if (value.surface !== undefined && !isSurfaceName(value.surface)) {
      throw new TestCoordinatorError("BAD_REQUEST", "surface 无效");
    }
    if (value.risk !== undefined && value.risk !== "read" && value.risk !== "business_write") {
      throw new TestCoordinatorError("BAD_REQUEST", "run risk 无效");
    }
    if (
      value.businessWriteSurfaces !== undefined &&
      (!Array.isArray(value.businessWriteSurfaces) ||
        value.businessWriteSurfaces.length > 4 ||
        value.businessWriteSurfaces.some((surface) => !isSurfaceName(surface)))
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "businessWriteSurfaces 无效");
    }
    if (value.risk === "business_write" && value.surface === undefined && value.businessWriteSurfaces === undefined) {
      throw new TestCoordinatorError("BAD_REQUEST", "业务写入执行必须声明 surface");
    }
  } else if (value.action === "pause") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action", "surface", "sensitive"]);
    if (!isSurfaceName(value.surface)) throw new TestCoordinatorError("BAD_REQUEST", "surface 无效");
    if (value.sensitive !== undefined && typeof value.sensitive !== "boolean") {
      throw new TestCoordinatorError("BAD_REQUEST", "sensitive 必须是布尔");
    }
  } else if (value.action === "takeover") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action", "surface", "reason", "sensitive"]);
    if (!isSurfaceName(value.surface)) throw new TestCoordinatorError("BAD_REQUEST", "surface 无效");
    if (!["login", "verification", "scan", "authorization", "judgment"].includes(String(value.reason))) {
      throw new TestCoordinatorError("BAD_REQUEST", "人工接管原因无效");
    }
    if (value.sensitive !== undefined && typeof value.sensitive !== "boolean") {
      throw new TestCoordinatorError("BAD_REQUEST", "sensitive 必须是布尔");
    }
  } else if (value.action === "resume") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action"]);
  } else if (value.action === "finish") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action", "status", "summaryText"]);
    if (value.status !== undefined && !["passed", "failed", "blocked", "aborted"].includes(String(value.status))) {
      throw new TestCoordinatorError("BAD_REQUEST", "status 无效");
    }
    if (
      value.summaryText !== undefined &&
      (typeof value.summaryText !== "string" || value.summaryText.length > 2_000)
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "summaryText 无效");
    }
  } else {
    throw new TestCoordinatorError("BAD_REQUEST", "test.run action 无效");
  }
  return value as unknown as TestRunRequest;
}

function validateDomainContext(raw: unknown): TestRequestContext {
  const value = requestRecord(raw);
  validateRequestContext(value);
  rejectUnknown(value, ["projectRoot", "projectId", "sessionId"]);
  return value as unknown as TestRequestContext;
}

const MAP_SECTIONS = ["modules", "flows", "roles", "open_questions"] as const;
const CASE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function validateMapRequest(raw: unknown): TestMapRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  if (value.action === "read") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action", "section"]);
    if (value.section !== undefined && !MAP_SECTIONS.includes(value.section as (typeof MAP_SECTIONS)[number])) {
      throw new TestCoordinatorError("BAD_REQUEST", "业务地图章节无效");
    }
  } else if (value.action === "update") {
    rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action", "section", "content"]);
    if (!MAP_SECTIONS.includes(value.section as (typeof MAP_SECTIONS)[number])) {
      throw new TestCoordinatorError("BAD_REQUEST", "业务地图章节无效");
    }
    if (typeof value.content !== "string" || value.content.length > 20_000 || /\0/.test(value.content)) {
      throw new TestCoordinatorError("BAD_REQUEST", "业务地图内容无效");
    }
  } else {
    throw new TestCoordinatorError("BAD_REQUEST", "test.map action 无效");
  }
  return value as unknown as TestMapRequest;
}

function validateCaseRequest(raw: unknown): TestCaseRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  const context = ["projectRoot", "projectId", "sessionId", "action"];
  if (value.action === "list") {
    rejectUnknown(value, context);
  } else if (value.action === "get" || value.action === "set_status") {
    rejectUnknown(value, [...context, "id", ...(value.action === "set_status" ? ["status"] : [])]);
    if (typeof value.id !== "string" || !CASE_ID_RE.test(value.id)) {
      throw new TestCoordinatorError("BAD_REQUEST", "case id 无效");
    }
    if (value.action === "set_status" && !["draft", "stable", "disabled"].includes(String(value.status))) {
      throw new TestCoordinatorError("BAD_REQUEST", "case status 无效");
    }
  } else if (value.action === "create" || value.action === "update") {
    rejectUnknown(value, [
      ...context,
      "id",
      "title",
      "description",
      "surface",
      "tags",
      "risk",
      "pre",
      "steps",
      "assert",
    ]);
    if (typeof value.id !== "string" || !CASE_ID_RE.test(value.id)) {
      throw new TestCoordinatorError("BAD_REQUEST", "case id 无效");
    }
    if (value.action === "create" && (!Array.isArray(value.steps) || value.steps.length < 1)) {
      throw new TestCoordinatorError("BAD_REQUEST", "case steps 至少 1 步");
    }
  } else {
    throw new TestCoordinatorError("BAD_REQUEST", "test.case action 无效");
  }
  return value as unknown as TestCaseRequest;
}

function validateFindingRequest(raw: unknown): TestFindingRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  const context = ["projectRoot", "projectId", "sessionId", "action"];
  if (value.action === "list") {
    rejectUnknown(value, context);
  } else if (value.action === "get") {
    rejectUnknown(value, [...context, "id"]);
  } else if (value.action === "create") {
    rejectUnknown(value, [
      ...context,
      "id",
      "title",
      "summary",
      "stepsToReproduce",
      "expected",
      "actual",
      "evidence",
      "surface",
      "severity",
      "confidence",
      "caseId",
    ]);
    for (const [key, max] of [
      ["title", 120],
      ["summary", 5_000],
      ["expected", 5_000],
      ["actual", 5_000],
    ] as const) {
      const text = value[key];
      if (typeof text !== "string" || !text.trim() || text.length > max || /\0/.test(text)) {
        throw new TestCoordinatorError("BAD_REQUEST", `${key} 无效`);
      }
    }
    if (
      !Array.isArray(value.stepsToReproduce) ||
      value.stepsToReproduce.length < 1 ||
      value.stepsToReproduce.length > 50 ||
      value.stepsToReproduce.some((step) => typeof step !== "string" || !step.trim() || step.length > 1_000)
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "stepsToReproduce 无效");
    }
    if (
      !Array.isArray(value.evidence) ||
      value.evidence.length < 1 ||
      value.evidence.length > 20 ||
      value.evidence.some((evidence) => typeof evidence !== "string")
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "evidence 无效");
    }
    if (!isSurfaceName(value.surface)) throw new TestCoordinatorError("BAD_REQUEST", "finding surface 无效");
    if (value.severity !== undefined && !["p0", "p1", "p2", "p3"].includes(String(value.severity))) {
      throw new TestCoordinatorError("BAD_REQUEST", "finding severity 无效");
    }
    if (value.confidence !== undefined && !["suspected", "observed", "confirmed"].includes(String(value.confidence))) {
      throw new TestCoordinatorError("BAD_REQUEST", "finding confidence 无效");
    }
  } else if (value.action === "set_status") {
    rejectUnknown(value, [...context, "id", "status", "duplicateOf", "confidence"]);
    if (!["open", "confirmed", "fixed", "wontfix", "duplicate"].includes(String(value.status))) {
      throw new TestCoordinatorError("BAD_REQUEST", "finding status 无效");
    }
  } else if (value.action === "retest") {
    rejectUnknown(value, [...context, "id", "result", "note", "evidence"]);
    if (!["still_fail", "passed", "blocked"].includes(String(value.result))) {
      throw new TestCoordinatorError("BAD_REQUEST", "retest result 无效");
    }
    if (
      value.note !== undefined &&
      (typeof value.note !== "string" || value.note.length > 2_000 || /\0/.test(value.note))
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "retest note 无效");
    }
    if (
      value.evidence !== undefined &&
      (!Array.isArray(value.evidence) ||
        value.evidence.length > 20 ||
        value.evidence.some((evidence) => typeof evidence !== "string"))
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "retest evidence 无效");
    }
  } else {
    throw new TestCoordinatorError("BAD_REQUEST", "test.finding action 无效");
  }
  if (value.action !== "list") {
    if (typeof value.id !== "string" || !CASE_ID_RE.test(value.id)) {
      throw new TestCoordinatorError("BAD_REQUEST", "finding id 无效");
    }
  }
  return value as unknown as TestFindingRequest;
}

function validatePlayRequest(raw: unknown): TestPlayRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "action", "caseIds", "title", "slug", "trigger"]);
  if (value.action !== "run") throw new TestCoordinatorError("BAD_REQUEST", "test.play action 无效");
  if (
    !Array.isArray(value.caseIds) ||
    value.caseIds.length < 1 ||
    value.caseIds.length > 100 ||
    value.caseIds.some((id) => typeof id !== "string" || !CASE_ID_RE.test(id))
  ) {
    throw new TestCoordinatorError("BAD_REQUEST", "caseIds 无效");
  }
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120) {
    throw new TestCoordinatorError("BAD_REQUEST", "title 无效");
  }
  if (typeof value.slug !== "string") throw new TestCoordinatorError("BAD_REQUEST", "slug 无效");
  if (value.trigger !== undefined && !["manual", "regression"].includes(String(value.trigger))) {
    throw new TestCoordinatorError("BAD_REQUEST", "play trigger 无效");
  }
  return value as unknown as TestPlayRequest;
}

function validateObserveRequest(raw: unknown): TestObserveRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "surface", "mode", "limit"]);
  if (!["h5", "admin", "app", "miniprogram"].includes(String(value.surface))) {
    throw new TestCoordinatorError("BAD_REQUEST", "surface 无效");
  }
  if (value.mode !== "text" && value.mode !== "snapshot" && value.mode !== "visual") {
    throw new TestCoordinatorError("BAD_REQUEST", "test.observe mode 无效");
  }
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 500)
  ) {
    throw new TestCoordinatorError("BAD_REQUEST", "limit 必须是 1 到 500 的整数");
  }
  return value as unknown as TestObserveRequest;
}

function validateSessionEndedRequest(raw: unknown): TestSessionEndedRequest {
  const value = requestRecord(raw);
  rejectUnknown(value, ["sessionId"]);
  if (typeof value.sessionId !== "string") throw new TestCoordinatorError("BAD_REQUEST", "sessionId 必填");
  assertPlainId(value.sessionId, "sessionId");
  return value as unknown as TestSessionEndedRequest;
}

function validateActRequest(raw: unknown): TestActRequest {
  const value = requestRecord(raw);
  validateRequestContext(value);
  rejectUnknown(value, ["projectRoot", "projectId", "sessionId", "surface", "risk", "confirmationId", "action"]);
  if (!["h5", "admin", "app", "miniprogram"].includes(String(value.surface))) {
    throw new TestCoordinatorError("BAD_REQUEST", "surface 无效");
  }
  if (!["read", "business_write", "high"].includes(String(value.risk))) {
    throw new TestCoordinatorError("BAD_REQUEST", "test.act risk 无效");
  }
  if (value.confirmationId !== undefined) {
    if (typeof value.confirmationId !== "string") throw new TestCoordinatorError("BAD_REQUEST", "confirmationId 无效");
    assertPlainId(value.confirmationId, "confirmationId");
  }
  const action = requestRecord(value.action);
  if (action.type === "open") {
    rejectUnknown(action, ["type"]);
  } else if (action.type === "click") {
    rejectUnknown(action, ["type", "target"]);
    if (typeof action.target !== "string") throw new TestCoordinatorError("BAD_REQUEST", "target 无效");
  } else if (action.type === "fill") {
    rejectUnknown(action, ["type", "target", "value", "sensitive"]);
    if (typeof action.target !== "string" || typeof action.value !== "string" || /\0/.test(action.value)) {
      throw new TestCoordinatorError("BAD_REQUEST", "fill 参数无效");
    }
    if (action.sensitive !== undefined && typeof action.sensitive !== "boolean") {
      throw new TestCoordinatorError("BAD_REQUEST", "sensitive 必须是布尔");
    }
  } else if (action.type === "wait") {
    rejectUnknown(action, ["type", "durationMs"]);
    if (!Number.isInteger(action.durationMs)) throw new TestCoordinatorError("BAD_REQUEST", "durationMs 必须是整数");
  } else if (action.type === "swipe") {
    rejectUnknown(action, ["type", "direction", "distance"]);
    if (!["up", "down", "left", "right"].includes(String(action.direction))) {
      throw new TestCoordinatorError("BAD_REQUEST", "swipe direction 无效");
    }
    if (
      action.distance !== undefined &&
      (!Number.isInteger(action.distance) || (action.distance as number) < 50 || (action.distance as number) > 2_000)
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "swipe distance 无效");
    }
  } else if (action.type === "shot") {
    rejectUnknown(action, ["type"]);
  } else {
    throw new TestCoordinatorError("BAD_REQUEST", "test.act action 无效");
  }
  return value as unknown as TestActRequest;
}

function validateContext(context: TestRequestContext): string {
  if (
    !path.isAbsolute(context.projectRoot) ||
    context.projectRoot.length > 4_096 ||
    /[\0\r\n]/.test(context.projectRoot)
  ) {
    throw new TestCoordinatorError("BAD_REQUEST", "projectRoot 必须是绝对路径");
  }
  return path.normalize(context.projectRoot);
}

function riskRank(risk: TestRisk): number {
  return risk === "read" ? 0 : risk === "business_write" ? 1 : 2;
}

function inferredRisk(request: TestActRequest): TestRisk {
  if (
    request.action.type === "open" ||
    request.action.type === "wait" ||
    request.action.type === "swipe" ||
    request.action.type === "shot"
  )
    return "read";
  if (HIGH_RISK_TARGET.test(request.action.target)) return "high";
  if (BUSINESS_WRITE_TARGET.test(request.action.target)) return "business_write";
  return request.risk;
}

function isSurfaceName(value: unknown): value is SurfaceName {
  return typeof value === "string" && ["h5", "admin", "app", "miniprogram"].includes(value);
}

function isWebSurface(surface: SurfaceName): surface is "h5" | "admin" {
  return surface === "h5" || surface === "admin";
}

type SupportedSurface = "h5" | "admin" | "app";

function assertSupportedSurface(surface: SurfaceName): asserts surface is SupportedSurface {
  if (surface === "miniprogram") {
    throw new TestCoordinatorError("NOT_IMPLEMENTED", "miniprogram 驱动待后续小程序技术切片实现");
  }
}

export class MainTestCoordinator {
  private readonly options: TestCoordinatorOptions;
  private lease: Lease | null = null;
  private activeAtomicOperations = 0;
  private authorizationLossPending = false;
  private pendingControl: PendingControl | null = null;
  private completingControl = false;
  private startingRun = false;
  private playing = false;
  private playbackSurface: SupportedSurface | null = null;

  constructor(options: TestCoordinatorOptions) {
    this.options = options;
  }

  readonly call: TestHostCall = async (method, params) => {
    if (method === "test.authorizeSession") {
      const value = requestRecord(params);
      rejectUnknown(value, ["projectRoot"]);
      if (typeof value.projectRoot !== "string") throw new TestCoordinatorError("BAD_REQUEST", "projectRoot 必填");
      const root = validateContext({ projectRoot: value.projectRoot, sessionId: "session-authorize" });
      await this.options.assertLicensed({ projectRoot: root, sessionId: "session-authorize" });
      return { projectId: loadProject(root).id } as never;
    }
    if (method === "test.setup") return (await this.setup(validateDomainContext(params))) as never;
    if (method === "test.run") return (await this.run(validateRunRequest(params))) as never;
    if (method === "test.map") return (await this.map(validateMapRequest(params))) as never;
    if (method === "test.case") return (await this.case(validateCaseRequest(params))) as never;
    if (method === "test.finding") return (await this.finding(validateFindingRequest(params))) as never;
    if (method === "test.play") return (await this.play(validatePlayRequest(params))) as never;
    if (method === "test.observe") return (await this.observe(validateObserveRequest(params))) as never;
    if (method === "test.act") return (await this.act(validateActRequest(params))) as never;
    if (method === "test.sessionEnded") return this.sessionEnded(validateSessionEndedRequest(params)) as never;
    throw new TestCoordinatorError("METHOD_NOT_FOUND", `不支持的测试方法: ${String(method)}`);
  };

  async setup(request: TestRequestContext): Promise<TestSetupResult> {
    const { root, project } = await this.prepare(request);
    const surfaces = this.options.setupReadiness
      ? await this.options.setupReadiness(root, project)
      : surfaceNames(project).map((surface) => {
          const readiness = getSurfaceReadiness(project, surface);
          return { ...readiness, status: readiness.ready ? ("ok" as const) : ("manual" as const) };
        });
    return {
      project: { id: project.id, name: project.name, environment: project.environment },
      activeRun: readActiveRunName(root),
      surfaces,
      identities: this.options.identityStatus?.(project) ?? [],
    };
  }

  async map(request: TestMapRequest): Promise<TestMapResult> {
    const { root } = request.action === "read" ? await this.prepare(request) : await this.assertActiveLease(request);
    if (request.action === "update") this.assertRunOperational(root);
    const sections =
      request.action === "update" ? updateMapSection(root, request.section, request.content) : readMap(root);
    return {
      sections: request.section ? { [request.section]: sections[request.section] } : sections,
    };
  }

  async case(request: TestCaseRequest): Promise<TestCaseResult> {
    const prepared =
      request.action === "list" || request.action === "get"
        ? await this.prepare(request)
        : await this.assertActiveLease(request);
    const { root, project } = prepared;
    if (request.action === "list") return { cases: listCases(root) };
    if (request.action === "get") return { case: loadCase(root, request.id, project) };
    this.assertRunOperational(root);
    if (request.action === "set_status") {
      return { case: setCaseStatus(root, request.id, request.status, project) };
    }
    if (request.action === "create") {
      const timestamp = nowIso();
      const created: TestCase = {
        schemaVersion: 1,
        id: request.id,
        title: request.title,
        description: request.description ?? null,
        surface: request.surface,
        status: "draft",
        tags: request.tags ?? [],
        risk: request.risk ?? "normal",
        createdAt: timestamp,
        updatedAt: timestamp,
        pre: request.pre,
        steps: request.steps,
        assert: request.assert,
      };
      return { case: createCase(root, created, project) };
    }
    const current = loadCase(root, request.id, project);
    const updated: TestCase = {
      ...current,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.surface === undefined ? {} : { surface: request.surface }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      ...(request.risk === undefined ? {} : { risk: request.risk }),
      ...(request.pre === undefined ? {} : { pre: request.pre }),
      ...(request.steps === undefined ? {} : { steps: request.steps }),
      ...(request.assert === undefined ? {} : { assert: request.assert }),
      updatedAt: nowIso(),
    };
    return { case: updateCase(root, updated, project) };
  }

  async finding(request: TestFindingRequest): Promise<TestFindingResult> {
    const prepared =
      request.action === "list" || request.action === "get"
        ? await this.prepare(request)
        : await this.assertActiveLease(request);
    const { root, project } = prepared;
    if (request.action === "list") return { findings: listFindings(root) };
    if (request.action === "get") return { finding: loadFinding(root, request.id, project) };
    this.assertRunOperational(root);
    if (request.action === "create") {
      for (const evidence of request.evidence) this.validateEvidence(root, evidence);
      if (request.caseId) loadCase(root, request.caseId, project);
      return {
        finding: createFinding(root, project, {
          id: request.id,
          title: request.title,
          summary: request.summary,
          stepsToReproduce: request.stepsToReproduce,
          expected: request.expected,
          actual: request.actual,
          evidence: request.evidence,
          surface: request.surface,
          severity: request.severity,
          confidence: request.confidence,
          caseId: request.caseId,
        }),
      };
    }
    if (request.action === "retest") {
      for (const evidence of request.evidence ?? []) this.validateEvidence(root, evidence);
      return {
        finding: addRetest(root, project, request.id, {
          result: request.result,
          note: request.note,
          evidence: request.evidence,
        }),
      };
    }
    return {
      finding: setFindingStatus(root, project, request.id, request.status, {
        duplicateOf: request.duplicateOf,
        confidence: request.confidence,
      }),
    };
  }

  private validateEvidence(root: string, evidence: string): void {
    if (!this.options.validateEvidence) {
      throw new TestCoordinatorError("EVIDENCE_VALIDATION_UNAVAILABLE", "证据校验不可用");
    }
    this.options.validateEvidence(root, evidence);
  }

  async play(request: TestPlayRequest): Promise<TestPlayResult> {
    if (this.playing) throw new TestCoordinatorError("TEST_BUSY", "已有确定性用例正在重放");
    const prepared = await this.prepare(request);
    if (this.lease || readActiveRunName(prepared.root)) {
      throw new TestCoordinatorError("TEST_BUSY", "已有测试正在执行");
    }
    if (new Set(request.caseIds).size !== request.caseIds.length) {
      throw new TestCoordinatorError("BAD_REQUEST", "caseIds 不能重复");
    }
    const cases = request.caseIds.map((id) => loadCase(prepared.root, id, prepared.project));
    for (const testCase of cases) {
      if (testCase.status === "disabled")
        throw new TestCoordinatorError("CASE_DISABLED", `case 已停用: ${testCase.id}`);
      if ((request.trigger ?? "manual") === "regression" && testCase.status !== "stable") {
        throw new TestCoordinatorError("CASE_NOT_STABLE", `回归只允许 stable case: ${testCase.id}`);
      }
    }
    const surfaceNamesToCheck = [...new Set(cases.flatMap(caseSurfaces))];
    for (const surface of surfaceNamesToCheck) {
      assertSupportedSurface(surface);
      requireSurfaceReady(prepared.project, surface);
    }
    if (this.options.setupReadiness) {
      const readiness = await this.options.setupReadiness(prepared.root, prepared.project);
      for (const surface of surfaceNamesToCheck) {
        const state = readiness.find((item) => item.surface === surface);
        if (!state?.ready) {
          throw new TestCoordinatorError("SURFACE_NOT_READY", state?.nextStep ?? `${surface} 测试端未就绪`);
        }
      }
    }
    const businessWriteSurfaces = [...new Set(cases.flatMap(caseBusinessWriteSurfaces))] as SupportedSurface[];
    if (prepared.project.environment === "production" && cases.some(caseHasProductionUnsafeAction)) {
      throw new TestCoordinatorError("PRODUCTION_READ_ONLY", "生产环境不能重放含点击、填写或高风险动作的用例");
    }
    const started = await this.run({
      ...request,
      action: "start",
      trigger: request.trigger ?? "manual",
      risk: businessWriteSurfaces.length > 0 ? "business_write" : "read",
      businessWriteSurfaces,
    });
    if (!started.run) throw new TestCoordinatorError("BAD_RUN_STATE", "未创建用例执行记录");

    this.playing = true;
    try {
      for (const testCase of cases) {
        await this.playCase(prepared.root, prepared.project, request, testCase);
      }
      return { run: this.finishPlayback(prepared.root) };
    } catch (error) {
      const active = readActiveRunName(prepared.root);
      if (!active) throw error;
      const doc = loadRun(prepared.root, active);
      const current = doc.cases.find((entry) => entry.status === "running");
      if (current) {
        let evidence: string | null = null;
        const testCase = cases.find((item) => item.id === current.id);
        if (testCase) {
          try {
            const failureSurface = this.playbackSurface ?? testCase.surface;
            assertSupportedSurface(failureSurface);
            evidence = await this.captureEvidence(prepared.root, prepared.project, failureSurface);
          } catch {
            // Preserve the original failure when failure evidence cannot be captured.
          }
        }
        updateRunCase(prepared.root, current.id, {
          status: isEnvironmentError(error) ? "blocked" : "failed",
          finishedAt: nowIso(),
          error: safeErrorMessage(error),
          ...(evidence ? { evidence: [...current.evidence, evidence] } : {}),
        });
      }
      appendJournal(prepared.root, {
        kind: "error",
        summary: safeErrorMessage(error),
        evidence: [],
      });
      return { run: this.finishPlayback(prepared.root) };
    } finally {
      this.playing = false;
      this.playbackSurface = null;
      this.lease = null;
    }
  }

  private async playCase(root: string, project: Project, request: TestPlayRequest, testCase: TestCase): Promise<void> {
    updateRunCase(root, testCase.id, { status: "running", startedAt: nowIso(), error: null });
    const captures: Record<string, string> = {};
    assertSupportedSurface(testCase.surface);
    let currentSurface: SupportedSurface = testCase.surface;
    for (const pre of testCase.pre ?? []) {
      const preSurface = pre.surface ?? testCase.surface;
      assertSupportedSurface(preSurface);
      currentSurface = preSurface;
      this.playbackSurface = currentSurface;
      if (pre.open !== undefined) {
        await this.playbackOperation(root, () =>
          this.openPlaybackSurface(root, project, request, currentSurface, pre.open),
        );
      } else if (pre.launch) {
        await this.playbackOperation(root, () => this.openPlaybackSurface(root, project, request, currentSurface));
      } else if (pre.connect) {
        await this.playbackOperation(root, () => this.ensurePlaybackSurface(project, currentSurface));
      }
    }
    for (const step of testCase.steps) {
      const stepSurface = step.surface ?? testCase.surface;
      assertSupportedSurface(stepSurface);
      currentSurface = stepSurface;
      this.playbackSurface = currentSurface;
      try {
        await this.playbackOperation(root, () =>
          this.playStep(root, project, request, testCase, step, currentSurface, captures),
        );
      } catch (error) {
        if (!step.optional) throw error;
        appendJournal(root, {
          surface: currentSurface,
          kind: "error",
          summary: `可选步骤未完成：${step.act}`,
          evidence: [],
        });
      }
    }
    for (const assertion of testCase.assert ?? []) {
      const assertionSurface = assertion.surface ?? testCase.surface;
      assertSupportedSurface(assertionSurface);
      currentSurface = assertionSurface;
      this.playbackSurface = currentSurface;
      await this.playbackOperation(root, () =>
        this.checkAssertion(root, project, request, currentSurface, assertion, captures),
      );
    }
    const current = requireActiveRun(root).doc.cases.find((entry) => entry.id === testCase.id)!;
    updateRunCase(root, testCase.id, {
      status: "passed",
      finishedAt: nowIso(),
      error: null,
      evidence: current.evidence,
    });
  }

  private async playStep(
    root: string,
    project: Project,
    request: TestPlayRequest,
    testCase: TestCase,
    step: TestCase["steps"][number],
    surface: SupportedSurface,
    captures: Record<string, string>,
  ): Promise<void> {
    if (step.act === "connect") return this.ensurePlaybackSurface(project, surface);
    if (step.act === "open" || step.act === "launch") {
      return this.openPlaybackSurface(root, project, request, surface, step.url);
    }
    if (step.act === "ui") {
      const observation = await this.observe({ ...request, surface, mode: "snapshot" });
      const active = requireActiveRun(root);
      const fileName = `${testCase.id}-${surface}-ui-${Date.now()}.txt`;
      const evidence = path.posix.join("runs", active.dirName, "evidence", fileName);
      writeFileSync(path.join(active.evidenceDir, fileName), observation.text, { encoding: "utf8", mode: 0o600 });
      appendJournal(root, { surface, kind: "observe", summary: "保存界面结构", evidence: [evidence] });
      const current = active.doc.cases.find((entry) => entry.id === testCase.id)!;
      updateRunCase(root, testCase.id, { evidence: [...current.evidence, evidence] });
      return;
    }
    if (step.act === "capture") {
      const observation = await this.observe({ ...request, surface, mode: "text" });
      const pattern = compileCapturePattern(step.pattern!);
      const match = pattern.exec(observation.text);
      if (!match?.[1]) throw new TestCoordinatorError("CAPTURE_NOT_FOUND", `未读取到 ${step.as}`);
      captures[step.as!] = match[1];
      appendJournal(root, { surface, kind: "observe", summary: `已读取 ${step.as}`, evidence: [] });
      return;
    }
    if (step.act === "wait" && step.text) {
      const timeoutMs = parseDuration(step.timeout, 10_000, 30_000);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        await this.waitForPlaybackRunning(root);
        const observation = await this.observe({ ...request, surface, mode: "text" });
        if (observation.text.includes(interpolatePlayback(step.text, project, root, captures))) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new TestCoordinatorError("ASSERTION_FAILED", `等待文案超时: ${step.text}`);
    }
    if (step.act === "wait" && step.package) {
      await this.waitForPackage(
        project,
        surface,
        interpolatePlayback(step.package, project, root, captures),
        step.timeout,
      );
      return;
    }
    const risk = playbackActionRisk(testCase, step.target);
    if (step.act === "tap") {
      await this.act({
        ...request,
        surface,
        risk,
        action: { type: "click", target: interpolatePlayback(step.target!, project, root, captures) },
      });
      return;
    }
    if (step.act === "fill") {
      const value = interpolatePlayback(step.value!, project, root, captures);
      await this.act({
        ...request,
        surface,
        risk,
        action: { type: "fill", target: step.target!, value },
      });
      return;
    }
    if (step.act === "wait") {
      await this.act({
        ...request,
        surface,
        risk: "read",
        action: { type: "wait", durationMs: parseDuration(step.idle, 200, 30_000) },
      });
      return;
    }
    if (step.act === "swipe") {
      await this.act({
        ...request,
        surface,
        risk: "read",
        action: { type: "swipe", direction: step.direction!, distance: step.distance },
      });
      return;
    }
    const evidence = await this.atomicOperation(() =>
      this.captureEvidence(root, project, surface, `${testCase.id}-${step.name}`),
    );
    appendJournal(root, { surface, kind: "observe", summary: "保存页面截图", evidence: [evidence] });
    const current = requireActiveRun(root).doc.cases.find((entry) => entry.id === testCase.id)!;
    updateRunCase(root, testCase.id, { evidence: [...current.evidence, evidence] });
  }

  private async checkAssertion(
    root: string,
    project: Project,
    request: TestPlayRequest,
    surface: SupportedSurface,
    assertion: NonNullable<TestCase["assert"]>[number],
    captures: Record<string, string>,
  ): Promise<void> {
    if (assertion.package) {
      await this.waitForPackage(project, surface, interpolatePlayback(assertion.package, project, root, captures));
      return;
    }
    if (assertion.url_contains) {
      if (!isWebSurface(surface)) throw new TestCoordinatorError("BAD_REQUEST", "url_contains 仅支持 Web 测试端");
      const binding = this.requireBrowserBinding(project.id, root, surface, true);
      const url = await this.options.browser.currentUrl(binding);
      const expected = interpolatePlayback(assertion.url_contains, project, root, captures);
      if (!url.includes(expected)) throw new TestCoordinatorError("ASSERTION_FAILED", `当前地址不包含 ${expected}`);
      return;
    }
    const observed = await this.observe({ ...request, surface, mode: "text" });
    if (assertion.see) {
      const expected = interpolatePlayback(assertion.see, project, root, captures);
      if (!observed.text.includes(expected)) throw new TestCoordinatorError("ASSERTION_FAILED", `未看到 ${expected}`);
    } else if (assertion.not_see) {
      const unexpected = interpolatePlayback(assertion.not_see, project, root, captures);
      if (observed.text.includes(unexpected))
        throw new TestCoordinatorError("ASSERTION_FAILED", `仍然看到 ${unexpected}`);
    }
  }

  private async openPlaybackSurface(
    root: string,
    project: Project,
    request: TestPlayRequest,
    surface: SupportedSurface,
    url?: string,
  ): Promise<void> {
    if (url && isWebSurface(surface)) {
      const configuredSurface = requireSurfaceReady(project, surface);
      const configured = configuredSurface.url;
      const resolved = interpolatePlayback(url, project, root, {});
      if (!configured || new URL(resolved).origin !== new URL(configured).origin) {
        throw new TestCoordinatorError("BAD_REQUEST", "case open URL 必须与项目测试地址同源");
      }
      await this.atomicOperation(async () => {
        this.assertRunOperational(root);
        await this.options.assertBrowserReady?.();
        const binding = this.requireBrowserBinding(project.id, root, surface, false);
        const opened = await this.options.browser.open({
          url: resolved,
          profileId: binding.profileId,
          viewport: configuredSurface.viewport,
          mobile: surface === "h5",
        });
        if (opened.tabId)
          this.options.saveBrowserBinding?.(project.id, root, surface, { ...binding, tabId: opened.tabId });
        appendJournal(root, { surface, kind: "step", summary: `打开 ${resolved}`, evidence: [] });
      });
      return;
    }
    await this.act({ ...request, surface, risk: "read", action: { type: "open" } });
  }

  private async ensurePlaybackSurface(project: Project, surface: SupportedSurface): Promise<void> {
    const configured = requireSurfaceReady(project, surface);
    if (isWebSurface(surface)) {
      await this.options.assertBrowserReady?.();
      this.requireBrowserBinding(project.id, this.lease!.projectRoot, surface, false);
      return;
    }
    const app = configured as NonNullable<Project["surfaces"]["app"]>;
    const mobile = this.requireMobileDriver();
    const serial = this.requireMobileSerial(app.serial);
    await this.atomicOperation(async () => {
      await mobile.connect(serial);
      await this.assertMobileForeground(mobile, serial, app.package);
    });
  }

  private async waitForPackage(
    project: Project,
    surface: SupportedSurface,
    expected: string,
    timeout?: string,
  ): Promise<void> {
    if (surface !== "app") throw new TestCoordinatorError("BAD_REQUEST", "package 检查仅支持 App");
    const configured = requireSurfaceReady(project, surface);
    const mobile = this.requireMobileDriver();
    const serial = this.requireMobileSerial(configured.serial);
    const deadline = Date.now() + parseDuration(timeout, 10_000, 30_000);
    while (Date.now() <= deadline) {
      await this.waitForPlaybackRunning(this.lease!.projectRoot);
      const foreground = await this.atomicOperation(() => mobile.foreground(serial));
      if (foreground.packageName === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new TestCoordinatorError("ASSERTION_FAILED", `前台 App 不是 ${expected}`);
  }

  private async playbackOperation(root: string, operation: () => Promise<void>): Promise<void> {
    await this.waitForPlaybackRunning(root);
    await operation();
  }

  private async waitForPlaybackRunning(root: string): Promise<void> {
    while (true) {
      if (!this.lease || this.lease.projectRoot !== root) {
        throw new TestCoordinatorError("TEST_LEASE_REQUIRED", "测试执行租约已释放");
      }
      const state = runControl(requireActiveRun(root).doc).state;
      if (state === "running") return;
      await new Promise((resolve) =>
        setTimeout(resolve, state === "paused" || state === "waiting_for_user" ? 100 : 50),
      );
    }
  }

  private finishPlayback(root: string) {
    const active = requireActiveRun(root).doc;
    for (const entry of active.cases) {
      if (entry.status === "pending") {
        updateRunCase(root, entry.id, { status: "skipped", finishedAt: nowIso(), error: "前序用例未完成" });
      }
    }
    return finishRun(root).doc;
  }

  async run(request: TestRunRequest): Promise<TestRunResult> {
    const { root, project } = await this.prepare(request, request.action !== "status");
    if (request.action === "status") {
      const activeRun = readActiveRunName(root);
      return {
        activeRun,
        ...(activeRun ? { run: loadRun(root, activeRun) } : {}),
        identities: this.options.identityStatus?.(project) ?? [],
      };
    }
    if (request.action === "start") {
      if (this.lease || this.startingRun) {
        throw new TestCoordinatorError("TEST_BUSY", "已有测试正在改变 Chrome 或手机状态");
      }
      this.startingRun = true;
      try {
        if (readActiveRunName(root)) abortStaleRun(root);
        for (const caseId of request.caseIds ?? []) {
          const testCase = loadCase(root, caseId, project);
          if (request.trigger === "regression" && testCase.status !== "stable") {
            throw new TestCoordinatorError("CASE_NOT_STABLE", `回归只允许 stable case: ${caseId}`);
          }
          if (testCase.status === "disabled") {
            throw new TestCoordinatorError("CASE_DISABLED", `case 已停用: ${caseId}`);
          }
        }
        const requestedWriteSurfaces = [
          ...new Set(request.businessWriteSurfaces ?? (request.surface ? [request.surface] : [])),
        ];
        for (const surface of requestedWriteSurfaces) {
          assertSupportedSurface(surface);
          requireSurfaceReady(project, surface);
        }
        const writeSurfaces = requestedWriteSurfaces as SupportedSurface[];
        if (request.surface) {
          assertSupportedSurface(request.surface);
          requireSurfaceReady(project, request.surface);
        }
        if (project.environment === "production" && request.risk === "business_write") {
          throw new TestCoordinatorError("PRODUCTION_READ_ONLY", "生产环境不能开始业务写入测试");
        }
        if (request.risk === "business_write") {
          for (const surface of writeSurfaces) {
            const confirmed = await this.options.confirmRisk?.({
              projectRoot: root,
              projectId: project.id,
              sessionId: request.sessionId,
              projectName: project.name,
              surface,
              risk: "business_write",
              scope: "run",
              action: { type: "click", target: "本次执行的业务写入范围" },
            });
            if (!confirmed) throw new TestCoordinatorError("CONFIRMATION_REQUIRED", "本次业务写入范围需要用户确认");
          }
        }
        await this.options.assertLicensed({ ...request, projectRoot: root });
        const result = startRun(root, project, {
          ...request,
          businessWriteConfirmedSurfaces: request.risk === "business_write" ? writeSurfaces : [],
        });
        if (request.risk === "business_write") {
          for (const surface of writeSurfaces) {
            appendJournal(root, {
              surface,
              kind: "confirm",
              summary: `已确认 ${surface} 本次执行的业务写入范围`,
              evidence: [],
            });
          }
        }
        this.lease = { projectId: project.id, projectRoot: root, sessionId: request.sessionId, runId: result.doc.id };
        return {
          activeRun: result.dirName,
          run: loadRun(root, result.dirName),
          identities: this.options.identityStatus?.(project) ?? [],
        };
      } finally {
        this.startingRun = false;
      }
    }

    this.assertLease(project, root, request.sessionId);
    if (request.action === "pause" || request.action === "takeover") {
      assertSupportedSurface(request.surface);
      requireSurfaceReady(project, request.surface);
      const control = runControl(requireActiveRun(root).doc);
      if (control.state !== "running") {
        throw new TestCoordinatorError("RUN_NOT_RUNNING", `当前执行状态为 ${control.state}`);
      }
      const target = request.action === "pause" ? "paused" : "waiting_for_user";
      updateRunControl(root, {
        state: request.action === "pause" ? "pause_requested" : "takeover_requested",
        surface: request.surface,
        takeoverReason: request.action === "takeover" ? request.reason : null,
        sensitive: request.action === "takeover" && request.reason !== "judgment" ? true : (request.sensitive ?? false),
      });
      appendJournal(root, {
        surface: request.surface,
        kind: "ask",
        summary: request.action === "pause" ? "请求在当前步骤后暂停" : "等待用户完成现场操作",
        evidence: [],
      });
      return new Promise<TestRunResult>((resolve, reject) => {
        if (this.pendingControl) {
          reject(new TestCoordinatorError("TEST_BUSY", "已有状态转换正在进行"));
          return;
        }
        this.pendingControl = {
          root,
          project,
          surface: request.surface as "h5" | "admin" | "app",
          target,
          sensitive:
            request.action === "takeover" && request.reason !== "judgment" ? true : (request.sensitive ?? false),
          resolve,
          reject,
        };
        if (this.activeAtomicOperations === 0) void this.completePendingControl();
      });
    }
    if (request.action === "resume") return this.atomicOperation(() => this.resumeRun(root, project));

    if (this.playing || this.activeAtomicOperations > 0 || this.pendingControl || this.completingControl) {
      throw new TestCoordinatorError("TEST_BUSY", "当前用例重放、原子步骤或状态转换完成后才能结束测试");
    }
    try {
      const result = finishRun(root, { status: request.status, text: request.summaryText });
      return { activeRun: null, run: result.doc };
    } finally {
      this.pendingControl = null;
      this.lease = null;
    }
  }

  sessionEnded(request: TestSessionEndedRequest): { released: boolean } {
    if (!this.lease || this.lease.sessionId !== request.sessionId) return { released: false };
    this.abortLease();
    return { released: true };
  }

  hostStopped(): void {
    this.authorizationLost();
  }

  authorizationLost(): void {
    if (!this.lease) {
      this.authorizationLossPending = false;
      return;
    }
    if (this.activeAtomicOperations > 0) {
      this.authorizationLossPending = true;
      return;
    }
    this.authorizationLossPending = false;
    this.abortLeaseIfPresent();
  }

  async observe(request: TestObserveRequest): Promise<TestObserveResult> {
    return this.atomicOperation(() => this.observeAuthorized(request));
  }

  private async observeAuthorized(request: TestObserveRequest): Promise<TestObserveResult> {
    const { root, project } = await this.prepare(request);
    assertSupportedSurface(request.surface);
    const surface = requireSurfaceReady(project, request.surface);
    this.assertLease(project, root, request.sessionId);
    this.assertRunOperational(root);
    if (request.mode === "visual") return this.visualObserve(root, project, request);
    const limit = request.mode === "snapshot" ? Math.min(Math.max(request.limit ?? 200, 1), 500) : 200;
    const progress = [this.progress("reading_page", request.surface)];
    let result: { text: string; truncated: boolean };
    if (isWebSurface(request.surface)) {
      await this.options.assertBrowserReady?.();
      const binding = this.requireBrowserBinding(project.id, root, request.surface, true);
      result = await this.options.browser.observe({ ...binding, mode: request.mode, limit });
    } else {
      const mobile = this.requireMobileDriver();
      const appSurface = surface as { package?: string | null; serial?: string | null };
      const serial = this.requireMobileSerial(appSurface.serial);
      await this.assertMobileForeground(mobile, serial, appSurface.package);
      result = await mobile.observe({ serial, mode: request.mode, limit });
    }
    appendJournal(root, {
      surface: request.surface,
      kind: "observe",
      summary:
        request.surface === "app"
          ? request.mode === "text"
            ? "读取手机界面"
            : "读取手机可操作结构"
          : request.mode === "text"
            ? "读取页面正文"
            : "读取页面可操作结构",
      evidence: [],
    });
    return { surface: request.surface, mode: request.mode, text: result.text, truncated: result.truncated, progress };
  }

  private async visualObserve(root: string, project: Project, request: TestObserveRequest): Promise<TestObserveResult> {
    if (project.defaults?.visualCheck !== true) {
      throw new TestCoordinatorError("VISUAL_CHECK_DISABLED", "请先在项目设置中启用明显视觉异常检查");
    }
    const visualModel = project.defaults?.visualModel ?? null;
    if (!visualModel) {
      throw new TestCoordinatorError("VISUAL_MODEL_REQUIRED", "请先在项目设置中配置视觉模型");
    }
    const observed = await this.observeSurface(
      root,
      project,
      request.surface as SupportedSurface,
      requireSurfaceReady(project, request.surface) as NonNullable<Project["surfaces"][SupportedSurface]>,
    );
    if (SENSITIVE_VISUAL_PAGE.test(observed.text)) {
      throw new TestCoordinatorError("SENSITIVE_VISUAL_PAGE", "当前页面可能包含敏感信息，已阻止截图发送给 AI");
    }
    const evidence = await this.captureEvidence(root, project, request.surface as SupportedSurface, "visual-check");
    const filePath = path.join(root, ...evidence.split("/"));
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) {
      throw new TestCoordinatorError("BAD_REQUEST", "视觉检查截图无效或过大");
    }
    appendJournal(root, {
      surface: request.surface,
      kind: "observe",
      summary: "保存明显视觉异常检查截图",
      evidence: [evidence],
    });
    return {
      surface: request.surface,
      mode: "visual",
      text: "请只检查明显错位、遮挡、截断、空白页、图片加载失败和弹窗溢出；不确定时标记疑似视觉问题。",
      truncated: observed.truncated,
      evidence,
      visualModel,
      image: { mimeType: "image/png", data: Buffer.from(readFileSync(filePath)).toString("base64") },
      progress: [
        this.progress("checking_result", request.surface),
        this.progress("capturing_evidence", request.surface),
      ],
    };
  }

  async act(request: TestActRequest): Promise<TestActResult> {
    return this.atomicOperation(() => this.actAuthorized(request));
  }

  private async actAuthorized(request: TestActRequest): Promise<TestActResult> {
    const { root, project } = await this.prepare(request);
    assertSupportedSurface(request.surface);
    const surface = requireSurfaceReady(project, request.surface);
    this.assertLease(project, root, request.sessionId);
    this.assertRunOperational(root);
    const web = isWebSurface(request.surface);
    if (web) await this.options.assertBrowserReady?.();
    const binding = web
      ? this.requireBrowserBinding(project.id, root, request.surface as "h5" | "admin", request.action.type !== "open")
      : null;
    const mobile = web ? null : this.requireMobileDriver();
    const appSurface = surface as { package?: string | null; serial?: string | null };
    const mobileSerial = web ? null : this.requireMobileSerial(appSurface.serial);
    if (!web && request.action.type !== "open" && request.action.type !== "shot") {
      await this.assertMobileForeground(mobile!, mobileSerial!, appSurface.package);
    }
    if (request.action.type === "fill" && (request.action.sensitive || SENSITIVE_TARGET.test(request.action.target))) {
      throw new TestCoordinatorError(
        "MANUAL_LOGIN_REQUIRED",
        "自动秘密填写尚未提供安全 stdin/pipe 传值，请人工完成登录",
      );
    }
    const effectiveRisk = inferredRisk(request);
    if (riskRank(request.risk) < riskRank(effectiveRisk)) {
      throw new TestCoordinatorError("RISK_UNDERSTATED", `动作风险至少为 ${effectiveRisk}`);
    }
    if (
      project.environment === "production" &&
      (effectiveRisk !== "read" || request.action.type === "click" || request.action.type === "fill")
    ) {
      throw new TestCoordinatorError("PRODUCTION_READ_ONLY", "生产环境只允许打开、观察、等待和截图");
    }
    if (effectiveRisk !== "read") {
      const control = runControl(requireActiveRun(root).doc);
      if (effectiveRisk === "business_write") {
        if (!control.businessWriteConfirmedSurfaces.includes(request.surface)) {
          throw new TestCoordinatorError(
            "RUN_SCOPE_CONFIRMATION_REQUIRED",
            "业务写入必须在 test_run start 时声明 surface 和 risk=business_write",
          );
        }
      } else {
        let confirmed = false;
        if (request.confirmationId) {
          const confirmationId = assertPlainId(request.confirmationId, "confirmationId");
          confirmed = this.options.isConfirmed({
            projectRoot: request.projectRoot,
            ...(request.projectId ? { projectId: request.projectId } : {}),
            sessionId: request.sessionId,
            confirmationId,
            risk: effectiveRisk,
          });
        }
        if (!confirmed && this.options.confirmRisk) {
          confirmed = await this.options.confirmRisk({
            projectRoot: root,
            projectId: project.id,
            sessionId: request.sessionId,
            projectName: project.name,
            surface: request.surface,
            risk: effectiveRisk,
            scope: "action",
            action: request.action,
          });
        }
        if (!confirmed) throw new TestCoordinatorError("CONFIRMATION_REQUIRED", "该动作需要用户确认");
        appendJournal(root, {
          surface: request.surface,
          kind: "confirm",
          summary:
            `已确认高风险动作：${request.action.type} ${"target" in request.action ? request.action.target : ""}`.trim(),
          evidence: [],
        });
      }
    }

    const progress: TestProgressEvent[] = [];
    if (request.action.type === "open") {
      progress.push(this.progress("opening_page", request.surface));
      if (web) {
        const webSurface = surface as { url: string | null; viewport?: string };
        const url = webSurface.url;
        if (!url || !binding) throw new TestCoordinatorError("SURFACE_NOT_READY", "测试地址未配置");
        const opened = await this.options.browser.open({
          url,
          profileId: binding.profileId,
          viewport: webSurface.viewport,
          mobile: request.surface === "h5",
        });
        if (opened.tabId) {
          this.options.saveBrowserBinding?.(project.id, root, request.surface as "h5" | "admin", {
            profileId: binding.profileId,
            tabId: opened.tabId,
          });
        }
        appendJournal(root, { surface: request.surface, kind: "step", summary: `打开 ${url}`, evidence: [] });
        return {
          surface: request.surface,
          action: "open",
          message: "页面已打开",
          ...(opened.tabId ? { tabId: opened.tabId } : {}),
          progress,
        };
      }
      const appSurface = surface as { package: string | null; activity?: string | null };
      if (!appSurface.package || !mobile || !mobileSerial) {
        throw new TestCoordinatorError("SURFACE_NOT_READY", "测试 App 尚未确认");
      }
      await mobile.open({ serial: mobileSerial, packageName: appSurface.package, activity: appSurface.activity });
      appendJournal(root, {
        surface: request.surface,
        kind: "step",
        summary: `启动 ${appSurface.package}`,
        evidence: [],
      });
      return { surface: request.surface, action: "open", message: "App 已启动", progress };
    }
    if (request.action.type === "wait") {
      const durationMs = request.action.durationMs;
      if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 30_000) {
        throw new TestCoordinatorError("BAD_REQUEST", "等待时长必须在 50 到 30000 毫秒之间");
      }
      progress.push(this.progress("waiting", request.surface));
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      appendJournal(root, {
        surface: request.surface,
        kind: "step",
        summary: `等待 ${durationMs} 毫秒`,
        evidence: [],
      });
      return { surface: request.surface, action: "wait", message: "等待完成", progress };
    }
    if (request.action.type === "swipe") {
      if (web || !mobile || !mobileSerial) {
        throw new TestCoordinatorError("BAD_REQUEST", "swipe 仅支持 Android App");
      }
      progress.push(this.progress("clicking", request.surface));
      await mobile.swipe({
        serial: mobileSerial,
        direction: request.action.direction,
        distance: request.action.distance,
      });
      appendJournal(root, {
        surface: request.surface,
        kind: "step",
        summary: `滑动 ${request.action.direction}`,
        evidence: [],
      });
      return { surface: request.surface, action: "swipe", message: "滑动完成", progress };
    }

    const tabId = binding?.tabId;
    if (request.action.type === "shot") {
      progress.push(this.progress("capturing_evidence", request.surface));
      const evidence = await this.captureEvidence(root, project, request.surface);
      appendJournal(root, {
        surface: request.surface,
        kind: "observe",
        summary: "保存页面截图",
        evidence: [evidence],
      });
      return {
        surface: request.surface,
        action: "shot",
        message: "证据已保存",
        evidence,
        progress,
      };
    }
    if (
      !request.action.target.trim() ||
      request.action.target.length > MAX_TARGET_LENGTH ||
      /[\0\r\n]/.test(request.action.target) ||
      /^\s*\d+\s*,\s*\d+\s*$/.test(request.action.target)
    ) {
      throw new TestCoordinatorError("BAD_REQUEST", "target 无效，且不允许坐标入口");
    }
    if (request.action.type === "click") {
      progress.push(this.progress("clicking", request.surface));
      if (web && binding && tabId) {
        await this.options.browser.click({ profileId: binding.profileId, tabId, target: request.action.target });
      } else if (mobile && mobileSerial) {
        await mobile.click({ serial: mobileSerial, target: request.action.target });
      }
      appendJournal(root, {
        surface: request.surface,
        kind: "step",
        summary: `点击 ${request.action.target}`,
        evidence: [],
      });
      return { surface: request.surface, action: "click", message: "点击完成", progress };
    }
    if (request.action.value.length > MAX_VALUE_LENGTH) throw new TestCoordinatorError("BAD_REQUEST", "填写内容过长");
    progress.push(this.progress("filling", request.surface));
    if (web && binding && tabId) {
      await this.options.browser.fill({
        profileId: binding.profileId,
        tabId,
        target: request.action.target,
        value: request.action.value,
      });
    } else if (mobile && mobileSerial) {
      await mobile.fill({ serial: mobileSerial, target: request.action.target, value: request.action.value });
    }
    appendJournal(root, {
      surface: request.surface,
      kind: "step",
      summary: `填写 ${request.action.target}`,
      evidence: [],
    });
    return { surface: request.surface, action: "fill", message: "填写完成", progress };
  }

  private assertRunOperational(root: string): void {
    const control = runControl(requireActiveRun(root).doc);
    if (control.state !== "running") {
      throw new TestCoordinatorError(
        control.state === "waiting_for_user" || control.state === "takeover_requested"
          ? "WAITING_FOR_USER"
          : "RUN_PAUSED",
        control.state === "waiting_for_user" || control.state === "takeover_requested"
          ? "正在等待用户完成现场操作"
          : "当前测试已暂停",
      );
    }
  }

  private async resumeRun(root: string, project: Project): Promise<TestRunResult> {
    const active = requireActiveRun(root);
    const previous = runControl(active.doc);
    if (previous.state !== "paused" && previous.state !== "waiting_for_user") {
      throw new TestCoordinatorError("RUN_NOT_PAUSED", `当前执行状态为 ${previous.state}`);
    }
    if (!previous.surface) throw new TestCoordinatorError("BAD_RUN_STATE", "暂停状态缺少测试端");
    assertSupportedSurface(previous.surface);
    const surface = requireSurfaceReady(project, previous.surface);
    updateRunControl(root, { state: "resuming" });
    try {
      const observation = await this.observeSurface(root, project, previous.surface, surface);
      const evidence =
        previous.state === "waiting_for_user" && !previous.sensitive
          ? await this.captureEvidence(root, project, previous.surface)
          : null;
      const updated = updateRunControl(root, {
        state: "running",
        surface: null,
        takeoverReason: null,
        sensitive: false,
      });
      appendJournal(root, {
        surface: previous.surface,
        kind: "observe",
        summary: previous.state === "waiting_for_user" ? "用户完成操作后重新感知现场" : "恢复前重新感知现场",
        evidence: evidence ? [evidence] : [],
      });
      return { activeRun: updated.dirName, run: loadRun(root, updated.dirName), observation };
    } catch (error) {
      updateRunControl(root, {
        state: previous.state,
        surface: previous.surface,
        takeoverReason: previous.takeoverReason,
        sensitive: previous.sensitive,
      });
      throw error;
    }
  }

  private async observeSurface(
    root: string,
    project: Project,
    surfaceName: "h5" | "admin" | "app",
    surface: NonNullable<Project["surfaces"]["h5" | "admin" | "app"]>,
  ): Promise<TestObserveResult> {
    const progress = [this.progress("checking_result", surfaceName)];
    let result: { text: string; truncated: boolean };
    if (isWebSurface(surfaceName)) {
      await this.options.assertBrowserReady?.();
      const binding = this.requireBrowserBinding(project.id, root, surfaceName, true);
      result = await this.options.browser.observe({ ...binding, mode: "snapshot", limit: 200 });
    } else {
      const appSurface = surface as { package?: string | null; serial?: string | null };
      const mobile = this.requireMobileDriver();
      const serial = this.requireMobileSerial(appSurface.serial);
      await this.assertMobileForeground(mobile, serial, appSurface.package);
      result = await mobile.observe({ serial, mode: "snapshot", limit: 200 });
    }
    return { surface: surfaceName, mode: "snapshot", text: result.text, truncated: result.truncated, progress };
  }

  private async assertMobileForeground(
    mobile: TestMobileDriver,
    serial: string,
    expectedPackage: string | null | undefined,
  ): Promise<void> {
    if (!expectedPackage) throw new TestCoordinatorError("SURFACE_NOT_READY", "测试 App 尚未确认");
    const foreground = await mobile.foreground(serial);
    if (foreground.packageName !== expectedPackage) {
      throw new TestCoordinatorError(
        "APP_FOREGROUND_CHANGED",
        `当前前台 App 为 ${foreground.packageName}，请切回 ${expectedPackage} 后重新感知`,
      );
    }
  }

  private async captureEvidence(
    root: string,
    project: Project,
    surfaceName: "h5" | "admin" | "app",
    name?: string,
  ): Promise<string> {
    const active = requireActiveRun(root);
    if (lstatSync(active.evidenceDir).isSymbolicLink()) {
      throw new TestCoordinatorError("BAD_REQUEST", "证据目录不能是符号链接");
    }
    const realRoot = realpathSync(root);
    const realEvidenceDir = realpathSync(active.evidenceDir);
    const relativeEvidenceDir = path.relative(realRoot, realEvidenceDir);
    if (relativeEvidenceDir.startsWith("..") || path.isAbsolute(relativeEvidenceDir)) {
      throw new TestCoordinatorError("BAD_REQUEST", "证据目录越界");
    }
    const stem = name && /^[a-z][a-z0-9-]{1,127}$/.test(name) ? name : surfaceName;
    const fileName = `${stem}-${Date.now()}.png`;
    const outputPath = path.join(realEvidenceDir, fileName);
    if (isWebSurface(surfaceName)) {
      await this.options.assertBrowserReady?.();
      const binding = this.requireBrowserBinding(project.id, root, surfaceName, true);
      await this.options.browser.screenshot({ ...binding, out: outputPath });
    } else {
      const surface = requireSurfaceReady(project, surfaceName);
      const mobile = this.requireMobileDriver();
      const serial = this.requireMobileSerial(surface.serial);
      await this.assertMobileForeground(mobile, serial, surface.package);
      await mobile.screenshot({ serial, out: outputPath });
    }
    if (!existsSync(outputPath)) throw new TestCoordinatorError("DRIVER_FAILED", "截图未写入证据目录");
    return path.posix.join("runs", active.dirName, "evidence", fileName);
  }

  private async completePendingControl(): Promise<void> {
    const pending = this.pendingControl;
    if (!pending || this.activeAtomicOperations > 0 || this.completingControl) return;
    this.pendingControl = null;
    this.completingControl = true;
    try {
      let evidence: string | null = null;
      let evidenceError: unknown;
      if (!pending.sensitive) {
        try {
          evidence = await this.captureEvidence(pending.root, pending.project, pending.surface);
        } catch (error) {
          evidenceError = error;
        }
      }
      const updated = updateRunControl(pending.root, { state: pending.target });
      appendJournal(pending.root, {
        surface: pending.surface,
        kind: pending.target === "paused" ? "step" : "ask",
        summary: pending.target === "paused" ? "当前步骤已完成，测试已暂停" : "已停止自动操作，等待用户完成现场操作",
        evidence: evidence ? [evidence] : [],
      });
      if (evidenceError) {
        appendJournal(pending.root, {
          surface: pending.surface,
          kind: "error",
          summary: "暂停前截图失败，测试保持暂停",
          evidence: [],
        });
      }
      pending.resolve({ activeRun: updated.dirName, run: loadRun(pending.root, updated.dirName) });
    } catch (error) {
      pending.reject(error);
    } finally {
      this.completingControl = false;
    }
  }

  private async prepare(
    context: TestRequestContext,
    requireLicense = true,
  ): Promise<{ root: string; project: Project }> {
    const root = validateContext(context);
    if (requireLicense) await this.options.assertLicensed({ ...context, projectRoot: root });
    const project = loadProject(root);
    if (context.projectId && context.projectId !== project.id) {
      throw new TestCoordinatorError("PROJECT_MISMATCH", "projectId 与 project.yaml 不一致");
    }
    return { root, project };
  }

  async assertActiveLease(context: TestRequestContext): Promise<{ root: string; project: Project }> {
    const prepared = await this.prepare(context);
    this.assertLease(prepared.project, prepared.root, context.sessionId);
    requireActiveRun(prepared.root);
    return prepared;
  }

  private requireMobileDriver(): TestMobileDriver {
    if (!this.options.mobile) {
      throw new TestCoordinatorError("MOBILE_DRIVER_UNAVAILABLE", "移动端驱动不可用");
    }
    return this.options.mobile;
  }

  private requireMobileSerial(value: string | null | undefined): string {
    if (!value) throw new TestCoordinatorError("ANDROID_DEVICE_REQUIRED", "请先选择并连接 Android 设备");
    return assertPlainId(value, "device serial");
  }

  private requireBrowserBinding(
    projectId: string,
    projectRoot: string,
    surface: "h5" | "admin",
    requireTab: boolean,
  ): BrowserDriverBinding {
    const binding = this.options.resolveBrowserBinding(projectId, projectRoot, surface);
    if (!binding) throw new TestCoordinatorError("BROWSER_BINDING_REQUIRED", "请先选择项目使用的 Chrome Profile");
    const profileId = assertPlainId(binding.profileId, "profileId");
    const tabId = binding.tabId === undefined ? undefined : assertPlainId(binding.tabId, "tabId");
    if (requireTab && !tabId) throw new TestCoordinatorError("BROWSER_TAB_REQUIRED", "请先打开并绑定项目测试页面");
    return { profileId, ...(tabId ? { tabId } : {}) };
  }

  private async atomicOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeAtomicOperations > 0 || this.completingControl) {
      throw new TestCoordinatorError("TEST_BUSY", "当前原子步骤尚未完成");
    }
    this.activeAtomicOperations = 1;
    try {
      return await operation();
    } finally {
      this.activeAtomicOperations = 0;
      if (this.activeAtomicOperations === 0 && this.authorizationLossPending) this.authorizationLost();
      else if (this.activeAtomicOperations === 0 && this.pendingControl) await this.completePendingControl();
    }
  }

  private abortLeaseIfPresent(): void {
    if (!this.lease) return;
    try {
      this.abortLease();
    } catch {
      this.lease = null;
    }
  }

  private abortLease(): void {
    const pending = this.pendingControl;
    this.pendingControl = null;
    try {
      finishRun(this.lease!.projectRoot, { status: "aborted", text: "测试会话意外结束" });
    } finally {
      this.lease = null;
      pending?.reject(new TestCoordinatorError("TEST_SESSION_ENDED", "测试会话已结束"));
    }
  }

  private assertLease(project: Project, projectRoot: string, sessionId: string): void {
    if (
      !this.lease ||
      this.lease.projectId !== project.id ||
      this.lease.projectRoot !== projectRoot ||
      this.lease.sessionId !== sessionId
    ) {
      throw new TestCoordinatorError("TEST_LEASE_REQUIRED", "当前会话不持有全局测试执行租约");
    }
  }

  private progress(code: TestProgressCode, surface: SurfaceName): TestProgressEvent {
    const event = { code, message: PROGRESS_MESSAGES[code], at: new Date().toISOString(), surface };
    this.options.onProgress?.(event);
    return event;
  }
}

export class AgentBrowserCliDriver implements TestBrowserDriver {
  private readonly executable: string;
  private readonly executor: ProbeExecutor;

  constructor(executable: string, executor: ProbeExecutor) {
    if (!path.isAbsolute(executable)) throw new Error("agent-browser-cli path must be absolute");
    this.executable = executable;
    this.executor = executor;
  }

  async observe(input: BrowserDriverBinding & { mode: "text" | "snapshot"; limit: number }) {
    const args =
      input.mode === "text"
        ? ["scan", "--text-only", "--tab", input.tabId!, "--profile", input.profileId, "--timeout", "30"]
        : [
            "snapshot",
            "--limit",
            String(input.limit),
            "--tab",
            input.tabId!,
            "--profile",
            input.profileId,
            "--timeout",
            "30",
          ];
    const result = await this.run(args, 35_000);
    return { text: browserObservationText(result.text, input.mode), truncated: result.truncated };
  }

  async open(input: {
    url: string;
    profileId: string;
    viewport?: string;
    mobile?: boolean;
  }): Promise<{ tabId?: string }> {
    const result = await this.run(["open", "--profile", input.profileId, "--timeout", "30", "--", input.url], 35_000);
    const tabId = findOpenedTabId(result.text);
    if (!tabId) return {};

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const lookup = await this.run(["lookup", "tab", tabId], 5_000, true);
      if (isConnectedTab(lookup.text, input.profileId, tabId)) {
        if (input.viewport) {
          const [width, height] = input.viewport.split("x").map(Number);
          await this.run(
            [
              "exec",
              "--tab",
              tabId,
              "--profile",
              input.profileId,
              JSON.stringify({
                cmd: "cdp",
                method: "Emulation.setDeviceMetricsOverride",
                params: { width, height, deviceScaleFactor: 1, mobile: input.mobile === true },
              }),
            ],
            35_000,
          );
        }
        return { tabId };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new TestCoordinatorError("DRIVER_FAILED", "新页面未连接浏览器驱动");
  }

  async click(input: BrowserDriverBinding & { target: string }): Promise<void> {
    const direct = await this.run(
      ["click", "--tab", input.tabId!, "--profile", input.profileId, "--timeout", "30", "--", input.target],
      35_000,
      true,
    );
    if (!driverReportedFailure(direct.text)) return;
    if (/^@e\d+$/i.test(input.target)) {
      throw new TestCoordinatorError(
        "DRIVER_FAILED",
        driverErrorMessage(direct.text) ?? "操作引用已失效，请重新读取页面结构后重试",
      );
    }

    const fallback = await this.run(
      [
        "exec",
        "--tab",
        input.tabId!,
        "--profile",
        input.profileId,
        "--timeout",
        "30",
        visibleTextClickScript(input.target),
      ],
      35_000,
    );
    const parsed = parseDriverJson(fallback.text) as {
      result?: { js_return?: { matched?: unknown; reason?: unknown } };
    };
    const outcome = parsed.result?.js_return;
    if (outcome?.matched === true) return;
    throw new TestCoordinatorError(
      "DRIVER_FAILED",
      outcome?.reason === "disabled"
        ? `目标当前不可点击: ${input.target}`
        : `未找到可见文案或无障碍名为“${input.target}”的可点击元素`,
    );
  }

  async fill(input: BrowserDriverBinding & { target: string; value: string }): Promise<void> {
    const direct = await this.run(
      ["fill", "--tab", input.tabId!, "--profile", input.profileId, "--timeout", "30", "--", input.target, input.value],
      35_000,
      true,
    );
    if (!driverReportedFailure(direct.text)) return;
    if (/^@e\d+$/i.test(input.target)) {
      throw new TestCoordinatorError(
        "DRIVER_FAILED",
        driverErrorMessage(direct.text) ?? "操作引用已失效，请重新读取页面结构后重试",
      );
    }

    const fallback = await this.run(
      [
        "exec",
        "--tab",
        input.tabId!,
        "--profile",
        input.profileId,
        "--timeout",
        "30",
        visibleTextFillScript(input.target, input.value),
      ],
      35_000,
    );
    const parsed = parseDriverJson(fallback.text) as {
      result?: { js_return?: { matched?: unknown; reason?: unknown } };
    };
    const outcome = parsed.result?.js_return;
    if (outcome?.matched === true) return;
    throw new TestCoordinatorError(
      "DRIVER_FAILED",
      outcome?.reason === "disabled"
        ? `目标当前不可填写: ${input.target}`
        : `未找到可见文案或无障碍名为“${input.target}”的输入元素`,
    );
  }

  async currentUrl(input: BrowserDriverBinding): Promise<string> {
    const result = await this.run(["lookup", "tab", input.tabId!], 5_000);
    try {
      const parsed = JSON.parse(result.text) as { result?: { url?: unknown } };
      if (typeof parsed.result?.url === "string") return parsed.result.url;
    } catch {
      // Report the same bounded driver failure as other malformed responses.
    }
    throw new TestCoordinatorError("DRIVER_FAILED", "浏览器驱动未返回当前地址");
  }

  async screenshot(input: BrowserDriverBinding & { out: string }): Promise<void> {
    if (!path.isAbsolute(input.out) || /[\0\r\n]/.test(input.out)) {
      throw new TestCoordinatorError("BAD_REQUEST", "截图输出路径无效");
    }
    await this.run(
      ["screenshot", "--out", input.out, "--tab", input.tabId!, "--profile", input.profileId, "--timeout", "30"],
      35_000,
    );
  }

  async inspect(): Promise<{ status: unknown; tabs: unknown }> {
    const tabs = await this.run(["tabs"], 15_000);
    const status = await this.run(["status"], 10_000);
    return { status: parseDriverJson(status.text), tabs: parseDriverJson(tabs.text) };
  }

  private async run(
    args: string[],
    timeoutMs: number,
    allowReportedFailure = false,
  ): Promise<{ text: string; truncated: boolean }> {
    const result = await this.executor.run({
      executable: this.executable,
      args,
      timeoutMs,
      outputLimitBytes: MAX_OUTPUT_BYTES,
    });
    if (!probeSucceeded(result)) {
      const reason = result.timedOut
        ? "操作超时"
        : result.outputLimitExceeded
          ? "驱动输出过大"
          : result.spawnErrorCode
            ? `无法启动驱动 (${result.spawnErrorCode})`
            : `驱动退出码 ${String(result.exitCode)}`;
      throw new TestCoordinatorError("DRIVER_FAILED", reason);
    }
    const text = result.stdout.trim();
    if (!allowReportedFailure && driverReportedFailure(text)) {
      throw new TestCoordinatorError("DRIVER_FAILED", driverErrorMessage(text) ?? "浏览器驱动未完成操作");
    }
    return { text, truncated: result.outputLimitExceeded };
  }
}

function visibleTextClickScript(target: string): string {
  return `
const __normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
const __wanted = __normalize(${JSON.stringify(target)});
const __interactive = 'button,a[href],input[type="button"],input[type="submit"],summary,[role="button"],[role="link"],[onclick],[tabindex]:not([tabindex="-1"])';
const __visible = element => {
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
};
const __allElements = root => {
  const list = [...(root || document).querySelectorAll('*')];
  for (const element of [...list]) {
    if (element.shadowRoot) list.push(...__allElements(element.shadowRoot));
  }
  return list;
};
const __name = element => {
  const labelledBy = (element.getAttribute('aria-labelledby') || '')
    .split(/\\s+/)
    .filter(Boolean)
    .map(id => (element.getRootNode().getElementById ? element.getRootNode().getElementById(id) : null)?.innerText || '')
    .join(' ');
  return __normalize(
    element.getAttribute('aria-label') ||
    labelledBy ||
    element.getAttribute('alt') ||
    element.getAttribute('title') ||
    (element instanceof HTMLInputElement ? element.value || element.placeholder : '') ||
    element.innerText ||
    element.textContent
  );
};
const __elements = __allElements().filter(__visible);
let __match = __elements.find(element => element.matches(__interactive) && __name(element) === __wanted);
if (!__match) {
  const leaf = [...__elements].reverse().find(element => __name(element) === __wanted);
  __match = leaf?.closest(__interactive) || leaf;
}
if (!__match) return { matched: false, reason: 'not_found' };
if (__match.matches(':disabled,[aria-disabled="true"],[inert]')) return { matched: false, reason: 'disabled' };
__match.scrollIntoView({ block: 'center', inline: 'center' });
__match.click();
return { matched: true, tag: __match.tagName, text: __name(__match).slice(0, 100) };
`.trim();
}

function visibleTextFillScript(target: string, value: string): string {
  return `
const __normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
const __wanted = __normalize(${JSON.stringify(target)});
const __value = ${JSON.stringify(value)};
const __visible = element => {
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
};
const __allElements = root => {
  const list = [...(root || document).querySelectorAll('*')];
  for (const element of [...list]) {
    if (element.shadowRoot) list.push(...__allElements(element.shadowRoot));
  }
  return list;
};
const __editable = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"]';
const __name = element => {
  const labelledBy = (element.getAttribute('aria-labelledby') || '')
    .split(/\\s+/)
    .filter(Boolean)
    .map(id => (element.getRootNode().getElementById ? element.getRootNode().getElementById(id) : null)?.innerText || '')
    .join(' ');
  const labels = element.labels ? [...element.labels].map(label => label.innerText || label.textContent).join(' ') : '';
  return __normalize(
    element.getAttribute('aria-label') ||
    labelledBy ||
    element.getAttribute('placeholder') ||
    labels ||
    element.value ||
    element.getAttribute('title') ||
    element.getAttribute('name') ||
    element.innerText ||
    element.textContent
  );
};
let __match = __allElements().filter(__visible).find(element => element.matches(__editable) && __name(element) === __wanted);
if (!__match) {
  for (const label of __allElements().filter(element => element.tagName === 'LABEL' && __visible(element))) {
    if (__normalize(label.innerText || label.textContent) !== __wanted) continue;
    const id = label.getAttribute('for');
    const control = id
      ? (label.getRootNode().getElementById ? label.getRootNode().getElementById(id) : null)
      : label.querySelector(__editable);
    if (control && control.matches(__editable) && __visible(control)) { __match = control; break; }
  }
}
if (!__match) return { matched: false, reason: 'not_found' };
if (__match.matches(':disabled,[aria-disabled="true"],[inert]')) return { matched: false, reason: 'disabled' };
__match.scrollIntoView({ block: 'center', inline: 'center' });
__match.focus();
if (__match.isContentEditable) {
  __match.textContent = '';
  let inserted = false;
  try { inserted = document.execCommand('insertText', false, __value); } catch (_) { inserted = false; }
  if (!inserted) { __match.textContent = __value; __match.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: __value, bubbles: true })); }
  __match.dispatchEvent(new Event('change', { bubbles: true }));
} else if (__match.tagName === 'SELECT') {
  __match.value = __value;
  __match.dispatchEvent(new Event('change', { bubbles: true }));
} else if (__match.tagName === 'INPUT' || __match.tagName === 'TEXTAREA') {
  const setter = Object.getOwnPropertyDescriptor(__match.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(__match, __value); else __match.value = __value;
  __match.dispatchEvent(new Event('input', { bubbles: true }));
  __match.dispatchEvent(new Event('change', { bubbles: true }));
} else {
  try { document.execCommand('insertText', false, __value); } catch (_) {}
  __match.dispatchEvent(new Event('input', { bubbles: true }));
  __match.dispatchEvent(new Event('change', { bubbles: true }));
}
return { matched: true, tag: __match.tagName, text: __name(__match).slice(0, 100) };
`.trim();
}

function driverErrorMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error !== "string" || !parsed.error.trim()) return undefined;
    return parsed.error.replaceAll("\0", "").replaceAll("\r", " ").replaceAll("\n", " ").trim().slice(0, 500);
  } catch {
    return undefined;
  }
}

function parseDriverJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TestCoordinatorError("DRIVER_FAILED", "浏览器驱动返回了无效 JSON");
  }
}

function driverReportedFailure(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown };
    return parsed?.ok === false;
  } catch {
    return false;
  }
}

function isConnectedTab(text: string, profileId: string, tabId: string): boolean {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; result?: Record<string, unknown> };
    return parsed.ok === true && parsed.result?.profile_id === profileId && String(parsed.result.tab_id) === tabId;
  } catch {
    return false;
  }
}

function browserObservationText(text: string, mode: "text" | "snapshot"): string {
  const parsed = parseDriverJson(text) as { ok?: unknown; result?: Record<string, unknown> };
  const value = mode === "text" ? parsed.result?.content : parsed.result?.tree;
  if (parsed.ok !== true || (typeof value !== "string" && !Array.isArray(value))) {
    throw new TestCoordinatorError("DRIVER_FAILED", "浏览器驱动返回了无效观察结果");
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function playbackActionRisk(testCase: TestCase, target?: string): TestRisk {
  if (testCase.risk === "high" || (target && HIGH_RISK_TARGET.test(target))) return "high";
  if (target && BUSINESS_WRITE_TARGET.test(target)) return "business_write";
  return "read";
}

function caseBusinessWriteSurfaces(testCase: TestCase): SurfaceName[] {
  return testCase.steps.flatMap((step) => {
    if ((step.act !== "tap" && step.act !== "fill") || playbackActionRisk(testCase, step.target) === "read") {
      return [];
    }
    return [step.surface ?? testCase.surface];
  });
}

function caseHasProductionUnsafeAction(testCase: TestCase): boolean {
  return testCase.risk === "high" || testCase.steps.some((step) => step.act === "tap" || step.act === "fill");
}

function caseSurfaces(testCase: TestCase): SurfaceName[] {
  return [
    ...new Set([
      testCase.surface,
      ...(testCase.pre ?? []).map((item) => item.surface ?? testCase.surface),
      ...testCase.steps.map((item) => item.surface ?? testCase.surface),
      ...(testCase.assert ?? []).map((item) => item.surface ?? testCase.surface),
    ]),
  ];
}

function parseDuration(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const match = /^(\d+)(ms|s)$/.exec(value);
  if (!match) throw new TestCoordinatorError("BAD_REQUEST", `时长无效: ${value}`);
  const duration = Number(match[1]) * (match[2] === "s" ? 1_000 : 1);
  if (!Number.isSafeInteger(duration) || duration < 50 || duration > maximum) {
    throw new TestCoordinatorError("BAD_REQUEST", `时长必须在 50 到 ${maximum} 毫秒之间`);
  }
  return duration;
}

function interpolatePlayback(value: string, project: Project, root: string, captures: Record<string, string>): string {
  const withCaptures = value.replace(/\{\{\s*capture\.([a-z][a-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    const captured = captures[key];
    if (captured === undefined) throw new TestCoordinatorError("CAPTURE_NOT_FOUND", `缺少 capture: ${key}`);
    return captured;
  });
  if (/\{\{\s*capture\./.test(withCaptures)) {
    throw new TestCoordinatorError("BAD_REQUEST", "capture 模板无效");
  }
  const inputKeys = [...withCaptures.matchAll(/\{\{\s*input\.([a-z][a-z0-9_]*)\s*\}\}/g)].map((match) => match[1]);
  for (const key of inputKeys) {
    if (project.inputs?.[key]?.secret !== false) {
      throw new TestCoordinatorError("MANUAL_LOGIN_REQUIRED", `输入 ${key} 是秘密，请人工接管完成填写`);
    }
  }
  return interpolate(withCaptures, project, loadSecrets(root));
}

function isEnvironmentError(error: unknown): boolean {
  const code = error instanceof TestCoordinatorError ? error.code : "";
  return /^(?:BROWSER|ANDROID|MOBILE|SURFACE|TEST_LEASE|RUN_PAUSED|WAITING_FOR_USER|CONFIRMATION|MANUAL_LOGIN|CAPTURE_NOT_FOUND)/.test(
    code,
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:password|passwd|token|secret|otp|验证码)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 500);
}

function findOpenedTabId(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const value = queue.shift();
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        queue.push(...value);
        continue;
      }
      const record = value as Record<string, unknown>;
      for (const key of ["opened_tab_id", "tab_id", "tabId"]) {
        if (typeof record[key] === "string" || typeof record[key] === "number") return String(record[key]);
      }
      queue.push(...Object.values(record));
    }
  } catch {
    return undefined;
  }
  return undefined;
}
