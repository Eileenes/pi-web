import { execFile } from "child_process";
import { promisify } from "util";
import type { GitBranchInfo, GitCommitDetail, GitCommitFileChange, GitLogEntry } from "./git-types";

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

/** git 元数据目录的绝对路径（worktree 场景指向主仓库 .git/worktrees/<name>） */
export async function getGitDir(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  const dir = result.ok ? result.stdout.trim() : "";
  return dir ? dir : null;
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

export interface GitLogOptions {
  count?: number;
  offset?: number;
  /** 是否包含所有分支的提交（git log --all） */
  all?: boolean;
}

/** 解析 git %D 装饰字段，如 "HEAD -> feat/x, origin/main, tag: v1.0" */
function parseRefs(decorations: string): string[] {
  return decorations
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

export async function getGitLog(cwd: string, options: GitLogOptions = {}): Promise<GitLogEntry[]> {
  const { count = 50, offset = 0, all = false } = options;
  const args = ["log", "--no-color"];
  if (all) args.push("--all");
  args.push(
    "-n", String(count),
    ...(offset > 0 ? ["--skip", String(offset)] : []),
    "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ad%x00%P%x00%D",
    "--date=iso-strict",
  );
  const result = await runGit(cwd, args);
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, shortHash, subject, author, authorEmail, date, parentsField, refsField] = line.split("\0");
    return {
      hash,
      shortHash,
      subject,
      author,
      authorEmail: authorEmail ?? "",
      date,
      parents: (parentsField ?? "").split(" ").filter(Boolean),
      refs: parseRefs(refsField ?? ""),
    };
  });
}

const NAME_STATUS_STATUS: Record<string, GitCommitFileChange["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

/** 解析 git numstat 输出（一行：<add>\t<del>\t<path>），重命名路径取 new 部分 */
function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    let path = m[3];
    // numstat 的重命名路径形如 "src/{b.ts => c.ts}"，取 => 后的新路径
    path = path.replace(/\{[^}]*=>\s*([^}]*)\}/, "$1");
    const arrow = path.indexOf(" => ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    stats.set(path, {
      additions: m[1] === "-" ? 0 : Number(m[1]),
      deletions: m[2] === "-" ? 0 : Number(m[2]),
    });
  }
  return stats;
}

export async function getGitCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  const meta = await runGit(cwd, [
    "show", "-s", "--no-color", hash,
    "--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%ad%x00%cd%x00%P%x00%D",
    "--date=iso-strict",
  ]);
  if (!meta.ok || !meta.stdout) return null;
  const [fullHash, shortHash, subject, body, author, authorEmail, authorDate, committerDate, parentsField, refsField] = meta.stdout.split("\0");
  if (!fullHash) return null;

  // 文件变更：name-status 给状态，numstat 给行数
  const [nameStatus, numstat] = await Promise.all([
    runGit(cwd, ["show", "--no-color", "--format=", "--name-status", hash]),
    runGit(cwd, ["show", "--no-color", "--format=", "--numstat", hash]),
  ]);
  const stats = parseNumstat(numstat.stdout);
  const files: GitCommitFileChange[] = [];
  for (const line of nameStatus.stdout.split("\n")) {
    const m = line.match(/^([A-Z]\d*)\t(.*)$/);
    if (!m) continue;
    const statusLetter = m[1][0];
    const status = NAME_STATUS_STATUS[statusLetter];
    if (!status) continue;
    // R/C 输出 old\tnew 两个路径，取最后一个（新路径）
    const parts = m[2].split("\t");
    const path = parts[parts.length - 1];
    const st = stats.get(path) ?? { additions: 0, deletions: 0 };
    files.push({ path, status, ...st });
  }

  return {
    hash: fullHash,
    shortHash,
    subject: subject ?? "",
    body: body?.trim() ?? "",
    author: author ?? "",
    authorEmail: authorEmail ?? "",
    authorDate,
    committerDate,
    parents: (parentsField ?? "").split(" ").filter(Boolean),
    refs: parseRefs(refsField ?? ""),
    files,
  };
}

/** 某次提交中单个文件的 unified diff（git show <hash> -- <path>） */
export async function getGitCommitFilePatch(cwd: string, hash: string, relPath: string): Promise<string> {
  // :(literal) 前缀关闭 git pathspec 的 glob/magic 解析，避免文件名含 * ? [ ] 时匹配到错误文件
  const result = await runGit(cwd, ["show", "--no-color", "--format=", hash, "--", `:(literal)${relPath}`]);
  return result.ok ? result.stdout : "";
}
