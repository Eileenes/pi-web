#!/usr/bin/env node
/**
 * 桌面版打包脚本（macOS 首发）。
 *
 * 流程：
 *   1. 检查环境（dev server 未占用 30141、平台支持）
 *   2. next build（生产构建）
 *   3. 打包 pi-web 运行目录 → src-tauri/resources/pi-web（.next/public/bin/package.json
 *      + 产线依赖 node_modules）
 *   4. 下载 Node 22 LTS 运行时 → src-tauri/binaries/node-<target-triple>
 *   5. tauri build（产出 .app / .dmg）
 *
 * 用法：npm run desktop:build
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, chmodSync, readdirSync, statSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_TAURI = path.join(ROOT, "src-tauri");
const RESOURCES_PIWEB = path.join(SRC_TAURI, "resources", "pi-web");
// node 运行时作为普通资源打包（放 Contents/Resources/，避免 Dock 出现多余图标）
const BINARIES_DIR = path.join(SRC_TAURI, "resources", "bin");

const NODE_VERSION = "v22.20.0";
const NODE_DIST = process.env.PIWEB_NODE_MIRROR
  ?? "https://cdn.npmmirror.com/binaries/node"; // 国内镜像，失败时回退 nodejs.org

const PLATFORM = process.platform;
if (PLATFORM !== "darwin" && PLATFORM !== "win32" && PLATFORM !== "linux") {
  console.error(`Unsupported platform: ${PLATFORM}`);
  process.exit(1);
}

function targetTriple() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch) {
    console.error(`Unsupported arch: ${process.arch}`);
    process.exit(1);
  }
  const os = PLATFORM === "darwin" ? "apple-darwin" : PLATFORM === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu";
  return `${arch}-${os}`;
}

function log(step) {
  console.log(`\n=== ${step} ===`);
}

function checkDevServer() {
  try {
    const res = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", "http://127.0.0.1:30141/"]);
    if (res.stdout?.toString().trim() === "200") {
      console.error(
        "\n[!] Dev server is running on port 30141.\n" +
        "    Stop it first (it shares .next/ with the production build):\n" +
        "    e.g. pkill -f 'next dev'   (or Ctrl+C in the dev terminal)\n",
      );
      process.exit(1);
    }
  } catch { /* curl unavailable — proceed */ }
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

async function downloadNodeRuntime() {
  const triple = targetTriple();
  const suffix = PLATFORM === "darwin" ? "darwin" : PLATFORM === "win32" ? "win-x64" : "linux-x64";
  const fileName = `node-${NODE_VERSION}-${suffix}-${PLATFORM === "darwin" ? (process.arch === "arm64" ? "arm64" : "x64") : "x64"}.tar.gz`;
  const url = `${NODE_DIST}/${NODE_VERSION}/${fileName}`;
  const cacheDir = path.join(tmpdir(), "piweb-node-cache");
  const tarball = path.join(cacheDir, fileName);
  mkdirSync(cacheDir, { recursive: true });

  if (!existsSync(tarball)) {
    log(`Downloading Node ${NODE_VERSION} (${fileName})`);
    try {
      await download(url, tarball);
    } catch (err) {
      const fallback = `https://nodejs.org/dist/${NODE_VERSION}/${fileName}`;
      console.warn(`Mirror failed (${err.message}), falling back to nodejs.org`);
      await download(fallback, tarball);
    }
  } else {
    log(`Using cached Node runtime: ${tarball}`);
  }

  const extractDir = path.join(cacheDir, `${fileName}-extracted`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", extractDir, "--strip-components=1"]);

  mkdirSync(BINARIES_DIR, { recursive: true });
  const nodeBin = path.join(extractDir, "bin", "node");
  // 放到 resources/ 下（作为普通资源随 bundle 打包）。不能放 externalBin
  // （会进 Contents/MacOS/，被 LaunchServices 识别成独立应用，在 Dock 显示多余图标）。
  const dest = path.join(BINARIES_DIR, "node");
  copyFileSync(nodeBin, dest);
  chmodSync(dest, 0o755);
  log(`Node runtime → ${dest}`);
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

/**
 * 递归查找 Next standalone 输出的 server.js（standalone 根目录会随
 * outputFileTracingRoot 变化）。优先匹配当前层的 server.js，
 * 避免先钻进 node_modules 深处匹配到无关的 server.js。
 */
function findStandaloneServer(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // 第一遍：只匹配当前目录的 server.js
  for (const entry of entries) {
    if (entry === "server.js") return path.join(dir, entry);
  }
  // 第二遍：递归子目录
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const found = findStandaloneServer(full);
      if (found) return found;
    }
  }
  return null;
}

async function packPiWeb() {
  log("Packing pi-web runtime directory");
  rmSync(RESOURCES_PIWEB, { recursive: true, force: true });
  mkdirSync(RESOURCES_PIWEB, { recursive: true });

  // Next standalone 输出：server.js + 按引用裁剪的 node_modules（省掉 600MB+ 全量依赖）
  const serverJs = findStandaloneServer(path.join(ROOT, ".next", "standalone"));
  if (!serverJs) {
    console.error("standalone server.js not found — did the build run with NEXT_OUTPUT=standalone?");
    process.exit(1);
  }
  const standaloneRoot = path.dirname(serverJs);
  log(`Standalone server: ${serverJs}`);

  for (const entry of readdirSync(standaloneRoot)) {
    execSync(`cp -R "${path.join(standaloneRoot, entry)}" "${RESOURCES_PIWEB}"`, { stdio: "inherit" });
  }

  // standalone 模式下 .next/static 需要手动复制（server.js 只带运行时目录）
  const staticSrc = path.join(ROOT, ".next", "static");
  if (existsSync(staticSrc)) {
    mkdirSync(path.join(RESOURCES_PIWEB, ".next"), { recursive: true });
    execSync(`cp -R "${staticSrc}" "${path.join(RESOURCES_PIWEB, ".next")}"`, { stdio: "inherit" });
  }

  // public 静态资源
  if (existsSync(path.join(ROOT, "public"))) {
    execSync(`cp -R "${path.join(ROOT, "public")}" "${RESOURCES_PIWEB}"`, { stdio: "inherit" });
  }

  const size = execSync(`du -sh "${RESOURCES_PIWEB}"`, { encoding: "utf8" }).trim().split("\t")[0];
  log(`pi-web runtime packed (${size})`);
}

async function main() {
  checkDevServer();

  log("1/4 Next.js production build (standalone)");
  run("npm", ["run", "build"], { env: { ...process.env, NEXT_OUTPUT: "standalone" } });

  await packPiWeb();
  await downloadNodeRuntime();

  log("4/4 Tauri build");
  run("npx", ["tauri", "build"], { cwd: SRC_TAURI });

  console.log("\n✅ Build complete. Artifacts in src-tauri/target/release/bundle/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
