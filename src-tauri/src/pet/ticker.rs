//! 每秒一次的调度线程：专注状态机 → 结算 → 猫咖 → 提醒 → 猫叫 → 关机警告。
//! 判断逻辑在 pet-core；这里只读时钟、读系统状态、发事件。

use super::model::TaskDto;
use super::platform;
use super::settings;
use super::shutdown;
use super::state::{rt, save_game, status_json, wall_secs};
use pet_core::economy;
use pet_core::focus::{FocusEvent, Phase};
use pet_core::overrides::{parse_focus_view, FocusView};
use pet_core::quiet::local_minute_of_day;
use pet_core::tasks;
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn emit_reminder(app: &AppHandle, dto: &TaskDto, missed: bool) {
    // 猫被隐藏时先显示出来，否则提醒看不到。
    if !crate::is_pet_visible(app) {
        crate::set_pet_visible(app, true);
    }
    let _ = app.emit(
        "kuro-reminder",
        json!({
            "id": dto.id, "name": dto.name, "message": dto.message,
            "animation": dto.animation, "sound": dto.sound, "missed": missed,
        }),
    );
}

pub fn run(app: AppHandle, last_seen_at_start: i64) {
    let r = rt();
    let mut tick: u64 = 0;
    let mut first = true;
    // 这一次隐藏是不是「专注时隐藏」造成的。只有是，专注结束才自动把猫显示回来；
    // 用户自己隐藏的猫，专注结束后不替他显示。该状态只在内存里，重启后猫总是显示。
    let mut hid_by_focus = false;

    loop {
        std::thread::sleep(Duration::from_secs(1));
        tick += 1;
        let now_m = r.start.elapsed().as_secs();
        let wall = wall_secs();
        let off = platform::utc_offset_secs();
        let settings = r.settings.lock().unwrap().clone();
        // 系统给出的「距上次输入」；拿不到时当作一直有人在用（不触发猫咖、猫叫）。
        let idle_secs = platform::idle_secs().unwrap_or(0);
        let last_input = now_m.saturating_sub(idle_secs);

        // 1) 专注状态机
        let (events, cafe, phase) = {
            let mut f = r.focus.lock().unwrap();
            f.note_input(last_input);
            let ev = f.tick(now_m);
            (ev, settings.cafe_enabled && f.should_play_cafe(now_m), f.phase())
        };
        let had_events = !events.is_empty();

        // 专注时隐藏猫（设置：专注时猫 = 隐藏）。先于结算与事件，保证结束时猫已经显示出来。
        {
            let want_hidden = phase == Phase::Focus && parse_focus_view(&settings.focus_view) == FocusView::Hidden;
            if want_hidden && !hid_by_focus && crate::is_pet_visible(&app) {
                crate::set_pet_visible(&app, false);
                hid_by_focus = true;
            } else if !want_hidden && hid_by_focus {
                if !crate::is_pet_visible(&app) {
                    crate::set_pet_visible(&app, true);
                }
                hid_by_focus = false;
            }
        }

        for ev in events {
            match ev {
                FocusEvent::FocusCompleted { .. } => {
                    let sid = (*r.focus_wall_start.lock().unwrap()).max(0) as u64;
                    let granted = {
                        let mut g = r.game.lock().unwrap();
                        economy::settle(&mut g, sid, settings.reward_per_session as u64)
                    };
                    save_game(r);
                    let _ = app.emit("kuro-focus-done", json!({ "granted": granted }));
                    let g = r.game.lock().unwrap();
                    let _ = app.emit("kuro-game", json!({ "coins": g.coins, "completed": g.completed }));
                }
                FocusEvent::BreakStarted { .. } => r.sedentary.lock().unwrap().reset(now_m), // 休息算起身
                _ => {}
            }
        }
        if phase != Phase::Idle || had_events {
            let _ = app.emit("kuro-focus", status_json(r));
        }
        {
            let mut on = r.cafe_on.lock().unwrap();
            if *on != cafe {
                *on = cafe;
                let _ = app.emit("kuro-cafe", json!({ "on": cafe }));
            }
        }

        // 2) 提醒任务
        let mut to_fire: Vec<(TaskDto, bool)> = Vec::new();
        {
            let mut list = r.tasks.lock().unwrap();
            for t in list.iter_mut() {
                if !t.dto.enabled {
                    continue;
                }
                if t.dto.kind == "sedentary" {
                    let away = t.dto.away_minutes as u64 * 60;
                    let limit = t.dto.every_minutes as u64 * 60;
                    if r.sedentary.lock().unwrap().tick(now_m, idle_secs, away, limit) {
                        to_fire.push((t.dto.clone(), false));
                    }
                    continue;
                }
                let lead = t.dto.lead_minutes as i64 * 60;
                if let Some(next) = t.next {
                    if wall + lead >= next {
                        to_fire.push((t.dto.clone(), false));
                        // 重复提醒错过就跳过：下一次从「现在」之后算起
                        t.next = t.dto.trigger().and_then(|tr| tasks::next_fire(&tr, next.max(wall), t.anchor, off));
                    }
                }
            }
        }
        // 启动后补弹一次错过的一次性提醒
        if first && now_m >= 3 {
            first = false;
            let list = r.tasks.lock().unwrap();
            for t in list.iter() {
                if let Some(task) = t.dto.to_task() {
                    if tasks::missed_once_on_start(&task, last_seen_at_start, wall) {
                        to_fire.push((t.dto.clone(), true));
                    }
                }
            }
        }
        // 稍后提醒到点
        {
            let mut sn = r.snoozes.lock().unwrap();
            let mut keep = Vec::new();
            for (dto, at) in sn.drain(..) {
                if wall >= at {
                    to_fire.push((dto, false));
                } else {
                    keep.push((dto, at));
                }
            }
            *sn = keep;
        }
        for (dto, missed) in to_fire {
            emit_reminder(&app, &dto, missed);
        }

        // 3) 猫叫：非专注、无操作、非全屏、不在安静时段
        if settings.meow_enabled {
            let mut next = r.meow_next.lock().unwrap();
            let mut rng = r.rng.lock().unwrap();
            let gap = |rng: &mut pet_core::rng::Rng| {
                rng.range(settings.meow_min_minutes as u64, settings.meow_max_minutes as u64) as i64 * 60
            };
            if *next == 0 {
                *next = wall + gap(&mut rng);
            } else if wall >= *next {
                let blocked = phase == Phase::Focus
                    || idle_secs < settings.idle_threshold_secs as u64
                    || settings::in_quiet_hours(&settings, local_minute_of_day(wall, off))
                    || platform::fullscreen_busy();
                if blocked {
                    *next = wall + 60; // 条件不满足，一分钟后再看
                } else {
                    let count = rng.range(1, 3);
                    let _ = app.emit("kuro-meow", json!({ "count": count, "volume": settings.meow_volume }));
                    *next = wall + gap(&mut rng);
                }
            }
        }

        // 4) 定时关机到点前警告
        if let Some(left) = shutdown::take_warning() {
            if !crate::is_pet_visible(&app) {
                crate::set_pet_visible(&app, true);
            }
            let _ = app.emit("kuro-shutdown-warning", json!({ "seconds": left }));
        }

        // 5) 每分钟记录一次「最后在线时间」（用于启动后补弹一次性提醒）
        if tick % 60 == 0 {
            *r.last_seen_wall.lock().unwrap() = wall;
            save_game(r);
        }
    }
}
