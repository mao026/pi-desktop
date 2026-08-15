/* global AbortController -- Node 22 provides AbortController for the transport fixture. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createElectronZentaoFetch } from "./zentao-fetch.ts";

class FakeRequest extends EventEmitter {
  headers = new Map();
  chunks = [];
  aborted = false;
  ended = false;

  setHeader(name, value) {
    this.headers.set(name, value);
  }

  write(value) {
    this.chunks.push(Buffer.from(value));
  }

  abort() {
    this.aborted = true;
  }

  end() {
    this.ended = true;
  }
}

function setup() {
  const state = {};
  const fetchImpl = createElectronZentaoFetch((options) => {
    state.options = options;
    state.request = new FakeRequest();
    return state.request;
  });
  return { state, fetchImpl };
}

function respond(request, statusCode, body) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.statusMessage = "OK";
  response.rawHeaders = ["Content-Type", "application/json"];
  request.emit("response", response);
  response.emit("data", Buffer.from(body));
  response.emit("end");
}

test("Electron ZenTao fetch writes POST bodies and headers without following redirects", async () => {
  const { state, fetchImpl } = setup();
  const pending = fetchImpl("https://zentao.example.test/api.php/v1/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", token: "secret" },
    body: '{"account":"user"}',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.options, {
    method: "POST",
    url: "https://zentao.example.test/api.php/v1/tokens",
    redirect: "manual",
    bypassCustomProtocolHandlers: true,
  });
  assert.equal(state.request.headers.get("token"), "secret");
  assert.equal(Buffer.concat(state.request.chunks).toString(), '{"account":"user"}');
  respond(state.request, 201, '{"token":"value"}');
  assert.deepEqual(await (await pending).json(), { token: "value" });
});

test("Electron ZenTao fetch rejects DNS resolving to local endpoints before making a request", async () => {
  let requested = false;
  const fetchImpl = createElectronZentaoFetch(
    () => {
      requested = true;
      return new FakeRequest();
    },
    async () => ["127.0.0.1"],
  );
  await assert.rejects(fetchImpl("https://zentao.example.test/api.php/v1/ping"), /resolved unsafely/);
  assert.equal(requested, false);
});

test("Electron ZenTao fetch rejects redirects and abort signals", async (t) => {
  await t.test("redirect", async () => {
    const { state, fetchImpl } = setup();
    const pending = fetchImpl("https://zentao.example.test/api.php/v1/ping");
    await new Promise((resolve) => setImmediate(resolve));
    state.request.emit("redirect", 302, "GET", "https://other.example.test/", {});
    await assert.rejects(pending, /redirect rejected/);
    assert.equal(state.request.aborted, true);
  });
  await t.test("abort", async () => {
    const { state, fetchImpl } = setup();
    const controller = new AbortController();
    const pending = fetchImpl("https://zentao.example.test/api.php/v1/ping", { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    assert.equal(state.request.aborted, true);
  });
});
