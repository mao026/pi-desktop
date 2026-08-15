import { join } from "node:path";

export const PROJECT_FILE = "project.yaml";
export const MAP_FILE = "map.md";
export const PI_TEST_DIR = ".pi-test";
export const ACTIVE_RUN_FILE = "active-run";
export const SECRETS_DIR = ".secrets";
export const INPUTS_FILE = "inputs.yaml";

const CASE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const RUN_DIR_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+){0,8}$/;

function safeSegment(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value) || value.length > 80) throw new Error(`${label} 不合法`);
  return value;
}

export function isRunDirName(value: string): boolean {
  return value.length <= 80 && RUN_DIR_RE.test(value);
}

export function projectPath(root: string): string {
  return join(root, PROJECT_FILE);
}

export function mapPath(root: string): string {
  return join(root, MAP_FILE);
}

export function casesDir(root: string): string {
  return join(root, "cases");
}

export function runsDir(root: string): string {
  return join(root, "runs");
}

export function findingsDir(root: string): string {
  return join(root, "findings");
}

export function piTestDir(root: string): string {
  return join(root, PI_TEST_DIR);
}

export function activeRunPath(root: string): string {
  return join(root, PI_TEST_DIR, ACTIVE_RUN_FILE);
}

export function secretsInputsPath(root: string): string {
  return join(root, SECRETS_DIR, INPUTS_FILE);
}

export function runDir(root: string, name: string): string {
  return join(root, "runs", safeSegment(name, RUN_DIR_RE, "run 目录名"));
}

export function runYamlPath(root: string, name: string): string {
  return join(root, "runs", safeSegment(name, RUN_DIR_RE, "run 目录名"), "run.yaml");
}

export function runEvidenceDir(root: string, name: string): string {
  return join(root, "runs", safeSegment(name, RUN_DIR_RE, "run 目录名"), "evidence");
}

export function casePath(root: string, id: string): string {
  return join(root, "cases", `${safeSegment(id, CASE_ID_RE, "case id")}.yaml`);
}
