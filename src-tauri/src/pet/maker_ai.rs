//! 皮肤制作器的 AI 功能：把用户的文字描述发给「用户自己填写的」OpenAI 兼容接口，换回一份颜色皮肤配置。
//!
//! 与 MCP 完全无关（MCP 是本机端口、供外部程序调用；这里是应用主动向外请求、只在用户点击生成时发生）。
//! 隐私与安全：
//! - 默认未配置，不会有任何外发请求；只有用户填写地址并点击「生成」才会发送。
//! - 发送内容只有：固定的系统提示（含颜色皮肤字段说明）和用户输入的描述（≤500 字）。
//!   不发送皮肤文件、系统信息、使用记录。
//! - 地址只接受 https（本机回环地址允许 http，供本地模型使用）。
//! - API 密钥默认只保存在内存；用户勾选「记住密钥」才写入本机文件（明文，界面有提示）。
//!   密钥不会回传给界面，也不写日志。
//! - 模型回复当作不可信输入：取出 JSON → 与皮肤包同一套颜色校验 → 通过才返回。

use super::skins;
use pet_core::ai;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

static KEY: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    base_url: String,
    model: String,
    remember: bool,
    api_key: Option<String>,
}

fn config_path() -> std::path::PathBuf {
    crate::config::app_data_dir().join("maker-ai.json")
}

fn load() -> Stored {
    let mut s: Stored = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if !s.remember {
        s.api_key = None;
    }
    s
}

fn save(s: &Stored) {
    let p = config_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(t) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(p, t);
    }
}

fn current_key(stored: &Stored) -> Option<String> {
    KEY.lock().unwrap().clone().or_else(|| stored.api_key.clone()).filter(|k| !k.trim().is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    base_url: String,
    model: String,
    remember: bool,
    has_key: bool,
}

pub fn get_config() -> PublicConfig {
    let s = load();
    let has_key = current_key(&s).is_some();
    PublicConfig { base_url: s.base_url, model: s.model, remember: s.remember, has_key }
}

/// `api_key`：`None` = 不改；`Some("")` = 清除；`Some(key)` = 设置。
pub fn set_config(base_url: String, model: String, remember: bool, api_key: Option<String>) -> Result<PublicConfig, String> {
    if !base_url.trim().is_empty() {
        ai::chat_completions_url(&base_url).map_err(|e| e.to_string())?;
    }
    let mut s = load();
    s.base_url = base_url.trim().chars().take(200).collect();
    s.model = model.trim().chars().take(100).collect();
    s.remember = remember;
    match api_key {
        Some(k) if k.trim().is_empty() => {
            *KEY.lock().unwrap() = None;
            s.api_key = None;
        }
        Some(k) => *KEY.lock().unwrap() = Some(k.trim().to_string()),
        None => {}
    }
    s.api_key = if remember { KEY.lock().unwrap().clone().or(s.api_key) } else { None };
    save(&s);
    Ok(get_config())
}

const SYSTEM_PROMPT: &str = "You design colour skins for a small desktop cat pet. \
Reply with ONE JSON object only, no prose and no code fences. The object is the skin's palette using the schema below \
(do NOT include id, name or builtin). Every colour must be a hex string like #aabbcc. Keep spots to at most 6. \
Schema and examples:\n";

/// 把模型回复变成已校验的调色板；失败返回错误码。
pub fn parse_reply(content: &str) -> Result<Value, String> {
    let content = if content.len() > ai::MAX_REPLY_BYTES { &content[..content.floor_char_boundary(ai::MAX_REPLY_BYTES)] } else { content };
    let text = ai::extract_json_object(content).ok_or("ai-no-json")?;
    let mut v: Value = serde_json::from_str(text).map_err(|_| "ai-bad-json".to_string())?;
    let obj = v.as_object_mut().ok_or("ai-bad-json")?;
    for k in ["id", "name", "builtin"] {
        obj.remove(k);
    }
    let errs = skins::palette_errors(&v);
    if !errs.is_empty() {
        return Err(format!("ai-invalid:{}", errs.join("|")));
    }
    // 结构上也必须能变成上游的猫皮肤配置
    let mut probe = v.clone();
    if let Some(o) = probe.as_object_mut() {
        o.insert("id".into(), json!("preview"));
        o.insert("name".into(), json!("preview"));
    }
    serde_json::from_value::<crate::cats::CatSkinConfig>(probe).map_err(|_| "ai-invalid:structure".to_string())?;
    Ok(v)
}

/// 阻塞调用，应在 spawn_blocking 里运行。
pub fn generate(prompt: &str) -> Result<Value, String> {
    let stored = load();
    if stored.base_url.trim().is_empty() || stored.model.trim().is_empty() {
        return Err("ai-not-configured".into());
    }
    let url = ai::chat_completions_url(&stored.base_url).map_err(|e| e.to_string())?;
    let prompt = ai::clamp_prompt(prompt);
    if prompt.is_empty() {
        return Err("ai-empty-prompt".into());
    }
    let schema = crate::cats::cat_schema_guide().to_string();
    let body = json!({
        "model": stored.model,
        "temperature": 0.8,
        "max_tokens": 1500,
        "messages": [
            { "role": "system", "content": format!("{SYSTEM_PROMPT}{schema}") },
            { "role": "user", "content": prompt },
        ],
    });

    let cfg = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(60))).build();
    let agent: ureq::Agent = cfg.into();
    let mut req = agent.post(&url);
    if let Some(key) = current_key(&stored) {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let mut resp = req.send_json(&body).map_err(|e| {
        let msg: String = e.to_string().chars().take(120).collect();
        format!("ai-request-failed:{msg}")
    })?;
    let reply: Value = resp.body_mut().read_json().map_err(|_| "ai-bad-response".to_string())?;
    let content = reply
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or("ai-bad-response")?;
    parse_reply(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_fenced_valid_palette_and_strips_identity_fields() {
        let reply = "Sure!\n```json\n{\"id\":\"x\",\"name\":\"n\",\"furColor\":\"#aabbcc\",\"eyeColorTop\":\"#00ff00\"}\n```";
        let v = parse_reply(reply).unwrap();
        assert!(v.get("id").is_none() && v.get("name").is_none());
        assert_eq!(v["furColor"], "#aabbcc");
    }

    #[test]
    fn rejects_bad_colors_missing_fur_and_non_json() {
        assert!(parse_reply(r#"{"furColor":"url(x)"}"#).unwrap_err().starts_with("ai-invalid"));
        assert!(parse_reply(r##"{"tailColor":"#fff"}"##).unwrap_err().starts_with("ai-invalid"));
        assert_eq!(parse_reply("I cannot do that").unwrap_err(), "ai-no-json");
        assert_eq!(parse_reply("{not json}").unwrap_err(), "ai-bad-json");
    }
}
