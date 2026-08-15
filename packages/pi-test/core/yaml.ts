import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

export function readYamlFile<T = unknown>(path: string): T {
  return parse(readFileSync(path, "utf8")) as T;
}

export function writeYamlFile(path: string, data: unknown): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, stringify(data, { lineWidth: 0, defaultStringType: "PLAIN" }), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ACLs are controlled by the containing user directory.
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
