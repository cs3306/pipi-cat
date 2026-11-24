//! 默认皮肤（内置黑猫/布偶）的「覆盖」与回滚的纯逻辑：不碰文件、不碰 JSON，只做决定。
//!
//! 原则：内置外观永远不被修改。覆盖是另存的一份文件；渲染前先查覆盖，覆盖有任何问题就退回内置。
//! 回滚四层：撤销上一次 → 恢复该皮肤默认 → 恢复全部 → 兜底（覆盖损坏/用户停用覆盖时退回内置）。

/// 允许覆盖的内置皮肤。大肥鱼是图片帧，不能原地改；其他内置猫暂不开放，等有需求再加。
pub const OVERRIDABLE: [&str; 2] = ["black", "ragdoll"];

/// 内置外观的版本号。以后新版本改了黑猫/布偶的内置外观时加 1，
/// 已有的覆盖会因为「基于旧版本」被标记为需要用户确认（保留 / 恢复默认）。
pub const BUILTIN_LOOK_VERSION: u32 = 1;

pub fn is_overridable(id: &str) -> bool {
    OVERRIDABLE.contains(&id)
}

/// 允许作为「复制成新皮肤」起点的内置皮肤：所有程序绘制的颜色型猫（不含大肥鱼）。
pub fn is_copyable_builtin(id: &str) -> bool {
    matches!(id, "black" | "ragdoll" | "orange-tabby" | "calico" | "tuxedo" | "siamese")
}

/// 启动/渲染时对一个覆盖文件的处理结果。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum LoadDecision {
    /// 没有覆盖，或用户停用了覆盖：用内置。
    UseBuiltin,
    /// 覆盖有效，直接用。
    UseOverride,
    /// 覆盖有效但基于旧版内置外观：仍然使用，同时提示用户确认。
    UseOverrideNeedsReview,
    /// 覆盖文件存在但损坏或校验不过：退回内置，并告诉用户。
    FallbackCorrupt,
}

pub fn decide_load(exists: bool, ignored: bool, parse_ok: bool, base_version: u32, current: u32) -> LoadDecision {
    if !exists || ignored {
        return LoadDecision::UseBuiltin;
    }
    if !parse_ok {
        return LoadDecision::FallbackCorrupt;
    }
    if base_version < current {
        LoadDecision::UseOverrideNeedsReview
    } else {
        LoadDecision::UseOverride
    }
}

/// 备份槽（上一代）里是什么。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Backup {
    /// 没有备份：没有可撤销的操作。
    None,
    /// 备份的是「当时没有覆盖」（也就是内置外观）。
    WasBuiltin,
    /// 备份的是一份覆盖文件。
    WasOverride,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum UndoAction {
    Nothing,
    /// 当前覆盖删掉，回到内置外观。
    RemoveCurrent,
    /// 用备份文件替换当前覆盖。
    RestoreBackup,
}

/// 「撤销上一次」只回退一代：撤销之后备份槽清空，不能连续撤销。
pub fn plan_undo(backup: Backup) -> UndoAction {
    match backup {
        Backup::None => UndoAction::Nothing,
        Backup::WasBuiltin => UndoAction::RemoveCurrent,
        Backup::WasOverride => UndoAction::RestoreBackup,
    }
}

/// 保存新覆盖前，备份槽应该记什么：原来有覆盖就备份它，原来没有就记「内置」。
pub fn backup_before_save(had_current: bool) -> Backup {
    if had_current {
        Backup::WasOverride
    } else {
        Backup::WasBuiltin
    }
}

/// 「恢复该皮肤默认」：当前覆盖移进备份槽（还能撤销回来）；本来就没有覆盖则什么也不做。
pub fn backup_before_reset(had_current: bool) -> Option<Backup> {
    if had_current {
        Some(Backup::WasOverride)
    } else {
        None
    }
}

/// 专注时猫的显示方式。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FocusView {
    Normal,
    Dim,
    Hidden,
}

pub fn parse_focus_view(s: &str) -> FocusView {
    match s {
        "dim" => FocusView::Dim,
        "hidden" => FocusView::Hidden,
        _ => FocusView::Normal,
    }
}

pub fn normalize_focus_view(s: &str) -> &'static str {
    match parse_focus_view(s) {
        FocusView::Normal => "normal",
        FocusView::Dim => "dim",
        FocusView::Hidden => "hidden",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_black_and_ragdoll_are_overridable() {
        assert!(is_overridable("black") && is_overridable("ragdoll"));
        assert!(!is_overridable("dafeiyu"));
        assert!(!is_overridable("calico"));
        assert!(!is_overridable("skin-abc"));
        assert!(!is_overridable("../black"));
    }

    #[test]
    fn dafeiyu_cannot_be_copied_as_palette() {
        assert!(is_copyable_builtin("siamese"));
        assert!(!is_copyable_builtin("dafeiyu"));
        assert!(!is_copyable_builtin("skin-x"));
    }

    #[test]
    fn load_decision_covers_every_layer() {
        let cur = BUILTIN_LOOK_VERSION;
        assert_eq!(decide_load(false, false, true, cur, cur), LoadDecision::UseBuiltin);
        assert_eq!(decide_load(true, true, true, cur, cur), LoadDecision::UseBuiltin, "user switched overrides off");
        assert_eq!(decide_load(true, false, false, cur, cur), LoadDecision::FallbackCorrupt);
        assert_eq!(decide_load(true, false, true, cur, cur), LoadDecision::UseOverride);
        assert_eq!(decide_load(true, false, true, cur - 1, cur), LoadDecision::UseOverrideNeedsReview);
        // 停用优先于损坏：停用时不去碰损坏的文件，也不报错
        assert_eq!(decide_load(true, true, false, cur, cur), LoadDecision::UseBuiltin);
        // 比当前还新（用户降级了程序）：照用，不提示
        assert_eq!(decide_load(true, false, true, cur + 3, cur), LoadDecision::UseOverride);
    }

    #[test]
    fn undo_is_one_generation_only() {
        assert_eq!(plan_undo(Backup::None), UndoAction::Nothing);
        assert_eq!(plan_undo(Backup::WasBuiltin), UndoAction::RemoveCurrent);
        assert_eq!(plan_undo(Backup::WasOverride), UndoAction::RestoreBackup);
    }

    #[test]
    fn first_save_can_be_undone_back_to_builtin() {
        let b = backup_before_save(false);
        assert_eq!(plan_undo(b), UndoAction::RemoveCurrent);
        let b = backup_before_save(true);
        assert_eq!(plan_undo(b), UndoAction::RestoreBackup);
    }

    #[test]
    fn reset_keeps_a_way_back_only_if_there_was_something() {
        assert_eq!(backup_before_reset(false), None);
        let b = backup_before_reset(true).unwrap();
        assert_eq!(plan_undo(b), UndoAction::RestoreBackup);
    }

    #[test]
    fn focus_view_parsing_defaults_to_normal() {
        assert_eq!(parse_focus_view("hidden"), FocusView::Hidden);
        assert_eq!(parse_focus_view("dim"), FocusView::Dim);
        assert_eq!(parse_focus_view("normal"), FocusView::Normal);
        assert_eq!(parse_focus_view(""), FocusView::Normal);
        assert_eq!(parse_focus_view("HIDDEN"), FocusView::Normal);
        assert_eq!(normalize_focus_view("whatever"), "normal");
        assert_eq!(normalize_focus_view("dim"), "dim");
    }
}
