//! 新增功能的设置，独立存放在 pet.json。
//!
//! 为什么不放进 AppSettings：上游 `update_settings` 接收整个 AppSettings 并整体覆盖，
//! 旧前端（菜单、托盘）发回的结构里没有新字段，会把新字段重置成默认值。
//! 独立文件 + 独立命令，互不影响，也减少与上游 config.rs 的合并冲突。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PetSettings {
    /// 存档结构版本，将来改字段时用于迁移。
    pub schema_version: u32,
    /// "auto" | "zh" | "en"
    pub language: String,
    pub file_reactions: bool,
    /// 首次启动是否已经问过用户（问过之前设置窗口会自动弹出）。
    pub file_reactions_asked: bool,
    pub mute_file_reactions_in_focus: bool,
    pub focus_minutes: u32,
    pub break_minutes: u32,
    pub reward_per_session: u32,
    pub idle_threshold_secs: u32,
    pub cafe_enabled: bool,
    pub meow_enabled: bool,
    /// 0.0..=1.0
    pub meow_volume: f32,
    pub meow_min_minutes: u32,
    pub meow_max_minutes: u32,
    pub quiet_enabled: bool,
    /// 本地时间，从 0 点起的分钟数。
    pub quiet_start_minute: u32,
    pub quiet_end_minute: u32,
    /// 定时关机默认是否强制关闭未保存的程序（默认否）。
    pub shutdown_force_default: bool,
    /// 文件反应监听的位置（只看「有文件新建/删除」这一事实，不读文件名）。
    /// 取值：desktop / downloads / documents。默认三者都不选，由用户勾选。
    pub watch_folders: Vec<String>,
    /// 专注时猫的显示方式："normal" | "dim" | "hidden"。默认正常。
    pub focus_view: String,
    /// 临时停用对默认皮肤的覆盖（托盘「使用内置外观」）。覆盖文件不删除，随时可重新启用。
    pub ignore_overrides: bool,
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            language: "auto".into(),
            file_reactions: false,
            file_reactions_asked: false,
            mute_file_reactions_in_focus: true,
            focus_minutes: 25,
            break_minutes: 5,
            reward_per_session: 10,
            idle_threshold_secs: 30,
            cafe_enabled: true,
            meow_enabled: false,
            meow_volume: 0.6,
            meow_min_minutes: 3,
            meow_max_minutes: 12,
            quiet_enabled: false,
            quiet_start_minute: 9 * 60,
            quiet_end_minute: 12 * 60,
            shutdown_force_default: false,
            watch_folders: Vec::new(),
            focus_view: "normal".into(),
            ignore_overrides: false,
        }
    }
}

impl PetSettings {
    /// 把任意来源（磁盘、前端）的值夹到合法范围。
    pub fn sanitize(&mut self) {
        self.schema_version = 1; // 目前只有 v1；将来在这里按旧版本号做迁移
        if !matches!(self.language.as_str(), "auto" | "zh" | "en") {
            self.language = "auto".into();
        }
        self.focus_minutes = self.focus_minutes.clamp(1, 180);
        self.break_minutes = self.break_minutes.clamp(1, 60);
        self.reward_per_session = self.reward_per_session.min(1000);
        self.idle_threshold_secs = self.idle_threshold_secs.clamp(5, 600);
        self.meow_volume = if self.meow_volume.is_finite() { self.meow_volume.clamp(0.0, 1.0) } else { 0.6 };
        self.meow_min_minutes = self.meow_min_minutes.clamp(1, 240);
        self.meow_max_minutes = self.meow_max_minutes.clamp(self.meow_min_minutes, 480);
        self.quiet_start_minute = self.quiet_start_minute.min(1439);
        self.quiet_end_minute = self.quiet_end_minute.min(1439);
        self.watch_folders.retain(|f| matches!(f.as_str(), "desktop" | "downloads" | "documents"));
        self.watch_folders.sort();
        self.watch_folders.dedup();
        self.focus_view = pet_core::overrides::normalize_focus_view(&self.focus_view).into();
    }
}

/// 当前本地时间是否落在安静时段内（逻辑在 pet-core，可单测）。
pub fn in_quiet_hours(s: &PetSettings, local_minute_of_day: u32) -> bool {
    pet_core::quiet::in_quiet_hours(s.quiet_enabled, s.quiet_start_minute, s.quiet_end_minute, local_minute_of_day)
}

pub fn path() -> PathBuf {
    crate::config::app_data_dir().join("pet.json")
}

pub fn load() -> PetSettings {
    let mut s = std::fs::read_to_string(path())
        .ok()
        .and_then(|t| serde_json::from_str::<PetSettings>(&t).ok())
        .unwrap_or_default();
    s.sanitize();
    s
}

pub fn save(s: &PetSettings) {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(p, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_hours_same_day_and_overnight() {
        let mut s = PetSettings { quiet_enabled: true, quiet_start_minute: 540, quiet_end_minute: 720, ..Default::default() };
        assert!(in_quiet_hours(&s, 540) && in_quiet_hours(&s, 719));
        assert!(!in_quiet_hours(&s, 720) && !in_quiet_hours(&s, 100));
        s.quiet_start_minute = 1320;
        s.quiet_end_minute = 420;
        assert!(in_quiet_hours(&s, 1400) && in_quiet_hours(&s, 30) && !in_quiet_hours(&s, 800));
        s.quiet_enabled = false;
        assert!(!in_quiet_hours(&s, 1400));
    }

    #[test]
    fn sanitize_clamps_everything() {
        let mut s = PetSettings { language: "xx".into(), focus_minutes: 0, break_minutes: 999, meow_volume: f32::NAN, meow_min_minutes: 50, meow_max_minutes: 5, ..Default::default() };
        s.sanitize();
        assert_eq!(s.language, "auto");
        assert_eq!((s.focus_minutes, s.break_minutes), (1, 60));
        assert_eq!(s.meow_volume, 0.6);
        assert!(s.meow_max_minutes >= s.meow_min_minutes);
    }

    #[test]
    fn watch_folders_only_known_values_sorted_unique() {
        let mut s = PetSettings { watch_folders: vec!["downloads".into(), "C:\\Windows".into(), "desktop".into(), "downloads".into()], ..Default::default() };
        s.sanitize();
        assert_eq!(s.watch_folders, vec!["desktop", "downloads"]);
    }

    #[test]
    fn focus_view_defaults_to_normal_and_is_normalized() {
        let mut s = PetSettings::default();
        assert_eq!(s.focus_view, "normal");
        assert!(!s.ignore_overrides);
        s.focus_view = "bogus".into();
        s.sanitize();
        assert_eq!(s.focus_view, "normal");
        s.focus_view = "hidden".into();
        s.sanitize();
        assert_eq!(s.focus_view, "hidden");
    }

    #[test]
    fn partial_json_fills_defaults() {
        let s: PetSettings = serde_json::from_str(r#"{"focusMinutes":40}"#).unwrap();
        assert_eq!(s.focus_minutes, 40);
        assert!(!s.file_reactions, "file reactions default off");
        assert!(!s.meow_enabled, "meowing default off");
    }
}
