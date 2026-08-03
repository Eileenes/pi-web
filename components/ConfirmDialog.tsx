"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { resolveConfirm } from "@/lib/confirm";
import { useI18n } from "@/hooks/useI18n";

/**
 * 全局确认弹窗宿主。挂在 AppShell 顶层；通过 lib/confirm 的 confirmDialog() 触发。
 */
export function ConfirmDialogHost() {
  const { t } = useI18n();
  const [state, setState] = useState<{ message: string } | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      setState({ message: detail.message });
    };
    const onDone = () => setState(null);
    window.addEventListener("pi-confirm-request", onRequest);
    window.addEventListener("pi-confirm-done", onDone);
    return () => {
      window.removeEventListener("pi-confirm-request", onRequest);
      window.removeEventListener("pi-confirm-done", onDone);
    };
  }, []);

  if (!state) return null;

  return createPortal(
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 2000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolveConfirm(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t("common.confirm")}
        style={{
          width: "min(420px, calc(100vw - 32px))",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.22)",
          padding: "16px 18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: 1 }}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, overflowWrap: "anywhere" }}>
            {state.message}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            autoFocus
            onClick={() => resolveConfirm(false)}
            style={{
              height: 30, padding: "0 14px",
              border: "1px solid var(--border)", borderRadius: 7,
              background: "var(--bg-panel)", color: "var(--text)",
              cursor: "pointer", fontSize: 12,
            }}
          >
            {t("i18n.cancel")}
          </button>
          <button
            type="button"
            onClick={() => resolveConfirm(true)}
            style={{
              height: 30, padding: "0 14px",
              border: "none", borderRadius: 7,
              background: "var(--accent)", color: "var(--on-accent)",
              cursor: "pointer", fontSize: 12, fontWeight: 600,
            }}
          >
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
