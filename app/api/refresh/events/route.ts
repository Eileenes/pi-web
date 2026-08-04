import fs from "fs";
import { NextRequest } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { subscribeRefresh } from "@/lib/refresh-hub";
import { startWatchingCwd, stopWatchingCwd } from "@/lib/refresh-watcher";

export const dynamic = "force-dynamic";

// GET /api/refresh/events?cwd=<project> — SSE 推送外部变化（git 元数据 / 工作树 / 会话）。
// cwd 校验通过后才注册对应项目的 watcher；连接断开时 watcher 自动关闭。
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
  let watchCwd: string | null = null;
  if (cwd) {
    try {
      if (cwd.startsWith("/") || isWindowsAbsolutePath(cwd)) {
        const allowedRoots = await getAllowedFileRoots();
        if (
          isFilePathAllowed(cwd, allowedRoots)
          && isExistingFilePathAllowed(cwd, allowedRoots)
          && fs.statSync(cwd).isDirectory()
        ) {
          watchCwd = cwd;
        }
      }
    } catch {
      // 校验失败则仅广播、不注册 watcher
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller 已关闭
        }
      };

      // 先订阅再启动 watcher，避免中间漏事件
      const unsubscribe = subscribeRefresh((event) => encode(event));
      if (watchCwd) void startWatchingCwd(watchCwd);

      // 心跳保活，防止代理/超时掐断连接
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller 已关闭
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        if (watchCwd) stopWatchingCwd(watchCwd);
        try { controller.close(); } catch { /* 已关闭 */ }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
