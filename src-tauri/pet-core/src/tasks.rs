//! 定时任务与提醒的数据模型 + 下次触发时间计算。纯逻辑、零依赖（不引入 chrono）。
//!
//! 时间一律用 Unix 秒；「本地时间」由调用方传入 UTC 偏移秒数（Windows 上用
//! GetTimeZoneInformation 取，已含夏令时）。偏移在计算时刻固定，跨夏令时切换的
//! 那一次触发可能差一小时，调度线程每次触发后会重新算下一次，误差不会累积。
//!
//! 规则（交接文档 §6.5）：重复提醒错过就跳过；一次性提醒启动后补弹一次。

const DAY: i64 = 86_400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// 每隔 N 秒（从上次触发或创建时间起算）。
    Interval { every_secs: u64 },
    /// 每天本地 minute_of_day（0..1440）。
    Daily { minute_of_day: u32 },
    /// 每周若干天（bit0=周日 … bit6=周六）的本地 minute_of_day。
    Weekly { days_mask: u8, minute_of_day: u32 },
    /// 一次性，Unix 秒。
    Once { at: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskAction {
    /// 弹气泡提醒，猫做动作。
    Remind { message: String, animation_id: String, sound: bool },
    /// 定时关机作为一种任务类型统一管理。
    Shutdown { force: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    /// 提前量：提醒比触发点早多少秒弹出。
    pub lead_secs: u64,
    pub action: TaskAction,
}

/// 校验任务；返回错误描述列表（空=合法）。
pub fn validate(task: &Task) -> Vec<String> {
    let mut e = Vec::new();
    if task.id.is_empty() || task.id.len() > 64 {
        e.push("id must be 1..64 chars".into());
    }
    if task.name.is_empty() || task.name.chars().count() > 40 {
        e.push("name must be 1..40 chars".into());
    }
    match &task.trigger {
        Trigger::Interval { every_secs } if *every_secs < 60 => {
            e.push("interval must be >= 60s".into())
        }
        Trigger::Daily { minute_of_day } | Trigger::Weekly { minute_of_day, .. }
            if *minute_of_day >= 1440 =>
        {
            e.push("minute_of_day must be < 1440".into())
        }
        Trigger::Weekly { days_mask, .. } if *days_mask & 0x7f == 0 => {
            e.push("weekly needs at least one day".into())
        }
        _ => {}
    }
    e
}

/// 本地时刻 → 星期（0=周日）。1970-01-01 是周四。
fn weekday(local_secs: i64) -> u32 {
    (local_secs.div_euclid(DAY) + 4).rem_euclid(7) as u32
}

/// 严格晚于 `after` 的下一次触发（Unix 秒）。
/// Interval 以 `anchor`（上次触发或创建时间）为起点；其余忽略 anchor。
/// 一次性任务已过期返回 None。
pub fn next_fire(trigger: &Trigger, after: i64, anchor: i64, utc_offset_secs: i64) -> Option<i64> {
    match trigger {
        Trigger::Interval { every_secs } => {
            let step = (*every_secs).max(1) as i64;
            if after < anchor {
                return Some(anchor + step);
            }
            let n = (after - anchor) / step + 1;
            Some(anchor + n * step)
        }
        Trigger::Once { at } => (*at > after).then_some(*at),
        Trigger::Daily { minute_of_day } => {
            let offset_in_day = *minute_of_day as i64 * 60;
            let local = after + utc_offset_secs;
            let day_start = local.div_euclid(DAY) * DAY;
            let mut cand = day_start + offset_in_day;
            if cand - utc_offset_secs <= after {
                cand += DAY;
            }
            Some(cand - utc_offset_secs)
        }
        Trigger::Weekly { days_mask, minute_of_day } => {
            if *days_mask & 0x7f == 0 {
                return None;
            }
            let offset_in_day = *minute_of_day as i64 * 60;
            let local = after + utc_offset_secs;
            let day_start = local.div_euclid(DAY) * DAY;
            for d in 0..8 {
                let day = day_start + d * DAY;
                if days_mask & (1 << weekday(day)) == 0 {
                    continue;
                }
                let cand = day + offset_in_day - utc_offset_secs;
                if cand > after {
                    return Some(cand);
                }
            }
            None
        }
    }
}

/// 启动时是否需要补弹：只有一次性提醒，且触发点落在 (last_seen, now] 内。
/// 重复提醒错过一律跳过。
pub fn missed_once_on_start(task: &Task, last_seen: i64, now: i64) -> bool {
    task.enabled && matches!(task.trigger, Trigger::Once { at } if at > last_seen && at <= now)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-11-23 00:00:00 UTC（周一）
    const MON: i64 = 1_795_392_000;

    fn task(trigger: Trigger) -> Task {
        Task {
            id: "t".into(),
            name: "n".into(),
            enabled: true,
            trigger,
            lead_secs: 0,
            action: TaskAction::Shutdown { force: false },
        }
    }

    #[test]
    fn weekday_anchor_is_correct() {
        assert_eq!(weekday(MON), 1);
        assert_eq!(weekday(0), 4);
        assert_eq!(weekday(-1), 3, "1969-12-31 is a Wednesday");
    }

    #[test]
    fn interval_steps_from_anchor() {
        let t = Trigger::Interval { every_secs: 3600 };
        assert_eq!(next_fire(&t, 100, 100, 0), Some(3700));
        assert_eq!(next_fire(&t, 3700, 100, 0), Some(7300), "strictly after");
        assert_eq!(next_fire(&t, 5000, 100, 0), Some(7300));
        assert_eq!(next_fire(&t, 0, 100, 0), Some(3700), "clock before anchor");
    }

    #[test]
    fn daily_today_or_tomorrow() {
        let t = Trigger::Daily { minute_of_day: 9 * 60 };
        // UTC 偏移 0：08:00 之后问 → 当天 09:00
        assert_eq!(next_fire(&t, MON + 8 * 3600, 0, 0), Some(MON + 9 * 3600));
        // 09:00 整问 → 次日 09:00（严格晚于）
        assert_eq!(next_fire(&t, MON + 9 * 3600, 0, 0), Some(MON + DAY + 9 * 3600));
    }

    #[test]
    fn daily_respects_utc_offset_across_midnight() {
        // 本地 UTC-8（温哥华冬令时），每天本地 09:00 = UTC 17:00
        let off = -8 * 3600;
        let t = Trigger::Daily { minute_of_day: 9 * 60 };
        assert_eq!(next_fire(&t, MON + 16 * 3600, 0, off), Some(MON + 17 * 3600));
        assert_eq!(next_fire(&t, MON + 17 * 3600, 0, off), Some(MON + DAY + 17 * 3600));
        // UTC 周一 03:00 = 本地周日 19:00，下一次是本地周一 09:00 = UTC 周一 17:00
        assert_eq!(next_fire(&t, MON + 3 * 3600, 0, off), Some(MON + 17 * 3600));
    }

    #[test]
    fn weekly_mask_picks_next_enabled_day() {
        // 周三(bit3)与周五(bit5) 10:00，偏移 0
        let t = Trigger::Weekly { days_mask: (1 << 3) | (1 << 5), minute_of_day: 600 };
        let wed = MON + 2 * DAY;
        let fri = MON + 4 * DAY;
        assert_eq!(next_fire(&t, MON, 0, 0), Some(wed + 600 * 60));
        assert_eq!(next_fire(&t, wed + 600 * 60, 0, 0), Some(fri + 600 * 60));
        assert_eq!(next_fire(&t, fri + 600 * 60, 0, 0), Some(wed + 7 * DAY + 600 * 60));
        assert_eq!(next_fire(&Trigger::Weekly { days_mask: 0, minute_of_day: 0 }, MON, 0, 0), None);
    }

    #[test]
    fn once_expires() {
        let t = Trigger::Once { at: 1000 };
        assert_eq!(next_fire(&t, 999, 0, 0), Some(1000));
        assert_eq!(next_fire(&t, 1000, 0, 0), None);
    }

    #[test]
    fn missed_policy_once_only() {
        let once = task(Trigger::Once { at: 500 });
        assert!(missed_once_on_start(&once, 400, 600));
        assert!(!missed_once_on_start(&once, 500, 600), "already seen");
        assert!(!missed_once_on_start(&once, 100, 450), "not due yet");
        let daily = task(Trigger::Daily { minute_of_day: 60 });
        assert!(!missed_once_on_start(&daily, 0, 10_000_000));
        let mut off = once.clone();
        off.enabled = false;
        assert!(!missed_once_on_start(&off, 400, 600));
    }

    #[test]
    fn validation() {
        assert!(validate(&task(Trigger::Interval { every_secs: 3000 })).is_empty());
        assert!(!validate(&task(Trigger::Interval { every_secs: 5 })).is_empty());
        assert!(!validate(&task(Trigger::Daily { minute_of_day: 1440 })).is_empty());
        assert!(!validate(&task(Trigger::Weekly { days_mask: 0, minute_of_day: 0 })).is_empty());
        let mut t = task(Trigger::Once { at: 1 });
        t.name.clear();
        assert!(!validate(&t).is_empty());
    }
}
