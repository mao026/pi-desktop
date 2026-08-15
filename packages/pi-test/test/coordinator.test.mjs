import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCase, loadCase, setCaseStatus } from "../core/case.ts";
import { loadFinding } from "../core/finding.ts";
import { readMap } from "../core/map.ts";
import { createProject, updateAppSurface, updateProjectConfiguration } from "../core/project.ts";
import {
  AgentBrowserCliDriver,
  MainTestCoordinator,
  TestCoordinatorError,
  resolveTestBrowserCliPath,
} from "../../../src/main/test-coordinator.ts";

function fixture(t, environment = "test") {
  const root = mkdtempSync(path.join(tmpdir(), "pi-test-coordinator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createProject(root, {
    id: "demo",
    name: "Demo",
    environment,
    h5Url: "https://example.com/",
  });
  return root;
}

function request(root, extra = {}) {
  return { projectRoot: root, projectId: "demo", sessionId: "session-one", ...extra };
}

test("Main coordinator owns run, binding, readiness, risk and production gates", async (t) => {
  const root = fixture(t);
  const calls = [];
  const confirmed = new Set();
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: ({ confirmationId }) => confirmed.has(confirmationId),
    browser: {
      async observe(input) {
        calls.push(["observe", input]);
        return { text: "首页", truncated: false };
      },
      async open(input) {
        calls.push(["open", input]);
        return { tabId: "tab-two" };
      },
      async click(input) {
        calls.push(["click", input]);
      },
      async fill(input) {
        calls.push(["fill", input]);
      },
    },
  });

  const started = await coordinator.call(
    "test.run",
    request(root, {
      action: "start",
      title: "冒烟",
      slug: "smoke",
      trigger: "manual",
    }),
  );
  assert.equal(started.run.status, "in_progress");

  const opened = await coordinator.call(
    "test.act",
    request(root, {
      surface: "h5",
      risk: "read",
      action: { type: "open" },
    }),
  );
  assert.equal(opened.tabId, "tab-two");
  assert.equal(opened.progress[0].message, "正在打开页面");
  assert.deepEqual(calls[0][1], {
    url: "https://example.com/",
    profileId: "profile-one",
    viewport: "390x844",
    mobile: true,
  });

  const observed = await coordinator.call(
    "test.observe",
    request(root, {
      surface: "h5",
      mode: "text",
    }),
  );
  assert.equal(observed.text, "首页");
  assert.deepEqual(calls[1][1], {
    profileId: "profile-one",
    tabId: "tab-one",
    mode: "text",
    limit: 200,
  });

  await coordinator.call(
    "test.act",
    request(root, {
      surface: "h5",
      risk: "read",
      action: { type: "click", target: "查看详情" },
    }),
  );
  await assert.rejects(
    coordinator.call(
      "test.act",
      request(root, {
        surface: "h5",
        risk: "read",
        action: { type: "click", target: "提交订单" },
      }),
    ),
    (error) => error.code === "RISK_UNDERSTATED",
  );
  await coordinator.call(
    "test.act",
    request(root, {
      surface: "h5",
      risk: "read",
      action: { type: "fill", target: "搜索", value: "订单" },
    }),
  );
  await assert.rejects(
    coordinator.call(
      "test.act",
      request(root, {
        surface: "h5",
        risk: "business_write",
        action: { type: "fill", target: "备注", value: "订单" },
      }),
    ),
    (error) => error.code === "RUN_SCOPE_CONFIRMATION_REQUIRED",
  );

  confirmed.add("confirm-one");
  await assert.rejects(
    coordinator.call(
      "test.act",
      request(root, {
        surface: "h5",
        risk: "business_write",
        confirmationId: "confirm-one",
        action: { type: "fill", target: "备注", value: "订单" },
      }),
    ),
    (error) => error.code === "RUN_SCOPE_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    coordinator.call(
      "test.act",
      request(root, {
        surface: "h5",
        risk: "business_write",
        confirmationId: "confirm-one",
        action: { type: "fill", target: "密码", value: "secret" },
      }),
    ),
    (error) => error.code === "MANUAL_LOGIN_REQUIRED",
  );
  for (const invalid of [
    request(root, { surface: "h5", risk: "read", action: { type: "shell", target: "echo unsafe" } }),
    request(root, { surface: "h5", risk: "read", action: { type: "open", url: "https://evil.example/" } }),
    request(root, { surface: "h5", risk: "read", action: { type: "click", target: 42 } }),
  ]) {
    await assert.rejects(coordinator.call("test.act", invalid), (error) => error.code === "BAD_REQUEST");
  }

  const finished = await coordinator.call("test.run", request(root, { action: "finish", status: "passed" }));
  assert.equal(finished.activeRun, null);
});

test("setup doctor and domain tools stay behind Main authorization, lease, and core validation", async (t) => {
  const root = fixture(t);
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    setupReadiness: (_root, project) => [{ surface: "h5", ready: Boolean(project.surfaces.h5?.url), status: "ok" }],
    validateEvidence: (_root, evidence) => assert.match(evidence, /^runs\//),
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      async observe() {
        return { text: "首页", truncated: false };
      },
      async open() {
        return { tabId: "tab-one" };
      },
      async click() {},
      async fill() {},
    },
  });

  const setup = await coordinator.call("test.setup", request(root));
  assert.equal(setup.surfaces[0].status, "ok");
  assert.equal(setup.activeRun, null);
  assert.match(
    (await coordinator.call("test.map", request(root, { action: "read", section: "modules" }))).sections.modules,
    /待补充/,
  );
  await assert.rejects(
    coordinator.call("test.map", request(root, { action: "update", section: "modules", content: "- 登录" })),
    (error) => error.code === "TEST_LEASE_REQUIRED",
  );

  await coordinator.call("test.run", request(root, { action: "start", title: "探索", slug: "explore" }));
  await assert.rejects(
    coordinator.call("test.map", {
      ...request(root, { action: "update", section: "modules", content: "- 越权" }),
      sessionId: "session-two",
    }),
    (error) => error.code === "TEST_LEASE_REQUIRED",
  );
  await coordinator.call(
    "test.map",
    request(root, { action: "update", section: "modules", content: "- 登录\n- 订单" }),
  );
  assert.match(readMap(root).modules, /订单/);

  const created = await coordinator.call(
    "test.case",
    request(root, {
      action: "create",
      id: "login-h5",
      title: "H5 登录",
      surface: "h5",
      steps: [{ act: "wait", text: "首页" }],
      assert: [{ see: "首页" }],
    }),
  );
  assert.equal(created.case.status, "draft");
  assert.equal(loadCase(root, "login-h5").title, "H5 登录");
  await assert.rejects(
    coordinator.call("test.case", request(root, { action: "set_status", id: "login-h5", status: "stable" })),
    /至少成功运行一次/,
  );

  const finding = await coordinator.call(
    "test.finding",
    request(root, {
      action: "create",
      id: "login-blank",
      title: "登录页空白",
      summary: "登录页主区域为空",
      stepsToReproduce: ["打开 H5"],
      expected: "展示登录表单",
      actual: "主区域为空",
      evidence: ["runs/2026-08-13-1200-explore/evidence/h5.png"],
      surface: "h5",
      severity: "p1",
      caseId: "login-h5",
    }),
  );
  assert.equal(finding.finding.status, "open");
  assert.equal(loadFinding(root, "login-blank").caseId, "login-h5");
});

test("visual observe is opt-in, blocks sensitive pages before screenshot, and returns run evidence", async (t) => {
  const root = fixture(t);
  let text = "Password verification";
  let screenshots = 0;
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      async observe() {
        return { text, truncated: false };
      },
      async open() {
        return { tabId: "tab-one" };
      },
      async click() {},
      async fill() {},
      async currentUrl() {
        return "https://example.com/";
      },
      async screenshot(input) {
        screenshots += 1;
        writeFileSync(input.out, "png");
      },
    },
  });
  const context = { projectRoot: root, projectId: "demo", sessionId: "session-visual" };
  await coordinator.call("test.run", { ...context, action: "start", title: "视觉检查", slug: "visual" });
  await assert.rejects(
    coordinator.call("test.observe", { ...context, surface: "h5", mode: "visual" }),
    (error) => error.code === "VISUAL_CHECK_DISABLED",
  );
  const project = updateProjectConfiguration(root, {
    name: "Demo",
    environment: "test",
    surfaces: ["h5"],
    h5Url: "https://example.com/",
    visualCheck: true,
  });
  assert.equal(project.defaults.visualCheck, true);
  await assert.rejects(
    coordinator.call("test.observe", { ...context, surface: "h5", mode: "visual" }),
    (error) => error.code === "VISUAL_MODEL_REQUIRED",
  );
  updateProjectConfiguration(root, {
    name: "Demo",
    environment: "test",
    surfaces: ["h5"],
    h5Url: "https://example.com/",
    visualCheck: true,
    visualModel: { provider: "qwen", modelId: "qwen-vl" },
  });
  await assert.rejects(
    coordinator.call("test.observe", { ...context, surface: "h5", mode: "visual" }),
    (error) => error.code === "SENSITIVE_VISUAL_PAGE",
  );
  assert.equal(screenshots, 0);
  text = "Dashboard\nImage\nDialog";
  const visual = await coordinator.call("test.observe", { ...context, surface: "h5", mode: "visual" });
  assert.equal(visual.mode, "visual");
  assert.match(visual.evidence, /visual-check.*\.png$/);
  assert.equal(visual.image.mimeType, "image/png");
  assert.equal(Buffer.from(visual.image.data, "base64").toString(), "png");
  assert.deepEqual(visual.visualModel, { provider: "qwen", modelId: "qwen-vl" });
  assert.equal(screenshots, 1);
});

test("deterministic playback records evidence, capture values, assertions, and stable regression", async (t) => {
  const root = fixture(t);
  const now = new Date().toISOString();
  createCase(
    root,
    {
      schemaVersion: 1,
      id: "order-search",
      title: "读取订单号并查询",
      surface: "h5",
      status: "draft",
      risk: "normal",
      createdAt: now,
      updatedAt: now,
      steps: [
        { act: "capture", pattern: "订单号[:：]\\s*([A-Z0-9-]+)", as: "order_id" },
        { act: "fill", target: "搜索", value: "{{capture.order_id}}" },
        { act: "shot", name: "order-found" },
      ],
      assert: [{ see: "订单详情" }],
    },
    undefined,
  );
  const calls = [];
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      async observe(input) {
        calls.push(["observe", input]);
        return { text: "订单号: ORD-42\n订单详情", truncated: false };
      },
      async open(input) {
        calls.push(["open", input]);
        return { tabId: "tab-one" };
      },
      async click(input) {
        calls.push(["click", input]);
      },
      async fill(input) {
        calls.push(["fill", input]);
      },
      async currentUrl() {
        return "https://example.com/orders/ORD-42";
      },
      async screenshot(input) {
        calls.push(["screenshot", input]);
        writeFileSync(input.out, "png");
      },
    },
  });
  const context = { projectRoot: root, projectId: "demo", sessionId: "session-play" };
  await assert.rejects(
    coordinator.call("test.play", {
      ...context,
      action: "run",
      caseIds: ["order-search"],
      title: "回归",
      slug: "draft-regression",
      trigger: "regression",
    }),
    (error) => error.code === "CASE_NOT_STABLE",
  );
  const first = await coordinator.call("test.play", {
    ...context,
    action: "run",
    caseIds: ["order-search"],
    title: "首次重放",
    slug: "first-play",
    trigger: "manual",
  });
  assert.equal(first.run.status, "passed");
  assert.equal(first.run.cases[0].status, "passed");
  assert.equal(first.run.cases[0].evidence.length, 1);
  assert.equal(existsSync(path.join(root, first.run.cases[0].evidence[0])), true);
  assert.equal(calls.find(([name]) => name === "fill")[1].value, "ORD-42");

  assert.equal(setCaseStatus(root, "order-search", "stable").status, "stable");
  const regression = await coordinator.call("test.play", {
    ...context,
    action: "run",
    caseIds: ["order-search"],
    title: "稳定回归",
    slug: "stable-regression",
    trigger: "regression",
  });
  assert.equal(regression.run.status, "passed");
  assert.equal(regression.run.trigger, "regression");
});

test("deterministic playback fails assertions with evidence and rejects unsafe capture patterns", async (t) => {
  const root = fixture(t);
  const now = new Date().toISOString();
  assert.throws(
    () =>
      createCase(root, {
        schemaVersion: 1,
        id: "unsafe-capture",
        title: "不安全捕获",
        surface: "h5",
        status: "draft",
        createdAt: now,
        updatedAt: now,
        steps: [{ act: "capture", pattern: "((a+)+)$", as: "value" }],
      }),
    /capture pattern/,
  );
  createCase(root, {
    schemaVersion: 1,
    id: "missing-text",
    title: "缺少结果",
    surface: "h5",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    steps: [{ act: "wait", idle: "50ms" }],
    assert: [{ see: "不会出现" }],
  });
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      async observe() {
        return { text: "当前页面", truncated: false };
      },
      async open() {
        return { tabId: "tab-one" };
      },
      async click() {},
      async fill() {},
      async currentUrl() {
        return "https://example.com/";
      },
      async screenshot(input) {
        writeFileSync(input.out, "png");
      },
    },
  });
  const failed = await coordinator.call("test.play", {
    projectRoot: root,
    projectId: "demo",
    sessionId: "session-play",
    action: "run",
    caseIds: ["missing-text"],
    title: "失败重放",
    slug: "failed-play",
  });
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.cases[0].status, "failed");
  assert.match(failed.run.cases[0].error, /未看到/);
  assert.equal(failed.run.cases[0].evidence.length, 1);
});

test("pause waits for the atomic step, captures evidence, and resume forces a fresh observation", async (t) => {
  const root = fixture(t);
  let releaseObserve;
  const observeStarted = new Promise((resolve) => {
    releaseObserve = resolve;
  });
  let continueObserve;
  const observeBlocked = new Promise((resolve) => {
    continueObserve = resolve;
  });
  let observeCount = 0;
  let screenshots = 0;
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      async observe() {
        observeCount += 1;
        if (observeCount === 1) {
          releaseObserve();
          await observeBlocked;
        }
        return { text: `snapshot-${observeCount}`, truncated: false };
      },
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
      async screenshot(input) {
        screenshots += 1;
        writeFileSync(input.out, "png-evidence");
      },
    },
  });
  const started = await coordinator.call("test.run", request(root, { action: "start", title: "执行", slug: "run" }));
  const observing = coordinator.call("test.observe", request(root, { surface: "h5", mode: "text" }));
  await observeStarted;
  await assert.rejects(
    coordinator.call("test.observe", request(root, { surface: "h5", mode: "snapshot" })),
    (error) => error.code === "TEST_BUSY",
  );
  let pauseFinished = false;
  const pausing = coordinator.call("test.run", request(root, { action: "pause", surface: "h5" })).then((result) => {
    pauseFinished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pauseFinished, false);
  assert.match(readFileSync(path.join(root, "runs", started.activeRun, "run.yaml"), "utf8"), /pause_requested/);
  await assert.rejects(
    coordinator.call(
      "test.act",
      request(root, { surface: "h5", risk: "read", action: { type: "wait", durationMs: 50 } }),
    ),
    (error) => error.code === "TEST_BUSY",
  );

  continueObserve();
  assert.equal((await observing).text, "snapshot-1");
  const paused = await pausing;
  assert.equal(paused.run.control.state, "paused");
  assert.equal(screenshots, 1);
  assert.equal(paused.run.journal.at(-1).evidence.length, 1);

  const resumed = await coordinator.call("test.run", request(root, { action: "resume" }));
  assert.equal(resumed.run.control.state, "running");
  assert.equal(resumed.observation.mode, "snapshot");
  assert.equal(resumed.observation.text, "snapshot-2");

  const takeover = await coordinator.call(
    "test.run",
    request(root, { action: "takeover", surface: "h5", reason: "verification", sensitive: true }),
  );
  assert.equal(takeover.run.control.state, "waiting_for_user");
  assert.equal(screenshots, 1);
  await assert.rejects(
    coordinator.call("test.observe", request(root, { surface: "h5", mode: "snapshot" })),
    (error) => error.code === "WAITING_FOR_USER",
  );
  const resumedAfterTakeover = await coordinator.call("test.run", request(root, { action: "resume" }));
  assert.equal(resumedAfterTakeover.observation.text, "snapshot-3");
  assert.equal(screenshots, 1);
  await coordinator.call("test.run", request(root, { action: "finish", status: "passed" }));
});

test("business-write confirmation occurs before the run and persists only for its surface", async (t) => {
  const root = fixture(t);
  let confirmations = 0;
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    async confirmRisk() {
      confirmations += 1;
      return true;
    },
    browser: {
      observe: async () => ({ text: "", truncated: false }),
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
    },
  });
  await coordinator.call(
    "test.run",
    request(root, { action: "start", title: "执行", slug: "run", surface: "h5", risk: "business_write" }),
  );
  assert.equal(confirmations, 1);
  for (const target of ["备注一", "备注二"]) {
    await coordinator.call(
      "test.act",
      request(root, { surface: "h5", risk: "business_write", action: { type: "fill", target, value: "x" } }),
    );
  }
  assert.equal(confirmations, 1);
  for (const target of ["删除草稿一", "删除草稿二"]) {
    await coordinator.call(
      "test.act",
      request(root, { surface: "h5", risk: "high", action: { type: "click", target } }),
    );
  }
  assert.equal(confirmations, 3);
  await coordinator.call("test.run", request(root, { action: "finish", status: "passed" }));
});

test("Main blocks Agent browser calls before the driver when the safe extension is not ready", async (t) => {
  const root = fixture(t);
  let driverCalls = 0;
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    assertBrowserReady() {
      throw new TestCoordinatorError("BROWSER_NOT_READY", "safe extension required");
    },
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      observe: async () => {
        driverCalls += 1;
        return { text: "", truncated: false };
      },
      open: async () => {
        driverCalls += 1;
        return {};
      },
      click: async () => {
        driverCalls += 1;
      },
      fill: async () => {
        driverCalls += 1;
      },
    },
  });
  await coordinator.call("test.run", request(root, { action: "start", title: "执行", slug: "run" }));
  await assert.rejects(
    coordinator.call("test.observe", request(root, { surface: "h5", mode: "text" })),
    (error) => error.code === "BROWSER_NOT_READY",
  );
  assert.equal(driverCalls, 0);
  await coordinator.call("test.run", request(root, { action: "finish", status: "blocked" }));
});

test("Main routes App operations only through the controlled mobile driver", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-test-mobile-coordinator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createProject(root, { id: "mobile-demo", name: "Mobile", surfaces: ["app"], appPackage: "com.example.app" });
  updateAppSurface(root, { package: "com.example.app", activity: ".MainActivity", serial: "SERIAL-1" });
  const calls = [];
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => null,
    isConfirmed: () => false,
    browser: {
      observe: async () => {
        throw new Error("browser must not be called");
      },
      open: async () => {
        throw new Error("browser must not be called");
      },
      click: async () => {
        throw new Error("browser must not be called");
      },
      fill: async () => {
        throw new Error("browser must not be called");
      },
    },
    mobile: {
      async connect(serial) {
        calls.push(["connect", serial]);
      },
      async foreground(serial) {
        calls.push(["foreground", serial]);
        return { packageName: "com.example.app", activity: ".MainActivity" };
      },
      async open(input) {
        calls.push(["open", input]);
      },
      async observe(input) {
        calls.push(["observe", input]);
        return { text: 'tap Button "Continue"', truncated: false };
      },
      async click(input) {
        calls.push(["click", input]);
      },
      async fill(input) {
        calls.push(["fill", input]);
      },
      async swipe(input) {
        calls.push(["swipe", input]);
      },
      async screenshot(input) {
        calls.push(["screenshot", input]);
        writeFileSync(input.out, "png");
      },
    },
  });
  const context = { projectRoot: root, projectId: "mobile-demo", sessionId: "session-mobile" };
  await coordinator.call("test.run", { ...context, action: "start", title: "App", slug: "app" });
  await coordinator.call("test.act", { ...context, surface: "app", risk: "read", action: { type: "open" } });
  const observed = await coordinator.call("test.observe", { ...context, surface: "app", mode: "snapshot" });
  assert.match(observed.text, /Continue/);
  await coordinator.call("test.act", {
    ...context,
    surface: "app",
    risk: "read",
    action: { type: "click", target: "Continue" },
  });
  const shot = await coordinator.call("test.act", {
    ...context,
    surface: "app",
    risk: "read",
    action: { type: "shot" },
  });
  assert.equal(existsSync(path.join(root, shot.evidence)), true);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "foreground", "observe", "foreground", "click", "foreground", "screenshot"],
  );
  assert.deepEqual(calls[0][1], {
    serial: "SERIAL-1",
    packageName: "com.example.app",
    activity: ".MainActivity",
  });
  updateAppSurface(root, { package: "com.example.other", activity: ".MainActivity", serial: "SERIAL-1" });
  await assert.rejects(
    coordinator.call("test.observe", { ...context, surface: "app", mode: "snapshot" }),
    (error) => error.code === "APP_FOREGROUND_CHANGED",
  );
  await coordinator.call("test.run", { ...context, action: "finish", status: "passed" });
});

test("lease is bound to the exact project root", async (t) => {
  const root = fixture(t);
  const otherRoot = fixture(t);
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      observe: async () => ({ text: "", truncated: false }),
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
    },
  });
  await coordinator.call("test.run", request(root, { action: "start", title: "执行", slug: "run" }));
  await assert.rejects(
    coordinator.call("test.observe", request(otherRoot, { surface: "h5", mode: "text" })),
    (error) => error.code === "TEST_LEASE_REQUIRED",
  );
  await coordinator.call("test.run", request(root, { action: "finish", status: "aborted" }));
});

test("session end aborts only its own active run and releases the lease", async (t) => {
  const root = fixture(t);
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      observe: async () => ({ text: "", truncated: false }),
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
    },
  });
  const started = await coordinator.call("test.run", request(root, { action: "start", title: "执行", slug: "run" }));
  assert.deepEqual(await coordinator.call("test.sessionEnded", { sessionId: "other-session" }), { released: false });
  assert.deepEqual(await coordinator.call("test.sessionEnded", { sessionId: "session-one" }), { released: true });
  assert.match(readFileSync(path.join(root, "runs", started.activeRun, "run.yaml"), "utf8"), /status: aborted/);
  assert.equal((await coordinator.call("test.run", request(root, { action: "status" }))).activeRun, null);

  const restarted = await coordinator.call(
    "test.run",
    request(root, { action: "start", title: "执行 2", slug: "run-two" }),
  );
  coordinator.authorizationLost();
  assert.match(readFileSync(path.join(root, "runs", restarted.activeRun, "run.yaml"), "utf8"), /status: aborted/);
});

test("authorization loss waits for the active browser operation before aborting the run", async (t) => {
  const root = fixture(t);
  let releaseObserve;
  const observeStarted = new Promise((resolve) => {
    releaseObserve = resolve;
  });
  let continueObserve;
  const observeBlocked = new Promise((resolve) => {
    continueObserve = resolve;
  });
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      async observe() {
        releaseObserve();
        await observeBlocked;
        return { text: "captured before revocation", truncated: false };
      },
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
    },
  });
  const started = await coordinator.call("test.run", request(root, { action: "start", title: "执行", slug: "run" }));
  const observing = coordinator.call("test.observe", request(root, { surface: "h5", mode: "text" }));
  await observeStarted;
  coordinator.authorizationLost();
  assert.match(readFileSync(path.join(root, "runs", started.activeRun, "run.yaml"), "utf8"), /status: in_progress/);
  continueObserve();
  assert.equal((await observing).text, "captured before revocation");
  const completed = readFileSync(path.join(root, "runs", started.activeRun, "run.yaml"), "utf8");
  assert.match(completed, /读取页面正文/);
  assert.match(completed, /status: aborted/);
});

test("new coordinator aborts a run left behind without an in-memory lease", async (t) => {
  const root = fixture(t);
  const options = {
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => false,
    browser: {
      observe: async () => ({ text: "", truncated: false }),
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
    },
  };
  const first = new MainTestCoordinator(options);
  const stale = await first.call("test.run", request(root, { action: "start", title: "旧执行", slug: "old" }));
  const second = new MainTestCoordinator(options);
  const replacement = await second.call("test.run", request(root, { action: "start", title: "新执行", slug: "new" }));

  assert.notEqual(replacement.activeRun, stale.activeRun);
  const oldRun = readFileSync(path.join(root, "runs", stale.activeRun, "run.yaml"), "utf8");
  assert.match(oldRun, /status: aborted/);
  assert.match(oldRun, /crash\/stale active-run/);
  await second.call("test.run", request(root, { action: "finish", status: "aborted" }));
});

test("production blocks writes before confirmation", async (t) => {
  const root = fixture(t, "production");
  const coordinator = new MainTestCoordinator({
    assertLicensed() {},
    resolveBrowserBinding: () => ({ profileId: "profile-one", tabId: "tab-one" }),
    isConfirmed: () => true,
    browser: {
      observe: async () => ({ text: "", truncated: false }),
      open: async () => ({}),
      click: async () => {},
      fill: async () => {},
    },
  });
  await assert.rejects(
    coordinator.call(
      "test.run",
      request(root, {
        action: "start",
        title: "写入",
        slug: "write",
        surface: "h5",
        risk: "business_write",
      }),
    ),
    (error) => error.code === "PRODUCTION_READ_ONLY",
  );
  await coordinator.call("test.run", request(root, { action: "start", title: "只读", slug: "readonly" }));
  for (const action of [
    { surface: "h5", risk: "read", action: { type: "click", target: "查看详情" } },
    {
      surface: "h5",
      risk: "business_write",
      confirmationId: "confirmed",
      action: { type: "fill", target: "搜索", value: "x" },
    },
  ]) {
    await assert.rejects(
      coordinator.call("test.act", request(root, action)),
      (error) => error.code === "PRODUCTION_READ_ONLY",
    );
  }
  await coordinator.call("test.run", request(root, { action: "finish", status: "aborted" }));
});

test("browser driver translates fixed argv and waits for a newly opened tab", async () => {
  const commands = [];
  let lookups = 0;
  const driver = new AgentBrowserCliDriver("/private/agent-browser-cli", {
    async run(command) {
      commands.push(command);
      const action = command.args[0];
      const stdout =
        action === "open"
          ? '{"ok":true,"result":{"opened_tab_id":"42"}}'
          : action === "lookup" && ++lookups < 3
            ? '{"ok":false,"error":"tab not connected"}'
            : action === "lookup"
              ? '{"ok":true,"result":{"profile_id":"profile-one","tab_id":"42"}}'
              : action === "snapshot"
                ? '{"ok":true,"result":{"tree":[{"role":"link","name":"Learn more","ref":"@e1"}]}}'
                : action === "scan"
                  ? '{"ok":true,"result":{"content":"Example Domain"}}'
                  : '{"ok":true,"result":{}}';
      return {
        executable: command.executable,
        args: command.args,
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: 1,
      };
    },
  });
  assert.deepEqual(
    await driver.open({ url: "https://example.com/", profileId: "profile-one", viewport: "390x844", mobile: true }),
    { tabId: "42" },
  );
  const observed = await driver.observe({
    mode: "snapshot",
    limit: 123,
    profileId: "profile-one",
    tabId: "42",
  });
  assert.deepEqual(JSON.parse(observed.text), [{ role: "link", name: "Learn more", ref: "@e1" }]);
  assert.equal(
    (await driver.observe({ mode: "text", limit: 200, profileId: "profile-one", tabId: "42" })).text,
    "Example Domain",
  );
  await driver.click({ target: "--help", profileId: "profile-one", tabId: "42" });
  await driver.fill({ target: "搜索", value: "--clear", profileId: "profile-one", tabId: "42" });
  assert.deepEqual(commands[0].args, [
    "open",
    "--profile",
    "profile-one",
    "--timeout",
    "30",
    "--",
    "https://example.com/",
  ]);
  assert.equal(lookups, 3);
  assert.deepEqual(commands[3].args, ["lookup", "tab", "42"]);
  assert.deepEqual(commands[4].args, [
    "exec",
    "--tab",
    "42",
    "--profile",
    "profile-one",
    '{"cmd":"cdp","method":"Emulation.setDeviceMetricsOverride","params":{"width":390,"height":844,"deviceScaleFactor":1,"mobile":true}}',
  ]);
  assert.deepEqual(commands[5].args, [
    "snapshot",
    "--limit",
    "123",
    "--tab",
    "42",
    "--profile",
    "profile-one",
    "--timeout",
    "30",
  ]);
  assert.deepEqual(commands[7].args, [
    "click",
    "--tab",
    "42",
    "--profile",
    "profile-one",
    "--timeout",
    "30",
    "--",
    "--help",
  ]);
  assert.deepEqual(commands[8].args, [
    "fill",
    "--tab",
    "42",
    "--profile",
    "profile-one",
    "--timeout",
    "30",
    "--",
    "搜索",
    "--clear",
  ]);
  assert.equal(
    commands.every((command) => command.outputLimitBytes === 50 * 1024),
    true,
  );
});

test("browser driver resolves visible text after a selector miss", async () => {
  const commands = [];
  const driver = new AgentBrowserCliDriver("/private/agent-browser-cli", {
    async run(command) {
      commands.push(command);
      const action = command.args[0];
      const script = command.args.at(-1);
      const stdout =
        action === "click"
          ? '{"ok":false,"error":"selector not found"}'
          : JSON.stringify({
              ok: true,
              result: { js_return: { matched: script.includes('const __wanted = __normalize("金料");') } },
            });
      return {
        executable: command.executable,
        args: command.args,
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: 1,
      };
    },
  });

  await driver.click({ target: "金料", profileId: "profile-one", tabId: "42" });
  assert.deepEqual(commands[1].args.slice(0, 7), [
    "exec",
    "--tab",
    "42",
    "--profile",
    "profile-one",
    "--timeout",
    "30",
  ]);
  await assert.rejects(
    driver.click({ target: "不存在", profileId: "profile-one", tabId: "42" }),
    (error) => error.code === "DRIVER_FAILED" && /未找到可见文案/.test(error.message),
  );
  await assert.rejects(
    driver.click({ target: "@e99", profileId: "profile-one", tabId: "42" }),
    (error) => error.code === "DRIVER_FAILED" && error.message === "selector not found",
  );
  assert.equal(commands.filter((command) => command.args[0] === "exec").length, 2);
});

test("browser driver resolves visible text fill after a selector miss", async () => {
  const commands = [];
  const driver = new AgentBrowserCliDriver("/private/agent-browser-cli", {
    async run(command) {
      commands.push(command);
      const action = command.args[0];
      const script = command.args.at(-1);
      const stdout =
        action === "fill"
          ? '{"ok":false,"error":"selector not found"}'
          : JSON.stringify({
              ok: true,
              result: {
                js_return: {
                  matched:
                    script.includes('const __wanted = __normalize("数量");') && script.includes('const __value = "2";'),
                },
              },
            });
      return {
        executable: command.executable,
        args: command.args,
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: 1,
      };
    },
  });

  await driver.fill({ target: "数量", value: "2", profileId: "profile-one", tabId: "42" });
  assert.deepEqual(commands[1].args.slice(0, 7), [
    "exec",
    "--tab",
    "42",
    "--profile",
    "profile-one",
    "--timeout",
    "30",
  ]);
  await assert.rejects(
    driver.fill({ target: "不存在", value: "2", profileId: "profile-one", tabId: "42" }),
    (error) => error.code === "DRIVER_FAILED" && /未找到可见文案/.test(error.message),
  );
  await assert.rejects(
    driver.fill({ target: "@e99", value: "2", profileId: "profile-one", tabId: "42" }),
    (error) => error.code === "DRIVER_FAILED" && error.message === "selector not found",
  );
});

test("browser driver rejects structured failures with a zero exit code", async () => {
  const driver = new AgentBrowserCliDriver("/private/agent-browser-cli", {
    async run(command) {
      return {
        executable: command.executable,
        args: command.args,
        exitCode: 0,
        signal: null,
        stdout: '{"ok":false,"error":"tab not connected"}',
        stderr: "",
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: 1,
      };
    },
  });
  await assert.rejects(
    driver.observe({ mode: "text", limit: 200, profileId: "profile-one", tabId: "missing" }),
    (error) => error.code === "DRIVER_FAILED",
  );
});

test("browser driver uses the stable Windows local app data path", () => {
  assert.equal(
    resolveTestBrowserCliPath({
      platform: "win32",
      arch: "x64",
      userDataDir: "C:\\Users\\tester\\AppData\\Roaming\\Pi Agent Desktop",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      isPackaged: true,
    }),
    "C:\\Users\\tester\\AppData\\Local\\PiTestDesktop\\toolchains\\agent-browser-cli\\0.3.7\\win32-x64\\agent-browser-cli.exe",
  );
  assert.throws(
    () =>
      resolveTestBrowserCliPath({
        platform: "win32",
        arch: "x64",
        userDataDir: "C:\\Users\\tester\\AppData\\Roaming\\Pi Agent Desktop",
        env: {},
        isPackaged: true,
      }),
    /LOCALAPPDATA/,
  );
});
