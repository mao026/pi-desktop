import { existsSync } from "node:fs";
import { secretsInputsPath } from "./paths.ts";
import type { Project } from "./project.ts";
import { readYamlFile } from "./yaml.ts";

export class InterpError extends Error {
  readonly missingInputs: string[];

  constructor(message: string, missingInputs: string[] = []) {
    super(message);
    this.name = "InterpError";
    this.missingInputs = missingInputs;
  }
}

export function loadSecrets(root: string): Record<string, string> {
  const p = secretsInputsPath(root);
  if (!existsSync(p)) return {};
  try {
    const raw = readYamlFile<unknown>(p);
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** Resolve {{surfaces.*}} and {{input.*}} in a string. */
export function interpolate(template: string, project: Project, secrets: Record<string, string>): string {
  const missing: string[] = [];
  const out = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key.startsWith("input.")) {
      const name = key.slice("input.".length);
      if (!(name in (project.inputs ?? {}))) {
        throw new InterpError(`未在 project.inputs 声明: ${name}`);
      }
      if (secrets[name] == null || secrets[name] === "") {
        missing.push(name);
        return `{{input.${name}}}`;
      }
      return secrets[name];
    }
    if (key.startsWith("surfaces.")) {
      const parts = key.split(".");
      // surfaces.h5.url | surfaces.app.package
      const surface = parts[1] as keyof Project["surfaces"];
      const field = parts[2];
      const s = project.surfaces[surface] as Record<string, unknown> | undefined;
      if (!s || field == null || s[field] == null) {
        throw new InterpError(`无法解析 ${key}`);
      }
      return String(s[field]);
    }
    throw new InterpError(`未知模板: {{${key}}}`);
  });
  if (missing.length) {
    throw new InterpError(`缺少输入: ${missing.join(", ")}（写入 .secrets/inputs.yaml 或提供）`, missing);
  }
  return out;
}

export function maybeInterp(value: unknown, project: Project, secrets: Record<string, string>): unknown {
  if (typeof value === "string" && value.includes("{{")) return interpolate(value, project, secrets);
  return value;
}
