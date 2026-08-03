"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitBranchInfo, GitFileStatus, GitLogEntry, GitStatusResponse } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  cwd: string | null;
  refreshKey?: number;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onBack: () => void;
}

const STATUS_META: Record<GitFileStatus["status"], { code: string; color: string }> = {
  modified: { code: "M", color: "var(--diff-mod)" },
  added: { code: "A", color: "var(--diff-add)" },
  deleted: { code: "D", color: "var(--diff-del)" },
  renamed: { code: "R", color: "var(--diff-rename)" },
  untracked: { code: "U", color: "var(--diff-add)" },
  conflict: { code: "C", color: "var(--danger)" },
};

const POLL_MS = 10_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function relPath(abs: string, root: string): string {
  const r = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return r.replace(/^[/\\]+/, "");
}

interface DirNode {
  type: "dir";
  name: string;
  relPath: string;
  children: TreeNode[];
}
interface FileNode {
  type: "file";
  name: string;
  relPath: string;
  file: GitFileStatus;
}
type TreeNode = DirNode | FileNode;

function buildTree(files: GitFileStatus[], root: string): TreeNode[] {
  const dirs = new Map<string, DirNode>();
  const rootChildren: TreeNode[] = [];
  for (const file of files) {
    const rel = relPath(file.filePath, root);
    const parts = rel.split("/");
    const fileName = parts.pop() || rel;
    let children = rootChildren;
    let curRel = "";
    for (const part of parts) {
      curRel = curRel ? `${curRel}/${part}` : part;
      let dir = dirs.get(curRel);
      if (!dir) {
        dir = { type: "dir", name: part, relPath: curRel, children: [] };
        dirs.set(curRel, dir);
        children.push(dir);
      }
      children = dir.children;
    }
    children.push({ type: "file", name: fileName, relPath: rel, file });
  }
  const sortChildren = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.type === "dir") sortChildren(n.children);
  };
  sortChildren(rootChildren);
  return rootChildren;
}

function splitGroups(files: GitFileStatus[]): {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
} {
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: GitFileStatus[] = [];
  for (const f of files) {
    if (f.status === "untracked") {
      untracked.push(f);
    } else if (f.status === "conflict" || (f.worktreeStatus !== " " && f.worktreeStatus !== "?")) {
      unstaged.push(f);
    } else if (f.indexStatus !== " " && f.indexStatus !== "?") {
      staged.push(f);
    } else {
      // 保底：任何未分组的变化都算未暂存
      unstaged.push(f);
    }
  }
  return { staged, unstaged, untracked };
}

function DirNodeView({
  node,
  depth,
  actions,
  t,
  selected,
  onToggleSelect,
}: {
  node: DirNode;
  depth: number;
  actions: {
    onStage: (f: GitFileStatus) => void;
    onUnstage: (f: GitFileStatus) => void;
    onDiscard: (f: GitFileStatus) => void;
    onOpenFile: (f: GitFileStatus) => void;
    staged: boolean;
  };
  t: ReturnType<typeof useI18n>["t"];
  selected: Set<string>;
  onToggleSelect: (p: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        style={{
          display: "flex", alignItems: "center", gap: 4, width: "100%", height: 22,
          padding: "0 6px", paddingLeft: 4 + depth * 12,
          border: "none", background: "transparent", color: "var(--text-muted)",
          cursor: "pointer", fontSize: 11, textAlign: "left", borderRadius: 4,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flexShrink: 0, transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.1s" }}>
          <polyline points="2 3 5 6 8 3" />
        </svg>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
      </button>
      {!collapsed && node.children.map((child) =>
        child.type === "dir" ? (
          <DirNodeView key={child.relPath} node={child} depth={depth + 1} actions={actions} t={t} selected={selected} onToggleSelect={onToggleSelect} />
        ) : (
          <FileNodeView key={child.relPath} node={child} depth={depth + 1} actions={actions} t={t} selected={selected} onToggleSelect={onToggleSelect} />
        ),
      )}
    </div>
  );
}

function FileNodeView({
  node,
  depth,
  actions,
  t,
  selected,
  onToggleSelect,
}: {
  node: FileNode;
  depth: number;
  actions: {
    onStage: (f: GitFileStatus) => void;
    onUnstage: (f: GitFileStatus) => void;
    onDiscard: (f: GitFileStatus) => void;
    onOpenFile: (f: GitFileStatus) => void;
    staged: boolean;
  };
  t: ReturnType<typeof useI18n>["t"];
  selected: Set<string>;
  onToggleSelect: (p: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const meta = STATUS_META[node.file.status];
  const isSelected = selected.has(node.file.filePath);
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 2, height: 24,
        padding: "0 6px", paddingLeft: 2 + depth * 12,
        cursor: "pointer", borderRadius: 4,
        background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => actions.onOpenFile(node.file)}
      title={node.relPath}
    >
      <button
        type="button"
        aria-label={isSelected ? t("scm.deselect") : t("scm.select")}
        title={isSelected ? t("scm.deselect") : t("scm.select")}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(node.file.filePath); }}
        style={{
          flexShrink: 0, width: 16, height: 16, padding: 0, border: "none",
          background: "transparent", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: hovered || isSelected ? "var(--text-muted)" : "transparent",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {isSelected ? (
            <><rect x="3" y="3" width="18" height="18" rx="4" fill="var(--accent)" stroke="var(--accent)" /><polyline points="9 12 11 14 15 10" stroke="var(--on-accent)" strokeWidth="2.6" /></>
          ) : (
            <rect x="3" y="3" width="18" height="18" rx="4" />
          )}
        </svg>
      </button>
      <span
        style={{
          flexShrink: 0, width: 16, fontSize: 10, fontWeight: 700, textAlign: "center",
          color: meta.color, fontFamily: "var(--font-mono)",
        }}
        title={t(`scm.status.${node.file.status}`)}
      >
        {meta.code}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
        {node.name}
      </span>
      <span style={{ display: "flex", gap: 2, opacity: hovered ? 1 : 0, transition: "opacity 0.1s", flexShrink: 0 }}>
        {actions.staged ? (
          <RowAction title={t("scm.unstage")} onClick={(e) => { e.stopPropagation(); actions.onUnstage(node.file); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14" /><path d="m14 5 7 7-7 7" /></svg>
          </RowAction>
        ) : (
          <RowAction title={t("scm.stage")} onClick={(e) => { e.stopPropagation(); actions.onStage(node.file); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          </RowAction>
        )}
        <RowAction title={t("scm.discard")} onClick={(e) => { e.stopPropagation(); actions.onDiscard(node.file); }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </RowAction>
        <RowAction title={t("scm.openDiff")} onClick={(e) => { e.stopPropagation(); actions.onOpenFile(node.file); }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
          </svg>
        </RowAction>
      </span>
    </div>
  );
}

function RowAction({ title, onClick, children }: { title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 20, height: 20, padding: 0, border: "none", borderRadius: 4,
        background: "transparent", color: "var(--text-dim)", cursor: "pointer",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-selected)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}

function FileGroup({
  title,
  files,
  root,
  staged,
  actions,
  t,
  selected,
  onToggleSelect,
  onStageAllFiles,
  onUnstageAllFiles,
}: {
  title: string;
  files: GitFileStatus[];
  root: string;
  staged: boolean;
  actions: {
    onStage: (f: GitFileStatus) => void;
    onUnstage: (f: GitFileStatus) => void;
    onDiscard: (f: GitFileStatus) => void;
    onOpenFile: (f: GitFileStatus) => void;
  };
  t: ReturnType<typeof useI18n>["t"];
  selected: Set<string>;
  onToggleSelect: (p: string) => void;
  onStageAllFiles: () => void;
  onUnstageAllFiles: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const tree = useMemo(() => buildTree(files, root), [files, root]);
  if (files.length === 0) return null;
  return (
    <div style={{ marginTop: 2 }}>
      <div
        style={{
          display: "flex", alignItems: "center", height: 24,
          padding: "0 8px", fontSize: 11, fontWeight: 650,
          color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.02em",
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          style={{
            display: "flex", alignItems: "center", gap: 5, border: "none", background: "transparent",
            color: "inherit", cursor: "pointer", fontSize: "inherit", fontWeight: "inherit",
            letterSpacing: "inherit", textTransform: "inherit", padding: 0, flexShrink: 0,
          }}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.1s" }}>
            <polyline points="2 3 5 6 8 3" />
          </svg>
          <span>{title}</span>
          <span style={{ fontWeight: 500, color: "var(--text-dim)" }}>{files.length}</span>
        </button>
        <span style={{ flex: 1 }} />
        {staged ? (
          <button
            type="button"
            onClick={onUnstageAllFiles}
            title={t("scm.unstageAll")}
            style={{
              border: "none", background: "transparent", padding: "0 4px",
              color: "var(--text-dim)", cursor: "pointer", fontSize: 10,
              display: "flex", alignItems: "center", gap: 3,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14" /><path d="m14 5 7 7-7 7" /></svg>
            {t("scm.unstageAll")}
          </button>
        ) : (
          <button
            type="button"
            onClick={onStageAllFiles}
            title={t("scm.stageGroup")}
            style={{
              border: "none", background: "transparent", padding: "0 4px",
              color: "var(--text-dim)", cursor: "pointer", fontSize: 10,
              display: "flex", alignItems: "center", gap: 3,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            {t("scm.stageGroup")}
          </button>
        )}
      </div>
      {!collapsed && tree.map((child) =>
        child.type === "dir" ? (
          <DirNodeView key={child.relPath} node={child} depth={0} actions={{ ...actions, staged }} t={t} selected={selected} onToggleSelect={onToggleSelect} />
        ) : (
          <FileNodeView key={child.relPath} node={child} depth={0} actions={{ ...actions, staged }} t={t} selected={selected} onToggleSelect={onToggleSelect} />
        ),
      )}
    </div>
  );
}

export function SourceControlPanel({ cwd, refreshKey, onOpenFile, onBack }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showBranches, setShowBranches] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [gitLog, setGitLog] = useState<GitLogEntry[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const branchRef = useRef<HTMLDivElement>(null);
  const gitRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      setBranchInfo(null);
      setLoading(false);
      return;
    }
    const requestId = ++gitRequestRef.current;
    try {
      const encoded = encodeURIComponent(cwd);
      const [s, b] = await Promise.all([
        fetchJson<GitStatusResponse>(`/api/git/status?cwd=${encoded}`),
        fetchJson<GitBranchInfo>(`/api/git/branch?cwd=${encoded}`),
      ]);
      if (requestId !== gitRequestRef.current) return;
      setStatus(s);
      setBranchInfo(b);
      setError(null);
    } catch (e) {
      if (requestId === gitRequestRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (requestId === gitRequestRef.current) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!showBranches) return;
    const handler = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) setShowBranches(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBranches]);

  const runCommand = useCallback(async (action: string, extra: Record<string, unknown> = {}, paths: string[] = []) => {
    if (!cwd) return null;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/git/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, cwd, paths, ...extra }),
      });
      const data = await res.json() as { ok: boolean; stderr?: string; error?: string };
      if (!data.ok) throw new Error(data.stderr || data.error || "Git command failed");
      await refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [cwd, refresh]);

  const handleStage = useCallback((f: GitFileStatus) => {
    void runCommand("stage", {}, [f.filePath]);
  }, [runCommand]);

  const handleUnstage = useCallback((f: GitFileStatus) => {
    void runCommand("unstage", {}, [f.filePath]);
  }, [runCommand]);

  const handleDiscard = useCallback((f: GitFileStatus) => {
    const label = relPath(f.filePath, status?.repositoryRoot ?? cwd ?? "");
    const ok = window.confirm(t("scm.discardConfirm", { file: label }));
    if (!ok) return;
    void runCommand("discard", { untracked: f.status === "untracked" }, [f.filePath]);
  }, [runCommand, status, cwd, t]);

  const handleOpenFile = useCallback((f: GitFileStatus) => {
    const rel = relPath(f.filePath, status?.repositoryRoot ?? cwd ?? "");
    const name = rel.split("/").pop() || rel;
    onOpenFile?.(f.filePath, name, { modeHint: "diff" });
  }, [onOpenFile, status, cwd]);

  const groups = useMemo(() => (status?.files ? splitGroups(status.files) : { staged: [], unstaged: [], untracked: [] }), [status]);
  const hasChanges = groups.staged.length + groups.unstaged.length + groups.untracked.length > 0;

  const handleCommit = useCallback(async (push: boolean) => {
    const msg = commitMsg.trim();
    if (!msg) return;
    // 暂存区为空但有更改：提示自动暂存全部再提交
    if (groups.staged.length === 0 && hasChanges) {
      if (!window.confirm(t("scm.stageAllAndCommitConfirm"))) return;
      const staged = await runCommand("stage", {}, []);
      if (!staged) return;
    }
    const committed = await runCommand("commit", { message: msg, amend: false });
    if (!committed) return;
    if (push) {
      const pushed = await runCommand("push");
      if (!pushed) return;
      setFeedback(t("scm.pushed"));
    } else {
      setFeedback(t("scm.committed"));
    }
    setCommitMsg("");
  }, [commitMsg, runCommand, t, groups.staged.length, hasChanges]);

  const canCommit = (groups.staged.length > 0 || hasChanges) && commitMsg.trim().length > 0 && !busy;
  const canStageAll = !busy && (groups.unstaged.length + groups.untracked.length) > 0;

  const handleCheckout = useCallback(async (name: string, create: boolean) => {
    const result = await runCommand("checkout", { branch: name, create });
    if (result) {
      setShowBranches(false);
      setNewBranchName("");
    }
  }, [runCommand]);

  const handleDeleteBranch = useCallback(async (name: string) => {
    if (!window.confirm(t("scm.deleteBranchConfirm", { branch: name }))) return;
    const result = await runCommand("deleteBranch", { branch: name });
    if (result) setFeedback(t("scm.branchDeleted", { branch: name }));
  }, [runCommand, t]);

  const handleStageAll = useCallback(async () => {
    const result = await runCommand("stage", {}, []);
    if (result) setFeedback(t("scm.stagedAll"));
  }, [runCommand, t]);

  const handleDiscardAll = useCallback(async () => {
    if (!window.confirm(t("scm.discardAllConfirm"))) return;
    const result = await runCommand("discard", {}, []);
    if (result) setFeedback(t("scm.discardedAll"));
  }, [runCommand, t]);

  const handlePull = useCallback(async () => {
    const result = await runCommand("pull");
    if (result) setFeedback(t("scm.pulled"));
  }, [runCommand, t]);

  const handlePush = useCallback(async () => {
    const result = await runCommand("push");
    if (result) setFeedback(t("scm.pushed"));
  }, [runCommand, t]);

  // ---- 多选与批量操作 ----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((p: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => {
    setSelected(new Set((status?.files ?? []).map((f) => f.filePath)));
  }, [status]);
  const selectedFiles = useMemo(
    () => (status?.files ?? []).filter((f) => selected.has(f.filePath)),
    [status, selected],
  );

  const batchStage = useCallback(async () => {
    const paths = selectedFiles
      .filter((f) => f.indexStatus === " " || f.indexStatus === "?")
      .map((f) => f.filePath);
    if (paths.length === 0) return;
    const result = await runCommand("stage", {}, paths);
    if (result) {
      setFeedback(t("scm.stagedN", { count: paths.length }));
      clearSelection();
    }
  }, [selectedFiles, runCommand, t, clearSelection]);

  const batchUnstage = useCallback(async () => {
    const paths = selectedFiles
      .filter((f) => f.indexStatus !== " " && f.indexStatus !== "?")
      .map((f) => f.filePath);
    if (paths.length === 0) return;
    const result = await runCommand("unstage", {}, paths);
    if (result) {
      setFeedback(t("scm.unstagedN", { count: paths.length }));
      clearSelection();
    }
  }, [selectedFiles, runCommand, t, clearSelection]);

  const batchDiscard = useCallback(async () => {
    if (selectedFiles.length === 0) return;
    if (!window.confirm(t("scm.discardNConfirm", { count: selectedFiles.length }))) return;
    const tracked = selectedFiles.filter((f) => f.status !== "untracked").map((f) => f.filePath);
    const untracked = selectedFiles.filter((f) => f.status === "untracked").map((f) => f.filePath);
    if (tracked.length > 0) await runCommand("discard", {}, tracked);
    if (untracked.length > 0) await runCommand("discard", { untracked: true }, untracked);
    clearSelection();
    setFeedback(t("scm.discardedN", { count: selectedFiles.length }));
  }, [selectedFiles, runCommand, t, clearSelection]);

  const stageAllInGroup = useCallback(async (files: GitFileStatus[]) => {
    const result = await runCommand("stage", {}, files.map((f) => f.filePath));
    if (result) setFeedback(t("scm.stagedN", { count: files.length }));
  }, [runCommand, t]);

  const unstageAllInGroup = useCallback(async (files: GitFileStatus[]) => {
    const result = await runCommand("unstage", {}, files.map((f) => f.filePath));
    if (result) setFeedback(t("scm.unstagedN", { count: files.length }));
  }, [runCommand, t]);

  const toggleLog = useCallback(() => {
    setShowLog((v) => !v);
  }, []);

  // 展开历史时按需加载（不在 setState updater 里发请求）
  useEffect(() => {
    if (showLog && gitLog === null && cwd) {
      void fetchJson<GitLogEntry[]>(`/api/git/log?cwd=${encodeURIComponent(cwd)}`)
        .then(setGitLog)
        .catch(() => setGitLog([]));
    }
  }, [showLog, gitLog, cwd]);

  const root = status?.repositoryRoot ?? cwd ?? "";

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", minWidth: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 8px 4px", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onBack}
          title={t("scm.back")}
          aria-label={t("scm.back")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0, border: "none", borderRadius: 5,
            background: "transparent", color: "var(--text-muted)", cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("scm.title")}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          title={t("scm.refresh")}
          aria-label={t("scm.refresh")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0, border: "none", borderRadius: 5,
            background: "transparent", color: "var(--text-muted)", cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>

      {/* Branch row */}
      <div style={{ padding: "2px 8px 6px", flexShrink: 0, position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div ref={branchRef} style={{ position: "relative", minWidth: 0, flex: 1 }}>
            <button
              type="button"
              onClick={() => setShowBranches((v) => !v)}
              title={t("scm.switchBranch")}
              style={{
                display: "flex", alignItems: "center", gap: 5, maxWidth: "100%",
                height: 24, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 11,
                fontWeight: 600, fontFamily: "var(--font-mono)",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-muted)" }}>
                <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 9a6 6 0 0 0-6-6v0" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {branchInfo?.current ?? "—"}
              </span>
            </button>
            {showBranches && branchInfo && (
              <div style={{
                position: "absolute", top: 28, left: 0, zIndex: 300,
                width: "min(280px, calc(100vw - 24px))",
                background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 7,
                boxShadow: "0 10px 28px rgba(0,0,0,0.14)", overflow: "hidden",
              }}>
                <div style={{ maxHeight: 220, overflowY: "auto", padding: 4 }}>
                  {branchInfo.branches.map((b) => (
                    <div key={b.name} style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 4, paddingRight: 4 }}>
                      <button
                        type="button"
                        onClick={() => void handleCheckout(b.name, false)}
                        disabled={b.isCurrent}
                        style={{
                          flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5,
                          height: 26, padding: "0 8px", border: "none", borderRadius: 4,
                          background: b.isCurrent ? "var(--bg-selected)" : "transparent",
                          color: "var(--text)", cursor: b.isCurrent ? "default" : "pointer",
                          fontSize: 11, fontFamily: "var(--font-mono)", textAlign: "left",
                        }}
                        onMouseEnter={(e) => { if (!b.isCurrent) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!b.isCurrent) e.currentTarget.style.background = "transparent"; }}
                      >
                        {b.isCurrent && (
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                      </button>
                      {!b.isCurrent && (
                        <button
                          type="button"
                          title={t("scm.deleteBranch")}
                          onClick={() => void handleDeleteBranch(b.name)}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            width: 20, height: 20, padding: 0, border: "none", borderRadius: 4,
                            background: "transparent", color: "var(--text-dim)", cursor: "pointer",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                  {branchInfo.branches.length === 0 && (
                    <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("scm.noBranches")}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid var(--border)" }}>
                  <input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newBranchName.trim()) void handleCheckout(newBranchName.trim(), true);
                    }}
                    placeholder={t("scm.newBranchPlaceholder")}
                    style={{
                      flex: 1, minWidth: 0, height: 24, padding: "0 8px",
                      border: "1px solid var(--border)", borderRadius: 5,
                      background: "var(--bg)", color: "var(--text)",
                      fontSize: 11, outline: "none", fontFamily: "var(--font-mono)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => newBranchName.trim() && void handleCheckout(newBranchName.trim(), true)}
                    disabled={!newBranchName.trim() || busy}
                    style={{
                      height: 24, padding: "0 9px", border: "none", borderRadius: 5,
                      background: "var(--accent)", color: "var(--on-accent)",
                      cursor: newBranchName.trim() && !busy ? "pointer" : "default",
                      fontSize: 11, fontWeight: 600, opacity: newBranchName.trim() && !busy ? 1 : 0.5,
                    }}
                  >
                    {t("scm.createBranch")}
                  </button>
                </div>
              </div>
            )}
          </div>
          {status?.isGitRepository && (
            <span style={{ flexShrink: 0, fontSize: 11, fontVariantNumeric: "tabular-nums", color: "var(--text-muted)" }}>
              <span style={{ color: "var(--diff-add)" }}>+{status.additions}</span>{" "}
              <span style={{ color: "var(--diff-del)" }}>−{status.deletions}</span>
            </span>
          )}
          {status?.isGitRepository && (
            <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => void handlePull()}
                disabled={busy}
                title={t("scm.pull")}
                aria-label={t("scm.pull")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0, border: "none", borderRadius: 4,
                  background: "transparent", color: "var(--text-muted)", cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!busy) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => void handlePush()}
                disabled={busy}
                title={t("scm.push")}
                aria-label={t("scm.push")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0, border: "none", borderRadius: 4,
                  background: "transparent", color: "var(--text-muted)", cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!busy) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M4 3h16" />
                </svg>
              </button>
            </span>
          )}
        </div>
      </div>

      {/* Groups */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
        {status?.isGitRepository && hasChanges && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 6px", flexShrink: 0 }}>
            {selected.size > 0 ? (
              <>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {t("scm.selectedN", { count: selected.size })}
                </span>
                <button
                  type="button"
                  onClick={() => void batchStage()}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 10.5,
                  }}
                >
                  {t("scm.stage")}
                </button>
                <button
                  type="button"
                  onClick={() => void batchUnstage()}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 10.5,
                  }}
                >
                  {t("scm.unstage")}
                </button>
                <button
                  type="button"
                  onClick={() => void batchDiscard()}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: "var(--danger)", cursor: "pointer", fontSize: 10.5,
                  }}
                >
                  {t("scm.discard")}
                </button>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={selectAll}
                  title={t("scm.selectAll")}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10.5,
                  }}
                >
                  {t("scm.selectAll")}
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  title={t("scm.clearSelection")}
                  style={{
                    height: 22, padding: "0 6px", border: "none", borderRadius: 5,
                    background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 12,
                  }}
                >
                  ×
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void handleStageAll()}
                  disabled={!canStageAll}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: canStageAll ? "var(--text)" : "var(--text-dim)",
                    cursor: canStageAll ? "pointer" : "default", fontSize: 10.5,
                    opacity: canStageAll ? 1 : 0.55,
                  }}
                >
                  {t("scm.stageAll")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDiscardAll()}
                  disabled={busy || !hasChanges}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: busy || !hasChanges ? "var(--text-dim)" : "var(--danger)",
                    cursor: busy || !hasChanges ? "default" : "pointer", fontSize: 10.5,
                    opacity: busy || !hasChanges ? 0.55 : 1,
                  }}
                >
                  {t("scm.discardAll")}
                </button>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={selectAll}
                  title={t("scm.selectAll")}
                  style={{
                    height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10.5,
                  }}
                >
                  {t("scm.selectAll")}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void toggleLog()}
              title={t("scm.history")}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                height: 22, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                background: showLog ? "var(--bg-selected)" : "var(--bg)",
                color: "var(--text-muted)", cursor: "pointer", fontSize: 10.5,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
              </svg>
              {t("scm.history")}
            </button>
          </div>
        )}
        {showLog && status?.isGitRepository && (
          <div style={{ borderBottom: "1px solid var(--border)", padding: "2px 4px 6px", flexShrink: 0 }}>
            {gitLog === null ? (
              <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("scm.loading")}</div>
            ) : gitLog.length === 0 ? (
              <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("scm.noCommits")}</div>
            ) : (
              gitLog.map((entry) => (
                <div key={entry.hash} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 8px", borderRadius: 4, fontSize: 11, minWidth: 0 }}>
                  <span style={{ flexShrink: 0, color: "var(--diff-rename)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{entry.shortHash}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{entry.subject}</span>
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{formatRelativeTime(entry.date)}</span>
                </div>
              ))
            )}
          </div>
        )}
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("scm.loading")}</div>
        ) : error ? (
          <div style={{ padding: 12, fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}>{error}</div>
        ) : !cwd ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6 }}>
            {t("scm.selectProject")}
          </div>
        ) : !status?.isGitRepository ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6 }}>
            {t("scm.notRepo")}
          </div>
        ) : !hasChanges ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: "0 auto 6px", display: "block" }}>
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            {t("scm.noChanges")}
          </div>
        ) : (
          <>
            <FileGroup
              title={t("scm.staged")}
              files={groups.staged}
              root={root}
              staged
              actions={{ onStage: handleStage, onUnstage: handleUnstage, onDiscard: handleDiscard, onOpenFile: handleOpenFile }}
              t={t}
              selected={selected}
              onToggleSelect={toggleSelect}
              onStageAllFiles={() => void stageAllInGroup(groups.staged)}
              onUnstageAllFiles={() => void unstageAllInGroup(groups.staged)}
            />
            <FileGroup
              title={t("scm.unstaged")}
              files={groups.unstaged}
              root={root}
              staged={false}
              actions={{ onStage: handleStage, onUnstage: handleUnstage, onDiscard: handleDiscard, onOpenFile: handleOpenFile }}
              t={t}
              selected={selected}
              onToggleSelect={toggleSelect}
              onStageAllFiles={() => void stageAllInGroup(groups.unstaged)}
              onUnstageAllFiles={() => void unstageAllInGroup(groups.unstaged)}
            />
            <FileGroup
              title={t("scm.untracked")}
              files={groups.untracked}
              root={root}
              staged={false}
              actions={{ onStage: handleStage, onUnstage: handleUnstage, onDiscard: handleDiscard, onOpenFile: handleOpenFile }}
              t={t}
              selected={selected}
              onToggleSelect={toggleSelect}
              onStageAllFiles={() => void stageAllInGroup(groups.untracked)}
              onUnstageAllFiles={() => void unstageAllInGroup(groups.untracked)}
            />
          </>
        )}
      </div>

      {/* Commit box */}
      {status?.isGitRepository && cwd && (
        <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) void handleCommit(false);
            }}
            placeholder={t("scm.commitPlaceholder")}
            rows={2}
            style={{
              width: "100%", resize: "none", padding: "6px 8px",
              border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg)", color: "var(--text)", fontSize: 12,
              outline: "none", lineHeight: 1.4, fontFamily: "inherit",
            }}
          />
          <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
            <button
              type="button"
              onClick={() => void handleCommit(false)}
              disabled={!canCommit}
              style={{
                flex: 1, height: 26, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                background: canCommit ? "var(--accent)" : "var(--bg-panel)",
                color: canCommit ? "var(--on-accent)" : "var(--text-dim)",
                cursor: canCommit ? "pointer" : "default", fontSize: 11, fontWeight: 600,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? t("scm.committing") : t("scm.commit")}
            </button>
            <button
              type="button"
              onClick={() => void handleCommit(true)}
              disabled={!canCommit}
              title={t("scm.commitAndPushTitle")}
              style={{
                flex: 1, height: 26, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 5,
                background: canCommit ? "var(--bg)" : "var(--bg-panel)",
                color: canCommit ? "var(--text)" : "var(--text-dim)",
                cursor: canCommit ? "pointer" : "default", fontSize: 11, fontWeight: 600,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? t("scm.committing") : t("scm.commitAndPush")}
            </button>
          </div>
          {groups.staged.length === 0 && hasChanges && !busy && (
            <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>{t("scm.stageAllAndCommitHint")}</div>
          )}
          {feedback && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--success)", display: "flex", alignItems: "center", gap: 4 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {feedback}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
