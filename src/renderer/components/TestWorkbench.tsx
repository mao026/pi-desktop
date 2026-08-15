import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Bug,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  ClipboardCheck,
  Hand,
  Pause,
  Download,
  Copy,
  Link2,
  ExternalLink,
  Eye,
  FileCheck2,
  FolderOpen,
  Gauge,
  Image,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  Map,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  X,
  XCircle,
} from "lucide-react";
import type {
  TestWorkbenchBrowserState,
  TestLicenseState,
  TestWorkbenchFindingInput,
  TestWorkbenchMobileState,
  TestWorkbenchProject,
  TestWorkbenchZentaoBugDraft,
  TestWorkbenchZentaoCatalog,
  TestWorkbenchZentaoConnection,
} from "@contract/test-workbench";
import type { SessionInfo } from "@/lib/types";
import { agentState, getModelPreferences, newAgent } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";
import { ModelsConfig } from "./ModelsConfig";
import "./test-workbench.css";

type WorkspaceView = "workbench" | "map" | "cases" | "runs" | "findings" | "identities" | "zentao";
type WorkbenchSurface = "h5" | "admin" | "app";
type Operation = "license" | "browser" | "mobile" | "run" | "observe" | "evidence" | "finish" | "finding" | null;

const NAV_ITEMS: Array<{ id: WorkspaceView; label: string; icon: typeof Gauge }> = [
  { id: "workbench", label: "工作台", icon: Gauge },
  { id: "map", label: "业务地图", icon: Map },
  { id: "cases", label: "测试用例", icon: ListChecks },
  { id: "runs", label: "执行记录", icon: ClipboardCheck },
  { id: "findings", label: "问题", icon: Bug },
  { id: "identities", label: "测试身份", icon: Users },
  { id: "zentao", label: "禅道", icon: Link2 },
];

const ENVIRONMENT_LABEL = { test: "测试环境", staging: "预发布环境", production: "生产环境" } as const;
const RUN_STATUS_LABEL: Record<string, string> = {
  in_progress: "自动测试中",
  passed: "已通过",
  failed: "未通过",
  blocked: "已阻塞",
  aborted: "意外中断",
};
const RUN_CONTROL_LABEL: Record<string, string> = {
  running: "自动测试中",
  pause_requested: "当前步骤后暂停",
  takeover_requested: "正在停止自动操作",
  paused: "已暂停",
  waiting_for_user: "等待用户操作",
  resuming: "正在重新感知",
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function temporarySession(project: Pick<TestWorkbenchProject, "root" | "name">, sessionId: string): SessionInfo {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    path: "",
    cwd: project.root,
    projectRoot: project.root,
    name: `${project.name} 测试对话`,
    created: now,
    modified: now,
    messageCount: 0,
    firstMessage: "测试工作台",
  };
}

export function TestWorkbench() {
  const [projects, setProjects] = useState<TestWorkbenchProject[]>([]);
  const [project, setProject] = useState<TestWorkbenchProject | null>(null);
  const [license, setLicense] = useState<TestLicenseState | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>("workbench");
  const [surface, setSurface] = useState<WorkbenchSurface>("h5");
  const [browser, setBrowser] = useState<TestWorkbenchBrowserState | null>(null);
  const [mobile, setMobile] = useState<TestWorkbenchMobileState | null>(null);
  const [browserNotice, setBrowserNotice] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<Operation>(null);
  const [regressionRunning, setRegressionRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observation, setObservation] = useState<string>("");
  const [latestEvidence, setLatestEvidence] = useState<string | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<{
    path: string;
    dataUrl: string | null;
    text: string | null;
  } | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [deleteProject, setDeleteProject] = useState<TestWorkbenchProject | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [findingOpen, setFindingOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState<string | null | false>(false);
  const [zentaoConnectionOpen, setZentaoConnectionOpen] = useState<string | null | false>(false);
  const [zentaoConnections, setZentaoConnections] = useState<TestWorkbenchZentaoConnection[]>([]);
  const [zentaoBugOpen, setZentaoBugOpen] = useState<string | false>(false);
  const [zentaoRetestOpen, setZentaoRetestOpen] = useState<string | false>(false);
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  const refreshRecent = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await window.piBridge.listRecentProjects());
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRecent();
    void window.piBridge
      .getTestLicenseState()
      .then(setLicense)
      .catch(() => undefined);
    return window.piBridge.onTestLicenseState(setLicense);
  }, [refreshRecent]);

  const refreshLicense = useCallback(async () => {
    setOperation("license");
    setError(null);
    try {
      setLicense(await window.piBridge.refreshTestLicense());
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setOperation(null);
    }
  }, []);

  const refreshProject = useCallback(async () => {
    if (!project) return null;
    const refreshed = await window.piBridge.openProject(project.root);
    setProject(refreshed);
    setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
    return refreshed;
  }, [project]);

  const refreshZentaoConnections = useCallback(async () => {
    const connections = await window.piBridge.listZentaoConnections();
    setZentaoConnections(connections);
    return connections;
  }, []);

  useEffect(() => {
    if (view !== "zentao" && view !== "findings") return;
    void refreshZentaoConnections().catch((nextError) => setError(errorMessage(nextError)));
  }, [refreshZentaoConnections, view]);

  const loadTestSite = useCallback(async () => {
    if (!project || !project.surfaces.some((item) => item.name === surface)) return;
    setOperation(surface === "app" ? "mobile" : "browser");
    try {
      if (surface === "app") setMobile(await window.piBridge.getMobileState(project.root));
      else setBrowser(await window.piBridge.getBrowserState(project.root, surface));
      setError(null);
    } catch (nextError) {
      if (surface === "app") setMobile(null);
      else setBrowser(null);
      setError(errorMessage(nextError));
    } finally {
      setOperation(null);
    }
  }, [project, surface]);

  useEffect(() => {
    if (!project) return;
    const available = project.surfaces
      .map((item) => item.name)
      .filter((name): name is WorkbenchSurface => name === "h5" || name === "admin" || name === "app");
    if (!available.includes(surface)) setSurface(available[0] ?? "h5");
  }, [project, surface]);

  useEffect(() => {
    if (!license?.authorized) {
      setBrowser(null);
      return;
    }
    if (!project || !project.surfaces.some((item) => item.name === surface)) return;
    void loadTestSite();
  }, [license?.authorized, project, surface, loadTestSite]);

  useEffect(() => {
    if (
      surface === "app" ||
      !license?.authorized ||
      !project ||
      browser?.assetsPrepared === false ||
      browser?.ready === true
    )
      return;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void window.piBridge
        .getBrowserState(project.root, surface)
        .then(setBrowser)
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [browser?.assetsPrepared, browser?.ready, license?.authorized, project, surface]);

  const projectRoot = project?.root ?? null;
  const projectName = project?.name ?? null;
  useEffect(() => {
    if (!license?.authorized || !projectRoot || !projectName) {
      setSessionId(null);
      setSessionLoading(false);
      return;
    }
    let cancelled = false;
    setSessionId(null);
    setSessionLoading(true);
    void newAgent({ cwd: projectRoot, type: "ensure_session", sessionMode: "test" })
      .then(({ sessionId }) => {
        if (!cancelled) {
          setSessionId(sessionId);
        }
      })
      .catch((nextError) => {
        if (!cancelled) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [license?.authorized, projectRoot, projectName]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => void agentState(sessionId).catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, [sessionId]);

  const session = sessionId && project ? temporarySession(project, sessionId) : null;
  const activeRun = project?.activeRun?.run ?? null;
  const allEvidence = useMemo(() => [...new Set(project?.runs.flatMap((run) => run.evidence) ?? [])], [project?.runs]);

  const perform = useCallback(async (kind: Exclude<Operation, null>, task: () => Promise<void>) => {
    setOperation(kind);
    setError(null);
    try {
      await task();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setOperation(null);
    }
  }, []);

  useEffect(() => {
    if (!project || !regressionRunning) return;
    const timer = window.setInterval(() => {
      void window.piBridge
        .openProject(project.root)
        .then((refreshed) => setProject(refreshed))
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [project, regressionRunning]);

  const runRegression = () => {
    if (!project || !session) return;
    const caseIds = project.cases.filter((item) => item.status === "stable").map((item) => item.id);
    setRegressionRunning(true);
    setError(null);
    setView("workbench");
    void window.piBridge
      .playCases(project.root, session.id, caseIds)
      .then(() => refreshProject())
      .catch((nextError) => setError(errorMessage(nextError)))
      .finally(() => setRegressionRunning(false));
  };

  const changeCaseStatus = (caseId: string, status: "draft" | "stable" | "disabled") => {
    if (!project) return;
    void perform("run", async () => {
      const refreshed = await window.piBridge.setCaseStatus(project.root, caseId, status);
      setProject(refreshed);
      setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
    });
  };

  const startRun = () => {
    if (!project || !session) return;
    void perform("run", async () => {
      let liveSessionId = session.id;
      if (!(await agentState(liveSessionId)).running) {
        liveSessionId = (await newAgent({ cwd: project.root, type: "ensure_session", sessionMode: "test" })).sessionId;
        setSessionId(liveSessionId);
      }
      await window.piBridge.startRun(
        project.root,
        liveSessionId,
        surface,
        `${project.name} ${surface === "app" ? "App" : "Web"} 功能测试`,
      );
      await refreshProject();
      await window.piBridge.act(project.root, liveSessionId, surface, "read", { type: "open" });
      const result = await window.piBridge.observe(project.root, liveSessionId, surface, "text");
      setObservation(result.text);
      await refreshProject();
      chatInputRef.current?.insertIfEmpty(
        "继续测试当前 Web 功能。页面已打开并完成首次感知；只执行只读操作，发现问题后截图留证并说明结果。",
      );
    });
  };

  const controlRun = (
    request:
      | { action: "pause"; surface: WorkbenchSurface; sensitive?: boolean }
      | {
          action: "takeover";
          surface: WorkbenchSurface;
          reason: "login" | "verification" | "scan" | "authorization" | "judgment";
          sensitive?: boolean;
        }
      | { action: "resume" },
  ) => {
    if (!project || !session) return;
    void perform("run", async () => {
      const result = await window.piBridge.controlRun(project.root, session.id, request);
      if (result.observation) setObservation(result.observation.text);
      await refreshProject();
    });
  };

  const finishRun = (status: "passed" | "failed" | "blocked" | "aborted") => {
    if (!project || !session) return;
    void perform("finish", async () => {
      await window.piBridge.finishRun(project.root, session.id, status, RUN_STATUS_LABEL[status]);
      await refreshProject();
    });
  };

  const observe = (mode: "text" | "snapshot") => {
    if (!project || !session) return;
    void perform("observe", async () => {
      const result = await window.piBridge.observe(project.root, session.id, surface, mode);
      setObservation(result.text);
      await refreshProject();
    });
  };

  const captureEvidence = () => {
    if (!project || !session) return;
    void perform("evidence", async () => {
      const result = await window.piBridge.act(project.root, session.id, surface, "read", { type: "shot" });
      if (result.evidence) setLatestEvidence(result.evidence);
      await refreshProject();
    });
  };

  const copyExtensionPath = () => {
    void perform("browser", async () => {
      const result = await window.piBridge.copyBrowserExtensionPath();
      setBrowserNotice(`扩展目录已复制：${result.path}`);
    });
  };

  const openExtensionManager = () => {
    void perform("browser", async () => {
      await window.piBridge.openBrowserExtensionManager();
      setBrowserNotice("已打开 Chrome 扩展管理，连接后会自动更新状态。");
    });
  };

  const installAndroidTools = () => {
    if (!project) return;
    void perform("mobile", async () => {
      setMobile(await window.piBridge.installAndroidTools(project.root));
    });
  };

  const connectMobile = (serial: string) => {
    if (!project || !serial) return;
    void perform("mobile", async () => {
      setMobile(await window.piBridge.connectMobile(project.root, serial));
    });
  };

  const confirmForegroundApp = () => {
    if (!project || !mobile?.selectedSerial) return;
    void perform("mobile", async () => {
      const refreshed = await window.piBridge.confirmForegroundApp(project.root, mobile.selectedSerial!);
      setProject(refreshed);
      setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
      setMobile(await window.piBridge.getMobileState(refreshed.root));
    });
  };

  const bindTab = (value: string) => {
    if (!project || !value || surface === "app") return;
    const [profileId, tabId] = value.split("\t");
    void perform("browser", async () => {
      setBrowser(await window.piBridge.bindBrowser(project.root, surface, profileId, tabId));
    });
  };

  const openEvidence = (evidence: string) => {
    if (!project) return;
    void perform("evidence", async () => {
      const result = await window.piBridge.readEvidence(project.root, evidence);
      setEvidencePreview({ path: evidence, dataUrl: result.dataUrl, text: result.text });
    });
  };

  const openProject = async (root: string) => {
    try {
      const opened = await window.piBridge.openProject(root);
      setProject(opened);
      setView("workbench");
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };

  if (!project) {
    return (
      <div className="tw-app tw-home">
        <header className="tw-home-header">
          <Brand />
          <button
            className="tw-icon-button"
            type="button"
            title="AI 服务"
            disabled={!license?.authorized}
            onClick={() => setModelsOpen(true)}
          >
            <Settings size={18} />
          </button>
        </header>
        <main className="tw-home-main">
          <div className="tw-home-title-row">
            <div>
              <h1>最近项目</h1>
              <p>选择一个测试项目继续工作。</p>
            </div>
            <div className="tw-actions">
              <button
                className="tw-button tw-button-secondary"
                type="button"
                onClick={() => void chooseExisting(openProject)}
              >
                <FolderOpen size={16} />
                打开已有项目
              </button>
              <button
                className="tw-button tw-button-primary"
                type="button"
                disabled={!license?.authorized}
                onClick={() => setNewProjectOpen(true)}
              >
                <Plus size={16} />
                新建测试项目
              </button>
            </div>
          </div>
          {license && !license.authorized && (
            <LicenseNotice
              license={license}
              refreshing={operation === "license"}
              onDetails={() => setLicenseOpen(true)}
              onRefresh={() => void refreshLicense()}
            />
          )}
          {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
          {loading ? (
            <EmptyState icon={LoaderCircle} title="正在读取项目" spinning />
          ) : projects.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="还没有测试项目"
              action={license?.authorized ? "新建测试项目" : undefined}
              onAction={license?.authorized ? () => setNewProjectOpen(true) : undefined}
            />
          ) : (
            <div className="tw-project-list">
              {projects.map((item) => (
                <div key={item.root} className={item.archived ? "tw-project-row archived" : "tw-project-row"}>
                  <button className="tw-project-open" type="button" onClick={() => void openProject(item.root)}>
                    <span className="tw-project-mark">{item.name.slice(0, 1).toUpperCase()}</span>
                    <span className="tw-project-copy">
                      <strong>{item.name}</strong>
                      <span>{item.root}</span>
                    </span>
                    <StatusBadge tone={item.environment === "production" ? "danger" : "neutral"}>
                      {item.archived ? "已归档" : ENVIRONMENT_LABEL[item.environment]}
                    </StatusBadge>
                    <span className="tw-project-surfaces">
                      {item.surfaces.map((entry) => entry.name.toUpperCase()).join(" · ")}
                    </span>
                    <ChevronRight size={17} />
                  </button>
                  <button
                    className="tw-icon-button"
                    type="button"
                    title="项目操作"
                    onClick={() => setProjectMenu((current) => (current === item.root ? null : item.root))}
                  >
                    <MoreHorizontal size={17} />
                  </button>
                  {projectMenu === item.root && (
                    <div className="tw-project-menu">
                      <button
                        type="button"
                        onClick={() =>
                          void perform("run", async () => {
                            await window.piBridge.setProjectArchived(item.root, !item.archived);
                            setProjectMenu(null);
                            await refreshRecent();
                          })
                        }
                      >
                        {item.archived ? "恢复项目" : "归档项目"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void perform("run", async () => {
                            await window.piBridge.removeProject(item.root);
                            setProjectMenu(null);
                            await refreshRecent();
                          })
                        }
                      >
                        仅从工作台移除
                      </button>
                      <button
                        className="danger"
                        type="button"
                        onClick={() => {
                          setProjectMenu(null);
                          setDeleteProject(item);
                        }}
                      >
                        删除本地项目数据
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </main>
        {newProjectOpen && (
          <NewProjectDialog
            onClose={() => setNewProjectOpen(false)}
            onCreated={(created) => {
              setNewProjectOpen(false);
              setProjects((current) => [created, ...current]);
              setProject(created);
            }}
          />
        )}
        {deleteProject && (
          <DeleteProjectDialog
            project={deleteProject}
            onClose={() => setDeleteProject(null)}
            onDeleted={() => {
              setDeleteProject(null);
              void refreshRecent();
            }}
          />
        )}
        {modelsOpen && (
          <ModelsDialog
            cwd={null}
            onClose={() => {
              setModelsOpen(false);
              setModelsRefreshKey((key) => key + 1);
            }}
          />
        )}
        {licenseOpen && license && (
          <LicenseDialog
            license={license}
            refreshing={operation === "license"}
            onRefresh={() => void refreshLicense()}
            onClose={() => setLicenseOpen(false)}
          />
        )}
      </div>
    );
  }

  const selectedSurface = project.surfaces.find((item) => item.name === surface);
  const boundTab = browser?.binding?.tabId
    ? browser.tabs.find((tab) => tab.profileId === browser.binding?.profileId && tab.tabId === browser.binding?.tabId)
    : null;
  const testSiteReady =
    surface === "app" ? mobile?.ready === true : browser?.ready === true && Boolean(browser.binding?.profileId);
  const runControlState = activeRun?.control?.state ?? "running";
  const runIsOperational = runControlState === "running";

  return (
    <div className="tw-app tw-workspace">
      <aside className="tw-sidebar">
        <div className="tw-sidebar-brand">
          <Brand compact />
        </div>
        <button
          className="tw-back-button"
          type="button"
          title="所有项目"
          onClick={() => {
            if (activeRun && license?.authorized) {
              setError("请先结束当前测试，再返回项目列表");
              return;
            }
            setProject(null);
          }}
        >
          <ArrowLeft size={15} />
          <span>所有项目</span>
        </button>
        <div className="tw-project-identity">
          <span className="tw-project-mark">{project.name.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{project.name}</strong>
            <small>{ENVIRONMENT_LABEL[project.environment]}</small>
          </span>
        </div>
        <nav className="tw-nav" aria-label="项目导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const count =
              item.id === "cases"
                ? project.cases.length
                : item.id === "runs"
                  ? project.runs.length
                  : item.id === "findings"
                    ? project.findings.length
                    : item.id === "identities"
                      ? project.identities.length
                      : item.id === "zentao"
                        ? project.zentao
                          ? 1
                          : 0
                        : null;
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "active" : ""}
                title={item.label}
                onClick={() => setView(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {count !== null && <small>{count}</small>}
              </button>
            );
          })}
        </nav>
        <div className="tw-sidebar-footer">
          <button
            type="button"
            title="项目设置"
            disabled={!license?.authorized || Boolean(activeRun)}
            onClick={() => setProjectSettingsOpen(true)}
          >
            <Settings size={16} />
            <span>项目设置</span>
          </button>
          <button type="button" title="AI 服务" disabled={!license?.authorized} onClick={() => setModelsOpen(true)}>
            <Bot size={16} />
            <span>AI 服务</span>
          </button>
        </div>
      </aside>

      <section className="tw-main">
        <header className="tw-topbar">
          <div className="tw-topbar-title">
            <h1>{NAV_ITEMS.find((item) => item.id === view)?.label}</h1>
            {project.environment === "production" && <StatusBadge tone="danger">生产环境只读</StatusBadge>}
          </div>
          <div className="tw-topbar-status">
            <button className="tw-license-status" type="button" onClick={() => setLicenseOpen(true)}>
              <StatusBadge tone={license?.authorized ? "success" : "warning"}>
                <ShieldCheck size={13} />
                {license?.phase === "development_bypass" ? "开发旁路" : license?.authorized ? "设备已授权" : "设备只读"}
              </StatusBadge>
            </button>
            <StatusBadge tone={testSiteReady ? "success" : "warning"}>
              {testSiteReady
                ? `${surface === "app" ? "App" : "Web"} 可测`
                : `${surface === "app" ? "App" : "Web"} 待连接`}
            </StatusBadge>
            {activeRun && (
              <StatusBadge tone="info">{RUN_CONTROL_LABEL[runControlState] ?? runControlState}</StatusBadge>
            )}
          </div>
        </header>
        {error && <ErrorNotice message={error} onClose={() => setError(null)} />}

        <div className="tw-workbench-grid" hidden={view !== "workbench"}>
          <div className="tw-chat-pane">
            {!license?.authorized ? (
              <EmptyState icon={ShieldCheck} title="设备未授权，测试会话已停用" />
            ) : sessionLoading || !session ? (
              <EmptyState icon={LoaderCircle} title="正在准备测试会话" spinning />
            ) : (
              <ChatWindow
                key={session.id}
                session={null}
                newSessionCwd={project.root}
                initialSessionId={session.id}
                chatInputRef={chatInputRef}
                onAgentEnd={() => void refreshProject()}
                modelsRefreshKey={modelsRefreshKey}
                testMode
              />
            )}
          </div>
          <aside className="tw-control-pane">
            <section className="tw-control-section">
              <div className="tw-section-heading">
                <h2>测试现场</h2>
                <button
                  className="tw-icon-button"
                  type="button"
                  title={surface === "app" ? "重新检测 Android" : "重新检测 Chrome"}
                  onClick={() => void loadTestSite()}
                  disabled={!license?.authorized || operation === "browser" || operation === "mobile"}
                >
                  <RefreshCw size={15} className={operation === "browser" || operation === "mobile" ? "tw-spin" : ""} />
                </button>
              </div>
              <label className="tw-field">
                <span>测试端</span>
                <select value={surface} onChange={(event) => setSurface(event.target.value as WorkbenchSurface)}>
                  {project.surfaces
                    .filter((item) => item.name === "h5" || item.name === "admin" || item.name === "app")
                    .map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name === "h5" ? "H5" : item.name === "admin" ? "管理后台" : "Android App"}
                      </option>
                    ))}
                </select>
              </label>
              <div className="tw-detail-row">
                <span>入口</span>
                <strong title={selectedSurface?.url ?? ""}>{selectedSurface?.url ?? "未配置"}</strong>
              </div>
              {surface === "app" ? (
                <MobileSetup
                  state={mobile}
                  busy={operation === "mobile"}
                  onInstall={installAndroidTools}
                  onConnect={connectMobile}
                  onConfirm={confirmForegroundApp}
                />
              ) : (
                <>
                  <div className="tw-detail-row">
                    <span>Chrome</span>
                    <strong className={browser?.ready ? "tw-positive" : "tw-warning"}>
                      {!browser?.assetsPrepared
                        ? "浏览器组件不可用"
                        : browser.extensionConnected
                          ? browser.extensionVersion === browser.expectedExtensionVersion
                            ? `扩展 ${browser.extensionVersion}`
                            : `扩展需更新 (${browser.extensionVersion ?? "未知版本"})`
                          : "扩展未连接"}
                    </strong>
                  </div>
                  {browser &&
                    (!browser.assetsPrepared ||
                      !browser.extensionConnected ||
                      browser.extensionVersion !== browser.expectedExtensionVersion) && (
                      <div className="tw-extension-setup">
                        <strong>{browser.assetsPrepared ? "连接 Chrome 扩展" : "浏览器组件校验失败"}</strong>
                        {browser.assetsPrepared ? (
                          <>
                            <ol>
                              <li>复制扩展目录并打开 Chrome 扩展管理。</li>
                              <li>开启开发者模式，选择“加载已解压的扩展程序”。</li>
                              <li>选择已复制的目录；更新时点击扩展的“重新加载”。</li>
                            </ol>
                            <p className="tw-permission-note">
                              扩展使用网页访问、调试、脚本、标签页和扩展管理权限连接真实 Chrome；产品不展示或复制
                              Cookie。
                            </p>
                            <div className="tw-extension-actions">
                              <button type="button" onClick={copyExtensionPath} disabled={operation === "browser"}>
                                <Copy size={14} />
                                复制路径
                              </button>
                              <button type="button" onClick={openExtensionManager} disabled={operation === "browser"}>
                                <ExternalLink size={14} />
                                打开扩展管理
                              </button>
                            </div>
                            {browserNotice && <p>{browserNotice}</p>}
                          </>
                        ) : (
                          <p>{browser.assetError ?? "请重新安装应用。"}</p>
                        )}
                      </div>
                    )}
                  {browser?.tabs.length ? (
                    <label className="tw-field">
                      <span>页面</span>
                      <select
                        value={boundTab ? `${boundTab.profileId}\t${boundTab.tabId}` : ""}
                        onChange={(event) => bindTab(event.target.value)}
                      >
                        <option value="">选择 Chrome 页面</option>
                        {browser.tabs.map((tab) => (
                          <option key={`${tab.profileId}:${tab.tabId}`} value={`${tab.profileId}\t${tab.tabId}`}>
                            {tab.profileLabel ?? tab.profileId.slice(0, 12)} · {tab.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="tw-inline-note">请在已安装扩展的 Chrome 中打开普通网页后重新检测。</p>
                  )}
                </>
              )}
              {observation && <pre className="tw-observation">{observation}</pre>}
            </section>

            <section className="tw-control-section">
              <div className="tw-section-heading">
                <h2>当前执行</h2>
                {activeRun && (
                  <StatusBadge tone="info">{RUN_CONTROL_LABEL[runControlState] ?? runControlState}</StatusBadge>
                )}
              </div>
              {!activeRun ? (
                <button
                  className="tw-button tw-button-primary tw-button-wide"
                  type="button"
                  disabled={!license?.authorized || !session || operation !== null || !testSiteReady}
                  onClick={startRun}
                >
                  <Play size={16} />
                  开始测试
                </button>
              ) : (
                <>
                  <div className="tw-run-title">
                    <strong>{activeRun.title}</strong>
                    <span>{new Date(activeRun.startedAt).toLocaleString("zh-CN")}</span>
                  </div>
                  {runIsOperational ? (
                    <div className="tw-action-grid">
                      <button
                        type="button"
                        onClick={() => observe("text")}
                        disabled={!license?.authorized || !session || operation !== null || regressionRunning}
                      >
                        <Eye size={15} />
                        读取正文
                      </button>
                      <button
                        type="button"
                        onClick={() => observe("snapshot")}
                        disabled={!license?.authorized || !session || operation !== null || regressionRunning}
                      >
                        <ListChecks size={15} />
                        读取结构
                      </button>
                      <button
                        type="button"
                        onClick={captureEvidence}
                        disabled={!license?.authorized || !session || operation !== null || regressionRunning}
                      >
                        <Image size={15} />
                        截图留证
                      </button>
                      <button
                        type="button"
                        onClick={() => controlRun({ action: "pause", surface })}
                        disabled={!license?.authorized || !session || operation !== null}
                      >
                        <Pause size={15} />
                        步骤后暂停
                      </button>
                      <button
                        type="button"
                        onClick={() => controlRun({ action: "takeover", surface, reason: "judgment" })}
                        disabled={!license?.authorized || !session || operation !== null}
                      >
                        <Hand size={15} />
                        人工接管
                      </button>
                    </div>
                  ) : (
                    <button
                      className="tw-button tw-button-primary tw-button-wide"
                      type="button"
                      disabled={
                        !license?.authorized ||
                        !session ||
                        operation !== null ||
                        (runControlState !== "paused" && runControlState !== "waiting_for_user")
                      }
                      onClick={() => controlRun({ action: "resume" })}
                    >
                      <Play size={15} />
                      {runControlState === "waiting_for_user" ? "我已完成" : "继续测试"}
                    </button>
                  )}
                  <div className="tw-finish-actions">
                    <button
                      type="button"
                      className="pass"
                      disabled={!license?.authorized || !session || operation !== null || regressionRunning}
                      onClick={() => finishRun("passed")}
                    >
                      <CheckCircle2 size={15} />
                      通过
                    </button>
                    <button
                      type="button"
                      className="fail"
                      disabled={!license?.authorized || !session || operation !== null || regressionRunning}
                      onClick={() => finishRun("failed")}
                    >
                      <XCircle size={15} />
                      未通过
                    </button>
                    <button
                      type="button"
                      disabled={!license?.authorized || !session || operation !== null || regressionRunning}
                      onClick={() => finishRun("aborted")}
                    >
                      <CircleStop size={15} />
                      结束
                    </button>
                  </div>
                </>
              )}
            </section>

            {(latestEvidence || allEvidence.length > 0) && (
              <section className="tw-control-section tw-evidence-section">
                <div className="tw-section-heading">
                  <h2>证据</h2>
                  <span>{allEvidence.length}</span>
                </div>
                <div className="tw-evidence-list">
                  {allEvidence.slice(0, 6).map((item) => (
                    <button key={item} type="button" onClick={() => openEvidence(item)}>
                      <Image size={14} />
                      <span>{item.split("/").pop()}</span>
                    </button>
                  ))}
                </div>
                {activeRun && allEvidence.length > 0 && (
                  <button
                    className="tw-button tw-button-secondary tw-button-wide"
                    type="button"
                    onClick={() => setFindingOpen(true)}
                  >
                    <Bug size={15} />
                    记录问题
                  </button>
                )}
              </section>
            )}
          </aside>
        </div>

        {view === "map" && (
          <AssetPage title="业务地图" empty="业务地图尚未生成。">
            <pre className="tw-map-content">{project.map}</pre>
          </AssetPage>
        )}
        {view === "cases" && (
          <CasesPage
            project={project}
            busy={operation !== null || regressionRunning}
            canRun={Boolean(license?.authorized && session && !activeRun)}
            onRun={runRegression}
            onStatus={changeCaseStatus}
          />
        )}
        {view === "runs" && <RunsPage project={project} onEvidence={openEvidence} />}
        {view === "findings" && (
          <FindingsPage
            project={project}
            connections={zentaoConnections}
            busy={operation !== null}
            canWrite={license?.authorized === true}
            onSubmit={(findingId) => setZentaoBugOpen(findingId)}
            onRefresh={(findingId) => {
              void perform("finding", async () => {
                const refreshed = await window.piBridge.refreshZentaoBug(project.root, findingId);
                setProject(refreshed);
                setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
              });
            }}
            onRetest={(findingId) => setZentaoRetestOpen(findingId)}
          />
        )}
        {view === "identities" && (
          <IdentityPage
            project={project}
            busy={operation !== null}
            onAdd={() => setIdentityOpen(null)}
            onEdit={(identityId) => setIdentityOpen(identityId)}
            onDelete={(identityId) => {
              void perform("run", async () => {
                const refreshed = await window.piBridge.deleteIdentity(project.root, identityId);
                setProject(refreshed);
                setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
              });
            }}
          />
        )}
        {view === "zentao" && (
          <ZentaoPage
            project={project}
            connections={zentaoConnections}
            busy={operation !== null}
            canWrite={license?.authorized === true && !activeRun}
            onAdd={() => setZentaoConnectionOpen(null)}
            onEdit={(connectionId) => setZentaoConnectionOpen(connectionId)}
            onDelete={(connectionId) => {
              void perform("run", async () => {
                await window.piBridge.deleteZentaoConnection(connectionId);
                await refreshZentaoConnections();
              });
            }}
            onProjectSaved={(refreshed) => {
              setProject(refreshed);
              setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
            }}
          />
        )}
      </section>

      {projectSettingsOpen && (
        <NewProjectDialog
          project={project}
          onClose={() => setProjectSettingsOpen(false)}
          onCreated={(refreshed) => {
            setProjectSettingsOpen(false);
            setProject(refreshed);
            setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
          }}
        />
      )}
      {modelsOpen && (
        <ModelsDialog
          cwd={project.root}
          onClose={() => {
            setModelsOpen(false);
            setModelsRefreshKey((key) => key + 1);
          }}
        />
      )}
      {licenseOpen && license && (
        <LicenseDialog
          license={license}
          refreshing={operation === "license"}
          onRefresh={() => void refreshLicense()}
          onClose={() => setLicenseOpen(false)}
        />
      )}
      {identityOpen !== false && (
        <IdentityDialog
          project={project}
          identityId={identityOpen}
          onClose={() => setIdentityOpen(false)}
          onSaved={(refreshed) => {
            setIdentityOpen(false);
            setProject(refreshed);
            setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
          }}
        />
      )}
      {findingOpen && session && allEvidence.length > 0 && (
        <FindingDialog
          project={project}
          sessionId={session.id}
          surface={surface}
          evidence={latestEvidence ?? allEvidence[0]}
          onClose={() => setFindingOpen(false)}
          onCreated={() => {
            setFindingOpen(false);
            void refreshProject();
          }}
        />
      )}
      {zentaoConnectionOpen !== false && (
        <ZentaoConnectionDialog
          connection={
            zentaoConnectionOpen
              ? zentaoConnections.find((connection) => connection.id === zentaoConnectionOpen)
              : undefined
          }
          onClose={() => setZentaoConnectionOpen(false)}
          onSaved={async () => {
            setZentaoConnectionOpen(false);
            await refreshZentaoConnections();
          }}
        />
      )}
      {zentaoBugOpen !== false && (
        <ZentaoBugDialog
          project={project}
          findingId={zentaoBugOpen}
          onClose={() => setZentaoBugOpen(false)}
          onSubmitted={(refreshed) => {
            setZentaoBugOpen(false);
            setProject(refreshed);
            setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
          }}
        />
      )}
      {zentaoRetestOpen !== false && (
        <ZentaoRetestDialog
          project={project}
          findingId={zentaoRetestOpen}
          onClose={() => setZentaoRetestOpen(false)}
          onSubmitted={(refreshed) => {
            setZentaoRetestOpen(false);
            setProject(refreshed);
            setProjects((current) => [refreshed, ...current.filter((item) => item.root !== refreshed.root)]);
          }}
        />
      )}
      {evidencePreview && <EvidenceDialog evidence={evidencePreview} onClose={() => setEvidencePreview(null)} />}
    </div>
  );
}

function MobileSetup({
  state,
  busy,
  onInstall,
  onConnect,
  onConfirm,
}: {
  state: TestWorkbenchMobileState | null;
  busy: boolean;
  onInstall: () => void;
  onConnect: (serial: string) => void;
  onConfirm: () => void;
}) {
  if (!state) return <p className="tw-inline-note">正在检测 Android 测试环境。</p>;
  if (!state.supported) {
    return (
      <div className="tw-extension-setup">
        <strong>Android 驱动不可用</strong>
        <p>{state.error ?? "当前平台不支持 Android App 测试。"}</p>
      </div>
    );
  }
  if (!state.platformToolsInstalled) {
    return (
      <div className="tw-extension-setup">
        <strong>准备 Android 测试组件</strong>
        <p>
          Handsets {state.handsetsVersion} 已就绪；还需要固定 platform-tools {state.platformToolsVersion}。
        </p>
        <button
          className="tw-button tw-button-secondary tw-button-wide"
          type="button"
          disabled={busy || !state.platformToolsDownloadAvailable}
          onClick={onInstall}
        >
          <Download size={14} />
          下载并安装
        </button>
        {!state.platformToolsDownloadAvailable && <p>此构建尚未配置 Android 工具下载地址。</p>}
      </div>
    );
  }
  const selected = state.devices.find((device) => device.serial === state.selectedSerial);
  return (
    <div className="tw-mobile-setup">
      <div className="tw-detail-row">
        <span>设备</span>
        <strong className={selected?.state === "device" ? "tw-positive" : "tw-warning"}>{state.summary}</strong>
      </div>
      {state.devices.length > 0 ? (
        <label className="tw-field">
          <span>Android 设备</span>
          <select
            value={state.selectedSerial ?? ""}
            disabled={busy}
            onChange={(event) => event.target.value && onConnect(event.target.value)}
          >
            <option value="">选择设备</option>
            {state.devices.map((device) => (
              <option key={device.serial} value={device.serial} disabled={device.state !== "device"}>
                {device.model ?? device.product ?? device.serial} · {device.state}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="tw-inline-note">连接手机并开启 USB 调试；品牌 USB 驱动需按厂商说明手工安装。</p>
      )}
      {state.previewDataUrl && <img className="tw-mobile-preview" src={state.previewDataUrl} alt="当前手机画面" />}
      {state.selectedSerial && selected?.state === "device" && !state.foregroundPackageName && (
        <button
          className="tw-button tw-button-secondary tw-button-wide"
          type="button"
          disabled={busy}
          onClick={() => onConnect(state.selectedSerial!)}
        >
          <Smartphone size={14} />
          连接设备
        </button>
      )}
      {state.selectedSerial && selected?.state === "device" && state.foregroundPackageName && (
        <button
          className="tw-button tw-button-secondary tw-button-wide"
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          <Smartphone size={14} />
          确认 {state.foregroundPackageName}
        </button>
      )}
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "tw-brand compact" : "tw-brand"}>
      <span>π</span>
      <div>
        <strong>Pi Test</strong>
        {!compact && <small>Desktop Workbench</small>}
      </div>
    </div>
  );
}

function StatusBadge({
  tone,
  children,
}: {
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  children: React.ReactNode;
}) {
  return <span className={`tw-badge ${tone}`}>{children}</span>;
}

function ErrorNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="tw-error-notice" role="alert">
      <AlertTriangle size={16} />
      <span>{message}</span>
      <button type="button" title="关闭" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function LicenseNotice({
  license,
  refreshing,
  onDetails,
  onRefresh,
}: {
  license: TestLicenseState;
  refreshing: boolean;
  onDetails: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="tw-license-notice" aria-label="设备授权">
      <div className="tw-license-copy">
        <ShieldCheck size={20} />
        <span>
          <strong>{license.message}</strong>
          <small>授权码 {license.deviceCode}</small>
        </span>
      </div>
      <div className="tw-license-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onDetails}>
          <ShieldCheck size={15} />
          授权详情
        </button>
        <button
          className="tw-icon-button"
          type="button"
          title="复制授权码"
          onClick={() => void copyText(license.deviceCode)}
        >
          <Copy size={15} />
        </button>
        <button className="tw-button tw-button-secondary" type="button" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw size={15} className={refreshing ? "tw-spin" : ""} />
          重新检查授权
        </button>
      </div>
    </section>
  );
}

function LicenseDialog({
  license,
  refreshing,
  onRefresh,
  onClose,
}: {
  license: TestLicenseState;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="设备授权" onClose={onClose}>
      <div className="tw-license-details">
        <div>
          <span>状态</span>
          <strong>{license.message}</strong>
        </div>
        <div>
          <span>授权码</span>
          <code>{license.deviceCode}</code>
          <button
            className="tw-icon-button"
            type="button"
            title="复制授权码"
            onClick={() => void copyText(license.deviceCode)}
          >
            <Copy size={15} />
          </button>
        </div>
        {license.deviceFingerprint && (
          <div>
            <span>设备标识</span>
            <code>{license.deviceFingerprint}</code>
            <button
              className="tw-icon-button"
              type="button"
              title="复制完整设备标识"
              onClick={() => void copyText(license.deviceFingerprint!)}
            >
              <Copy size={15} />
            </button>
          </div>
        )}
        <div>
          <span>本次检查</span>
          <strong>{license.checkedAt ? new Date(license.checkedAt).toLocaleString("zh-CN") : "尚未检查"}</strong>
        </div>
        {license.licenseId && (
          <div>
            <span>许可证</span>
            <strong>{license.licenseId}</strong>
          </div>
        )}
      </div>
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw size={15} className={refreshing ? "tw-spin" : ""} />
          重新检查授权
        </button>
      </div>
    </Dialog>
  );
}

function EmptyState({
  icon: Icon,
  title,
  action,
  onAction,
  spinning = false,
}: {
  icon: typeof Gauge;
  title: string;
  action?: string;
  onAction?: () => void;
  spinning?: boolean;
}) {
  return (
    <div className="tw-empty">
      <Icon size={28} className={spinning ? "tw-spin" : ""} />
      <strong>{title}</strong>
      {action && (
        <button className="tw-button tw-button-primary" type="button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

async function chooseExisting(open: (root: string) => Promise<void>) {
  const root = await window.piBridge.selectDirectory();
  if (root) await open(root);
}

function NewProjectDialog({
  project,
  onClose,
  onCreated,
}: {
  project?: TestWorkbenchProject;
  onClose: () => void;
  onCreated: (project: TestWorkbenchProject) => void;
}) {
  const existingSurfaces = project?.surfaces
    .map((item) => item.name)
    .filter((name): name is WorkbenchSurface => name === "h5" || name === "admin" || name === "app");
  const [name, setName] = useState(project?.name ?? "");
  const [environment, setEnvironment] = useState<"test" | "staging" | "production">(project?.environment ?? "test");
  const [surfaces, setSurfaces] = useState<WorkbenchSurface[]>(existingSurfaces ?? ["h5"]);
  const [h5Url, setH5Url] = useState(project?.surfaces.find((item) => item.name === "h5")?.url ?? "");
  const [adminUrl, setAdminUrl] = useState(project?.surfaces.find((item) => item.name === "admin")?.url ?? "");
  const [visualCheck, setVisualCheck] = useState(project?.visualCheckEnabled ?? false);
  const [visualModel, setVisualModel] = useState<{ provider: string; modelId: string } | null>(
    project?.visualModel ?? null,
  );
  const [imageModels, setImageModels] = useState<Array<{ provider: string; modelId: string; name: string }>>([]);
  const [root, setRoot] = useState(project?.root ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toggleSurface = (value: WorkbenchSurface) =>
    setSurfaces((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    getModelPreferences(root)
      .then((preferences) => {
        if (cancelled) return;
        setImageModels(
          preferences.models
            .filter((model) => model.input.includes("image"))
            .map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })),
        );
      })
      .catch(() => {
        if (!cancelled) setImageModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);
  const submit = async () => {
    if (visualCheck && !visualModel) {
      setError("请选择视觉模型");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = { root, name, environment, surfaces, h5Url, adminUrl, visualCheck, visualModel };
      onCreated(project ? await window.piBridge.updateProject(input) : await window.piBridge.createProject(input));
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title={project ? "项目设置" : "新建测试项目"} onClose={onClose}>
      <div className="tw-form-grid">
        <label className="tw-field">
          <span>项目名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：商城后台"
          />
        </label>
        <label className="tw-field">
          <span>环境</span>
          <select value={environment} onChange={(event) => setEnvironment(event.target.value as typeof environment)}>
            <option value="test">测试环境</option>
            <option value="staging">预发布环境</option>
            <option value="production">生产环境</option>
          </select>
        </label>
        <fieldset className="tw-field tw-field-wide tw-check-group">
          <legend>测试端</legend>
          {(["h5", "admin", "app"] as const).map((item) => (
            <label key={item}>
              <input type="checkbox" checked={surfaces.includes(item)} onChange={() => toggleSurface(item)} />
              {item === "h5" ? "H5" : item === "admin" ? "管理后台" : "Android App"}
            </label>
          ))}
        </fieldset>
        {surfaces.includes("h5") && (
          <label className="tw-field">
            <span>H5 地址</span>
            <input
              type="url"
              value={h5Url}
              onChange={(event) => setH5Url(event.target.value)}
              placeholder="https://example.com/"
            />
          </label>
        )}
        {surfaces.includes("admin") && (
          <label className="tw-field">
            <span>管理后台地址</span>
            <input
              type="url"
              value={adminUrl}
              onChange={(event) => setAdminUrl(event.target.value)}
              placeholder="https://admin.example.com/"
            />
          </label>
        )}
        <label className="tw-toggle-field tw-field-wide">
          <input type="checkbox" checked={visualCheck} onChange={(event) => setVisualCheck(event.target.checked)} />
          <span>明显视觉异常检查</span>
        </label>
        {visualCheck && (
          <label className="tw-field tw-field-wide">
            <span>视觉模型</span>
            <select
              value={visualModel ? `${visualModel.provider}/${visualModel.modelId}` : ""}
              onChange={(event) => {
                const value = event.target.value;
                const selected = imageModels.find((model) => `${model.provider}/${model.modelId}` === value) ?? null;
                setVisualModel(selected ? { provider: selected.provider, modelId: selected.modelId } : null);
              }}
            >
              <option value="">选择支持图片的模型</option>
              {imageModels.map((model) => (
                <option key={`${model.provider}/${model.modelId}`} value={`${model.provider}/${model.modelId}`}>
                  {model.name}（{model.provider}）
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="tw-field tw-field-wide">
          <span>项目目录</span>
          <div className="tw-path-input">
            <input value={root} disabled={Boolean(project)} onChange={(event) => setRoot(event.target.value)} />
            {!project && (
              <button
                className="tw-icon-button"
                type="button"
                title="选择目录"
                onClick={() => void window.piBridge.selectDirectory().then((value) => value && setRoot(value))}
              >
                <FolderOpen size={16} />
              </button>
            )}
          </div>
        </label>
      </div>
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={saving || !name.trim() || !root || surfaces.length === 0}
          onClick={() => void submit()}
        >
          {saving && <LoaderCircle size={15} className="tw-spin" />}
          {project ? "保存设置" : "创建项目"}
        </button>
      </div>
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: TestWorkbenchProject;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setDeleting(true);
    setError(null);
    try {
      await window.piBridge.deleteProjectData(project.root, confirmation);
      onDeleted();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog title="删除本地项目数据" onClose={onClose}>
      <label className="tw-field">
        <span>输入项目名称确认</span>
        <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-danger"
          type="button"
          disabled={deleting || confirmation !== project.name}
          onClick={() => void submit()}
        >
          {deleting && <LoaderCircle size={15} className="tw-spin" />}
          移到回收站
        </button>
      </div>
    </Dialog>
  );
}

function IdentityPage({
  project,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  project: TestWorkbenchProject;
  busy: boolean;
  onAdd: () => void;
  onEdit: (identityId: string) => void;
  onDelete: (identityId: string) => void;
}) {
  return (
    <AssetPage title="测试身份" empty="">
      <div className="tw-identity-toolbar">
        <button className="tw-button tw-button-primary" type="button" disabled={busy} onClick={onAdd}>
          <Plus size={15} />
          新增身份
        </button>
      </div>
      {project.identities.length === 0 ? (
        <EmptyState icon={Users} title="还没有测试身份" action="新增身份" onAction={onAdd} />
      ) : (
        <div className="tw-identity-list">
          {project.identities.map((identity) => (
            <div className="tw-identity-row" key={identity.id}>
              <span className="tw-project-mark">{identity.name.slice(0, 1)}</span>
              <span className="tw-identity-copy">
                <strong>{identity.name}</strong>
                <small>
                  {identity.surfaces.map((item) => item.toUpperCase()).join(" · ")}
                  {identity.defaultSurfaces.length > 0
                    ? ` · 默认：${identity.defaultSurfaces.map((item) => item.toUpperCase()).join("、")}`
                    : ""}
                </small>
              </span>
              <StatusBadge tone={identity.credentialConfigured ? "success" : "neutral"}>
                <KeyRound size={13} />
                {identity.credentialConfigured ? "凭据已配置" : "人工登录"}
              </StatusBadge>
              <div className="tw-identity-actions">
                <button
                  className="tw-icon-button"
                  type="button"
                  title="编辑身份"
                  disabled={busy}
                  onClick={() => onEdit(identity.id)}
                >
                  <Settings size={15} />
                </button>
                <button
                  className="tw-icon-button"
                  type="button"
                  title="删除身份"
                  disabled={busy}
                  onClick={() => onDelete(identity.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AssetPage>
  );
}

function IdentityDialog({
  project,
  identityId,
  onClose,
  onSaved,
}: {
  project: TestWorkbenchProject;
  identityId: string | null;
  onClose: () => void;
  onSaved: (project: TestWorkbenchProject) => void;
}) {
  const available = project.surfaces
    .map((item) => item.name)
    .filter((name): name is WorkbenchSurface => name === "h5" || name === "admin" || name === "app");
  const existing = identityId ? project.identities.find((identity) => identity.id === identityId) : undefined;
  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [surfaces, setSurfaces] = useState<WorkbenchSurface[]>(existing?.surfaces ?? available.slice(0, 1));
  const [defaults, setDefaults] = useState<WorkbenchSurface[]>(existing?.defaultSurfaces ?? []);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (values: WorkbenchSurface[], value: WorkbenchSurface) =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await window.piBridge.saveIdentity({
        projectRoot: project.root,
        id,
        name,
        surfaces,
        defaultSurfaces: defaults,
        ...(username && password ? { username, password } : {}),
      });
      setUsername("");
      setPassword("");
      onSaved(saved);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title={existing ? "编辑测试身份" : "新增测试身份"} onClose={onClose}>
      <div className="tw-form-grid">
        <label className="tw-field">
          <span>身份 ID</span>
          <input
            autoFocus={!existing}
            value={id}
            disabled={Boolean(existing)}
            onChange={(event) => setId(event.target.value)}
            placeholder="normal-user"
          />
        </label>
        <label className="tw-field">
          <span>名称</span>
          <input
            autoFocus={Boolean(existing)}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="普通用户"
          />
        </label>
        <fieldset className="tw-field tw-field-wide tw-check-group">
          <legend>适用测试端</legend>
          {available.map((item) => (
            <label key={item}>
              <input
                type="checkbox"
                checked={surfaces.includes(item)}
                onChange={() => {
                  const next = toggle(surfaces, item);
                  setSurfaces(next);
                  setDefaults((current) => current.filter((surface) => next.includes(surface)));
                }}
              />
              {item.toUpperCase()}
            </label>
          ))}
        </fieldset>
        <fieldset className="tw-field tw-field-wide tw-check-group">
          <legend>设为默认身份</legend>
          {surfaces.map((item) => (
            <label key={item}>
              <input
                type="checkbox"
                checked={defaults.includes(item)}
                onChange={() => setDefaults(toggle(defaults, item))}
              />
              {item.toUpperCase()}
            </label>
          ))}
        </fieldset>
        <label className="tw-field">
          <span>账号（可选）</span>
          <input value={username} autoComplete="off" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="tw-field">
          <span>密码（可选）</span>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={saving || !id || !name || surfaces.length === 0 || Boolean(username) !== Boolean(password)}
          onClick={() => void submit()}
        >
          {saving && <LoaderCircle size={15} className="tw-spin" />}
          保存身份
        </button>
      </div>
    </Dialog>
  );
}

function ZentaoPage({
  project,
  connections,
  busy,
  canWrite,
  onAdd,
  onEdit,
  onDelete,
  onProjectSaved,
}: {
  project: TestWorkbenchProject;
  connections: TestWorkbenchZentaoConnection[];
  busy: boolean;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onProjectSaved: (project: TestWorkbenchProject) => void;
}) {
  const [selectedConnection, setSelectedConnection] = useState(project.zentao?.connectionId ?? "");
  const [productId, setProductId] = useState(project.zentao?.productId ? String(project.zentao.productId) : "");
  const [moduleId, setModuleId] = useState(project.zentao?.moduleId ? String(project.zentao.moduleId) : "");
  const [openedBuild, setOpenedBuild] = useState(project.zentao?.openedBuild ?? "");
  const [assignedTo, setAssignedTo] = useState(project.zentao?.assignedTo ?? "");
  const [catalog, setCatalog] = useState<TestWorkbenchZentaoCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = connections.find((item) => item.id === selectedConnection);

  useEffect(() => {
    if (!selectedConnection || !productId) {
      setCatalog(null);
      return;
    }
    let cancelled = false;
    setLoadingCatalog(true);
    setError(null);
    void window.piBridge
      .getZentaoCatalog(selectedConnection, Number(productId))
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch((nextError) => {
        if (!cancelled) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId, selectedConnection]);

  const saveMapping = async () => {
    setLoadingCatalog(true);
    setError(null);
    try {
      const saved = await window.piBridge.setProjectZentao(
        selectedConnection
          ? {
              projectRoot: project.root,
              connectionId: selectedConnection,
              productId: Number(productId),
              moduleId: moduleId ? Number(moduleId) : null,
              openedBuild: openedBuild || null,
              assignedTo: assignedTo || null,
            }
          : { projectRoot: project.root, connectionId: null },
      );
      onProjectSaved(saved);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoadingCatalog(false);
    }
  };

  return (
    <AssetPage title="禅道" empty="">
      <div className="tw-asset-toolbar">
        <span>{connections.length} 个全局连接</span>
        <button className="tw-button tw-button-primary" type="button" disabled={!canWrite || busy} onClick={onAdd}>
          <Plus size={15} />
          新增连接
        </button>
      </div>
      <div className="tw-zentao-layout">
        <section>
          <h3>连接</h3>
          {connections.length === 0 ? (
            <EmptyState icon={Link2} title="还没有禅道连接" action="新增连接" onAction={onAdd} />
          ) : (
            <div className="tw-data-list">
              {connections.map((item) => (
                <div key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.baseUrl} · {item.version ?? "版本未知"}
                    </small>
                  </span>
                  <div className="tw-row-actions">
                    <StatusBadge tone={item.connected && item.credentialConfigured ? "success" : "warning"}>
                      {item.connected && item.credentialConfigured ? "已连接" : "待认证"}
                    </StatusBadge>
                    <StatusBadge tone={item.capabilities?.createBug ? "success" : "warning"}>
                      Bug {item.capabilities?.createBug ? "可创建" : "不可创建"}
                    </StatusBadge>
                    <StatusBadge
                      tone={
                        item.capabilities?.attachments === "supported"
                          ? "success"
                          : item.capabilities?.attachments === "unavailable"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      附件 {item.capabilities?.attachments ?? "未探测"}
                    </StatusBadge>
                    <StatusBadge tone={item.capabilities?.comments === "supported" ? "success" : "neutral"}>
                      备注 {item.capabilities?.comments ?? "未探测"}
                    </StatusBadge>
                    <button
                      className="tw-icon-button"
                      type="button"
                      title="编辑并测试连接"
                      disabled={!canWrite || busy}
                      onClick={() => onEdit(item.id)}
                    >
                      <Settings size={15} />
                    </button>
                    <button
                      className="tw-icon-button"
                      type="button"
                      title="删除连接"
                      disabled={!canWrite || busy}
                      onClick={() => onDelete(item.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3>项目映射</h3>
          <div className="tw-form-grid">
            <label className="tw-field tw-field-wide">
              <span>连接</span>
              <select
                value={selectedConnection}
                disabled={!canWrite || busy}
                onChange={(event) => {
                  setSelectedConnection(event.target.value);
                  setProductId("");
                  setModuleId("");
                  setOpenedBuild("");
                  setAssignedTo("");
                }}
              >
                <option value="">不连接禅道</option>
                {connections.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.connected || !item.credentialConfigured}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedConnection && (
              <>
                <label className="tw-field">
                  <span>产品</span>
                  <select
                    value={productId}
                    disabled={!canWrite || busy}
                    onChange={(event) => {
                      setProductId(event.target.value);
                      setModuleId("");
                      setOpenedBuild("");
                    }}
                  >
                    <option value="">选择产品</option>
                    {connection?.products.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tw-field">
                  <span>Bug 模块</span>
                  <select
                    value={moduleId}
                    disabled={!canWrite || busy || loadingCatalog}
                    onChange={(event) => setModuleId(event.target.value)}
                  >
                    <option value="">根模块</option>
                    {catalog?.modules.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tw-field">
                  <span>影响版本</span>
                  <select
                    value={openedBuild}
                    disabled={!canWrite || busy || loadingCatalog}
                    onChange={(event) => setOpenedBuild(event.target.value)}
                  >
                    <option value="">默认 trunk</option>
                    {catalog?.builds.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tw-field">
                  <span>默认指派</span>
                  <select
                    value={assignedTo}
                    disabled={!canWrite || busy || loadingCatalog}
                    onChange={(event) => setAssignedTo(event.target.value)}
                  >
                    <option value="">不指定</option>
                    {(catalog?.users ?? connection?.users ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          {catalog && !catalog.capabilities.createBug && (
            <p className="tw-inline-note">
              Bug 创建不可用
              {catalog.capabilities.unsupportedBugFields.length
                ? `：未适配必填字段 ${catalog.capabilities.unsupportedBugFields.join("、")}`
                : "：能力探测未通过"}
            </p>
          )}
          {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
          <div className="tw-dialog-actions">
            <button
              className="tw-button tw-button-primary"
              type="button"
              disabled={!canWrite || busy || loadingCatalog || Boolean(selectedConnection && !productId)}
              onClick={() => void saveMapping()}
            >
              {loadingCatalog && <LoaderCircle size={15} className="tw-spin" />}
              保存项目映射
            </button>
          </div>
        </section>
      </div>
    </AssetPage>
  );
}

function ZentaoConnectionDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection?: TestWorkbenchZentaoConnection;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [id, setId] = useState(connection?.id ?? "");
  const [name, setName] = useState(connection?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [authMode, setAuthMode] = useState<"token" | "password">("token");
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.piBridge.saveZentaoConnection({
        id,
        name,
        baseUrl,
        ...(authMode === "token" && token ? { token } : {}),
        ...(authMode === "password" ? { account, password } : {}),
      });
      setToken("");
      setPassword("");
      await onSaved();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title={connection ? "编辑禅道连接" : "新增禅道连接"} onClose={onClose}>
      <div className="tw-form-grid">
        <label className="tw-field">
          <span>连接 ID</span>
          <input
            autoFocus={!connection}
            value={id}
            disabled={Boolean(connection)}
            onChange={(event) => setId(event.target.value)}
            placeholder="company-zentao"
          />
        </label>
        <label className="tw-field">
          <span>名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="公司禅道" />
        </label>
        <label className="tw-field tw-field-wide">
          <span>地址</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://zentao.example.com/zentao"
          />
        </label>
        <fieldset className="tw-field tw-field-wide tw-check-group">
          <legend>认证方式</legend>
          <label>
            <input
              type="radio"
              name="zentao-auth"
              checked={authMode === "token"}
              onChange={() => setAuthMode("token")}
            />
            Token
          </label>
          <label>
            <input
              type="radio"
              name="zentao-auth"
              checked={authMode === "password"}
              onChange={() => setAuthMode("password")}
            />
            账号密码换取 Token
          </label>
        </fieldset>
        {authMode === "token" ? (
          <label className="tw-field tw-field-wide">
            <span>{connection?.credentialConfigured ? "Token（留空沿用现有）" : "Token"}</span>
            <input
              type="password"
              value={token}
              autoComplete="new-password"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="tw-field">
              <span>账号</span>
              <input value={account} autoComplete="off" onChange={(event) => setAccount(event.target.value)} />
            </label>
            <label className="tw-field">
              <span>密码</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={
            saving ||
            !id ||
            !name ||
            !baseUrl ||
            (authMode === "token" ? !token && !connection?.credentialConfigured : !account || !password)
          }
          onClick={() => void submit()}
        >
          {saving && <LoaderCircle size={15} className="tw-spin" />}
          测试并保存
        </button>
      </div>
    </Dialog>
  );
}

function FindingsPage({
  project,
  connections,
  busy,
  canWrite,
  onSubmit,
  onRefresh,
  onRetest,
}: {
  project: TestWorkbenchProject;
  connections: TestWorkbenchZentaoConnection[];
  busy: boolean;
  canWrite: boolean;
  onSubmit: (findingId: string) => void;
  onRefresh: (findingId: string) => void;
  onRetest: (findingId: string) => void;
}) {
  const capability = (finding: TestWorkbenchProject["findings"][number]) =>
    connections.find((connection) => connection.id === finding.remote?.connectionId)?.capabilities;
  return (
    <AssetPage title="问题" empty="还没有记录问题。">
      {project.findings.length ? (
        <div className="tw-data-list">
          {project.findings.map((finding) => (
            <div key={finding.id}>
              <span>
                <strong>{finding.title}</strong>
                <small>
                  {finding.severity.toUpperCase()} · {finding.status} · {finding.id}
                  {finding.remote?.bugId
                    ? ` · Bug #${finding.remote.bugId} · ${finding.remote.status ?? "状态未知"}`
                    : ""}
                </small>
                {finding.remote?.lastError && <small className="tw-danger-text">{finding.remote.lastError}</small>}
              </span>
              <div className="tw-row-actions">
                <StatusBadge
                  tone={
                    finding.remote?.syncStatus === "submitted"
                      ? "success"
                      : finding.remote?.syncStatus === "failed"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {finding.remote?.syncStatus ?? "未提交"}
                </StatusBadge>
                {!finding.remote?.bugId ? (
                  <button
                    className="tw-button tw-button-secondary"
                    type="button"
                    disabled={!canWrite || busy || !project.zentao}
                    onClick={() => onSubmit(finding.id)}
                  >
                    <Bug size={14} />
                    提交
                  </button>
                ) : (
                  <>
                    <button
                      className="tw-icon-button"
                      type="button"
                      title="刷新远端状态"
                      disabled={!canWrite || busy}
                      onClick={() => onRefresh(finding.id)}
                    >
                      <RefreshCw size={15} />
                    </button>
                    <button
                      className="tw-icon-button"
                      type="button"
                      title={
                        capability(finding)?.comments === "unavailable"
                          ? "当前禅道现代 REST API 不支持备注写入"
                          : "追加复测备注和证据"
                      }
                      disabled={!canWrite || busy || capability(finding)?.comments === "unavailable"}
                      onClick={() => onRetest(finding.id)}
                    >
                      <ClipboardCheck size={15} />
                    </button>
                    <button
                      className="tw-icon-button"
                      type="button"
                      title="打开禅道详情"
                      onClick={() => void window.piBridge.openZentaoBug(project.root, finding.id)}
                    >
                      <ExternalLink size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={Bug} title="还没有记录问题。" />
      )}
    </AssetPage>
  );
}

function ZentaoBugDialog({
  project,
  findingId,
  onClose,
  onSubmitted,
}: {
  project: TestWorkbenchProject;
  findingId: string;
  onClose: () => void;
  onSubmitted: (project: TestWorkbenchProject) => void;
}) {
  const [draft, setDraft] = useState<TestWorkbenchZentaoBugDraft | null>(null);
  const [availableEvidence, setAvailableEvidence] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.piBridge
      .prepareZentaoBug(project.root, findingId)
      .then((value) => {
        if (!cancelled) {
          setDraft(value);
          setAvailableEvidence(value.evidence);
        }
      })
      .catch((nextError) => !cancelled && setError(errorMessage(nextError)));
    return () => {
      cancelled = true;
    };
  }, [findingId, project.root]);
  const submit = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      onSubmitted(await window.piBridge.submitZentaoBug(draft));
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title="提交禅道 Bug" onClose={onClose}>
      {!draft && !error ? (
        <EmptyState icon={LoaderCircle} title="正在读取禅道能力" spinning />
      ) : draft ? (
        <div className="tw-form-grid">
          <label className="tw-field tw-field-wide">
            <span>标题</span>
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label className="tw-field">
            <span>严重程度</span>
            <select
              value={draft.severity}
              onChange={(event) => setDraft({ ...draft, severity: Number(event.target.value) })}
            >
              {[1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="tw-field">
            <span>优先级</span>
            <select
              value={draft.priority}
              onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })}
            >
              {[1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="tw-field">
            <span>类型</span>
            <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
              {draft.bugTypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="tw-field tw-field-wide">
            <span>描述</span>
            <textarea
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <div className="tw-field tw-field-wide">
            <span>来源标识</span>
            <code>{draft.marker}</code>
          </div>
          <fieldset className="tw-field tw-field-wide tw-check-group">
            <legend>证据附件</legend>
            {availableEvidence.map((item) => (
              <label key={item}>
                <input
                  type="checkbox"
                  checked={draft.evidence.includes(item)}
                  onChange={() =>
                    setDraft({
                      ...draft,
                      evidence: draft.evidence.includes(item)
                        ? draft.evidence.filter((evidence) => evidence !== item)
                        : [...draft.evidence, item],
                    })
                  }
                />
                {item.split("/").pop()}
              </label>
            ))}
          </fieldset>
        </div>
      ) : null}
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={saving || !draft || !draft.title || !draft.description}
          onClick={() => void submit()}
        >
          {saving && <LoaderCircle size={15} className="tw-spin" />}
          提交
        </button>
      </div>
    </Dialog>
  );
}

function ZentaoRetestDialog({
  project,
  findingId,
  onClose,
  onSubmitted,
}: {
  project: TestWorkbenchProject;
  findingId: string;
  onClose: () => void;
  onSubmitted: (project: TestWorkbenchProject) => void;
}) {
  const finding = project.findings.find((item) => item.id === findingId);
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onSubmitted(await window.piBridge.appendZentaoRetest({ projectRoot: project.root, findingId, note, evidence }));
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title="追加复测记录" onClose={onClose}>
      <label className="tw-field">
        <span>复测备注</span>
        <textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {finding?.evidence.length ? (
        <fieldset className="tw-field tw-check-group">
          <legend>追加证据</legend>
          {finding.evidence.map((item) => (
            <label key={item}>
              <input
                type="checkbox"
                checked={evidence.includes(item)}
                onChange={() =>
                  setEvidence((current) =>
                    current.includes(item) ? current.filter((value) => value !== item) : [...current, item],
                  )
                }
              />
              {item.split("/").pop()}
            </label>
          ))}
        </fieldset>
      ) : null}
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={saving || !note.trim()}
          onClick={() => void submit()}
        >
          {saving && <LoaderCircle size={15} className="tw-spin" />}
          追加
        </button>
      </div>
    </Dialog>
  );
}

function FindingDialog({
  project,
  sessionId,
  surface,
  evidence,
  onClose,
  onCreated,
}: {
  project: TestWorkbenchProject;
  sessionId: string;
  surface: WorkbenchSurface;
  evidence: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [severity, setSeverity] = useState<TestWorkbenchFindingInput["severity"]>("p2");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.piBridge.createFinding({
        projectRoot: project.root,
        sessionId,
        surface,
        title,
        summary,
        stepsToReproduce: steps
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        expected,
        actual,
        severity,
        evidence,
      });
      onCreated();
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title="记录问题" onClose={onClose}>
      <div className="tw-form-grid">
        <label className="tw-field tw-field-wide">
          <span>标题</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="tw-field">
          <span>严重程度</span>
          <select value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}>
            <option value="p0">P0</option>
            <option value="p1">P1</option>
            <option value="p2">P2</option>
            <option value="p3">P3</option>
          </select>
        </label>
        <label className="tw-field tw-field-wide">
          <span>摘要</span>
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <label className="tw-field tw-field-wide">
          <span>复现步骤（每行一步）</span>
          <textarea value={steps} onChange={(event) => setSteps(event.target.value)} />
        </label>
        <label className="tw-field">
          <span>预期结果</span>
          <textarea value={expected} onChange={(event) => setExpected(event.target.value)} />
        </label>
        <label className="tw-field">
          <span>实际结果</span>
          <textarea value={actual} onChange={(event) => setActual(event.target.value)} />
        </label>
        <div className="tw-field tw-field-wide">
          <span>证据</span>
          <code>{evidence}</code>
        </div>
      </div>
      {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
      <div className="tw-dialog-actions">
        <button className="tw-button tw-button-secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={saving || !title || !summary || !steps || !expected || !actual}
          onClick={() => void submit()}
        >
          {saving && <LoaderCircle size={15} className="tw-spin" />}保存问题
        </button>
      </div>
    </Dialog>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="tw-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="tw-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="tw-icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="tw-dialog-body">{children}</div>
      </div>
    </div>
  );
}

function ModelsDialog({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  return (
    <Dialog title="AI 服务" onClose={onClose}>
      <div className="tw-models-dialog">
        <ModelsConfig embedded cwd={cwd} onClose={() => undefined} />
      </div>
    </Dialog>
  );
}

function EvidenceDialog({
  evidence,
  onClose,
}: {
  evidence: { path: string; dataUrl: string | null; text: string | null };
  onClose: () => void;
}) {
  return (
    <Dialog title="证据预览" onClose={onClose}>
      <figure className="tw-evidence-preview">
        {evidence.dataUrl ? <img src={evidence.dataUrl} alt="测试证据" /> : <pre>{evidence.text}</pre>}
        <figcaption>{evidence.path}</figcaption>
      </figure>
    </Dialog>
  );
}

function AssetPage({ title, empty, children }: { title: string; empty: string; children?: React.ReactNode }) {
  return (
    <div className="tw-asset-page">
      <header>
        <h2>{title}</h2>
      </header>
      {children ?? <EmptyState icon={FileCheck2} title={empty} />}
    </div>
  );
}

function CasesPage({
  project,
  busy,
  canRun,
  onRun,
  onStatus,
}: {
  project: TestWorkbenchProject;
  busy: boolean;
  canRun: boolean;
  onRun: () => void;
  onStatus: (caseId: string, status: "draft" | "stable" | "disabled") => void;
}) {
  const stableCount = project.cases.filter((item) => item.status === "stable").length;
  return (
    <AssetPage title="测试用例" empty="还没有测试用例。">
      <div className="tw-asset-toolbar">
        <span>{stableCount} 个可重复运行用例</span>
        <button
          className="tw-button tw-button-primary"
          type="button"
          disabled={!canRun || busy || stableCount === 0}
          onClick={onRun}
        >
          {busy && <LoaderCircle size={15} className="tw-spin" />}
          <Play size={15} />
          运行稳定用例
        </button>
      </div>
      {project.cases.length ? (
        <div className="tw-data-list">
          {project.cases.map((item) => (
            <div key={item.id}>
              <span>
                <strong>{item.title}</strong>
                <small>
                  {item.surface.toUpperCase()} · {item.id}
                </small>
              </span>
              <div className="tw-row-actions">
                <StatusBadge tone={item.status === "stable" ? "success" : "neutral"}>{item.status}</StatusBadge>
                <select
                  aria-label={`${item.title} 状态`}
                  value={item.status}
                  disabled={busy}
                  onChange={(event) => onStatus(item.id, event.target.value as "draft" | "stable" | "disabled")}
                >
                  <option value="draft">待完善</option>
                  <option value="stable">可重复运行</option>
                  <option value="disabled">已停用</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={FileCheck2} title="还没有测试用例。" />
      )}
    </AssetPage>
  );
}

function RunsPage({ project, onEvidence }: { project: TestWorkbenchProject; onEvidence: (path: string) => void }) {
  return (
    <AssetPage title="执行记录" empty="还没有执行记录。">
      {project.runs.length ? (
        <div className="tw-data-list">
          {project.runs.map((run) => (
            <div key={run.id}>
              <span>
                <strong>{run.title}</strong>
                <small>
                  {new Date(run.startedAt).toLocaleString("zh-CN")} · {run.evidence.length} 个证据
                </small>
              </span>
              <div className="tw-row-actions">
                {run.evidence[0] && (
                  <button
                    className="tw-icon-button"
                    type="button"
                    title="查看证据"
                    onClick={() => onEvidence(run.evidence[0])}
                  >
                    <Image size={15} />
                  </button>
                )}
                <StatusBadge
                  tone={run.status === "passed" ? "success" : run.status === "failed" ? "danger" : "neutral"}
                >
                  {RUN_STATUS_LABEL[run.status] ?? run.status}
                </StatusBadge>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={ClipboardCheck} title="还没有执行记录。" />
      )}
    </AssetPage>
  );
}
