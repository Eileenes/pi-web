"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommitDetail, GitCommitFileChange, GitLogEntry } from "@/lib/git-types";
import { buildCommitGraph, type GraphRow } from "@/lib/commit-graph";
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

// ---- 提交图（VSCode 风格分支连线图） ----

const GRAPH_LANE_W = 14;
// 分支线调色板（VSCode 深浅主题通用的中等亮度色）
const GRAPH_COLORS = [
  "#e06c75", "#61afef", "#98c379", "#d19a66", "#c678dd",
  "#56b6c2", "#e5c07b", "#f78c6c", "#7ec699", "#ff9e64",
];

function laneColor(i: number): string {
  return GRAPH_COLORS[i % GRAPH_COLORS.length];
}

function CommitGraph({ row, width }: { row: GraphRow; width: number }) {
  const x = (i: number) => i * GRAPH_LANE_W + GRAPH_LANE_W / 2;
  return (
    <svg
      width={width}
      height="100%"
      style={{ display: "block", flexShrink: 0, alignSelf: "stretch", minHeight: 22 }}
      aria-hidden="true"
    >
      {/* 进入竖线：从上一行延续到本行的线 */}
      {row.lanesBefore.map((h, j) =>
        h === null ? null : (
          <line key={`in-${j}`} x1={x(j)} y1="0" x2={x(j)} y2="100%" stroke={laneColor(j)} strokeWidth={2} />
        ),
      )}
      {/* 合流水平线：其它分支并入节点列 */}
      {row.merges.map((j) => (
        <line key={`m-${j}`} x1={x(j)} y1="50%" x2={x(row.col)} y2="50%" stroke={laneColor(j)} strokeWidth={2} />
      ))}
      {/* 分叉水平线：节点列分流到父提交所在列 */}
      {row.forks.map((f) => (
        <line key={`f-${f}`} x1={x(row.col)} y1="50%" x2={x(f)} y2="50%" stroke={laneColor(row.col)} strokeWidth={2} />
      ))}
      {/* 提交节点：合并提交为空心圆 */}
      <circle
        cx={x(row.col)}
        cy="50%"
        r={row.isMerge ? 5 : 3.5}
        fill={row.isMerge ? "var(--bg-panel)" : laneColor(row.col)}
        stroke={laneColor(row.col)}
        strokeWidth={row.isMerge ? 1.8 : 0}
      />
    </svg>
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
  const [all, setAll] = useState(true);
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

  // hover 弹窗：快速预览提交信息与文件改动
  const [hover, setHover] = useState<{ hash: string; x: number; y: number } | null>(null);
  const [hoverDetail, setHoverDetail] = useState<GitCommitDetail | null>(null);
  const [hoverLoading, setHoverLoading] = useState(false);
  const hoverDetailCacheRef = useRef(new Map<string, GitCommitDetail | null>());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  entriesRef.current = entries;

  // 提交图布局：entries 增长（分页）时全量重建；由于 lanes 状态从头连续计算，
  // 未加载到的父提交会作为悬挂 hash 保留，加载更多后连线自然落地。
  const graphRows = useMemo(
    () => buildCommitGraph(entries.map((e) => ({ hash: e.hash, parents: e.parents }))),
    [entries],
  );
  const graphWidth = useMemo(() => {
    let cols = 1;
    for (const r of graphRows) {
      cols = Math.max(
        cols,
        r.lanesBefore.length,
        r.lanesAfter.length,
        r.col + 1,
        ...r.merges.map((m) => m + 1),
        ...r.forks.map((f) => f + 1),
      );
    }
    return cols * GRAPH_LANE_W + GRAPH_LANE_W / 2;
  }, [graphRows]);

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

  // 组件卸载时清理 hover 定时器
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

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

  // hover 弹窗：延迟 250ms 显示，同时按需加载提交详情（带缓存）
  const handleRowHover = useCallback((e: React.MouseEvent, hash: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const x = e.clientX;
    const y = e.clientY;
    hoverTimerRef.current = setTimeout(() => {
      setHover({ hash, x, y });
      const cached = hoverDetailCacheRef.current.get(hash);
      if (cached !== undefined) {
        setHoverDetail(cached);
        setHoverLoading(false);
        return;
      }
      if (!cwd) return;
      setHoverLoading(true);
      setHoverDetail(null);
      void (async () => {
        try {
          const d = await fetchJson<GitCommitDetail>(
            `/api/git/commit?cwd=${encodeURIComponent(cwd)}&hash=${hash}`,
          );
          hoverDetailCacheRef.current.set(hash, d);
          setHoverDetail(d);
        } catch {
          hoverDetailCacheRef.current.set(hash, null);
          setHoverDetail(null);
        } finally {
          setHoverLoading(false);
        }
      })();
    }, 250);
  }, [cwd]);

  const handleRowLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHover(null);
    setHoverDetail(null);
    setHoverLoading(false);
  }, []);

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
      <div
        ref={scrollRef}
        onScroll={handleRowLeave}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
      >
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("scm.loading")}</div>
        ) : error ? (
          <div style={{ padding: 12, fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}>{error}</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6 }}>
            {t("scm.noCommits")}
          </div>
        ) : (
          entries.map((entry, idx) => {
            const isExpanded = expandedHash === entry.hash;
            const row = graphRows[idx];
            return (
              <div key={entry.hash} style={{ borderBottom: "1px solid var(--border)" }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void toggleDetail(entry.hash)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void toggleDetail(entry.hash);
                    }
                  }}
                  title={t("scm.expandCommit")}
                  aria-expanded={isExpanded}
                  style={{
                    display: "flex", alignItems: "stretch", minWidth: 0, height: 26,
                    background: isExpanded ? "var(--bg-selected)" : "transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!isExpanded) e.currentTarget.style.background = "var(--bg-hover)";
                    handleRowHover(e, entry.hash);
                  }}
                  onMouseLeave={(e) => {
                    if (!isExpanded) e.currentTarget.style.background = "transparent";
                    handleRowLeave();
                  }}
                >
                  {row && <CommitGraph row={row} width={graphWidth} />}
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, paddingRight: 4 }}>
                    <span
                      title={entry.subject}
                      style={{
                        flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        fontSize: 12, fontWeight: 500, color: "var(--text)",
                      }}
                    >
                      {entry.subject}
                    </span>
                    <span
                      title={entry.author}
                      style={{
                        flexShrink: 0, fontSize: 10, color: "var(--text-dim)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 72,
                      }}
                    >
                      {entry.author.split(" ")[0]}
                    </span>
                  </div>
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" style={{ flexShrink: 0, alignSelf: "center", marginRight: 6, transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.12s" }}>
                    <polyline points="2 3 5 6 8 3" />
                  </svg>
                </div>

                {isExpanded && (
                  <div style={{ padding: `2px 8px 8px ${graphWidth + 6}px`, background: "var(--bg-selected)", minWidth: 0 }}>
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

      {/* hover 弹窗：快速预览提交信息与文件改动 */}
      {hover && (() => {
        const entry = entries.find((e) => e.hash === hover.hash);
        if (!entry) return null;
        const cardWidth = 300;
        const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
        const vh = typeof window !== "undefined" ? window.innerHeight : 800;
        const left = Math.max(8, Math.min(hover.x + 14, vw - cardWidth - 12));
        const top = Math.max(8, Math.min(hover.y - 12, vh - 360));
        return (
          <div
            role="tooltip"
            style={{
              position: "fixed", top, left, zIndex: 500, width: cardWidth, maxHeight: 340,
              overflowY: "auto", background: "var(--bg-panel)",
              border: "1px solid var(--border)", borderRadius: 8,
              boxShadow: "0 10px 30px rgba(0,0,0,0.18)", padding: 8,
              fontSize: 11, pointerEvents: "none",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.4, wordBreak: "break-word" }}>
              {entry.subject}
            </div>
            {entry.refs.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 4 }}>
                {entry.refs.map((ref) => <RefTag key={ref} ref={ref} />)}
              </div>
            )}
            <div style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{entry.hash}</span>
              <span style={{ color: "var(--text-muted)" }}>{entry.author} &lt;{entry.authorEmail}&gt;</span>
              <span style={{ color: "var(--text-dim)" }}>{new Date(entry.date).toLocaleString()}</span>
            </div>
            <div style={{ borderTop: "1px solid var(--border)", margin: "7px 0 5px" }} />
            {hoverLoading ? (
              <div style={{ padding: "4px 0", color: "var(--text-dim)" }}>{t("scm.loading")}</div>
            ) : hoverDetail ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {hoverDetail.files.slice(0, 20).map((f) => {
                  const meta = FILE_STATUS_META[f.status];
                  return (
                    <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, padding: "1.5px 0" }}>
                      <span style={{ flexShrink: 0, width: 13, fontSize: 9.5, fontWeight: 700, textAlign: "center", color: meta.color, fontFamily: "var(--font-mono)" }}>{meta.code}</span>
                      <span title={f.path} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 10 }}>{f.path}</span>
                      <span style={{ flexShrink: 0, fontSize: 9.5, fontVariantNumeric: "tabular-nums", color: "var(--text-dim)" }}>
                        <span style={{ color: "var(--diff-add)" }}>+{f.additions}</span>{" "}
                        <span style={{ color: "var(--diff-del)" }}>−{f.deletions}</span>
                      </span>
                    </div>
                  );
                })}
                {hoverDetail.files.length === 0 && (
                  <div style={{ color: "var(--text-dim)", padding: "2px 0" }}>{t("scm.noFileChanges")}</div>
                )}
                {hoverDetail.files.length > 20 && (
                  <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 3 }}>{t("scm.moreFiles", { count: hoverDetail.files.length - 20 })}</div>
                )}
              </div>
            ) : (
              <div style={{ color: "var(--text-dim)", padding: "2px 0" }}>{t("scm.loadFailed")}</div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
