import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { findingsDir } from "./paths.ts";
import type { Project, SurfaceName } from "./project.ts";
import { loadRun, readActiveRunName, requireActiveRun, saveRun } from "./run.ts";
import { nowIso } from "./time.ts";
import { readYamlFile, writeYamlFile } from "./yaml.ts";

export type FindingStatus = "open" | "confirmed" | "fixed" | "wontfix" | "duplicate";
export type FindingSeverity = "p0" | "p1" | "p2" | "p3";
export type FindingConfidence = "suspected" | "observed" | "confirmed";
export type RetestResult = "still_fail" | "passed" | "blocked";
export type FindingRemoteSyncStatus = "unsubmitted" | "submitting" | "submitted" | "failed" | "remote_closed";

export interface FindingRemote {
  provider: "zentao";
  connectionId: string;
  marker: string;
  syncStatus: FindingRemoteSyncStatus;
  bugId?: number | null;
  url?: string | null;
  status?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface FindingRetest {
  at: string;
  runId: string;
  result: RetestResult;
  note?: string | null;
  evidence?: string[];
}

export interface Finding {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  status: FindingStatus;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  surface: SurfaceName;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  caseId?: string | null;
  duplicateOf?: string | null;
  summary: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  evidence: string[];
  env?: { note?: string };
  tags?: string[];
  retests: FindingRetest[];
  remote?: FindingRemote | null;
}

export class FindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingError";
  }
}

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const TOP = new Set([
  "schemaVersion",
  "id",
  "projectId",
  "title",
  "status",
  "severity",
  "confidence",
  "surface",
  "createdAt",
  "updatedAt",
  "runIds",
  "caseId",
  "duplicateOf",
  "summary",
  "stepsToReproduce",
  "expected",
  "actual",
  "evidence",
  "env",
  "tags",
  "retests",
  "remote",
]);

function findingPath(root: string, id: string): string {
  if (!ID_RE.test(id)) throw new FindingError("finding id 不合法");
  return join(findingsDir(root), `${id}.yaml`);
}

function isProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function validateFinding(raw: unknown, project?: Project): Finding {
  if (!raw || typeof raw !== "object") throw new FindingError("finding 不是对象");
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !TOP.has(k));
  if (unknown.length) throw new FindingError(`未知字段: ${unknown.join(", ")}`);
  if (o.schemaVersion !== 1) throw new FindingError("schemaVersion 必须是 1");
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new FindingError("id 不合法");
  if (typeof o.projectId !== "string") throw new FindingError("projectId 必填");
  if (project && o.projectId !== project.id) throw new FindingError("projectId 与项目不一致");
  if (typeof o.title !== "string" || o.title.length < 1 || o.title.length > 120) {
    throw new FindingError("title 不合法");
  }
  const statuses = ["open", "confirmed", "fixed", "wontfix", "duplicate"];
  if (!statuses.includes(o.status as string)) throw new FindingError("status 无效");
  if (!["h5", "admin", "app", "miniprogram"].includes(o.surface as string)) {
    throw new FindingError("surface 无效");
  }
  if (project && !project.surfaces[o.surface as SurfaceName]) {
    throw new FindingError(`project 无 surface: ${String(o.surface)}`);
  }
  if (!["p0", "p1", "p2", "p3"].includes(o.severity as string)) throw new FindingError("severity 无效");
  if (!["suspected", "observed", "confirmed"].includes(o.confidence as string)) {
    throw new FindingError("confidence 无效");
  }
  if (o.status === "confirmed" && o.confidence !== "confirmed") {
    throw new FindingError("status=confirmed 时 confidence 必须为 confirmed");
  }
  if (o.status === "duplicate") {
    if (!o.duplicateOf || o.duplicateOf === o.id) throw new FindingError("duplicate 需要有效 duplicateOf");
  }
  if (!Array.isArray(o.runIds) || o.runIds.length < 1) throw new FindingError("runIds 至少 1 个");
  if (!Array.isArray(o.stepsToReproduce) || o.stepsToReproduce.length < 1) {
    throw new FindingError("stepsToReproduce 至少 1 条");
  }
  if (!Array.isArray(o.evidence) || o.evidence.length < 1) throw new FindingError("evidence 至少 1 条");
  for (const e of o.evidence as string[]) {
    if (!isProjectRelativePath(e)) throw new FindingError("evidence 必须是项目内 POSIX 相对路径");
  }
  if (typeof o.summary !== "string" || typeof o.expected !== "string" || typeof o.actual !== "string") {
    throw new FindingError("summary/expected/actual 必填");
  }
  if (o.retests != null && !Array.isArray(o.retests)) throw new FindingError("retests 必须是数组");
  if (o.remote != null) {
    if (typeof o.remote !== "object" || Array.isArray(o.remote)) throw new FindingError("remote 必须是对象");
    const remote = o.remote as Record<string, unknown>;
    const unknownRemote = Object.keys(remote).filter(
      (key) =>
        ![
          "provider",
          "connectionId",
          "marker",
          "syncStatus",
          "bugId",
          "url",
          "status",
          "lastSyncedAt",
          "lastError",
        ].includes(key),
    );
    if (unknownRemote.length) throw new FindingError(`remote 未知字段: ${unknownRemote.join(", ")}`);
    if (remote.provider !== "zentao") throw new FindingError("remote.provider 无效");
    if (typeof remote.connectionId !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(remote.connectionId)) {
      throw new FindingError("remote.connectionId 无效");
    }
    if (
      typeof remote.marker !== "string" ||
      remote.marker.length > 160 ||
      remote.marker !== `Pi-Test: ${String(o.projectId)}/${String(o.id)}`
    ) {
      throw new FindingError("remote.marker 无效");
    }
    if (!["unsubmitted", "submitting", "submitted", "failed", "remote_closed"].includes(remote.syncStatus as string)) {
      throw new FindingError("remote.syncStatus 无效");
    }
    if (remote.bugId != null && (!Number.isSafeInteger(remote.bugId) || (remote.bugId as number) < 1)) {
      throw new FindingError("remote.bugId 无效");
    }
    if (remote.url != null) {
      if (typeof remote.url !== "string" || remote.url.length > 2_048) throw new FindingError("remote.url 无效");
      try {
        const url = new URL(remote.url);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
      } catch {
        throw new FindingError("remote.url 无效");
      }
    }
    for (const key of ["status", "lastError"] as const) {
      const value = remote[key];
      if (value != null && (typeof value !== "string" || value.length > 1_000 || /\0/.test(value))) {
        throw new FindingError(`remote.${key} 无效`);
      }
    }
    if (
      remote.lastSyncedAt != null &&
      (typeof remote.lastSyncedAt !== "string" ||
        !remote.lastSyncedAt.endsWith("Z") ||
        !Number.isFinite(Date.parse(remote.lastSyncedAt)))
    ) {
      throw new FindingError("remote.lastSyncedAt 无效");
    }
  }
  if (o.status === "fixed") {
    const retests = (o.retests as FindingRetest[]) ?? [];
    if (!retests.some((r) => r.result === "passed")) {
      throw new FindingError("status=fixed 需要至少一条 retest passed");
    }
  }
  return o as unknown as Finding;
}

export function loadFinding(root: string, id: string, project?: Project): Finding {
  const path = findingPath(root, id);
  if (!existsSync(path)) throw new FindingError(`找不到 finding: ${id}`);
  const f = validateFinding(readYamlFile(path), project);
  if (f.id !== id) throw new FindingError("文件名与 id 不一致");
  return f;
}

export function listFindings(root: string): { id: string; status: string; title: string; severity: string }[] {
  const dir = findingsDir(root);
  if (!existsSync(dir)) return [];
  const out: { id: string; status: string; title: string; severity: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml")) continue;
    const id = basename(f, ".yaml");
    try {
      const doc = loadFinding(root, id);
      out.push({ id: doc.id, status: doc.status, title: doc.title, severity: doc.severity });
    } catch {
      out.push({ id, status: "?", title: "(invalid)", severity: "?" });
    }
  }
  return out;
}

export interface CreateFindingOpts {
  id: string;
  title: string;
  summary: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  evidence: string[];
  surface: SurfaceName;
  severity?: FindingSeverity;
  confidence?: FindingConfidence;
  caseId?: string | null;
  envNote?: string;
  tags?: string[];
}

export function createFinding(root: string, project: Project, opts: CreateFindingOpts): Finding {
  const { doc } = requireActiveRun(root);
  const t = nowIso();
  const f: Finding = {
    schemaVersion: 1,
    id: opts.id,
    projectId: project.id,
    title: opts.title,
    status: "open",
    severity: opts.severity ?? "p2",
    confidence: opts.confidence ?? "observed",
    surface: opts.surface,
    createdAt: t,
    updatedAt: t,
    runIds: [doc.id],
    caseId: opts.caseId ?? null,
    duplicateOf: null,
    summary: opts.summary,
    stepsToReproduce: opts.stepsToReproduce,
    expected: opts.expected,
    actual: opts.actual,
    evidence: opts.evidence,
    env: opts.envNote ? { note: opts.envNote } : undefined,
    tags: opts.tags ?? [],
    retests: [],
  };
  validateFinding(f, project);
  if (existsSync(findingPath(root, f.id))) throw new FindingError(`finding 已存在: ${f.id}`);
  writeYamlFile(findingPath(root, f.id), f);

  // link into active run
  const dirName = readActiveRunName(root)!;
  const run = loadRun(root, dirName);
  if (!run.findings.includes(f.id)) {
    run.findings.push(f.id);
    saveRun(root, dirName, run);
  }
  return f;
}

export function addRetest(
  root: string,
  project: Project,
  id: string,
  opts: { result: RetestResult; note?: string; evidence?: string[] },
): Finding {
  const f = loadFinding(root, id, project);
  const { doc } = requireActiveRun(root);
  f.retests.push({
    at: nowIso(),
    runId: doc.id,
    result: opts.result,
    note: opts.note ?? null,
    evidence: opts.evidence ?? [],
  });
  if (!f.runIds.includes(doc.id)) f.runIds.push(doc.id);
  if (opts.result === "passed") {
    // leave status to setStatus; just update time
  } else if (opts.result === "still_fail" && f.status === "fixed") {
    f.status = "open";
  }
  f.updatedAt = nowIso();
  validateFinding(f, project);
  writeYamlFile(findingPath(root, id), f);

  const dirName = readActiveRunName(root)!;
  const run = loadRun(root, dirName);
  if (!run.findings.includes(id)) {
    run.findings.push(id);
    saveRun(root, dirName, run);
  }
  return f;
}

export function setFindingRemote(root: string, project: Project, id: string, remote: FindingRemote): Finding {
  const finding = loadFinding(root, id, project);
  finding.remote = remote;
  finding.updatedAt = nowIso();
  validateFinding(finding, project);
  writeYamlFile(findingPath(root, id), finding);
  return finding;
}

export function setFindingStatus(
  root: string,
  project: Project,
  id: string,
  status: FindingStatus,
  opts?: { duplicateOf?: string; confidence?: FindingConfidence },
): Finding {
  const f = loadFinding(root, id, project);
  f.status = status;
  if (status === "confirmed") f.confidence = "confirmed";
  if (opts?.confidence) f.confidence = opts.confidence;
  if (status === "duplicate") f.duplicateOf = opts?.duplicateOf ?? f.duplicateOf;
  f.updatedAt = nowIso();
  validateFinding(f, project);
  writeYamlFile(findingPath(root, id), f);
  return f;
}
