//! 诊断日志：`%APPDATA%\pipi-cat\pipi-cat.log`。
//! 发布版没有控制台，而且 panic=abort（出错即闪退），出问题时只有这个文件能说明发生了什么。
//! 单个文件，超过 1 MB 自动轮转成 `pipi-cat.log.1`（只保留一代）。时间为 UTC。
//! 不记录键盘输入、剪贴板或文件内容，只记录程序自己的状态和错误。

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 1024 * 1024;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn log_path() -> PathBuf {
    crate::config::app_data_dir().join("pipi-cat.log")
}

/// 从 1970-01-01 起的天数 → (年, 月, 日)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn stamp() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms.rem_euclid(1000)
    )
}

pub fn write(level: &str, tag: &str, msg: &str) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let thread = std::thread::current();
    let line = format!("{} {:<5} [{}] ({}) {}\n", stamp(), level, tag, thread.name().unwrap_or("?"), msg.replace('\r', ""));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn info(tag: &str, msg: &str) {
    write("INFO", tag, msg);
}

#[allow(dead_code)]
pub fn warn(tag: &str, msg: &str) {
    write("WARN", tag, msg);
}

#[allow(dead_code)]
pub fn error(tag: &str, msg: &str) {
    write("ERROR", tag, msg);
}

/// panic 时写入原因、位置和调用栈（发布版符号被剥离，调用栈只有地址，但位置和消息足够定位）。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let bt = std::backtrace::Backtrace::force_capture();
        write("PANIC", "panic", &format!("{info}\nbacktrace:\n{bt}"));
    }));
}

/// 启动横幅：版本、系统、路径、命令行参数。
pub fn banner() {
    write("INFO", "boot", "------------------------------------------------------------");
    write(
        "INFO",
        "boot",
        &format!(
            "pipi-cat {} starting (os={}, arch={}, debug_build={})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            cfg!(debug_assertions)
        ),
    );
    // 路径里常带 Windows 用户名（C:\Users\<name>\…），写日志前把用户目录替换成 `~`。
    write("INFO", "boot", &redact_home(&format!("exe={:?}", std::env::current_exe().ok())));
    write("INFO", "boot", &redact_home(&format!("data_dir={:?}", crate::config::app_data_dir())));
    write("INFO", "boot", &redact_home(&format!("args={:?}", std::env::args().collect::<Vec<_>>())));
}

/// 把文本里的用户主目录（USERPROFILE / HOME）替换成 `~`。`{:?}` 会把反斜杠写成双反斜杠，两种写法都处理。
pub fn redact_home(s: &str) -> String {
    let mut out = s.to_string();
    for var in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(var) {
            out = redact_with(&out, &home);
        }
    }
    out
}

fn redact_with(s: &str, home: &str) -> String {
    let home = home.trim_end_matches(['\\', '/']);
    // 太短（如 "C:" 或 "/"）会误伤整段文本，不处理。
    if home.len() < 4 {
        return s.to_string();
    }
    s.replace(&home.replace('\\', "\\\\"), "~").replace(home, "~")
}

#[cfg(test)]
mod redact_tests {
    use super::redact_with;

    #[test]
    fn replaces_plain_and_debug_escaped_home() {
        assert_eq!(
            redact_with(r"exe=C:\Users\bob\AppData\x.exe", r"C:\Users\bob"),
            r"exe=~\AppData\x.exe"
        );
        assert_eq!(
            redact_with(r#"exe=Some("C:\\Users\\bob\\AppData")"#, r"C:\Users\bob"),
            r#"exe=Some("~\\AppData")"#
        );
    }

    #[test]
    fn leaves_other_text_and_short_homes_alone() {
        assert_eq!(redact_with("exe=F:\\tools\\a.exe", r"C:\Users\bob"), "exe=F:\\tools\\a.exe");
        assert_eq!(redact_with("anything /usr", "/"), "anything /usr");
    }
}

/// WebView2 相关环境变量（在运行时配置完成之后调用）。
pub fn webview_env() {
    for var in ["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", "WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] {
        match std::env::var_os(var) {
            Some(v) => write("INFO", "boot", &format!("{var}={v:?}")),
            None => write("INFO", "boot", &format!("{var}=<unset>")),
        }
    }
}

/// 猫窗口与显示器的位置、大小、缩放，用来排查"窗口跑到屏幕外/拖不动"之类的问题。
pub fn describe_windows(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        write("WARN", "window", "main window not found");
        return;
    };
    write(
        "INFO",
        "window",
        &format!(
            "main: pos={:?} size={:?} scale={:?} visible={:?}",
            w.outer_position().ok(),
            w.outer_size().ok(),
            w.scale_factor().ok(),
            w.is_visible().ok()
        ),
    );
    match w.available_monitors() {
        Ok(list) => {
            for (i, m) in list.iter().enumerate() {
                write(
                    "INFO",
                    "window",
                    &format!("monitor {i}: name={:?} pos={:?} size={:?} scale={}", m.name(), m.position(), m.size(), m.scale_factor()),
                );
            }
        }
        Err(e) => write("WARN", "window", &format!("available_monitors failed: {e}")),
    }
}


/// 看门狗：每秒让主线程回一次话；超过 3 秒没回应就写日志，恢复后再写一条。
/// 窗口"卡死"时，日志里能看到主线程从什么时候开始、卡了多久。
pub fn start_watchdog(app: tauri::AppHandle) {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let _ = std::thread::Builder::new().name("watchdog".into()).spawn(move || {
        let mut stalls = 0u32;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let (tx, rx) = mpsc::channel::<()>();
            let sent = Instant::now();
            if app.run_on_main_thread(move || drop(tx.send(()))).is_err() {
                return; // 应用正在退出
            }
            if rx.recv_timeout(Duration::from_secs(3)).is_ok() {
                continue;
            }
            stalls += 1;
            write(
                "WARN",
                "watchdog",
                &format!(
                    "main thread not responding for >3s (stall #{stalls}); poller_stage={}, last_window_event={}",
                    poller_stage_name(),
                    last_window_event()
                ),
            );
            let mut logged = 3u64;
            loop {
                match rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(()) => {
                        write("WARN", "watchdog", &format!("main thread recovered after {:.1}s", sent.elapsed().as_secs_f32()));
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        logged += 5;
                        if logged <= 63 {
                            write("WARN", "watchdog", &format!("main thread still not responding after {logged}s"));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if stalls >= 20 {
                return;
            }
        }
    });
}

static POLLER_TICK_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 鼠标轮询线程当前走到哪一步（每步都会跨线程调用主线程）。主线程卡死时，日志里能看到轮询线程正卡在哪一步。
static POLLER_STAGE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const POLLER_STAGES: [&str; 9] = [
    "tick-start",
    "find-window",
    "is_visible",
    "scale+cursor",
    "geometry",
    "topmost-guard",
    "set-ignore",
    "emit-cursor",
    "paused",
];

pub fn poller_stage(i: usize) {
    POLLER_STAGE.store(i, std::sync::atomic::Ordering::Relaxed);
}

fn poller_stage_name() -> &'static str {
    POLLER_STAGES
        .get(POLLER_STAGE.load(std::sync::atomic::Ordering::Relaxed))
        .copied()
        .unwrap_or("?")
}

/// 最近一次窗口生命周期事件（设置/制作器窗口的打开、关闭请求、销毁），卡死时用来对照"卡之前主线程在做什么"。
static LAST_WINDOW_EVENT: Mutex<(u64, String)> = Mutex::new((0, String::new()));

pub fn note_window_event(msg: &str) {
    let mut g = LAST_WINDOW_EVENT.lock().unwrap_or_else(|e| e.into_inner());
    *g = (now_ms(), msg.chars().take(80).collect());
}

fn last_window_event() -> String {
    let g = LAST_WINDOW_EVENT.lock().unwrap_or_else(|e| e.into_inner());
    if g.0 == 0 {
        "none".to_string()
    } else {
        format!("{:?} {}ms ago", g.1, now_ms().saturating_sub(g.0))
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 鼠标轮询线程每轮调用一次，证明自己还活着。
pub fn touch_poller() {
    POLLER_TICK_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

/// 监视鼠标轮询线程：它卡住（通常意味着"点不到猫、拖不动"）时写日志，恢复后再写一条。
pub fn start_poller_watch() {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let _ = std::thread::Builder::new().name("poller-watch".into()).spawn(|| {
        let mut stalled = false;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let t = POLLER_TICK_MS.load(Ordering::Relaxed);
            if t == 0 {
                continue;
            }
            let age = now_ms().saturating_sub(t);
            if age > 3000 && !stalled {
                stalled = true;
                write(
                    "WARN",
                    "poller",
                    &format!(
                        "cursor poller has not ticked for {age}ms (building_or_paused={}, stage={})",
                        crate::pet::building_window(),
                        poller_stage_name()
                    ),
                );
            } else if age <= 3000 && stalled {
                stalled = false;
                write("WARN", "poller", "cursor poller recovered");
            }
        }
    });
}

/// Windows：捕获原生崩溃（访问冲突等），崩溃前把异常代码和地址写进日志。
/// Rust 的 panic 钩子管不到这类崩溃（例如 WebView2 / COM 里出错）。
#[cfg(windows)]
pub fn install_native_crash_logger() {
    use std::ffi::c_void;

    #[repr(C)]
    struct ExceptionRecord {
        code: u32,
        flags: u32,
        record: *mut ExceptionRecord,
        address: *mut c_void,
        num_params: u32,
        params: [usize; 15],
    }
    #[repr(C)]
    struct ExceptionPointers {
        record: *mut ExceptionRecord,
        context: *mut c_void,
    }
    type Filter = unsafe extern "system" fn(*const ExceptionPointers) -> i32;
    extern "system" {
        fn SetUnhandledExceptionFilter(filter: Option<Filter>) -> Option<Filter>;
    }
    unsafe extern "system" fn handler(p: *const ExceptionPointers) -> i32 {
        if !p.is_null() {
            let r = (*p).record;
            if !r.is_null() {
                let r = &*r;
                write(
                    "FATAL",
                    "native-crash",
                    &format!(
                        "unhandled exception code=0x{:08X} address={:p} params=[0x{:x}, 0x{:x}]",
                        r.code, r.address, r.params[0], r.params[1]
                    ),
                );
            }
        }
        0 // EXCEPTION_CONTINUE_SEARCH：交还给系统，照常崩溃/报告
    }
    unsafe {
        SetUnhandledExceptionFilter(Some(handler));
    }
}

#[cfg(not(windows))]
pub fn install_native_crash_logger() {}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_416), (2025, 11, 24));
    }
}
