import { execFile } from "child_process";
import { existsSync, realpathSync } from "fs";
import { basename, dirname, join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitCommandRunOptions {
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export interface GitCommandRunner {
  run(cwd: string, args: string[], options: GitCommandRunOptions): Promise<{ stdout: string }>;
}

const defaultGitCommandRunner: GitCommandRunner = {
  async run(cwd, args, options) {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      encoding: "utf8",
      env: options.env,
    });
    return { stdout: String(stdout) };
  },
};

let gitCommandRunner: GitCommandRunner = defaultGitCommandRunner;

export function setGitCommandRunner(runner: GitCommandRunner): () => void {
  const previous = gitCommandRunner;
  gitCommandRunner = runner;
  return () => {
    if (gitCommandRunner === runner) gitCommandRunner = previous;
  };
}

// ============================================================================
// Project resolution: cwd → { projectRoot, branch }
//
// A worktree's `git rev-parse --git-common-dir` points at the *main* repo's
// .git directory, so its parent is the project root shared by all worktrees.
// Non-git directories resolve to themselves. Results use a process-local short
// TTL cache.
// ============================================================================

export interface ProjectInfo {
  projectRoot: string;
  /** Current branch of the cwd, null for non-git dirs or detached HEAD */
  branch: string | null;
  /** True when cwd is a linked worktree (not the main checkout) */
  isWorktree: boolean;
  /** True when cwd is the top-level directory of a checkout (main or linked). */
  isTopLevel: boolean;
}

const PROJECT_CACHE_TTL_MS = 60_000;
const projectCache = new Map<string, { info: ProjectInfo; expiresAt: number }>();
let projectCacheRevision = 0;

function getProjectCache(): Map<string, { info: ProjectInfo; expiresAt: number }> {
  return projectCache;
}

export function invalidateProjectCache(): void {
  projectCache.clear();
  projectCacheRevision += 1;
}

export function getProjectCacheRevision(): number {
  return projectCacheRevision;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await gitCommandRunner.run(cwd, args, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await gitCommandRunner.run(cwd, args, {
    timeout: 10_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

/** List repository files through the configured Git runtime. */
export async function listGitFiles(cwd: string): Promise<string[]> {
  const stdout = await gitRaw(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

/**
 * When a removed worktree's directory no longer exists, group its sessions
 * back under the main repo instead of letting them dangle as a phantom project.
 */
function inferRemovedWorktree(cwd: string): ProjectInfo | null {
  const parent = dirname(cwd);
  if (!parent.endsWith("-worktrees")) return null;
  const repoRoot = parent.slice(0, -"-worktrees".length);
  if (!repoRoot || !existsSync(join(repoRoot, ".git"))) return null;
  return { projectRoot: repoRoot, branch: basename(cwd), isWorktree: true, isTopLevel: true };
}

export async function resolveProject(cwd: string): Promise<ProjectInfo> {
  const cache = getProjectCache();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  let info: ProjectInfo;
  try {
    if (!existsSync(cwd)) {
      info = inferRemovedWorktree(cwd) ?? { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false };
      cache.set(cwd, { info, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
      return info;
    }
    const out = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-dir",
      "--show-toplevel",
      "--abbrev-ref",
      "HEAD",
    ]);
    const [commonDir, gitDir, toplevel, ref] = out.split("\n").map((l) => l.trim());
    let realCwd = cwd;
    try {
      realCwd = realpathSync(cwd);
    } catch {
      /* keep as-is */
    }
    const isTopLevel = toplevel === realCwd;
    const isWorktreeTopLevel = gitDir !== commonDir && isTopLevel;
    info = {
      projectRoot: isWorktreeTopLevel ? dirname(commonDir) : cwd,
      branch: ref && ref !== "HEAD" ? ref : null,
      isWorktree: isWorktreeTopLevel,
      isTopLevel,
    };
  } catch {
    info = { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false };
  }

  cache.set(cwd, { info, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  return info;
}
