"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommitDetail, GitCommitFileChange, GitLogEntry } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";
import { DiffView } from "./FileViewer";

interface Props {
  cwd: string | null;
}

const PAGE_SIZE = 50;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const FILE_STATUS_META: Record<GitCommitFileChange["status"], { code: string; color: string }> = {
  added: { code: "A", color: "var(--diff-add)" },
  deleted: { code: "D", color: "var(--diff-del)" },
  modified: { code: "M", color: "var(--diff-mod)" },
  renamed: { code: "R", color: "var(--diff-rename)" },
  copied: { code: "C", color: "var(--diff-rename)" },
};

/** 渲染 %D 装饰标签：HEAD 分支 / 标签 / 远程或本地分支 */
function RefTag({ ref }: { ref: string }) {
  const isHead = ref.startsWith("HEAD");
  const isTag = ref.startsWith("tag:");
  const text = isHead ? ref.replace("HEAD -> ", "") : isTag ? ref.replace("tag: ", "") : ref;
  const color = isHead ? "var(--accent)" : isTag ? "var(--warning)" : "var(--text-muted)";
  return (
    <span
      style={{
        flexShrink: 0,
        maxWidth: 120,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: "0 5px",
        height: 14,
        lineHeight: "14px",
        borderRadius: 3,
        border: `1px solid ${color}`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        color,
        fontSize: 9,
        fontWeight: 650,
        fontFamily: "var(--font-mono)",
      }}
    >
      {text}
    </span>
  );
}

export function GitHistoryPanel({ cwd }: Props) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef<GitLogEntry[]>([]);
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const requestRef = useRef(0);

  // 展开的提交详情
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  // 详情内联 diff
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffPatch, setDiffPatch] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(false);

  entriesRef.current = entries;

  const loadPage = useCallback(async (reset: boolean) => {
    if (!cwd) {
      setEntries([]);
      setHasMore(false);
      setLoading(false);
      return;
    }
    const requestId = ++requestRef.current;
    const offset = reset ? 0 : entriesRef.current.length;
    if (reset) {
      setLoading(true);
      setError(null);
      setHasMore(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const url = `/api/git/log?cwd=${encodeURIComponent(cwd)}&count=${PAGE_SIZE}&offset=${offset}&all=${all ? "1" : "0"}`;
      const next = await fetchJson<GitLogEntry[]>(url);
      if (requestId !== requestRef.current) return;
      if (reset) {
        setEntries(next);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        // 重置后收起已展开的详情
        setExpandedHash(null);
        setDetail(null);
        setDiffPath(null);
        setDiffPatch(null);
        setDiffError(false);
      } else {
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.hash));
          return [...prev, ...next.filter((e) => !seen.has(e.hash))];
        });
      }
      setHasMore(next.length === PAGE_SIZE);
    } catch (e) {
      if (requestId === requestRef.current) {
        if (reset) setError(e instanceof Error ? e.message : String(e));
        setHasMore(false);
      }
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [cwd, all]);

  // 首屏加载：cwd 或 all 切换时重置
  useEffect(() => {
    void loadPage(true);
  }, [loadPage]);

  // 触底无限加载
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed[0].isIntersecting && hasMore && !loading && !loadingMore) {
          void loadPage(false);
        }
      },
      { root, rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, hasMore, loading, loadingMore]);

  const toggleDetail = useCallback(async (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
      setDetail(null);
      setDiffPath(null);
      setDiffPatch(null);
      setDiffError(false);
      return;
    }
    setExpandedHash(hash);
    setDetail(null);
    setDiffPath(null);
    setDiffPatch(null);
    setDiffError(false);
    if (!cwd) return;
    setDetailLoading(true);
    setDetailError(false);
    try {
      const d = await fetchJson<GitCommitDetail>(`/api/git/commit?cwd=${encodeURIComponent(cwd)}&hash=${hash}`);
      setDetail(d);
    } catch {
      setDetailError(true);
    } finally {
      setDetailLoading(false);
    }
  }, [cwd, expandedHash]);

  const loadFileDiff = useCallback(async (path: string) => {
    if (!cwd || !expandedHash) return;
    if (diffPath === path) {
      // 再次点击收起
      setDiffPath(null);
      setDiffPatch(null);
      setDiffError(false);
      return;
    }
    setDiffPath(path);
    setDiffPatch(null);
    setDiffError(false);
    setDiffLoading(true);
    try {
      const res = await fetchJson<{ patch: string }>(
        `/api/git/commit-file?cwd=${encodeURIComponent(cwd)}&hash=${expandedHash}&path=${encodeURIComponent(path)}`,
      );
      setDiffPatch(res.patch);
    } catch {
      setDiffError(true);
      setDiffPatch("");
    } finally {
      setDiffLoading(false);
    }
  }, [cwd, expandedHash, diffPath]);

  const formatRelativeTime = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("scm.justNow");
    if (mins < 60) return t("scm.minutesAgo", { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("scm.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 7) return t("scm.daysAgo", { count: days });
    return new Date(dateStr).toLocaleDateString();
  };

  if (!cwd) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6 }}>
        {t("scm.selectProject")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Toolbar: all-branches toggle + refresh */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 6px", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          title={all ? t("scm.currentBranchOnly") : t("scm.allBranches")}
          style={{
            display: "flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px",
            border: "1px solid var(--border)", borderRadius: 5,
            background: all ? "var(--bg-selected)" : "var(--bg)",
            color: "var(--text-muted)", cursor: "pointer", fontSize: 10.5,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" />
            <path d="M18 9a6 6 0 0 0-6-6v0" />
          </svg>
          {all ? t("scm.allBranches") : t("scm.currentBranchOnly")}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void loadPage(true)}
          title={t("scm.refresh")}
          aria-label={t("scm.refresh")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--text-muted)", cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>

      {/* Scrollable list */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("scm.loading")}</div>
        ) : error ? (
          <div style={{ padding: 12, fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}>{error}</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6 }}>
            {t("scm.noCommits")}
          </div>
        ) : (
          entries.map((entry) => {
            const isExpanded = expandedHash === entry.hash;
            return (
              <div key={entry.hash} style={{ borderBottom: "1px solid var(--border)" }}>
                <button
                  type="button"
                  onClick={() => void toggleDetail(entry.hash)}
                  title={t("scm.expandCommit")}
                  aria-expanded={isExpanded}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    width: "100%", minWidth: 0, padding: "6px 8px",
                    border: "none", background: isExpanded ? "var(--bg-selected)" : "transparent",
                    color: "var(--text)", cursor: "pointer", textAlign: "left",
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                      {entry.refs.map((ref) => <RefTag key={ref} ref={ref} />)}
                      <span style={{
                        flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        fontSize: 12, fontWeight: 600, color: "var(--text)",
                      }}>
                        {entry.subject}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, fontSize: 10, color: "var(--text-dim)", minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{entry.author}</span>
                      <span style={{ flexShrink: 0 }}>·</span>
                      <span style={{ flexShrink: 0 }}>{formatRelativeTime(entry.date)}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{entry.shortHash}</span>
                    </div>
                  </div>
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" style={{ flexShrink: 0, transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.12s" }}>
                    <polyline points="2 3 5 6 8 3" />
                  </svg>
                </button>

                {isExpanded && (
                  <div style={{ padding: "2px 8px 8px", background: "var(--bg-selected)", minWidth: 0 }}>
                    {detailLoading ? (
                      <div style={{ padding: "8px 2px", fontSize: 11, color: "var(--text-dim)" }}>{t("scm.loading")}</div>
                    ) : detailError ? (
                      <div style={{ padding: "8px 2px", fontSize: 11, color: "var(--danger)" }}>{t("scm.loadFailed")}</div>
                    ) : detail ? (
                      <>
                        {detail.body && (
                          <div style={{
                            fontSize: 11.5, color: "var(--text)", lineHeight: 1.55,
                            whiteSpace: "pre-wrap", wordBreak: "break-word",
                            marginBottom: 6,
                          }}>
                            {detail.body}
                          </div>
                        )}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>
                          <span>{t("scm.author")}: {detail.author} &lt;{detail.authorEmail}&gt;</span>
                          <span>{t("scm.commitTime")}: {new Date(detail.committerDate).toLocaleString()}</span>
                        </div>
                        {detail.files.length === 0 ? (
                          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 2px" }}>{t("scm.noFileChanges")}</div>
                        ) : (
                          <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", background: "var(--bg)" }}>
                            {detail.files.map((f) => {
                              const meta = FILE_STATUS_META[f.status];
                              const active = diffPath === f.path;
                              const slashIdx = f.path.lastIndexOf("/");
                              const fileName = slashIdx === -1 ? f.path : f.path.slice(slashIdx + 1);
                              const dirName = slashIdx === -1 ? "" : f.path.slice(0, slashIdx + 1);
                              return (
                                <button
                                  key={f.path}
                                  type="button"
                                  onClick={() => void loadFileDiff(f.path)}
                                  title={t("scm.viewFileDiff")}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0,
                                    padding: "3px 8px", border: "none", borderTop: "1px solid var(--border)",
                                    background: active ? "var(--bg-hover)" : "transparent",
                                    color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11,
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
                                >
                                  <span style={{ flexShrink: 0, width: 14, fontSize: 10, fontWeight: 700, textAlign: "center", color: meta.color, fontFamily: "var(--font-mono)" }}>
                                    {meta.code}
                                  </span>
                                  <span title={f.path} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
                                    {fileName}
                                    {dirName && <span style={{ color: "var(--text-dim)", fontSize: 9.5 }}>  {dirName}</span>}
                                  </span>
                                  <span style={{ flexShrink: 0, fontSize: 10, fontVariantNumeric: "tabular-nums", color: "var(--text-dim)" }}>
                                    <span style={{ color: "var(--diff-add)" }}>+{f.additions}</span>{" "}
                                    <span style={{ color: "var(--diff-del)" }}>−{f.deletions}</span>
                                  </span>
                                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" style={{ flexShrink: 0, transform: active ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.12s" }}>
                                    <polyline points="2 3 5 6 8 3" />
                                  </svg>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {diffPath && (
                          <div style={{ marginTop: 6 }}>
                            {diffLoading ? (
                              <div style={{ padding: "8px 2px", fontSize: 11, color: "var(--text-dim)" }}>{t("scm.loading")}</div>
                            ) : diffError ? (
                              <div style={{ padding: "6px 2px", fontSize: 11, color: "var(--danger)" }}>{t("scm.loadFailed")}</div>
                            ) : diffPatch ? (
                              <DiffView patch={diffPatch} />
                            ) : (
                              <div style={{ padding: "6px 2px", fontSize: 11, color: "var(--text-dim)" }}>{t("i18n.noChanges")}</div>
                            )}
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
        {!loading && hasMore && entries.length > 0 && (
          <div ref={sentinelRef} style={{ padding: 12, textAlign: "center" }}>
            {loadingMore ? (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("scm.loadingMore")}</span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("scm.loading")}</span>
            )}
          </div>
        )}
        {!loading && !hasMore && entries.length > 0 && (
          <div style={{ padding: 10, textAlign: "center", fontSize: 10, color: "var(--text-dim)" }}>
            {t("scm.endOfHistory")}
          </div>
        )}
      </div>
    </div>
  );
}
