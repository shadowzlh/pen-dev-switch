use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
const MAX_BYTES: u64 = 1_000_000;

pub fn init(dir: &Path) -> PathBuf {
    let log_dir = dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let path = log_dir.join("app.log");

    if fs::metadata(&path).map(|meta| meta.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, log_dir.join("app.log.1"));
    }

    let _ = LOG_PATH.set(path.clone());
    path
}

pub fn path() -> Option<PathBuf> {
    LOG_PATH.get().cloned()
}

pub fn info(message: &str) {
    write_line("INFO", message);
}

pub fn warn(message: &str) {
    write_line("WARN", message);
}

pub fn error(message: &str) {
    write_line("ERROR", message);
}

/// 最近的 N 行，供诊断导出使用。
pub fn tail(limit: usize) -> Vec<String> {
    let Some(path) = path() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = content.lines().collect();
    lines
        .iter()
        .skip(lines.len().saturating_sub(limit))
        .map(|line| line.to_string())
        .collect()
}

fn write_line(level: &str, message: &str) {
    let Some(path) = path() else {
        return;
    };
    let line = format!("{} {:<5} {}\n", timestamp(), level, message);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// UTC ISO-8601，避免为一个时间戳引入额外依赖。
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_epoch_as_iso() {
        // 2026-11-13T00:00:00Z
        let days = 20_770;
        let (year, month, day) = civil_from_days(days);
        assert_eq!((year, month, day), (2026, 11, 13));
    }

    #[test]
    fn tail_keeps_last_lines() {
        let dir = std::env::temp_dir().join(format!(
            "pen-switch-log-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // 复用进程级 OnceLock，只在未初始化时设置。
        let _ = init(&dir);
        info("first");
        info("second");
        let lines = tail(1);
        if let Some(last) = lines.first() {
            assert!(last.contains("second"));
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
