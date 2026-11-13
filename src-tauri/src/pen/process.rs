use crate::domain::error::AppResult;

#[cfg(windows)]
mod imp {
    use super::AppResult;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// 用 tasklist 判断 Pen 是否在运行；不引入额外进程枚举依赖。
    pub fn pen_running() -> bool {
        let output = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq Pen.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match output {
            Ok(out) => String::from_utf8_lossy(&out.stdout)
                .to_ascii_lowercase()
                .contains("pen.exe"),
            Err(_) => false,
        }
    }

    pub fn pen_exe_path() -> Option<PathBuf> {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let path = PathBuf::from(local)
            .join("Programs")
            .join("Pen")
            .join("Pen.exe");
        path.exists().then_some(path)
    }

    /// 发送正常关闭请求（不带 /F），超时未退出就返回 false。
    pub fn quit_all(timeout: Duration) -> AppResult<bool> {
        if !pen_running() {
            return Ok(true);
        }

        Command::new("taskkill")
            .args(["/IM", "Pen.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| crate::domain::error::AppError::new("pen_quit", format!("无法请求 pen.dev 退出：{e}")))?;

        let start = Instant::now();
        while start.elapsed() < timeout {
            if !pen_running() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(400));
        }
        Ok(!pen_running())
    }

    /// 通过 explorer 转交启动：直接 spawn 会继承调用方进程树的 Job 限制，
    /// pen.dev 会在初始化前静默退出（exit code 0、无日志）。
    pub fn start_pen() -> AppResult<bool> {
        let path = pen_exe_path().ok_or_else(|| {
            crate::domain::error::AppError::new("pen_missing", "没有找到 Pen.exe，请先安装 pen.dev")
        })?;

        Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| crate::domain::error::AppError::new("pen_start", format!("无法启动 pen.dev：{e}")))?;

        wait_started(Duration::from_secs(12))
    }

    fn wait_started(timeout: Duration) -> AppResult<bool> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if pen_running() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::AppResult;
    use crate::domain::error::AppError;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// `pgrep -x Pen` 精确匹配进程名。
    pub fn pen_running() -> bool {
        Command::new("pgrep")
            .args(["-x", "Pen"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub fn pen_exe_path() -> Option<PathBuf> {
        let path = PathBuf::from("/Applications/Pen.app");
        path.exists().then_some(path)
    }

    /// 用 AppleScript 让 Pen 正常退出，触发 Electron 的 before-quit。
    pub fn quit_all(timeout: Duration) -> AppResult<bool> {
        if !pen_running() {
            return Ok(true);
        }

        let _ = Command::new("osascript")
            .args(["-e", "tell application \"Pen\" to quit"])
            .output();

        let start = Instant::now();
        while start.elapsed() < timeout {
            if !pen_running() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(400));
        }

        // 兜底：SIGTERM。可能不触发正常退出流程，仅用于避免卡死。
        let _ = Command::new("killall").args(["-TERM", "Pen"]).output();
        std::thread::sleep(Duration::from_millis(800));
        Ok(!pen_running())
    }

    pub fn start_pen() -> AppResult<bool> {
        if pen_exe_path().is_none() {
            return Err(AppError::new(
                "pen_missing",
                "没有找到 /Applications/Pen.app，请先安装 pen.dev",
            ));
        }

        let launched = Command::new("open")
            .args(["-a", "Pen"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        if !launched {
            let _ = Command::new("open")
                .arg("/Applications/Pen.app")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(12) {
            if pen_running() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Ok(false)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::AppResult;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Linux 尚无官方桌面端，这里保持可编译并提供最小实现。
    pub fn pen_running() -> bool {
        Command::new("pgrep")
            .args(["-x", "pen"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub fn pen_exe_path() -> Option<PathBuf> {
        None
    }

    pub fn quit_all(timeout: Duration) -> AppResult<bool> {
        if !pen_running() {
            return Ok(true);
        }
        let _ = Command::new("pkill").args(["-TERM", "-x", "pen"]).output();
        let start = Instant::now();
        while start.elapsed() < timeout {
            if !pen_running() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(400));
        }
        Ok(!pen_running())
    }

    pub fn start_pen() -> AppResult<bool> {
        Err(crate::domain::error::AppError::new(
            "pen_missing",
            "当前平台没有可用的 pen.dev 桌面端",
        ))
    }
}

pub use imp::{pen_exe_path, pen_running, quit_all, start_pen};
