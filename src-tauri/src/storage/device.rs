use std::fs;
use std::path::Path;

/// 桌面端会带 `X-Device-Id` 头；这里生成并复用一个本机标识。
pub fn device_id(dir: &Path) -> String {
    let path = dir.join("device-id");
    if let Ok(raw) = fs::read_to_string(&path) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let _ = fs::write(&path, &id);
    id
}
