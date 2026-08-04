import fs from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { emitRefresh } from "./refresh-hub";
import { getGitDir } from "./git-commands";

/**
 * 服务端文件监听（globalThis 键控，抗热重载）。检测三类外部变化并 emit 到
 * refresh-hub：
 *
 *  1. <git-dir>（HEAD / refs / index / worktrees...）→ { type: "git" }：
 *     commit、分支增删、切分支、git add、pull/push、worktree 增删
 *  2. 工作树（带忽略规则，不关心 node_modules/.git 等）→ { type: "workspace" }：
 *     外部编辑器保存文件等
 *  3. ~/.pi/agent/sessions → { type: "sessions" }：会话文件增删改（全局，只启动一次）
 *
 * watcher 生命周期跟随 SSE 订阅：startWatchingCwd / stopWatchingCwd 引用计数，
 * 没有订阅者时全部关闭，避免空转。
 */

const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 1500;

// .git 内需要关心的路径；objects/、config 等高频低价值变化一律忽略
function isGitDirEventRelevant(filename: string | null): boolean {
  if (!filename) return true;
  const f = filename.replace(/\\/g, "/");
  if (f.startsWith("objects/")) return false;
  if (
    f === "config" || f === "config.lock" || f === "index.lock"
    || f === "COMMIT_EDITMSG" || f === "description"
  ) {
    return false;
  }
  return true;
}

// 工作树中忽略的顶层目录（事件仍会由底层上报，但在这里被过滤）
const WORKTREE_IGNORED_TOP = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", "coverage",
  "target", "venv", ".venv", "Pods", ".terraform", ".cache",
]);

function isWorktreeEventRelevant(filename: string | null): boolean {
  if (!filename) return true;
  const f = filename.replace(/\\/g, "/");
  return !WORKTREE_IGNORED_TOP.has(f.split("/")[0]);
}

interface DebounceSlot {
  timer: ReturnType<typeof setTimeout> | null;
  firstAt: number;
}

interface CwdWatchState {
  refCount: number;
  watchers: fs.FSWatcher[];
  gitSlot: DebounceSlot;
  wsSlot: DebounceSlot;
}

interface WatchRegistry {
  byCwd: Map<string, CwdWatchState>;
  sessionsStarted: boolean;
  sessionsWatcher: fs.FSWatcher | null;
  sessionsTimer: ReturnType<typeof setTimeout> | null;
}

function getRegistry(): WatchRegistry {
  const g = globalThis as unknown as { __piRefreshWatchers?: WatchRegistry };
  if (!g.__piRefreshWatchers) {
    g.__piRefreshWatchers = {
      byCwd: new Map(),
      sessionsStarted: false,
      sessionsWatcher: null,
      sessionsTimer: null,
    };
  }
  return g.__piRefreshWatchers;
}

/** 优先递归监听；平台不支持时退化为 root + 关键子目录的非递归监听 */
function watchDir(
  root: string,
  subdirs: string[],
  filter: (f: string | null) => boolean,
  onChange: () => void,
): fs.FSWatcher[] {
  try {
    const w = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (filter(filename)) onChange();
    });
    // 递归监听中途出错时静默降级（后续事件靠 focus 兜底刷新）
    w.on("error", () => { /* noop */ });
    return [w];
  } catch {
    const watchers: fs.FSWatcher[] = [];
    const add = (dir: string) => {
      try {
        const w = fs.watch(dir, (_event, filename) => {
          if (filter(filename)) onChange();
        });
        w.on("error", () => { /* noop */ });
        watchers.push(w);
      } catch {
        // 目录不存在等：忽略
      }
    };
    add(root);
    for (const sub of subdirs) add(path.join(root, sub));
    return watchers;
  }
}

/** 事件风暴（npm install、大 commit）下最多 MAX_WAIT_MS 必须落一次刷新 */
function scheduleEmit(
  cwd: string,
  state: CwdWatchState,
  slot: DebounceSlot,
  type: "git" | "workspace",
): void {
  const now = Date.now();
  if (!slot.firstAt) slot.firstAt = now;
  if (slot.timer) clearTimeout(slot.timer);
  const fire = () => {
    slot.timer = null;
    slot.firstAt = 0;
    emitRefresh(type === "git" ? { type: "git", cwd } : { type: "workspace", cwd });
  };
  if (now - slot.firstAt >= MAX_WAIT_MS) {
    fire();
    return;
  }
  slot.timer = setTimeout(fire, DEBOUNCE_MS);
}

/** 注册一个项目目录的监听（引用计数，可被多个 SSE 连接并发持有） */
export async function startWatchingCwd(cwd: string): Promise<void> {
  const reg = getRegistry();
  const existing = reg.byCwd.get(cwd);
  if (existing) {
    existing.refCount += 1;
    return;
  }

  const state: CwdWatchState = {
    refCount: 1,
    watchers: [],
    gitSlot: { timer: null, firstAt: 0 },
    wsSlot: { timer: null, firstAt: 0 },
  };
  reg.byCwd.set(cwd, state);

  // git 元数据目录（worktree 场景下是主仓库 .git/worktrees/<name>，rev-parse 解析）
  try {
    const gitDir = await getGitDir(cwd);
    if (gitDir) {
      const watchers = watchDir(
        gitDir,
        ["refs", "refs/heads", "refs/remotes", "logs", "worktrees"],
        isGitDirEventRelevant,
        () => scheduleEmit(cwd, state, state.gitSlot, "git"),
      );
      state.watchers.push(...watchers);
    }
  } catch {
    // 非 git 目录或命令失败：只监听工作树
  }

  // 工作树监听（最佳努力；macOS/Windows 递归可靠，Linux 视 inotify 限制而定）
  try {
    const watchers = watchDir(
      cwd,
      [],
      isWorktreeEventRelevant,
      () => scheduleEmit(cwd, state, state.wsSlot, "workspace"),
    );
    state.watchers.push(...watchers);
  } catch {
    // 忽略
  }

  ensureSessionsWatcher(reg);
}

/** 释放一个项目的监听（引用计数归零后关闭全部 watcher） */
export function stopWatchingCwd(cwd: string): void {
  const reg = getRegistry();
  const state = reg.byCwd.get(cwd);
  if (!state) return;
  state.refCount -= 1;
  if (state.refCount > 0) return;
  reg.byCwd.delete(cwd);
  for (const w of state.watchers) {
    try { w.close(); } catch { /* 忽略 */ }
  }
  if (state.gitSlot.timer) clearTimeout(state.gitSlot.timer);
  if (state.wsSlot.timer) clearTimeout(state.wsSlot.timer);
}

/** 会话目录监听（全局仅启动一次，事件稀有、代价极小） */
function ensureSessionsWatcher(reg: WatchRegistry): void {
  if (reg.sessionsStarted) return;
  reg.sessionsStarted = true;
  let sessionsDir: string;
  try {
    sessionsDir = path.join(getAgentDir(), "sessions");
  } catch {
    return;
  }
  try {
    const w = fs.watch(sessionsDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const f = String(filename).replace(/\\/g, "/");
      if (f.endsWith(".jsonl") || f.endsWith(".jsonl.tmp")) {
        if (reg.sessionsTimer) clearTimeout(reg.sessionsTimer);
        reg.sessionsTimer = setTimeout(() => {
          reg.sessionsTimer = null;
          emitRefresh({ type: "sessions" });
        }, DEBOUNCE_MS);
      }
    });
    w.on("error", () => { /* noop */ });
    reg.sessionsWatcher = w;
  } catch {
    // 平台不支持递归等：会话列表靠既有机制刷新
  }
}
