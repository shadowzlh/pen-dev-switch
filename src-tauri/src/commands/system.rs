use crate::domain::error::AppResult;
use crate::domain::model::AppStatus;
use crate::pen::{process, session};
use crate::quota::{Outcome, QuotaView};
use crate::state::AppState;
use crate::storage::vault;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[tauri::command]
pub fn app_status(state: State<'_, AppState>) -> AppResult<AppStatus> {
    let live_email = session::read(&state.sessions.desktop)
        .ok()
        .map(|snapshot| snapshot.email);

    Ok(AppStatus {
        pen_running: process::pen_running(),
        pen_exe_path: process::pen_exe_path().map(|path| path.display().to_string()),
        session_path: Some(state.sessions.desktop.display().to_string()),
        live_email,
        backend_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// 拉取账号额度：`/usage/summary` + `/public/upgrade-options`，带 5 分钟缓存。
#[tauri::command]
pub fn quota_get(state: State<'_, AppState>, id: String) -> AppResult<QuotaView> {
    if let Some(cached) = state.cached_quota(&id) {
        return Ok(cached);
    }

    let token = vault::load_session(&id)?
        .map(|session| session.token)
        .filter(|token| !token.is_empty());

    let Some(token) = token else {
        return Ok(QuotaView::unavailable("该账号没有保存的会话"));
    };

    let view = match crate::quota::fetch(&token) {
        Outcome::Ok(quota) => QuotaView::ok(quota),
        Outcome::Revoked => {
            crate::logging::warn(&format!("quota revoked for account {id}"));
            let mut store = state.store()?;
            let mut changed = false;
            if let Some(account) = store.data.accounts.iter_mut().find(|item| item.id == id) {
                if !account.revoked {
                    account.revoked = true;
                    changed = true;
                }
            }
            if changed {
                store.save()?;
            }
            QuotaView::unavailable("会话已被吊销，请重新导入")
        }
        Outcome::Unavailable(reason) => {
            crate::logging::warn(&format!("quota unavailable for account {id}: {reason}"));
            QuotaView::unavailable(reason)
        }
    };

    state.store_quota(&id, &view);
    Ok(view)
}

/// 导出一份纯文本诊断：版本、路径、账号概况（不含 token）和最近日志。
#[tauri::command]
pub fn export_diagnostics(state: State<'_, AppState>) -> AppResult<String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();

    let mut out = String::new();
    let _ = writeln!(out, "pen-dev-switch diagnostics");
    let _ = writeln!(out, "generated_at_epoch: {stamp}");
    let _ = writeln!(out, "app_version: {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(
        out,
        "os: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let _ = writeln!(out, "pen_running: {}", process::pen_running());
    let _ = writeln!(out, "pen_exe: {:?}", process::pen_exe_path());
    let _ = writeln!(out, "session_path: {}", state.sessions.desktop.display());
    let _ = writeln!(out, "log_path: {:?}", crate::logging::path());

    {
        let store = state.store()?;
        let _ = writeln!(out, "\n[accounts] count={}", store.data.accounts.len());
        for account in &store.data.accounts {
            let _ = writeln!(
                out,
                "- email={} source={:?} revoked={} has_token={} last_verified_at={:?} alias={}",
                account.email,
                account.source,
                account.revoked,
                vault::has_token(&account.id),
                account.last_verified_at,
                account.alias
            );
        }
        let _ = writeln!(out, "current: {:?}", store.data.current);
    }

    let _ = writeln!(out, "\n[log tail]");
    for line in crate::logging::tail(200) {
        let _ = writeln!(out, "{line}");
    }

    let target = diagnostics_dir().join(format!("pen-switch-diagnostics-{stamp}.txt"));
    std::fs::write(&target, out)?;
    crate::logging::info(&format!("diagnostics exported to {}", target.display()));
    Ok(target.display().to_string())
}

/// HOME（macOS/Linux）与 USERPROFILE（Windows）都试一遍。
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn diagnostics_dir() -> PathBuf {
    if let Some(home) = home_dir() {
        let downloads = home.join("Downloads");
        if downloads.exists() {
            return downloads;
        }
    }
    std::env::temp_dir()
}
