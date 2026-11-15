use crate::commands::account::upsert_account;
use crate::commands::session::{build_views, sync_session_state};
use crate::domain::error::{AppError, AppResult};
use crate::domain::model::{now_ms, AccountSource, AccountView};
use crate::state::AppState;
use crate::storage::vault::{self, StoredSession};
use tauri::State;

/// 发送邮箱验证码；不需要已有会话。
#[tauri::command]
pub async fn auth_request_code(email: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || request_code_blocking(email))
        .await
        .map_err(|err| AppError::new("task", format!("验证码请求失败：{err}")))?
}

fn request_code_blocking(email: String) -> AppResult<()> {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(AppError::invalid("请输入有效的邮箱地址"));
    }
    crate::auth::request_code(email)
        .map_err(|message| AppError::new("auth_request_failed", message))
}

/// 验证码登录：拿到会话后只保存到本机，不立刻改写 pen.dev 的会话文件。
#[tauri::command]
pub async fn auth_login(
    app: tauri::AppHandle,
    email: String,
    code: String,
) -> AppResult<AccountView> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || login_blocking(app.state::<AppState>(), email, code))
        .await
        .map_err(|err| AppError::new("task", format!("验证码登录任务失败：{err}")))?
}

fn login_blocking(state: State<'_, AppState>, email: String, code: String) -> AppResult<AccountView> {
    let email = email.trim().to_string();
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err(AppError::invalid("请输入验证码"));
    }

    let device = {
        let store = state.store()?;
        crate::storage::device::device_id(&store.dir)
    };

    let payload = crate::auth::login_with_code(&email, &code, &device)
        .map_err(|message| AppError::new("auth_login_failed", message))?;

    let token = payload
        .token
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AppError::new("auth_login_failed", "登录成功但服务端没有返回会话 token"))?;

    let resolved_email = payload
        .email
        .map(|value| value.trim().to_string())
        .filter(|value| value.contains('@'))
        .unwrap_or(email);

    let mut store = state.store()?;
    let original_current = store.data.current.clone();
    let id = upsert_account(&mut store, &resolved_email, &token, AccountSource::Desktop)?;
    // 验证码登录仅保存备用账号，不改写桌面会话，也不改变当前账号。
    store.data.current = original_current;

    let workspace = crate::auth::personal_workspace(&token);
    vault::save_session(
        &id,
        &StoredSession {
            email: resolved_email.clone(),
            token,
            workspace,
        },
    )?;

    if let Some(account) = store.data.accounts.iter_mut().find(|item| item.id == id) {
        account.last_verified_at = Some(now_ms());
        account.revoked = false;
    }
    store.save()?;
    state.forget_quota(&id);
    crate::logging::info(&format!("login account {resolved_email}"));

    let states = sync_session_state(&mut store, &state.sessions)?;
    build_views(&store, &states)
        .into_iter()
        .find(|view| view.id == id)
        .ok_or_else(|| AppError::new("state", "账号保存失败"))
}
