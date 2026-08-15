import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lt, valid } from "semver";
import type { TestLicenseState } from "../contract/test-workbench.ts";

const IDENTITY_KEY = "device:license:identity";
const LICENSE_VERSION = 1;
const MAX_LICENSE_BYTES = 32 * 1024;
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const LICENSE_KEYS = [
  "deviceFingerprint",
  "features",
  "issuedAt",
  "licenseId",
  "minimumDesktopVersion",
  "signature",
  "status",
  "version",
];

interface DeviceIdentity {
  version: 1;
  privateKeyPkcs8: string;
}

export interface SignedDeviceLicense {
  version: 1;
  licenseId: string;
  deviceFingerprint: string;
  status: "active" | "revoked";
  issuedAt: string;
  features: string[];
  minimumDesktopVersion: string;
  signature: string;
}

interface LicenseCache {
  version: 1;
  checkedAt: string;
  license: SignedDeviceLicense;
}

interface VaultLike {
  get(key: string): Record<string, unknown> | null;
  set(key: string, value: Record<string, unknown>): void;
}

export interface DeviceLicenseServiceOptions {
  vault: VaultLike;
  cachePath: string;
  baseUrl: string;
  publicKey: string;
  appVersion: string;
  fetchImpl?: typeof fetch;
  bypass?: boolean;
  now?: () => Date;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

export class DeviceLicenseError extends Error {
  readonly code = "DEVICE_LICENSE_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "DeviceLicenseError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("License payload is not canonical JSON");
}

export function canonicalizeLicensePayload(license: Omit<SignedDeviceLicense, "signature">): Buffer {
  return Buffer.from(canonicalJson(license), "utf8");
}

function privateKeyFromVault(vault: VaultLike): KeyObject {
  const saved = vault.get(IDENTITY_KEY) as Partial<DeviceIdentity> | null;
  if (saved) {
    if (saved.version !== 1 || typeof saved.privateKeyPkcs8 !== "string") {
      throw new Error("Stored device identity is invalid");
    }
    const privateKey = createPrivateKey({
      key: Buffer.from(saved.privateKeyPkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Stored device identity is not Ed25519");
    return privateKey;
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  vault.set(IDENTITY_KEY, {
    version: 1,
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  return privateKey;
}

function fingerprintFor(privateKey: KeyObject): string {
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return createHash("sha256").update(publicDer).digest("hex");
}

function shortDeviceCode(fingerprint: string): string {
  return fingerprint
    .slice(0, 16)
    .toUpperCase()
    .match(/.{1,4}/g)!
    .join("-");
}

function parsePublicKey(value: string): KeyObject | null {
  if (!value) return null;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    return publicKey.asymmetricKeyType === "ed25519" ? publicKey : null;
  } catch {
    return null;
  }
}

function licensePayload(license: SignedDeviceLicense): Omit<SignedDeviceLicense, "signature"> {
  const { signature: _signature, ...payload } = license;
  return payload;
}

function parseLicense(value: unknown): SignedDeviceLicense {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("License must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== LICENSE_KEYS.join("\0")) {
    throw new Error("License fields are invalid");
  }
  if (
    record.version !== LICENSE_VERSION ||
    typeof record.licenseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(record.licenseId) ||
    typeof record.deviceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.deviceFingerprint) ||
    (record.status !== "active" && record.status !== "revoked") ||
    typeof record.issuedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(record.issuedAt) ||
    !Array.isArray(record.features) ||
    record.features.length > 32 ||
    !record.features.every((feature) => typeof feature === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(feature)) ||
    new Set(record.features).size !== record.features.length ||
    typeof record.minimumDesktopVersion !== "string" ||
    !valid(record.minimumDesktopVersion) ||
    typeof record.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(record.signature)
  ) {
    throw new Error("License values are invalid");
  }
  return record as unknown as SignedDeviceLicense;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LICENSE_BYTES) throw new Error("License is too large");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > MAX_LICENSE_BYTES) {
      await reader.cancel();
      throw new Error("License is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function validBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    return null;
  }
}

function initialState(deviceCode: string, phase: TestLicenseState["phase"], message: string): TestLicenseState {
  return {
    phase,
    authorized: phase === "authorized" || phase === "development_bypass",
    readOnly: phase !== "authorized" && phase !== "development_bypass",
    deviceCode,
    deviceFingerprint: null,
    checkedAt: null,
    lastValidAt: null,
    licenseId: null,
    message,
  };
}

export class DeviceLicenseService {
  private readonly options: DeviceLicenseServiceOptions;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: URL | null;
  private readonly authorizationKey: KeyObject | null;
  private readonly fingerprint: string;
  private readonly listeners = new Set<(state: TestLicenseState) => void>();
  private state: TestLicenseState;
  private refreshPromise: Promise<TestLicenseState> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastCheckStartedAt = 0;

  constructor(options: DeviceLicenseServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.baseUrl = validBaseUrl(options.baseUrl);
    this.authorizationKey = parsePublicKey(options.publicKey);

    try {
      this.fingerprint = fingerprintFor(privateKeyFromVault(options.vault));
      const deviceCode = shortDeviceCode(this.fingerprint);
      if (options.bypass) {
        this.state = initialState(deviceCode, "development_bypass", "开发模式授权旁路");
      } else if (!this.baseUrl || !this.authorizationKey) {
        this.state = initialState(deviceCode, "unconfigured", "此构建尚未配置设备授权服务");
      } else {
        this.state = initialState(deviceCode, "unlicensed", "尚未在线检查设备授权");
        this.loadCachedDisplayState();
      }
      this.state.deviceFingerprint = this.fingerprint;
    } catch (error) {
      this.fingerprint = "";
      this.state = initialState("不可用", "invalid", "设备安全存储不可用，无法建立设备身份");
      this.options.log?.(`device identity unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getState(): TestLicenseState {
    return { ...this.state };
  }

  getDeviceFingerprint(): string {
    return this.fingerprint;
  }

  subscribe(listener: (state: TestLicenseState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<TestLicenseState> {
    if (this.options.bypass || !this.baseUrl || !this.authorizationKey || !this.fingerprint) {
      return Promise.resolve(this.getState());
    }
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
      this.refreshTimer.unref();
    }
    return this.refresh();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async assertLicensed(): Promise<void> {
    if (this.options.bypass) return;
    if (this.refreshPromise) await this.refreshPromise;
    else if (
      this.lastCheckStartedAt === 0 ||
      this.now().getTime() - this.lastCheckStartedAt >= this.refreshIntervalMs
    ) {
      await this.refresh();
    }
    if (!this.state.authorized) throw new DeviceLicenseError(this.state.message);
  }

  refresh(): Promise<TestLicenseState> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.options.bypass || !this.baseUrl || !this.authorizationKey || !this.fingerprint) {
      return Promise.resolve(this.getState());
    }

    this.lastCheckStartedAt = this.now().getTime();
    this.updateState({ ...this.state, phase: "checking", message: "正在检查设备授权" });
    this.refreshPromise = this.checkOnline().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async checkOnline(): Promise<TestLicenseState> {
    const checkedAt = this.now().toISOString();
    const url = new URL(`licenses/${this.fingerprint}.json`, this.baseUrl!);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.redirected || (response.url && response.url !== url.href))
        throw new Error("License redirect rejected");
      if (response.status === 404) {
        await response.body?.cancel();
        return this.finishCheck("unlicensed", checkedAt, "当前设备尚未授权");
      }
      if (!response.ok) {
        await response.body?.cancel();
        return this.finishCheck("offline", checkedAt, "授权服务暂时不可用，请稍后重试");
      }

      const license = parseLicense(JSON.parse(await readBoundedBody(response)) as unknown);
      this.verifyLicense(license);
      if (license.status === "revoked") {
        this.writeCache({ version: 1, checkedAt, license });
        return this.finishCheck("revoked", checkedAt, "当前设备授权已被撤销", license.licenseId);
      }
      if (!license.features.includes("desktop-testing")) {
        return this.finishCheck("invalid", checkedAt, "授权未包含桌面测试功能", license.licenseId);
      }
      if (!valid(this.options.appVersion) || lt(this.options.appVersion, license.minimumDesktopVersion)) {
        return this.finishCheck("invalid", checkedAt, "当前桌面版本低于授权要求，请先更新应用", license.licenseId);
      }
      this.writeCache({ version: 1, checkedAt, license });
      this.updateState({
        ...this.state,
        phase: "authorized",
        authorized: true,
        readOnly: false,
        checkedAt,
        lastValidAt: checkedAt,
        licenseId: license.licenseId,
        message: "设备已授权",
      });
      return this.getState();
    } catch (error) {
      const invalid = error instanceof SyntaxError || /License|signature|fingerprint|issuedAt/i.test(String(error));
      this.options.log?.(`device license check failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.finishCheck(
        invalid ? "invalid" : "offline",
        checkedAt,
        invalid ? "授权文件无效或签名验证失败" : "无法连接授权服务，当前为只读模式",
      );
    }
  }

  private verifyLicense(license: SignedDeviceLicense): void {
    if (license.deviceFingerprint !== this.fingerprint) throw new Error("License fingerprint mismatch");
    const issuedAt = Date.parse(license.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt > this.now().getTime() + CLOCK_SKEW_MS) {
      throw new Error("License issuedAt is invalid");
    }
    const signature = Buffer.from(license.signature, "base64");
    if (!verify(null, canonicalizeLicensePayload(licensePayload(license)), this.authorizationKey!, signature)) {
      throw new Error("License signature is invalid");
    }
  }

  private finishCheck(
    phase: Exclude<TestLicenseState["phase"], "authorized" | "development_bypass" | "checking" | "unconfigured">,
    checkedAt: string,
    message: string,
    licenseId: string | null = null,
  ): TestLicenseState {
    this.updateState({
      ...this.state,
      phase,
      authorized: false,
      readOnly: true,
      checkedAt,
      licenseId,
      message,
    });
    return this.getState();
  }

  private loadCachedDisplayState(): void {
    try {
      const cache = JSON.parse(fs.readFileSync(this.options.cachePath, "utf8")) as Partial<LicenseCache>;
      if (cache.version !== 1 || typeof cache.checkedAt !== "string") return;
      const license = parseLicense(cache.license);
      this.verifyLicense(license);
      this.state = {
        ...this.state,
        lastValidAt: license.status === "active" ? cache.checkedAt : null,
        licenseId: license.licenseId,
        message: license.status === "revoked" ? "上次在线检查显示授权已撤销" : "等待本次启动在线检查",
      };
    } catch {
      // Cached licenses never authorize and invalid display cache is ignored.
    }
  }

  private writeCache(cache: LicenseCache): void {
    try {
      fs.mkdirSync(path.dirname(this.options.cachePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.cachePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, this.options.cachePath);
    } catch (error) {
      this.options.log?.(
        `device license cache write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private updateState(state: TestLicenseState): void {
    this.state = state;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}
