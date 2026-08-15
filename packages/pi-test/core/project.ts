import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { casesDir, findingsDir, mapPath, piTestDir, projectPath, runsDir } from "./paths.ts";
import { nowIso } from "./time.ts";
import { readYamlFile, writeYamlFile } from "./yaml.ts";

export type SurfaceName = "h5" | "admin" | "app" | "miniprogram";
export type ProjectEnvironment = "test" | "staging" | "production";

export interface SurfaceH5 {
  url: string | null;
  viewport?: string;
}

export interface SurfaceAdmin {
  url: string | null;
  viewport?: string;
}

export interface SurfaceApp {
  package: string | null;
  activity?: string | null;
  serial?: string | null;
}

export interface SurfaceMiniprogram {
  wechatPackage?: string;
  name: string | null;
  appId?: string | null;
  entry?: string | null;
}

export interface ProjectIdentity {
  name: string;
  surfaces: SurfaceName[];
}

export interface ProjectInputDecl {
  description?: string;
  secret?: boolean;
}

export interface VisualModelRef {
  provider: string;
  modelId: string;
}

export interface ProjectDefaults {
  regression?: string[];
  riskConfirm?: boolean;
  visualCheck?: boolean;
  visualModel?: VisualModelRef;
}

export interface ProjectZentao {
  connectionId: string;
  productId: number;
  moduleId?: number | null;
  openedBuild?: string | null;
  assignedTo?: string | null;
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  environment: ProjectEnvironment;
  createdAt: string;
  updatedAt: string;
  surfaces: {
    h5?: SurfaceH5;
    admin?: SurfaceAdmin;
    app?: SurfaceApp;
    miniprogram?: SurfaceMiniprogram;
  };
  identities: Record<string, ProjectIdentity>;
  defaultIdentityBySurface: Partial<Record<SurfaceName, string>>;
  inputs?: Record<string, ProjectInputDecl>;
  defaults?: ProjectDefaults;
  zentao?: ProjectZentao | null;
}

export type SurfaceReadinessCode =
  "surface_not_configured" | "url_missing" | "package_missing" | "miniprogram_name_missing";

export interface SurfaceReadiness {
  surface: SurfaceName;
  ready: boolean;
  code?: SurfaceReadinessCode;
  nextStep?: string;
}

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const IDENTITY_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ANDROID_PACKAGE_RE = /^(?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/;
const VIEWPORT_RE = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/;
const INPUT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const CONNECTION_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SURFACE_NAMES: SurfaceName[] = ["h5", "admin", "app", "miniprogram"];
const SURFACE_KEYS = new Set<string>(SURFACE_NAMES);
const TOP_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "environment",
  "createdAt",
  "updatedAt",
  "surfaces",
  "identities",
  "defaultIdentityBySurface",
  "inputs",
  "defaults",
  "zentao",
]);

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

export class SurfaceNotReadyError extends ProjectError {
  readonly readiness: SurfaceReadiness;

  constructor(readiness: SurfaceReadiness) {
    super(`${readiness.surface} 未就绪：${readiness.nextStep ?? readiness.code ?? "请完善配置"}`);
    this.readiness = readiness;
    this.name = "SurfaceNotReadyError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectError(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ProjectError(`${label} 未知字段: ${unknown.join(", ")}`);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown, label: string): void {
  if (value != null && typeof value !== "string") throw new ProjectError(`${label} 必须是字符串或 null`);
}

/** Upgrade the pre-desktop schema 1 shape in memory. New-format documents stay strict. */
export function migrateProjectSchema1(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== 1 || "environment" in source) return raw;

  const migrated = structuredClone(source);
  migrated.environment = "test";
  migrated.identities ??= {};
  migrated.defaultIdentityBySurface ??= {};
  if (migrated.defaults && typeof migrated.defaults === "object" && !Array.isArray(migrated.defaults)) {
    delete (migrated.defaults as Record<string, unknown>).allowBash;
  }
  return migrated;
}

export function validateProject(raw: unknown): Project {
  const o = record(migrateProjectSchema1(raw), "project.yaml");
  rejectUnknown(o, TOP_KEYS, "project.yaml");
  if (o.schemaVersion !== 1) throw new ProjectError("schemaVersion 必须是 1");
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new ProjectError("id 不合法");
  if (typeof o.name !== "string" || o.name.length < 1 || o.name.length > 80) throw new ProjectError("name 不合法");
  if (o.environment !== "test" && o.environment !== "staging" && o.environment !== "production") {
    throw new ProjectError("environment 必须是 test|staging|production");
  }
  if (!isIsoUtc(o.createdAt) || !isIsoUtc(o.updatedAt))
    throw new ProjectError("createdAt/updatedAt 必须是 UTC ISO 时间");

  const surfaces = record(o.surfaces, "surfaces");
  rejectUnknown(surfaces, SURFACE_KEYS, "surfaces");
  if (Object.keys(surfaces).length === 0) throw new ProjectError("至少需要一个 surface");

  for (const surface of ["h5", "admin"] as const) {
    if (!(surface in surfaces)) continue;
    const config = record(surfaces[surface], surface);
    rejectUnknown(config, new Set(["url", "viewport"]), surface);
    if (config.url !== null && (typeof config.url !== "string" || !isHttpUrl(config.url))) {
      throw new ProjectError(`${surface}.url 无效`);
    }
    if (config.viewport != null && (typeof config.viewport !== "string" || !VIEWPORT_RE.test(config.viewport))) {
      throw new ProjectError(`${surface}.viewport 无效`);
    }
  }

  if ("app" in surfaces) {
    const app = record(surfaces.app, "app");
    rejectUnknown(app, new Set(["package", "activity", "serial"]), "app");
    if (app.package !== null && (typeof app.package !== "string" || !ANDROID_PACKAGE_RE.test(app.package))) {
      throw new ProjectError("app.package 无效");
    }
    optionalString(app.activity, "app.activity");
    optionalString(app.serial, "app.serial");
  }

  if ("miniprogram" in surfaces) {
    const miniprogram = record(surfaces.miniprogram, "miniprogram");
    rejectUnknown(miniprogram, new Set(["wechatPackage", "name", "appId", "entry"]), "miniprogram");
    if (
      miniprogram.wechatPackage != null &&
      (typeof miniprogram.wechatPackage !== "string" || !ANDROID_PACKAGE_RE.test(miniprogram.wechatPackage))
    ) {
      throw new ProjectError("miniprogram.wechatPackage 无效");
    }
    optionalString(miniprogram.name, "miniprogram.name");
    optionalString(miniprogram.appId, "miniprogram.appId");
    optionalString(miniprogram.entry, "miniprogram.entry");
  }

  const identities = record(o.identities, "identities");
  for (const [identityId, value] of Object.entries(identities)) {
    if (!IDENTITY_ID_RE.test(identityId)) throw new ProjectError(`identity id 不合法: ${identityId}`);
    const identity = record(value, `identities.${identityId}`);
    rejectUnknown(identity, new Set(["name", "surfaces"]), `identities.${identityId}`);
    if (typeof identity.name !== "string" || identity.name.length < 1 || identity.name.length > 80) {
      throw new ProjectError(`identities.${identityId}.name 不合法`);
    }
    if (!Array.isArray(identity.surfaces) || identity.surfaces.length === 0) {
      throw new ProjectError(`identities.${identityId}.surfaces 至少 1 项`);
    }
    for (const surface of identity.surfaces) {
      if (typeof surface !== "string" || !SURFACE_KEYS.has(surface) || !(surface in surfaces)) {
        throw new ProjectError(`identities.${identityId} 引用了未配置 surface: ${String(surface)}`);
      }
    }
  }

  const defaultsBySurface = record(o.defaultIdentityBySurface, "defaultIdentityBySurface");
  rejectUnknown(defaultsBySurface, SURFACE_KEYS, "defaultIdentityBySurface");
  for (const [surface, identityId] of Object.entries(defaultsBySurface)) {
    if (!(surface in surfaces) || typeof identityId !== "string" || !identities[identityId]) {
      throw new ProjectError(`defaultIdentityBySurface.${surface} 无效`);
    }
    const identity = identities[identityId] as unknown as ProjectIdentity;
    if (!identity.surfaces.includes(surface as SurfaceName)) {
      throw new ProjectError(`identity ${identityId} 不适用于 ${surface}`);
    }
  }

  if (o.inputs != null) {
    const inputs = record(o.inputs, "inputs");
    for (const [key, value] of Object.entries(inputs)) {
      if (!INPUT_KEY_RE.test(key)) throw new ProjectError(`inputs 键不合法: ${key}`);
      const input = record(value, `inputs.${key}`);
      rejectUnknown(input, new Set(["description", "secret"]), `inputs.${key}`);
      optionalString(input.description, `inputs.${key}.description`);
      if (input.secret != null && typeof input.secret !== "boolean") {
        throw new ProjectError(`inputs.${key}.secret 必须是布尔`);
      }
    }
  }

  if (o.defaults != null) {
    const defaults = record(o.defaults, "defaults");
    rejectUnknown(defaults, new Set(["regression", "riskConfirm", "visualCheck", "visualModel"]), "defaults");
    if (
      defaults.regression != null &&
      (!Array.isArray(defaults.regression) ||
        defaults.regression.some((id) => typeof id !== "string" || !ID_RE.test(id)))
    ) {
      throw new ProjectError("defaults.regression 必须是 case id 数组");
    }
    if (defaults.riskConfirm != null && typeof defaults.riskConfirm !== "boolean") {
      throw new ProjectError("defaults.riskConfirm 必须是布尔");
    }
    if (defaults.visualCheck != null && typeof defaults.visualCheck !== "boolean") {
      throw new ProjectError("defaults.visualCheck 必须是布尔");
    }
    if (defaults.visualModel != null) {
      const visualModel = record(defaults.visualModel, "defaults.visualModel");
      rejectUnknown(visualModel, new Set(["provider", "modelId"]), "defaults.visualModel");
      for (const key of ["provider", "modelId"] as const) {
        const value = visualModel[key];
        if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\0\r\n]/.test(value)) {
          throw new ProjectError(`defaults.visualModel.${key} 无效`);
        }
      }
    }
  }

  if (o.zentao != null) {
    const zentao = record(o.zentao, "zentao");
    rejectUnknown(zentao, new Set(["connectionId", "productId", "moduleId", "openedBuild", "assignedTo"]), "zentao");
    if (typeof zentao.connectionId !== "string" || !CONNECTION_ID_RE.test(zentao.connectionId)) {
      throw new ProjectError("zentao.connectionId 无效");
    }
    if (!Number.isSafeInteger(zentao.productId) || (zentao.productId as number) < 1) {
      throw new ProjectError("zentao.productId 无效");
    }
    if (zentao.moduleId != null && (!Number.isSafeInteger(zentao.moduleId) || (zentao.moduleId as number) < 0)) {
      throw new ProjectError("zentao.moduleId 无效");
    }
    if (
      zentao.openedBuild != null &&
      (typeof zentao.openedBuild !== "string" || !/^(?:trunk|[1-9][0-9]{0,9})$/.test(zentao.openedBuild))
    ) {
      throw new ProjectError("zentao.openedBuild 无效");
    }
    if (
      zentao.assignedTo != null &&
      (typeof zentao.assignedTo !== "string" || zentao.assignedTo.length > 100 || /[\0\r\n]/.test(zentao.assignedTo))
    ) {
      throw new ProjectError("zentao.assignedTo 无效");
    }
  }

  return o as unknown as Project;
}

export function loadProject(root: string): Project {
  const path = projectPath(root);
  if (!existsSync(path)) throw new ProjectError("当前目录没有 project.yaml");
  try {
    return validateProject(readYamlFile(path));
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(`读 project.yaml 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function tryLoadProject(root: string): Project | null {
  try {
    return loadProject(root);
  } catch {
    return null;
  }
}

export function surfaceNames(project: Project): SurfaceName[] {
  return SURFACE_NAMES.filter((surface) => project.surfaces[surface] !== undefined);
}

export function updateProjectConfiguration(
  root: string,
  input: {
    name: string;
    environment: ProjectEnvironment;
    surfaces: Array<"h5" | "admin" | "app">;
    h5Url?: string | null;
    adminUrl?: string | null;
    visualCheck?: boolean;
    visualModel?: VisualModelRef | null;
  },
): Project {
  const project = loadProject(root);
  const selected = new Set(input.surfaces);
  if (selected.size === 0) throw new ProjectError("至少需要一个 surface");
  const next = structuredClone(project);
  next.name = input.name;
  next.environment = input.environment;
  next.surfaces = {
    ...(selected.has("h5")
      ? { h5: { url: input.h5Url ?? null, viewport: project.surfaces.h5?.viewport ?? "390x844" } }
      : {}),
    ...(selected.has("admin")
      ? { admin: { url: input.adminUrl ?? null, viewport: project.surfaces.admin?.viewport ?? "1440x900" } }
      : {}),
    ...(selected.has("app") ? { app: project.surfaces.app ?? { package: null, activity: null, serial: null } } : {}),
  };
  if (input.visualCheck !== undefined) next.defaults = { ...next.defaults, visualCheck: input.visualCheck };
  if (input.visualModel !== undefined) {
    next.defaults = { ...next.defaults };
    if (input.visualModel === null) delete next.defaults.visualModel;
    else next.defaults.visualModel = input.visualModel;
  }
  next.updatedAt = nowIso();
  validateProject(next);
  writeYamlFile(projectPath(root), next);
  return next;
}

export function setProjectIdentity(
  root: string,
  identityId: string,
  identity: ProjectIdentity,
  defaultSurfaces: SurfaceName[],
): Project {
  if (!IDENTITY_ID_RE.test(identityId)) throw new ProjectError("identity id 不合法");
  const project = loadProject(root);
  const next = structuredClone(project);
  next.identities[identityId] = identity;
  for (const surface of SURFACE_NAMES) {
    if (next.defaultIdentityBySurface[surface] === identityId && !defaultSurfaces.includes(surface)) {
      delete next.defaultIdentityBySurface[surface];
    }
  }
  for (const surface of defaultSurfaces) next.defaultIdentityBySurface[surface] = identityId;
  next.updatedAt = nowIso();
  validateProject(next);
  writeYamlFile(projectPath(root), next);
  return next;
}

export function deleteProjectIdentity(root: string, identityId: string): Project {
  if (!IDENTITY_ID_RE.test(identityId)) throw new ProjectError("identity id 不合法");
  const project = loadProject(root);
  if (!project.identities[identityId]) throw new ProjectError("identity 不存在");
  const next = structuredClone(project);
  delete next.identities[identityId];
  for (const surface of SURFACE_NAMES) {
    if (next.defaultIdentityBySurface[surface] === identityId) delete next.defaultIdentityBySurface[surface];
  }
  next.updatedAt = nowIso();
  validateProject(next);
  writeYamlFile(projectPath(root), next);
  return next;
}

export function updateAppSurface(
  root: string,
  patch: { package?: string | null; serial: string; activity?: string | null },
): Project {
  const project = loadProject(root);
  if (!project.surfaces.app) throw new ProjectError("项目未选择 App 测试端");
  const next = structuredClone(project);
  next.surfaces.app = {
    package: patch.package === undefined ? project.surfaces.app.package : patch.package,
    serial: patch.serial,
    activity: patch.activity === undefined ? (project.surfaces.app.activity ?? null) : patch.activity,
  };
  next.updatedAt = nowIso();
  validateProject(next);
  writeYamlFile(projectPath(root), next);
  return next;
}

export function setProjectZentao(root: string, zentao: ProjectZentao | null): Project {
  const project = loadProject(root);
  const next = structuredClone(project);
  next.zentao = zentao;
  next.updatedAt = nowIso();
  validateProject(next);
  writeYamlFile(projectPath(root), next);
  return next;
}

export function needsWeb(project: Project | null): boolean {
  return !project || project.surfaces.h5 !== undefined || project.surfaces.admin !== undefined;
}

export function needsMobile(project: Project | null): boolean {
  return !project || project.surfaces.app !== undefined || project.surfaces.miniprogram !== undefined;
}

export function getSurfaceReadiness(project: Project, surface: SurfaceName): SurfaceReadiness {
  if (!project.surfaces[surface]) {
    return { surface, ready: false, code: "surface_not_configured", nextStep: "项目未选择该测试端" };
  }
  if ((surface === "h5" && !project.surfaces.h5?.url) || (surface === "admin" && !project.surfaces.admin?.url)) {
    return { surface, ready: false, code: "url_missing", nextStep: "请先填写测试地址" };
  }
  if (surface === "app" && !project.surfaces.app?.package) {
    return { surface, ready: false, code: "package_missing", nextStep: "请连接手机并选择测试 App" };
  }
  if (surface === "miniprogram" && !project.surfaces.miniprogram?.name) {
    return { surface, ready: false, code: "miniprogram_name_missing", nextStep: "请先填写小程序名称" };
  }
  return { surface, ready: true };
}

export function requireSurfaceReady<S extends SurfaceName>(
  project: Project,
  surface: S,
): NonNullable<Project["surfaces"][S]> {
  const readiness = getSurfaceReadiness(project, surface);
  if (!readiness.ready) throw new SurfaceNotReadyError(readiness);
  return project.surfaces[surface] as NonNullable<Project["surfaces"][S]>;
}

export const MAP_TEMPLATE = `# 业务地图

## 模块

- 待补充

## 主流程

- 待补充

## 角色

- 待补充

## 待确认

- 待补充
`;

export interface NewProjectOpts {
  id: string;
  name: string;
  environment?: ProjectEnvironment;
  surfaces?: SurfaceName[];
  h5Url?: string | null;
  adminUrl?: string | null;
  appPackage?: string | null;
  appActivity?: string | null;
  miniprogramName?: string | null;
  identities?: Record<string, ProjectIdentity>;
  defaultIdentityBySurface?: Partial<Record<SurfaceName, string>>;
  visualCheck?: boolean;
  visualModel?: VisualModelRef | null;
}

export function createProject(root: string, opts: NewProjectOpts): Project {
  if (existsSync(projectPath(root))) throw new ProjectError("已有 project.yaml，换目录或先清理");
  if (!ID_RE.test(opts.id)) throw new ProjectError("id 不合法（小写字母开头，字母数字连字符）");

  const selected = new Set(opts.surfaces ?? []);
  if (opts.h5Url !== undefined) selected.add("h5");
  if (opts.adminUrl !== undefined) selected.add("admin");
  if (opts.appPackage !== undefined) selected.add("app");
  if (opts.miniprogramName !== undefined) selected.add("miniprogram");
  if (selected.size === 0) throw new ProjectError("至少选择一个 surface");

  const surfaces: Project["surfaces"] = {};
  if (selected.has("h5")) surfaces.h5 = { url: opts.h5Url ?? null, viewport: "390x844" };
  if (selected.has("admin")) surfaces.admin = { url: opts.adminUrl ?? null, viewport: "1440x900" };
  if (selected.has("app")) {
    surfaces.app = { package: opts.appPackage ?? null, activity: opts.appActivity ?? null, serial: null };
  }
  if (selected.has("miniprogram")) {
    surfaces.miniprogram = {
      name: opts.miniprogramName ?? null,
      wechatPackage: "com.tencent.mm",
      appId: null,
      entry: null,
    };
  }

  const timestamp = nowIso();
  const project: Project = {
    schemaVersion: 1,
    id: opts.id,
    name: opts.name,
    environment: opts.environment ?? "test",
    createdAt: timestamp,
    updatedAt: timestamp,
    surfaces,
    identities: opts.identities ?? {},
    defaultIdentityBySurface: opts.defaultIdentityBySurface ?? {},
    inputs: {},
    defaults: {
      regression: [],
      riskConfirm: true,
      visualCheck: opts.visualCheck ?? false,
      ...(opts.visualModel ? { visualModel: opts.visualModel } : {}),
    },
  };
  validateProject(project);

  mkdirSync(casesDir(root), { recursive: true });
  mkdirSync(runsDir(root), { recursive: true });
  mkdirSync(findingsDir(root), { recursive: true });
  mkdirSync(piTestDir(root), { recursive: true });
  writeYamlFile(projectPath(root), project);
  writeFileSync(mapPath(root), MAP_TEMPLATE);
  const gitignore = join(root, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, [".secrets/", ".pi-test/active-run", ""].join("\n"));
  return project;
}
