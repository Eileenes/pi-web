use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::ServerState;

const DEFAULT_PORT: u16 = 30141;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// 服务日志超过该大小后下次启动截断，防止 /tmp 日志无限增长。
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// 当前 node 侧车 PID，供信号 handler 在进程被强杀时做进程组清理。
static NODE_PID: AtomicI32 = AtomicI32::new(0);

/// SIGTERM/SIGINT/SIGHUP 兜底：主进程被 kill 时按进程组清理 node 侧车。
/// libc::kill(2) 是 async-signal-safe 函数，可以直接在 handler 中调用；
/// 清理完后恢复默认处理并重发信号，让进程按系统默认方式终止。
#[cfg(unix)]
extern "C" fn handle_kill_signal(sig: libc::c_int) {
    let pid = NODE_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

/// 注册强杀兜底信号处理（dev 模式不 spawn node，NODE_PID 为 0，无副作用）。
pub fn install_signal_handlers() {
    #[cfg(unix)]
    unsafe {
        let handler = handle_kill_signal as *const () as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGHUP, handler);
    }
}

/// pi-web 运行目录（构建时由 scripts/desktop-build.mjs 拷入 resources/pi-web）。
/// Next standalone 运行时：server.js + .next + 裁剪后的 node_modules。
fn piweb_dir(app: &AppHandle) -> PathBuf {
    let res = app.path().resource_dir().expect("resource dir");
    let candidates = [
        res.join("pi-web"),
        res.join("resources").join("pi-web"),
    ];
    candidates
        .iter()
        .find(|p| p.join("server.js").exists())
        .cloned()
        .unwrap_or_else(|| res.join("pi-web"))
}

/// 打包进 bundle 的 node 运行时。作为普通资源打包（Contents/Resources/），
/// 而不是 externalBin（那会进 Contents/MacOS/，被 LaunchServices 识别成独立
/// 应用，在 Dock 显示多余的 node 图标）。
fn node_bin(app: &AppHandle) -> PathBuf {
    let res = app.path().resource_dir().expect("resource dir");
    let candidates = [
        res.join("resources").join("bin").join("node"),
        res.join("bin").join("node"),
        res.join("node"),
    ];
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| res.join("resources").join("bin").join("node"))
}

fn is_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_free_port() -> u16 {
    if is_port_free(DEFAULT_PORT) {
        return DEFAULT_PORT;
    }
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(DEFAULT_PORT)
}

/// 极简 HTTP GET，检查服务是否返回 200（避免引入 reqwest 依赖）。
fn http_get_ok(port: u16, path: &str) -> bool {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
        let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        if stream.write_all(req.as_bytes()).is_ok() {
            let mut buf = [0u8; 2048];
            if let Ok(n) = stream.read(&mut buf) {
                let text = String::from_utf8_lossy(&buf[..n]);
                return text.starts_with("HTTP/1.1 200") || text.contains(" 200 ");
            }
        }
    }
    false
}

fn wait_ready(port: u16) -> bool {
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if http_get_ok(port, "/api/agent/running") {
            return true;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    false
}

/// 启动 pi-web 服务（生产模式 spawn node 侧车；dev 模式直接用 devUrl）。
/// 返回窗口要加载的 URL。
pub fn start(app: &AppHandle) -> Result<String, String> {
    if tauri::is_dev() {
        return Ok("http://127.0.0.1:30141".to_string());
    }

    let piweb = piweb_dir(app);
    let node = node_bin(app);
    if !piweb.join("server.js").exists() {
        return Err(format!(
            "pi-web standalone build not found at {}. Run the desktop build script first.",
            piweb.display()
        ));
    }
    if !node.exists() {
        return Err(format!(
            "node runtime not found at {}. Run the desktop build script first.",
            node.display()
        ));
    }

    let port = find_free_port();
    let mut cmd = Command::new(&node);
    cmd.args(["server.js"])
        .current_dir(&piweb)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1");
    // 把 node 服务的输出落到日志文件，便于排查启动问题；日志过大时截断重写
    let log_path = "/tmp/piweb-desktop-server.log";
    if let Ok(meta) = std::fs::metadata(log_path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(log_path);
        }
    }
    if let Ok(log_file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let out = log_file.try_clone().unwrap_or(log_file);
        cmd.stdout(Stdio::from(out));
        if let Ok(err_file) = OpenOptions::new().create(true).append(true).open(log_path) {
            cmd.stderr(Stdio::from(err_file));
        } else {
            cmd.stderr(Stdio::null());
        }
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }
    // Unix：让 node 成为新会话首领（setsid），这样 next 子进程在同一进程组，
    // 退出时按进程组 kill，避免 next 变孤儿继续占用端口。
    #[cfg(unix)]
    {
        // 让 node 成为新会话首领，退出时按进程组 kill，避免 next 子进程成孤儿
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let child = cmd.spawn().map_err(|e| format!("failed to spawn pi-web server: {e}"))?;
    let pid = child.id();
    NODE_PID.store(pid as i32, Ordering::SeqCst);

    *app.state::<ServerState>().0.lock().expect("server state lock") = Some((child, pid));

    if !wait_ready(port) {
        shutdown(app);
        return Err(format!("pi-web server did not become ready on port {port}"));
    }

    Ok(format!("http://127.0.0.1:{port}"))
}

/// 在主线程创建主窗口。
pub fn create_window(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(url.parse().expect("valid url")),
    )
    .title("Pi Web")
    .inner_size(1280.0, 820.0)
    .min_inner_size(720.0, 480.0)
    .on_navigation(move |url| {
        if url.scheme() == "http" || url.scheme() == "https" {
            let is_local = url
                .host_str()
                .map(|h| matches!(h, "127.0.0.1" | "localhost" | "[::1]" | "::1"))
                .unwrap_or(false);
            if !is_local {
                let _ = open::that_detached(url.as_str());
                return false;
            }
        }
        true
    })
    .build()?;

    window.show()?;
    Ok(())
}

/// 结束 pi-web 服务进程（防孤儿进程）。
/// node 以 setsid 启动，pid 即进程组 id；按组 kill 会连 next 子进程一起清理。
pub fn shutdown(app: &AppHandle) {
    if let Some((mut child, pid)) = app.state::<ServerState>().0.lock().expect("server state lock").take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        NODE_PID.store(0, Ordering::SeqCst);
    }
}

/// 供托盘菜单使用：杀掉子进程并立即退出。
pub fn kill_and_exit(app: &AppHandle) {
    shutdown(app);
    app.exit(0);
}
