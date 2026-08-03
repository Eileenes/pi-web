"use client";

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { parseAnsiLine } from "@/lib/ansi";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  initialCwd: string | null;
  onClose: () => void;
  /** 面板是否可见（打开时聚焦活动终端的输入框） */
  open?: boolean;
}

interface Line {
  type: "input" | "output";
  text: string;
}

/** 解析 cd 目标路径（支持 ~、绝对路径、相对路径），返回规范化绝对路径。 */
function resolveTargetPath(target: string, cwd: string, homeDir: string | null): string | null {
  let p = target;
  if (p === "~" || p.startsWith("~/")) {
    if (!homeDir) return null;
    p = homeDir + p.slice(1);
  } else if (p.startsWith("~")) {
    // ~user 形式暂不支持，避免被当作相对路径解析成 cwd/~user
    return null;
  }
  if (p.startsWith("/")) {
    const parts = p.split("/").filter(Boolean);
    return "/" + parts.join("/");
  }
  const parts = (cwd + "/" + p).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

/* ============================ 单个终端会话 ============================ */

/** 每个终端最多保留的输出行数（防误跑 yes 等打爆 DOM/内存） */
const MAX_LINES = 2000;

export interface TerminalSessionHandle {
  stop: () => void;
  clear: () => void;
  focus: () => void;
}

interface TerminalSessionProps {
  initialCwd: string | null;
  /** 运行状态变化（用于容器显示全局停止按钮） */
  onRunningChange: (running: boolean) => void;
  /** cwd 变化（用于新建终端时继承当前目录） */
  onCwdChange: (cwd: string) => void;
}

const TerminalSession = memo(forwardRef<TerminalSessionHandle, TerminalSessionProps>(function TerminalSession(
  { initialCwd, onRunningChange, onCwdChange },
  ref,
) {
  const { t } = useI18n();
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const historyIdxRef = useRef(-1);
  const [running, setRunning] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const homeDirRef = useRef<string | null>(null);
  const pendingRef = useRef("");
  const prevCwdRef = useRef<string | null>(null); // cd - 用的 OLDPWD
  const stickToBottomRef = useRef(true); // 用户向上翻看时不强制拉底

  // 回调引用稳定化：容器每次 render 会传入新函数，避免 effect 依赖变化导致空跑/死循环
  const onCwdChangeRef = useRef(onCwdChange);
  const onRunningChangeRef = useRef(onRunningChange);
  useEffect(() => {
    onCwdChangeRef.current = onCwdChange;
    onRunningChangeRef.current = onRunningChange;
  });

  // 通知容器 cwd/running 变化（新建终端继承目录、tab 红点/头部刷新）
  useEffect(() => {
    onCwdChangeRef.current(cwd);
  }, [cwd]);

  useEffect(() => {
    onRunningChangeRef.current(running);
  }, [running]);

  useImperativeHandle(ref, () => ({
    stop: () => abortRef.current?.abort(),
    clear: () => {
      setLines([]);
      pendingRef.current = "";
    },
    focus: () => inputRef.current?.focus(),
  }), []);

  // 预取 home 目录（cd ~ 用）
  useEffect(() => {
    fetch("/api/home")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        homeDirRef.current = typeof d?.home === "string" ? d.home : null;
      })
      .catch(() => {});
  }, []);

  // 新输出时自动滚到底部（仅当用户停留在底部时）
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, running]);

  const handleOutputScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  /** 追加行（带 MAX_LINES 上限，丢弃最早的行；单次追加超限也截断） */
  const appendLines = useCallback((...newLines: Line[]) => {
    setLines((prev) => {
      if (prev.length + newLines.length <= MAX_LINES) return [...prev, ...newLines];
      return [...prev, ...newLines].slice(-MAX_LINES);
    });
  }, []);

  const flushPending = useCallback(() => {
    if (pendingRef.current) {
      appendLines({ type: "output", text: pendingRef.current });
      pendingRef.current = "";
    }
  }, [appendLines]);

  const appendOutput = useCallback((text: string) => {
    pendingRef.current += text;
    const parts = pendingRef.current.split("\n");
    pendingRef.current = parts.pop() ?? "";
    if (parts.length > 0) {
      appendLines(...parts.map((p) => ({ type: "output" as const, text: p })));
    }
  }, [appendLines]);

  const clearTerminal = useCallback(() => {
    setLines([]);
    pendingRef.current = "";
  }, []);

  const stopCommand = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const execute = useCallback(async (raw: string) => {
    const command = raw.trim();
    if (!command) return;
    appendLines({ type: "input", text: `$ ${command}` });
    setInput("");
    setHistory((prev) => [...prev.slice(-99), command]);
    historyIdxRef.current = -1;

    // cd 命令在前端解析（保持 cwd 状态，供后续命令使用）
    const cdMatch = command.match(/^\s*cd(?:\s+(.+?))?\s*$/);
    if (cdMatch) {
      const raw = cdMatch[1]?.trim() ?? "~"; // 无参数 → home（与 bash 一致）
      // 去掉引号（'...' "..."）与反斜杠转义（\  → 空格），支持 cd "my dir" / cd ~/My\ Documents
      const target = raw
        .replace(/^'(.*)'$/, "$1")
        .replace(/^"(.*)"$/, "$1")
        .replace(/\\(["'\\ ])/g, "$1");
      if (target === "-") {
        // cd -：回到上一个目录（OLDPWD）
        const prev = prevCwdRef.current;
        if (prev && prev !== cwd) {
          prevCwdRef.current = cwd;
          setCwd(prev);
          appendLines({ type: "output", text: t("terminal.cdTo", { path: prev }) });
        } else {
          appendLines({ type: "output", text: t("terminal.cdOlderPwd") });
        }
        return;
      }
      const resolved = resolveTargetPath(target, cwd, homeDirRef.current);
      if (resolved) {
        prevCwdRef.current = cwd;
        setCwd(resolved);
        appendLines({ type: "output", text: t("terminal.cdTo", { path: resolved }) });
      } else {
        appendLines({ type: "output", text: t("terminal.cdFailed", { path: target }) });
      }
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, command }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        appendOutput(decoder.decode(value, { stream: true }));
      }
      appendOutput(decoder.decode());
      flushPending();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        pendingRef.current = "";
        appendLines({ type: "output", text: t("terminal.stopped") });
      } else {
        appendLines({ type: "output", text: `[error] ${e instanceof Error ? e.message : String(e)}` });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }, [cwd, appendOutput, appendLines, flushPending, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void execute(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      historyIdxRef.current = Math.min(historyIdxRef.current + 1, history.length - 1);
      if (historyIdxRef.current >= 0) setInput(history[history.length - 1 - historyIdxRef.current]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      historyIdxRef.current -= 1;
      if (historyIdxRef.current < 0) {
        historyIdxRef.current = -1;
        setInput("");
      } else {
        setInput(history[history.length - 1 - historyIdxRef.current]);
      }
    } else if (e.key === "c" && e.ctrlKey && running) {
      e.preventDefault();
      stopCommand();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clearTerminal();
    }
  }, [input, history, running, execute, stopCommand, clearTerminal]);

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
        background: "var(--bg)", borderTop: "1px solid var(--border)",
      }}
    >
      {/* 输出区 */}
      <div
        ref={scrollRef}
        onScroll={handleOutputScroll}
        style={{
          flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",
          padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5,
        }}
      >
        {lines.map((line, i) =>
          line.type === "input" ? (
            <div key={i} style={{ color: "var(--accent)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {line.text}
            </div>
          ) : (
            <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text)" }}>
              {line.text
                ? parseAnsiLine(line.text).map((seg, j) => (
                    <span key={j} style={seg.style}>{seg.text}</span>
                  ))
                : "\u00a0"}
            </div>
          ),
        )}
        {running && (
          <div style={{ color: "var(--text-dim)", display: "inline-block", animation: "blink 1s step-end infinite" }}>
            ▋
          </div>
        )}
      </div>

      {/* 输入行 */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 10px", borderTop: "1px solid var(--border)", flexShrink: 0,
        }}
      >
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12, flexShrink: 0 }}>
          {running ? "…" : "$"}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("terminal.placeholder")}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none",
            color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12,
          }}
        />
        <button
          type="button"
          onClick={() => void execute(input)}
          disabled={!input.trim() || running}
          style={{
            height: 22, padding: "0 10px", border: "none", borderRadius: 5,
            background: "var(--accent)", color: "var(--on-accent)",
            cursor: input.trim() && !running ? "pointer" : "default",
            fontSize: 10.5, fontWeight: 600, opacity: input.trim() && !running ? 1 : 0.5,
            flexShrink: 0,
          }}
        >
          {t("terminal.run")}
        </button>
      </div>
    </div>
  );
}));

/* ============================ 多终端容器 ============================ */

interface TerminalTabInfo {
  id: number;
  label: string;
}

export function TerminalPanel({ initialCwd, onClose, open = true }: Props) {
  const { t } = useI18n();
  const [tabs, setTabs] = useState<TerminalTabInfo[]>([{ id: 0, label: "1" }]);
  const [activeId, setActiveId] = useState(0);
  // 活动 tab 的运行状态（控制全局停止按钮显隐）
  const [running, setRunning] = useState(false);
  // 强制重渲染：runningRef/cwdRef 是 ref（不触发 render），红点/头部 cwd 依赖它刷新
  const [, setUiTick] = useState(0);
  const rerender = useCallback(() => setUiTick((v) => v + 1), []);

  const sessionRefs = useRef<Record<number, TerminalSessionHandle | null>>({});
  const runningRef = useRef<Record<number, boolean>>({});
  const cwdRef = useRef<Record<number, string>>({});
  const nextIdRef = useRef(1);
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  // 按 id 缓存的回调（map），保证传给子组件的函数引用稳定，memo 才能生效
  const runningHandlers = useRef(new Map<number, (r: boolean) => void>());
  const cwdHandlers = useRef(new Map<number, (cwd: string) => void>());
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // 面板从隐藏变为可见时聚焦活动 tab 输入框（组件始终挂载，autoFocus 只在首次生效）
  useEffect(() => {
    if (open) {
      const id = activeIdRef.current;
      requestAnimationFrame(() => sessionRefs.current[id]?.focus());
    }
  }, [open]);

  const activeCwd = cwdRef.current[activeId];

  const getRunningHandler = useCallback((id: number) => {
    let fn = runningHandlers.current.get(id);
    if (!fn) {
      fn = (r: boolean) => {
        runningRef.current[id] = r;
        if (activeIdRef.current === id) setRunning(r);
        rerender(); // 非活动 tab 的红点也需要刷新
      };
      runningHandlers.current.set(id, fn);
    }
    return fn;
  }, [rerender]);

  const getCwdHandler = useCallback((id: number) => {
    let fn = cwdHandlers.current.get(id);
    if (!fn) {
      fn = (cwd: string) => {
        cwdRef.current[id] = cwd;
        rerender(); // 头部 cwd / tab title 需要刷新
      };
      cwdHandlers.current.set(id, fn);
    }
    return fn;
  }, [rerender]);

  const addTab = useCallback(() => {
    const id = nextIdRef.current++;
    // label 取递增序号，避免连点重复（可能不连续，可接受）
    const label = String(id + 1);
    setTabs((prev) => [...prev, { id, label }]);
    setActiveId(id);
    setRunning(runningRef.current[id] ?? false);
    // 新 tab 继承当前活动 tab 的 cwd（fallback 面板初始 cwd）
    cwdRef.current[id] = activeCwd ?? initialCwd ?? "";
  }, [activeCwd, initialCwd]);

  const closeTab = useCallback((id: number) => {
    // 先终止可能运行中的命令
    sessionRefs.current[id]?.stop();
    delete sessionRefs.current[id];
    delete runningRef.current[id];
    delete cwdRef.current[id];
    runningHandlers.current.delete(id);
    cwdHandlers.current.delete(id);
    const prev = tabsRef.current;
    const idx = prev.findIndex((tab) => tab.id === id);
    const next = prev.filter((tab) => tab.id !== id);
    if (next.length === 0) {
      // 关闭最后一个 tab → 收起整个面板
      onClose();
      return;
    }
    setTabs(next);
    if (activeIdRef.current === id) {
      // 关闭的是活动 tab：切到相邻 tab
      const newActive = next[Math.max(0, idx - 1)];
      setActiveId(newActive.id);
      setRunning(runningRef.current[newActive.id] ?? false);
    }
    // 关闭非活动 tab：活动 tab 保持不变
  }, [onClose]);

  const switchTab = useCallback((id: number) => {
    setActiveId(id);
    setRunning(runningRef.current[id] ?? false);
    // 渲染后聚焦该终端的输入框
    requestAnimationFrame(() => sessionRefs.current[id]?.focus());
  }, []);

  // 稳定 ref 回调：避免每次 render 重新创建导致 React 先 null 再赋值
  const setSessionRef = useCallback((id: number) => (h: TerminalSessionHandle | null) => {
    sessionRefs.current[id] = h;
  }, []);

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
        background: "var(--bg)", borderTop: "1px solid var(--border)",
      }}
    >
      {/* 面板头部：tab 栏 + 操作按钮 */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "4px 6px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
          flexShrink: 0, minWidth: 0,
        }}
      >
        {/* Terminal 标题 */}
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", flexShrink: 0, padding: "0 4px" }}>
          {t("terminal.title")}
        </span>

        {/* Tab 列表 */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0, overflowX: "auto" }}>
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            const tabCwd = cwdRef.current[tab.id] ?? initialCwd ?? "";
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                aria-label={t("terminal.tabLabel", { n: tab.label })}
                tabIndex={0}
                onClick={() => switchTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    switchTab(tab.id);
                  }
                }}
                title={t("terminal.tabCwd", { cwd: tabCwd })}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  height: 24, padding: "0 4px 0 8px", borderRadius: 5,
                  background: active ? "var(--bg-selected)" : "transparent",
                  cursor: "pointer", flexShrink: 0, userSelect: "none",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={active ? "var(--text)" : "var(--text-muted)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <span style={{ fontSize: 10.5, fontWeight: active ? 650 : 500, color: active ? "var(--text)" : "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {tab.label}
                </span>
                {/* 运行指示点 */}
                {runningRef.current[tab.id] && (
                  <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--danger)", flexShrink: 0 }} />
                )}
                <button
                  type="button"
                  aria-label={t("terminal.closeTab")}
                  title={t("terminal.closeTab")}
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 16, height: 16, padding: 0, border: "none", borderRadius: 3,
                    background: "transparent", color: "var(--text-dim)", cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              </div>
            );
          })}

          {/* 新建终端 */}
          <button
            type="button"
            title={t("terminal.newTab")}
            aria-label={t("terminal.newTab")}
            onClick={addTab}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, padding: 0, border: "none", borderRadius: 4,
              background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          </button>
        </div>

        <span style={{ flexShrink: 0, width: 1, height: 16, background: "var(--border)", margin: "0 2px" }} />

        {/* 活动 tab 的运行状态 cwd 提示 */}
        <span
          title={activeCwd ?? ""}
          style={{
            minWidth: 0, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontSize: 10.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 1,
          }}
        >
          {activeCwd ?? ""}
        </span>

        {/* 全局操作按钮（作用于活动 tab） */}
        {running && (
          <button
            type="button"
            onClick={() => sessionRefs.current[activeId]?.stop()}
            title={t("terminal.stop")}
            style={{
              display: "flex", alignItems: "center", gap: 4, height: 22, padding: "0 8px",
              border: "1px solid var(--border)", borderRadius: 5,
              background: "color-mix(in srgb, var(--danger) 10%, var(--bg))",
              color: "var(--danger)", cursor: "pointer", fontSize: 10.5, flexShrink: 0,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            {t("terminal.stop")}
          </button>
        )}
        <button
          type="button"
          onClick={() => sessionRefs.current[activeId]?.clear()}
          title={t("terminal.clear")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t("terminal.close")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, padding: 0, border: "none", borderRadius: 4,
            background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </div>

      {/* 会话区：非活动 tab 用 display:none 保留状态 */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          style={{ display: tab.id === activeId ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
          <TerminalSession
            ref={setSessionRef(tab.id)}
            initialCwd={tab.id === 0 ? initialCwd : (cwdRef.current[tab.id] || initialCwd || null)}
            onRunningChange={getRunningHandler(tab.id)}
            onCwdChange={getCwdHandler(tab.id)}
          />
        </div>
      ))}
    </div>
  );
}
