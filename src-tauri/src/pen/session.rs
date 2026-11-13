use crate::domain::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default)]
    pub organization_id: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSession {
    #[serde(default)]
    email: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    current_workspace: Option<Workspace>,
}

/// 解析后的会话快照。token 只在后端内存中使用，不进入 IPC。
#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    pub email: String,
    pub token: String,
    pub workspace: Option<Workspace>,
}

pub fn read(path: &Path) -> AppResult<SessionSnapshot> {
    let raw = fs::read_to_string(path).map_err(|e| {
        AppError::new(
            "session_missing",
            format!("读取会话文件失败（{}）：{e}", path.display()),
        )
    })?;
    let parsed: RawSession = serde_json::from_str(&raw)
        .map_err(|e| AppError::new("session_invalid", format!("会话文件不是有效 JSON：{e}")))?;

    let email = parsed.email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err(AppError::new("session_invalid", "会话文件里没有有效邮箱"));
    }
    if parsed.token.trim().is_empty() {
        return Err(AppError::new("session_invalid", "会话文件里没有 token，可能尚未登录"));
    }

    Ok(SessionSnapshot {
        email,
        token: parsed.token,
        workspace: parsed.current_workspace,
    })
}

/// 读取原始文件内容，用于切换前备份；文件不存在时返回 None。
pub fn read_raw(path: &Path) -> AppResult<Option<String>> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::new(
            "session_missing",
            format!("读取会话文件失败（{}）：{err}", path.display()),
        )),
    }
}

/// 按 pen.dev 桌面会话的字段结构重建文件内容。
pub fn build_session_file(
    email: &str,
    token: &str,
    workspace: Option<&Workspace>,
    last_online_at: i64,
) -> AppResult<String> {
    let mut value = serde_json::json!({
        "email": email,
        "token": token,
        "lastOnlineAt": last_online_at,
    });
    if let Some(workspace) = workspace {
        value["currentWorkspace"] = serde_json::to_value(workspace)?;
    }
    Ok(serde_json::to_string(&value)?)
}

/// 同目录临时文件 + rename，避免 pen.dev 读到半个 JSON。
pub fn write_atomic(path: &Path, contents: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 等 pen.dev 停止写会话文件；进程退出瞬间它还会更新一次 lastOnlineAt。
pub fn wait_for_stable(path: &Path, idle: Duration, timeout: Duration) -> bool {
    let start = Instant::now();
    let mut last = modified(path);
    let mut stable_since = Instant::now();

    while start.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(250));
        let current = modified(path);
        if current != last {
            last = current;
            stable_since = Instant::now();
        } else if stable_since.elapsed() >= idle {
            return true;
        }
    }
    false
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|meta| meta.modified().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pen-switch-session-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_desktop_session_shape() {
        let dir = temp_dir();
        let path = dir.join("session-desktop.json");
        std::fs::write(
            &path,
            r#"{"email":"a@example.com","token":"tok","lastOnlineAt":1,"currentWorkspace":{"organizationId":"org","slug":"personal","label":"Personal"}}"#,
        )
        .unwrap();

        let snapshot = read(&path).unwrap();
        assert_eq!(snapshot.email, "a@example.com");
        let workspace = snapshot.workspace.expect("workspace parsed");
        assert_eq!(workspace.label.as_deref(), Some("Personal"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_session_without_token() {
        let dir = temp_dir();
        let path = dir.join("session-cli.json");
        std::fs::write(&path, r#"{"email":"a@example.com","token":""}"#).unwrap();

        let error = read(&path).unwrap_err();
        assert_eq!(error.code, "session_invalid");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn built_file_roundtrips_through_parser() {
        let dir = temp_dir();
        let path = dir.join("session-desktop.json");
        let workspace = Workspace {
            organization_id: Some("org".to_string()),
            slug: Some("personal".to_string()),
            label: Some("Personal workspace".to_string()),
        };

        let contents =
            build_session_file("b@example.com", "token-b", Some(&workspace), 1234).unwrap();
        write_atomic(&path, &contents).unwrap();

        let snapshot = read(&path).unwrap();
        assert_eq!(snapshot.email, "b@example.com");
        assert_eq!(snapshot.token, "token-b");
        assert_eq!(
            snapshot.workspace.and_then(|w| w.label).as_deref(),
            Some("Personal workspace")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = temp_dir();
        assert!(read_raw(&dir.join("nope.json")).unwrap().is_none());
        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod real_file {
    use super::*;

    #[test]
    #[ignore = "需要本机已登录的 pen.dev 桌面会话"]
    fn reads_real_desktop_session() {
        let Some(home) = crate::commands::system::home_dir() else {
            eprintln!("skip: 找不到用户目录");
            return;
        };
        let path = crate::pen::paths::SessionPaths::from_home(&home).desktop;
        if !path.exists() {
            eprintln!("skip: {} 不存在", path.display());
            return;
        }
        let snapshot = read(&path).expect("真实会话应可解析");
        assert!(snapshot.email.contains('@'));
        assert!(snapshot.token.len() > 20);
        eprintln!(
            "ok email={} token_len={} workspace={:?}",
            snapshot.email,
            snapshot.token.len(),
            snapshot.workspace.and_then(|w| w.label)
        );
    }
}
