//! Windows 实现。每个函数都很短，便于在 Windows runner 上逐个核对。
//! 依据（微软文档）：
//! - GetLastInputInfo：Windows 2000 起；只反映当前会话；dwTime 是 GetTickCount 的滴答值。
//! - SHQueryUserNotificationState：Vista 起；2=BUSY 3=D3D 全屏 4=演示模式。
//! - shutdown.exe：/s /t N /c "注释" [/f]；/a 取消；错误码 1190 已有计划、1116 没有计划。

use std::os::windows::process::CommandExt;
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 距离上一次键盘/鼠标输入过了多少秒。不装任何钩子，不读取输入内容。
pub fn idle_secs() -> Option<u64> {
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info) == 0 {
            return None;
        }
        // 两者都是 u32 滴答，回绕时用 wrapping_sub 才正确。
        let ms = GetTickCount().wrapping_sub(info.dwTime);
        Some(ms as u64 / 1000)
    }
}

/// 全屏应用 / D3D 全屏 / 演示模式时为 true。
pub fn fullscreen_busy() -> bool {
    unsafe {
        let mut state: i32 = 0;
        if SHQueryUserNotificationState(&mut state) < 0 {
            return false;
        }
        matches!(state, 2 | 3 | 4)
    }
}

/// 本地时间相对 UTC 的偏移（秒）。UTC = 本地 + Bias(分钟)。
pub fn utc_offset_secs() -> i64 {
    unsafe {
        let mut tz: TIME_ZONE_INFORMATION = std::mem::zeroed();
        let id = GetTimeZoneInformation(&mut tz);
        let extra = if id == 2 { tz.DaylightBias } else { tz.StandardBias }; // 2 = TIME_ZONE_ID_DAYLIGHT
        -((tz.Bias + extra) as i64) * 60
    }
}

/// 调用系统自带的 shutdown.exe。Err 里是 (退出码, 错误文本)。
pub fn run_shutdown(args: &[&str]) -> Result<(), (i32, String)> {
    let out = std::process::Command::new("shutdown")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| (-1, e.to_string()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

pub fn open_folder(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub const SHUTDOWN_SUPPORTED: bool = true;
