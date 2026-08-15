import fs from "node:fs";
import path from "node:path";
import { TestCoordinatorError, type TestMobileDriver } from "./test-coordinator.ts";
import type { TestAndroidAssetsState } from "./test-android-assets.ts";
import { defaultProbeExecutor, probeSucceeded, type ProbeExecutor } from "./toolchains/process-runner.ts";

const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PACKAGE_RE = /^(?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/;
const COMPONENT_RE = /^((?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*)(?:\/([^\s]+))?$/;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface TestMobileDevice {
  serial: string;
  state: "device" | "unauthorized" | "offline" | "other";
  model: string | null;
  product: string | null;
}

function serial(value: string): string {
  if (!SERIAL_RE.test(value)) throw new TestCoordinatorError("BAD_REQUEST", "Android device serial 无效");
  return value;
}

function packageName(value: string): string {
  if (!PACKAGE_RE.test(value)) throw new TestCoordinatorError("BAD_REQUEST", "Android package 无效");
  return value;
}

function minimalEnvironment(base: NodeJS.ProcessEnv, assets: TestAndroidAssetsState): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: assets.platformToolsPath,
    HANDSETS_JAR: assets.hsJarPath,
    HOME: assets.root,
    USERPROFILE: assets.root,
    HS_FORMAT: "human",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"]) {
    if (base[key]) env[key] = base[key];
  }
  return env;
}

function driverFailure(tool: "adb" | "hs", result: Awaited<ReturnType<ProbeExecutor["run"]>>): never {
  if (result.timedOut) throw new TestCoordinatorError("MOBILE_TIMEOUT", `${tool} 操作超时`);
  if (result.outputLimitExceeded) throw new TestCoordinatorError("MOBILE_OUTPUT_LIMIT", `${tool} 输出超过限制`);
  if (result.spawnErrorCode) throw new TestCoordinatorError("MOBILE_TOOL_UNAVAILABLE", `${tool} 无法启动`);
  const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 1_000);
  if (/unauthorized/i.test(detail)) {
    throw new TestCoordinatorError("ANDROID_UNAUTHORIZED", "请在手机上允许 USB 调试");
  }
  if (/offline/i.test(detail)) throw new TestCoordinatorError("ANDROID_OFFLINE", "Android 设备处于 offline 状态");
  if (/no devices|not attached|device.*not found/i.test(detail)) {
    throw new TestCoordinatorError("ANDROID_DEVICE_MISSING", "未找到已选择的 Android 设备");
  }
  throw new TestCoordinatorError("MOBILE_DRIVER_FAILED", detail || `${tool} 操作失败`);
}

export class HandsetsMobileDriver implements TestMobileDriver {
  private readonly assets: TestAndroidAssetsState;
  private readonly executor: ProbeExecutor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ports = new Map<string, number>();

  constructor(
    assets: TestAndroidAssetsState,
    baseEnv: NodeJS.ProcessEnv,
    executor: ProbeExecutor = defaultProbeExecutor,
  ) {
    this.assets = assets;
    this.executor = executor;
    this.env = minimalEnvironment(baseEnv, assets);
  }

  async devices(): Promise<TestMobileDevice[]> {
    this.assertTools();
    const result = await this.executor.run({
      executable: this.assets.adbPath,
      args: ["devices", "-l"],
      env: this.env,
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1024,
    });
    if (!probeSucceeded(result)) driverFailure("adb", result);
    return result.stdout
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line): TestMobileDevice[] => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("*")) return [];
        const fields = trimmed.split(/\s+/);
        const deviceSerial = fields[0];
        const rawState = fields[1];
        if (!deviceSerial || !SERIAL_RE.test(deviceSerial) || !rawState) return [];
        const metadata = new Map(
          fields.slice(2).flatMap((field) => {
            const separator = field.indexOf(":");
            return separator > 0 ? [[field.slice(0, separator), field.slice(separator + 1)] as const] : [];
          }),
        );
        const state =
          rawState === "device" || rawState === "unauthorized" || rawState === "offline" ? rawState : "other";
        return [
          {
            serial: deviceSerial,
            state,
            model: metadata.get("model") ?? null,
            product: metadata.get("product") ?? null,
          },
        ];
      });
  }

  async connect(deviceSerial: string): Promise<void> {
    const selectedSerial = serial(deviceSerial);
    const devices = await this.devices();
    const selected = devices.find((device) => device.serial === selectedSerial);
    if (!selected) throw new TestCoordinatorError("ANDROID_DEVICE_MISSING", "已选择的 Android 设备未连接");
    if (selected.state === "unauthorized") {
      throw new TestCoordinatorError("ANDROID_UNAUTHORIZED", "请在手机上允许 USB 调试");
    }
    if (selected.state !== "device") throw new TestCoordinatorError("ANDROID_OFFLINE", "Android 设备尚未就绪");
    const readyDevices = devices.filter((device) => device.state === "device");
    if (readyDevices.length === 1) {
      await this.hs(["use"], 20_000);
      this.ports.set(selectedSerial, await this.forwardedPort(selectedSerial));
      return;
    }
    await this.connectSelected(selectedSerial);
  }

  async foreground(deviceSerial: string): Promise<{ packageName: string; activity: string | null }> {
    await this.requireDevice(deviceSerial);
    const output = (await this.hs([...this.route(deviceSerial), "show", "top"], 10_000)).trim();
    const component = output.split(/\s+/).find((value) => COMPONENT_RE.test(value));
    const match = component ? COMPONENT_RE.exec(component) : null;
    if (!match) throw new TestCoordinatorError("MOBILE_DRIVER_FAILED", "无法读取当前前台 App");
    return { packageName: packageName(match[1]), activity: match[2] ?? null };
  }

  async observe(input: { serial: string; mode: "text" | "snapshot"; limit: number }) {
    await this.requireDevice(input.serial);
    const args = [...this.route(input.serial), "ui", ...(input.mode === "snapshot" ? ["--json"] : [])];
    const text = await this.hs(args, 15_000);
    const lines = text.split(/\r?\n/);
    const bounded = lines.slice(0, input.limit).join("\n");
    return { text: bounded, truncated: lines.length > input.limit };
  }

  async open(input: { serial: string; packageName: string; activity?: string | null }): Promise<void> {
    await this.connect(input.serial);
    const component = input.activity
      ? `${packageName(input.packageName)}/${input.activity}`
      : packageName(input.packageName);
    if (component.length > 300 || /[\0\r\n\s]/.test(component)) {
      throw new TestCoordinatorError("BAD_REQUEST", "Android component 无效");
    }
    await this.hs([...this.route(input.serial), "open", component], 15_000);
  }

  async click(input: { serial: string; target: string }): Promise<void> {
    await this.requireDevice(input.serial);
    this.assertSafeActionValue(input.target, "selector");
    await this.hs(
      [...this.route(input.serial), "--json", "tap", input.target, "--visible", "--unique", "--timeout", "10000"],
      15_000,
    );
  }

  async fill(input: { serial: string; target: string; value: string }): Promise<void> {
    await this.requireDevice(input.serial);
    this.assertSafeActionValue(input.target, "selector");
    this.assertSafeActionValue(input.value, "value");
    await this.hs(
      [
        ...this.route(input.serial),
        "--json",
        "fill",
        input.target,
        input.value,
        "--visible",
        "--unique",
        "--timeout",
        "10000",
      ],
      15_000,
    );
  }

  async swipe(input: {
    serial: string;
    direction: "up" | "down" | "left" | "right";
    distance?: number;
  }): Promise<void> {
    await this.requireDevice(input.serial);
    const duration = Math.min(Math.max(Math.round((input.distance ?? 300) * 1.3), 100), 1_500);
    await this.hs([...this.route(input.serial), "swipe", input.direction, String(duration)], 10_000);
  }

  async screenshot(input: { serial: string; out: string }): Promise<void> {
    await this.requireDevice(input.serial);
    if (!path.isAbsolute(input.out) || /[\0\r\n]/.test(input.out) || !input.out.toLowerCase().endsWith(".png")) {
      throw new TestCoordinatorError("BAD_REQUEST", "移动截图输出路径无效");
    }
    await this.hs([...this.route(input.serial), "see", input.out, "--native"], 30_000);
    const stat = fs.lstatSync(input.out);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8) {
      throw new TestCoordinatorError("MOBILE_DRIVER_FAILED", "移动截图未生成有效文件");
    }
  }

  private route(deviceSerial: string): string[] {
    const selectedSerial = serial(deviceSerial);
    const port = this.ports.get(selectedSerial);
    return port ? ["--port", String(port)] : ["--device", selectedSerial];
  }

  private async connectSelected(deviceSerial: string): Promise<void> {
    const occupied = new Set<number>();
    const forwards = await this.adb(["forward", "--list"], 10_000);
    for (const match of forwards.matchAll(/\btcp:(9\d{3})\b/g)) occupied.add(Number(match[1]));
    let port = 9008;
    while (occupied.has(port) && port <= 9100) port += 1;
    if (port > 9100) throw new TestCoordinatorError("MOBILE_DRIVER_FAILED", "没有可用的 Handsets 本地端口");
    const selected = serial(deviceSerial);
    await this.adb(["-s", selected, "push", this.assets.hsJarPath, "/data/local/tmp/hs.jar"], 20_000);
    await this.adb(["-s", selected, "forward", `tcp:${port}`, `tcp:${port}`], 10_000);
    const command =
      `CLASSPATH=/data/local/tmp/hs.jar nohup app_process /system/bin --nice-name=hsd ` +
      `dev.handsets.daemon.Main --port=${port} >/data/local/tmp/hs.log 2>&1 &`;
    await this.adb(["-s", selected, "shell", command], 10_000);
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const probe = await this.executor.run({
        executable: this.assets.hsPath,
        args: ["--port", String(port), "dev", "ping"],
        cwd: path.dirname(this.assets.hsPath),
        env: this.env,
        timeoutMs: 1_000,
        outputLimitBytes: 16 * 1024,
      });
      if (probeSucceeded(probe)) {
        this.ports.set(selected, port);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new TestCoordinatorError("MOBILE_DRIVER_FAILED", "Handsets daemon 启动超时");
  }

  private async forwardedPort(deviceSerial: string): Promise<number> {
    const output = await this.adb(["forward", "--list"], 10_000);
    const escaped = deviceSerial.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}\\s+tcp:(9\\d{3})\\s+tcp:`, "m").exec(output);
    if (!match) throw new TestCoordinatorError("MOBILE_DRIVER_FAILED", "Handsets 本地端口未建立");
    return Number(match[1]);
  }

  private async adb(args: string[], timeoutMs: number): Promise<string> {
    this.assertTools();
    const result = await this.executor.run({
      executable: this.assets.adbPath,
      args,
      env: this.env,
      timeoutMs,
      outputLimitBytes: MAX_OUTPUT_BYTES,
    });
    if (!probeSucceeded(result)) driverFailure("adb", result);
    return result.stdout;
  }

  private assertSafeActionValue(value: string, label: string): void {
    if (!value.trim() || value.length > 10_000 || /[\0\r\n]/.test(value) || value.trimStart().startsWith("--")) {
      throw new TestCoordinatorError("BAD_REQUEST", `Android ${label} 无效`);
    }
  }

  private assertTools(): void {
    if (!this.assets.supported)
      throw new TestCoordinatorError("ANDROID_UNSUPPORTED", this.assets.error ?? "Android 驱动不可用");
    if (!this.assets.platformToolsInstalled) {
      throw new TestCoordinatorError("ANDROID_TOOLS_REQUIRED", "请先准备 Android platform-tools");
    }
  }

  private async requireDevice(deviceSerial: string): Promise<void> {
    const selected = (await this.devices()).find((device) => device.serial === serial(deviceSerial));
    if (!selected) throw new TestCoordinatorError("ANDROID_DEVICE_MISSING", "已选择的 Android 设备未连接");
    if (selected.state === "unauthorized")
      throw new TestCoordinatorError("ANDROID_UNAUTHORIZED", "请在手机上允许 USB 调试");
    if (selected.state !== "device") throw new TestCoordinatorError("ANDROID_OFFLINE", "Android 设备尚未就绪");
  }

  private async hs(args: string[], timeoutMs: number): Promise<string> {
    this.assertTools();
    const result = await this.executor.run({
      executable: this.assets.hsPath,
      args,
      cwd: path.dirname(this.assets.hsPath),
      env: this.env,
      timeoutMs,
      outputLimitBytes: MAX_OUTPUT_BYTES,
    });
    if (!probeSucceeded(result)) driverFailure("hs", result);
    return result.stdout;
  }
}
