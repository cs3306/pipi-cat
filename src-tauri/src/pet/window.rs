//! 独立窗口：设置、皮肤制作器。都是有标题栏、可聚焦、可输入的普通窗口。
//! 猫窗口只有 420×440 且平时穿透、不抢焦点，放不下这些界面也无法正常输入。
//! 用 async：Windows 上在同步命令里创建 WebView 窗口可能死锁（Tauri 已知问题）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 诊断日志（统一写进 pipi-cat.log，见 applog.rs）。
pub fn trace(msg: &str) {
    crate::applog::info("window", msg);
}

/// 正在创建新窗口。创建 WebView2 窗口时主线程要泵消息，此时猫窗口的鼠标轮询线程
/// 如果还在每 25ms 跨线程操作主窗口，有卡死的嫌疑；所以创建期间让它暂停。
/// 只最多暂停 2.5 秒：就算创建卡住不返回，猫窗口的鼠标处理也会恢复，不会跟着一起僵住。
static BUILDING_SINCE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(1)
        .max(1)
}

pub fn building_window() -> bool {
    let since = BUILDING_SINCE_MS.load(Ordering::Relaxed);
    since != 0 && now_ms().saturating_sub(since) < 2500
}

struct BuildGuard;

impl BuildGuard {
    fn new() -> Self {
        BUILDING_SINCE_MS.store(now_ms(), Ordering::Relaxed);
        BuildGuard
    }
}

impl Drop for BuildGuard {
    fn drop(&mut self) {
        BUILDING_SINCE_MS.store(0, Ordering::Relaxed);
    }
}

/// 与猫窗口（tauri.conf.json）完全一致的浏览器参数。
/// WebView2 要求「同一个用户数据目录」下的窗口环境参数一致，否则新窗口会报 0x8007139F。
const MAIN_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";

fn build_window(
    app: &AppHandle,
    label: &str,
    page: &str,
    title: &str,
    size: (f64, f64),
    min: (f64, f64),
    transparent: bool,
    args: Option<&str>,
) -> tauri::Result<tauri::WebviewWindow> {
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .resizable(true)
        .decorations(true)
        .transparent(transparent)
        // Windows 上默认的原生拖放处理会吞掉网页里的拖放事件；关掉后「拖入文件」才能工作。
        .disable_drag_drop_handler()
        .center();
    #[cfg(windows)]
    if let Some(a) = args {
        b = b.additional_browser_args(a);
    }
    #[cfg(not(windows))]
    let _ = args;
    b.build()
}

async fn open_named(app: AppHandle, label: &str, page: &str, title: &str, size: (f64, f64), min: (f64, f64)) -> Result<(), String> {
    trace(&format!("open {label}: start"));
    if let Some(w) = app.get_webview_window(label) {
        trace(&format!("open {label}: reuse existing window"));
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let _building = BuildGuard::new();
    // 看门狗：创建迟迟不返回时把情况写进日志（卡死时没有任何别的线索）。
    let done = Arc::new(AtomicBool::new(false));
    {
        let done = done.clone();
        let name = label.to_string();
        std::thread::spawn(move || {
            let mut waited = 0u64;
            for step in [3u64, 7, 10] {
                std::thread::sleep(Duration::from_secs(step));
                waited += step;
                if done.load(Ordering::Relaxed) {
                    return;
                }
                crate::applog::warn("window", &format!("open {name}: build() still pending after {waited}s"));
            }
        });
    }
    let started = Instant::now();
    // 依次尝试几种环境参数组合；第一种与猫窗口完全一致，最可能成功。每次结果都写进日志。
    let attempts: [(bool, Option<&str>); 4] = [
        (true, Some(MAIN_BROWSER_ARGS)),
        (true, None),
        (false, Some(MAIN_BROWSER_ARGS)),
        (false, None),
    ];
    let mut last_err = String::new();
    for (i, (transparent, args)) in attempts.iter().enumerate() {
        trace(&format!("open {label}: attempt {} (transparent={transparent}, args={})", i + 1, args.is_some()));
        match build_window(&app, label, page, title, size, min, *transparent, *args) {
            Ok(w) => {
                done.store(true, Ordering::Relaxed);
                trace(&format!("open {label}: attempt {} ok after {}ms", i + 1, started.elapsed().as_millis()));
                let name = label.to_string();
                w.on_window_event(move |ev| match ev {
                    tauri::WindowEvent::CloseRequested { .. } => trace(&format!("{name}: CloseRequested")),
                    tauri::WindowEvent::Destroyed => trace(&format!("{name}: Destroyed")),
                    _ => {}
                });
                return Ok(());
            }
            Err(e) => {
                trace(&format!("open {label}: attempt {} failed: {e}", i + 1));
                last_err = e.to_string();
            }
        }
    }
    done.store(true, Ordering::Relaxed);
    Err(last_err)
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
