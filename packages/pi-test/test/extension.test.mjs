import assert from "node:assert/strict";
import test from "node:test";
import { createTestExtension, TEST_TOOL_NAMES } from "../extension/index.ts";

function registry() {
  const tools = [];
  createTestExtension(
    async (method, params) => ({ method, params }),
    async () => "分析结果",
  )({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return tools;
}

const context = {
  cwd: "/projects/demo",
  sessionManager: { getSessionId: () => "session-one" },
  model: { input: ["text", "image"] },
};

test("adapter registers only the fixed test tool allowlist", () => {
  const tools = registry();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...TEST_TOOL_NAMES],
  );
  for (const forbidden of ["bash", "read", "write", "edit", "git", "browser_open"]) {
    assert.equal(
      tools.some((tool) => tool.name === forbidden),
      false,
    );
  }
});

test("visual observe uses the project visual model analyzer and keeps base64 out of details", async () => {
  let calls = 0;
  let analyzed = null;
  const tools = [];
  createTestExtension(
    async () => {
      calls += 1;
      return {
        surface: "h5",
        mode: "visual",
        text: "检查明显视觉异常",
        progress: [],
        truncated: false,
        evidence: "runs/run/evidence/visual.png",
        image: { mimeType: "image/png", data: "cG5n" },
        visualModel: { provider: "qwen", modelId: "qwen-vl" },
      };
    },
    async (input) => {
      analyzed = input;
      return "发现提交按钮被底部导航遮挡";
    },
  )({ registerTool: (tool) => tools.push(tool) });
  const observe = tools.find((tool) => tool.name === "test_observe");
  const visual = await observe.execute("call", { surface: "h5", mode: "visual" }, undefined, undefined, context);
  assert.equal(calls, 1);
  assert.equal(visual.content[0].type, "text");
  assert.match(visual.content[0].text, /qwen\/qwen-vl/);
  assert.match(visual.content[0].text, /提交按钮被底部导航遮挡/);
  assert.equal(
    visual.content.some((block) => block.type === "image"),
    false,
  );
  assert.equal("image" in visual.details, false);
  assert.deepEqual(visual.details.visualModel, { provider: "qwen", modelId: "qwen-vl" });
  assert.deepEqual(analyzed.image, { mimeType: "image/png", data: "cG5n" });
});

test("adapter injects project and session identity from trusted extension context", async () => {
  const tools = registry();
  const setup = tools.find((tool) => tool.name === "test_setup");
  const run = tools.find((tool) => tool.name === "test_run");
  const observe = tools.find((tool) => tool.name === "test_observe");
  const act = tools.find((tool) => tool.name === "test_act");
  const map = tools.find((tool) => tool.name === "test_map");
  const cases = tools.find((tool) => tool.name === "test_case");
  const findings = tools.find((tool) => tool.name === "test_finding");
  const play = tools.find((tool) => tool.name === "test_play");
  const setupResult = await setup.execute("call", {}, undefined, undefined, context);
  const runResult = await run.execute("call", { action: "status" }, undefined, undefined, context);
  const takeoverResult = await run.execute(
    "call",
    { action: "takeover", surface: "app", reason: "verification", sensitive: true },
    undefined,
    undefined,
    context,
  );
  const observeResult = await observe.execute("call", { surface: "h5", mode: "text" }, undefined, undefined, context);
  const actResult = await act.execute(
    "call",
    { surface: "h5", risk: "read", action: { type: "open" } },
    undefined,
    undefined,
    context,
  );
  const mapResult = await map.execute("call", { action: "read" }, undefined, undefined, context);
  const caseResult = await cases.execute("call", { action: "list" }, undefined, undefined, context);
  const findingResult = await findings.execute("call", { action: "list" }, undefined, undefined, context);
  const playResult = await play.execute(
    "call",
    { action: "run", caseIds: ["smoke-h5"], title: "回归", slug: "regression" },
    undefined,
    undefined,
    context,
  );

  for (const [details, method] of [
    [setupResult.details, "test.setup"],
    [runResult.details, "test.run"],
    [takeoverResult.details, "test.run"],
    [observeResult.details, "test.observe"],
    [actResult.details, "test.act"],
    [mapResult.details, "test.map"],
    [caseResult.details, "test.case"],
    [findingResult.details, "test.finding"],
    [playResult.details, "test.play"],
  ]) {
    assert.equal(details.method, method);
    assert.equal(details.params.projectRoot, "/projects/demo");
    assert.equal(details.params.sessionId, "session-one");
    assert.equal("profileId" in details.params, false);
    assert.equal("tabId" in details.params, false);
  }
});
