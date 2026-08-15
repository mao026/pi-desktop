import type { CaseAssert, CasePre, CaseRisk, CaseStatus, CaseStep, TestCase } from "./core/case.ts";
import type { Finding, FindingConfidence, FindingSeverity, FindingStatus, RetestResult } from "./core/finding.ts";
import type { MapSection } from "./core/map.ts";
import type { SurfaceName, VisualModelRef } from "./core/project.ts";
import type { RunDoc, RunStatus, RunTrigger } from "./core/run.ts";

export type TestRisk = "read" | "business_write" | "high";
export type TestProgressCode =
  | "opening_page"
  | "reading_page"
  | "clicking"
  | "filling"
  | "waiting"
  | "capturing_evidence"
  | "waiting_for_user"
  | "checking_result";

export interface TestProgressEvent {
  code: TestProgressCode;
  message: string;
  at: string;
  surface: SurfaceName;
}

export interface TestRequestContext {
  projectRoot: string;
  projectId?: string;
  sessionId: string;
}

export type TestRunRequest = TestRequestContext &
  (
    | {
        action: "start";
        title: string;
        slug: string;
        trigger?: RunTrigger;
        caseIds?: string[];
        note?: string;
        surface?: SurfaceName;
        risk?: Exclude<TestRisk, "high">;
        businessWriteSurfaces?: SurfaceName[];
      }
    | { action: "status" }
    | { action: "pause"; surface: SurfaceName; sensitive?: boolean }
    | {
        action: "takeover";
        surface: SurfaceName;
        reason: "login" | "verification" | "scan" | "authorization" | "judgment";
        sensitive?: boolean;
      }
    | { action: "resume" }
    | { action: "finish"; status?: Exclude<RunStatus, "in_progress">; summaryText?: string }
  );

export interface TestIdentityStatus {
  id: string;
  name: string;
  surfaces: SurfaceName[];
  defaultSurfaces: SurfaceName[];
  credentialConfigured: boolean;
}

export interface TestRunResult {
  activeRun: string | null;
  run?: RunDoc;
  observation?: TestObserveResult;
  identities?: TestIdentityStatus[];
}

export type TestObserveRequest = TestRequestContext & {
  surface: SurfaceName;
  mode: "text" | "snapshot" | "visual";
  limit?: number;
};

export interface TestObserveResult {
  surface: SurfaceName;
  mode: "text" | "snapshot" | "visual";
  text: string;
  progress: TestProgressEvent[];
  truncated: boolean;
  evidence?: string;
  image?: { mimeType: "image/png"; data: string };
  visualModel?: VisualModelRef;
}

export type TestActRequest = TestRequestContext & {
  surface: SurfaceName;
  risk: TestRisk;
  confirmationId?: string;
  action:
    | { type: "open" }
    | { type: "click"; target: string }
    | { type: "fill"; target: string; value: string; sensitive?: boolean }
    | { type: "wait"; durationMs: number }
    | { type: "swipe"; direction: "up" | "down" | "left" | "right"; distance?: number }
    | { type: "shot" };
};

export interface TestActResult {
  surface: SurfaceName;
  action: TestActRequest["action"]["type"];
  message: string;
  tabId?: string;
  evidence?: string;
  progress: TestProgressEvent[];
}

export interface TestSessionEndedRequest {
  sessionId: string;
}

export type TestSetupRequest = TestRequestContext;

export interface TestSetupResult {
  project: { id: string; name: string; environment: "test" | "staging" | "production" };
  activeRun: string | null;
  surfaces: Array<{
    surface: SurfaceName;
    ready: boolean;
    status: "ok" | "manual";
    code?: string;
    nextStep?: string;
  }>;
  identities: TestIdentityStatus[];
}

export type TestMapRequest = TestRequestContext &
  ({ action: "read"; section?: MapSection } | { action: "update"; section: MapSection; content: string });

export interface TestMapResult {
  sections: Partial<Record<MapSection, string>>;
}

export interface TestCaseDraft {
  id: string;
  title: string;
  description?: string | null;
  surface: SurfaceName;
  tags?: string[];
  risk?: CaseRisk;
  pre?: CasePre[];
  steps: CaseStep[];
  assert?: CaseAssert[];
}

export type TestCaseRequest = TestRequestContext &
  (
    | { action: "list" }
    | { action: "get"; id: string }
    | ({ action: "create" } & TestCaseDraft)
    | ({ action: "update"; id: string } & Partial<Omit<TestCaseDraft, "id">>)
    | { action: "set_status"; id: string; status: CaseStatus }
  );

export interface TestCaseResult {
  cases?: Array<{ id: string; status: CaseStatus; title: string; surface: string }>;
  case?: TestCase;
}

export type TestFindingRequest = TestRequestContext &
  (
    | { action: "list" }
    | { action: "get"; id: string }
    | {
        action: "create";
        id: string;
        title: string;
        summary: string;
        stepsToReproduce: string[];
        expected: string;
        actual: string;
        evidence: string[];
        surface: SurfaceName;
        severity?: FindingSeverity;
        confidence?: FindingConfidence;
        caseId?: string | null;
      }
    | { action: "set_status"; id: string; status: FindingStatus; duplicateOf?: string; confidence?: FindingConfidence }
    | { action: "retest"; id: string; result: RetestResult; note?: string; evidence?: string[] }
  );

export interface TestFindingResult {
  findings?: Array<{ id: string; status: string; title: string; severity: string }>;
  finding?: Finding;
}

export type TestPlayRequest = TestRequestContext & {
  action: "run";
  caseIds: string[];
  title: string;
  slug: string;
  trigger?: "manual" | "regression";
};

export interface TestPlayResult {
  run: RunDoc;
}

export interface TestSessionAuthorizeRequest {
  projectRoot: string;
}

export interface TestHostRpc {
  "test.authorizeSession": { params: TestSessionAuthorizeRequest; result: { projectId: string } };
  "test.setup": { params: TestSetupRequest; result: TestSetupResult };
  "test.run": { params: TestRunRequest; result: TestRunResult };
  "test.map": { params: TestMapRequest; result: TestMapResult };
  "test.case": { params: TestCaseRequest; result: TestCaseResult };
  "test.finding": { params: TestFindingRequest; result: TestFindingResult };
  "test.play": { params: TestPlayRequest; result: TestPlayResult };
  "test.observe": { params: TestObserveRequest; result: TestObserveResult };
  "test.act": { params: TestActRequest; result: TestActResult };
  "test.sessionEnded": { params: TestSessionEndedRequest; result: { released: boolean } };
}

export type TestHostMethod = keyof TestHostRpc;
export type TestHostParams<M extends TestHostMethod> = TestHostRpc[M]["params"];
export type TestHostResult<M extends TestHostMethod> = TestHostRpc[M]["result"];
export type TestHostCall = <M extends TestHostMethod>(
  method: M,
  params: TestHostParams<M>,
) => Promise<TestHostResult<M>>;
