use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::ServerState;

const DEFAULT_PORT: u16 = 30141;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// pi-web 运行目录（构建时由 scripts/desktop-build.mjs 拷入 resources/pi-web）。
/// 探测两种布局：Tauri 打包时资源相对 src-tauri 的路径会被保留。
fn piweb_dir(app: &AppHandle) -> PathBuf {
    let res = app.path().resource_dir().expect("resource dir");
    let candidates = [
        res.join("pi-web"),
        res.join("resources").join("pi-web"),
    ];
    candidates
        .iter()
        .find(|p| p.join(".next").exists())
        .cloned()
        .unwrap_or_else(|| res.join("pi-web"))
}

/// 打包进 Resources 的 node 侧车二进制（externalBin: binaries/node）。
fn node_bin(app: &AppHandle) -> PathBuf {
    app.path().resource_dir().expect("resource dir").join("node")
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
    if !piweb.join(".next").exists() {
        return Err(format!(
            "pi-web build not found at {}. Run the desktop build script first.",
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
    cmd.args(["bin/pi-web.js", "--port", &port.to_string(), "--no-open"])
        .current_dir(&piweb)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
    }
}

/// 供托盘菜单使用：杀掉子进程并立即退出。
pub fn kill_and_exit(app: &AppHandle) {
    shutdown(app);
    app.exit(0);
}
