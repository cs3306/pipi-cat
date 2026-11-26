//! 猫窗口拖动（仅 Windows 普通路径）。
//!
//! 为什么不用 tao 的 `start_dragging`：它只是异步投递一条 WM_NCLBUTTONDOWN 就返回，
//! 并且在 tao 内部用一个 `dragging` 标志防止重复拖动；该标志只在系统移动循环结束（WM_EXITSIZEMOVE）时复位。
//! 只要有一次投递没有真正进入移动循环（例如慢机器上点一下、消息处理前鼠标已松开），
//! 标志就永远是 true，之后所有原生拖动都被静默忽略 —— 表现为「一开始能拖，后面不行」。
//! 前端原来用「调用耗时 < 150 ms」猜原生拖动是否失败，这个判断两头都不可靠。
//!
//! 这里改成：前端按下时调用一次命令，后端线程按系统光标位置（GetCursorPos）和物理按键状态
//! （GetAsyncKeyState）直接 SetWindowPos，直到松开。不依赖网页能否收到 mousemove，也不依赖 IPC 往返速度。
//!
//! 日志（标签 `drag`）只记录次数、耗时、位移量、卡顿指标和状态位，**不记录屏幕坐标、窗口位置或任何内容**。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, PhysicalPosition};
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, GetWindowRect, IsWindow, SetWindowPos, SM_SWAPBUTTON,
    SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
};

use crate::applog;

/// 同一时刻只允许一个拖动。
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// 第几次拖动（进程内计数），用于限制常规日志条数。
static SEQ: AtomicU32 = AtomicU32::new(0);

/// 前 N 次拖动每次都写一行小结，之后只写异常。
const VERBOSE_DRAGS: u32 = 40;
/// 轮询间隔。
const TICK: Duration = Duration::from_millis(8);
/// 单次拖动的安全上限（防止按键状态读取异常时永远不结束）。
const MAX_DRAG: Duration = Duration::from_secs(300);
/// SetWindowPos 单次超过这个耗时算「慢」（说明主线程在忙）。
const SLOW_SETPOS: Duration = Duration::from_millis(100);
/// 两次轮询间隔超过这个时间算「卡顿」。
const STALL_GAP: Duration = Duration::from_millis(250);
/// 前端按下到后端开始处理超过这个时间算「IPC 慢」。
const SLOW_IPC_MS: i64 = 150;

/// 调用方在命令入口采集的、只含状态位的上下文。
pub struct Context {
    /// 前端 mousedown 到后端开始处理的延迟（毫秒），前端没传则为 None。
    pub ipc_delay_ms: Option<i64>,
    /// 开始拖动时窗口是否带 WS_EX_TRANSPARENT（点击穿透）。
    pub click_through: Option<bool>,
    pub menu_open: bool,
}

struct Guard {
    dragging: Arc<AtomicBool>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.dragging.store(false, Ordering::Relaxed);
        ACTIVE.store(false, Ordering::SeqCst);
    }
}

fn button_vk() -> (u16, bool) {
    // GetAsyncKeyState 读的是物理键；交换了左右键时，「主键」是物理右键。
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    (if swapped { VK_RBUTTON } else { VK_LBUTTON }, swapped)
}

fn is_down(vk: u16) -> bool {
    (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
}

/// 阻塞到松开鼠标为止。应在专用线程里调用（`spawn_blocking`）。
pub fn run(app: &AppHandle, hwnd_raw: isize, dragging: Arc<AtomicBool>, ctx: Context) {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        applog::warn("drag", "cursor drag requested while another is active; ignored");
        return;
    }
    dragging.store(true, Ordering::Relaxed);
    let _guard = Guard { dragging };

    let n = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let verbose = n <= VERBOSE_DRAGS;
    let hwnd = hwnd_raw as HWND;
    let (vk, swapped) = button_vk();
    let started = Instant::now();

    if !is_down(vk) {
        // 前端按下后，后端处理前鼠标已经松开（快速点击）：当作普通点击，不移动。
        if verbose || ctx.ipc_delay_ms.is_some_and(|d| d > SLOW_IPC_MS) {
            applog::info(
                "drag",
                &format!(
                    "cursor drag #{n}: button already released at start (ipc_delay_ms={:?}); treated as click",
                    ctx.ipc_delay_ms
                ),
            );
        }
        return;
    }

    let mut cur = POINT { x: 0, y: 0 };
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe { GetCursorPos(&mut cur) != 0 && GetWindowRect(hwnd, &mut rect) != 0 };
    if !ok {
        applog::warn("drag", &format!("cursor drag #{n}: GetCursorPos/GetWindowRect failed"));
        return;
    }
    let (sx, sy) = (cur.x, cur.y);
    let (wx, wy) = (rect.left, rect.top);
    let mut last = (wx, wy);

    let mut ticks: u32 = 0;
    let mut moves: u32 = 0;
    let mut slow_setpos: u32 = 0;
    let mut max_setpos = Duration::ZERO;
    let mut max_gap = Duration::ZERO;
    let mut last_tick = Instant::now();
    let reason;

    loop {
        std::thread::sleep(TICK);
        ticks += 1;
        let now = Instant::now();
        max_gap = max_gap.max(now - last_tick);
        last_tick = now;

        if !is_down(vk) {
            reason = "button-up";
            break;
        }
        if started.elapsed() > MAX_DRAG {
            reason = "timeout";
            break;
        }
        if unsafe { IsWindow(hwnd) } == 0 {
            reason = "window-gone";
            break;
        }
        if unsafe { GetCursorPos(&mut cur) } == 0 {
            continue;
        }
        let target = (wx + (cur.x - sx), wy + (cur.y - sy));
        if target == last {
            continue;
        }
        let t = Instant::now();
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                target.0,
                target.1,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        let d = t.elapsed();
        max_setpos = max_setpos.max(d);
        if d > SLOW_SETPOS {
            slow_setpos += 1;
        }
        moves += 1;
        last = target;
    }

    // 以实际窗口位置为准保存（只在真的移动过时）。
    if moves > 0 {
        let mut end = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { GetWindowRect(hwnd, &mut end) } != 0 {
            crate::windows_display::remember_dragged_position(
                app,
                PhysicalPosition::new(end.left, end.top),
            );
        }
    }

    let anomaly = reason != "button-up"
        || slow_setpos > 0
        || max_gap > STALL_GAP
        || ctx.ipc_delay_ms.is_some_and(|d| d > SLOW_IPC_MS)
        || ctx.click_through == Some(true)
        || ctx.menu_open;
    if verbose || anomaly {
        let line = format!(
            "cursor drag #{n} end: reason={reason} ms={} ticks={ticks} moves={moves} \
             displacement=({:+},{:+}) max_tick_gap_ms={} max_setpos_ms={} slow_setpos={slow_setpos} \
             ipc_delay_ms={:?} click_through_at_start={:?} menu_open={} swap_buttons={swapped}",
            started.elapsed().as_millis(),
            last.0 - wx,
            last.1 - wy,
            max_gap.as_millis(),
            max_setpos.as_millis(),
            ctx.ipc_delay_ms,
            ctx.click_through,
            ctx.menu_open,
        );
        if anomaly {
            applog::warn("drag", &line);
        } else {
            applog::info("drag", &line);
        }
    }
}
