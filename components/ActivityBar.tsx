"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

export type ActivityBarView = "sessions" | "scm";

interface Props {
  view: ActivityBarView;
  onViewChange: (view: ActivityBarView) => void;
  /** 当前项目的 git 变更数（未暂存+暂存+未跟踪），null 表示未知/无项目 */
  changeCount: number | null;
}

function SessionsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function ScmIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6" />
      <path d="M18 9a6 6 0 0 0-6-6v0" />
    </svg>
  );
}

/**
 * VSCode 风格的左侧 Activity Bar（仅桌面端显示）：
 * 常驻图标入口，带 git 变更数 badge，点击切换侧栏视图。
 */
export function ActivityBar({ view, onViewChange, changeCount }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  if (isMobile) return null;

  const items: { id: ActivityBarView; label: string; icon: ReactNode }[] = [
    { id: "sessions", label: t("activitybar.sessions"), icon: <SessionsIcon /> },
    { id: "scm", label: t("scm.sidebarLabel"), icon: <ScmIcon /> },
  ];

  return (
    <div
      role="navigation"
      aria-label={t("activitybar.label")}
      style={{
        width: 44,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "var(--bg-panel)",
        borderRight: "1px solid var(--border)",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        zIndex: 201,
        userSelect: "none",
      }}
    >
      {items.map((item) => {
        const active = view === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onViewChange(item.id)}
            title={item.label}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              padding: 0,
              border: "none",
              background: "transparent",
              color: active ? "var(--text)" : "var(--text-dim)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--text-muted)"; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {/* Active indicator bar (left edge) */}
            {active && (
              <span style={{
                position: "absolute", left: 0, top: 10, bottom: 10, width: 2,
                background: "var(--text)", borderRadius: 1,
              }} />
            )}
            {item.icon}
            {item.id === "scm" && changeCount !== null && changeCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: 5,
                  right: 4,
                  minWidth: 15,
                  height: 15,
                  padding: "0 4px",
                  borderRadius: 8,
                  background: "var(--danger)",
                  color: "var(--on-accent)",
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: "15px",
                  textAlign: "center",
                  fontVariantNumeric: "tabular-nums",
                  boxSizing: "border-box",
                }}
              >
                {changeCount > 99 ? "99+" : changeCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
