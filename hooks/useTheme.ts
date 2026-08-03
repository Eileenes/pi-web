"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  applySkinVars,
  getSkin,
  isKnownSkin,
  SKINS,
} from "@/lib/skins";

type Theme = "light" | "dark";

const listeners = new Set<() => void>();

// 快照缓存：useSyncExternalStore 要求快照引用稳定（对象复用），
// 状态变更时置 null 强制重建。
let snapshot: { theme: Theme; skinId: string } | null = null;

function readInitialState(): { theme: Theme; skinId: string } {
  if (typeof document === "undefined") return { theme: "light", skinId: "classic" };
  const theme: Theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  let skinId = document.documentElement.dataset.skin ?? "";
  if (!isKnownSkin(skinId)) {
    try {
      const stored = localStorage.getItem("pi-skin");
      skinId = stored && isKnownSkin(stored) ? stored : "classic";
    } catch {
      skinId = "classic";
    }
  }
  return { theme, skinId };
}

let state = readInitialState();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): { theme: Theme; skinId: string } {
  if (!snapshot) snapshot = state;
  return snapshot;
}

const SERVER_SNAPSHOT: { theme: Theme; skinId: string } = { theme: "light", skinId: "classic" };
function getServerSnapshot(): { theme: Theme; skinId: string } {
  return SERVER_SNAPSHOT;
}

type ToggleOrigin = { x: number; y: number };

/** 应用亮暗 + 皮肤，并持久化。 */
function applyState(next: { theme: Theme; skinId: string }): void {
  state = next;
  snapshot = null;

  const el = document.documentElement;
  if (next.theme === "dark") el.classList.add("dark");
  else el.classList.remove("dark");
  el.dataset.skin = next.skinId;
  applySkinVars(el, getSkin(next.skinId), next.theme === "dark");

  try {
    localStorage.setItem("pi-theme", next.theme);
    localStorage.setItem("pi-skin", next.skinId);
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  listeners.forEach((cb) => cb());
}

/** View Transitions 圆形过渡（亮暗切换与换肤共用）。 */
function runTransition(apply: () => void, origin?: ToggleOrigin) {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const supportsVT = typeof document.startViewTransition === "function";

  if (!supportsVT || reduceMotion) {
    apply();
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );

  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${endRadius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 450,
          easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      // transition cancelled — ignore
    });
}

export function useTheme() {
  const { theme, skinId } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isDark = theme === "dark";

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    const nextTheme: Theme = state.theme === "dark" ? "light" : "dark";
    runTransition(() => applyState({ theme: nextTheme, skinId: state.skinId }), origin);
  }, []);

  const setSkin = useCallback((nextSkinId: string, origin?: ToggleOrigin) => {
    if (!isKnownSkin(nextSkinId)) return;
    runTransition(() => applyState({ theme: state.theme, skinId: nextSkinId }), origin);
  }, []);

  return {
    theme,
    isDark,
    skinId,
    skin: getSkin(skinId),
    skins: SKINS,
    toggleTheme,
    setSkin,
  };
}
