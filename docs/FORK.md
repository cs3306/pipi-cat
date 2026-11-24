# 与上游的关系（硬分叉）

- 上游：`qianyiai/kurocat`（MIT）。分叉基线：**v4.9.0**（拉取时的最新提交）。
- 策略：**不再合并上游**。需要上游的修复或功能时，手动挑选（cherry-pick 或照着改），并在下表记录。
- 许可：上游的版权声明与 MIT 文本必须保留在 `LICENSE`，并随安装包分发（见 `NOTICE.md`）。
- 命名：MIT 不授予商标，请使用自己的产品名，并避免暗示与上游官方有关。

## 边界（我们自己的代码都在这里）
- `src-tauri/pet-core/`：纯逻辑 crate（零依赖，`cargo test`）。
- `src-tauri/src/pet/`：Tauri 内联插件 "pet"（玩法、关机、文件反应、皮肤包），`platform/` 集中全部 Win32 调用。
- `src/` 下的 `i18n.ts`、`petBridge.ts`、`petEffects.ts`、`spriteSkin.ts`、`settingsMain.ts`、`meowAudio.ts`。

## 已改动的上游文件（分叉后由我们自己维护）
`src-tauri/src/lib.rs`、`tray.rs`、`updater.rs`、`build.rs`、`Cargo.toml`、`capabilities/default.json`、
`src/catEngine.ts`（叠加绘制回调 + 图片皮肤分支 + 几个加法式方法）、`src/main.ts`、`src/menuMain.ts`、`menu.html`、`src/style.css`、`vite.config.ts`。

## 上游修复/功能挑选记录
| 日期 | 上游提交 / 版本 | 内容 | 状态 |
|---|---|---|---|
| — | — | （尚无） | — |

## 追加的上游文件改动（制作器 / MCP 拆分）
- `src-tauri/src/config.rs`：`default_mcp_enabled()` 改为 false
- `src-tauri/src/mcp.rs`：`upsert_cat` 先走 `pet::skins::palette_errors`，并保留 `skin-` 前缀
- `src-tauri/Cargo.toml`：+`ureq`；`src-tauri/capabilities/default.json`：+`maker` 窗口；`vite.config.ts`：+`maker.html` 入口
- `src/menuMain.ts`：`mcpEnabled` 默认 false
- `src/catEngine.ts`：再加 `setLayeredSkin / setSkinAdjust / getRigInput` 与 `drawSpriteScene` 里的分层分支（加法式）
- `src/main.ts`：皮肤同步改走 `skinLoader`，并监听 `storage` 事件（皮肤高级调整）
