mod commands;
mod server;
mod tray;

use std::sync::Mutex;
use std::process::Child;
use tauri::Manager;

/// 保存 node 侧车进程及其 PID（PID 用于按进程组清理，避免 next 子进程成为孤儿）。
pub struct ServerState(pub Mutex<Option<(Child, u32)>>);

impl Drop for ServerState {
    /// 兜底清理：无论主进程以何种方式结束（正常退出、panic、事件循环异常返回），
    /// 只要 Rust 侧还能运行析构，就按进程组杀掉 node 侧车，防止 next 变孤儿。
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some((mut child, pid)) = guard.take() {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(ServerState(Mutex::new(None)))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：聚焦已有窗口
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::select_directory,
            commands::reveal_in_finder,
            commands::notify
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            let _ = tray::setup_tray(app.handle());

            // 强杀兑底：SIGTERM/SIGINT/SIGHUP 时按进程组清理 node 侧车
            server::install_signal_handlers();

            // 在后台线程启动 pi-web 服务，就绪后回主线程创建窗口
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let url = match server::start(&handle) {
                    Ok(url) => url,
                    Err(e) => {
                        eprintln!("pi-web desktop: failed to start server: {e}");
                        return;
                    }
                };
                let handle_for_closure = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(e) = server::create_window(&handle_for_closure, &url) {
                        eprintln!("pi-web desktop: failed to create window: {e}");
                    }
                });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 → 隐藏到托盘（真正退出走托盘菜单 / Cmd+Q）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 两种退出路径都必须清理 node 侧车：
            // 1. ExitRequested：托盘退出(app.exit) / 最后一个窗口真正销毁时触发
            // 2. Exit：macOS Cmd+Q / Dock 退出走 tao 的 LoopDestroyed，只发 Exit 事件
            //    （窗口被 prevent_close 隐藏，永远不会 Destroyed，所以之前漏掉了这条路径）
            if let tauri::RunEvent::ExitRequested { .. } = event {
                server::shutdown(app_handle);
            } else if let tauri::RunEvent::Exit = event {
                server::shutdown(app_handle);
            }
        });
}
