//! 提醒任务的存档结构（tasks.json）与内置任务。校验委托给 pet-core 的 tasks 模块。

use pet_core::tasks::{self, Task, TaskAction, Trigger};
use serde::{Deserialize, Serialize};

// ───────────────────────── 任务 DTO（存 tasks.json） ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// "interval" | "daily" | "weekly" | "once" | "sedentary"
    pub kind: String,
    /// interval：间隔分钟；sedentary：连续操作多少分钟后提醒。
    pub every_minutes: u32,
    /// sedentary：无操作多少分钟算起身。
    pub away_minutes: u32,
    pub minute_of_day: u32,
    /// bit0=周日 … bit6=周六
    pub days_mask: u8,
    /// once：Unix 秒
    pub at: i64,
    pub lead_minutes: u32,
    /// 为空时前端用该内置任务的默认文案（便于多语言）。
    pub message: String,
    pub animation: String,
    pub sound: bool,
}

impl Default for TaskDto {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: false,
            kind: "interval".into(),
            every_minutes: 60,
            away_minutes: 5,
            minute_of_day: 9 * 60,
            days_mask: 0b0111110, // 周一到周五
            at: 0,
            lead_minutes: 0,
            message: String::new(),
            animation: "remind".into(),
            sound: false,
        }
    }
}

impl TaskDto {
    pub fn trigger(&self) -> Option<Trigger> {
        match self.kind.as_str() {
            "interval" => Some(Trigger::Interval { every_secs: self.every_minutes as u64 * 60 }),
            "daily" => Some(Trigger::Daily { minute_of_day: self.minute_of_day }),
            "weekly" => Some(Trigger::Weekly { days_mask: self.days_mask, minute_of_day: self.minute_of_day }),
            "once" => Some(Trigger::Once { at: self.at }),
            _ => None, // sedentary 由调度线程按「连续操作时长」处理
        }
    }

    pub fn to_task(&self) -> Option<Task> {
        Some(Task {
            id: self.id.clone(),
            // 内置任务名称为空（前端按语言显示），校验时用 id 代替
            name: if self.name.is_empty() { self.id.clone() } else { self.name.clone() },
            enabled: self.enabled,
            trigger: self.trigger()?,
            lead_secs: self.lead_minutes as u64 * 60,
            action: TaskAction::Remind {
                message: self.message.clone(),
                animation_id: self.animation.clone(),
                sound: self.sound,
            },
        })
    }

    pub fn validate(&self) -> Vec<String> {
        let mut errs = Vec::new();
        if self.message.chars().count() > 200 {
            errs.push("message must be <= 200 chars".into());
        }
        match self.kind.as_str() {
            "sedentary" => {
                if self.id.is_empty() || self.id.len() > 64 {
                    errs.push("id must be 1..64 chars".into());
                }
                if self.every_minutes < 5 || self.away_minutes < 1 {
                    errs.push("sedentary: every_minutes >= 5 and away_minutes >= 1".into());
                }
            }
            "interval" | "daily" | "weekly" | "once" => {
                if let Some(t) = self.to_task() {
                    errs.extend(tasks::validate(&t));
                }
            }
            other => errs.push(format!("unknown kind: {other}")),
        }
        errs
    }
}

pub fn builtin_tasks() -> Vec<TaskDto> {
    let mk = |id: &str, kind: &str, every: u32, anim: &str| TaskDto {
        id: id.into(),
        name: String::new(), // 内置任务的名称由前端按语言显示
        kind: kind.into(),
        every_minutes: every,
        animation: anim.into(),
        ..Default::default()
    };
    vec![
        mk("builtin-sit", "sedentary", 50, "remind"),
        mk("builtin-water", "interval", 60, "remind"),
        mk("builtin-eyes", "interval", 20, "remind"),
    ]
}

pub struct TaskRt {
    pub dto: TaskDto,
    pub anchor: i64,
    pub next: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_roundtrip_and_defaults() {
        let t: TaskDto = serde_json::from_str(r#"{"id":"a","kind":"daily"}"#).unwrap();
        assert_eq!(t.minute_of_day, 540);
        assert!(!t.enabled, "tasks are off unless the user turns them on");
        assert!(t.validate().is_empty(), "empty name falls back to id");
        let bad: TaskDto = serde_json::from_str(r#"{"id":"b","kind":"daily","minuteOfDay":2000}"#).unwrap();
        assert!(!bad.validate().is_empty());
        let unknown: TaskDto = serde_json::from_str(r#"{"id":"c","kind":"nope"}"#).unwrap();
        assert!(!unknown.validate().is_empty());
    }

    #[test]
    fn builtin_tasks_start_disabled() {
        assert!(builtin_tasks().iter().all(|t| !t.enabled));
        assert_eq!(builtin_tasks().len(), 3);
    }
}
