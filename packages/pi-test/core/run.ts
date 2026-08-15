import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { activeRunPath, isRunDirName, piTestDir, runDir, runEvidenceDir, runYamlPath, runsDir } from "./paths.ts";
import type { Project, SurfaceName } from "./project.ts";
import { localStamp, nowIso } from "./time.ts";
import { readYamlFile, writeYamlFile } from "./yaml.ts";

export type RunStatus = "in_progress" | "passed" | "failed" | "blocked" | "aborted";
export type RunTrigger = "manual" | "regression" | "explore";
export type CaseRunStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "blocked";
export type RunControlState =
  "running" | "pause_requested" | "takeover_requested" | "paused" | "waiting_for_user" | "resuming";
export type RunTakeoverReason = "login" | "verification" | "scan" | "authorization" | "judgment";

export interface RunControl {
  state: RunControlState;
  surface: SurfaceName | null;
  takeoverReason: RunTakeoverReason | null;
  sensitive: boolean;
  updatedAt: string;
  businessWriteConfirmedSurfaces: SurfaceName[];
}

export interface RunCaseEntry {
  id: string;
  status: CaseRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  evidence: string[];
}

export interface RunJournalEntry {
  at: string;
  surface?: SurfaceName | string | null;
  kind: "step" | "observe" | "ask" | "confirm" | "error";
  summary: string;
  evidence: string[];
}

export interface RunDoc {
  schemaVersion: 1;
  id: string;
  projectId: string;
  status: RunStatus;
  trigger: RunTrigger;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  title: string;
  note: string | null;
  cases: RunCaseEntry[];
  env: {
    surfaces: string[];
    browser: string | null;
    deviceSerial: string | null;
    deviceModel: string | null;
    toolVersions: Record<string, string | null>;
  };
  journal: RunJournalEntry[];
  control?: RunControl;
  findings: string[];
  summary: {
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    text: string | null;
  };
}

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunError";
  }
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+){0,7}$/;
const FINAL: RunStatus[] = ["passed", "failed", "blocked", "aborted"];

export function runControl(doc: RunDoc): RunControl {
  if (!doc.control) {
    return {
      state: "running",
      surface: null,
      takeoverReason: null,
      sensitive: false,
      updatedAt: doc.startedAt,
      businessWriteConfirmedSurfaces: [],
    };
  }
  const control = doc.control;
  if (
    !["running", "pause_requested", "takeover_requested", "paused", "waiting_for_user", "resuming"].includes(
      control.state,
    ) ||
    (control.surface !== null && !["h5", "admin", "app", "miniprogram"].includes(control.surface)) ||
    (control.takeoverReason !== null &&
      !["login", "verification", "scan", "authorization", "judgment"].includes(control.takeoverReason)) ||
    typeof control.sensitive !== "boolean" ||
    typeof control.updatedAt !== "string" ||
    !control.updatedAt.endsWith("Z") ||
    !Array.isArray(control.businessWriteConfirmedSurfaces) ||
    control.businessWriteConfirmedSurfaces.some((surface) => !["h5", "admin", "app", "miniprogram"].includes(surface))
  ) {
    throw new RunError("run control 状态无效");
  }
  return control;
}

export function readActiveRunName(root: string): string | null {
  const p = activeRunPath(root);
  if (!existsSync(p)) return null;
  const name = readFileSync(p, "utf8").trim();
  if (!isRunDirName(name)) {
    clearActiveRun(root);
    return null;
  }
  return name;
}

export function clearActiveRun(root: string): void {
  const p = activeRunPath(root);
  if (existsSync(p)) unlinkSync(p);
}

export function writeActiveRun(root: string, dirName: string): void {
  if (!isRunDirName(dirName)) throw new RunError("run 目录名不合法");
  mkdirSync(piTestDir(root), { recursive: true });
  writeFileSync(activeRunPath(root), `${dirName}\n`);
}

export function loadRun(root: string, dirName: string): RunDoc {
  const path = runYamlPath(root, dirName);
  if (!existsSync(path)) throw new RunError(`找不到 run: ${dirName}`);
  return readYamlFile<RunDoc>(path);
}

export function saveRun(root: string, dirName: string, doc: RunDoc): void {
  writeYamlFile(runYamlPath(root, dirName), doc);
}

/** Clear stale active-run pointer; abort leftover in_progress run if needed. */
export function reconcileActiveRun(root: string): { cleaned: boolean; aborted?: string } {
  const name = readActiveRunName(root);
  if (!name) return { cleaned: false };
  const yaml = runYamlPath(root, name);
  if (!existsSync(yaml)) {
    clearActiveRun(root);
    return { cleaned: true };
  }
  const doc = loadRun(root, name);
  if (FINAL.includes(doc.status)) {
    clearActiveRun(root);
    return { cleaned: true };
  }
  return { cleaned: false };
}

export function abortStaleRun(root: string): string | null {
  const name = readActiveRunName(root);
  if (!name) return null;
  const yaml = runYamlPath(root, name);
  if (!existsSync(yaml)) {
    clearActiveRun(root);
    return name;
  }
  const doc = loadRun(root, name);
  if (doc.status === "in_progress") {
    doc.status = "aborted";
    doc.finishedAt = nowIso();
    doc.summary.text = "crash/stale active-run";
    saveRun(root, name, doc);
  }
  clearActiveRun(root);
  return name;
}

function uniqueRunDir(root: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new RunError("slug 不合法");
  mkdirSync(runsDir(root), { recursive: true });
  const base = `${localStamp()}-${slug}`;
  if (base.length > 80) throw new RunError("run 目录名过长");
  let name = base;
  let n = 2;
  while (existsSync(runDir(root, name))) {
    name = `${base}-${n}`;
    n += 1;
    if (name.length > 80) throw new RunError("run 目录名过长");
  }
  return name;
}

export interface StartRunOpts {
  title: string;
  slug: string;
  trigger?: RunTrigger;
  caseIds?: string[];
  note?: string;
  businessWriteConfirmedSurfaces?: SurfaceName[];
}

export function startRun(root: string, project: Project, opts: StartRunOpts): { dirName: string; doc: RunDoc } {
  const rec = reconcileActiveRun(root);
  if (readActiveRunName(root)) {
    throw new RunError(`已有进行中的 run（${readActiveRunName(root)}）。先 finish 或 aborted。`);
  }
  // if pointer cleaned but in_progress files exist — ignore unless pointer set

  const dirName = uniqueRunDir(root, opts.slug);
  const t = nowIso();
  const cases: RunCaseEntry[] = (opts.caseIds ?? []).map((id) => ({
    id,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    error: null,
    evidence: [],
  }));

  const surfaces = Object.keys(project.surfaces).filter((k) => project.surfaces[k as SurfaceName]);
  const doc: RunDoc = {
    schemaVersion: 1,
    id: `run-${dirName}`,
    projectId: project.id,
    status: "in_progress",
    trigger: opts.trigger ?? "manual",
    createdAt: t,
    startedAt: t,
    finishedAt: null,
    title: opts.title,
    note: opts.note ?? null,
    cases,
    env: {
      surfaces,
      browser: surfaces.some((s) => s === "h5" || s === "admin") ? "chrome+agent-browser-cli" : null,
      deviceSerial: project.surfaces.app?.serial ?? null,
      deviceModel: null,
      toolVersions: {
        "agent-browser-cli": null,
        hs: null,
      },
    },
    journal: [],
    control: {
      state: "running",
      surface: null,
      takeoverReason: null,
      sensitive: false,
      updatedAt: t,
      businessWriteConfirmedSurfaces: [...new Set(opts.businessWriteConfirmedSurfaces ?? [])],
    },
    findings: [],
    summary: { passed: 0, failed: 0, blocked: 0, skipped: 0, text: null },
  };

  mkdirSync(runEvidenceDir(root, dirName), { recursive: true });
  saveRun(root, dirName, doc);
  writeActiveRun(root, dirName);
  if (rec.cleaned) {
    /* pointer was stale; already cleared */
  }
  return { dirName, doc };
}

export interface FinishRunOpts {
  /** 省略则按 cases 推导：failed>blocked>passed */
  status?: Exclude<RunStatus, "in_progress">;
  text?: string;
}

export function finishRun(root: string, opts: FinishRunOpts = {}): { dirName: string; doc: RunDoc } {
  const dirName = readActiveRunName(root);
  if (!dirName) throw new RunError("没有进行中的 run，先 start");
  const doc = loadRun(root, dirName);
  if (doc.status !== "in_progress") {
    clearActiveRun(root);
    throw new RunError(`run 已是终态 ${doc.status}`);
  }

  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const c of doc.cases) {
    if (c.status === "passed") counts.passed++;
    else if (c.status === "failed") counts.failed++;
    else if (c.status === "blocked") counts.blocked++;
    else if (c.status === "skipped") counts.skipped++;
    else if (c.status === "pending" || c.status === "running") {
      c.status = "skipped";
      c.finishedAt = nowIso();
      counts.skipped++;
    }
  }

  let status = opts.status;
  if (!status) {
    if (counts.failed > 0) status = "failed";
    else if (counts.blocked > 0) status = "blocked";
    else status = "passed";
  }

  doc.status = status;
  doc.finishedAt = nowIso();
  doc.summary = { ...counts, text: opts.text ?? null };
  saveRun(root, dirName, doc);
  clearActiveRun(root);
  return { dirName, doc };
}

export function updateRunControl(
  root: string,
  patch: Partial<Omit<RunControl, "businessWriteConfirmedSurfaces">> & {
    confirmBusinessWriteSurface?: SurfaceName;
  },
): { dirName: string; doc: RunDoc } {
  const active = requireActiveRun(root);
  const current = runControl(active.doc);
  const confirmed = [...current.businessWriteConfirmedSurfaces];
  if (patch.confirmBusinessWriteSurface && !confirmed.includes(patch.confirmBusinessWriteSurface)) {
    confirmed.push(patch.confirmBusinessWriteSurface);
  }
  const { confirmBusinessWriteSurface, ...controlPatch } = patch;
  void confirmBusinessWriteSurface;
  active.doc.control = {
    ...current,
    ...controlPatch,
    updatedAt: patch.updatedAt ?? nowIso(),
    businessWriteConfirmedSurfaces: confirmed,
  };
  runControl(active.doc);
  saveRun(root, active.dirName, active.doc);
  return { dirName: active.dirName, doc: active.doc };
}

export function updateRunCase(
  root: string,
  id: string,
  patch: Partial<Omit<RunCaseEntry, "id">>,
): { dirName: string; doc: RunDoc } {
  const active = requireActiveRun(root);
  const entry = active.doc.cases.find((item) => item.id === id);
  if (!entry) throw new RunError(`当前 run 不包含 case: ${id}`);
  Object.assign(entry, patch);
  saveRun(root, active.dirName, active.doc);
  return { dirName: active.dirName, doc: active.doc };
}

export function appendJournal(
  root: string,
  entry: Omit<RunJournalEntry, "at"> & { at?: string },
): { dirName: string; doc: RunDoc } {
  const dirName = readActiveRunName(root);
  if (!dirName) throw new RunError("没有进行中的 run");
  const doc = loadRun(root, dirName);
  doc.journal.push({
    at: entry.at ?? nowIso(),
    surface: entry.surface ?? null,
    kind: entry.kind,
    summary: entry.summary,
    evidence: entry.evidence ?? [],
  });
  saveRun(root, dirName, doc);
  return { dirName, doc };
}

export function requireActiveRun(root: string): { dirName: string; doc: RunDoc; evidenceDir: string } {
  reconcileActiveRun(root);
  const dirName = readActiveRunName(root);
  if (!dirName) throw new RunError("没有进行中的 run。先 test_run start");
  const doc = loadRun(root, dirName);
  if (doc.status !== "in_progress") {
    clearActiveRun(root);
    throw new RunError("active-run 已过期，请重新 start");
  }
  return { dirName, doc, evidenceDir: runEvidenceDir(root, dirName) };
}
