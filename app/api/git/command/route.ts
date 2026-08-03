import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import {
  gitCheckout,
  gitCommit,
  gitDeleteBranch,
  gitDiscard,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  getRepositoryRoot,
} from "@/lib/git-commands";
import type { GitCommandRequest, GitCommandResponse } from "@/lib/git-types";

const ACTIONS = new Set(["stage", "unstage", "discard", "commit", "push", "pull", "checkout", "deleteBranch"]);

/** git 分支名不允许以 - 开头（会被解析为选项），也不允许 shell 特殊/空白字符。 */
function isValidBranchName(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as GitCommandRequest;
    const { action, cwd, paths = [], message, branch, create, amend, untracked } = body;

    if (!action || !ACTIONS.has(action)) {
      return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
    }
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ ok: false, error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        return NextResponse.json({ ok: false, error: "Not a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ ok: false, error: "Directory not found" }, { status: 404 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }

    // 校验所有路径都在允许根内（discard 的已删除文件可能不存在于磁盘，用 isFilePathAllowed）
    const validPaths: string[] = [];
    for (const p of paths) {
      if (!p || (!p.startsWith("/") && !isWindowsAbsolutePath(p))) {
        return NextResponse.json({ ok: false, error: "path must be an absolute path" }, { status: 400 });
      }
      if (!isFilePathAllowed(p, allowedRoots)) {
        return NextResponse.json({ ok: false, error: `Access denied: ${p}` }, { status: 403 });
      }
      validPaths.push(p);
    }

    // 有显式路径时，确保它们都属于 cwd 的 git 仓库（避免对允许根内其他项目误操作）
    if (validPaths.length > 0) {
      const repositoryRoot = await getRepositoryRoot(cwd);
      if (repositoryRoot) {
        for (const p of validPaths) {
          const rel = path.relative(repositoryRoot, p);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            return NextResponse.json(
              { ok: false, error: `Path outside repository: ${p}` },
              { status: 403 },
            );
          }
        }
      }
    }

    let result: { ok: boolean; stdout: string; stderr: string };
    switch (action) {
      case "stage":
        result = await gitStage(cwd, validPaths);
        break;
      case "unstage":
        if (validPaths.length === 0) return NextResponse.json({ ok: false, error: "paths required" }, { status: 400 });
        result = await gitUnstage(cwd, validPaths);
        break;
      case "discard":
        if (untracked && validPaths.length === 0) {
          return NextResponse.json({ ok: false, error: "paths required for untracked discard" }, { status: 400 });
        }
        result = await gitDiscard(cwd, validPaths, Boolean(untracked));
        break;
      case "commit":
        if (!message || !message.trim()) {
          return NextResponse.json({ ok: false, error: "Commit message required" }, { status: 400 });
        }
        result = await gitCommit(cwd, message.trim(), Boolean(amend));
        break;
      case "push":
        result = await gitPush(cwd);
        break;
      case "pull":
        result = await gitPull(cwd);
        break;
      case "checkout":
        if (!branch || !branch.trim() || !isValidBranchName(branch.trim())) {
          return NextResponse.json({ ok: false, error: "Invalid branch name" }, { status: 400 });
        }
        result = await gitCheckout(cwd, branch.trim(), Boolean(create));
        break;
      case "deleteBranch":
        if (!branch || !branch.trim() || !isValidBranchName(branch.trim())) {
          return NextResponse.json({ ok: false, error: "Invalid branch name" }, { status: 400 });
        }
        result = await gitDeleteBranch(cwd, branch.trim());
        break;
    }

    const response: GitCommandResponse = {
      ok: result.ok,
      stdout: result.ok ? result.stdout.slice(0, 4000) : undefined,
      stderr: result.ok ? undefined : result.stderr.slice(0, 2000),
    };
    return NextResponse.json(response, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
