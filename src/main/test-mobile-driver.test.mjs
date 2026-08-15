import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HandsetsMobileDriver } from "./test-mobile-driver.ts";

function assets(root) {
  const handsets = path.join(root, "handsets");
  const platformTools = path.join(root, "platform-tools", "37.0.1");
  fs.mkdirSync(handsets, { recursive: true });
  fs.mkdirSync(platformTools, { recursive: true });
  return {
    supported: true,
    error: null,
    root,
    hsPath: path.join(handsets, "hs.exe"),
    hsJarPath: path.join(handsets, "hs.jar"),
    handsetsVersion: "0.1.38",
    platformToolsPath: platformTools,
    adbPath: path.join(platformTools, "adb.exe"),
    platformToolsVersion: "37.0.1",
    platformToolsInstalled: true,
    platformToolsDownloadAvailable: true,
  };
}

function result(command, stdout = "", exitCode = 0, stderr = "") {
  return {
    executable: command.executable,
    args: command.args,
    exitCode,
    signal: null,
    stdout,
    stderr,
    timedOut: false,
    outputLimitExceeded: false,
    durationMs: 1,
  };
}

test("mobile driver uses only fixed adb/hs argv and a private PATH", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mobile-driver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixed = assets(root);
  const calls = [];
  const executor = {
    async run(command) {
      calls.push(command);
      if (command.executable === fixed.adbPath) {
        if (command.args[0] === "forward") return result(command, "SERIAL-1 tcp:9008 tcp:9008\n");
        return result(command, "List of devices attached\nSERIAL-1 device product:demo model:Pixel_9 transport_id:1\n");
      }
      if (command.args.includes("show")) return result(command, "com.example.app/.MainActivity\n");
      if (command.args.includes("ui")) return result(command, 'tap Button "Continue" #continue 100,200\n');
      if (command.args.includes("see")) {
        fs.writeFileSync(command.args[command.args.indexOf("see") + 1], Buffer.from("png-data"));
      }
      return result(command);
    },
  };
  const driver = new HandsetsMobileDriver(fixed, { PATH: "/untrusted/bin", SystemRoot: "C:\\Windows" }, executor);
  assert.deepEqual(await driver.devices(), [
    { serial: "SERIAL-1", state: "device", model: "Pixel_9", product: "demo" },
  ]);
  await driver.connect("SERIAL-1");
  assert.deepEqual(await driver.foreground("SERIAL-1"), {
    packageName: "com.example.app",
    activity: ".MainActivity",
  });
  assert.equal((await driver.observe({ serial: "SERIAL-1", mode: "text", limit: 20 })).text.includes("Continue"), true);
  await driver.click({ serial: "SERIAL-1", target: "Continue" });
  await driver.swipe({ serial: "SERIAL-1", direction: "up", distance: 300 });
  const screenshot = path.join(root, "screen.png");
  await driver.screenshot({ serial: "SERIAL-1", out: screenshot });
  assert.equal(fs.existsSync(screenshot), true);

  assert.equal(
    calls.every((call) => call.executable === fixed.adbPath || call.executable === fixed.hsPath),
    true,
  );
  assert.equal(
    calls.every((call) => call.env.PATH === fixed.platformToolsPath),
    true,
  );
  assert.equal(
    calls.some((call) => call.executable === fixed.hsPath && call.args.includes("shell")),
    false,
  );
  assert.deepEqual(calls.find((call) => call.args.includes("tap")).args, [
    "--port",
    "9008",
    "--json",
    "tap",
    "Continue",
    "--visible",
    "--unique",
    "--timeout",
    "10000",
  ]);
  assert.deepEqual(calls.find((call) => call.args.includes("swipe")).args, ["--port", "9008", "swipe", "up", "390"]);
});

test("mobile driver uses fixed adb setup commands for a selected device among multiple devices", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mobile-driver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixed = assets(root);
  const calls = [];
  const executor = {
    async run(command) {
      calls.push(command);
      if (command.executable === fixed.adbPath) {
        if (command.args[0] === "devices") {
          return result(command, "List of devices attached\nSERIAL-1 device\nSERIAL-2 device\n");
        }
        return result(command, "");
      }
      return result(command, "pong\n");
    },
  };
  const driver = new HandsetsMobileDriver(fixed, {}, executor);
  await driver.connect("SERIAL-2");
  assert.deepEqual(
    calls.filter((call) => call.executable === fixed.adbPath).map((call) => call.args),
    [
      ["devices", "-l"],
      ["forward", "--list"],
      ["-s", "SERIAL-2", "push", fixed.hsJarPath, "/data/local/tmp/hs.jar"],
      ["-s", "SERIAL-2", "forward", "tcp:9008", "tcp:9008"],
      [
        "-s",
        "SERIAL-2",
        "shell",
        "CLASSPATH=/data/local/tmp/hs.jar nohup app_process /system/bin --nice-name=hsd dev.handsets.daemon.Main --port=9008 >/data/local/tmp/hs.log 2>&1 &",
      ],
    ],
  );
  assert.deepEqual(calls.at(-1).args, ["--port", "9008", "dev", "ping"]);
});

test("mobile driver reports USB authorization and rejects flag-shaped values", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mobile-driver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixed = assets(root);
  const executor = {
    async run(command) {
      return result(command, "List of devices attached\nSERIAL-1 unauthorized usb:1\n");
    },
  };
  const driver = new HandsetsMobileDriver(fixed, {}, executor);
  assert.equal((await driver.devices())[0].state, "unauthorized");
  await assert.rejects(driver.connect("SERIAL-1"), (error) => error.code === "ANDROID_UNAUTHORIZED");

  const readyExecutor = {
    async run(command) {
      if (command.executable === fixed.adbPath) return result(command, "List of devices attached\nSERIAL-1 device\n");
      return result(command);
    },
  };
  const ready = new HandsetsMobileDriver(fixed, {}, readyExecutor);
  await assert.rejects(
    ready.click({ serial: "SERIAL-1", target: "--timeout" }),
    (error) => error.code === "BAD_REQUEST",
  );
});
