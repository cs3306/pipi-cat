//! 非 Windows：只保证能编译，相关功能关闭（本版本只发布 Windows 10/11）。

pub fn idle_secs() -> Option<u64> {
    None
}

pub fn fullscreen_busy() -> bool {
    false
}

pub fn utc_offset_secs() -> i64 {
    0
}

pub fn run_shutdown(_args: &[&str]) -> Result<(), (i32, String)> {
    Err((-1, "scheduled shutdown is only available on Windows".into()))
}

pub fn open_folder(_path: &std::path::Path) -> Result<(), String> {
    Err("only available on Windows".into())
}

pub const SHUTDOWN_SUPPORTED: bool = false;
