import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  TestActRequest,
  TestCaseRequest,
  TestFindingRequest,
  TestHostCall,
  TestHostMethod,
  TestHostParams,
  TestHostResult,
  TestMapRequest,
  TestObserveRequest,
  TestPlayRequest,
  TestRunRequest,
} from "../contract.ts";

export const TEST_TOOL_NAMES = [
  "test_setup",
  "test_run",
  "test_observe",
  "test_act",
  "test_map",
  "test_case",
  "test_play",
  "test_finding",
] as const;

const Surface = Type.Union([
  Type.Literal("h5"),
  Type.Literal("admin"),
  Type.Literal("app"),
  Type.Literal("miniprogram"),
]);
const MapSection = Type.Union([
  Type.Literal("modules"),
  Type.Literal("flows"),
  Type.Literal("roles"),
  Type.Literal("open_questions"),
]);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export type TestVisualAnalyzer = (input: {
  model: NonNullable<TestHostResult<"test.observe">["visualModel"]>;
  image: NonNullable<TestHostResult<"test.observe">["image"]>;
  instruction: string;
  signal?: AbortSignal;
}) => Promise<string>;

async function observeResult(
  value: TestHostResult<"test.observe">,
  analyzeVisual: TestVisualAnalyzer,
  signal?: AbortSignal,
) {
  if (!value.image) return result(value);
  if (!value.visualModel) throw new Error("项目未配置视觉模型");
  const analysis = await analyzeVisual({
    model: value.visualModel,
    image: value.image,
    instruction: value.text,
    signal,
  });
  const details = { ...value };
  delete details.image;
  return {
    content: [
      {
        type: "text" as const,
        text: `视觉模型 ${value.visualModel.provider}/${value.visualModel.modelId} 分析结果：\n${analysis}`,
      },
    ],
    details,
  };
}

function contextFor(ctx: { cwd: string; sessionManager: { getSessionId(): string } }) {
  return { projectRoot: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

export function createTestExtension(callHost: TestHostCall, analyzeVisual: TestVisualAnalyzer) {
  return function registerPiTest(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "test_setup",
      label: "检查测试环境",
      description: "检查项目各测试端的真实 readiness、当前执行和身份配置；只读，不安装或连接设备。",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        return result(await callHost("test.setup", contextFor(ctx)));
      },
    });

    pi.registerTool({
      name: "test_run",
      label: "测试执行",
      description: "开始、查看、暂停、请求人工接管、恢复或结束当前项目的测试执行。所有状态转换由 Main 统一处理。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("status"),
          Type.Literal("pause"),
          Type.Literal("takeover"),
          Type.Literal("resume"),
          Type.Literal("finish"),
        ]),
        title: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        trigger: Type.Optional(
          Type.Union([Type.Literal("manual"), Type.Literal("regression"), Type.Literal("explore")]),
        ),
        caseIds: Type.Optional(Type.Array(Type.String())),
        note: Type.Optional(Type.String()),
        risk: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("business_write")])),
        surface: Type.Optional(Surface),
        reason: Type.Optional(
          Type.Union([
            Type.Literal("login"),
            Type.Literal("verification"),
            Type.Literal("scan"),
            Type.Literal("authorization"),
            Type.Literal("judgment"),
          ]),
        ),
        sensitive: Type.Optional(Type.Boolean()),
        status: Type.Optional(
          Type.Union([
            Type.Literal("passed"),
            Type.Literal("failed"),
            Type.Literal("blocked"),
            Type.Literal("aborted"),
          ]),
        ),
        summaryText: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (params.action === "start" && (!params.title?.trim() || !params.slug?.trim())) {
          throw new Error("开始测试需要 title 和 slug");
        }
        if ((params.action === "pause" || params.action === "takeover") && !params.surface) {
          throw new Error("暂停或人工接管需要 surface");
        }
        if (params.action === "takeover" && !params.reason) throw new Error("人工接管需要 reason");
        return result(await callHost("test.run", { ...params, ...contextFor(ctx) } as TestRunRequest));
      },
    });

    pi.registerTool({
      name: "test_observe",
      label: "感知测试现场",
      description: "读取 Main 已绑定的真实 Chrome 或手机现场。不能执行 JavaScript、CDP 或 Shell。",
      parameters: Type.Object({
        surface: Surface,
        mode: Type.Union([Type.Literal("text"), Type.Literal("snapshot"), Type.Literal("visual")]),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        return observeResult(
          await callHost("test.observe", { ...params, ...contextFor(ctx) } as TestObserveRequest),
          analyzeVisual,
          signal,
        );
      },
    });

    pi.registerTool({
      name: "test_act",
      label: "操作测试现场",
      description:
        "通过 Main 执行受控打开、点击、填写、等待或截图留证；必须声明风险，不接受命令字符串。点击或填写失败时先重新感知(snapshot)定位，不要用 open 猜 URL 开新标签页。",
      parameters: Type.Object({
        surface: Surface,
        risk: Type.Union([Type.Literal("read"), Type.Literal("business_write"), Type.Literal("high")]),
        confirmationId: Type.Optional(Type.String()),
        action: Type.Union([
          Type.Object({ type: Type.Literal("open") }),
          Type.Object({ type: Type.Literal("click"), target: Type.String() }),
          Type.Object({
            type: Type.Literal("fill"),
            target: Type.String(),
            value: Type.String(),
            sensitive: Type.Optional(Type.Boolean()),
          }),
          Type.Object({ type: Type.Literal("wait"), durationMs: Type.Number() }),
          Type.Object({
            type: Type.Literal("swipe"),
            direction: Type.Union([
              Type.Literal("up"),
              Type.Literal("down"),
              Type.Literal("left"),
              Type.Literal("right"),
            ]),
            distance: Type.Optional(Type.Number()),
          }),
          Type.Object({ type: Type.Literal("shot") }),
        ]),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return result(await callHost("test.act", { ...params, ...contextFor(ctx) } as TestActRequest));
      },
    });

    pi.registerTool({
      name: "test_map",
      label: "业务地图",
      description: "读取或更新业务地图的模块、主流程、角色、待确认章节；更新需要当前测试执行。",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("read"), Type.Literal("update")]),
        section: Type.Optional(MapSection),
        content: Type.Optional(Type.String({ maxLength: 20_000 })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (params.action === "update" && (!params.section || params.content === undefined)) {
          throw new Error("更新业务地图需要 section 和 content");
        }
        return result(await callHost("test.map", { ...params, ...contextFor(ctx) } as TestMapRequest));
      },
    });

    const CaseStep = Type.Object({
      act: Type.Union([
        Type.Literal("open"),
        Type.Literal("connect"),
        Type.Literal("launch"),
        Type.Literal("tap"),
        Type.Literal("fill"),
        Type.Literal("wait"),
        Type.Literal("swipe"),
        Type.Literal("shot"),
        Type.Literal("ui"),
        Type.Literal("capture"),
      ]),
      surface: Type.Optional(Surface),
      target: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      idle: Type.Optional(Type.String()),
      package: Type.Optional(Type.String()),
      direction: Type.Optional(
        Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
      ),
      distance: Type.Optional(Type.Number()),
      name: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.String()),
      optional: Type.Optional(Type.Boolean()),
      note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      pattern: Type.Optional(Type.String()),
      as: Type.Optional(Type.String()),
    });
    const CasePre = Type.Object({
      surface: Type.Optional(Surface),
      open: Type.Optional(Type.String()),
      connect: Type.Optional(Type.Boolean()),
      launch: Type.Optional(Type.Boolean()),
    });
    const CaseAssert = Type.Object({
      surface: Type.Optional(Surface),
      see: Type.Optional(Type.String()),
      not_see: Type.Optional(Type.String()),
      url_contains: Type.Optional(Type.String()),
      package: Type.Optional(Type.String()),
    });
    pi.registerTool({
      name: "test_case",
      label: "测试用例",
      description: "列出、读取、创建、调整、启停或晋级结构化测试用例；创建默认为 draft。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("set_status"),
        ]),
        id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        surface: Type.Optional(Surface),
        tags: Type.Optional(Type.Array(Type.String())),
        risk: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("high")])),
        pre: Type.Optional(Type.Array(CasePre)),
        steps: Type.Optional(Type.Array(CaseStep)),
        assert: Type.Optional(Type.Array(CaseAssert)),
        status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("stable"), Type.Literal("disabled")])),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (["get", "create", "update", "set_status"].includes(params.action) && !params.id) {
          throw new Error("该用例操作需要 id");
        }
        if (params.action === "create" && (!params.title || !params.surface || !params.steps?.length)) {
          throw new Error("创建用例需要 title、surface 和 steps");
        }
        if (params.action === "set_status" && !params.status) throw new Error("设置用例状态需要 status");
        return result(await callHost("test.case", { ...params, ...contextFor(ctx) } as TestCaseRequest));
      },
    });

    pi.registerTool({
      name: "test_play",
      label: "重放测试用例",
      description: "确定性重放用例并写入完整 run、证据和逐用例结果；regression 只接受 stable 用例。",
      parameters: Type.Object({
        action: Type.Literal("run"),
        caseIds: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
        title: Type.String(),
        slug: Type.String(),
        trigger: Type.Optional(Type.Union([Type.Literal("manual"), Type.Literal("regression")])),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return result(await callHost("test.play", { ...params, ...contextFor(ctx) } as TestPlayRequest));
      },
    });

    pi.registerTool({
      name: "test_finding",
      label: "本地问题",
      description: "列出、读取、创建本地问题，更新状态或追加当前 run 的复测结果。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("create"),
          Type.Literal("set_status"),
          Type.Literal("retest"),
        ]),
        id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        stepsToReproduce: Type.Optional(Type.Array(Type.String())),
        expected: Type.Optional(Type.String()),
        actual: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.String())),
        surface: Type.Optional(Surface),
        severity: Type.Optional(
          Type.Union([Type.Literal("p0"), Type.Literal("p1"), Type.Literal("p2"), Type.Literal("p3")]),
        ),
        confidence: Type.Optional(
          Type.Union([Type.Literal("suspected"), Type.Literal("observed"), Type.Literal("confirmed")]),
        ),
        caseId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        status: Type.Optional(
          Type.Union([
            Type.Literal("open"),
            Type.Literal("confirmed"),
            Type.Literal("fixed"),
            Type.Literal("wontfix"),
            Type.Literal("duplicate"),
          ]),
        ),
        duplicateOf: Type.Optional(Type.String()),
        result: Type.Optional(
          Type.Union([Type.Literal("still_fail"), Type.Literal("passed"), Type.Literal("blocked")]),
        ),
        note: Type.Optional(Type.String()),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (params.action !== "list" && !params.id) throw new Error("该问题操作需要 id");
        if (
          params.action === "create" &&
          (!params.title ||
            !params.summary ||
            !params.stepsToReproduce?.length ||
            !params.expected ||
            !params.actual ||
            !params.evidence?.length ||
            !params.surface)
        ) {
          throw new Error("创建问题需要完整事实和至少一条证据");
        }
        if (params.action === "set_status" && !params.status) throw new Error("更新问题需要 status");
        if (params.action === "retest" && !params.result) throw new Error("追加复测需要 result");
        return result(await callHost("test.finding", { ...params, ...contextFor(ctx) } as TestFindingRequest));
      },
    });
  };
}

export function createTypedTestHostCall(
  call: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>,
): TestHostCall {
  return <M extends TestHostMethod>(method: M, params: TestHostParams<M>) =>
    call<TestHostResult<M>>(method, params, method === "test.play" ? 30 * 60_000 : 40_000);
}
