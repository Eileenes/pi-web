mod commands;
mod server;
mod tray;

use std::sync::Mutex;
use std::process::Child;
use tauri::Manager;

/// 保存 node 侧车进程及其 PID（PID 用于按进程组清理，避免 next 子进程成为孤儿）。
pub struct ServerState(pub Mutex<Option<(Child, u32)>>);

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
            if let tauri::RunEvent::ExitRequested { .. } = event {
                server::shutdown(app_handle);
            }
        });
}
