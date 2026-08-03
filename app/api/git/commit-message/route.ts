import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const DIFF_MAX_CHARS = 12_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

/** 收集本次变更的 diff 摘要，供模型生成 commit message。 */
async function collectChangeSummary(cwd: string): Promise<string> {
  const parts: string[] = [];

  // 已暂存 + 未暂存（工作区 vs HEAD）
  const diff = await git(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--unified=2"]);
  if (diff.trim()) {
    parts.push("=== Diff (working tree vs HEAD) ===");
    parts.push(diff.length > DIFF_MAX_CHARS ? diff.slice(0, DIFF_MAX_CHARS) + "\n... (truncated)" : diff);
  }

  // 未跟踪文件清单（内容不展开，只列路径）
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.trim()) {
    const untracked = status.split("\0")
      .filter((record) => record.length >= 4 && record[2] === " " && (record[0] === "?" || record[1] === "?"))
      .map((record) => record.slice(3));
    if (untracked.length > 0) {
      parts.push("=== Untracked files (new, not yet added) ===");
      parts.push(untracked.slice(0, 50).join("\n"));
    }
  }

  return parts.join("\n\n") || "No changes found.";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { cwd?: string };
    const cwd = body.cwd?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ ok: false, error: "cwd must be an absolute path" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }

    const summary = await collectChangeSummary(cwd);

    // 用临时（内存）AgentSession 让模型生成 commit message
    initTheme();
    const agentDir = getAgentDir();
    const sessionManager = SessionManager.inMemory(cwd);
    const services = await createAgentSessionServices({ cwd, agentDir });
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    if (!defaultProvider || !defaultModelId) {
      return NextResponse.json(
        { ok: false, error: "No default model configured. Configure a model in Models first." },
        { status: 400 },
      );
    }
    const initial = selectInitialModelScope(scope, {
      defaultModel: { provider: defaultProvider, modelId: defaultModelId },
    });
    if (!initial.model) {
      return NextResponse.json(
        { ok: false, error: "Default model is not available in the enabled scope." },
        { status: 400 },
      );
    }

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: initial.model,
      scopedModels: initial.scopedModels,
      tools: [],
    });

    const prompt = [
      "You are helping write a git commit message. Based on the code changes below, produce ONE concise commit message.",
      "Rules:",
      "- Use Conventional Commits format: feat:, fix:, refactor:, chore:, docs:, test:, perf:, style:",
      "- First line (subject) ≤ 72 chars, imperative mood",
      "- Add a short body (2-4 bullet points) only if the change is non-trivial",
      "- Do NOT wrap in quotes or backticks, do NOT add any explanation before or after",
      "- Output ONLY the commit message",
      "",
      summary,
    ].join("\n");

    // 流式输出：订阅 text_delta 事件，边生成边把文本推给前端
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let unsubscribe: (() => void) | null = null;
        const safeClose = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
          try {
            controller.close();
          } catch { /* already closed */ }
        };
        try {
          unsubscribe = session.subscribe((event) => {
            if (event.type === "message_update") {
              const evt = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
              if (evt?.type === "text_delta" && typeof evt.delta === "string") {
                try {
                  controller.enqueue(encoder.encode(evt.delta));
                } catch { /* controller closed */ }
              }
            } else if (event.type === "agent_end") {
              safeClose();
            }
          });
        } catch {
          safeClose();
          return;
        }
        session
          .prompt(prompt)
          .catch(() => { /* prompt error — stream will just close */ })
          .finally(safeClose);
      },
      cancel() {
        // 客户端断开：终止模型生成，避免继续消耗 token
        try {
          session.abort();
        } catch { /* session may already be done */ }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
