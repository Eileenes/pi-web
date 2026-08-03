# Pi Web

[English](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的本地网页界面。它会读取本机的 pi 会话文件，在浏览器里提供会话管理、实时对话、模型配置、技能管理和项目文件预览。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。可通过 `node --version` 检查当前版本。

**无需安装，直接运行：**

```bash
npx @agegr/pi-web@latest
```

**或全局安装后使用：**

```bash
npm install -g @agegr/pi-web
pi-web
```

启动后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。命令行版本会在服务就绪后尝试自动打开浏览器。Pi Web 默认仅监听 `127.0.0.1`。

**可选参数：**

```bash
pi-web --port 8080              # 自定义端口
pi-web --hostname 0.0.0.0       # 在可信网络中开放访问
pi-web -p 8080 -H 0.0.0.0       # 组合使用
pi-web --no-open                # 不自动打开浏览器

PORT=8080 pi-web                # 也支持环境变量
PI_WEB_HOSTNAME=0.0.0.0 pi-web  # 显式开放网络访问
PI_WEB_ALLOWED_HOSTS=pi-web.internal pi-web  # 允许指定的代理或自定义主机名
PI_WEB_PASSWORD='足够长的随机密码' pi-web  # 启用 Basic Auth（用户名固定为 pi）
PI_WEB_NO_OPEN=1 pi-web         # 适用于后台服务或开机自启
```

设置 `PI_WEB_PASSWORD` 后，网页和所有 API 端点都会启用 HTTP Basic Auth，用户名固定为 `pi`。未设置或设置为空值时不启用认证。

Pi Web 可以调用高权限智能体。Basic Auth 不会加密传输中的密码，因此不要把明文 HTTP 暴露到互联网。远程访问时应使用可信反向代理提供 HTTPS，或通过可信 VPN 访问。
API 请求仅接受 loopback 名称、IP 字面量、当前监听主机名，以及 `PI_WEB_ALLOWED_HOSTS` 中以逗号分隔的精确主机名。可信反向代理使用不同的外部主机名时，请配置该变量。

## HTTP 代理

Pi Web 的服务端模型请求和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 功能介绍

- **把历史工作接回来**：打开网页就能按项目找到以前的 pi 对话，不必在终端里翻文件或记住会话路径。
- **放心试不同方向**：可以从某条历史消息重新开始，也可以复制出一条独立的新路线，探索方案时不怕弄乱原来的对话。
- **跨分支工作**：在侧边栏切换 Git worktree，让新会话和 Explorer 跟随你选择的 checkout。
- **边聊边看项目文件**：左侧浏览项目文件，右侧打开源码、文档、图片、音频和 PDF；文件变化会自动刷新，适合边让 agent 改边检查结果。
- **随时掌握会话状态**：在顶部就能看到上下文占用、花费、压缩结果和系统提示，长会话不再像黑箱。
- **少离开当前界面**：模型、登录/API key、模型测试和技能开关都能在网页里处理，配置 agent 时不用在多个工具之间来回切换。

## 注意事项

- **数据目录**：默认读取 `~/.pi/agent/sessions` 下的会话文件。可通过环境变量 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **会话文件**：路径形如 `~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。
- **模型配置**：Models 面板读写 pi agent 目录下的 `models.json`，模型列表和默认模型由 pi 的配置解析得到。
- **文件访问**：文件浏览和预览面向当前选择的项目目录，以及会话中已出现过的工作目录。
- **Git worktree**：什么时候显示切换器、新建目录在哪里、删除会影响什么，见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。
- **Fork 与会话内分支不同**：Fork 会创建新的 `.jsonl` 文件；“Edit from here” 是同一会话文件里的分支。

## 桌面应用（Tauri）

Pi Web 同时提供基于 [Tauri](https://v2.tauri.app/) 的原生桌面壳（`src-tauri/`）。壳会用内置的 Node.js 22 运行时（无需系统安装 Node）启动 pi-web 服务，并在原生窗口中渲染同一套界面，同时提供桌面端集成能力：

- **系统托盘**：显示/隐藏窗口、新建会话、退出（关闭窗口只会隐藏到托盘——从托盘菜单选择“退出”才会真正退出并停止服务）。
- **原生目录选择器**：目录选择器提供“系统”按钮，直接弹出操作系统文件夹选择框。
- **在 Finder/资源管理器中显示**：文件查看器工具栏可定位文件所在目录。
- **系统通知**：Agent 完成任务时弹出系统级通知。
- **外部链接走系统浏览器**：指向本机服务以外的 http(s) 链接会自动交给默认浏览器打开。
- **单实例与窗口记忆**：再次启动会聚焦已有窗口，窗口大小/位置会被记住。
- **官方 pi 图标**：应用图标为 [pi.dev](https://pi.dev) 的官方 logo。

其余一切——皮肤/主题、源代码管理（SCM）、模型配置、会话——与网页版完全一致。

### 环境要求

- Node.js 22.19.0+（构建时需要）
- Rust 工具链（`cargo`、`rustc` 1.77+）
- macOS：需要 Xcode Command Line Tools（`xcode-select --install`）用于编译
- 能访问 crates.io（国内网络建议配置 [Rust 镜像](https://rsproxy.cn/)）

### 开发模式

分两个终端运行 Next.js 开发服务器和桌面壳：

```bash
npm install
npm run dev          # 终端 1：Next.js 开发服务器，http://127.0.0.1:30141
npm run tauri dev    # 终端 2：桌面壳（加载上面的开发服务器）
```

### 打包可分发的应用（macOS）

```bash
npm run desktop:build
```

构建脚本（`scripts/desktop-build.mjs`）会自动完成：

1. `next build` — 前端生产构建
2. 把运行时（`public`、`bin`、产线依赖 `node_modules`）打包进 `src-tauri/resources/pi-web/`
3. 下载 Node 22 LTS 运行时，作为 Tauri 侧车进程放入 `src-tauri/binaries/node-<target-triple>`
4. 执行 `tauri build`

产物在 `src-tauri/target/release/bundle/` 下：`Pi Web.app` 与 `Pi Web.dmg`。应用完全自包含（内置 Node 运行时 + pi-web 服务）。构建前请确保 30141 端口没有被开发服务器占用。

### src-tauri 目录结构

```text
src-tauri/
  src/
    main.rs         # 入口
    lib.rs          # 应用初始化、插件、窗口事件、服务生命周期
    server.rs       # 端口探测 → 启动内置 Node → 健康检查 → 创建窗口
    tray.rs         # 系统托盘菜单（显示/隐藏、新建会话、退出）
    commands.rs     # Tauri 命令：select_directory、reveal_in_finder、notify
  tauri.conf.json   # 窗口、打包、externalBin（node 侧车）、资源
  icons/            # 应用图标（由官方 pi logo 生成）
  binaries/         # 内置 Node 运行时（gitignored，desktop:build 生成）
  resources/pi-web/ # 打包后的 pi-web 运行时（gitignored，desktop:build 生成）
```

### 注意事项

- 关闭窗口只是隐藏到托盘，服务仍在后台运行；从托盘菜单选择“退出”才会退出并停止服务。
- 端口自动探测：默认 30141，被占用时自动改用空闲端口。
- `src-tauri/binaries/`、`src-tauri/resources/`、`src-tauri/target/` 均在 gitignore 中，由构建脚本生成。

## 开发

```bash
npm install
npm run dev
```

本地开发端口为 [http://127.0.0.1:30141](http://127.0.0.1:30141)。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发时不要运行 `next build` / `npm run build`，它会写入 `.next/`，容易影响正在运行的 dev server。发布流程再执行构建。

## 项目结构

```
app/
  api/
    agent/          # 创建/驱动 AgentSession，提供 SSE 事件流
    auth/           # OAuth 和 API key 管理
    cwd/browse/     # 服务端目录浏览
    cwd/validate/   # 自定义工作目录校验
    default-cwd/    # 获取 pi 默认工作目录
    files/          # 文件列表、读取、预览、watch
    home/           # 当前用户 home 目录
    models/         # 可用模型、默认模型、thinking levels
    models-config/  # 读写 models.json、测试模型
    sessions/       # 会话读取、重命名、删除、上下文、HTML 导出
    skills/         # skills 列表、搜索、安装、启停
components/
  AppShell.tsx        # 主布局、URL 状态、顶部面板、文件标签
  SessionSidebar.tsx  # 项目选择、会话树、Explorer
  DirectoryPicker.tsx # 支持浏览和路径输入的工作目录选择器
  ChatWindow.tsx      # 消息区、SSE、拖拽图片、minimap
  ChatInput.tsx       # 输入栏、模型/工具/thinking/compact/slash controls
  MessageView.tsx     # 消息、thinking、tool call/result 渲染
  ModelsConfig.tsx    # 模型和认证配置面板
  SkillsConfig.tsx    # 技能管理面板
  FileExplorer.tsx    # 文件树
  FileViewer.tsx      # 源码、diff、图片、音频、PDF、DOCX 预览
lib/
  directory-browser.ts # 目录规范化和安全枚举工具
  http-dispatcher.ts  # 服务端 fetch 的 HTTP(S) 代理配置
  rpc-manager.ts      # AgentSessionWrapper 生命周期和全局 registry
  session-reader.ts   # 解析 .jsonl 会话文件和分支上下文
  normalize.ts        # 规范化 toolCall 字段名
  file-access.ts      # 文件读取安全边界
  file-paths.ts       # 文件路径编码/相对路径工具
  markdown.ts         # Markdown/Mermaid/KaTeX 插件配置
  pi-types.ts         # pi 相关类型
hooks/
  useAgentSession.ts  # 会话加载、发送命令、SSE 状态机
  useAudio.ts         # 完成提示音
  useDragDrop.ts      # 图片拖拽
  useTheme.ts         # 主题切换
bin/
  pi-web.js           # npm CLI 入口
instrumentation.ts    # 初始化服务端 HTTP dispatcher
```
