import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { secretsInputsPath } from "./paths.ts";
import type { Project } from "./project.ts";
import { loadSecrets } from "./interp.ts";
import { readYamlFile, writeYamlFile } from "./yaml.ts";

export interface SecretStatus {
  key: string;
  description: string;
  secret: boolean;
  present: boolean;
  /** masked preview if present and secret */
  preview: string | null;
}

function mask(v: string): string {
  if (v.length <= 2) return "**";
  if (v.length <= 4) return v[0] + "***";
  return v.slice(0, 2) + "***" + v.slice(-1);
}

export function listSecretStatus(root: string, project: Project): SecretStatus[] {
  const secrets = loadSecrets(root);
  const decls = project.inputs ?? {};
  return Object.entries(decls).map(([key, d]) => {
    const present = secrets[key] != null && secrets[key] !== "";
    const isSecret = d.secret !== false;
    return {
      key,
      description: d.description ?? "",
      secret: isSecret,
      present,
      preview: present ? (isSecret ? mask(secrets[key]) : secrets[key]) : null,
    };
  });
}

export function missingSecrets(root: string, project: Project, keys?: string[]): string[] {
  const secrets = loadSecrets(root);
  const want = keys ?? Object.keys(project.inputs ?? {});
  return want.filter((k) => {
    if (!(k in (project.inputs ?? {}))) return false;
    return secrets[k] == null || secrets[k] === "";
  });
}

/** Set one or more input values into .secrets/inputs.yaml */
export function setSecrets(root: string, project: Project, values: Record<string, string>): void {
  const decls = project.inputs ?? {};
  for (const k of Object.keys(values)) {
    if (!(k in decls)) throw new Error(`未在 project.inputs 声明: ${k}`);
  }
  const path = secretsInputsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const cur = existsSync(path) ? (readYamlFile<Record<string, unknown>>(path) ?? {}) : {};
  if (typeof cur !== "object" || cur == null) {
    writeYamlFile(path, values);
    return;
  }
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(cur)) {
    if (v != null) next[k] = String(v);
  }
  for (const [k, v] of Object.entries(values)) next[k] = v;
  writeYamlFile(path, next);
}

export function ensureSecretsFile(root: string): void {
  const path = secretsInputsPath(root);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# {{input.*}} — do not commit\n");
}
