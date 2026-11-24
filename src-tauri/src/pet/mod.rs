//! 宠物玩法插件（Tauri 内联插件 "pet"）。
//!
//! 与上游的耦合点只有三处：lib.rs 的 `.plugin(pet::init())`、托盘菜单项调用
//! `pet::open_settings_window`、前端的少量加法式钩子。其余全部在本目录内：
//!   model/settings/state/ticker/commands  玩法与调度（逻辑在 pet-core，可单测）
//!   platform/                             所有 Win32 调用（Windows 实现 + 其他系统的空实现）
//!   files.rs                              文件反应（notify 监听用户勾选的文件夹）
//!   shutdown.rs                           定时关机（shutdown.exe）
//!
//! 事件（前端监听）：kuro-focus kuro-focus-done kuro-cafe kuro-game kuro-snack kuro-reminder
//!   kuro-meow kuro-shutdown kuro-shutdown-warning kuro-pet-settings kuro-fileop

mod commands;
mod files;
mod maker_ai;
mod model;
mod overrides;
mod platform;
mod settings;
mod shutdown;
pub(crate) mod skins;
mod state;
mod ticker;
mod window;

use std::time::Duration;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Wry};

pub use window::open_settings_window;

/// 给 cats.rs 用：把默认皮肤的覆盖叠加到内置猫上。
pub fn apply_overrides(list: &mut [crate::cats::CatSkinConfig]) {
    overrides::apply(list);
}
/// 给托盘用：是否停用了覆盖，以及切换。
pub use overrides::{ignored as overrides_ignored, set_ignore as set_overrides_ignored};

/// 与 build.rs 里的 `PET_COMMANDS` 必须一致（见下方测试）。
pub const COMMANDS: &[&str] = &[
    "pet_get_settings",
    "pet_update_settings",
    "pet_status",
    "focus_start",
    "focus_cancel",
    "buy_snack",
    "snack_catalog",
    "tasks_get",
    "tasks_save",
    "reminder_snooze",
    "list_meow_files",
    "read_meow_file",
    "open_meow_folder",
    "shutdown_schedule",
    "shutdown_cancel",
    "shutdown_status",
    "open_settings",
    "skin_inspect",
    "skin_install",
    "skin_list",
    "skin_remove",
    "skin_sprites",
    "skin_rig",
    "maker_ai_get_config",
    "maker_ai_set_config",
    "maker_ai_palette",
    "open_maker",
    "skin_read",
    "skin_rollback",
    "skin_open_folder",
    "skin_override_status",
    "skin_builtin_look",
    "skin_override_save",
    "skin_override_undo",
    "skin_override_reset",
    "skin_override_reset_all",
    "skin_override_keep",
    "skin_override_ignore",
];

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("pet")
        .invoke_handler(tauri::generate_handler![
            commands::pet_get_settings,
            commands::pet_update_settings,
            commands::pet_status,
            commands::focus_start,
            commands::focus_cancel,
            commands::buy_snack,
            commands::snack_catalog,
            commands::tasks_get,
            commands::tasks_save,
            commands::reminder_snooze,
            commands::list_meow_files,
            commands::read_meow_file,
            commands::open_meow_folder,
            commands::shutdown_schedule,
            commands::shutdown_cancel,
            commands::shutdown_status,
            commands::open_settings,
            commands::skin_inspect,
            commands::skin_install,
            commands::skin_list,
            commands::skin_remove,
            commands::skin_sprites,
            commands::skin_rig,
            commands::maker_ai_get_config,
            commands::maker_ai_set_config,
            commands::maker_ai_palette,
            commands::open_maker,
            commands::skin_read,
            commands::skin_rollback,
            commands::skin_open_folder,
            commands::skin_override_status,
            commands::skin_builtin_look,
            commands::skin_override_save,
            commands::skin_override_undo,
            commands::skin_override_reset,
            commands::skin_override_reset_all,
            commands::skin_override_keep,
            commands::skin_override_ignore,
        ])
        .setup(|app, _api| {
            start(app.clone());
            Ok(())
        })
        .build()
}

fn start(app: AppHandle) {
    let (runtime, last_seen, s) = state::new_runtime();
    if !state::install(runtime) {
        return; // 已初始化
    }
    shutdown::restore();
    files::apply(&app, s.file_reactions, &s.watch_folders);

    // 首次启动：问用户是否开启文件反应（设置窗口自动弹出并显示欢迎卡片）
    if !s.file_reactions_asked {
        let a = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2500));
            tauri::async_runtime::block_on(async {
                let _ = window::open_settings_window(a).await;
            });
        });
    }
    std::thread::spawn(move || ticker::run(app, last_seen));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// build.rs 不能引用本模块，所以用文本检查两份命令清单一致，避免权限与实际命令不同步。
    #[test]
    fn commands_match_build_rs() {
        let build = include_str!("../../build.rs");
        let start = build.find("const PET_COMMANDS").expect("PET_COMMANDS in build.rs");
        let block = &build[start..];
        let end = block.find("];").expect("end of list");
        let listed: Vec<&str> = block[..end].split('"').skip(1).step_by(2).collect();
        let mut a: Vec<&str> = listed;
        let mut b: Vec<&str> = COMMANDS.to_vec();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }
}
