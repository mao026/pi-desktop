import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionFromServicesOptions,
  type AgentSessionRuntimeDiagnostic,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import path from "node:path";
import { cacheSessionPath } from "./session-reader";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "../shared/pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "../shared/types";
import { toolchainRuntime } from "./toolchain-runtime";
import { createToolchainBashOptions } from "./toolchain-bash";
import { createDesktopSearchToolDefinitions } from "./toolchain-search";
import { projectExtensionDiagnostics } from "./extension-diagnostics";
import { callMain } from "./parent-rpc";
import {
  createTestExtension,
  createTypedTestHostCall,
  TEST_TOOL_NAMES,
  type TestVisualAnalyzer,
} from "../../packages/pi-test/extension/index.ts";
import { analyzeVisualScreenshot } from "./visual-model";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

export type AgentSessionMode = "general" | "test";

const PI_TEST_SESSION_MARKER = "pi-test-session";
const PI_TEST_SYSTEM_PROMPT = [
  "你是 Pi 专用测试工作台中的测试 Agent。",
  "只使用固定 test_setup、test_run、test_observe、test_act、test_map、test_case、test_play 和 test_finding 工具；不得使用 Bash、任意文件工具、Git、Electron Browser 或第三方资源。",
  "所有现场操作由 Main Test Coordinator 统一执行，并遵守 readiness、全局租约、生产只读和风险确认门禁。",
].join("\n");

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const LEGACY_CHANNEL_PROMPT = /^\[外部消息来源：(微信|Telegram|飞书 \/ Lark)\]\n/;
const LEGACY_CHANNEL_PROMPT_DELIMITER = "\n---\n";

function stripLegacyChannelPromptText(text: string): string {
  if (!LEGACY_CHANNEL_PROMPT.test(text)) return text;
  const delimiter = text.indexOf(LEGACY_CHANNEL_PROMPT_DELIMITER);
  return delimiter < 0 ? text : text.slice(delimiter + LEGACY_CHANNEL_PROMPT_DELIMITER.length);
}

function stripLegacyChannelPrompts(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return message;
    const user = message as { content?: unknown };
    if (typeof user.content === "string") {
      const content = stripLegacyChannelPromptText(user.content);
      return content === user.content ? message : { ...message, content };
    }
    if (!Array.isArray(user.content)) return message;

    let changed = false;
    const content = user.content.map((block) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") return block;
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") return block;
      const stripped = stripLegacyChannelPromptText(text);
      if (stripped === text) return block;
      changed = true;
      return { ...block, text: stripped };
    });
    return changed ? { ...message, content } : message;
  });
}

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...toolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  public readonly inner: AgentSessionLike;
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private runtimeDiagnosticStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private extensionWorkingMessage = "Working";
  private extensionWorkingIndicator = "";
  private extensionWorkingVisible = true;
  private extensionEditorText = "";
  private unsupportedExtensionFeatures = new Set<string>();
  private promptRunning = false;
  private queuedTurnCount = 0;
  private turnTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private toolchainPrompt = "";
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;

  constructor(
    inner: AgentSessionLike,
    public readonly sessionMode: AgentSessionMode = "general",
  ) {
    this.inner = inner;
    const messages = this.inner.agent.state?.messages;
    if (Array.isArray(messages)) this.inner.agent.state!.messages = stripLegacyChannelPrompts(messages);
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    const cwd = this.inner.sessionManager.getHeader()?.cwd;
    return typeof cwd === "string" ? cwd : "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return (
      this._alive &&
      (this.promptRunning || this.queuedTurnCount > 0 || this.inner.isStreaming || this.inner.isCompacting)
    );
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.resetIdleTimer();
      this.emit(event);
      // Streaming / compaction / tool events flow through here; re-broadcast
      // the running-status snapshot so the sidebar can update live.
      notifyRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  syncBrowserToolActivation(): void {
    if (this.sessionMode === "test") {
      this.inner.setActiveToolsByName([...TEST_TOOL_NAMES]);
    }
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  setToolchainSummary(revision: number, summary: readonly string[]): void {
    this.toolchainPrompt = [
      `<pi-desktop-toolchain revision="${revision}">`,
      ...summary,
      "</pi-desktop-toolchain>",
    ].join("\n");
    this.applyToolchainSummary();
  }

  setRuntimeDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
    this.runtimeDiagnosticStatuses = new Map(
      projectExtensionDiagnostics(diagnostics).map(({ key, text }) => [key, text]),
    );
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error(
        "[pi-desktop] failed to dispatch session_start to extensions:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () =>
            this.emit({
              type: "extension_ui_request",
              id: randomUUID(),
              method: "notify",
              notifyType: "warning",
              message: "Extension requested shutdown, but shutdown is not supported in Pi Desktop.",
            } as ExtensionUiRequest as AgentEvent),
          onError: (error) =>
            this.emit({
              type: "extension_error",
              extensionPath: error.extensionPath,
              event: error.event,
              error: error.error,
            }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pi-desktop] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = "";
    }
  }

  private applyToolchainSummary(): void {
    if (this.forceEmptySystemPrompt || !this.toolchainPrompt || !this.inner.agent.state) return;
    const marker = /\n*<pi-desktop-toolchain revision="\d+">[\s\S]*?<\/pi-desktop-toolchain>\n*/g;
    const base = String(this.inner.agent.state.systemPrompt ?? "")
      .replace(marker, "")
      .trimEnd();
    this.inner.agent.state.systemPrompt = `${base}\n\n${this.toolchainPrompt}`.trim();
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private enqueueTurn<T>(task: () => Promise<T>): Promise<T> {
    this.queuedTurnCount += 1;
    notifyRunningChange();
    const run = this.turnTail
      .catch(() => undefined)
      .then(async () => {
        if (!this._alive) throw new Error("Agent session is no longer available");
        this.promptRunning = true;
        notifyRunningChange();
        try {
          return await task();
        } finally {
          this.promptRunning = false;
          this.queuedTurnCount = Math.max(0, this.queuedTurnCount - 1);
          notifyRunningChange();
        }
      });
    this.turnTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reloadSessionResources(): Promise<void> {
    await this.waitForExtensionsBound();
    this.extensionStatuses.clear();
    this.extensionWidgets.clear();
    await this.inner.reload();
    if (typeof this.inner.bindExtensions !== "function") {
      this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
    }
    this.applyForcedEmptySystemPrompt();
    this.applyToolchainSummary();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        // Never idle-evict a still-running agent (ISSUE-003)
        if (this.isRunning()) {
          this.resetIdleTimer();
          return;
        }
        this.destroy();
      },
      10 * 60 * 1000,
    );
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    switch (type) {
      case "prompt": {
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        const invokePrompt = () =>
          this.inner.prompt(command.message as string, {
            ...(promptImages?.length ? { images: promptImages } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            source: "rpc",
          });
        const operation = streamingBehavior ? invokePrompt() : this.enqueueTurn(invokePrompt);
        operation
          .then(() => {
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          })
          .catch((error) => {
            this.emit({
              type: "prompt_error",
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          });
        return null;
      }

      case "abort":
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        if (this.sessionMode === "test") throw new Error("测试会话不允许分叉");
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (
          level === "xhigh" &&
          (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat ===
            "deepseek" &&
          this.inner.agent?.state
        ) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        const result = await this.withFinalRunningNotification(() =>
          this.enqueueTurn(() => this.inner.compact(command.customInstructions as string | undefined)),
        );
        return result;
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
        this.syncBrowserToolActivation();
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.enqueueTurn(() => this.reloadSessionResources());
        this.syncBrowserToolActivation();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  /**
   * Stop the underlying agent and release resources (ISSUE-001).
   * Prefer dispose() for full teardown after abort.
   */
  async abortAndDispose(): Promise<void> {
    if (!this._alive) return;
    try {
      await this.inner.abort();
    } catch {
      /* already stopped */
    }
    try {
      const agent = this.inner.agent as { waitForIdle?: () => Promise<void>; dispose?: () => void | Promise<void> };
      await agent.waitForIdle?.();
      await agent.dispose?.();
    } catch {
      /* best-effort */
    }
    this.destroy();
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.sessionMode === "test") {
      void callMain("test.sessionEnded", { sessionId: this.sessionId }).catch(() => undefined);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.listeners = [];
    this.onDestroyCallback?.();
    notifyRunningChange();
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(new Map([...this.runtimeDiagnosticStatuses, ...this.extensionStatuses]), ([key, text]) => ({
      key,
      text,
    }));
  }

  private setExtensionStatus(key: string, text: string | undefined): void {
    if (text === undefined) this.extensionStatuses.delete(key);
    else this.extensionStatuses.set(key, text);
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setStatus",
      statusKey: key,
      statusText: text,
    } as ExtensionUiRequest as AgentEvent);
  }

  private syncExtensionWorkingStatus(): void {
    this.setExtensionStatus(
      "extension-working",
      this.extensionWorkingVisible
        ? [this.extensionWorkingIndicator, this.extensionWorkingMessage].filter(Boolean).join(" ")
        : undefined,
    );
  }

  private reportUnsupportedExtensionFeature(feature: string): void {
    if (this.unsupportedExtensionFeatures.has(feature)) return;
    this.unsupportedExtensionFeatures.add(feature);
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "notify",
      message: `Extension feature “${feature}” is terminal-specific and is not available in the desktop renderer.`,
      notifyType: "warning",
    } as ExtensionUiRequest as AgentEvent);
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return 92;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return 92;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width) ? Math.max(40, Math.min(140, Math.round(width))) : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(factory: unknown, options?: unknown): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      const tui = {
        requestRender: () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
      };
      const done = (value: T) => this.closeCustomUi(id, value);

      Promise.resolve()
        .then(() => factory(tui, undefined, undefined, done))
        .then((component) => {
          if (
            !component ||
            typeof component !== "object" ||
            typeof (component as CustomUiComponent).render !== "function"
          ) {
            resolve(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => resolve(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          resolve(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) =>
        this.requestExtensionUi(
          { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          opts?.timeout,
          opts?.signal,
        ),
      confirm: (title, message, opts) =>
        this.requestExtensionUi(
          { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
          false,
          (response) => ("confirmed" in response ? response.confirmed : false),
          opts?.timeout,
          opts?.signal,
        ),
      input: (title, placeholder, opts) =>
        this.requestExtensionUi(
          {
            method: "input",
            title,
            ...(placeholder !== undefined ? { placeholder } : {}),
            ...(opts?.timeout ? { timeout: opts.timeout } : {}),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          opts?.timeout,
          opts?.signal,
        ),
      editor: (title, prefill, opts) =>
        this.requestExtensionUi(
          {
            method: "editor",
            title,
            ...(prefill !== undefined ? { prefill } : {}),
            ...(opts?.timeout ? { timeout: opts.timeout } : {}),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          opts?.timeout,
          opts?.signal,
        ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => {
        this.reportUnsupportedExtensionFeature("raw terminal input");
        return () => {};
      },
      setStatus: (key, text) => {
        this.setExtensionStatus(key, text);
      },
      setWorkingMessage: (message) => {
        this.extensionWorkingMessage = message?.trim() || "Working";
        this.syncExtensionWorkingStatus();
      },
      setWorkingVisible: (visible) => {
        this.extensionWorkingVisible = visible;
        this.syncExtensionWorkingStatus();
      },
      setWorkingIndicator: (options) => {
        const frame = options?.frames?.[0];
        if (options?.frames?.length === 0) this.extensionWorkingVisible = false;
        else {
          this.extensionWorkingVisible = true;
          this.extensionWorkingIndicator = frame ?? "";
        }
        this.syncExtensionWorkingStatus();
      },
      setHiddenThinkingLabel: (label) => {
        this.setExtensionStatus("hidden-thinking-label", label);
      },
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => this.reportUnsupportedExtensionFeature("custom TUI footer"),
      setHeader: () => this.reportUnsupportedExtensionFeature("custom TUI header"),
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.extensionEditorText += text;
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.extensionEditorText = text;
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => this.extensionEditorText,
      addAutocompleteProvider: () => this.reportUnsupportedExtensionFeature("TUI autocomplete provider"),
      setEditorComponent: () => this.reportUnsupportedExtensionFeature("custom TUI editor component"),
      getEditorComponent: () => undefined,
      get theme() {
        return undefined;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: "Theme switching is not supported in the Pi Desktop extension UI yet",
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => {
        this.reportUnsupportedExtensionFeature("extension-driven session replacement");
        return { cancelled: true };
      },
      fork: async () => {
        this.reportUnsupportedExtensionFeature("extension-driven session fork");
        return { cancelled: true };
      },
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => {
        this.reportUnsupportedExtensionFeature("extension-driven session switch");
        return { cancelled: true };
      },
      reload: async () => {
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyForcedEmptySystemPrompt();
      },
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

const sessionRegistry = new Map<string, AgentSessionWrapper>();
const startLocks = new Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>>();
const runningListeners = new Set<(ids: string[]) => void>();
let registryCleanupInstalled = false;

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!registryCleanupInstalled) {
    registryCleanupInstalled = true;
    const cleanup = () => sessionRegistry.forEach((session) => session.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return sessionRegistry;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  return startLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// MessagePort updates instead of polling.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  return runningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers. Cheap to call often.
 */
export function notifyRunningChange(): void {
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of getRunningListeners()) {
    try {
      listener(ids);
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  requestedMode: AgentSessionMode = "general",
  authorizeTestSession: (projectRoot: string) => Promise<unknown> = (projectRoot) =>
    callMain("test.authorizeSession", { projectRoot }, 10_000),
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const agentDir = getAgentDir();

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);
    const sessionMode: AgentSessionMode =
      requestedMode === "test" ||
      sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === PI_TEST_SESSION_MARKER)
        ? "test"
        : "general";
    if (sessionMode === "test") await authorizeTestSession(cwd);

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in desktop sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = toolNames.length === 0 ? [] : undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    const piTestRoot = path.resolve(import.meta.dirname, "../../packages/pi-test");
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(sessionMode === "test"
        ? {
            resourceLoaderOptions: {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              extensionFactories: [
                {
                  name: "pi-test",
                  factory: createTestExtension(createTypedTestHostCall(callMain), ((input) =>
                    analyzeVisualScreenshot(services.modelRuntime, input)) satisfies TestVisualAnalyzer),
                },
              ],
              additionalSkillPaths: [path.join(piTestRoot, "workflows")],
              systemPrompt: PI_TEST_SYSTEM_PROMPT,
            },
          }
        : {}),
    });
    const executionContext =
      sessionMode === "test"
        ? null
        : await toolchainRuntime.createExecutionContext({
            cwd,
            intent: "agent-shell",
            trusted: services.settingsManager.isProjectTrusted(),
          });
    const customTools =
      sessionMode === "test"
        ? []
        : ([
            createBashToolDefinition(
              cwd,
              createToolchainBashOptions(
                executionContext!,
                toolchainRuntime,
                services.settingsManager.getShellCommandPrefix(),
              ),
            ),
            ...createDesktopSearchToolDefinitions(cwd, executionContext!, toolchainRuntime),
          ] as unknown as NonNullable<CreateAgentSessionFromServicesOptions["customTools"]>);
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionMode === "test"
        ? { tools: [...TEST_TOOL_NAMES], noTools: "builtin" as const }
        : toolsOption !== undefined
          ? { tools: toolsOption }
          : {}),
      customTools,
    });

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in Pi Desktop just like in the `pi` CLI.
    if (sessionMode === "test") {
      inner.setActiveToolsByName([...TEST_TOOL_NAMES]);
    } else if (toolNames && toolNames.length > 0) {
      inner.setActiveToolsByName(withExtensionTools(inner, toolNames));
    }

    const wrapper = new AgentSessionWrapper(inner, sessionMode);
    wrapper.setRuntimeDiagnostics(services.diagnostics);
    if (executionContext) wrapper.setToolchainSummary(executionContext.inventoryRevision, executionContext.summary);
    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // keep this forced after extension resource discovery and reloads as well.
    if (sessionMode !== "test" && toolNames?.length === 0) {
      wrapper.setForceEmptySystemPrompt(true);
    }
    wrapper.start();
    wrapper.syncBrowserToolActivation();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (!sessionFile && sessionMode === "test")
      inner.sessionManager.appendCustomEntry(PI_TEST_SESSION_MARKER, { version: 1 });
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);
    wrapper.beginExtensionBinding({ forceEmptySystemPrompt: sessionMode !== "test" && toolNames?.length === 0 });

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
