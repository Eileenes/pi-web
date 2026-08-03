import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitCommitFilePatch, getRepositoryRoot } from "@/lib/git-commands";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const hash = request.nextUrl.searchParams.get("hash")?.trim() ?? "";
    const relPath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) {
      return NextResponse.json({ error: "Invalid hash" }, { status: 400 });
    }
    if (!relPath || relPath.includes("\0")) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // relPath 是仓库相对路径：解析到绝对路径后必须仍落在仓库根内（防路径穿越）
    const repoRoot = (await getRepositoryRoot(cwd)) ?? cwd;
    const abs = path.resolve(repoRoot, relPath);
    if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!isFilePathAllowed(abs, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const patch = await getGitCommitFilePatch(cwd, hash, relPath);
    return NextResponse.json({ patch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
