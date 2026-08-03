import { spawn } from "child_process";
import { NextRequest } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";

/** 单条命令最长执行时间（超时后终止整个进程组） */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** 输出缓冲低于该字节数时暂停子进程 stdout/stderr（背压） */
const BACKPRESSURE_THRESHOLD = 32 * 1024;

/**
 * 终止整个命令进程组（含 shell 派生的孙进程）。
 * POSIX：detached spawn 使 shell 成为新进程组组长，kill(-pid) 可整树终止。
 * Windows：taskkill /T 递归终止子进程树。
 */
function killProcessTree(pid: number | undefined, isWindows: boolean, signal: "SIGTERM" | "SIGKILL") {
  if (!pid) return;
  try {
    if (isWindows) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // 进程已退出，忽略
  }
}

/**
 * 终端命令执行接口（流式）。
 *
 * POST { cwd, command } → text/plain 流，stdout+stderr 合并输出。
 * 客户端断开（abort）或命令超时时终止整个进程组，防止孤儿进程。
 *
 * 注意：终端允许执行任意命令（等同本地 shell 权限），仅对 cwd 做
 * allowedRoots 校验。这是单用户本地工具的设计取舍——确保服务只监听
 * 127.0.0.1，或在开放网络时启用 PI_WEB_PASSWORD。
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    let body: { cwd?: string; command?: string };
    try {
      body = raw ? (JSON.parse(raw) as { cwd?: string; command?: string }) : {};
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const cwd = body.cwd?.trim() ?? "";
    const command = body.command?.trim() ?? "";

    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return new Response(JSON.stringify({ error: "cwd must be an absolute path" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!command) {
      return new Response(JSON.stringify({ error: "command required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (command.includes("\0")) {
      // spawn 参数含 null 字节会抛错，提前拦截
      return new Response(JSON.stringify({ error: "command must not contain null bytes" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/bash";
    const shellArgs = isWindows ? ["/c", command] : ["-lc", command];

    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      shell: false,
      // POSIX 下创建独立进程组，便于超时/中断时整树终止
      detached: !isWindows,
    });

    let timeout: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    // 背压状态：start 和 pull 之间共享
    let paused = false;
    const tryResume = () => {
      if (paused) {
        paused = false;
        child.stdout.resume();
        child.stderr.resume();
      }
    };

    const stream = new ReadableStream<Uint8Array>(
      {
      start(controller) {
        const encoder = new TextEncoder();
        // 流式解码：UTF-8 多字节序列跨 chunk 边界时不会产生乱码
        const decoder = new TextDecoder("utf-8");
        let closed = false;

        const safeClose = () => {
          if (closed) return;
          closed = true;
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          if (forceKillTimer) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        // 消费者消费不及时（desiredSize 偏低）时暂停子进程输出，pull() 恢复
        const tryPause = () => {
          if (!paused && controller.desiredSize !== null && controller.desiredSize < BACKPRESSURE_THRESHOLD) {
            paused = true;
            child.stdout.pause();
            child.stderr.pause();
          }
        };

        const onData = (chunk: Buffer) => {
          const text = decoder.decode(chunk, { stream: true });
          if (text) {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              // closed
            }
          }
          tryPause();
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);

        child.on("error", (error) => {
          try {
            const tail = decoder.decode();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.enqueue(encoder.encode(`\n[error] ${error.message}\n`));
          } catch {
            // closed
          }
          safeClose();
        });
        child.on("close", (code, signal) => {
          try {
            const tail = decoder.decode();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.enqueue(encoder.encode(`\n[退出码 ${code ?? (signal ? `signal ${signal}` : "?")}]\n`));
          } catch {
            // closed
          }
          safeClose();
        });

        // 命令超时：先 SIGTERM，3 秒后仍未退出则 SIGKILL 强杀
        timeout = setTimeout(() => {
          killProcessTree(child.pid, isWindows, "SIGTERM");
          try {
            controller.enqueue(encoder.encode("\n[超时: 命令已终止]\n"));
          } catch {
            // closed
          }
          safeClose();
          forceKillTimer = setTimeout(() => {
            killProcessTree(child.pid, isWindows, "SIGKILL");
          }, 3000);
        }, COMMAND_TIMEOUT_MS);
      },
      pull() {
        // 消费者取走数据后恢复子进程输出
        tryResume();
      },
      cancel() {
        // 客户端断开：终止整个命令进程组，防止孤儿进程
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        killProcessTree(child.pid, isWindows, "SIGKILL");
      },
    },
      // chunk 数级别的背压阈值，减少 pause/resume 抖动
      { highWaterMark: 16 },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
