use crate::domain::error::{AppError, AppResult};
use crate::domain::model::now_ms;
use crate::pen::paths::SessionPaths;
use crate::quota::QuotaView;
use crate::storage::repo::Store;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// 额度缓存有效期：避免每次刷新都打三次请求。
const QUOTA_TTL_MS: i64 = 300_000;

pub struct AppState {
    store: Mutex<Store>,
    pub sessions: SessionPaths,
    quota: Mutex<HashMap<String, (i64, QuotaView)>>,
    watch_generation: AtomicU64,
}

impl AppState {
    pub fn new(store: Store, sessions: SessionPaths) -> Self {
        Self {
            store: Mutex::new(store),
            sessions,
            quota: Mutex::new(HashMap::new()),
            watch_generation: AtomicU64::new(0),
        }
    }

    pub fn next_watch_generation(&self) -> u64 {
        self.watch_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_watch_current(&self, generation: u64) -> bool {
        self.watch_generation.load(Ordering::SeqCst) == generation
    }

    pub fn cancel_watch(&self) {
        self.watch_generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn cached_quota(&self, id: &str) -> Option<QuotaView> {
        let cache = self.quota.lock().ok()?;
        let (stamp, view) = cache.get(id)?;
        (now_ms() - stamp < QUOTA_TTL_MS).then(|| view.clone())
    }

    pub fn store_quota(&self, id: &str, view: &QuotaView) {
        if let Ok(mut cache) = self.quota.lock() {
            cache.insert(id.to_string(), (now_ms(), view.clone()));
        }
    }

    pub fn forget_quota(&self, id: &str) {
        if let Ok(mut cache) = self.quota.lock() {
            cache.remove(id);
        }
    }

    /// 账号文件读写都在这一把锁里，避免并发命令写出半更新状态。
    pub fn store(&self) -> AppResult<MutexGuard<'_, Store>> {
        self.store
            .lock()
            .map_err(|_| AppError::new("state", "内部状态锁已损坏，请重启应用"))
    }
}
