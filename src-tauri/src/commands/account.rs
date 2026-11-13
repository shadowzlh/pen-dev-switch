use crate::commands::session::{build_views, sync_session_state};
use crate::domain::error::{AppError, AppResult};
use crate::domain::model::{now_ms, AccountRecord, AccountSource, AccountView, SessionState};
use crate::pen::session;
use crate::state::AppState;
use crate::storage::repo::Store;
use crate::storage::vault;
use std::time::{Duration, Instant};
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn account_list(state: State<'_, AppState>) -> AppResult<Vec<AccountView>> {
    let mut store = state.store()?;
    let states = sync_session_state(&mut store, &state.sessions)?;
    Ok(build_views(&store, &states))
}

/// 从本机 pen.dev 会话文件导入账号；桌面会话导入后即视为当前账号。
#[tauri::command]
pub async fn account_import(app: tauri::AppHandle, source: AccountSource) -> AppResult<AccountView> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || import_blocking(app.state::<AppState>(), source))
        .await
        .map_err(|err| AppError::new("task", format!("导入任务失败：{err}")))?
}

fn import_blocking(state: State<'_, AppState>, source: AccountSource) -> AppResult<AccountView> {
    let path = state.sessions.for_source(source).to_path_buf();
    let snapshot = session::read(&path)?;

    let mut store = state.store()?;
    let id = upsert_account(&mut store, &snapshot.email, &snapshot.token, source)?;

    vault::save_session(
        &id,
        &vault::StoredSession {
            email: snapshot.email.clone(),
            token: snapshot.token.clone(),
            workspace: snapshot.workspace.clone(),
        },
    )?;

    let now = now_ms();
    let record = {
        let account = store
            .data
            .accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| AppError::new("state", "账号保存失败"))?;
        if source == AccountSource::Desktop {
            account.last_verified_at = Some(now);
        }
        account.clone()
    };
    let current = store.data.current.clone();
    store.save()?;
    state.forget_quota(&id);
    crate::logging::info(&format!(
        "import account {} source={:?}",
        snapshot.email, source
    ));

    let session_state = if source == AccountSource::Desktop {
        SessionState::Ok
    } else {
        SessionState::Unknown
    };

    Ok(AccountView::from_record(
        &record,
        current.as_deref(),
        true,
        session_state,
    ))
}

/// 轮询桌面会话文件，直到出现一个不同于 `exclude_email` 的邮箱且文件写入已稳定，
/// 再按导入流程保存它。超时未检测到新登录时返回 `Ok(None)`，不是错误。
/// 用于“登录一个新账号”里退出旧账号、重新登录后的自动捕获。
#[tauri::command]
pub async fn account_watch_new(
    app: tauri::AppHandle,
    exclude_email: String,
    timeout_ms: u64,
) -> AppResult<Option<AccountView>> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        watch_new_blocking(app.state::<AppState>(), exclude_email, timeout_ms.min(180_000))
    })
    .await
    .map_err(|err| AppError::new("task", format!("监听任务失败：{err}")))?
}

fn watch_new_blocking(
    state: State<'_, AppState>,
    exclude_email: String,
    timeout_ms: u64,
) -> AppResult<Option<AccountView>> {
    let path = state.sessions.for_source(AccountSource::Desktop).to_path_buf();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let generation = state.next_watch_generation();
    let exclude = exclude_email.trim().to_lowercase();

    loop {
        if !state.is_watch_current(generation) || Instant::now() >= deadline {
            return Ok(None);
        }
        if let Some(email) = session::peek_email(&path) {
            if email.to_lowercase() != exclude
                && session::wait_for_stable(&path, Duration::from_millis(600), Duration::from_secs(3))
                && state.is_watch_current(generation)
            {
                let snapshot = session::read(&path)?;
                if snapshot.email.eq_ignore_ascii_case(&exclude) {
                    continue;
                }
                return import_blocking(state, AccountSource::Desktop).map(Some);
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[tauri::command]
pub fn account_cancel_watch(state: State<'_, AppState>) {
    state.cancel_watch();
}

/// 先去重：邮箱相同，或保存的 token 完全相同（说明是同一次登录）。
/// 桌面会话总是成为当前账号。
pub(crate) fn upsert_account(
    store: &mut Store,
    email: &str,
    token: &str,
    source: AccountSource,
) -> AppResult<String> {
    let now = now_ms();
    let existing = find_existing_index(&store.data.accounts, email, token, |id| {
        vault::load_session(id).ok().flatten().map(|session| session.token)
    });

    let id = match existing {
        Some(index) => {
            let account = &mut store.data.accounts[index];
            account.last_seen_at = now;
            account.source = source;
            // 导入来源的邮箱更接近用户实际操作，顺手纠正。
            account.email = email.to_string();
            account.id.clone()
        }
        None => {
            let id = Uuid::new_v4().to_string();
            store.data.accounts.push(AccountRecord {
                id: id.clone(),
                email: email.to_string(),
                alias: String::new(),
                source,
                added_at: now,
                last_seen_at: now,
                last_verified_at: None,
                revoked: false,
            });
            id
        }
    };

    if source == AccountSource::Desktop || store.data.current.is_none() {
        store.data.current = Some(id.clone());
    }

    Ok(id)
}

/// 邮箱（大小写不敏感）或 token 相同即视为同一条记录。
fn find_existing_index(
    accounts: &[AccountRecord],
    email: &str,
    token: &str,
    stored_token: impl Fn(&str) -> Option<String>,
) -> Option<usize> {
    if let Some(index) = accounts
        .iter()
        .position(|account| account.email.eq_ignore_ascii_case(email))
    {
        return Some(index);
    }
    accounts
        .iter()
        .position(|account| stored_token(&account.id).as_deref() == Some(token))
}

#[tauri::command]
pub fn account_set_alias(
    state: State<'_, AppState>,
    id: String,
    alias: String,
) -> AppResult<AccountView> {
    let alias = alias.trim().to_string();
    if alias.chars().count() > 60 {
        return Err(AppError::invalid("备注最多 60 个字符"));
    }

    let mut store = state.store()?;
    {
        let account = store
            .data
            .accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| AppError::not_found("账号不存在"))?;
        account.alias = alias;
    }
    store.save()?;

    let states = sync_session_state(&mut store, &state.sessions)?;
    let session_state = states.get(&id).copied().unwrap_or(SessionState::Unknown);
    let record = store
        .find(&id)
        .cloned()
        .ok_or_else(|| AppError::not_found("账号不存在"))?;
    let current = store.data.current.clone();

    Ok(AccountView::from_record(
        &record,
        current.as_deref(),
        vault::has_token(&id),
        session_state,
    ))
}

#[tauri::command]
pub fn account_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut store = state.store()?;
    if store.data.current.as_deref() == Some(id.as_str()) {
        return Err(AppError::new(
            "current_account",
            "当前登录账号不能移除，请先切换到其他账号",
        ));
    }

    let before = store.data.accounts.len();
    store.data.accounts.retain(|account| account.id != id);
    if store.data.accounts.len() == before {
        return Err(AppError::not_found("账号不存在"));
    }

    vault::delete_token(&id)?;
    state.forget_quota(&id);
    store.save()?;
    crate::logging::info(&format!("remove account {id}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!(
            "pen-switch-import-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        Store::load(dir).unwrap()
    }

    #[test]
    fn import_dedupes_email_case_insensitively() {
        let mut store = temp_store("dedupe");

        let first = upsert_account(&mut store, "User@Example.com", "token-1", AccountSource::Desktop).unwrap();
        let second = upsert_account(&mut store, "user@example.com", "token-1", AccountSource::Cli).unwrap();

        assert_eq!(first, second);
        assert_eq!(store.data.accounts.len(), 1);
        assert_eq!(store.data.accounts[0].source, AccountSource::Cli);
        // 桌面导入后当前账号已固定，后续 CLI 导入不应抢占。
        assert_eq!(store.data.current.as_deref(), Some(first.as_str()));

        std::fs::remove_dir_all(&store.dir).ok();
    }

    #[test]
    fn desktop_import_becomes_current() {
        let mut store = temp_store("current");

        let cli = upsert_account(&mut store, "cli@example.com", "token-cli", AccountSource::Cli).unwrap();
        assert_eq!(store.data.current.as_deref(), Some(cli.as_str()));

        let desktop = upsert_account(
            &mut store,
            "desktop@example.com",
            "token-desktop",
            AccountSource::Desktop,
        )
        .unwrap();
        assert_eq!(store.data.current.as_deref(), Some(desktop.as_str()));

        std::fs::remove_dir_all(&store.dir).ok();
    }

    #[test]
    fn dedupes_by_token_even_with_different_email() {
        let accounts = vec![AccountRecord {
            id: "a".to_string(),
            email: "typo@gmail.com".to_string(),
            alias: String::new(),
            source: AccountSource::Desktop,
            added_at: 1,
            last_seen_at: 1,
            last_verified_at: None,
            revoked: false,
        }];

        let index = find_existing_index(&accounts, "real@gmail.com", "same-token", |id| {
            (id == "a").then(|| "same-token".to_string())
        });
        assert_eq!(index, Some(0));

        let none = find_existing_index(&accounts, "other@gmail.com", "new-token", |_| {
            Some("same-token".to_string())
        });
        assert_eq!(none, None);
    }
}
