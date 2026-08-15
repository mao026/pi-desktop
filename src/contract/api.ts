import type {
  AgentCommand,
  AgentEvent,
  CredentialMutationResult,
  EntryContentResult,
  FileContent,
  HistoryWindow,
  LoginProgressEvent,
  ModelPreferencesResult,
  ModelsConfig,
  ModelsListResult,
  PagedContextInfo,
  ProviderStatus,
  RunningStateEvent,
  SessionDetail,
  SessionInfo,
  SessionRuntimeState,
  TestResult,
} from "./types";
import type { ToolCapabilityId, ToolProvider } from "../shared/toolchains/types";

/** Request/response API surface (replaces HTTP routes). */
export interface Api {
  "host.ping": { params: void; result: { ok: true; ts: number } };
  "host.toolchain": {
    params: { cwd: string };
    result: {
      inventoryRevision: number;
      resolutionId: string;
      capabilities: Partial<Record<ToolCapabilityId, { provider: ToolProvider; version: string }>>;
    };
  };

  // Sessions & projects
  "sessions.list": {
    params: { cwd?: string } | void;
    result: { sessions: SessionInfo[]; runningSessionIds: string[] };
  };
  "sessions.get": {
    params: { id: string; includeState?: boolean; traceId?: string; historyWindow?: HistoryWindow };
    result: SessionDetail;
  };
  "sessions.context": {
    params: { id: string; leafId?: string; historyWindow?: HistoryWindow };
    result: { context: PagedContextInfo };
  };
  "sessions.contextPage": {
    params: { id: string; cursor: string; maxTurns?: number; maxBytes?: number };
    result: { context: PagedContextInfo };
  };
  "sessions.entryContent": {
    params: { id: string; entryId: string; blockIndex?: number };
    result: EntryContentResult;
  };
  "sessions.export": {
    params: { id: string; format?: "md" | "json" };
    result: { content: string; suggestedName: string };
  };
  "sessions.delete": { params: { id: string; force?: boolean }; result: { ok: true } };
  "sessions.rename": {
    params: { id: string; name: string };
    result: { ok: true };
  };

  // Agent lifecycle
  "agent.new": {
    params: {
      cwd: string;
      type?: string;
      message?: string;
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: string;
      sessionMode?: "general" | "test";
      [key: string]: unknown;
    };
    result: { sessionId: string; data?: unknown };
  };
  "agent.command": {
    params: { sessionId: string; command: AgentCommand };
    result: unknown;
  };
  "agent.state": {
    params: { sessionId: string };
    result: { running: boolean; state?: SessionRuntimeState };
  };

  // Read-only file access for markdown blob rendering
  "files.read": {
    params: { path: string; sourceSessionId?: string };
    result: FileContent & { encoding?: "utf8" | "base64" | "too_large"; mime?: string };
  };
  "files.download": {
    params: { path: string; sourceSessionId?: string };
    result: { base64: string; size: number; mime: string };
  };

  // Config
  "models.list": {
    params: { cwd?: string } | void;
    result: ModelsListResult;
  };
  "models.refresh": {
    params: { cwd?: string; requestId: string };
    result: ModelsListResult;
  };
  "models.refreshCancel": {
    params: { requestId: string };
    result: { ok: true; cancelled: boolean };
  };
  "models.preferences.get": {
    params: { cwd?: string } | void;
    result: ModelPreferencesResult;
  };
  "models.preferences.set": {
    params: { cwd?: string; enabledModels: string[] | null };
    result: ModelPreferencesResult;
  };
  "modelsConfig.get": { params: void; result: ModelsConfig };
  "modelsConfig.set": { params: ModelsConfig; result: { ok: true } };
  "modelsConfig.test": {
    params: {
      providerName?: string;
      provider?: Record<string, unknown>;
      model?: Record<string, unknown>;
      [key: string]: unknown;
    };
    result: TestResult;
  };

  "auth.providers": { params: void; result: { providers: ProviderStatus[] } };
  "auth.allProviders": { params: void; result: { providers: ProviderStatus[] } };
  "auth.setApiKey": {
    params: { provider: string; key: string };
    result: CredentialMutationResult;
  };
  "auth.deleteApiKey": {
    params: { provider: string };
    result: CredentialMutationResult;
  };
  "auth.logout": { params: { provider: string }; result: CredentialMutationResult };
  "auth.loginSubmit": {
    params: { provider: string; token: string; code: string };
    result: { ok: true };
  };
  /** Kick off OAuth login; progress arrives on Streams["auth.login"]. */
  "auth.loginStart": {
    params: { provider: string };
    result: { ok: true; started: boolean };
  };
  "auth.loginCancel": {
    params: { provider: string };
    result: { ok: true };
  };

  // System / desktop helpers exposed via Host (or main-bridged)
  "system.home": { params: void; result: { home: string } };
  "system.validateCwd": {
    params: { path: string };
    result: { ok: boolean; path?: string; error?: string };
  };
  "system.defaultCwd": { params: void; result: { cwd: string } };
  "system.allowRoot": { params: { path: string }; result: { ok: true } };
  "system.runningCount": { params: void; result: { count: number; sessionIds: string[] } };
}

/** Server-push streams delivered over MessagePort RPC. */
export interface Streams {
  "agent.events": AgentEvent;
  "agent.running": RunningStateEvent;
  "auth.login": LoginProgressEvent;
  "sessions.changed": {
    cwd: string | null;
    sessionId?: string;
    session?: SessionInfo;
    deleted?: boolean;
    fullRefresh?: boolean;
  };
  "host.restarted": { reason: string };
  "host.ready": { ts: number };
}

export type ApiMethod = keyof Api;
export type StreamTopic = keyof Streams;

export type ApiParams<M extends ApiMethod> = Api[M]["params"];
export type ApiResult<M extends ApiMethod> = Api[M]["result"];
