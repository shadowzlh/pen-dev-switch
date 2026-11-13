use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountSource {
    Desktop,
    Cli,
}

/// 会话是否与当前 pen.dev 磁盘会话一致。有效期不可知，这里只表达“能否核对”。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// 与磁盘上的会话邮箱一致，刚刚核对过。
    Ok,
    /// 保存了会话，但它不是当前登录账号，本轮无法核对。
    Unknown,
    /// 没有保存的会话，或当前账号的会话已从磁盘消失/被替换。
    NeedsReimport,
}

/// 落盘记录（不含任何 token）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRecord {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub alias: String,
    pub source: AccountSource,
    pub added_at: i64,
    pub last_seen_at: i64,
    /// 最近一次与磁盘会话核对成功的时间。
    #[serde(default)]
    pub last_verified_at: Option<i64>,
    /// 服务端 `/auth/session-info` 返回 401，说明会话已被吊销。
    #[serde(default)]
    pub revoked: bool,
}

/// 返回前端的账号视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub email: String,
    pub alias: String,
    pub source: AccountSource,
    /// 套餐与额度目前无公开接口，保持 None，前端显示“未知”。
    pub plan: Option<String>,
    pub has_token: bool,
    pub added_at: i64,
    pub last_seen_at: i64,
    pub last_verified_at: Option<i64>,
    pub revoked: bool,
    pub session_state: SessionState,
    pub is_current: bool,
}

impl AccountView {
    pub fn from_record(
        record: &AccountRecord,
        current: Option<&str>,
        has_token: bool,
        session_state: SessionState,
    ) -> Self {
        Self {
            id: record.id.clone(),
            email: record.email.clone(),
            alias: record.alias.clone(),
            source: record.source,
            plan: None,
            has_token,
            added_at: record.added_at,
            last_seen_at: record.last_seen_at,
            last_verified_at: record.last_verified_at,
            revoked: record.revoked,
            session_state,
            is_current: current == Some(record.id.as_str()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchReport {
    pub switched_to: String,
    pub pen_restarted: bool,
    pub dry_run: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub pen_running: bool,
    pub pen_exe_path: Option<String>,
    pub session_path: Option<String>,
    /// 磁盘会话里的邮箱；即使它不在账号列表里也返回，供前端提示导入。
    pub live_email: Option<String>,
    pub backend_version: String,
}



pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
