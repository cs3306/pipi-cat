//! 独立窗口：设置、皮肤制作器。都是有标题栏、可聚焦、可输入的普通窗口。
//! 猫窗口只有 420×440 且平时穿透、不抢焦点，放不下这些界面也无法正常输入。
//! 用 async：Windows 上在同步命令里创建 WebView 窗口可能死锁（Tauri 已知问题）。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

async fn open_named(app: AppHandle, label: &str, page: &str, title: &str, size: (f64, f64), min: (f64, f64)) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .resizable(true)
        .decorations(true)
        // Windows 上默认的原生拖放处理会吞掉网页里的拖放事件；关掉后「拖入文件」才能工作。
        .disable_drag_drop_handler()
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    open_named(app, "settings", "settings.html", "Settings", (720.0, 520.0), (560.0, 400.0)).await
}

/// `target`：让制作器直接打开某个起点。格式 `builtin:<id>`（复制内置猫）、`override:<id>`（修改默认皮肤）、
/// `skin:<id>`（编辑已安装皮肤）。只接受小写字母/数字/连字符，所以可以安全拼进地址。
pub fn valid_maker_target(t: &str) -> bool {
    let Some((kind, id)) = t.split_once(':') else { return false };
    matches!(kind, "builtin" | "override" | "skin")
        && !id.is_empty()
        && id.len() <= 36
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub async fn open_maker_window(app: AppHandle, target: Option<String>) -> Result<(), String> {
    use tauri::Emitter;
    let target = target.filter(|t| valid_maker_target(t));
    if app.get_webview_window("maker").is_some() {
        // 已经开着：不重建窗口，通知它切换到新的起点。
        if let Some(t) = &target {
            let _ = app.emit("kuro-maker-load", t);
        }
        return open_named(app, "maker", "maker.html", "Skin Maker", (980.0, 680.0), (760.0, 520.0)).await;
    }
    let page = match &target {
        Some(t) => format!("maker.html?target={t}"),
        None => "maker.html".to_string(),
    };
    open_named(app, "maker", &page, "Skin Maker", (980.0, 680.0), (760.0, 520.0)).await
}

#[cfg(test)]
mod tests {
    use super::valid_maker_target;

    #[test]
    fn maker_target_is_strictly_validated() {
        assert!(valid_maker_target("builtin:black"));
        assert!(valid_maker_target("override:ragdoll"));
        assert!(valid_maker_target("skin:my-cat-2"));
        assert!(!valid_maker_target("skin:"));
        assert!(!valid_maker_target("file:abc"));
        assert!(!valid_maker_target("skin:a/b"));
        assert!(!valid_maker_target("skin:A"));
        assert!(!valid_maker_target("skin:a&x=1"));
        assert!(!valid_maker_target("skin:a?b"));
        assert!(!valid_maker_target("nocolon"));
    }
}
