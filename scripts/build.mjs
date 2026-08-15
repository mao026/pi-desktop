#!/usr/bin/env node
import { spawnSync } from "child_process";
import { rmSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync(path.join(root, "out", "main"), { recursive: true, force: true });
run("npx", ["tsup", "--config", "tsup.config.ts"]);
run("npx", ["vite", "build", "--config", "vite.config.ts"]);
console.log("[build] done → out/");
