use crate::domain::error::AppResult;
use crate::domain::model::AccountRecord;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountsFile {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    #[serde(default)]
    pub accounts: Vec<AccountRecord>,
    #[serde(default)]
    pub current: Option<String>,
}

fn default_schema() -> u32 {
    SCHEMA_VERSION
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            accounts: Vec::new(),
            current: None,
        }
    }
}

pub struct Store {
    pub dir: PathBuf,
    pub data: AccountsFile,
}

impl Store {
    pub fn load(dir: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&dir)?;
        let path = dir.join("accounts.json");
        let data = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<AccountsFile>(&raw) {
                Ok(parsed) => parsed,
                Err(_) => {
                    // 损坏的账号文件不静默丢弃：留一份带时间戳的副本再从空列表开始。
                    let stamp = crate::domain::model::now_ms();
                    let backup = dir.join(format!("accounts.corrupt-{stamp}.json"));
                    let _ = fs::copy(&path, &backup);
                    AccountsFile::default()
                }
            },
            Err(_) => AccountsFile::default(),
        };
        Ok(Self { dir, data })
    }

    pub fn save(&self) -> AppResult<()> {
        let path = self.dir.join("accounts.json");
        let bytes = serde_json::to_vec_pretty(&self.data)?;
        write_atomic(&path, &bytes)
    }

    pub fn find(&self, id: &str) -> Option<&AccountRecord> {
        self.data.accounts.iter().find(|a| a.id == id)
    }

    pub fn find_by_email(&self, email: &str) -> Option<&AccountRecord> {
        self.data
            .accounts
            .iter()
            .find(|a| a.email.eq_ignore_ascii_case(email))
    }
}

/// 同目录临时文件 + rename，避免半个 JSON。
fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pen-switch-{tag}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn roundtrip_accounts_file() {
        let dir = temp_dir("repo");
        let mut store = Store::load(dir.clone()).unwrap();
        assert!(store.data.accounts.is_empty());

        store.data.accounts.push(AccountRecord {
            id: "id-1".to_string(),
            email: "a@example.com".to_string(),
            alias: "主账号".to_string(),
            source: crate::domain::model::AccountSource::Desktop,
            added_at: 1,
            last_seen_at: 2,
            last_verified_at: None,
            revoked: false,
        });
        store.data.current = Some("id-1".to_string());
        store.save().unwrap();

        let reloaded = Store::load(dir.clone()).unwrap();
        assert_eq!(reloaded.data.accounts.len(), 1);
        assert_eq!(reloaded.data.current.as_deref(), Some("id-1"));
        assert!(reloaded.find_by_email("A@example.com").is_some());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_file_is_quarantined() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("accounts.json"), "{ not json").unwrap();

        let store = Store::load(dir.clone()).unwrap();
        assert!(store.data.accounts.is_empty());
        let quarantined = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("accounts.corrupt-"));
        assert!(quarantined);

        std::fs::remove_dir_all(dir).ok();
    }
}