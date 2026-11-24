//! 前端可调用的命令（插件 "pet"，前端用 `invoke("plugin:pet|<name>")`）。
//! 新增命令时，同时更新 `mod.rs` 的 `COMMANDS` 和 `build.rs` 里的列表（有测试检查二者一致）。

use super::model::TaskDto;
use super::platform;
use super::settings::{self, PetSettings};
use super::shutdown;
use super::skins;
use super::state::{build_task_rt, focus_cfg, rt, save_game, save_tasks, status_json, wall_secs};
use pet_core::economy;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn pet_get_settings() -> PetSettings {
    rt().settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn pet_update_settings(app: AppHandle, mut patch: PetSettings) -> PetSettings {
    patch.sanitize();
    let r = rt();
    // 「停用覆盖」只能通过 skin_override_ignore / 托盘切换；设置页带回来的旧值不能把它改回去。
    patch.ignore_overrides = r.settings.lock().unwrap().ignore_overrides;
    *r.settings.lock().unwrap() = patch.clone();
    settings::save(&patch);
    r.focus.lock().unwrap().set_config(focus_cfg(&patch));
    *r.meow_next.lock().unwrap() = 0; // 频率变了就重新抽签
    super::files::apply(&app, patch.file_reactions, &patch.watch_folders);
    let _ = app.emit("kuro-pet-settings", &patch);
    patch
}

#[tauri::command]
pub fn pet_status() -> Value {
    status_json(rt())
}

#[tauri::command]
pub fn focus_start(app: AppHandle) -> Value {
    let r = rt();
    let now = r.start.elapsed().as_secs();
    let events = r.focus.lock().unwrap().start(now);
    if !events.is_empty() {
        *r.focus_wall_start.lock().unwrap() = wall_secs();
        r.sedentary.lock().unwrap().reset(now);
    }
    let s = status_json(r);
    let _ = app.emit("kuro-focus", &s);
    s
}

#[tauri::command]
pub fn focus_cancel(app: AppHandle) -> Value {
    let r = rt();
    let now = r.start.elapsed().as_secs();
    r.focus.lock().unwrap().cancel(now);
    let s = status_json(r);
    let _ = app.emit("kuro-focus", &s);
    s
}

#[tauri::command]
pub fn buy_snack(app: AppHandle, id: String) -> Result<Value, String> {
    let r = rt();
    let snack = {
        let mut g = r.game.lock().unwrap();
        match economy::buy(&mut g, &id) {
            Ok(s) => s,
            Err(economy::BuyError::Unknown) => return Err("unknown-snack".into()),
            Err(economy::BuyError::Insufficient { need }) => return Err(format!("insufficient-coins:{need}")),
        }
    };
    save_game(r);
    let g = r.game.lock().unwrap().clone();
    let _ = app.emit("kuro-game", json!({ "coins": g.coins, "completed": g.completed }));
    let _ = app.emit("kuro-snack", json!({ "id": snack.id, "animation": snack.animation }));
    Ok(json!({ "coins": g.coins, "id": snack.id }))
}

#[tauri::command]
pub fn snack_catalog() -> Value {
    json!(economy::SNACKS
        .iter()
        .map(|s| json!({ "id": s.id, "price": s.price }))
        .collect::<Vec<_>>())
}

#[tauri::command]
pub fn tasks_get() -> Vec<TaskDto> {
    rt().tasks.lock().unwrap().iter().map(|t| t.dto.clone()).collect()
}

#[tauri::command]
pub fn tasks_save(list: Vec<TaskDto>) -> Result<(), String> {
    if list.len() > 100 {
        return Err("too many tasks (max 100)".into());
    }
    let mut seen = std::collections::HashSet::new();
    for t in &list {
        if !seen.insert(t.id.clone()) {
            return Err(format!("duplicate id: {}", t.id));
        }
        let errs = t.validate();
        if !errs.is_empty() {
            return Err(format!("{}: {}", t.id, errs.join("; ")));
        }
    }
    save_tasks(&list);
    *rt().tasks.lock().unwrap() = build_task_rt(list);
    Ok(())
}

#[tauri::command]
pub fn reminder_snooze(id: String, minutes: u32) {
    let r = rt();
    let dto = r.tasks.lock().unwrap().iter().find(|t| t.dto.id == id).map(|t| t.dto.clone());
    if let Some(dto) = dto {
        let at = wall_secs() + minutes.clamp(1, 120) as i64 * 60;
        r.snoozes.lock().unwrap().push((dto, at));
    }
}

fn meow_dir() -> std::path::PathBuf {
    crate::config::app_data_dir().join("meow")
}

#[tauri::command]
pub fn list_meow_files() -> Vec<String> {
    let dir = meow_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".wav") || lower.ends_with(".mp3") || lower.ends_with(".ogg") {
                out.push(name);
            }
        }
    }
    out.sort();
    out.truncate(50);
    out
}

#[tauri::command]
pub fn read_meow_file(name: String) -> Result<Vec<u8>, String> {
    // 只接受文件夹内的简单文件名，防路径穿越
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.is_empty() {
        return Err("invalid file name".into());
    }
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".wav") || lower.ends_with(".mp3") || lower.ends_with(".ogg")) {
        return Err("unsupported file type".into());
    }
    let path = meow_dir().join(&name);
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 1_500_000 {
        return Err("file too large (max 1.5 MB)".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_meow_folder() -> Result<(), String> {
    let dir = meow_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    platform::open_folder(&dir)
}

// 定时关机
#[tauri::command]
pub fn shutdown_schedule(app: AppHandle, seconds: u64, force: bool) -> Result<Value, String> {
    let v = shutdown::schedule(seconds, force)?;
    let _ = app.emit("kuro-shutdown", &v);
    Ok(v)
}

#[tauri::command]
pub fn shutdown_cancel(app: AppHandle) -> Result<Value, String> {
    let v = shutdown::cancel()?;
    let _ = app.emit("kuro-shutdown", &v);
    Ok(v)
}

#[tauri::command]
pub fn shutdown_status() -> Value {
    shutdown::status()
}

/// 打开设置窗口（托盘与右键菜单也用）。
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    super::window::open_settings_window(app).await
}

// ───────── 皮肤包 ─────────

fn skin_err(errs: Vec<String>) -> String {
    errs.join(",")
}

/// 只校验，不写入。成功返回摘要；失败返回逗号分隔的错误码。
#[tauri::command]
pub fn skin_inspect(json: String) -> Result<skins::Summary, String> {
    skins::inspect(&json).map_err(skin_err)
}

#[tauri::command]
pub fn skin_install(app: AppHandle, json: String) -> Result<skins::Summary, String> {
    let s = skins::install(&json).map_err(skin_err)?;
    let _ = app.emit("kuro-skins-changed", json!({ "id": s.id }));
    Ok(s)
}

#[tauri::command]
pub fn skin_list() -> Vec<skins::Summary> {
    skins::list()
}

#[tauri::command]
pub fn skin_remove(app: AppHandle, id: String) -> Result<bool, String> {
    let removed = skins::remove(&id)?;
    let _ = app.emit("kuro-skins-changed", json!({ "id": id }));
    Ok(removed)
}

/// 图片皮肤的各槽位图片（data URI）。
#[tauri::command]
pub fn skin_sprites(id: String) -> Result<std::collections::BTreeMap<String, String>, String> {
    skins::sprites(&id)
}

// ───────── 皮肤制作器 ─────────

/// `target` 可选：`builtin:<id>` / `override:<id>` / `skin:<id>`，让制作器直接打开对应起点。
#[tauri::command]
pub async fn open_maker(app: AppHandle, target: Option<String>) -> Result<(), String> {
    super::window::open_maker_window(app, target).await
}

#[tauri::command]
pub fn maker_ai_get_config() -> super::maker_ai::PublicConfig {
    super::maker_ai::get_config()
}

/// `api_key`：不传 = 不改；传空串 = 清除。
#[tauri::command]
pub fn maker_ai_set_config(
    base_url: String,
    model: String,
    remember: bool,
    api_key: Option<String>,
) -> Result<super::maker_ai::PublicConfig, String> {
    super::maker_ai::set_config(base_url, model, remember, api_key)
}

/// 生成颜色皮肤的调色板（已校验）。只有用户点击「生成」才会调用。
#[tauri::command]
pub async fn maker_ai_palette(prompt: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || super::maker_ai::generate(&prompt))
        .await
        .map_err(|e| e.to_string())?
}

/// 分层皮肤：取回（已重新校验的）rig；其他种类返回 null。
#[tauri::command]
pub fn skin_rig(id: String) -> Result<Value, String> {
    super::skins::rig_of(&id).map(|v| v.unwrap_or(Value::Null))
}

// ───────── 皮肤文件管理 ─────────

/// 已安装皮肤的原文（制作器打开、「重新安装」确认卡用）。
#[tauri::command]
pub fn skin_read(id: String) -> Result<String, String> {
    skins::read_text(&id)
}

/// 回退到上一代（同 id 更新过才有）。
#[tauri::command]
pub fn skin_rollback(app: AppHandle, id: String) -> Result<skins::Summary, String> {
    let s = skins::rollback(&id)?;
    let _ = app.emit("kuro-skins-changed", json!({ "id": s.id }));
    Ok(s)
}

#[tauri::command]
pub fn skin_open_folder() -> Result<(), String> {
    skins::open_folder()
}

// ───────── 默认皮肤：覆盖与回滚 ─────────

#[tauri::command]
pub fn skin_override_status() -> Vec<super::overrides::Status> {
    super::overrides::status()
}

/// 制作器的起点：内置猫的颜色配置（以及可覆盖的两只当前的覆盖）。
#[tauri::command]
pub fn skin_builtin_look(id: String) -> Result<super::overrides::Look, String> {
    super::overrides::look(&id)
}

#[tauri::command]
pub fn skin_override_save(app: AppHandle, id: String, palette: Value) -> Result<(), String> {
    super::overrides::save(&id, &palette).map_err(skin_err)?;
    super::overrides::refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn skin_override_undo(app: AppHandle, id: String) -> Result<bool, String> {
    let r = super::overrides::undo(&id)?;
    super::overrides::refresh(&app);
    Ok(r)
}

#[tauri::command]
pub fn skin_override_reset(app: AppHandle, id: String) -> Result<bool, String> {
    let r = super::overrides::reset(&id)?;
    super::overrides::refresh(&app);
    Ok(r)
}

#[tauri::command]
pub fn skin_override_reset_all(app: AppHandle) -> usize {
    let n = super::overrides::reset_all();
    super::overrides::refresh(&app);
    n
}

#[tauri::command]
pub fn skin_override_keep(app: AppHandle, id: String) -> Result<(), String> {
    super::overrides::keep(&id)?;
    super::overrides::refresh(&app);
    Ok(())
}

/// 停用 / 重新启用对默认皮肤的覆盖（托盘同款开关）。
#[tauri::command]
pub fn skin_override_ignore(app: AppHandle, ignore: bool) {
    super::overrides::set_ignore(&app, ignore);
}
