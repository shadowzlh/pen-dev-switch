mod auth;
mod commands;
mod domain;
mod logging;
mod pen;
mod quota;
mod state;
mod storage;
mod verify;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：第二个实例直接退出并聚焦已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("无法获取应用数据目录");
            let home = app.path().home_dir().expect("无法获取用户目录");

            let store = storage::repo::Store::load(data_dir.clone()).expect("无法初始化账号存储");
            let _ = storage::vault::cleanup_backups(&data_dir);
            logging::init(&data_dir);
            logging::info(&format!(
                "app started version={} os={} arch={}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            let sessions = pen::paths::SessionPaths::from_home(&home);
            app.manage(state::AppState::new(store, sessions));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::account::account_list,
            commands::auth::auth_request_code,
            commands::auth::auth_login,
            commands::account::account_import,
            commands::account::account_set_alias,
            commands::account::account_remove,
            commands::session::session_current,
            commands::session::session_verify,
            commands::session::session_switch,
            commands::system::app_status,
            commands::system::quota_get,
            commands::system::export_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
