import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProject } from "../core/project.ts";
import { MainTestCoordinator } from "../../../src/main/test-coordinator.ts";
import { TestWorkbenchService, TestWorkbenchStore } from "../../../src/main/test-workbench-service.ts";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-test-workbench-"));
  const root = path.join(directory, "project");
  createProject(root, { id: "demo", name: "Demo", h5Url: "https://example.com/" });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, root };
}

function browserInspection() {
  return {
    status: {
      ready: true,
      summary: "ready",
      connection: {
        extension_connected: true,
        profiles: [{ extension_version: "2.1-pi-test.2", profile_id: "profile-one" }],
      },
    },
    tabs: {
      ok: true,
      result: {
        metadata: {
          tabs: [
            {
              browser_id: "browser-one",
              profile_id: "profile-one",
              profile_label: "work",
              tab_id: "tab-one",
              title: "Example Domain",
              url: "https://example.com/",
            },
          ],
        },
      },
    },
  };
}

function workbench(t, inspection = browserInspection(), zentaoFetch) {
  const { directory, root } = fixture(t);
  const calls = [];
  const copiedPaths = [];
  let extensionManagerOpenCount = 0;
  const store = new TestWorkbenchStore(path.join(directory, "workbench.json"));
  const vaultEntries = new Map();
  const vault = {
    has: (key) => vaultEntries.has(key),
    get: (key) => vaultEntries.get(key) ?? null,
    set: (key, value) => vaultEntries.set(key, structuredClone(value)),
    delete: (key) => vaultEntries.delete(key),
  };
  const browser = {
    async inspect() {
      return inspection;
    },
    async observe(input) {
      calls.push(["observe", input]);
      return { text: "Example Domain", truncated: false };
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
    async screenshot(input) {
      calls.push(["screenshot", input]);
      writeFileSync(input.out, "png");
    },
  };
  const coordinator = new MainTestCoordinator({
    browser,
    assertLicensed() {},
    resolveBrowserBinding: (projectId, projectRoot, surface) => store.getBinding(projectId, projectRoot, surface),
    saveBrowserBinding: (projectId, projectRoot, surface, binding) =>
      store.setBinding(projectId, projectRoot, surface, binding),
    isConfirmed: () => false,
  });
  const trashed = [];
  const service = new TestWorkbenchService(
    coordinator,
    browser,
    store,
    () => {},
    {
      prepared: true,
      error: null,
      cliPath: "/private/agent-browser-cli",
      cliVersion: "0.3.7",
      extensionPath: "/private/tmwd_cdp_bridge",
      extensionBackupPath: "/private/tmwd_cdp_bridge.previous",
      extensionVersion: "2.1",
      productExtensionVersion: "2.1-pi-test.2",
    },
    (extensionPath) => copiedPaths.push(extensionPath),
    () => {
      extensionManagerOpenCount += 1;
    },
    undefined,
    undefined,
    undefined,
    vault,
    async (projectRoot) => {
      trashed.push(projectRoot);
      rmSync(projectRoot, { recursive: true, force: true });
    },
    zentaoFetch,
  );
  service.openProject(root);
  return {
    directory,
    root,
    store,
    service,
    calls,
    copiedPaths,
    vaultEntries,
    trashed,
    extensionManagerOpenCount: () => extensionManagerOpenCount,
  };
}

test("workbench auto-binds one Chrome profile and completes run evidence finding flow", async (t) => {
  const { root, service, calls } = workbench(t);
  const browser = await service.getBrowserState(root, "h5");
  assert.deepEqual(browser.binding, { profileId: "profile-one", tabId: "tab-one" });

  const started = await service.startRun(root, "session-one", "h5", "Web test");
  assert.equal(started.run.status, "in_progress");
  const opened = await service.act(root, "session-one", "h5", "read", { type: "open" });
  assert.equal(opened.tabId, "tab-one");
  const observed = await service.observe(root, "session-one", "h5", "text");
  assert.equal(observed.text, "Example Domain");
  const paused = await service.controlRun(root, "session-one", { action: "pause", surface: "h5" });
  assert.equal(paused.run.control.state, "paused");
  const resumed = await service.controlRun(root, "session-one", { action: "resume" });
  assert.equal(resumed.run.control.state, "running");
  assert.equal(resumed.observation.mode, "snapshot");
  const evidence = await service.act(root, "session-one", "h5", "read", { type: "shot" });
  assert.match(evidence.evidence, /^runs\/.+\/evidence\/h5-\d+\.png$/);
  assert.equal(existsSync(path.join(root, evidence.evidence)), true);
  assert.match(service.readEvidence(root, evidence.evidence).dataUrl, /^data:image\/png;base64,/);

  const finding = await service.createFinding({
    projectRoot: root,
    sessionId: "session-one",
    surface: "h5",
    title: "Page issue",
    summary: "Page content is wrong",
    stepsToReproduce: ["Open page"],
    expected: "Expected",
    actual: "Actual",
    severity: "p2",
    evidence: evidence.evidence,
  });
  assert.equal(finding.status, "open");

  await service.finishRun(root, "session-one", "failed", "Found issue");
  const project = service.openProject(root);
  assert.equal(project.activeRun, null);
  assert.equal(project.runs[0].status, "failed");
  assert.equal(project.runs[0].evidence.length, 2);
  assert.equal(project.runs[0].evidence.includes(evidence.evidence), true);
  assert.equal(project.findings[0].id, finding.id);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "observe", "screenshot", "observe", "screenshot"],
  );
});

test("workbench creates and updates multiple surfaces without retaining removed Web bindings", async (t) => {
  const { directory, service, store } = workbench(t);
  const root = path.join(directory, "multi-surface");
  const created = await service.createProject({
    root,
    name: "Cross surface",
    environment: "test",
    surfaces: ["h5", "admin", "app"],
    h5Url: "https://m.example.test/",
    adminUrl: "https://admin.example.test/",
  });
  assert.deepEqual(
    created.surfaces.map((surface) => surface.name),
    ["h5", "admin", "app"],
  );
  store.setBinding(created.id, root, "admin", { profileId: "profile-one", tabId: "tab-one" });
  const updated = await service.updateProject({
    root,
    name: "Cross surface updated",
    environment: "staging",
    surfaces: ["h5", "app"],
    h5Url: "https://m2.example.test/",
  });
  assert.equal(updated.name, "Cross surface updated");
  assert.equal(updated.environment, "staging");
  assert.deepEqual(
    updated.surfaces.map((surface) => surface.name),
    ["h5", "app"],
  );
  assert.equal(store.getBinding(created.id, root, "admin"), null);

  await service.saveIdentity({
    projectRoot: root,
    id: "mobile-user",
    name: "手机用户",
    surfaces: ["app"],
    defaultSurfaces: ["app"],
  });
  await assert.rejects(
    service.updateProject({
      root,
      name: "Invalid removal",
      environment: "staging",
      surfaces: ["h5"],
      h5Url: "https://m2.example.test/",
    }),
    /未配置 surface|无效/,
  );
});

test("workbench keeps archive, remove, and system-trash deletion as separate operations", async (t) => {
  const { directory, service, vaultEntries, trashed } = workbench(t);
  const root = path.join(directory, "lifecycle");
  const created = await service.createProject({
    root,
    name: "Lifecycle",
    environment: "test",
    surfaces: ["h5"],
    h5Url: "https://example.test/",
  });
  await service.setProjectArchived(root, true);
  assert.equal(service.listRecentProjects().find((item) => item.root === root).archived, true);
  assert.equal(existsSync(root), true);
  await service.setProjectArchived(root, false);
  assert.equal(service.listRecentProjects().find((item) => item.root === root).archived, false);
  await service.removeProject(root);
  assert.equal(
    service.listRecentProjects().some((item) => item.root === root),
    false,
  );
  assert.equal(existsSync(root), true);

  service.openProject(root);
  await service.saveIdentity({
    projectRoot: root,
    id: "operator",
    name: "操作员",
    surfaces: ["h5"],
    defaultSurfaces: [],
    username: "user",
    password: "password",
  });
  await assert.rejects(service.deleteProjectData(root, "wrong"), (error) => error.code === "CONFIRMATION_MISMATCH");
  assert.equal(existsSync(root), true);
  await service.deleteProjectData(root, created.name);
  assert.deepEqual(trashed, [root]);
  assert.equal(existsSync(root), false);
  assert.equal(vaultEntries.size, 0);
  assert.equal(
    service.listRecentProjects().some((item) => item.root === root),
    false,
  );
});

test("workbench stores identity credentials only in the write-only Main vault", async (t) => {
  const { root, service, vaultEntries } = workbench(t);
  const saved = await service.saveIdentity({
    projectRoot: root,
    id: "operator",
    name: "后台操作员",
    surfaces: ["h5"],
    defaultSurfaces: ["h5"],
    username: "operator@example.test",
    password: "private-password",
  });
  assert.deepEqual(saved.identities, [
    {
      id: "operator",
      name: "后台操作员",
      surfaces: ["h5"],
      defaultSurfaces: ["h5"],
      credentialConfigured: true,
    },
  ]);
  const yaml = readFileSync(path.join(root, "project.yaml"), "utf8");
  assert.doesNotMatch(yaml, /operator@example\.test|private-password/);
  assert.doesNotMatch(JSON.stringify(saved), /operator@example\.test|private-password/);
  assert.deepEqual(vaultEntries.get("test:project:demo:identity:operator"), {
    version: 1,
    username: "operator@example.test",
    password: "private-password",
  });

  const deleted = await service.deleteIdentity(root, "operator");
  assert.deepEqual(deleted.identities, []);
  assert.equal(vaultEntries.size, 0);
});

test("workbench keeps ZenTao secrets in the vault and submits one idempotent Bug from a local finding", async (t) => {
  const requests = [];
  const zentaoFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const pathAndSearch = `${parsed.pathname}${parsed.search}`;
    requests.push({ path: pathAndSearch, init });
    const response = (value, status = 200) => {
      const result = new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      Object.defineProperty(result, "url", { value: String(url) });
      return result;
    };
    if (pathAndSearch.endsWith("/ping")) return response({ token: "session" });
    if (pathAndSearch.endsWith("/configurations")) {
      return response([
        { key: "version", value: "21.7.1" },
        { key: "edition", value: "open" },
      ]);
    }
    if (pathAndSearch.includes("/products?")) return response({ products: [{ id: 7, name: "商城" }] });
    if (pathAndSearch.includes("/users?")) return response({ users: [{ account: "dev", realname: "开发" }] });
    if (pathAndSearch.endsWith("/requiredFields")) {
      return response({ bug: { create: { method: "create", fields: ["title", "openedBuild"] } } });
    }
    if (pathAndSearch.includes("/modules?")) return response({ modules: [{ id: 9, name: "订单" }] });
    if (pathAndSearch.includes("/releases?")) return response({ releases: [] });
    if (pathAndSearch.includes("/options/bug?")) {
      return response({
        options: { modules: { 9: "订单" }, build: { trunk: "主干" }, type: { codeerror: "代码错误" } },
      });
    }
    if (pathAndSearch.includes("/products/7/bugs?") && init.method === "GET") {
      return response({ page: 1, total: 0, limit: 100, bugs: [] });
    }
    if (pathAndSearch.endsWith("/products/7/bugs") && init.method === "POST") {
      return response({ id: 42, title: "Remote issue", status: "active" }, 201);
    }
    if (pathAndSearch.includes("/files?")) throw new Error("upload unsupported in fixture");
    throw new Error(`unexpected ${init.method} ${pathAndSearch}`);
  };
  const { root, service, vaultEntries } = workbench(t, browserInspection(), zentaoFetch);
  const savedConnection = await service.saveZentaoConnection({
    id: "company-zentao",
    name: "公司禅道",
    baseUrl: "https://zentao.example.test/zentao/",
    token: "private-token",
  });
  assert.equal(savedConnection.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(savedConnection), /private-token/);
  assert.deepEqual(vaultEntries.get("test:zentao:company-zentao:token"), {
    version: 1,
    baseUrl: "https://zentao.example.test/zentao",
    token: "private-token",
  });
  assert.doesNotMatch(readFileSync(path.join(path.dirname(root), "workbench.json"), "utf8"), /private-token/);

  await service.setProjectZentao({
    projectRoot: root,
    connectionId: "company-zentao",
    productId: 7,
    moduleId: 9,
    openedBuild: "trunk",
    assignedTo: "dev",
  });
  await service.getBrowserState(root, "h5");
  await service.startRun(root, "session-one", "h5", "ZenTao sync");
  const evidence = await service.act(root, "session-one", "h5", "read", { type: "shot" });
  const summary = await service.createFinding({
    projectRoot: root,
    sessionId: "session-one",
    surface: "h5",
    title: "Remote issue",
    summary: "Wrong content",
    stepsToReproduce: ["Open page"],
    expected: "Expected",
    actual: "Actual",
    severity: "p1",
    evidence: evidence.evidence,
  });
  await service.finishRun(root, "session-one", "failed", "Found issue");
  const draft = await service.prepareZentaoBug(root, summary.id);
  assert.equal(draft.marker, `Pi-Test: demo/${summary.id}`);
  assert.equal(draft.severity, 2);
  assert.equal(draft.priority, 2);
  assert.match(draft.description, /Wrong content|Wrong content/i);
  const submitted = await service.submitZentaoBug(draft);
  const remote = submitted.findings.find((finding) => finding.id === summary.id).remote;
  assert.equal(remote.syncStatus, "submitted");
  assert.equal(remote.bugId, 42);
  assert.match(remote.url, /bugID=42/);
  assert.match(remote.lastError, /附件失败/);
  const post = requests.find((request) => request.init.method === "POST" && request.path.endsWith("/products/7/bugs"));
  const body = JSON.parse(post.init.body);
  assert.equal(body.severity, 2);
  assert.equal(body.pri, 2);
  assert.match(body.steps, new RegExp(`Pi-Test: demo/${summary.id}`));
  assert(requests.every((request) => request.init.headers.get("Token") === "private-token"));
  assert(requests.every((request) => !request.path.includes("private-token")));
  assert.match(readFileSync(path.join(root, "project.yaml"), "utf8"), /connectionId: company-zentao/);
  assert.doesNotMatch(readFileSync(path.join(root, "project.yaml"), "utf8"), /private-token/);
});

test("workbench rejects an unpatched extension and exposes only the fixed installation actions", async (t) => {
  const inspection = browserInspection();
  inspection.status.connection.profiles[0].extension_version = "2.1";
  const { root, service, copiedPaths, extensionManagerOpenCount } = workbench(t, inspection);
  const state = await service.getBrowserState(root, "h5");
  assert.equal(state.ready, false);
  assert.equal(state.extensionConnected, true);
  assert.equal(state.extensionVersion, "2.1");
  assert.equal(state.expectedExtensionVersion, "2.1-pi-test.2");

  assert.deepEqual(await service.copyExtensionPath(), { path: "/private/tmwd_cdp_bridge" });
  await service.openExtensionManager();
  assert.deepEqual(copiedPaths, ["/private/tmwd_cdp_bridge"]);
  assert.equal(extensionManagerOpenCount(), 1);
});

test("workbench binding and startup recovery use the exact project root", async (t) => {
  const { root, store, service } = workbench(t);
  await service.getBrowserState(root, "h5");
  await service.startRun(root, "session-one", "h5", "Interrupted");

  const sibling = path.join(path.dirname(root), "sibling");
  createProject(sibling, { id: "demo", name: "Sibling", h5Url: "https://example.com/" });
  assert.equal(store.getBinding("demo", sibling, "h5"), null);

  store.setBinding("demo", root, "h5", { profileId: "missing-profile", tabId: "missing-tab" });
  assert.equal((await service.getBrowserState(root, "h5")).binding, null);
  assert.equal(store.getBinding("demo", root, "h5"), null);

  service.recoverStaleRuns();
  const run = service.openProject(root).runs[0];
  assert.equal(run.status, "aborted");
  assert.match(readFileSync(path.join(root, "runs", run.dirName, "run.yaml"), "utf8"), /crash\/stale active-run/);
});

test("workbench evidence reader rejects arbitrary project files and symlinks", async (t) => {
  const { root, service } = workbench(t);
  assert.throws(
    () => service.readEvidence(root, "project.yaml"),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.throws(
    () => service.readEvidence(root, "runs/../../project.yaml"),
    (error) => error.code === "BAD_REQUEST",
  );

  const run = await service.startRun(root, "session-one", "h5", "Evidence link");
  const evidenceDir = path.join(root, "runs", run.activeRun, "evidence");
  writeFileSync(path.join(evidenceDir, "ui.txt"), "RootWebArea\nButton Login");
  assert.deepEqual(service.readEvidence(root, `runs/${run.activeRun}/evidence/ui.txt`), {
    dataUrl: null,
    text: "RootWebArea\nButton Login",
  });

  const outside = path.join(path.dirname(root), "outside.png");
  writeFileSync(outside, "png");
  symlinkSync(outside, path.join(evidenceDir, "linked.png"));
  assert.throws(
    () => service.readEvidence(root, `runs/${run.activeRun}/evidence/linked.png`),
    (error) => error.code === "BAD_REQUEST",
  );
});
