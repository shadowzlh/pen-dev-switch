use crate::domain::error::{AppError, AppResult};
use crate::pen::session::Workspace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// token 存进 Windows 凭据管理器，不落明文文件、不回传前端。
const SERVICE: &str = "dev.pen.switch";
const BACKUP_SERVICE: &str = "dev.pen.switch.backup";

/// 一个账号的完整会话资料，切换时用它重建 pen.dev 的会话文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    #[serde(default)]
    pub email: String,
    pub token: String,
    #[serde(default)]
    pub workspace: Option<Workspace>,
}

fn entry(service: &str, account_id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(service, account_id)
        .map_err(|e| AppError::new("vault", format!("无法打开凭据存储：{e}")))
}

pub fn save_session(account_id: &str, session: &StoredSession) -> AppResult<()> {
    let payload = serde_json::to_string(session)?;
    entry(SERVICE, account_id)?
        .set_password(&payload)
        .map_err(|e| AppError::new("vault", format!("无法保存会话：{e}")))
}

pub fn load_session(account_id: &str) -> AppResult<Option<StoredSession>> {
    match entry(SERVICE, account_id)?.get_password() {
        Ok(raw) => Ok(Some(decode(&raw))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::new("vault", format!("无法读取会话：{e}"))),
    }
}

pub fn has_token(account_id: &str) -> bool {
    matches!(load_session(account_id), Ok(Some(session)) if !session.token.is_empty())
}

pub fn delete_token(account_id: &str) -> AppResult<()> {
    match entry(SERVICE, account_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new("vault", format!("无法删除会话：{e}"))),
    }
}

/// 兼容 M1 直接写入的裸 token。
fn decode(raw: &str) -> StoredSession {
    match serde_json::from_str::<StoredSession>(raw) {
        Ok(session) => session,
        Err(_) => StoredSession {
            email: String::new(),
            token: raw.to_string(),
            workspace: None,
        },
    }
}

/// 只保留最近几份切换前备份；更早的删掉，避免凭据管理器无限堆积。
const MAX_BACKUPS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEntry {
    key: String,
    created_at: i64,
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("backups.json")
}

fn read_manifest(dir: &Path) -> Vec<BackupEntry> {
    fs::read_to_string(manifest_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &Path, entries: &[BackupEntry]) -> AppResult<()> {
    fs::create_dir_all(dir)?;
    fs::write(manifest_path(dir), serde_json::to_string_pretty(entries)?)?;
    Ok(())
}

fn drop_backup(key: &str) {
    if let Ok(entry) = entry(BACKUP_SERVICE, key) {
        let _ = entry.delete_credential();
    }
}

/// 切换前把原会话整体存进凭据管理器，避免在磁盘上多留一份明文 token。
pub fn save_backup_credential(dir: &Path, raw: &str) -> AppResult<String> {
    let created_at = crate::domain::model::now_ms();
    let key = format!("backup-{created_at}");
    entry(BACKUP_SERVICE, &key)?
        .set_password(raw)
        .map_err(|e| AppError::new("vault", format!("无法备份原会话：{e}")))?;

    let mut entries = read_manifest(dir);
    entries.push(BackupEntry {
        key: key.clone(),
        created_at,
    });
    while entries.len() > MAX_BACKUPS {
        let oldest = entries.remove(0);
        drop_backup(&oldest.key);
    }
    write_manifest(dir, &entries)?;
    Ok(key)
}

/// 启动时清理一次，防止上次异常退出留下多余备份。
pub fn cleanup_backups(dir: &Path) -> AppResult<()> {
    let mut entries = read_manifest(dir);
    let before = entries.len();
    while entries.len() > MAX_BACKUPS {
        let oldest = entries.remove(0);
        drop_backup(&oldest.key);
    }
    if entries.len() != before {
        write_manifest(dir, &entries)?;
    }
    Ok(())
}

pub fn restore_backup_credential(key: &str) -> AppResult<Option<String>> {
    match entry(BACKUP_SERVICE, key)?.get_password() {
        Ok(raw) => Ok(Some(raw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::new("vault", format!("无法读取原会话备份：{e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_session_credential() {
        let id = format!("test-session-{}", crate::domain::model::now_ms());
        let session = StoredSession {
            email: "a@example.com".to_string(),
            token: "dummy-token".to_string(),
            workspace: None,
        };
        save_session(&id, &session).expect("写入凭据");
        assert!(has_token(&id));
        let loaded = load_session(&id).unwrap().expect("读取凭据");
        assert_eq!(loaded.email, "a@example.com");
        assert_eq!(loaded.token, "dummy-token");
        delete_token(&id).expect("删除凭据");
        assert!(load_session(&id).unwrap().is_none());
    }

    #[test]
    fn legacy_plain_token_is_accepted() {
        let decoded = decode("legacy-token");
        assert_eq!(decoded.token, "legacy-token");
        assert!(decoded.email.is_empty());
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    #[test]
    fn prunes_old_backups() {
        let dir = std::env::temp_dir().join(format!(
            "pen-switch-backups-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut keys = Vec::new();
        for _ in 0..5 {
            keys.push(save_backup_credential(&dir, "{\"token\":\"dummy\"}").unwrap());
            std::thread::sleep(std::time::Duration::from_millis(3));
        }

        let manifest = read_manifest(&dir);
        assert_eq!(manifest.len(), MAX_BACKUPS);
        // 最老的已经被删除，凭据读不到。
        drop_backup(&keys[0]);
        for entry in &manifest {
            drop_backup(&entry.key);
        }
        std::fs::remove_dir_all(dir).ok();
    }
}