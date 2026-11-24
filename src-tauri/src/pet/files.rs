//! 文件反应：用文件系统通知（Windows 底层是 ReadDirectoryChangesW）监听用户在设置里勾选的文件夹。
//!
//! 隐私：回调里只用文件名判断「是不是临时文件」，之后只发出一个事件种类（created / delete），
//! 路径和文件名不会离开回调、不写日志、不发给前端。默认不监听任何文件夹。
//!
//! 局限：只监听所选文件夹本身（不递归）；经 OneDrive 重定向的文件夹以系统返回的路径为准；
//! 重命名不算新建也不算删除；Shift+Delete 与进回收站都表现为「文件消失」，统一当作 delete。

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const COOLDOWN: Duration = Duration::from_millis(1200);

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// 临时文件 / 隐藏文件 / 下载中间文件不触发反应。
fn is_noise(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return true };
    let lower = name.to_ascii_lowercase();
    lower.starts_with('.')
        || lower.starts_with("~$")
        || lower == "desktop.ini"
        || lower == "thumbs.db"
        || [".tmp", ".crdownload", ".part", ".partial", ".download", ".lnk"].iter().any(|e| lower.ends_with(e))
}

fn classify(kind: &EventKind, paths: &[PathBuf]) -> Option<&'static str> {
    let k = match kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "delete",
        _ => return None,
    };
    if paths.is_empty() || paths.iter().all(|p| is_noise(p)) {
        return None;
    }
    Some(k)
}

fn resolve(app: &AppHandle, names: &[String]) -> Vec<PathBuf> {
    let p = app.path();
    names
        .iter()
        .filter_map(|n| match n.as_str() {
            "desktop" => p.desktop_dir().ok(),
            "downloads" => p.download_dir().ok(),
            "documents" => p.document_dir().ok(),
            _ => None,
        })
        .collect()
}

/// 按当前设置（重新）建立监听；关闭或没选文件夹时释放监听器。
pub fn apply(app: &AppHandle, enabled: bool, folders: &[String]) {
    let mut slot = WATCHER.lock().unwrap();
    *slot = None; // 先释放旧的
    if !enabled || folders.is_empty() {
        return;
    }
    let dirs = resolve(app, folders);
    if dirs.is_empty() {
        return;
    }
    let handle = app.clone();
    let last = Mutex::new(Instant::now() - COOLDOWN);
    let handler = move |res: notify::Result<Event>| {
        let Ok(ev) = res else { return };
        let Some(kind) = classify(&ev.kind, &ev.paths) else { return };
        if !super::state::file_reactions_active() || super::state::file_reactions_muted_now() {
            return;
        }
        let mut l = last.lock().unwrap();
        if l.elapsed() < COOLDOWN {
            return;
        }
        *l = Instant::now();
        let _ = handle.emit("kuro-fileop", json!({ "kind": kind }));
    };
    let Ok(mut watcher) = notify::recommended_watcher(handler) else { return };
    let mut any = false;
    for d in dirs {
        if watcher.watch(&d, RecursiveMode::NonRecursive).is_ok() {
            any = true;
        }
    }
    if any {
        *slot = Some(watcher);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn noise_files_are_ignored() {
        for n in ["a.tmp", "~$report.docx", ".hidden", "Desktop.ini", "x.crdownload", "link.lnk"] {
            assert!(is_noise(Path::new(n)), "{n}");
        }
        assert!(!is_noise(Path::new("photo.png")));
    }

    #[test]
    fn only_create_and_remove_count() {
        let p = vec![PathBuf::from("photo.png")];
        assert_eq!(classify(&EventKind::Create(CreateKind::File), &p), Some("created"));
        assert_eq!(classify(&EventKind::Remove(RemoveKind::File), &p), Some("delete"));
        assert_eq!(classify(&EventKind::Modify(ModifyKind::Any), &p), None);
        assert_eq!(classify(&EventKind::Create(CreateKind::File), &[PathBuf::from("a.tmp")]), None);
        assert_eq!(classify(&EventKind::Create(CreateKind::File), &[]), None);
    }
}
