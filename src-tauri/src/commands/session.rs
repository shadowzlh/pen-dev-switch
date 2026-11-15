use crate::domain::error::{AppError, AppResult};
use crate::domain::model::{now_ms, AccountView, SessionState, SwitchReport};
use crate::pen::paths::SessionPaths;
use crate::pen::session::SessionSnapshot;
use crate::pen::{process, session};
use crate::state::AppState;
use crate::storage::repo::Store;
use crate::storage::vault::{self, StoredSession};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tauri::State;

const QUIT_TIMEOUT: Duration = Duration::from_secs(20);
const STABLE_IDLE: Duration = Duration::from_millis(800);
const STABLE_TIMEOUT: Duration = Duration::from_secs(6);


/// 与磁盘上的 pen.dev 会话核对一次：顺带修正当前账号指针，
/// 刷新“已验证时间”，并在磁盘 token 变化时以磁盘为准更新保存值。
pub fn sync_session_state(
    store: &mut Store,
    paths: &SessionPaths,
) -> AppResult<HashMap<String, SessionState>> {
    let live: Option<SessionSnapshot> = session::read(&paths.desktop).ok();
    let live_email = live.as_ref().map(|snapshot| snapshot.email.as_str());
    let mut dirty = false;
    let mut states = HashMap::new();

    if let Some(snapshot) = &live {
        if let Some(account) = store
            .data
            .accounts
            .iter()
            .find(|account| account.email.eq_ignore_ascii_case(&snapshot.email))
        {
            if store.data.current.as_deref() != Some(account.id.as_str()) {
                store.data.current = Some(account.id.clone());
                dirty = true;
            }
        }
    }

    let current = store.data.current.clone();

    for account in &mut store.data.accounts {
        let has_token = vault::has_token(&account.id);
        let is_current = current.as_deref() == Some(account.id.as_str());
        let state = classify(
            live_email,
            &account.email,
            has_token,
            is_current,
            account.revoked,
            account.last_verified_at.is_some(),
        );

        // 只有磁盘会话确实属于这个账号时，才允许把磁盘 token 回写到该账号。
        // 否则会把「当前登录账号」的 token 覆盖到其他账号上（曾导致凭据串号）。
        if state == SessionState::Ok && should_resync(live_email, &account.email) {
            let stored = vault::load_session(&account.id)?;
            let token_changed = match (&stored, &live) {
                (Some(stored), Some(snapshot)) => stored.token != snapshot.token,
                _ => false,
            };
            if token_changed {
                if let Some(snapshot) = &live {
                    vault::save_session(
                        &account.id,
                        &StoredSession {
                            email: snapshot.email.clone(),
                            token: snapshot.token.clone(),
                            workspace: snapshot.workspace.clone(),
                        },
                    )?;
                }
            }
        }

        states.insert(account.id.clone(), state);
    }

    if dirty {
        store.save()?;
    }
    Ok(states)
}

/// 仅当磁盘会话邮箱与账号邮箱一致时才回写 token。
fn should_resync(live_email: Option<&str>, account_email: &str) -> bool {
    live_email
        .map(|email| email.eq_ignore_ascii_case(account_email))
        .unwrap_or(false)
}

/// 会话状态判定：服务端已吊销优先，其次看能否与当前磁盘会话对上。
fn classify(
    live_email: Option<&str>,
    account_email: &str,
    has_token: bool,
    is_current: bool,
    revoked: bool,
    server_verified: bool,
) -> SessionState {
    if !has_token || revoked {
        return SessionState::NeedsReimport;
    }
    // 服务端确认过的 token 即使不是当前登录，也算可用。
    if server_verified {
        return SessionState::Ok;
    }
    match live_email {
        Some(email) if email.eq_ignore_ascii_case(account_email) => SessionState::Ok,
        Some(_) => SessionState::Unknown,
        None if is_current => SessionState::NeedsReimport,
        None => SessionState::Unknown,
    }
}

/// 账号视图统一出口，避免各命令各自拼装。
pub fn build_views(store: &Store, states: &HashMap<String, SessionState>) -> Vec<AccountView> {
    let current = store.data.current.clone();
    store
        .data
        .accounts
        .iter()
        .map(|record| {
            AccountView::from_record(
                record,
                current.as_deref(),
                vault::has_token(&record.id),
                states
                    .get(&record.id)
                    .copied()
                    .unwrap_or(SessionState::Unknown),
            )
        })
        .collect()
}

/// 用服务端 `/auth/session-info` 复核所有已保存的会话；
/// 200 记为已验证，401/403 标记为已被吊销，网络异常则保持原状态。
#[tauri::command]
pub async fn session_verify(app: tauri::AppHandle) -> AppResult<Vec<AccountView>> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || verify_sessions_blocking(app.state::<AppState>()))
        .await
        .map_err(|err| AppError::new("task", format!("会话校验任务失败：{err}")))?
}

fn verify_sessions_blocking(state: State<'_, AppState>) -> AppResult<Vec<AccountView>> {
    let (device, targets) = {
        let store = state.store()?;
        let device = crate::storage::device::device_id(&store.dir);
        let targets: Vec<(String, String)> = store
            .data
            .accounts
            .iter()
            .filter_map(|account| {
                vault::load_session(&account.id)
                    .ok()
                    .flatten()
                    .map(|session| (account.id.clone(), session.token))
            })
            .collect();
        (device, targets)
    };

    // 网络请求不持锁，避免阻塞其他命令。
    let mut verdicts = Vec::with_capacity(targets.len());
    for (id, token) in targets {
        verdicts.push((id, crate::verify::verify(&token, &device)));
    }

    let mut store = state.store()?;
    let now = now_ms();
    let mut dirty = false;
    let mut valid = 0;
    let mut revoked = 0;
    let mut unreachable = 0;

    for (id, verdict) in verdicts {
        let Some(account) = store.data.accounts.iter_mut().find(|item| item.id == id) else {
            continue;
        };
        match verdict {
            crate::verify::Verdict::Valid(_) => {
                valid += 1;
                account.revoked = false;
                account.last_verified_at = Some(now);
                dirty = true;
            }
            crate::verify::Verdict::Revoked => {
                revoked += 1;
                if !account.revoked {
                    account.revoked = true;
                    dirty = true;
                }
            }
            crate::verify::Verdict::Unreachable => {
                unreachable += 1;
            }
        }
    }

    if dirty {
        store.save()?;
    }

    crate::logging::info(&format!(
        "verify sessions valid={valid} revoked={revoked} unreachable={unreachable}"
    ));

    let states = sync_session_state(&mut store, &state.sessions)?;
    Ok(build_views(&store, &states))
}

/// 读取正在生效的桌面会话，并映射到已保存的账号。
#[tauri::command]
pub fn session_current(state: State<'_, AppState>) -> AppResult<Option<AccountView>> {
    let path = state.sessions.desktop.clone();
    if !path.exists() {
        return Ok(None);
    }
    let Ok(snapshot) = session::read(&path) else {
        return Ok(None);
    };

    let store = state.store()?;
    let Some(record) = store.find_by_email(&snapshot.email).cloned() else {
        return Ok(None);
    };
    let has_token = vault::has_token(&record.id);
    Ok(Some(AccountView::from_record(
        &record,
        Some(record.id.as_str()),
        has_token,
        SessionState::Ok,
    )))
}

/// 真正写入 pen.dev 会话文件：退出 → 备份 → 原子写 → 校验 → 重启，失败回滚。
#[tauri::command]
pub async fn session_switch(
    app: tauri::AppHandle,
    id: String,
    restart_pen: bool,
    dry_run: Option<bool>,
) -> AppResult<SwitchReport> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        switch_blocking(app.state::<AppState>(), id, restart_pen, dry_run)
    })
    .await
    .map_err(|err| AppError::new("task", format!("切换任务失败：{err}")))?
}

fn switch_blocking(
    state: State<'_, AppState>,
    id: String,
    restart_pen: bool,
    dry_run: Option<bool>,
) -> AppResult<SwitchReport> {
    let dry_run = dry_run.unwrap_or_else(|| {
        std::env::var("PEN_SWITCH_DRY_RUN")
            .map(|value| value == "1")
            .unwrap_or(false)
    });

    let (stored_email, stored) = {
        let store = state.store()?;
        let account = store
            .find(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("账号不存在"))?;
        let stored = vault::load_session(&id)?
            .filter(|session| !session.token.is_empty())
            .ok_or_else(|| AppError::new("no_token", "该账号没有保存的会话，请重新导入"))?;
        (account.email, stored)
    };

    let mut email = if stored.email.is_empty() {
        stored_email.clone()
    } else {
        stored.email.clone()
    };

    // 切换前向服务端确认 token 的归属；跨账号的 token 直接拒绝，避免写错账号。
    let device = {
        let store = state.store()?;
        crate::storage::device::device_id(&store.dir)
    };
    match crate::verify::verify(&stored.token, &device) {
        crate::verify::Verdict::Valid(Some(server_email)) => {
            if !server_email.eq_ignore_ascii_case(&stored_email) {
                return Err(AppError::new(
                    "session_mismatch",
                    format!("保存的会话属于 {server_email}，请重新导入该账号"),
                ));
            }
            email = server_email;
        }
        crate::verify::Verdict::Valid(None) => {}
        crate::verify::Verdict::Revoked => {
            return Err(AppError::new(
                "session_revoked",
                "该账号的会话已失效，请重新导入",
            ));
        }
        crate::verify::Verdict::Unreachable => {}
    }
    // 旧账号可能没有记录工作区，切过去时补一次，避免 pen.dev 打不开工作区。
    let workspace = stored
        .workspace
        .clone()
        .or_else(|| crate::auth::personal_workspace(&stored.token));
    let contents =
        session::build_session_file(&email, &stored.token, workspace.as_ref(), now_ms())?;

    let target = if dry_run {
        std::env::temp_dir().join("pen-switch-dryrun-session.json")
    } else {
        state.sessions.desktop.clone()
    };

    crate::logging::info(&format!(
        "switch requested id={id} restart_pen={restart_pen} dry_run={dry_run}"
    ));

    let mut warnings = Vec::new();
    let was_running = process::pen_running();

    if was_running && !dry_run {
        if !restart_pen {
            return Err(AppError::new(
                "pen_running",
                "pen.dev 正在运行，切换需要先退出它",
            ));
        }
        if !process::quit_all(QUIT_TIMEOUT)? {
            return Err(AppError::new(
                "pen_still_running",
                "pen.dev 未能在 20 秒内退出，已取消切换",
            ));
        }
    } else if was_running {
        warnings.push("dry-run：未退出 pen.dev".to_string());
    }

    if !dry_run && !session::wait_for_stable(&target, STABLE_IDLE, STABLE_TIMEOUT) {
        warnings.push("会话文件仍在变化，已按当前内容继续".to_string());
    }

    // 备份放凭据管理器，磁盘上不新增明文 token；只保留最近几份。
    let backup_dir = {
        let store = state.store()?;
        store.dir.clone()
    };
    let backup_key = if dry_run {
        None
    } else {
        match session::read_raw(&target) {
            Ok(Some(raw)) => Some(vault::save_backup_credential(&backup_dir, &raw)?),
            _ => None,
        }
    };

    if let Err(err) = session::write_atomic(&target, &contents) {
        crate::logging::error(&format!("session write failed: {err}"));
        rollback(backup_key.as_deref(), &target);
        if was_running && !dry_run {
            let _ = process::start_pen();
        }
        return Err(err);
    }

    let verified = session::read(&target)
        .map(|written| written.email.eq_ignore_ascii_case(&email))
        .unwrap_or(false);
    if !verified {
        crate::logging::error("session verify failed after write, rolled back");
        rollback(backup_key.as_deref(), &target);
        if was_running && !dry_run {
            let _ = process::start_pen();
        }
        return Err(AppError::new(
            "verify_failed",
            "写入后校验失败，已回滚原会话",
        ));
    }

    let mut pen_restarted = false;
    if !dry_run && (was_running || restart_pen) {
        pen_restarted = process::start_pen()?;
        if !pen_restarted {
            warnings.push("pen.dev 未能自动启动，请手动打开".to_string());
        }
    }

    if !dry_run {
        let mut store = state.store()?;
        if let Some(account) = store.data.accounts.iter_mut().find(|item| item.id == id) {
            account.last_verified_at = Some(now_ms());
        }
        store.data.current = Some(id.clone());
        store.save()?;
    }

    if stored.workspace.is_none() {
        if let Some(workspace) = &workspace {
            let _ = vault::save_session(
                &id,
                &StoredSession {
                    email: email.clone(),
                    token: stored.token.clone(),
                    workspace: Some(workspace.clone()),
                },
            );
        }
    }

    crate::logging::info(&format!("session switched to {email}"));
    if dry_run {
        warnings.push(format!("dry-run：写入到 {}", target.display()));
    }
    warnings.push(
        "保存的 token 可能已被 pen.dev 轮换；切换后若提示未登录，请重新导入该账号。".to_string(),
    );

    Ok(SwitchReport {
        switched_to: email,
        pen_restarted,
        dry_run,
        warnings,
    })
}

fn rollback(backup_key: Option<&str>, target: &Path) {
    let Some(key) = backup_key else {
        return;
    };
    if let Ok(Some(raw)) = vault::restore_backup_credential(key) {
        let _ = session::write_atomic(target, &raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_does_not_overwrite_other_account_tokens() {
        use crate::domain::model::{AccountRecord, AccountSource};
        use crate::pen::paths::SessionPaths;

        let dir = std::env::temp_dir().join(format!(
            "pen-switch-sync-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut store = crate::storage::repo::Store::load(dir.clone()).unwrap();
        for (id, email) in [("acc-a", "a@example.com"), ("acc-b", "b@example.com")] {
            store.data.accounts.push(AccountRecord {
                id: id.to_string(),
                email: email.to_string(),
                alias: String::new(),
                source: AccountSource::Desktop,
                added_at: 1,
                last_seen_at: 1,
                last_verified_at: Some(1),
                revoked: false,
            });
        }
        store.data.current = Some("acc-b".to_string());
        store.save().unwrap();

        vault::save_session(
            "acc-a",
            &StoredSession {
                email: "a@example.com".to_string(),
                token: "token-a".to_string(),
                workspace: None,
            },
        )
        .unwrap();
        vault::save_session(
            "acc-b",
            &StoredSession {
                email: "b@example.com".to_string(),
                token: "token-b".to_string(),
                workspace: None,
            },
        )
        .unwrap();

        let desktop = dir.join("session-desktop.json");
        std::fs::write(
            &desktop,
            r#"{"email":"b@example.com","token":"token-b-live"}"#,
        )
        .unwrap();
        let paths = SessionPaths {
            desktop,
            cli: dir.join("session-cli.json"),
        };

        sync_session_state(&mut store, &paths).unwrap();

        assert_eq!(
            vault::load_session("acc-a").unwrap().unwrap().token,
            "token-a",
            "非当前账号的 token 不应被覆盖"
        );
        assert_eq!(
            vault::load_session("acc-b").unwrap().unwrap().token,
            "token-b-live",
            "当前账号应同步磁盘上的新 token"
        );

        let _ = vault::delete_token("acc-a");
        let _ = vault::delete_token("acc-b");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn resync_requires_matching_live_email() {
        assert!(should_resync(Some("a@example.com"), "A@example.com"));
        assert!(!should_resync(Some("other@example.com"), "a@example.com"));
        assert!(!should_resync(None, "a@example.com"));
    }

    #[test]
    fn classifies_session_states() {
        assert_eq!(
            classify(Some("a@example.com"), "A@example.com", true, true, false, false),
            SessionState::Ok
        );
        assert_eq!(
            classify(Some("other@example.com"), "a@example.com", true, false, false, false),
            SessionState::Unknown
        );
        assert_eq!(
            classify(None, "a@example.com", true, true, false, false),
            SessionState::NeedsReimport
        );
        assert_eq!(
            classify(None, "a@example.com", true, false, false, false),
            SessionState::Unknown
        );
        assert_eq!(
            classify(Some("a@example.com"), "a@example.com", false, true, false, false),
            SessionState::NeedsReimport
        );
        // 服务端已验证的非当前账号也应视为可用。
        assert_eq!(
            classify(Some("other@example.com"), "a@example.com", true, false, false, true),
            SessionState::Ok
        );
        // 已吊销优先于一切。
        assert_eq!(
            classify(Some("a@example.com"), "a@example.com", true, true, true, true),
            SessionState::NeedsReimport
        );
    }

    #[test]
    #[ignore = "需要 PEN_FP_ACCOUNT 指向已导入的账号"]
    fn stored_token_matches_live_session() {
        let Ok(id) = std::env::var("PEN_FP_ACCOUNT") else {
            eprintln!("skip: 未设置 PEN_FP_ACCOUNT");
            return;
        };
        let Some(home) = crate::commands::system::home_dir() else {
            eprintln!("skip: 找不到用户目录");
            return;
        };
        let paths = SessionPaths::from_home(&home);
        let stored = vault::load_session(&id).expect("读取凭据").expect("账号拥有凭据");
        let live = session::read(&paths.desktop).expect("读取桌面会话");
        println!("stored_email={} live_email={}", stored.email, live.email);
        println!(
            "token_equal={} stored_len={} live_len={}",
            stored.token == live.token,
            stored.token.len(),
            live.token.len()
        );
    }
}

#[cfg(test)]
mod compare {
    use crate::storage::vault;

    #[test]
    #[ignore = "需要 PEN_A / PEN_B 两个账号 id"]
    fn compare_two_stored_sessions() {
        let (Ok(a), Ok(b)) = (std::env::var("PEN_A"), std::env::var("PEN_B")) else {
            eprintln!("skip: 未设置 PEN_A / PEN_B");
            return;
        };
        let sa = vault::load_session(&a).unwrap().expect("A 有凭据");
        let sb = vault::load_session(&b).unwrap().expect("B 有凭据");
        println!("A email={} token_len={} ws={:?}", sa.email, sa.token.len(), sa.workspace);
        println!("B email={} token_len={} ws={:?}", sb.email, sb.token.len(), sb.workspace);
        println!("token_equal={}", sa.token == sb.token);
        let same: usize = sa.token.chars().zip(sb.token.chars()).take_while(|(x, y)| x == y).count();
        println!("common_prefix_len={}", same);
    }
}
#[cfg(test)]
mod backup_dump {
    use crate::storage::vault;

    #[test]
    #[ignore = "读取备份凭据内容，仅打印摘要"]
    fn dump_backup_summaries() {
        for key in std::env::var("PEN_BACKUP_KEYS").unwrap_or_default().split(',') {
            let key = key.trim();
            if key.is_empty() { continue; }
            match vault::restore_backup_credential(key) {
                Ok(Some(raw)) => {
                    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                    println!(
                        "{key}: email={:?} token_len={} ws={:?}",
                        parsed.get("email").and_then(|v| v.as_str()),
                        parsed.get("token").and_then(|v| v.as_str()).map(str::len).unwrap_or(0),
                        parsed.get("currentWorkspace").map(|v| v.to_string().chars().take(60).collect::<String>())
                    );
                }
                Ok(None) => println!("{key}: missing"),
                Err(err) => println!("{key}: error {err}"),
            }
        }
    }
}