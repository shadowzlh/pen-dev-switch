# macOS 支持说明

## 已做的跨平台改造（M1）

| 位置 | 改动 |
| --- | --- |
| `src-tauri/src/pen/process.rs` | 按 `windows` / `target_os = "macos"` / 其他 unix 分别实现进程检测、退出、启动 |
| `src-tauri/Cargo.toml` | keyring 同时启用 `windows-native` 与 `apple-native`（Windows 用凭据管理器，macOS 用钥匙串） |
| `src-tauri/src/commands/system.rs` | 诊断导出目录改用 `HOME` / `USERPROFILE` 兜底 |
| `src-tauri/src/pen/session.rs`、`commands/session.rs` | 测试里的用户目录改用 `home_dir()`，macOS 不再跳过 |
| `src-tauri/tauri.macos.conf.json` | macOS 打包目标 `app` + `dmg`，最低系统版本 11.0 |
| 前端文案 | “Windows 凭据管理器”改为“系统凭据管理器（Windows 凭据 / macOS 钥匙串）” |

会话文件路径无需改动：pen.dev 在 macOS 上同样是 `~/.pencil/session-desktop.json`
（客户端源码里 `CONFIG_FOLDER = join(os.homedir(), ".pencil")`）。

## macOS 上的平台实现

- 进程检测：`pgrep -x Pen`
- 退出：`osascript -e 'tell application "Pen" to quit'`，超时后兜底 `killall -TERM Pen`
- 启动：`open -a Pen`，失败回退 `open /Applications/Pen.app`
- 安装路径：`/Applications/Pen.app`

## 构建（需要 macOS 机器）

```bash
pnpm install
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 当前架构
pnpm tauri build

# Intel + Apple Silicon 通用包
pnpm tauri build --target universal-apple-darwin
```

产物：`src-tauri/target/.../bundle/dmg/*.dmg` 与 `bundle/macos/*.app`。

## 签名与公证（发布必需）

未签名的包在别人机器上会被 Gatekeeper 拦截。需要：

1. Apple Developer Program 账号
2. Developer ID Application 证书
3. 公证用的 App Store Connect API Key 或 Apple ID

Tauri 支持通过环境变量完成签名和公证：

```bash
export APPLE_CERTIFICATE="<base64 p12>"
export APPLE_CERTIFICATE_PASSWORD="..."
export APPLE_SIGNING_IDENTITY="Developer ID Application: ..."
export APPLE_ID="..."
export APPLE_PASSWORD="<app-specific password>"
export APPLE_TEAM_ID="..."
pnpm tauri build --target universal-apple-darwin
```

## 运行时权限

1. **自动化（TCC）**：第一次通过 `osascript` 关闭 Pen 时，macOS 会询问“允许 Pen Switch 控制 Pen”。
   拒绝后切换会失败，需要到「系统设置 → 隐私与安全性 → 自动化」重新授权。
2. **钥匙串**：第一次读写 token 会弹系统授权；拒绝则账号凭据不可用。
3. 应用不在 App Sandbox 中，因此可以读写 `~/.pencil`；若将来上架 App Store，需要改为
   user-selected file 权限并重新设计会话访问方式。

## 验收清单（macOS 实机）

- [ ] 启动应用，界面与 Windows 一致
- [ ] 导入当前登录（读取 `~/.pencil/session-desktop.json`）
- [ ] 切换账号：Pen 正常退出 → 写入 → 自动重启 → 显示目标邮箱
- [ ] 额度与套餐显示正常
- [ ] 验证码登录可用
- [ ] 凭据写入/读取钥匙串（含首次授权）
- [ ] 导出诊断到 `~/Downloads`
- [ ] 单实例：重复打开只保留一个窗口

## 已知风险

- AppleScript 退出依赖应用名精确为 `Pen`；若安装名不同，需改成 bundle id。
- 公证链路需要 Apple 账号与证书，无法在 Windows 上验证。
- 目前所有实机验证都在 Windows 完成，macOS 分支只保证语法与条件编译正确。
