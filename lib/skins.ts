/**
 * 皮肤（主题）注册表。
 *
 * 每款皮肤定义一套 CSS 变量的亮/暗两套取值。应用方式：
 *   - `data-skin="<id>"` 挂在 <html> 上（供 CSS 钩子/未来扩展）
 *   - `dark` class 控制亮暗
 *   - 变量通过 inline style 注入（优先级高于 globals.css 的 :root 兜底值）
 *
 * globals.css 中的 :root / html.dark 保留为 classic 兜底，无 JS 时也能正常显示。
 */

export type SkinVarKey =
  | "--bg"
  | "--bg-panel"
  | "--bg-hover"
  | "--bg-selected"
  | "--border"
  | "--text"
  | "--text-muted"
  | "--text-dim"
  | "--accent"
  | "--accent-hover"
  | "--user-bg"
  | "--assistant-bg"
  | "--tool-bg"
  | "--bg-subtle"
  // 语义色（状态/差异/强调上的文字色）
  | "--success"
  | "--danger"
  | "--warning"
  | "--info"
  | "--diff-add"
  | "--diff-del"
  | "--diff-mod"
  | "--diff-rename"
  | "--on-accent";

export type SkinVars = Partial<Record<SkinVarKey, string>>;

export interface Skin {
  id: string;
  /** 色板圆点，用于选择卡片上的迷你预览 */
  preview: { light: string[]; dark: string[] };
  colors: { light: SkinVars; dark: SkinVars };
}

export const CLASSIC_SKIN_ID = "classic";

/** classic = 现有默认配色，取值与 globals.css 的 :root / html.dark 完全一致。 */
export const SKINS: Skin[] = [
  {
    id: CLASSIC_SKIN_ID,
    preview: {
      light: ["#ffffff", "#f5f5f5", "#e0e0e0", "#2563eb", "#1a1a1a"],
      dark: ["#1a1a1a", "#242424", "#3a3a3a", "#60a5fa", "#e8e8e8"],
    },
    colors: {
      light: {
        "--bg": "#ffffff",
        "--bg-panel": "#f5f5f5",
        "--bg-hover": "#eeeeee",
        "--bg-selected": "#e8e8e8",
        "--border": "#e0e0e0",
        "--text": "#1a1a1a",
        "--text-muted": "#6b7280",
        "--text-dim": "#9ca3af",
        "--accent": "#2563eb",
        "--accent-hover": "#1d4ed8",
        "--user-bg": "#eff6ff",
        "--assistant-bg": "#ffffff",
        "--tool-bg": "#f9fafb",
        "--bg-subtle": "rgba(0,0,0,0.03)",
        "--success": "#16a34a",
        "--danger": "#dc2626",
        "--warning": "#d97706",
        "--info": "#2563eb",
        "--diff-add": "#4ade80",
        "--diff-del": "#f87171",
        "--diff-mod": "#d6a84b",
        "--diff-rename": "#60a5fa",
        "--on-accent": "#ffffff",
      },
      dark: {
        "--bg": "#1a1a1a",
        "--bg-panel": "#242424",
        "--bg-hover": "#2e2e2e",
        "--bg-selected": "#383838",
        "--border": "#3a3a3a",
        "--text": "#e8e8e8",
        "--text-muted": "#9ca3af",
        "--text-dim": "#6b7280",
        "--accent": "#60a5fa",
        "--accent-hover": "#93c5fd",
        "--user-bg": "#1e293b",
        "--assistant-bg": "#1a1a1a",
        "--tool-bg": "#1f2937",
        "--bg-subtle": "rgba(255,255,255,0.04)",
        "--success": "#4ade80",
        "--danger": "#f87171",
        "--warning": "#fbbf24",
        "--info": "#60a5fa",
        "--diff-add": "#4ade80",
        "--diff-del": "#f87171",
        "--diff-mod": "#d6a84b",
        "--diff-rename": "#60a5fa",
        "--on-accent": "#0b1220",
      },
    },
  },
  {
    id: "claude",
    preview: {
      light: ["#FAF9F5", "#F2F0EA", "#D8D4C9", "#D97757", "#3D3929"],
      dark: ["#262624", "#2E2E2C", "#3E3E3A", "#DF8E66", "#F0EEE6"],
    },
    colors: {
      light: {
        "--bg": "#FAF9F5",
        "--bg-panel": "#F2F0EA",
        "--bg-hover": "#EAE7DF",
        "--bg-selected": "#E0DCD1",
        "--border": "#D8D4C9",
        "--text": "#3D3929",
        "--text-muted": "#6E6759",
        "--text-dim": "#9C9484",
        "--accent": "#D97757",
        "--accent-hover": "#C15F3C",
        "--user-bg": "#F5E9E0",
        "--assistant-bg": "#FAF9F5",
        "--tool-bg": "#F2F0EA",
        "--bg-subtle": "rgba(61,57,41,0.04)",
        "--success": "#4E8C5A",
        "--danger": "#C25E41",
        "--warning": "#C98A2D",
        "--info": "#D97757",
        "--diff-add": "#5A9E6F",
        "--diff-del": "#D47A6A",
        "--diff-mod": "#C98A2D",
        "--diff-rename": "#8A6FB0",
        "--on-accent": "#FFFFFF",
      },
      dark: {
        "--bg": "#262624",
        "--bg-panel": "#2E2E2C",
        "--bg-hover": "#383835",
        "--bg-selected": "#43433F",
        "--border": "#3E3E3A",
        "--text": "#F0EEE6",
        "--text-muted": "#A8A294",
        "--text-dim": "#7A7468",
        "--accent": "#DF8E66",
        "--accent-hover": "#EDAB87",
        "--user-bg": "#38332C",
        "--assistant-bg": "#262624",
        "--tool-bg": "#2B2B28",
        "--bg-subtle": "rgba(240,238,230,0.05)",
        "--success": "#8BBF96",
        "--danger": "#E08B7B",
        "--warning": "#E0B45C",
        "--info": "#DF8E66",
        "--diff-add": "#8BBF96",
        "--diff-del": "#E08B7B",
        "--diff-mod": "#D9B36C",
        "--diff-rename": "#C8A0DE",
        "--on-accent": "#2A2118",
      },
    },
  },
  {
    id: "green",
    preview: {
      light: ["#F7FAF7", "#EDF3EC", "#CBD9C8", "#2F9E44", "#1F2B1F"],
      dark: ["#16211A", "#1D2A21", "#2B3A2F", "#4ADE80", "#E3EFE2"],
    },
    colors: {
      light: {
        "--bg": "#F7FAF7",
        "--bg-panel": "#EDF3EC",
        "--bg-hover": "#E2EBE1",
        "--bg-selected": "#D6E3D4",
        "--border": "#CBD9C8",
        "--text": "#1F2B1F",
        "--text-muted": "#5C6B5C",
        "--text-dim": "#8FA08C",
        "--accent": "#2F9E44",
        "--accent-hover": "#238636",
        "--user-bg": "#E4F4E0",
        "--assistant-bg": "#F7FAF7",
        "--tool-bg": "#EDF3EC",
        "--bg-subtle": "rgba(31,43,31,0.04)",
        "--success": "#2E9E44",
        "--danger": "#C4453C",
        "--warning": "#C98A2D",
        "--info": "#1E8E3E",
        "--diff-add": "#2E9E44",
        "--diff-del": "#C4453C",
        "--diff-mod": "#C98A2D",
        "--diff-rename": "#3B82A0",
        "--on-accent": "#FFFFFF",
      },
      dark: {
        "--bg": "#16211A",
        "--bg-panel": "#1D2A21",
        "--bg-hover": "#24342A",
        "--bg-selected": "#2D4234",
        "--border": "#2B3A2F",
        "--text": "#E3EFE2",
        "--text-muted": "#9DB39A",
        "--text-dim": "#6E846C",
        "--accent": "#4ADE80",
        "--accent-hover": "#67E08E",
        "--user-bg": "#1F3326",
        "--assistant-bg": "#16211A",
        "--tool-bg": "#1A271E",
        "--bg-subtle": "rgba(227,239,226,0.05)",
        "--success": "#4ADE80",
        "--danger": "#E07A6E",
        "--warning": "#E0C060",
        "--info": "#55C07E",
        "--diff-add": "#4ADE80",
        "--diff-del": "#E07A6E",
        "--diff-mod": "#E0C060",
        "--diff-rename": "#66B8D9",
        "--on-accent": "#0E1A12",
      },
    },
  },
  {
    id: "voyage",
    preview: {
      light: ["#F5F9FD", "#E8F0F8", "#C3D5E3", "#B8860B", "#17324A"],
      dark: ["#0A1929", "#0F2238", "#274466", "#F4BD55", "#EAF6FF"],
    },
    colors: {
      light: {
        "--bg": "#F5F9FD",
        "--bg-panel": "#E8F0F8",
        "--bg-hover": "#DCE8F2",
        "--bg-selected": "#CFDFEC",
        "--border": "#C3D5E3",
        "--text": "#17324A",
        "--text-muted": "#5B7A94",
        "--text-dim": "#8AA6BD",
        "--accent": "#B8860B",
        "--accent-hover": "#9A7209",
        "--user-bg": "#E8F0FB",
        "--assistant-bg": "#F5F9FD",
        "--tool-bg": "#EDF4FA",
        "--bg-subtle": "rgba(23,50,74,0.04)",
        "--success": "#16A34A",
        "--danger": "#DC2626",
        "--warning": "#B45309",
        "--info": "#2563EB",
        "--diff-add": "#22C55E",
        "--diff-del": "#EF4444",
        "--diff-mod": "#D97706",
        "--diff-rename": "#3B82F6",
        "--on-accent": "#FFFFFF",
      },
      dark: {
        "--bg": "#0A1929",
        "--bg-panel": "#0F2238",
        "--bg-hover": "#142B45",
        "--bg-selected": "#1A3452",
        "--border": "#274466",
        "--text": "#EAF6FF",
        "--text-muted": "#9DB9D6",
        "--text-dim": "#6D8BAB",
        "--accent": "#F4BD55",
        "--accent-hover": "#F7CD7A",
        "--user-bg": "#16304D",
        "--assistant-bg": "#0A1929",
        "--tool-bg": "#0E2136",
        "--bg-subtle": "rgba(234,246,255,0.05)",
        "--success": "#4ADE80",
        "--danger": "#F87171",
        "--warning": "#FBBF24",
        "--info": "#7DD3FC",
        "--diff-add": "#4ADE80",
        "--diff-del": "#F87171",
        "--diff-mod": "#F4BD55",
        "--diff-rename": "#93C5FD",
        "--on-accent": "#0A1929",
      },
    },
  },
  {
    id: "myth",
    preview: {
      light: ["#F7F2EA", "#EFE7DA", "#D2C2A8", "#A8622F", "#3B2E21"],
      dark: ["#100D0B", "#1A1512", "#46332A", "#D08142", "#EFE2D3"],
    },
    colors: {
      light: {
        "--bg": "#F7F2EA",
        "--bg-panel": "#EFE7DA",
        "--bg-hover": "#E7DCCB",
        "--bg-selected": "#DDCEB8",
        "--border": "#D2C2A8",
        "--text": "#3B2E21",
        "--text-muted": "#7A6A55",
        "--text-dim": "#A5917A",
        "--accent": "#A8622F",
        "--accent-hover": "#8F5227",
        "--user-bg": "#F3E6D6",
        "--assistant-bg": "#F7F2EA",
        "--tool-bg": "#F0E8DC",
        "--bg-subtle": "rgba(59,46,33,0.04)",
        "--success": "#2E7D4F",
        "--danger": "#B3472F",
        "--warning": "#9A6B1F",
        "--info": "#A8622F",
        "--diff-add": "#3F9458",
        "--diff-del": "#C05A42",
        "--diff-mod": "#B8862F",
        "--diff-rename": "#7A5FB5",
        "--on-accent": "#FFFFFF",
      },
      dark: {
        "--bg": "#100D0B",
        "--bg-panel": "#1A1512",
        "--bg-hover": "#241C17",
        "--bg-selected": "#2E241D",
        "--border": "#46332A",
        "--text": "#EFE2D3",
        "--text-muted": "#C7AA90",
        "--text-dim": "#8F735C",
        "--accent": "#D08142",
        "--accent-hover": "#DD9660",
        "--user-bg": "#2B1F18",
        "--assistant-bg": "#100D0B",
        "--tool-bg": "#171210",
        "--bg-subtle": "rgba(239,226,211,0.05)",
        "--success": "#8BBF96",
        "--danger": "#E08B7B",
        "--warning": "#E0B45C",
        "--info": "#D08142",
        "--diff-add": "#8BBF96",
        "--diff-del": "#E08B7B",
        "--diff-mod": "#D9B36C",
        "--diff-rename": "#C8A0DE",
        "--on-accent": "#20140E",
      },
    },
  },
  {
    id: "wanxiang",
    preview: {
      light: ["#F2FAFF", "#E4F2FC", "#B3D5EC", "#2F88CF", "#0F3D5F"],
      dark: ["#0C1D2E", "#12283D", "#2C4C6B", "#5AA8E8", "#E4F3FF"],
    },
    colors: {
      light: {
        "--bg": "#F2FAFF",
        "--bg-panel": "#E4F2FC",
        "--bg-hover": "#D6EAF8",
        "--bg-selected": "#C4E0F3",
        "--border": "#B3D5EC",
        "--text": "#0F3D5F",
        "--text-muted": "#4F7A9C",
        "--text-dim": "#82A9C4",
        "--accent": "#2F88CF",
        "--accent-hover": "#1E74B8",
        "--user-bg": "#DCF0FE",
        "--assistant-bg": "#F2FAFF",
        "--tool-bg": "#E9F5FD",
        "--bg-subtle": "rgba(15,61,95,0.04)",
        "--success": "#16A34A",
        "--danger": "#DC2626",
        "--warning": "#D97706",
        "--info": "#2F88CF",
        "--diff-add": "#22C55E",
        "--diff-del": "#EF4444",
        "--diff-mod": "#D97706",
        "--diff-rename": "#6366F1",
        "--on-accent": "#FFFFFF",
      },
      dark: {
        "--bg": "#0C1D2E",
        "--bg-panel": "#12283D",
        "--bg-hover": "#19324B",
        "--bg-selected": "#213E5C",
        "--border": "#2C4C6B",
        "--text": "#E4F3FF",
        "--text-muted": "#9CC3E0",
        "--text-dim": "#6D96B8",
        "--accent": "#5AA8E8",
        "--accent-hover": "#7DBCF0",
        "--user-bg": "#16334E",
        "--assistant-bg": "#0C1D2E",
        "--tool-bg": "#10253A",
        "--bg-subtle": "rgba(228,243,255,0.05)",
        "--success": "#4ADE80",
        "--danger": "#F87171",
        "--warning": "#FBBF24",
        "--info": "#5AA8E8",
        "--diff-add": "#4ADE80",
        "--diff-del": "#F87171",
        "--diff-mod": "#E8C468",
        "--diff-rename": "#93C5FD",
        "--on-accent": "#081A29",
      },
    },
  },
];

const SKIN_MAP = new Map(SKINS.map((skin) => [skin.id, skin]));

export function getSkin(id: string | null | undefined): Skin {
  return (id && SKIN_MAP.get(id)) || SKINS[0];
}

export function isKnownSkin(id: string | null | undefined): boolean {
  return Boolean(id && SKIN_MAP.has(id));
}

/** 把皮肤变量注入到元素上（inline style 优先级最高，可压过 :root 兜底）。 */
export function applySkinVars(el: HTMLElement, skin: Skin, isDark: boolean): void {
  const vars = isDark ? skin.colors.dark : skin.colors.light;
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) el.style.setProperty(key, value);
  }
}

/**
 * 生成 <head> 内联脚本：在首帧绘制前恢复持久化的皮肤/亮暗，
 * 避免刷新闪烁。layout.tsx（RSC）直接 import 本函数输出字符串。
 */
export function getSkinBootstrapScript(): string {
  const payload = SKINS.map((skin) => ({
    id: skin.id,
    light: skin.colors.light,
    dark: skin.colors.dark,
  }));
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `(function(){try{var t=localStorage.getItem("pi-theme");var dark=t==="dark";if(dark)document.documentElement.classList.add("dark");var s=localStorage.getItem("pi-skin")||"classic";var skins=${json};var skin=null;for(var i=0;i<skins.length;i++){if(skins[i].id===s){skin=skins[i];break}}if(!skin)skin=skins[0];var vars=dark?skin.dark:skin.light;var st=document.documentElement.style;for(var k in vars){if(Object.prototype.hasOwnProperty.call(vars,k)&&vars[k]!==undefined){st.setProperty(k,vars[k])}}document.documentElement.setAttribute("data-skin",skin.id)}catch(e){}})();`;
}
