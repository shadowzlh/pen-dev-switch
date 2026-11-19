# 发布流程

## 版本规则

- 唯一来源：`package.json` 的 `version`
- `src-tauri/tauri.conf.json` 直接引用 `../package.json`
- `src-tauri/Cargo.toml` 的版本由脚本同步，Rust 侧通过 `APP_VERSION` 读取 package.json
- 发布标识：git tag `vX.Y.Z`，必须与 `package.json` 完全一致

```bash
pnpm version:set 0.2.0   # 同步 package.json 与 Cargo.toml
pnpm version:check       # 本地校验三处一致
git add -A && git commit -m "chore: release 0.2.0"
git push
```

## 触发发布

### Windows 应用内更新

Updater 使用独立签名验证更新包。首次启用前，将本机 `src-tauri/updater.key` 的完整内容保存到 GitHub 仓库 `Settings → Secrets and variables → Actions`，Secret 名称为 `TAURI_SIGNING_PRIVATE_KEY`。私钥已加入 `.gitignore`，不得提交到仓库；`src-tauri/tauri.conf.json` 中的公钥用于验证更新包。

Windows 发布会额外生成签名的 NSIS 安装程序和 `latest.json`，应用确认后自动下载、验证并以带进度条的 passive 模式启动更新安装，无需手动卸载。普通 NSIS 安装程序仍保留作首次安装/手动恢复。

当前 `v0.1.2` 尚未集成 updater。首次启用后，用户需手动安装一个包含 updater 的新版本；后续 Windows 版本才支持应用内更新。

### 方式一：手动指定版本（推荐）

GitHub → Actions → `release` → Run workflow：

| 输入 | 说明 |
| --- | --- |
| `version` | 必填，例如 `0.2.0`，必须与 `package.json` 一致 |
| `prerelease` | 勾选则标记为预发布（`releases/latest` 会忽略） |

限制：只能从 `main` 分支触发；已存在的 tag 会被拒绝。

工作流会：校验版本 → 创建 tag（发布时由 action 基于当前 commit 创建）→ Windows/macOS 并行构建 → 全部成功后创建 Release。

### 方式二：推送 tag

```bash
git tag v0.2.0
git push origin v0.2.0
```

## 产物

| 平台 | 文件 |
| --- | --- |
| Windows | `pen-dev-switch_0.2.0_x64-setup.exe` |
| macOS | `pen-dev-switch_0.2.0_universal.dmg` |

## 原子性

`publish` job 依赖 `prepare` 和 `build` 全部成功；任一平台构建失败都不会产生 Release，避免出现只有一半产物的版本。

## 注意

- macOS 产物目前**未签名**，他人打开会被 Gatekeeper 拦截；正式分发前需配置 Apple 证书与公证
- 仓库必须保持公开，后续 updater 才能匿名拉取更新清单
- 发布后不要删除 Release；回滚只能让用户手动安装旧版本
