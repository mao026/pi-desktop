import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BUG_SEARCH_PAGES = 10;
const ZENTAO_18_BUG_REQUIRED_FIELDS = ["title", "pri", "severity", "type", "openedBuild"];
const BUG_CREATE_FIELDS = new Set([
  "title",
  "pri",
  "severity",
  "type",
  "keywords",
  "steps",
  "openedBuild",
  "product",
  "module",
  "assignedTo",
]);

export type ZentaoFetch = typeof fetch;

export interface ZentaoConnectionConfig {
  baseUrl: string;
  token: string;
}

export interface ZentaoItem {
  id: string;
  name: string;
}

export interface ZentaoCapabilities {
  apiV1: boolean;
  tokenAuth: boolean;
  products: boolean;
  modules: boolean;
  releases: boolean;
  users: boolean;
  bugOptions: boolean;
  requiredFields: boolean;
  createBug: boolean;
  attachments: "verify_on_write" | "supported" | "unavailable";
  comments: "verify_on_write" | "supported" | "unavailable";
  bugRequiredFields: string[];
  unsupportedBugFields: string[];
}

export interface ZentaoProbeResult {
  connected: boolean;
  version: string | null;
  edition: string | null;
  products: ZentaoItem[];
  users: ZentaoItem[];
  capabilities: ZentaoCapabilities;
}

export interface ZentaoCatalog extends ZentaoProbeResult {
  modules: ZentaoItem[];
  releases: ZentaoItem[];
  builds: ZentaoItem[];
  bugTypes: ZentaoItem[];
}

export interface ZentaoBug {
  id: number;
  title: string;
  status: string;
  url: string;
  raw: Record<string, unknown>;
}

export interface ZentaoCreateBugInput {
  productId: number;
  title: string;
  steps: string;
  severity: number;
  priority: number;
  type: string;
  moduleId?: number | null;
  openedBuild?: string | null;
  assignedTo?: string | null;
  marker: string;
}

export class ZentaoError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ZentaoError";
  }
}

export function isUnsafeZentaoHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1") {
    return true;
  }
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (isIP(host) === 6) {
    const mapped = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      return isUnsafeZentaoHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    const dotted = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
    if (dotted) return isUnsafeZentaoHost(dotted[1]!);
    return (
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("ff")
    );
  }
  return false;
}

export function normalizeZentaoBaseUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2_048 || /[\0\r\n]/.test(value)) {
    throw new ZentaoError("BAD_URL", "禅道地址无效");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ZentaoError("BAD_URL", "禅道地址无效");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ZentaoError("BAD_URL", "禅道地址必须是不含账号、查询参数或片段的 HTTP(S) 地址");
  }
  if (isUnsafeZentaoHost(url.hostname)) {
    throw new ZentaoError("UNSAFE_URL", "禅道地址不能指向本机、链路本地或组播地址");
  }
  url.pathname = url.pathname
    .replace(/\/user-login-[A-Za-z0-9_-]+\.html$/i, "")
    .replace(/\/+$/, "")
    .replace(/\/api\.php\/v1$/i, "");
  return url.href.replace(/\/$/, "");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ZentaoError("INVALID_RESPONSE", `禅道 ${label} 响应格式无效`);
  }
  return value as Record<string, unknown>;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 1_000);
  if (Array.isArray(value)) return value.map(errorText).join("; ").slice(0, 1_000);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(errorText)
      .filter(Boolean)
      .join("; ")
      .slice(0, 1_000);
  }
  return "禅道请求失败";
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new ZentaoError("RESPONSE_TOO_LARGE", "禅道响应过大");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw new ZentaoError("RESPONSE_TOO_LARGE", "禅道响应过大");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ZentaoError("INVALID_RESPONSE", "禅道返回了非 JSON 响应");
  }
}

function items(value: unknown, preferredName = "name"): ZentaoItem[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
          entry && typeof entry === "object"
            ? { id: key, ...(entry as Record<string, unknown>) }
            : { id: key, name: entry },
        )
      : [];
  return source.flatMap((entry): ZentaoItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const id = row.id ?? row.account;
    const name = row[preferredName] ?? row.realname ?? row.title ?? row.name ?? id;
    if ((typeof id !== "string" && typeof id !== "number") || (typeof name !== "string" && typeof name !== "number"))
      return [];
    return [{ id: String(id), name: String(name) }];
  });
}

function nestedModules(value: unknown): ZentaoItem[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nestedModules);
  const row = value as Record<string, unknown>;
  const own = row.id != null && (row.name != null || row.title != null) ? items([row]) : [];
  if (own.length > 0) {
    return [...own, ...Object.values(row).flatMap(nestedModules)].filter(
      (entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index,
    );
  }
  if (Object.values(row).every((entry) => typeof entry === "string" || typeof entry === "number")) {
    return items(row);
  }
  return Object.values(row)
    .flatMap(nestedModules)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
}

function configValue(configs: unknown, key: string): string | null {
  if (!Array.isArray(configs)) return null;
  const found = configs.find(
    (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).key === key,
  ) as Record<string, unknown> | undefined;
  return typeof found?.value === "string" ? found.value : null;
}

function requiredBugFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const bug = (value as Record<string, unknown>).bug;
  if (!bug || typeof bug !== "object" || Array.isArray(bug)) return [];
  const create = (bug as Record<string, unknown>).create;
  if (!create || typeof create !== "object" || Array.isArray(create)) return [];
  const fields = (create as Record<string, unknown>).fields;
  return Array.isArray(fields) ? fields.filter((field): field is string => typeof field === "string") : [];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function bugFrom(value: unknown, baseUrl: string): ZentaoBug {
  const row = object(value, "Bug");
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id < 1 || typeof row.title !== "string") {
    throw new ZentaoError("INVALID_RESPONSE", "禅道 Bug 响应缺少 id 或 title");
  }
  return {
    id,
    title: row.title,
    status: typeof row.status === "string" ? row.status : "unknown",
    url: `${baseUrl}/index.php?m=bug&f=view&bugID=${id}`,
    raw: row,
  };
}

export class ZentaoClient {
  readonly baseUrl: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: ZentaoFetch;

  constructor(config: ZentaoConnectionConfig, fetchImpl: ZentaoFetch = fetch) {
    this.baseUrl = normalizeZentaoBaseUrl(config.baseUrl);
    if (
      typeof config.token !== "string" ||
      !config.token ||
      config.token.length > 4_096 ||
      /[\0\r\n]/.test(config.token)
    ) {
      throw new ZentaoError("BAD_TOKEN", "禅道 Token 无效");
    }
    this.token = config.token;
    this.apiUrl = `${this.baseUrl}/api.php/v1`;
    this.fetchImpl = fetchImpl;
  }

  private readonly token: string;

  static async exchangeToken(
    baseUrl: string,
    account: string,
    password: string,
    fetchImpl: ZentaoFetch = fetch,
  ): Promise<string> {
    const normalized = normalizeZentaoBaseUrl(baseUrl);
    if (
      !account ||
      account.length > 200 ||
      /[\0\r\n]/.test(account) ||
      !password ||
      password.length > 4_096 ||
      /\0/.test(password)
    ) {
      throw new ZentaoError("BAD_CREDENTIALS", "禅道账号或密码无效");
    }
    const client = new ZentaoClient({ baseUrl: normalized, token: "token-exchange" }, fetchImpl);
    let response: unknown;
    try {
      response = await client.request("POST", "/tokens", { json: { account, password }, authenticated: false });
    } catch (error) {
      if (error instanceof ZentaoError) throw new ZentaoError(error.code, "禅道认证失败", error.status);
      throw new ZentaoError("NETWORK", "禅道认证失败");
    }
    const result = object(response, "Token");
    if (typeof result.token !== "string" || !result.token || result.token.length > 4_096) {
      throw new ZentaoError("INVALID_RESPONSE", "禅道未返回有效 Token");
    }
    return result.token;
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    options: { json?: Record<string, unknown>; form?: FormData; authenticated?: boolean } = {},
  ): Promise<unknown> {
    if (!/^\/[A-Za-z0-9/?=&._~-]*$/.test(path) || path.includes(".."))
      throw new ZentaoError("BAD_PATH", "禅道 API 路径无效");
    const url = `${this.apiUrl}${path}`;
    const headers = new Headers({ accept: "application/json" });
    if (options.authenticated !== false) headers.set("Token", this.token);
    let body: string | FormData | undefined;
    if (options.json) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof ZentaoError) throw error;
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ZentaoError(timedOut ? "TIMEOUT" : "NETWORK", timedOut ? "禅道请求超时" : "无法连接禅道");
    }
    if (response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new ZentaoError("REDIRECT_REJECTED", "禅道 API 重定向已拒绝");
    }
    const data = await readJson(response);
    if (!response.ok) {
      const rawMessage =
        data && typeof data === "object" ? errorText((data as Record<string, unknown>).error ?? data) : "禅道请求失败";
      const message = this.token ? rawMessage.replaceAll(this.token, "[REDACTED]") : rawMessage;
      throw new ZentaoError(response.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR", message, response.status);
    }
    return data;
  }

  async probe(): Promise<ZentaoProbeResult> {
    await this.request("GET", "/ping");
    const productsResponse = await this.request("GET", "/products?limit=100&page=1");
    const results = await Promise.allSettled([
      this.request("GET", "/configurations"),
      this.request("GET", "/users?limit=0"),
      this.request("GET", "/requiredFields"),
    ]);
    const configs = results[0].status === "fulfilled" ? results[0].value : null;
    const usersResponse = results[1].status === "fulfilled" ? results[1].value : null;
    const requiredResponse = results[2].status === "fulfilled" ? results[2].value : null;
    const productsObject = object(productsResponse, "产品目录");
    const usersObject =
      usersResponse && typeof usersResponse === "object" ? (usersResponse as Record<string, unknown>) : {};
    const version = configValue(configs, "version");
    const required = results[2].status === "fulfilled";
    const requiredFailure = results[2].status === "rejected" ? results[2].reason : null;
    const legacyRequiredFields =
      !required &&
      /^18(?:\.|$)/.test(version ?? "") &&
      requiredFailure instanceof ZentaoError &&
      (requiredFailure.status === 404 || requiredFailure.status === 405);
    const bugRequiredFields = required
      ? requiredBugFields(requiredResponse)
      : legacyRequiredFields
        ? ZENTAO_18_BUG_REQUIRED_FIELDS
        : [];
    const unsupportedBugFields = bugRequiredFields.filter((field) => !BUG_CREATE_FIELDS.has(field));
    return {
      connected: true,
      version,
      edition: configValue(configs, "edition"),
      products: items(productsObject.products),
      users: items(usersObject.users, "realname"),
      capabilities: {
        apiV1: true,
        tokenAuth: true,
        products: true,
        modules: false,
        releases: false,
        users: results[1].status === "fulfilled",
        bugOptions: false,
        requiredFields: required,
        createBug: (required || legacyRequiredFields) && unsupportedBugFields.length === 0,
        attachments: "verify_on_write",
        comments: "unavailable",
        bugRequiredFields,
        unsupportedBugFields,
      },
    };
  }

  async catalog(productId: number): Promise<ZentaoCatalog> {
    if (!Number.isSafeInteger(productId) || productId < 1) throw new ZentaoError("BAD_PRODUCT", "禅道产品无效");
    const probe = await this.probe();
    const [modulesResult, releasesResult, optionsResult] = await Promise.allSettled([
      this.request("GET", `/modules?type=bug&id=${productId}`),
      this.request("GET", `/products/${productId}/releases?limit=100&page=1`),
      this.request("GET", `/options/bug?product=${productId}`),
    ]);
    const modulesValue = modulesResult.status === "fulfilled" ? modulesResult.value : null;
    const releasesValue = releasesResult.status === "fulfilled" ? releasesResult.value : null;
    const optionsValue = optionsResult.status === "fulfilled" ? optionsResult.value : null;
    const modulesObject =
      modulesValue && typeof modulesValue === "object" ? (modulesValue as Record<string, unknown>) : {};
    const releasesObject =
      releasesValue && typeof releasesValue === "object" ? (releasesValue as Record<string, unknown>) : {};
    const optionsObject =
      optionsValue && typeof optionsValue === "object" ? (optionsValue as Record<string, unknown>) : {};
    const bugOptions =
      optionsObject.options && typeof optionsObject.options === "object"
        ? (optionsObject.options as Record<string, unknown>)
        : {};
    const modules = nestedModules(modulesObject.modules ?? bugOptions.modules);
    const releases = items(releasesObject.releases, "name");
    const builds = items(bugOptions.build, "name");
    const bugTypes = items(bugOptions.type, "name");
    return {
      ...probe,
      modules,
      releases,
      builds,
      bugTypes,
      capabilities: {
        ...probe.capabilities,
        modules: modulesResult.status === "fulfilled",
        releases: releasesResult.status === "fulfilled",
        bugOptions: optionsResult.status === "fulfilled",
        createBug: probe.capabilities.createBug && optionsResult.status === "fulfilled" && bugTypes.length > 0,
      },
    };
  }

  async getBug(bugId: number): Promise<ZentaoBug> {
    if (!Number.isSafeInteger(bugId) || bugId < 1) throw new ZentaoError("BAD_BUG", "禅道 Bug ID 无效");
    return bugFrom(await this.request("GET", `/bugs/${bugId}`), this.baseUrl);
  }

  async findBugByMarker(productId: number, marker: string): Promise<ZentaoBug | null> {
    if (
      !Number.isSafeInteger(productId) ||
      productId < 1 ||
      !/^Pi-Test: [a-z][a-z0-9-]{1,63}\/[a-z][a-z0-9-]{1,63}$/.test(marker)
    ) {
      throw new ZentaoError("BAD_MARKER", "禅道来源标识无效");
    }
    // ponytail: scans the newest 1,000 bugs; add a server-side marker index if old-marker recovery becomes necessary.
    for (let page = 1; page <= MAX_BUG_SEARCH_PAGES; page += 1) {
      const response = object(
        await this.request("GET", `/products/${productId}/bugs?status=all&limit=100&page=${page}`),
        "Bug 列表",
      );
      const bugs = Array.isArray(response.bugs) ? response.bugs : [];
      for (const value of bugs) {
        if (!value || typeof value !== "object") continue;
        const row = value as Record<string, unknown>;
        if ([row.steps, row.title, row.keywords].some((field) => typeof field === "string" && field.includes(marker))) {
          return bugFrom(row, this.baseUrl);
        }
      }
      const total = Number(response.total);
      const limit = Number(response.limit) || 100;
      if (bugs.length < limit || (Number.isFinite(total) && page * limit >= total)) break;
    }
    return null;
  }

  async createBug(input: ZentaoCreateBugInput): Promise<{ bug: ZentaoBug; existing: boolean }> {
    const existing = await this.findBugByMarker(input.productId, input.marker);
    if (existing) return { bug: existing, existing: true };
    const body: Record<string, unknown> = {
      product: input.productId,
      title: input.title,
      steps: `<p>${escapeHtml(input.steps).replaceAll("\n", "<br>")}</p><p>${escapeHtml(input.marker)}</p>`,
      severity: input.severity,
      pri: input.priority,
      type: input.type,
      openedBuild: [input.openedBuild || "trunk"],
      keywords: input.marker,
    };
    if (input.moduleId) body.module = input.moduleId;
    if (input.assignedTo) body.assignedTo = input.assignedTo;
    try {
      return {
        bug: bugFrom(await this.request("POST", `/products/${input.productId}/bugs`, { json: body }), this.baseUrl),
        existing: false,
      };
    } catch (error) {
      const recovered = await this.findBugByMarker(input.productId, input.marker).catch(() => null);
      if (recovered) return { bug: recovered, existing: true };
      throw error;
    }
  }

  async attachFiles(
    bugId: number,
    files: Array<{ name: string; type: string; bytes: Uint8Array }>,
  ): Promise<ZentaoBug> {
    if (files.length === 0) return this.getBug(bugId);
    const uid = `pitest${randomUUID().replaceAll("-", "")}`;
    const uploadedIds: number[] = [];
    for (const file of files) {
      const form = new FormData();
      const bytes = Uint8Array.from(file.bytes);
      form.append("imgFile", new Blob([bytes.buffer], { type: file.type }), file.name);
      const uploaded = object(await this.request("POST", `/files?uid=${uid}`, { form }), "附件");
      const id = Number(uploaded.id);
      if (!Number.isSafeInteger(id) || id < 1)
        throw new ZentaoError("ATTACHMENT_UNSUPPORTED", "禅道附件接口未返回文件 ID");
      uploadedIds.push(id);
    }
    await this.request("PUT", `/bugs/${bugId}`, { json: { uid } });
    const bug = await this.getBug(bugId);
    const rawFiles = Array.isArray(bug.raw.files)
      ? bug.raw.files
      : bug.raw.files && typeof bug.raw.files === "object"
        ? Object.values(bug.raw.files)
        : [];
    const linkedIds = rawFiles.flatMap((file) => {
      if (!file || typeof file !== "object") return [];
      const id = Number((file as Record<string, unknown>).id);
      return Number.isSafeInteger(id) ? [id] : [];
    });
    if (!uploadedIds.every((id) => linkedIds.includes(id))) {
      throw new ZentaoError("ATTACHMENT_UNSUPPORTED", "禅道未将已上传证据关联到 Bug");
    }
    return bug;
  }

  async appendComment(bugId: number, comment: string): Promise<ZentaoBug> {
    if (!comment.trim() || comment.length > 20_000 || /\0/.test(comment))
      throw new ZentaoError("BAD_COMMENT", "复测备注无效");
    const marker = `Pi-Test-Retest: ${randomUUID()}`;
    await this.request("PUT", `/bugs/${bugId}`, { json: { comment: `${comment}\n${marker}` } });
    const bug = await this.getBug(bugId);
    const actions = Array.isArray(bug.raw.actions) ? bug.raw.actions : [];
    const written = actions.some(
      (action) =>
        action &&
        typeof action === "object" &&
        String((action as Record<string, unknown>).comment ?? "").includes(marker),
    );
    if (!written)
      throw new ZentaoError("COMMENT_UNSUPPORTED", "当前禅道版本的现代 REST API 未提供可验证的 Bug 备注写入");
    return bug;
  }
}
