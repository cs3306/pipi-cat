//! 运行时状态与存档。一个全局 Runtime（OnceLock），由调度线程和命令共享。

use super::model::{builtin_tasks, TaskDto, TaskRt};
use super::platform;
use super::settings::{self, PetSettings};
use pet_core::economy::GameState;
use pet_core::focus::{FocusConfig, FocusMachine, Phase};
use pet_core::rng::Rng;
use pet_core::sedentary::Sedentary;
use pet_core::tasks;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct Runtime {
    pub settings: Mutex<PetSettings>,
    pub game: Mutex<GameState>,
    pub focus: Mutex<FocusMachine>,
    pub focus_wall_start: Mutex<i64>,
    pub tasks: Mutex<Vec<TaskRt>>,
    pub snoozes: Mutex<Vec<(TaskDto, i64)>>,
    pub start: Instant,
    pub sedentary: Mutex<Sedentary>,
    pub rng: Mutex<Rng>,
    pub meow_next: Mutex<i64>,
    pub cafe_on: Mutex<bool>,
    pub last_seen_wall: Mutex<i64>,
}

static RT: OnceLock<Runtime> = OnceLock::new();

pub fn rt() -> &'static Runtime {
    RT.get().expect("pet runtime not initialised")
}

/// 运行时还没初始化时返回 None（托盘可能比插件先建好）。
pub fn try_rt() -> Option<&'static Runtime> {
    RT.get()
}

pub fn install(rt: Runtime) -> bool {
    RT.set(rt).is_ok()
}

pub fn file_reactions_active() -> bool {
    RT.get().map(|r| r.settings.lock().unwrap().file_reactions).unwrap_or(false)
}

/// 专注期间是否按设置静音文件反应。
pub fn file_reactions_muted_now() -> bool {
    let Some(r) = RT.get() else { return false };
    let mute = r.settings.lock().unwrap().mute_file_reactions_in_focus;
    mute && r.focus.lock().unwrap().phase() == Phase::Focus
}

pub fn wall_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn focus_cfg(s: &PetSettings) -> FocusConfig {
    FocusConfig {
        focus_secs: s.focus_minutes as u64 * 60,
        break_secs: s.break_minutes as u64 * 60,
        idle_threshold_secs: s.idle_threshold_secs as u64,
    }
}

pub fn phase_str(p: Phase) -> &'static str {
    match p {
        Phase::Idle => "idle",
        Phase::Focus => "focus",
        Phase::Break => "break",
    }
}

pub fn status_json(r: &Runtime) -> Value {
    let now = r.start.elapsed().as_secs();
    let f = r.focus.lock().unwrap();
    let g = r.game.lock().unwrap();
    json!({
        "phase": phase_str(f.phase()),
        "remaining": f.remaining(now),
        "session": f.session(),
        "coins": g.coins,
        "completed": g.completed,
        "cafe": *r.cafe_on.lock().unwrap(),
    })
}

// ───────────── 存档 ─────────────

fn game_path() -> std::path::PathBuf {
    crate::config::app_data_dir().join("game.json")
}

fn tasks_path() -> std::path::PathBuf {
    crate::config::app_data_dir().join("tasks.json")
}

fn write_json(path: std::path::PathBuf, v: &Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(v) {
        let _ = std::fs::write(path, text);
    }
}

pub fn load_game() -> (GameState, i64) {
    let Ok(text) = std::fs::read_to_string(game_path()) else { return (GameState::default(), 0) };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return (GameState::default(), 0) };
    let coins = v.get("coins").and_then(Value::as_u64).unwrap_or(0);
    let completed = v.get("completed").and_then(Value::as_u64).unwrap_or(0);
    let settled = v
        .get("settled")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        .unwrap_or_default();
    let last_seen = v.get("lastSeen").and_then(Value::as_i64).unwrap_or(0);
    (GameState { coins, settled, completed }, last_seen)
}

pub fn save_game(r: &Runtime) {
    let g = r.game.lock().unwrap().clone();
    let last_seen = *r.last_seen_wall.lock().unwrap();
    write_json(
        game_path(),
        &json!({ "schemaVersion": 1, "coins": g.coins, "completed": g.completed, "settled": g.settled, "lastSeen": last_seen }),
    );
}

pub fn load_tasks() -> Vec<TaskDto> {
    let mut out: Vec<TaskDto> = std::fs::read_to_string(tasks_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    // 补齐缺失的内置任务（新版本新增内置项时老用户也能看到）
    for b in builtin_tasks() {
        if !out.iter().any(|t| t.id == b.id) {
            out.push(b);
        }
    }
    out
}

pub fn save_tasks(list: &[TaskDto]) {
    if let Ok(v) = serde_json::to_value(list) {
        write_json(tasks_path(), &v);
    }
}

pub fn build_task_rt(list: Vec<TaskDto>) -> Vec<TaskRt> {
    let wall = wall_secs();
    let off = platform::utc_offset_secs();
    list.into_iter()
        .map(|dto| {
            let next = dto.trigger().and_then(|tr| tasks::next_fire(&tr, wall, wall, off));
            TaskRt { dto, anchor: wall, next }
        })
        .collect()
}

pub fn new_runtime() -> (Runtime, i64, PetSettings) {
    let mut s = settings::load();
    s.sanitize();
    let (game, last_seen) = load_game();
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
    let rt = Runtime {
        settings: Mutex::new(s.clone()),
        game: Mutex::new(game),
        focus: Mutex::new(FocusMachine::new(focus_cfg(&s), 0)),
        focus_wall_start: Mutex::new(0),
        tasks: Mutex::new(build_task_rt(load_tasks())),
        snoozes: Mutex::new(Vec::new()),
        start: Instant::now(),
        sedentary: Mutex::new(Sedentary::new(0)),
        rng: Mutex::new(Rng::new(seed)),
        meow_next: Mutex::new(0),
        cafe_on: Mutex::new(false),
        last_seen_wall: Mutex::new(last_seen),
    };
    (rt, last_seen, s)
}
