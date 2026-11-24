//! 皮肤包（.petskin）：安装、列出、删除。皮肤包是单个 JSON 文件，图片以 data URI 内嵌。
//!
//! 安全：皮肤包是不可信输入，只允许「数据」——颜色 JSON 或 PNG/WebP 图片，没有脚本。
//! 校验规则在 pet-core::skin（有单测）：id 格式、必填作者与许可证、图片看文件头、大小与尺寸上限。
//! 存放：app_data/skins/<id>.petskin（已校验的原文）。颜色皮肤另外注册进上游的自定义猫列表
//! （id = "skin-<id>"），这样它自动出现在猫的选择菜单里；图片皮肤用同一个 id 注册一个占位条目，
//! 前端发现 id 以 "skin-" 开头时再向本模块取图片。

use pet_core::rig::{self, PartFacts, RigFacts};
use pet_core::skin::{self, PackFacts};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

const MAX_PACK_BYTES: usize = 8_000_000; // 颜色/图片皮肤：4MB 图片 base64 后约 5.4MB，再加 JSON 余量
const MAX_LAYERED_BYTES: usize = rig::MAX_PACK_BYTES; // 分层皮肤：6MB 图片 base64 后约 8MB
const MAX_SPOTS: usize = 24;
pub const ID_PREFIX: &str = "skin-";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pack {
    schema: u32,
    id: String,
    name: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    license: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    kind: String,
    #[serde(default)]
    palette: Option<Value>,
    #[serde(default)]
    sprites: Option<BTreeMap<String, String>>,
    /// 分层皮肤：{ scale?, parts: { torso, head, limbs?, tail? } }，格式见 docs/skins/RIG-SPEC.md
    #[serde(default)]
    rig: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub cat_id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    pub version: String,
    pub description: String,
    pub kind: String,
    pub bytes: usize,
    pub installed: bool,
    /// 已登记进猫列表（cats.json）。手动复制进文件夹的皮肤是 false，需要走安装确认卡。
    pub registered: bool,
    /// 有上一代备份（同 id 更新过）可以回退。
    pub has_previous: bool,
}

fn skins_dir() -> PathBuf {
    crate::config::app_data_dir().join("skins")
}

fn pack_path(id: &str) -> PathBuf {
    skins_dir().join(format!("{id}.petskin"))
}

/// 上一代：同 id 再次安装时，旧文件改名保存在这里（只留一代；扩展名不是 .petskin，列表不会当成皮肤）。
fn prev_path(id: &str) -> PathBuf {
    skins_dir().join(format!("{id}.petskin.prev"))
}

fn is_registered(id: &str) -> bool {
    let cat_id = format!("{ID_PREFIX}{id}");
    crate::cats::load_custom_cats().iter().any(|c| c.id == cat_id)
}

fn write_atomic(path: &PathBuf, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// 递归检查：键名含 "color"（不分大小写）的字符串值必须是十六进制颜色。
fn check_colors(v: &Value, errs: &mut Vec<String>, path: &str) {
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                let p = format!("{path}.{k}");
                if k.to_ascii_lowercase().contains("color") {
                    match val {
                        Value::String(s) if skin::is_hex_color(s) => {}
                        Value::Null => {}
                        _ => errs.push(format!("bad-color:{p}")),
                    }
                } else {
                    check_colors(val, errs, &p);
                }
            }
        }
        Value::Array(a) => {
            for (i, val) in a.iter().enumerate() {
                check_colors(val, errs, &format!("{path}[{i}]"));
            }
        }
        _ => {}
    }
}

/// 颜色皮肤配置的统一校验（皮肤包、制作器 AI、MCP 的 upsert_cat 都走这里）。
pub fn palette_errors(pal: &Value) -> Vec<String> {
    let mut errs = Vec::new();
    check_colors(pal, &mut errs, "palette");
    if !pal.get("furColor").map(|v| v.is_string()).unwrap_or(false) {
        errs.push("palette-needs-furColor".into());
    }
    if let Some(v) = pal.get("schemaVersion") {
        if !matches!(v.as_u64(), Some(1) | Some(2)) {
            errs.push("bad-schemaVersion".into());
        }
    }
    if pal.get("spots").and_then(Value::as_array).map(|a| a.len() > MAX_SPOTS).unwrap_or(false) {
        errs.push("too-many-spots".into());
    }
    errs
}

// ───────── 分层皮肤（kind = "layered"）：把 rig JSON 摊平成 pet-core 能校验的形式 ─────────

fn num_pair(v: Option<&Value>) -> Option<[f64; 2]> {
    let a = v?.as_array()?;
    if a.len() != 2 {
        return None;
    }
    Some([a[0].as_f64()?, a[1].as_f64()?])
}

/// 解码一张 data URI 图片并登记；返回是否存在该图片字段。
fn take_image(name: &str, v: Option<&Value>, images: &mut Vec<(String, Vec<u8>)>, errs: &mut Vec<String>) -> bool {
    let Some(text) = v.and_then(Value::as_str) else { return false };
    match skin::strip_data_uri(text).map(skin::b64_decode) {
        Some(Ok(bytes)) => {
            images.push((name.to_string(), bytes));
            true
        }
        Some(Err(e)) => {
            errs.push(format!("{e}:{name}"));
            true
        }
        None => {
            errs.push(format!("not-a-data-uri:{name}"));
            true
        }
    }
}

/// `top` = 顶层部位（有 attach / z / segments）；分段（segment）必须有 end。
fn read_part(name: &str, v: &Value, top: bool, parts: &mut Vec<PartFacts>, images: &mut Vec<(String, Vec<u8>)>, errs: &mut Vec<String>) {
    let Some(obj) = v.as_object() else {
        errs.push(format!("bad-part:{name}"));
        return;
    };
    let segs: Vec<&Value> = if top {
        obj.get("segments").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
    } else {
        Vec::new()
    };
    let has_image = take_image(name, obj.get("image"), images, errs);
    if !has_image && segs.is_empty() {
        errs.push(format!("missing-image:{name}"));
    }
    let pivot = match obj.get("pivot") {
        None => [0.5, 0.5],
        Some(p) => num_pair(Some(p)).unwrap_or_else(|| {
            errs.push(format!("bad-pivot:{name}"));
            [0.5, 0.5]
        }),
    };
    let end = match obj.get("end") {
        None => None,
        Some(p) => {
            let e = num_pair(Some(p));
            if e.is_none() {
                errs.push(format!("bad-end:{name}"));
            }
            e
        }
    };
    if !top && end.is_none() && !errs.iter().any(|e| e == &format!("bad-end:{name}")) {
        errs.push(format!("missing-end:{name}"));
    }
    let attach = if top {
        match obj.get("attach") {
            None => Some([0.0, 0.0]),
            Some(p) => Some(num_pair(Some(p)).unwrap_or_else(|| {
                errs.push(format!("bad-attach:{name}"));
                [0.0, 0.0]
            })),
        }
    } else {
        None
    };
    let z = if top {
        match obj.get("z") {
            None => Some(0),
            Some(z) => Some(z.as_i64().unwrap_or_else(|| {
                errs.push(format!("bad-z:{name}"));
                0
            })),
        }
    } else {
        None
    };
    parts.push(PartFacts { name: name.to_string(), pivot, end, attach, z, segments: segs.len() });

    if name == "head" {
        for k in ["eyesClosedImage", "mouthOpenImage"] {
            take_image(&format!("head.{k}"), obj.get(k), images, errs);
        }
    }
    for (i, sv) in segs.iter().take(rig::MAX_SEGMENTS).enumerate() {
        read_part(&format!("{name}.seg{i}"), sv, false, parts, images, errs);
    }
}

fn check_rig(rig_json: Option<&Value>) -> (Vec<String>, Vec<(String, Vec<u8>)>) {
    let mut errs = Vec::new();
    let mut images: Vec<(String, Vec<u8>)> = Vec::new();
    let Some(r) = rig_json.and_then(Value::as_object) else {
        return (vec!["rig-missing".into()], images);
    };
    let scale = r.get("scale").and_then(Value::as_f64).unwrap_or(1.0);
    let mut parts: Vec<PartFacts> = Vec::new();
    let Some(p) = r.get("parts").and_then(Value::as_object) else {
        return (vec!["rig-missing".into()], images);
    };
    for key in ["torso", "head", "tail"] {
        if let Some(v) = p.get(key) {
            read_part(key, v, true, &mut parts, &mut images, &mut errs);
        }
    }
    if let Some(limbs) = p.get("limbs").and_then(Value::as_object) {
        for (k, v) in limbs {
            if matches!(k.as_str(), "fl" | "fr" | "hl" | "hr") {
                read_part(&format!("limb.{k}"), v, true, &mut parts, &mut images, &mut errs);
            } else {
                errs.push(format!("unknown-limb:{k}"));
            }
        }
    }
    for k in p.keys() {
        if !matches!(k.as_str(), "torso" | "head" | "tail" | "limbs") {
            errs.push(format!("unknown-part:{k}"));
        }
    }
    let facts = RigFacts { scale, parts, images: images.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect() };
    errs.extend(rig::validate_rig(&facts));
    (errs, images)
}

struct Checked {
    pack: Pack,
    /// 已解码并校验通过的图片字节（仅图片皮肤）
    images: Vec<(String, Vec<u8>)>,
}

fn check(text: &str) -> Result<Checked, Vec<String>> {
    if text.len() > MAX_LAYERED_BYTES {
        return Err(vec!["pack-too-large".into()]);
    }
    let pack: Pack = serde_json::from_str(text).map_err(|e| vec![format!("invalid-json:{e}")])?;
    let mut errs = Vec::new();
    if pack.kind != "layered" && text.len() > MAX_PACK_BYTES {
        return Err(vec!["pack-too-large".into()]);
    }

    let mut images: Vec<(String, Vec<u8>)> = Vec::new();
    if let Some(map) = &pack.sprites {
        if map.len() > 8 {
            errs.push("too-many-images".into());
        }
        for (slot, uri) in map.iter().take(8) {
            match skin::strip_data_uri(uri).map(skin::b64_decode) {
                Some(Ok(bytes)) => images.push((slot.clone(), bytes)),
                Some(Err(e)) => errs.push(format!("{e}:{slot}")),
                None => errs.push(format!("not-a-data-uri:{slot}")),
            }
        }
    }

    let facts = PackFacts {
        schema: pack.schema,
        id: &pack.id,
        name: &pack.name,
        author: &pack.author,
        license: &pack.license,
        version: &pack.version,
        kind: &pack.kind,
        has_palette: pack.palette.is_some(),
        images: images.iter().map(|(s, b)| (s.as_str(), b.as_slice())).collect(),
    };
    errs.extend(skin::validate(&facts));

    if let Some(pal) = &pack.palette {
        errs.extend(palette_errors(pal));
    }
    if pack.kind == "layered" {
        errs.extend(check_rig(pack.rig.as_ref()).0);
    }
    if errs.is_empty() {
        Ok(Checked { pack, images })
    } else {
        Err(errs)
    }
}

fn summarize(c: &Checked, len: usize) -> Summary {
    Summary {
        id: c.pack.id.clone(),
        cat_id: format!("{ID_PREFIX}{}", c.pack.id),
        name: c.pack.name.trim().to_string(),
        author: c.pack.author.trim().to_string(),
        license: c.pack.license.trim().to_string(),
        version: c.pack.version.trim().to_string(),
        description: c.pack.description.chars().take(300).collect(),
        kind: c.pack.kind.clone(),
        bytes: len,
        installed: pack_path(&c.pack.id).exists(),
        registered: is_registered(&c.pack.id),
        has_previous: prev_path(&c.pack.id).exists(),
    }
}

/// 只校验，不写入（供安装前的确认界面使用）。
pub fn inspect(text: &str) -> Result<Summary, Vec<String>> {
    check(text).map(|c| summarize(&c, text.len()))
}

/// 注册进上游的自定义猫列表。颜色皮肤用皮肤包里的 palette；图片皮肤用中性占位颜色。
fn register_cat(c: &Checked) -> Result<(), String> {
    let cat_id = format!("{ID_PREFIX}{}", c.pack.id);
    let mut v = match (&c.pack.palette, c.pack.kind.as_str()) {
        (Some(p), "palette") => p.clone(),
        _ => json!({ "furColor": "#8a8a8a" }),
    };
    let obj = v.as_object_mut().ok_or("palette must be an object")?;
    obj.insert("id".into(), json!(cat_id));
    obj.insert("name".into(), json!(c.pack.name.trim()));
    obj.insert("builtin".into(), json!(false));
    if c.pack.kind == "sprites" {
        obj.insert("emoji".into(), json!("🖼"));
    } else if c.pack.kind == "layered" {
        obj.insert("emoji".into(), json!("🎭"));
    }
    let cat: crate::cats::CatSkinConfig = serde_json::from_value(v).map_err(|e| format!("invalid palette: {e}"))?;
    crate::cats::upsert_custom_cat(cat).map(|_| ())
}

pub fn install(text: &str) -> Result<Summary, Vec<String>> {
    let c = check(text)?;
    register_cat(&c).map_err(|e| vec![format!("register-failed:{e}")])?;
    let dir = skins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| vec![format!("io:{e}")])?;
    // 同 id 更新：先把现有文件留作上一代（只留一代），再原子写入新文件。
    let target = pack_path(&c.pack.id);
    if target.exists() {
        let _ = std::fs::copy(&target, prev_path(&c.pack.id));
    }
    write_atomic(&target, text).map_err(|e| vec![format!("io:{e}")])?;
    let mut s = summarize(&c, text.len());
    s.installed = true;
    Ok(s)
}

/// 猫列表里有 `skin-` 条目但皮肤文件已不存在（用户在文件夹里手动删了）：清掉悬空条目。
/// 只做删除，从不「发现」新文件——新文件必须走安装确认卡。
pub fn drop_orphans() {
    for c in crate::cats::load_custom_cats() {
        let Some(id) = c.id.strip_prefix(ID_PREFIX) else { continue };
        if skin::is_valid_id(id) && !pack_path(id).exists() {
            let _ = crate::cats::delete_custom_cat(&c.id);
        }
    }
}

pub fn list() -> Vec<Summary> {
    drop_orphans();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(skins_dir()) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("petskin") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(c) = check(&text) {
                out.push(summarize(&c, text.len()));
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 读出已安装皮肤的原文（重新校验过），供制作器打开、「重新安装」确认卡使用。
pub fn read_text(id: &str) -> Result<String, String> {
    if !skin::is_valid_id(id) {
        return Err("bad-id".into());
    }
    let text = std::fs::read_to_string(pack_path(id)).map_err(|e| e.to_string())?;
    check(&text).map_err(|e| e.join(","))?;
    Ok(text)
}

/// 回退到上一代。当前版本变成新的「上一代」，所以可以来回切换。
pub fn rollback(id: &str) -> Result<Summary, String> {
    if !skin::is_valid_id(id) {
        return Err("bad-id".into());
    }
    let prev_text = std::fs::read_to_string(prev_path(id)).map_err(|_| "no-previous".to_string())?;
    let c = check(&prev_text).map_err(|e| e.join(","))?;
    if c.pack.id != id {
        return Err("id-mismatch".into());
    }
    register_cat(&c)?;
    let cur = pack_path(id);
    let current_text = std::fs::read_to_string(&cur).ok();
    write_atomic(&cur, &prev_text).map_err(|e| e.to_string())?;
    match current_text {
        Some(t) => {
            let _ = write_atomic(&prev_path(id), &t);
        }
        None => {
            let _ = std::fs::remove_file(prev_path(id));
        }
    }
    let mut s = summarize(&c, prev_text.len());
    s.installed = true;
    Ok(s)
}

/// 在资源管理器里打开皮肤文件夹（不存在就先建）。
pub fn open_folder() -> Result<(), String> {
    let dir = skins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let r = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("/usr/bin/open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&dir).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

pub fn remove(id: &str) -> Result<bool, String> {
    if !skin::is_valid_id(id) {
        return Err("bad-id".into());
    }
    let _ = std::fs::remove_file(prev_path(id));
    let _ = crate::cats::delete_custom_cat(&format!("{ID_PREFIX}{id}"));
    match std::fs::remove_file(pack_path(id)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// 图片皮肤：返回各槽位的 data URI（已重新校验过）。颜色皮肤返回空表。
pub fn sprites(id: &str) -> Result<BTreeMap<String, String>, String> {
    if !skin::is_valid_id(id) {
        return Err("bad-id".into());
    }
    let text = std::fs::read_to_string(pack_path(id)).map_err(|e| e.to_string())?;
    let c = check(&text).map_err(|e| e.join(","))?;
    Ok(if c.pack.kind == "sprites" { c.pack.sprites.unwrap_or_default() } else { BTreeMap::new() })
}

/// 分层皮肤：返回已重新校验过的 rig（含内嵌图片）。其他种类返回 None。
pub fn rig_of(id: &str) -> Result<Option<Value>, String> {
    if !skin::is_valid_id(id) {
        return Err("bad-id".into());
    }
    let text = std::fs::read_to_string(pack_path(id)).map_err(|e| e.to_string())?;
    let c = check(&text).map_err(|e| e.join(","))?;
    Ok(if c.pack.kind == "layered" { c.pack.rig } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette_pack(extra: &str) -> String {
        format!(
            r##"{{"schema":1,"id":"sunny-cat","name":"Sunny","author":"me","license":"CC-BY-4.0","version":"1.0.0","kind":"palette","palette":{{"furColor":"#ffcc00","eyeColorTop":"#00ff00","spots":[{{"part":"head","x":0,"y":0,"rx":1,"ry":1,"color":"#fff"}}]{extra}}}}}"##
        )
    }

    #[test]
    fn valid_palette_pack_is_accepted() {
        let s = inspect(&palette_pack("")).unwrap();
        assert_eq!(s.cat_id, "skin-sunny-cat");
        assert_eq!(s.kind, "palette");
    }

    #[test]
    fn non_hex_colors_are_rejected_everywhere() {
        let errs = inspect(&palette_pack(r#","tailColor":"url(javascript:alert(1))""#)).unwrap_err();
        assert!(errs.iter().any(|e| e.starts_with("bad-color:palette.tailColor")));
        let bad_spot = palette_pack("").replace(r##""color":"#fff""##, r#""color":"red""#);
        assert!(inspect(&bad_spot).unwrap_err().iter().any(|e| e.contains("spots[0].color")));
    }

    #[test]
    fn palette_errors_is_shared_by_all_entry_points() {
        let ok: Value = serde_json::from_str(r##"{"furColor":"#fff","spots":[]}"##).unwrap();
        assert!(palette_errors(&ok).is_empty());
        let bad: Value = serde_json::from_str(r#"{"furColor":"red"}"#).unwrap();
        assert!(!palette_errors(&bad).is_empty());
        let none: Value = serde_json::from_str("{}").unwrap();
        assert!(palette_errors(&none).contains(&"palette-needs-furColor".to_string()));
    }

    #[test]
    fn rejects_garbage_and_oversize() {
        assert!(inspect("not json").unwrap_err()[0].starts_with("invalid-json"));
        assert_eq!(inspect(&" ".repeat(MAX_PACK_BYTES + 1)).unwrap_err(), vec!["pack-too-large"]);
    }

    // 1x1 PNG（真实文件头），用于分层皮肤测试
    const PNG1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    fn layered_pack(extra_parts: &str) -> String {
        let img = format!("data:image/png;base64,{PNG1}");
        format!(
            r##"{{"schema":1,"id":"my-rig","name":"Rig","author":"me","license":"CC-BY-4.0","version":"1.0.0","kind":"layered","rig":{{"scale":1,"parts":{{"torso":{{"image":"{img}","pivot":[0.5,1],"attach":[0,0],"z":10}},"head":{{"image":"{img}","pivot":[0.5,0.9],"attach":[0,-100],"z":20}}{extra_parts}}}}}}}"##
        )
    }

    #[test]
    fn minimal_layered_pack_is_accepted_and_registers_as_layered() {
        let s = inspect(&layered_pack("")).unwrap();
        assert_eq!(s.kind, "layered");
        assert_eq!(s.cat_id, "skin-my-rig");
    }

    #[test]
    fn layered_pack_with_limbs_and_segments_is_accepted() {
        let img = format!("data:image/png;base64,{PNG1}");
        let extra = format!(
            r##","limbs":{{"fl":{{"pivot":[0.5,0.1],"attach":[-30,-40],"z":30,"segments":[{{"image":"{img}","pivot":[0.5,0.1],"end":[0.5,0.9]}},{{"image":"{img}","pivot":[0.5,0.1],"end":[0.5,0.9]}}]}}}},"tail":{{"image":"{img}","pivot":[0.05,0.5],"end":[0.95,0.5],"attach":[40,-20],"z":5}}"##
        );
        assert!(inspect(&layered_pack(&extra)).is_ok());
    }

    #[test]
    fn layered_pack_rejects_bad_geometry_unknown_parts_and_missing_head() {
        let bad_limb = r##","limbs":{"xx":{"image":"data:image/png;base64,AAAA"}}"##;
        assert!(inspect(&layered_pack(bad_limb)).unwrap_err().iter().any(|e| e == "unknown-limb:xx"));
        let weird = r##","wings":{}"##;
        assert!(inspect(&layered_pack(weird)).unwrap_err().iter().any(|e| e == "unknown-part:wings"));
        let no_rig = layered_pack("").replace("\"rig\"", "\"nope\"");
        assert!(inspect(&no_rig).unwrap_err().contains(&"rig-missing".to_string()));
    }

    #[test]
    fn layered_pack_cannot_smuggle_palette_or_sprites() {
        let p = layered_pack("").replace("\"kind\":\"layered\"", "\"kind\":\"layered\",\"palette\":{\"furColor\":\"#fff\"}");
        assert!(inspect(&p).unwrap_err().contains(&"layered-skin-cannot-contain-palette".to_string()));
    }

    #[test]
    fn sprites_pack_with_real_png_header_is_accepted() {
        // 1x1 PNG
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
        let p = format!(
            r#"{{"schema":1,"id":"fish-skin","name":"Fish","author":"me","license":"MIT","version":"1","kind":"sprites","sprites":{{"idle":"data:image/png;base64,{png}"}}}}"#
        );
        assert_eq!(inspect(&p).unwrap().kind, "sprites");
        let svg = p.replace("data:image/png;base64,", "data:image/svg+xml;base64,");
        assert!(inspect(&svg).unwrap_err().iter().any(|e| e.starts_with("not-a-data-uri")));
    }
}
