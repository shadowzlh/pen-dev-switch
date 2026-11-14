use crate::domain::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const RELEASES_API: &str = "https://api.github.com/repos/shadowzlh/pen-dev-switch/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/shadowzlh/pen-dev-switch/releases";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    release_url: Option<String>,
}

#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
    html_url: String,
}

/// 手动检查 GitHub Releases 稳定版；不下载、不自动安装。
#[tauri::command]
pub async fn check_updates() -> AppResult<UpdateInfo> {
    tauri::async_runtime::spawn_blocking(check_updates_blocking)
        .await
        .map_err(|err| AppError::new("task", format!("更新检查任务失败：{err}")))?
}

fn check_updates_blocking() -> AppResult<UpdateInfo> {
    let current = env!("APP_VERSION").to_string();
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(8))
        .build();
    let response = agent
        .get(RELEASES_API)
        .set("User-Agent", "pen-dev-switch")
        .set("Accept", "application/vnd.github+json")
        .call();
    let release: LatestRelease = match response {
        Ok(response) => response.into_json().map_err(|err| {
            AppError::new("release_invalid", format!("无法解析 GitHub Release：{err}"))
        })?,
        Err(ureq::Error::Status(404, _)) => {
            return Ok(UpdateInfo {
                current_version: current,
                latest_version: None,
                update_available: false,
                release_url: None,
            });
        }
        Err(err) => {
            return Err(AppError::new(
                "update_check_failed",
                format!("无法连接 GitHub Releases：{err}"),
            ));
        }
    };

    let latest = release.tag_name.trim_start_matches('v');
    let current_parts = parse_version(&current).ok_or_else(|| AppError::new("version", "当前版本号无效"))?;
    let latest_parts = parse_version(latest).ok_or_else(|| {
        AppError::new("release_invalid", "GitHub Release 的版本号不是稳定版格式")
    })?;
    let release_url = release
        .html_url
        .starts_with(&format!("{RELEASES_PAGE}/tag/"))
        .then_some(release.html_url);
    Ok(UpdateInfo {
        current_version: current,
        latest_version: Some(latest.to_string()),
        update_available: latest_parts > current_parts,
        release_url,
    })
}

fn parse_version(value: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn compares_versions_numerically() {
        assert!(parse_version("0.10.0") > parse_version("0.9.9"));
        assert_eq!(parse_version("1.2.3"), Some([1, 2, 3]));
        assert_eq!(parse_version("1.2.3-beta"), None);
    }
}
