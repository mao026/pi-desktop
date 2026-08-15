import assert from "node:assert/strict";
import test from "node:test";
import { runProbeCommand } from "./process-runner.ts";

test("runs a probe with argv and stdin without invoking a shell", async () => {
  const result = await runProbeCommand({
    executable: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    input: "路径 with spaces ; $(ignored)",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "路径 with spaces ; $(ignored)");
  assert.equal(result.timedOut, false);
});

test("bounds stdout and terminates a noisy probe", async () => {
  const result = await runProbeCommand({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"],
    outputLimitBytes: 128,
    timeoutMs: 2_000,
  });

  assert.equal(result.outputLimitExceeded, true);
  assert.equal(Buffer.byteLength(result.stdout), 128);
});

test("times out a stalled probe", async () => {
  const result = await runProbeCommand({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 30,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("timeout resolves when a descendant keeps the output pipes open", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "setTimeout(() => {}, 1500)"], {
      detached: true,
      stdio: ["ignore", process.stdout, process.stderr],
    });
    child.unref();
    setInterval(() => {}, 1000);
  `;
  const result = await runProbeCommand({
    executable: process.execPath,
    args: ["-e", script],
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 500, `probe took ${result.durationMs}ms`);
});
