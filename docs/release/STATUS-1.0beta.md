# 1.0 beta 状态（重构后）

## 架构
- `src-tauri/pet-core/`：纯逻辑 crate（focus、tasks、economy、quiet、sedentary、rng），零依赖，`cargo test` 可在任何平台跑。
- `src-tauri/src/pet/`：Tauri 内联插件 "pet"（命令前缀 `plugin:pet|`），`platform/` 集中所有 Win32 调用，非 Windows 有空实现。
- 对上游文件的改动：`lib.rs`（删/增 mod 与一行 `.plugin(pet::init())`）、`tray.rs`（一个菜单项）、`updater.rs`（默认关闭）、`build.rs` + `Cargo.toml` + capabilities（插件权限与依赖）、`catEngine.ts`（加法式钩子）、`main.ts`/`menuMain.ts`/`menu.html`/`style.css`（界面）。`input_hook.rs` 与上游一致。

## 皮肤包
- 格式见 `docs/skins/SKIN-FORMAT.md`；打包工具 `tools/pack-skin.mjs`；设置里有「皮肤」页（安装/拖入/卸载，安装前显示作者与许可证）。
- 校验在 `pet-core/skin.rs`（id、必填作者与许可证、PNG/WebP 文件头、大小与尺寸、base64），后端 `pet/skins.rs` 再校验颜色字段并写入。颜色皮肤注册进上游的自定义猫列表（id = `skin-<id>`），图片皮肤走 `engine.setSpriteSkin`。

## 已验证
- `cargo test`（pet-core）：52 项通过（含皮肤校验、base64、图片头嗅探、分层皮肤几何与图片校验、制作器 AI 的端点与 JSON 提取、默认皮肤覆盖/回滚决策、专注显示方式解析）。
- 前端全量 `tsc`（使用 stub 类型）通过；`npm test` 28 项（含 makerPack、分层皮肤解析/姿态适配器/IK 数学、打包工具）。
- `src/pet/**`、`build.rs`、`lib.rs`、`tray.rs` 通过 rustfmt 语法解析（仅语法，不是编译）。

## 未验证
- 依赖 tauri / notify / windows-sys 的 Rust 从未编译（沙箱无网络）：`src/pet/**`。
- `windows-sys` 的 `GetLastInputInfo`/`LASTINPUTINFO`/`GetTickCount` 路径已对照公开代码核对；`SHQueryUserNotificationState`、`GetTimeZoneInformation` 的字段/类型凭记忆。
- InlinedPlugin 的 `tauri_build` API 依据公开文档，版本细节未编译确认。
- `src/pet/skins.rs` 的测试（需要 serde，沙箱无法编译）；图片皮肤的绘制位置/大小；拖入文件在真实 WebView2 里是否生效；所有 Canvas 绘制、设置窗口外观、运行时行为。

## 占位符
产品名已定为 pipi-cat（productName、可执行文件名、数据目录 `%APPDATA%\pipi-cat`、开机自启项、版本 1.0.0-beta.1、标识 `io.github.cs3306.pipi-cat`）；更新器仓库指向 `cs3306/pipi-cat` 但 `UPDATES_CONFIGURED=false`（有了第一个 Release 再开）；仍待：LICENSE 里加你自己的版权行、代码签名。见 RELEASE-CHECKLIST.md。

## 分层皮肤（1.0 beta 新增）
`kind: "layered"`：torso + head 必填，四肢/尾巴可选，肢体 2 段 IK、尾巴 2–3 段链式、闭眼/张嘴头部替换图。后端校验 `pet-core/rig.rs`；渲染 `src/rig/*`；制作器可编辑；设置里每个图片/分层皮肤有「高级」大小与上下位置。示例皮肤 `docs/skins/examples/blocky-rig/`。
**渲染、肢体弯折方向、位置/层叠、尾巴摆动都没见过画面**，必须在 Windows 真机上肉眼验证（见 RELEASE-CHECKLIST）。

## 皮肤管理（beta 1 新增）
- **制作器能打开已有皮肤**：从内置猫开始（复制）、打开已安装皮肤、从文件打开；也可从设置页带着起点打开（`open_maker(target)`，`builtin:` / `override:` / `skin:`，目标字符串严格校验）。
- **默认皮肤（黑猫、布偶）**：内置外观永不被修改；覆盖另存为 `app_data/overrides/<id>.json`（只留一代备份 `.json.bak`），由 `cats::all_cats` 在渲染前叠加。回滚四层：撤销上一次 → 恢复该猫默认（可再撤销）→ 全部恢复（需确认、不可撤销）→ 兜底（覆盖损坏自动退回内置并提示；托盘「使用内置外观」可临时停用全部覆盖而不删除文件）。覆盖记录 `baseVersion`，将来内置外观变了会提示「保留我的修改 / 恢复默认」。大肥鱼不能覆盖。决策逻辑在 `pet-core/overrides.rs`（有单测）。
- **文件管理**：设置 → 皮肤 → 「打开皮肤文件夹」；列表标出「未登记」（手动放进文件夹的文件），只能通过「重新安装…」走确认卡；不自动扫描。猫列表里指向已不存在文件的 `skin-` 条目会被清掉（只删除，不发现）。同 id 再安装时旧文件保留为 `<id>.petskin.prev`，设置里可「回退到上一版」（可来回切换）。写入先写临时文件再改名。
- **皮肤新字段**：后端 `CatSkinConfig` 与 `get_cat_schema` 同步 `schemaVersion / apronColor / mouthInnerColor / tongueColor`（颜色走同一套校验，`schemaVersion` 只能是 1 或 2）。
- **专注时猫的显示**：设置 → 专注 →「正常 / 变淡 / 隐藏」，默认正常。隐藏由后端调度线程执行：只有「由专注隐藏」的猫才会在专注结束时自动显示（用户自己隐藏的不替他显示）；提醒与关机警告本来就会先显示猫；状态只在内存，重启后猫总是显示。「变淡」是前端对猫画布的透明度（提醒弹出时临时恢复）。
- **未验证（需要 Windows 构建）**：以上全部 Rust（`pet/overrides.rs`、`skins.rs` 新增部分、`window.rs`、`ticker.rs`、托盘新菜单项）从未编译；`explorer` 打开文件夹；制作器切换起点后的界面；`std::fs::rename` 在 Windows 上覆盖已有文件的行为；变淡的实际观感。
