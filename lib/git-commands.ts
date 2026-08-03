import { execFile } from "child_process";
import { promisify } from "util";
import type { GitBranchInfo, GitLogEntry } from "./git-types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitCommandOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<GitCommandOutput> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      env: { ...process.env, LC_ALL: "C" },
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    // git 部分失败（如空暂存区 commit）会把原因写到 stdout 而非 stderr，
    // 这里把 stdout 作为 stderr 的兜底，避免前端只看到 “Command failed”。
    const stderr = (typeof e.stderr === "string" ? e.stderr : "").trim()
      || (typeof e.stdout === "string" ? e.stdout : "").trim()
      || e.message
      || String(error);
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr,
    };
  }
}

function quotePaths(paths: string[]): string[] {
  return paths.flatMap((p) => ["--", p]);
}

export async function getRepositoryRoot(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const root = result.ok ? result.stdout.trim() : "";
  return root ? root : null;
}

export async function gitStage(cwd: string, paths: string[]): Promise<GitCommandOutput> {
  if (paths.length > 0) return runGit(cwd, ["add", ...quotePaths(paths)]);
  return runGit(cwd, ["add", "-A"]);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<GitCommandOutput> {
  return runGit(cwd, ["restore", "--staged", ...quotePaths(paths)]);
}

export async function gitDiscard(cwd: string, paths: string[], untracked: boolean): Promise<GitCommandOutput> {
  if (untracked) {
    // git clean 只能操作未跟踪路径；必须显式传路径（不允许全量 clean）
    if (paths.length === 0) return { ok: false, stdout: "", stderr: "No untracked paths specified" };
    return runGit(cwd, ["clean", "-fd", ...quotePaths(paths)]);
  }
  if (paths.length === 0) return runGit(cwd, ["checkout", "--", "."]);
  return runGit(cwd, ["checkout", "--", ...quotePaths(paths)]);
}

export async function gitCommit(cwd: string, message: string, amend: boolean): Promise<GitCommandOutput> {
  const args = ["commit", ...(amend ? ["--amend", "--no-edit"] : []), "-m", message];
  return runGit(cwd, args);
}

export async function gitPush(cwd: string): Promise<GitCommandOutput> {
  return runGit(cwd, ["push"]);
}

export async function gitPull(cwd: string): Promise<GitCommandOutput> {
  return runGit(cwd, ["pull", "--rebase"]);
}

export async function gitCheckout(cwd: string, branch: string, create: boolean): Promise<GitCommandOutput> {
  return runGit(cwd, create ? ["checkout", "-b", branch] : ["checkout", branch]);
}

export async function gitDeleteBranch(cwd: string, branch: string): Promise<GitCommandOutput> {
  return runGit(cwd, ["branch", "-d", branch]);
}

export async function getGitBranches(cwd: string): Promise<GitBranchInfo> {
  const result = await runGit(cwd, ["branch", "--format=%(refname:short)"]);
  if (!result.ok) {
    // 可能是非 git 仓库
    return { isGitRepository: false, current: null, branches: [] };
  }
  const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const currentResult = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const current = currentResult.ok && currentResult.stdout.trim() && currentResult.stdout.trim() !== "HEAD"
    ? currentResult.stdout.trim()
    : null;
  return {
    isGitRepository: true,
    current,
    branches: lines.map((name) => ({ name, isCurrent: name === current })),
  };
}

export async function getGitLog(cwd: string, count = 20): Promise<GitLogEntry[]> {
  const result = await runGit(cwd, [
    "log",
    "--no-color",
    `-n ${count}`,
    "--format=%H%x00%h%x00%s%x00%an%x00%ad",
    "--date=iso-strict",
  ]);
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, shortHash, subject, author, date] = line.split("\0");
    return { hash, shortHash, subject, author, date };
  });
}
