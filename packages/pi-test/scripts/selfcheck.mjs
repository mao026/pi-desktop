#!/usr/bin/env node
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProject,
  loadProject,
  migrateProjectSchema1,
  requireSurfaceReady,
  setProjectZentao,
  updateProjectConfiguration,
  validateProject,
} from "../core/project.ts";
import { finishRun, loadRun, readActiveRunName, requireActiveRun, runControl, saveRun, startRun } from "../core/run.ts";
import { readYamlFile, writeYamlFile } from "../core/yaml.ts";
import { validateCase, saveCase, setCaseStatus, listCases, updateCase } from "../core/case.ts";
import { createFinding, addRetest, setFindingRemote, setFindingStatus, loadFinding } from "../core/finding.ts";
import { interpolate, loadSecrets } from "../core/interp.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok", msg);
}

// —— P0 ——
{
  const dir = mkdtempSync(join(tmpdir(), "pi-test-"));
  try {
    const p = createProject(dir, {
      id: "demo",
      name: "Demo",
      h5Url: "https://example.com/",
      appPackage: "com.example.app",
    });
    assert(p.surfaces.h5?.url === "https://example.com/", "create h5");
    assert(existsSync(join(dir, "map.md")), "map.md");
    assert(existsSync(join(dir, ".gitignore")), "gitignore");
    assert(loadProject(dir).id === "demo", "load");
    assert(p.environment === "test", "new project environment");
    mkdirSync(join(dir, ".pi-test"), { recursive: true });
    writeFileSync(join(dir, ".pi-test", "active-run"), "../../outside\n");
    assert(readActiveRunName(dir) === null, "active-run rejects traversal");
    assert(!existsSync(join(dir, ".pi-test", "active-run")), "invalid active-run cleared");

    try {
      validateProject({
        schemaVersion: 1,
        id: "x",
        name: "n",
        createdAt: "t",
        updatedAt: "t",
        surfaces: { h5: { url: "https://a.com/" } },
        extra: 1,
      });
      assert(false, "should reject unknown key");
    } catch (e) {
      assert(String(e.message).includes("未知"), "unknown key rejected");
    }

    const { dirName } = startRun(dir, loadProject(dir), {
      title: "smoke",
      slug: "smoke",
      trigger: "explore",
    });
    assert(readActiveRunName(dir) === dirName, "active-run");
    assert(existsSync(join(dir, "runs", dirName, "run.yaml")), "run.yaml");
    assert(runControl(requireActiveRun(dir).doc).state === "running", "run control");
    const legacyRun = loadRun(dir, dirName);
    delete legacyRun.control;
    assert(runControl(legacyRun).state === "running", "legacy run control");

    try {
      startRun(dir, loadProject(dir), { title: "x", slug: "x" });
      assert(false, "double start should fail");
    } catch (e) {
      assert(String(e.message).includes("进行中"), "single active run");
    }

    const fin = finishRun(dir, { status: "passed", text: "ok" });
    assert(fin.doc.status === "passed", "finish");
    assert(readActiveRunName(dir) === null, "active cleared");
    assert(readYamlFile(join(dir, "runs", dirName, "run.yaml")).summary.text === "ok", "summary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// —— desktop schema 1 ——
{
  const migrated = validateProject(
    migrateProjectSchema1({
      schemaVersion: 1,
      id: "legacy",
      name: "Legacy",
      createdAt: "2026-08-11T08:00:00Z",
      updatedAt: "2026-08-11T08:00:00Z",
      surfaces: { h5: { url: "https://example.com/" } },
      defaults: { allowBash: false },
    }),
  );
  assert(migrated.environment === "test", "legacy schema migrates environment");
  assert(!("allowBash" in migrated.defaults), "legacy schema removes allowBash");

  const incomplete = validateProject({
    schemaVersion: 1,
    id: "desktop",
    name: "Desktop",
    environment: "staging",
    createdAt: "2026-08-11T08:00:00Z",
    updatedAt: "2026-08-11T08:00:00Z",
    surfaces: { h5: { url: null }, admin: { url: "https://admin.example.com/" } },
    identities: { operator: { name: "后台操作员", surfaces: ["admin"] } },
    defaultIdentityBySurface: { admin: "operator" },
  });
  try {
    requireSurfaceReady(incomplete, "h5");
    assert(false, "incomplete surface should not be ready");
  } catch (e) {
    assert(e.readiness?.code === "url_missing", "incomplete surface readiness");
  }
  assert(requireSurfaceReady(incomplete, "admin").url.startsWith("https://"), "ready sibling surface");
  const updateRoot = mkdtempSync(join(tmpdir(), "pi-test-update-"));
  try {
    createProject(updateRoot, {
      id: "update",
      name: "Before",
      surfaces: ["h5", "admin"],
      h5Url: "https://example.com/",
      adminUrl: "https://admin.example.com/",
    });
    const updated = updateProjectConfiguration(updateRoot, {
      name: "After",
      environment: "staging",
      surfaces: ["h5", "app"],
      h5Url: "https://m.example.com/",
    });
    assert(updated.name === "After" && updated.surfaces.app?.package === null, "multi-surface project update");
    const mapped = setProjectZentao(updateRoot, {
      connectionId: "company-zentao",
      productId: 7,
      moduleId: 9,
      openedBuild: "trunk",
      assignedTo: "dev",
    });
    assert(mapped.zentao?.productId === 7 && !JSON.stringify(mapped).includes("token"), "project ZenTao mapping");
  } finally {
    rmSync(updateRoot, { recursive: true, force: true });
  }
  try {
    validateProject({
      ...incomplete,
      surfaces: { h5: { url: "https://user:password@example.com/" } },
      identities: {},
      defaultIdentityBySurface: {},
    });
    assert(false, "project URL should reject embedded credentials");
  } catch (e) {
    assert(String(e.message).includes("url"), "project URL rejects embedded credentials");
  }
}

// —— P1 ——
{
  const dir = mkdtempSync(join(tmpdir(), "pi-test-p1-"));
  try {
    const p = createProject(dir, { id: "p1", name: "P1", h5Url: "https://example.com/" });
    p.inputs = { phone: { description: "x", secret: true } };
    writeYamlFile(join(dir, "project.yaml"), p);

    const c = {
      schemaVersion: 1,
      id: "smoke-h5",
      title: "smoke",
      surface: "h5",
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pre: [{ open: "{{surfaces.h5.url}}" }],
      steps: [{ act: "wait", text: "x" }],
      assert: [{ see: "x" }],
    };
    validateCase(c, p);
    saveCase(dir, c);
    assert(listCases(dir).length === 1, "list cases");
    const successful = startRun(dir, p, { title: "case success", slug: "case-success", caseIds: [c.id] });
    successful.doc.cases[0].status = "passed";
    saveRun(dir, successful.dirName, successful.doc);
    finishRun(dir);
    setCaseStatus(dir, "smoke-h5", "stable", p);
    assert(listCases(dir)[0].status === "stable", "stable");
    const changed = updateCase(
      dir,
      { ...c, status: "stable", updatedAt: new Date().toISOString(), assert: [{ see: "y" }] },
      p,
    );
    assert(changed.status === "draft", "stable case change returns to draft");
    try {
      setCaseStatus(dir, "smoke-h5", "stable", p);
      assert(false, "old successful run must not promote changed case");
    } catch (e) {
      assert(String(e.message).includes("成功运行一次"), "changed case needs fresh successful run");
    }

    // reject @eN in stable
    try {
      const c2 = {
        ...c,
        status: "stable",
        steps: [{ act: "tap", target: "@e1" }],
      };
      validateCase(c2, p);
      assert(false, "should reject @eN stable");
    } catch (e) {
      assert(String(e.message).includes("@e"), "stable bans @eN");
    }

    mkdirSync(join(dir, ".secrets"), { recursive: true });
    writeFileSync(join(dir, ".secrets/inputs.yaml"), 'phone: "1"\n');
    const secrets = loadSecrets(dir);
    assert(
      interpolate("{{input.phone}}-{{surfaces.h5.url}}", loadProject(dir), secrets).startsWith("1-http"),
      "interp",
    );

    const { dirName } = startRun(dir, loadProject(dir), { title: "f", slug: "f", trigger: "manual" });
    mkdirSync(join(dir, "runs", dirName, "evidence"), { recursive: true });
    writeFileSync(join(dir, "runs", dirName, "evidence", "a.jpg"), "x");
    const f = createFinding(dir, loadProject(dir), {
      id: "f-blank",
      title: "blank",
      summary: "s",
      stepsToReproduce: ["open"],
      expected: "e",
      actual: "a",
      evidence: [`runs/${dirName}/evidence/a.jpg`],
      surface: "h5",
    });
    assert(f.id === "f-blank", "finding create");
    setFindingRemote(dir, loadProject(dir), "f-blank", {
      provider: "zentao",
      connectionId: "company-zentao",
      marker: "Pi-Test: p1/f-blank",
      syncStatus: "submitted",
      bugId: 42,
      url: "https://zentao.example.test/index.php?m=bug&f=view&bugID=42",
      status: "active",
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
    assert(loadFinding(dir, "f-blank").remote?.bugId === 42, "finding remote metadata");
    addRetest(dir, loadProject(dir), "f-blank", { result: "passed", note: "ok" });
    setFindingStatus(dir, loadProject(dir), "f-blank", "fixed");
    assert(loadFinding(dir, "f-blank").status === "fixed", "finding fixed");

    // finish without status → auto from cases (empty → passed)
    finishRun(dir, { text: "auto" });
    assert(readActiveRunName(dir) === null, "auto finish");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// —— P2 secrets ——
{
  const dir = mkdtempSync(join(tmpdir(), "pi-test-p2-"));
  try {
    const { listSecretStatus, setSecrets, missingSecrets } = await import("../core/secrets.ts");
    const p = createProject(dir, { id: "p2", name: "P2", h5Url: "https://example.com/" });
    p.inputs = { phone: { description: "手机", secret: true }, note: { description: "备注", secret: false } };
    writeYamlFile(join(dir, "project.yaml"), p);
    assert(missingSecrets(dir, loadProject(dir)).includes("phone"), "missing phone");
    setSecrets(dir, loadProject(dir), { phone: "13800138000", note: "hi" });
    const st = listSecretStatus(dir, loadProject(dir));
    const phone = st.find((s) => s.key === "phone");
    assert(phone?.present && phone.preview?.includes("***"), "masked secret");
    const note = st.find((s) => s.key === "note");
    assert(note?.preview === "hi", "non-secret preview");
    assert(missingSecrets(dir, loadProject(dir)).length === 0, "no missing");

    // cross-surface case validates surfaces exist
    const cross = {
      schemaVersion: 1,
      id: "cross",
      title: "cross",
      surface: "h5",
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [
        { act: "wait", text: "a" },
        { act: "wait", surface: "admin", text: "b" },
      ],
    };
    try {
      validateCase(cross, loadProject(dir));
      assert(false, "cross case should reject missing surface");
    } catch (e) {
      assert(String(e.message).includes("step.surface"), "cross case rejects missing surface");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
