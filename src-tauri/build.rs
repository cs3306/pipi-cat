fn main() {
    println!("cargo:rerun-if-env-changed=KUROCAT_YY_THUNKS_OBJ");
    println!("cargo:rerun-if-env-changed=KUROCAT_VC_LTL_LIB");
    println!("cargo:rerun-if-env-changed=KUROCAT_WIN7_OLE32_SHIM_OBJ");
    #[cfg(feature = "win7")]
    {
        if let Ok(vc_ltl) = std::env::var("KUROCAT_VC_LTL_LIB") {
            let trimmed = vc_ltl.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-search=native={}", trimmed);
            }
        }
        if let Ok(shim) = std::env::var("KUROCAT_WIN7_OLE32_SHIM_OBJ") {
            let trimmed = shim.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=KuroCat={}", trimmed);
            }
        }
        if let Ok(obj) = std::env::var("KUROCAT_YY_THUNKS_OBJ") {
            let trimmed = obj.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=KuroCat={}", trimmed);
                println!("cargo:rustc-link-arg-bin=KuroCat=/SUBSYSTEM:WINDOWS,6.01");
            }
        }
    }
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "pet",
        tauri_build::InlinedPlugin::new()
            .commands(PET_COMMANDS)
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
    ))
    .expect("failed to run tauri-build");
}

/// 宠物插件的命令清单；必须与 src/pet/mod.rs 的 COMMANDS 一致（有测试检查）。
const PET_COMMANDS: &[&str] = &[
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
