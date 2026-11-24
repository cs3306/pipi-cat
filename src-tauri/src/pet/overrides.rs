//! 默认皮肤（内置黑猫/布偶）的覆盖：内置外观永不被修改，覆盖另存为一份文件，渲染前先查覆盖。
//! 决定逻辑（用哪个、撤销怎么走）在 pet-core::overrides（有单测）；这里只做读写文件和 JSON。
//!
//! 文件：app_data/overrides/<id>.json（当前覆盖）、<id>.json.bak（上一代，只留一代）。
//! 覆盖内容：{ "schema":1, "baseVersion":N, "palette":{...同颜色皮肤的字段...} }。
//! 覆盖是不可信输入：每次读取都重新校验，任何问题都退回内置外观（第四层回滚）。

use super::skins::palette_errors;
use crate::cats::CatSkinConfig;
use pet_core::overrides::{self as oc, Backup, LoadDecision, UndoAction};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

const NONE_MARK: &str = "{\"none\":true}";
/// 覆盖不允许改的字段：身份由内置决定。
const PROTECTED: [&str; 4] = ["id", "name", "builtin", "emoji"];

fn dir() -> PathBuf {
    crate::config::app_data_dir().join("overrides")
}
fn cur_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.json"))
}
fn bak_path(id: &str) -> PathBuf {
    dir().join(format!("{id}.json.bak"))
}

fn check_id(id: &str) -> Result<(), String> {
    if oc::is_overridable(id) {
        Ok(())
    } else {
        Err("not-overridable".into())
    }
}

fn builtin(id: &str) -> Option<CatSkinConfig> {
    crate::cats::builtin_cats().into_iter().find(|c| c.id == id)
}

/// 把覆盖的 palette 叠到内置外观上，得到最终的猫。失败返回 None（调用方退回内置）。
fn merged(base: &CatSkinConfig, palette: &Map<String, Value>) -> Option<CatSkinConfig> {
    let mut v = serde_json::to_value(base).ok()?;
    let obj = v.as_object_mut()?;
    for (k, val) in palette {
        if PROTECTED.contains(&k.as_str()) {
            continue;
        }
        obj.insert(k.clone(), val.clone());
    }
    let mut cat: CatSkinConfig = serde_json::from_value(v).ok()?;
    cat.id = base.id.clone();
    cat.name = base.name.clone();
    cat.emoji = base.emoji.clone();
    cat.builtin = true;
    Some(cat)
}

/// 取出并校验覆盖文件里的 palette。Err = 文件存在但不可用。
fn read_override(id: &str) -> Result<(u32, Map<String, Value>), String> {
    let text = std::fs::read_to_string(cur_path(id)).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("bad-schema".into());
    }
    let base_version = v.get("baseVersion").and_then(Value::as_u64).unwrap_or(0) as u32;
    let pal = v.get("palette").cloned().ok_or("no-palette")?;
    let errs = palette_errors(&pal);
    if !errs.is_empty() {
        return Err(errs.join(","));
    }
    let map = pal.as_object().cloned().ok_or("palette-not-object")?;
    let b = builtin(id).ok_or("no-builtin")?;
    merged(&b, &map).ok_or("does-not-fit-cat")?;
    Ok((base_version, map))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub name: String,
    /// 当前正在使用覆盖外观
    pub active: bool,
    /// 有覆盖文件（即使因停用而没有生效）
    pub has_override: bool,
    pub needs_review: bool,
    pub corrupt: bool,
    pub can_undo: bool,
}

fn backup_kind(id: &str) -> Backup {
    match std::fs::read_to_string(bak_path(id)) {
        Err(_) => Backup::None,
        Ok(t) if t.trim() == NONE_MARK => Backup::WasBuiltin,
        Ok(_) => Backup::WasOverride,
    }
}

fn decision(id: &str, ignored: bool) -> (LoadDecision, Option<(u32, Map<String, Value>)>) {
    let exists = cur_path(id).exists();
    if !exists || ignored {
        return (oc::decide_load(exists, ignored, true, 0, oc::BUILTIN_LOOK_VERSION), None);
    }
    match read_override(id) {
        Ok((bv, map)) => (oc::decide_load(true, false, true, bv, oc::BUILTIN_LOOK_VERSION), Some((bv, map))),
        Err(_) => (oc::decide_load(true, false, false, 0, oc::BUILTIN_LOOK_VERSION), None),
    }
}

pub fn status() -> Vec<Status> {
    let ignored = super::settings::load().ignore_overrides;
    oc::OVERRIDABLE
        .iter()
        .filter_map(|id| {
            let b = builtin(id)?;
            let (d, _) = decision(id, ignored);
            Some(Status {
                id: (*id).into(),
                name: b.name,
                active: matches!(d, LoadDecision::UseOverride | LoadDecision::UseOverrideNeedsReview),
                has_override: cur_path(id).exists(),
                needs_review: d == LoadDecision::UseOverrideNeedsReview,
                corrupt: d == LoadDecision::FallbackCorrupt,
                can_undo: oc::plan_undo(backup_kind(id)) != UndoAction::Nothing,
            })
        })
        .collect()
}

/// 给 cats::all_cats 用：把有效的覆盖应用到内置猫上。任何问题都保持内置不变。
pub fn apply(list: &mut [CatSkinConfig]) {
    let ignored = super::settings::load().ignore_overrides;
    for cat in list.iter_mut() {
        if !cat.builtin || !oc::is_overridable(&cat.id) {
            continue;
        }
        if let (_, Some((_, map))) = decision(&cat.id, ignored) {
            if let Some(m) = merged(cat, &map) {
                *cat = m;
            }
        }
    }
}

fn write_atomic(path: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn clean_palette(pal: &Value) -> Result<Map<String, Value>, Vec<String>> {
    let errs = palette_errors(pal);
    if !errs.is_empty() {
        return Err(errs);
    }
    let mut map = pal.as_object().cloned().ok_or_else(|| vec!["palette-not-object".to_string()])?;
    for k in PROTECTED {
        map.remove(k);
    }
    Ok(map)
}

pub fn save(id: &str, palette: &Value) -> Result<(), Vec<String>> {
    check_id(id).map_err(|e| vec![e])?;
    let map = clean_palette(palette)?;
    let b = builtin(id).ok_or_else(|| vec!["no-builtin".to_string()])?;
    merged(&b, &map).ok_or_else(|| vec!["does-not-fit-cat".to_string()])?;

    let had_current = cur_path(id).exists();
    // 先备份上一代，再写新文件；中途失败最坏也只是多一份备份。
    match oc::backup_before_save(had_current) {
        Backup::WasOverride => {
            std::fs::copy(cur_path(id), bak_path(id)).map_err(|e| vec![format!("io:{e}")])?;
        }
        _ => write_atomic(&bak_path(id), NONE_MARK).map_err(|e| vec![format!("io:{e}")])?,
    }
    let doc = json!({ "schema": 1, "baseVersion": oc::BUILTIN_LOOK_VERSION, "palette": Value::Object(map) });
    write_atomic(&cur_path(id), &doc.to_string()).map_err(|e| vec![format!("io:{e}")])
}

/// 第一层：撤销上一次。只回退一代。
pub fn undo(id: &str) -> Result<bool, String> {
    check_id(id)?;
    match oc::plan_undo(backup_kind(id)) {
        UndoAction::Nothing => Ok(false),
        UndoAction::RemoveCurrent => {
            let _ = std::fs::remove_file(cur_path(id));
            let _ = std::fs::remove_file(bak_path(id));
            Ok(true)
        }
        UndoAction::RestoreBackup => {
            std::fs::rename(bak_path(id), cur_path(id)).map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

/// 第二层：恢复这只猫的默认外观。当前覆盖移进备份槽，所以还能「撤销」回来。
pub fn reset(id: &str) -> Result<bool, String> {
    check_id(id)?;
    if oc::backup_before_reset(cur_path(id).exists()).is_none() {
        return Ok(false);
    }
    std::fs::rename(cur_path(id), bak_path(id)).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 第三层：恢复全部默认，连备份一起清掉，无法撤销（界面上要先确认）。
pub fn reset_all() -> usize {
    let mut n = 0;
    for id in oc::OVERRIDABLE {
        if std::fs::remove_file(cur_path(id)).is_ok() {
            n += 1;
        }
        let _ = std::fs::remove_file(bak_path(id));
    }
    n
}

/// 新版本改了内置外观后，用户选择「保留我的修改」：把基于的版本号更新到当前。
pub fn keep(id: &str) -> Result<(), String> {
    check_id(id)?;
    let (_, map) = read_override(id)?;
    let doc = json!({ "schema": 1, "baseVersion": oc::BUILTIN_LOOK_VERSION, "palette": Value::Object(map) });
    write_atomic(&cur_path(id), &doc.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub id: String,
    pub name: String,
    /// 内置外观的颜色配置（起点）。
    pub builtin: Value,
    /// 当前覆盖（若有且有效）。
    #[serde(rename = "override")]
    pub overridden: Option<Value>,
}

fn palette_value(c: &CatSkinConfig) -> Value {
    let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        for k in PROTECTED {
            o.remove(k);
        }
    }
    v
}

/// 制作器的起点：任何颜色型内置猫的颜色配置；可覆盖的两只再带上当前覆盖。
pub fn look(id: &str) -> Result<Look, String> {
    if !oc::is_copyable_builtin(id) {
        return Err("not-copyable".into());
    }
    let b = builtin(id).ok_or("no-builtin")?;
    let overridden = if oc::is_overridable(id) {
        read_override(id).ok().and_then(|(_, map)| merged(&b, &map)).map(|c| palette_value(&c))
    } else {
        None
    };
    Ok(Look { id: id.into(), name: b.name.clone(), builtin: palette_value(&b), overridden })
}

/// 当前是否停用了覆盖（托盘「使用内置外观」）。
pub fn ignored() -> bool {
    super::settings::load().ignore_overrides
}

/// 通知所有窗口重新取猫列表与皮肤。
pub fn refresh(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("kuro-cats", crate::cats::all_cats());
    let _ = app.emit("kuro-skins-changed", json!({ "id": Value::Null }));
}

/// 停用 / 重新启用覆盖。覆盖文件不动，随时可切回来。
pub fn set_ignore(app: &tauri::AppHandle, on: bool) {
    use tauri::Emitter;
    let snapshot = {
        let mut s = super::settings::load();
        s.ignore_overrides = on;
        super::settings::save(&s);
        if let Some(r) = super::state::try_rt() {
            *r.settings.lock().unwrap() = s.clone();
        }
        s
    };
    let _ = app.emit("kuro-pet-settings", &snapshot);
    refresh(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn black() -> CatSkinConfig {
        crate::cats::builtin_cats().into_iter().find(|c| c.id == "black").unwrap()
    }

    #[test]
    fn merge_keeps_identity_and_overlays_colors() {
        let map: Map<String, Value> =
            serde_json::from_value(json!({ "furColor": "#112233", "id": "evil", "name": "X", "builtin": false })).unwrap();
        let m = merged(&black(), &map).unwrap();
        assert_eq!(m.fur_color, "#112233");
        assert_eq!(m.id, "black");
        assert_ne!(m.name, "X");
        assert!(m.builtin);
    }

    #[test]
    fn null_in_override_clears_optional_color() {
        let map: Map<String, Value> = serde_json::from_value(json!({ "furColor": "#112233", "noseColor": null })).unwrap();
        assert!(merged(&black(), &map).unwrap().nose_color.is_none());
    }

    #[test]
    fn clean_palette_rejects_bad_colors_and_strips_identity() {
        assert!(clean_palette(&json!({ "furColor": "red" })).is_err());
        let ok = clean_palette(&json!({ "furColor": "#aabbcc", "id": "x", "emoji": "x" })).unwrap();
        assert!(!ok.contains_key("id") && !ok.contains_key("emoji"));
    }

    #[test]
    fn only_allowlisted_ids_are_accepted() {
        assert!(check_id("black").is_ok());
        assert!(check_id("dafeiyu").is_err());
        assert!(check_id("../../x").is_err());
    }
}
