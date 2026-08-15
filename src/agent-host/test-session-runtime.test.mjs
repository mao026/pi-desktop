import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..", "..");

async function loadRpcManager() {
  const outputDirectory = path.join(root, ".artifacts", "test-modules");
  mkdirSync(outputDirectory, { recursive: true });
  const outputFile = path.join(outputDirectory, `test-session-runtime-${process.pid}.mjs`);
  await build({
    absWorkingDir: root,
    entryPoints: ["src/agent-host/rpc-manager.ts"],
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    sourcemap: false,
    logLevel: "silent",
  });
  return import(`${pathToFileURL(outputFile).href}?v=${Date.now()}`);
}

test("test session loads only fixed pi-test tools and workflows without coding or Browser tools", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-test-runtime-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(base, "sessions");
  process.env.PI_OFFLINE = "1";

  const { startRpcSession } = await loadRpcManager();
  const authorize = async (projectRoot) => assert.equal(projectRoot, root);
  const { session } = await startRpcSession("__test__", "", root, undefined, "test", authorize);
  t.after(() => session.destroy());

  const commands = await session.send({ type: "get_commands" });
  const tools = await session.send({ type: "get_tools" });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["test_setup", "test_run", "test_observe", "test_act", "test_map", "test_case", "test_play", "test_finding"],
  );
  assert.equal(
    tools.every((tool) => tool.active),
    true,
  );
  assert.deepEqual(
    commands.commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name)
      .sort(),
    ["skill:test-explore", "skill:test-mobile", "skill:test-web"],
  );
  assert.equal(
    commands.commands.some((command) => command.source !== "skill"),
    false,
  );

  await session.send({ type: "set_tools", toolNames: ["bash", "read"] });
  assert.deepEqual(
    (await session.send({ type: "get_tools" })).map((tool) => tool.name),
    ["test_setup", "test_run", "test_observe", "test_act", "test_map", "test_case", "test_play", "test_finding"],
  );
  await session.send({ type: "reload" });
  assert.deepEqual(
    (await session.send({ type: "get_tools" })).map((tool) => tool.name),
    ["test_setup", "test_run", "test_observe", "test_act", "test_map", "test_case", "test_play", "test_finding"],
  );
  await assert.rejects(session.send({ type: "fork", entryId: "anything" }), /测试会话不允许分叉/);

  const sessionFile = session.sessionFile;
  const sessionId = session.sessionId;
  assert.equal(
    session.inner.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-test-session"),
    true,
    `in-memory entries: ${JSON.stringify(session.inner.sessionManager.getEntries())}`,
  );
  session.inner.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "runtime check" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  assert.match(readFileSync(sessionFile, "utf8"), /"customType":"pi-test-session"/);
  const persisted = SessionManager.open(sessionFile);
  assert.equal(
    persisted.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-test-session"),
    true,
  );

  session.destroy();
  const reopened = await startRpcSession(sessionId, sessionFile, root, undefined, "general", authorize);
  assert.equal(reopened.session.sessionMode, "test");
  assert.deepEqual(
    (await reopened.session.send({ type: "get_tools" })).map((tool) => tool.name),
    ["test_setup", "test_run", "test_observe", "test_act", "test_map", "test_case", "test_play", "test_finding"],
  );
  reopened.session.destroy();
});
