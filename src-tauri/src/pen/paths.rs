use crate::domain::model::AccountSource;
use std::path::{Path, PathBuf};

/// pen.dev 的两个本地会话文件；字段已于本机核实。
#[derive(Debug, Clone)]
pub struct SessionPaths {
    pub desktop: PathBuf,
    pub cli: PathBuf,
}

impl SessionPaths {
    pub fn from_home(home: &Path) -> Self {
        let base = home.join(".pencil");
        Self {
            desktop: base.join("session-desktop.json"),
            cli: base.join("session-cli.json"),
        }
    }

    pub fn for_source(&self, source: AccountSource) -> &Path {
        match source {
            AccountSource::Desktop => &self.desktop,
            AccountSource::Cli => &self.cli,
        }
    }
}
