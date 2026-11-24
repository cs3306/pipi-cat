//! 定时关机：用系统自带的 shutdown.exe（经平台层调用）。
//!
//! 倒计时由系统负责，本程序退出后照样关机；取消用 `/a`。
//! 安全默认：不强制关闭未保存的程序（/f 只在用户明确勾选时附加）；
//! 到点前 60 秒由调度线程发出 `kuro-shutdown-warning`，猫提示可取消。

use super::platform;
use serde_json::{json, Value};
use std::sync::Mutex;

pub const MIN_DELAY_SECS: u64 = 60;
pub const MAX_DELAY_SECS: u64 = 7 * 24 * 3600;
const ERR_NO_PLAN: i32 = 1116;

#[derive(Clone, Copy)]
struct Plan {
    due_at: i64,
    force: bool,
}

static PLAN: Mutex<Option<Plan>> = Mutex::new(None);
static WARNED: Mutex<bool> = Mutex::new(false);

fn plan_file() -> std::path::PathBuf {
    crate::config::app_data_dir().join("shutdown-plan.txt")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn persist(plan: Option<Plan>) {
    let p = plan_file();
    match plan {
        Some(pl) => {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(p, format!("{} {}", pl.due_at, pl.force as u8));
        }
        None => {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 启动时恢复计划（只恢复尚未到点的）。
pub fn restore() {
    let Ok(text) = std::fs::read_to_string(plan_file()) else { return };
    let mut it = text.split_whitespace();
    let (Some(a), Some(b)) = (it.next(), it.next()) else { return };
    let (Ok(due_at), Ok(force)) = (a.parse::<i64>(), b.parse::<u8>()) else { return };
    if due_at > now_secs() {
        *PLAN.lock().unwrap() = Some(Plan { due_at, force: force != 0 });
    } else {
        persist(None);
    }
}

pub fn status() -> Value {
    match *PLAN.lock().unwrap() {
        Some(p) if p.due_at > now_secs() => json!({ "scheduled": true, "dueAt": p.due_at, "force": p.force }),
        _ => json!({ "scheduled": false }),
    }
}

/// 到点前 60 秒内返回剩余秒数（只返回一次）；调度线程每秒调用。
pub fn take_warning() -> Option<i64> {
    let plan = (*PLAN.lock().unwrap())?;
    let left = plan.due_at - now_secs();
    if left < 0 {
        *PLAN.lock().unwrap() = None;
        *WARNED.lock().unwrap() = false;
        persist(None);
        return None;
    }
    let mut warned = WARNED.lock().unwrap();
    if left <= 60 && !*warned {
        *warned = true;
        return Some(left);
    }
    None
}

pub fn schedule(seconds: u64, force: bool) -> Result<Value, String> {
    if !(MIN_DELAY_SECS..=MAX_DELAY_SECS).contains(&seconds) {
        return Err(format!("delay must be {MIN_DELAY_SECS}..={MAX_DELAY_SECS} seconds"));
    }
    // 已有计划时先取消再重设（1116 = 本来就没有计划，忽略）。
    if let Err((code, msg)) = platform::run_shutdown(&["/a"]) {
        if code != ERR_NO_PLAN && platform::SHUTDOWN_SUPPORTED {
            return Err(format!("cancel previous plan failed ({code}): {msg}"));
        }
    }
    let secs = seconds.to_string();
    let mut args = vec!["/s", "/t", secs.as_str(), "/c", "Scheduled shutdown (desktop pet)"];
    if force {
        args.push("/f");
    }
    platform::run_shutdown(&args).map_err(|(code, msg)| format!("shutdown.exe failed ({code}): {msg}"))?;
    let plan = Plan { due_at: now_secs() + seconds as i64, force };
    *PLAN.lock().unwrap() = Some(plan);
    *WARNED.lock().unwrap() = false;
    persist(Some(plan));
    Ok(status())
}

pub fn cancel() -> Result<Value, String> {
    match platform::run_shutdown(&["/a"]) {
        Ok(()) => {}
        Err((ERR_NO_PLAN, _)) => {}
        Err((code, msg)) => return Err(format!("cancel failed ({code}): {msg}")),
    }
    *PLAN.lock().unwrap() = None;
    *WARNED.lock().unwrap() = false;
    persist(None);
    Ok(status())
}
