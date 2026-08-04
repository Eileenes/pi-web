"use client";

import { useEffect, useRef } from "react";

/**
 * 客户端自动刷新：订阅 /api/refresh/events SSE，外部变化（git 元数据 / 工作树 /
 * 会话文件）到达时立即回调，取代轮询。
 *
 * - cwd 变化 → 断开旧连接、为新项目建立新连接（服务端随之切换 watcher）
 * - 页面隐藏 → 断开（服务端 watcher 一并关闭，避免空转）；回到可见 → 重连
 * - 窗口获得焦点 → 兜底刷新一次（补 FSEvents 偶发漏事件）
 */
export interface AutoRefreshHandlers {
  /** .git 变化：commit / 分支增删 / 切分支 / index / worktree */
  onGitChange?: (cwd: string) => void;
  /** 工作树文件变化（外部编辑器保存等） */
  onWorkspaceChange?: (cwd: string) => void;
  /** 会话文件增删改 */
  onSessionsChange?: () => void;
  /** 窗口获得焦点时的兜底刷新 */
  onFocusRefresh?: () => void;
}

export function useAutoRefresh(cwd: string | null, handlers: AutoRefreshHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    let es: EventSource | null = null;

    const open = () => {
      if (disposed || !cwd || document.visibilityState !== "visible") return;
      es = new EventSource(`/api/refresh/events?cwd=${encodeURIComponent(cwd)}`);
      es.onmessage = (e) => {
        let event: { type?: string; cwd?: string };
        try {
          event = JSON.parse(e.data);
        } catch {
          return;
        }
        if (event.type === "git" && event.cwd === cwd) {
          handlersRef.current.onGitChange?.(cwd);
        } else if (event.type === "workspace" && event.cwd === cwd) {
          handlersRef.current.onWorkspaceChange?.(cwd);
        } else if (event.type === "sessions") {
          handlersRef.current.onSessionsChange?.();
        }
      };
      // onerror：EventSource 自动重连，无需处理
    };

    const close = () => {
      es?.close();
      es = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") open();
      else close();
    };

    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      open();
      handlersRef.current.onFocusRefresh?.();
    };

    open();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [cwd]);
}
