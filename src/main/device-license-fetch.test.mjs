/* global AbortController -- Node 22 abort signal used by network adapter tests */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createElectronDeviceLicenseFetch } from "./device-license-fetch.ts";

class FakeRequest extends EventEmitter {
  headers = new Map();
  aborted = false;
  ended = false;

  setHeader(name, value) {
    this.headers.set(name, value);
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
  const fetchImpl = createElectronDeviceLicenseFetch((options) => {
    state.options = options;
    state.request = new FakeRequest();
    return state.request;
  });
  return { state, fetchImpl };
}

function respond(request, statusCode, body) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.statusMessage = statusCode === 200 ? "OK" : "Not Found";
  response.rawHeaders = ["Content-Type", "application/json"];
  request.emit("response", response);
  response.emit("data", Buffer.from(body));
  response.emit("end");
}

test("Electron device license fetch uses GET, manual redirect policy, and request headers", async () => {
  const { state, fetchImpl } = setup();
  const pending = fetchImpl("https://license.example.com/licenses/device.json", {
    headers: { accept: "application/json", "cache-control": "no-cache" },
  });
  assert.deepEqual(state.options, {
    method: "GET",
    url: "https://license.example.com/licenses/device.json",
    redirect: "manual",
    bypassCustomProtocolHandlers: true,
  });
  assert.equal(state.request.headers.get("accept"), "application/json");
  assert.equal(state.request.headers.get("cache-control"), "no-cache");
  respond(state.request, 200, '{"ok":true}');
  const response = await pending;
  assert.equal(await response.text(), '{"ok":true}');
});

test("Electron device license fetch rejects redirects synchronously", async () => {
  const { state, fetchImpl } = setup();
  const pending = fetchImpl("https://license.example.com/licenses/device.json");
  state.request.emit("redirect", 302, "GET", "https://other.example.com/device.json", {});
  await assert.rejects(pending, /redirect rejected/);
  assert.equal(state.request.aborted, true);
});

test("Electron device license fetch aborts before or during the response body", async (t) => {
  await t.test("before response", async () => {
    const { state, fetchImpl } = setup();
    const controller = new AbortController();
    const pending = fetchImpl("https://license.example.com/licenses/device.json", { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    assert.equal(state.request.aborted, true);
  });

  await t.test("during body", async () => {
    const { state, fetchImpl } = setup();
    const controller = new AbortController();
    const pending = fetchImpl("https://license.example.com/licenses/device.json", { signal: controller.signal });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.statusMessage = "OK";
    response.rawHeaders = [];
    state.request.emit("response", response);
    const body = (await pending).text();
    controller.abort(new Error("body timeout"));
    await assert.rejects(body, /body timeout/);
    assert.equal(state.request.aborted, true);
  });
});
