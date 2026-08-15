import assert from "node:assert/strict";
import test from "node:test";
import { ZentaoClient, normalizeZentaoBaseUrl } from "./zentao-client.ts";

function json(value, status = 200, url = "") {
  const body = JSON.stringify(value);
  const response = new Response(body, { status, headers: { "content-type": "application/json" } });
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
}

function fixture(overrides = {}) {
  const calls = [];
  const bugs = overrides.bugs ?? [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = new URL(url).pathname + new URL(url).search;
    if (path.endsWith("/ping")) return json({ token: "session", tokenLife: "1440" }, 200, String(url));
    if (path.endsWith("/configurations")) {
      return json(
        [
          { key: "version", value: "21.7.1" },
          { key: "edition", value: "open" },
        ],
        200,
        String(url),
      );
    }
    if (path.includes("/products?")) return json({ products: [{ id: 7, name: "商城" }] }, 200, String(url));
    if (path.includes("/users?")) return json({ users: [{ account: "dev", realname: "开发" }] }, 200, String(url));
    if (path.endsWith("/requiredFields")) {
      return json(
        {
          bug: { create: { fields: overrides.requiredFields ?? ["title", "pri", "severity", "type", "openedBuild"] } },
        },
        200,
        String(url),
      );
    }
    if (path.includes("/products/7/bugs?") && init.method === "GET") {
      return json({ page: 1, total: bugs.length, limit: 100, bugs }, 200, String(url));
    }
    if (path.endsWith("/products/7/bugs") && init.method === "POST") {
      return json({ id: 42, title: "Issue", status: "active", steps: JSON.parse(init.body).steps }, 201, String(url));
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  return {
    calls,
    client: new ZentaoClient({ baseUrl: "https://zentao.example.test/zentao/", token: "secret" }, fetchImpl),
  };
}

test("ZenTao URL policy rejects credentials, loopback, query strings, and normalizes API paths", () => {
  assert.equal(
    normalizeZentaoBaseUrl("https://zentao.example.test/zentao/api.php/v1"),
    "https://zentao.example.test/zentao",
  );
  assert.equal(
    normalizeZentaoBaseUrl("http://47.107.124.89:8080/zentao/user-login-L3plbnRhby9teS5odG1s.html"),
    "http://47.107.124.89:8080/zentao",
  );
  for (const value of [
    "https://user:pass@zentao.example.test/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "https://zentao.example.test/?token=x",
  ]) {
    assert.throws(() => normalizeZentaoBaseUrl(value), /地址/);
  }
});

test("ZenTao probe sends Token only in headers and blocks unknown required Bug fields", async () => {
  const { calls, client } = fixture({ requiredFields: ["title", "companyRequired"] });
  const result = await client.probe();
  assert.equal(result.version, "21.7.1");
  assert.equal(result.capabilities.createBug, false);
  assert.deepEqual(result.capabilities.bugRequiredFields, ["title", "companyRequired"]);
  assert.deepEqual(result.capabilities.unsupportedBugFields, ["companyRequired"]);
  assert(calls.every((call) => call.init.headers.get("Token") === "secret"));
  assert(calls.every((call) => !call.url.includes("secret")));
});

test("ZenTao 18 uses its fixed API-required Bug fields only when requiredFields is absent", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const response = (value, status = 200) => json(value, status, String(url));
    if (path.endsWith("/ping")) return response({ token: "session" });
    if (path.endsWith("/configurations")) return response([{ key: "version", value: "18.5" }]);
    if (path.includes("/products?")) return response({ products: [{ id: 7, name: "Product" }] });
    if (path.includes("/users?")) return response({ users: [] });
    if (path.endsWith("/requiredFields")) return response({ error: "not found" }, 404);
    throw new Error(`unexpected ${path}`);
  };
  const probe = await new ZentaoClient({ baseUrl: "https://zentao.example.test/", token: "secret" }, fetchImpl).probe();
  assert.equal(probe.version, "18.5");
  assert.equal(probe.capabilities.requiredFields, false);
  assert.equal(probe.capabilities.createBug, true);
  assert.deepEqual(probe.capabilities.bugRequiredFields, ["title", "pri", "severity", "type", "openedBuild"]);
});

test("ZenTao unknown versions stay fail-closed when requiredFields is absent", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const response = (value, status = 200) => json(value, status, String(url));
    if (path.endsWith("/ping")) return response({ token: "session" });
    if (path.endsWith("/configurations")) return response([{ key: "version", value: "17.0" }]);
    if (path.includes("/products?")) return response({ products: [{ id: 7, name: "Product" }] });
    if (path.includes("/users?")) return response({ users: [] });
    if (path.endsWith("/requiredFields")) return response({ error: "not found" }, 404);
    throw new Error(`unexpected ${path}`);
  };
  const probe = await new ZentaoClient({ baseUrl: "https://zentao.example.test/", token: "secret" }, fetchImpl).probe();
  assert.equal(probe.capabilities.createBug, false);
  assert.deepEqual(probe.capabilities.bugRequiredFields, []);
});

test("ZenTao catalog reads flat module options and requires at least one Bug type", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(path);
    const response = (value) => {
      const result = json(value, 200, String(url));
      return result;
    };
    if (path.endsWith("/ping")) return response({ token: "session" });
    if (path.endsWith("/configurations")) return response([]);
    if (path.includes("/products?")) return response({ products: [{ id: 7, name: "Product" }] });
    if (path.includes("/users?")) return response({ users: [] });
    if (path.endsWith("/requiredFields")) return response({ bug: { create: { fields: ["title"] } } });
    if (path.includes("/modules?")) return json({ error: "unsupported" }, 404, String(url));
    if (path.includes("/releases?")) return response({ releases: [] });
    if (path.includes("/options/bug?")) {
      return response({
        options: { modules: { 9: "Orders" }, build: { trunk: "Trunk" }, type: { codeerror: "Code" } },
      });
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  const catalog = await new ZentaoClient(
    { baseUrl: "https://zentao.example.test/", token: "secret" },
    fetchImpl,
  ).catalog(7);
  assert.deepEqual(catalog.modules, [{ id: "9", name: "Orders" }]);
  assert.deepEqual(catalog.builds, [{ id: "trunk", name: "Trunk" }]);
  assert.equal(catalog.capabilities.createBug, true);
  assert(calls.some((path) => path.includes("/options/bug?product=7")));
});

test("ZenTao Bug creation reuses the stable marker before POST", async () => {
  const marker = "Pi-Test: demo/finding-one";
  const { calls, client } = fixture({ bugs: [{ id: 8, title: "Existing", status: "active", steps: marker }] });
  const result = await client.createBug({
    productId: 7,
    title: "Issue",
    steps: "Steps",
    severity: 2,
    priority: 3,
    type: "codeerror",
    marker,
  });
  assert.equal(result.existing, true);
  assert.equal(result.bug.id, 8);
  assert.equal(
    calls.some((call) => call.init.method === "POST"),
    false,
  );
});

test("ZenTao Bug creation embeds the stable marker and keeps priority distinct from severity", async () => {
  const { calls, client } = fixture();
  const result = await client.createBug({
    productId: 7,
    title: "Issue",
    steps: "Steps",
    severity: 1,
    priority: 4,
    type: "codeerror",
    openedBuild: "trunk",
    marker: "Pi-Test: demo/finding-two",
  });
  assert.equal(result.bug.id, 42);
  const post = calls.find((call) => call.init.method === "POST");
  const body = JSON.parse(post.init.body);
  assert.equal(body.severity, 1);
  assert.equal(body.pri, 4);
  assert.match(body.steps, /Pi-Test: demo\/finding-two/);
});
