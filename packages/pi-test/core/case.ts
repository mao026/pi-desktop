import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { compileCapturePattern } from "./capture.ts";
import { casePath, casesDir, isRunDirName, runsDir } from "./paths.ts";
import type { Project, SurfaceName } from "./project.ts";
import { loadRun } from "./run.ts";
import { nowIso } from "./time.ts";
import { readYamlFile, writeYamlFile } from "./yaml.ts";

export type CaseStatus = "draft" | "stable" | "disabled";
export type CaseRisk = "normal" | "high";

export type ActName = "open" | "connect" | "launch" | "tap" | "fill" | "wait" | "swipe" | "shot" | "ui" | "capture";

export interface CaseStep {
  act: ActName;
  surface?: SurfaceName;
  target?: string;
  value?: string;
  url?: string;
  text?: string;
  idle?: string;
  package?: string;
  direction?: "up" | "down" | "left" | "right";
  distance?: number;
  name?: string;
  timeout?: string;
  optional?: boolean;
  note?: string | null;
  pattern?: string;
  as?: string;
}

export interface CasePre {
  surface?: SurfaceName;
  open?: string;
  connect?: boolean;
  launch?: boolean;
}

export interface CaseAssert {
  surface?: SurfaceName;
  see?: string;
  not_see?: string;
  url_contains?: string;
  package?: string;
}

export interface TestCase {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string | null;
  surface: SurfaceName;
  status: CaseStatus;
  tags?: string[];
  risk?: CaseRisk;
  createdAt: string;
  updatedAt: string;
  pre?: CasePre[];
  steps: CaseStep[];
  assert?: CaseAssert[];
}

export class CaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseError";
  }
}

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TAG_RE = /^[a-z0-9-]{1,32}$/;
const ACTS = new Set<ActName>(["open", "connect", "launch", "tap", "fill", "wait", "swipe", "shot", "ui", "capture"]);
const SURFACES = new Set(["h5", "admin", "app", "miniprogram"]);
const STEP_KEYS = new Set([
  "act",
  "surface",
  "target",
  "value",
  "url",
  "text",
  "idle",
  "package",
  "direction",
  "distance",
  "name",
  "timeout",
  "optional",
  "note",
  "pattern",
  "as",
]);
const PRE_KEYS = new Set(["surface", "open", "connect", "launch"]);
const ASSERT_KEYS = new Set(["surface", "see", "not_see", "url_contains", "package"]);
const TOP = new Set([
  "schemaVersion",
  "id",
  "title",
  "description",
  "surface",
  "status",
  "tags",
  "risk",
  "createdAt",
  "updatedAt",
  "pre",
  "steps",
  "assert",
]);

export function validateCase(raw: unknown, project?: Project): TestCase {
  if (!raw || typeof raw !== "object") throw new CaseError("case 不是对象");
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !TOP.has(k));
  if (unknown.length) throw new CaseError(`未知字段: ${unknown.join(", ")}`);
  if (o.schemaVersion !== 1) throw new CaseError("schemaVersion 必须是 1");
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new CaseError("id 不合法");
  if (typeof o.title !== "string" || o.title.length < 1 || o.title.length > 120) {
    throw new CaseError("title 不合法");
  }
  if (typeof o.surface !== "string" || !SURFACES.has(o.surface)) throw new CaseError("surface 不合法");
  if (project && !project.surfaces[o.surface as SurfaceName]) {
    throw new CaseError(`project 无 surface: ${o.surface}`);
  }
  if (o.status !== "draft" && o.status !== "stable" && o.status !== "disabled") {
    throw new CaseError("status 必须是 draft|stable|disabled");
  }
  if (o.risk != null && o.risk !== "normal" && o.risk !== "high") throw new CaseError("risk 无效");
  if (typeof o.createdAt !== "string" || typeof o.updatedAt !== "string") {
    throw new CaseError("createdAt/updatedAt 必填");
  }
  if (o.tags != null) {
    if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string" || !TAG_RE.test(t))) {
      throw new CaseError("tags 无效");
    }
  }
  if (!Array.isArray(o.steps) || o.steps.length < 1) throw new CaseError("steps 至少 1 步");
  if (o.pre != null) {
    if (!Array.isArray(o.pre)) throw new CaseError("pre 必须是数组");
    for (const pre of o.pre as CasePre[]) {
      if (!pre || typeof pre !== "object") throw new CaseError("pre 无效");
      const unknown = Object.keys(pre).filter((key) => !PRE_KEYS.has(key));
      if (unknown.length) throw new CaseError(`pre 未知字段: ${unknown.join(", ")}`);
      const actions = [pre.open, pre.connect, pre.launch].filter((value) => value != null).length;
      if (actions !== 1) throw new CaseError("pre 需要恰好一个 open|connect|launch");
      if (pre.surface && !SURFACES.has(pre.surface)) throw new CaseError(`pre.surface 无效: ${pre.surface}`);
      if (project && pre.surface && !project.surfaces[pre.surface]) {
        throw new CaseError(`project 无 pre.surface: ${pre.surface}`);
      }
    }
  }
  for (const step of o.steps as CaseStep[]) {
    if (!step || typeof step !== "object") throw new CaseError("step 无效");
    const unknown = Object.keys(step).filter((key) => !STEP_KEYS.has(key));
    if (unknown.length) throw new CaseError(`step 未知字段: ${unknown.join(", ")}`);
    if (!ACTS.has(step.act)) throw new CaseError(`未知 act: ${step.act}`);
    if (step.act === "fill" && step.value == null) throw new CaseError("fill 需要 value");
    if (step.act === "tap" && !step.target) throw new CaseError("tap 需要 target");
    if (step.act === "open" && !step.url) throw new CaseError("open 需要 url");
    if (step.act === "shot" && !step.name) throw new CaseError("shot 需要 name");
    if (step.act === "swipe" && !step.direction) throw new CaseError("swipe 需要 direction");
    if (step.act === "capture") {
      if (!step.pattern || !step.as || !/^[a-z][a-z0-9_]{0,31}$/.test(step.as)) {
        throw new CaseError("capture 需要合法 pattern 和 as");
      }
      try {
        compileCapturePattern(step.pattern);
      } catch (error) {
        throw new CaseError(error instanceof Error ? error.message : "capture pattern 无效");
      }
    }
    if (step.act === "wait") {
      const n = [step.text, step.idle, step.package].filter((x) => x != null).length;
      if (n !== 1) throw new CaseError("wait 需要恰好一个 text|idle|package");
    }
    if (step.target && /^@e\d+$/i.test(step.target) && o.status === "stable") {
      throw new CaseError("stable case 禁止 @eN target");
    }
    if (step.surface && !SURFACES.has(step.surface)) throw new CaseError(`step.surface 无效: ${step.surface}`);
    if (project && step.surface && !project.surfaces[step.surface]) {
      throw new CaseError(`project 无 step.surface: ${step.surface}`);
    }
  }
  if (o.assert != null) {
    if (!Array.isArray(o.assert)) throw new CaseError("assert 必须是数组");
    for (const assertion of o.assert as CaseAssert[]) {
      if (!assertion || typeof assertion !== "object") throw new CaseError("assert 无效");
      const unknown = Object.keys(assertion).filter((key) => !ASSERT_KEYS.has(key));
      if (unknown.length) throw new CaseError(`assert 未知字段: ${unknown.join(", ")}`);
      const checks = [assertion.see, assertion.not_see, assertion.url_contains, assertion.package].filter(
        (value) => value != null,
      ).length;
      if (checks !== 1) throw new CaseError("assert 需要恰好一个检查字段");
      if (assertion.surface && !SURFACES.has(assertion.surface)) {
        throw new CaseError(`assert.surface 无效: ${assertion.surface}`);
      }
      if (project && assertion.surface && !project.surfaces[assertion.surface]) {
        throw new CaseError(`project 无 assert.surface: ${assertion.surface}`);
      }
    }
  }
  return o as unknown as TestCase;
}

export function loadCase(root: string, id: string, project?: Project): TestCase {
  const path = casePath(root, id);
  if (!existsSync(path)) throw new CaseError(`找不到 case: ${id}`);
  const c = validateCase(readYamlFile(path), project);
  if (c.id !== id) throw new CaseError(`文件名与 id 不一致: ${id} vs ${c.id}`);
  return c;
}

export function listCases(root: string): { id: string; status: CaseStatus; title: string; surface: string }[] {
  const dir = casesDir(root);
  if (!existsSync(dir)) return [];
  const out: { id: string; status: CaseStatus; title: string; surface: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml")) continue;
    const id = basename(f, ".yaml");
    try {
      const c = loadCase(root, id);
      out.push({ id: c.id, status: c.status, title: c.title, surface: c.surface });
    } catch {
      out.push({ id, status: "draft", title: "(invalid)", surface: "?" });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function setCaseStatus(root: string, id: string, status: CaseStatus, project?: Project): TestCase {
  if (status !== "draft" && status !== "stable" && status !== "disabled") {
    throw new CaseError("status 必须是 draft|stable|disabled");
  }
  const c = loadCase(root, id, project);
  if (status === "stable") {
    if (c.surface === "miniprogram" || caseSurfaces(c).includes("miniprogram")) {
      throw new CaseError("miniprogram case 不能晋级 stable");
    }
    c.status = "stable";
    validateCase(c, project);
    if (!hasSuccessfulRun(root, id, c.updatedAt)) throw new CaseError("case 至少成功运行一次后才能晋级 stable");
  }
  c.status = status;
  c.updatedAt = nowIso();
  writeYamlFile(casePath(root, id), c);
  return c;
}

export function createCase(root: string, c: TestCase, project?: Project): TestCase {
  validateCase(c, project);
  const file = casePath(root, c.id);
  if (existsSync(file)) throw new CaseError(`case 已存在: ${c.id}`);
  writeYamlFile(file, c);
  writeCaseMdStub(root, c.id, c.title);
  return c;
}

export function updateCase(root: string, c: TestCase, project?: Project): TestCase {
  if (!existsSync(casePath(root, c.id))) throw new CaseError(`找不到 case: ${c.id}`);
  const current = loadCase(root, c.id, project);
  if (replaySignature(current) !== replaySignature(c)) {
    if (current.status === "stable") c.status = "draft";
    c.updatedAt = new Date(
      Math.max(Date.now(), Date.parse(current.updatedAt), Date.parse(c.updatedAt)) + 1,
    ).toISOString();
  }
  validateCase(c, project);
  writeYamlFile(casePath(root, c.id), c);
  return c;
}

export function saveCase(root: string, c: TestCase): void {
  validateCase(c);
  writeYamlFile(casePath(root, c.id), c);
}

function caseSurfaces(c: TestCase): SurfaceName[] {
  return [
    c.surface,
    ...(c.pre ?? []).map((item) => item.surface ?? c.surface),
    ...c.steps.map((item) => item.surface ?? c.surface),
    ...(c.assert ?? []).map((item) => item.surface ?? c.surface),
  ];
}

function replaySignature(c: TestCase): string {
  return JSON.stringify({
    surface: c.surface,
    risk: c.risk ?? "normal",
    pre: c.pre ?? [],
    steps: c.steps,
    assert: c.assert ?? [],
  });
}

function hasSuccessfulRun(root: string, id: string, updatedAt: string): boolean {
  if (!existsSync(runsDir(root))) return false;
  return readdirSync(runsDir(root)).some((name) => {
    if (!isRunDirName(name)) return false;
    try {
      const run = loadRun(root, name);
      return (
        run.finishedAt !== null &&
        run.finishedAt >= updatedAt &&
        run.cases.some((entry) => entry.id === id && entry.status === "passed")
      );
    } catch {
      return false;
    }
  });
}

export function writeCaseMdStub(root: string, id: string, title: string): void {
  const p = join(casesDir(root), `${id}.md`);
  if (existsSync(p)) return;
  writeFileSync(p, `# ${title}\n\n业务背景与已知坑（不参与重放）。\n`);
}
