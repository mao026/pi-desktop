import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeLicensePayload, DeviceLicenseService } from "./device-license.ts";

function memoryVault() {
  const entries = new Map();
  return {
    entries,
    get(key) {
      return entries.get(key) ?? null;
    },
    set(key, value) {
      entries.set(key, structuredClone(value));
    },
  };
}

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-device-license-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authority = generateKeyPairSync("ed25519");
  const authorizationPublicKey = authority.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const vault = overrides.vault ?? memoryVault();
  const requests = [];
  let responseFactory = () => new Response(null, { status: 404 });
  const service = new DeviceLicenseService({
    vault,
    cachePath: path.join(directory, "license-cache.json"),
    baseUrl: "https://license.example.com/",
    publicKey: authorizationPublicKey,
    appVersion: "1.2.3",
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return responseFactory();
    },
    ...overrides,
  });
  const signedLicense = (patch = {}) => {
    const payload = {
      version: 1,
      licenseId: "lic-test-001",
      deviceFingerprint: service.getDeviceFingerprint(),
      status: "active",
      issuedAt: "2026-08-12T08:00:00Z",
      features: ["desktop-testing"],
      minimumDesktopVersion: "1.0.0",
      ...patch,
    };
    return {
      ...payload,
      signature: sign(null, canonicalizeLicensePayload(payload), authority.privateKey).toString("base64"),
    };
  };
  return {
    directory,
    service,
    vault,
    requests,
    authorizationPublicKey,
    signedLicense,
    respond(factory) {
      responseFactory = factory;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("device identity is stable and a valid signed online license authorizes operations", async (t) => {
  const f = fixture(t);
  const fingerprint = f.service.getDeviceFingerprint();
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.match(f.service.getState().deviceCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  f.respond(() => jsonResponse(f.signedLicense()));

  const state = await f.service.start();
  assert.equal(state.phase, "authorized");
  assert.equal(state.authorized, true);
  assert.equal(state.readOnly, false);
  await f.service.assertLicensed();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, `https://license.example.com/licenses/${fingerprint}.json`);
  assert.equal(f.requests[0].init.headers["cache-control"], "no-cache");
  assert.equal(f.requests[0].init.redirect, "error");
  assert.equal(f.vault.entries.has("device:license:identity"), true);
  assert.equal(readFileSync(path.join(f.directory, "license-cache.json"), "utf8").includes("lic-test-001"), true);

  const restarted = fixture(t, { vault: f.vault });
  assert.equal(restarted.service.getDeviceFingerprint(), fingerprint);
  assert.equal(restarted.service.getState().authorized, false);
});

test("revocation, tampering, wrong device, and unsupported desktop version fail closed", async (t) => {
  const cases = [
    { name: "revoked", patch: { status: "revoked" }, phase: "revoked" },
    { name: "old desktop", patch: { minimumDesktopVersion: "2.0.0" }, phase: "invalid" },
  ];
  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const f = fixture(subtest);
      f.respond(() => jsonResponse(f.signedLicense(item.patch)));
      const state = await f.service.start();
      assert.equal(state.phase, item.phase);
      assert.equal(state.authorized, false);
      await assert.rejects(() => f.service.assertLicensed(), /DEVICE_LICENSE_REQUIRED|授权|版本/);
    });
  }

  await t.test("tampered", async (subtest) => {
    const f = fixture(subtest);
    const license = f.signedLicense();
    license.features = [];
    f.respond(() => jsonResponse(license));
    assert.equal((await f.service.start()).phase, "invalid");
  });

  await t.test("wrong device", async (subtest) => {
    const f = fixture(subtest);
    f.respond(() => jsonResponse(f.signedLicense({ deviceFingerprint: "0".repeat(64) })));
    assert.equal((await f.service.start()).phase, "invalid");
  });
});

test("404, network failure, and cached active license remain read-only until a current online check passes", async (t) => {
  const f = fixture(t);
  assert.equal((await f.service.start()).phase, "unlicensed");
  await assert.rejects(() => f.service.assertLicensed(), /当前设备尚未授权/);

  f.respond(() => {
    throw new Error("network offline");
  });
  assert.equal((await f.service.refresh()).phase, "offline");
  await assert.rejects(() => f.service.assertLicensed(), /只读模式/);

  f.respond(() => jsonResponse(f.signedLicense()));
  assert.equal((await f.service.refresh()).authorized, true);

  const offlineRestart = new DeviceLicenseService({
    vault: f.vault,
    cachePath: path.join(f.directory, "license-cache.json"),
    baseUrl: "https://license.example.com/",
    publicKey: f.authorizationPublicKey,
    appVersion: "1.2.3",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offlineRestart.getState().authorized, false);
  assert.equal(offlineRestart.getState().licenseId, "lic-test-001");
  assert.equal(offlineRestart.getState().lastValidAt, "2026-08-12T12:00:00.000Z");
  assert.equal((await offlineRestart.start()).phase, "offline");
  assert.equal(offlineRestart.getState().authorized, false);
});

test("licensed operations force a new online check after the 24 hour refresh interval", async (t) => {
  let now = new Date("2026-08-12T12:00:00.000Z");
  const f = fixture(t, { now: () => now });
  f.respond(() => jsonResponse(f.signedLicense()));
  await f.service.start();
  assert.equal(f.requests.length, 1);

  now = new Date("2026-08-13T11:59:59.000Z");
  await f.service.assertLicensed();
  assert.equal(f.requests.length, 1);

  now = new Date("2026-08-13T12:00:00.000Z");
  await f.service.assertLicensed();
  assert.equal(f.requests.length, 2);
});

test("unconfigured builds and explicit development bypass are deterministic", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-device-license-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    vault: memoryVault(),
    cachePath: path.join(directory, "cache.json"),
    baseUrl: "",
    publicKey: "",
    appVersion: "1.2.3",
  };
  const unconfigured = new DeviceLicenseService(options);
  assert.equal(unconfigured.getState().phase, "unconfigured");
  await assert.rejects(() => unconfigured.assertLicensed(), /尚未配置/);

  const bypass = new DeviceLicenseService({ ...options, bypass: true });
  assert.equal(bypass.getState().phase, "development_bypass");
  await bypass.assertLicensed();
});
