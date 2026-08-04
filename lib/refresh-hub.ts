/**
 * 服务端刷新事件总线（globalThis 键控，抗 Next.js 热重载）。
 *
 * watcher（lib/refresh-watcher.ts）检测到外部变化后 emit，
 * SSE 路由（/api/refresh/events）订阅并广播给客户端，客户端据此立即重拉数据，
 * 全程无轮询。
 */

export type RefreshEvent =
  | { type: "git"; cwd: string }        // .git 元数据变化：commit / 分支增删 / 切分支 / index / worktree
  | { type: "workspace"; cwd: string }  // 工作树文件变化（不含 .git / 忽略目录）
  | { type: "sessions" };               // 会话文件增删改

type RefreshListener = (event: RefreshEvent) => void;

interface RefreshHubState {
  listeners: Set<RefreshListener>;
}

function getHub(): RefreshHubState {
  const g = globalThis as unknown as { __piRefreshHub?: RefreshHubState };
  if (!g.__piRefreshHub) g.__piRefreshHub = { listeners: new Set() };
  return g.__piRefreshHub;
}

/** 订阅刷新事件，返回取消订阅函数 */
export function subscribeRefresh(listener: RefreshListener): () => void {
  const hub = getHub();
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
  };
}

/** 广播一次刷新事件（单个监听器异常不影响其余广播） */
export function emitRefresh(event: RefreshEvent): void {
  const hub = getHub();
  for (const listener of [...hub.listeners]) {
    try {
      listener(event);
    } catch {
      // 忽略单个监听器的错误
    }
  }
}
