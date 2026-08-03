"use client";

/**
 * 全局确认弹窗（自绘，不依赖 window.confirm）。
 *
 * 背景：Tauri v2 会拦截 window.confirm 并转发给原生 dialog 插件，
 * 但该转发需要前端引入 @tauri-apps/plugin-dialog 的 JS API；
 * 没有它时桌面端 confirm 会抛 “dialog.confirm not allowed” 错误。
 * 这里用自绘弹窗 + 事件桥，浏览器与桌面行为一致。
 *
 * 用法：
 *   if (!(await confirmDialog("确定要放弃吗？"))) return;
 */

let activeResolver: ((ok: boolean) => void) | null = null;

export function confirmDialog(message: string): Promise<boolean> {
  window.dispatchEvent(new CustomEvent("pi-confirm-request", { detail: { message } }));
  return new Promise((resolve) => {
    activeResolver = resolve;
  });
}

export function resolveConfirm(ok: boolean): void {
  if (!activeResolver) return;
  activeResolver(ok);
  activeResolver = null;
  window.dispatchEvent(new CustomEvent("pi-confirm-done"));
}
