/**
 * 桌面端（Tauri）桥。
 *
 * Tauri 配置了 `app.withGlobalTauri: true`，WebView 内可通过
 * `window.__TAURI__.core.invoke` 调用 Rust 命令。浏览器/PWA 环境
 * 下这些函数全部安全降级（返回 null / no-op）。
 */

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI__);
}

export async function selectDirectoryDesktop(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return (await window.__TAURI__!.core.invoke("select_directory")) as string | null;
  } catch {
    return null;
  }
}

export async function revealInFinderDesktop(filePath: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    await window.__TAURI__!.core.invoke("reveal_in_finder", { path: filePath });
  } catch {
    // ignore
  }
}

export async function notifyDesktop(title: string, body: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    await window.__TAURI__!.core.invoke("notify", { title, body });
  } catch {
    // ignore
  }
}
