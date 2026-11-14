use std::path::Path;

fn main() {
    // 版本唯一来源：package.json。注入成 APP_VERSION 供 Rust 侧读取，
    // 避免 Cargo.toml 与打包版本各写一份而漂移。
    let manifest = Path::new("..").join("package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());

    let version = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(|item| item.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    println!("cargo:rustc-env=APP_VERSION={version}");
    tauri_build::build()
}