//! 专注模式（番茄钟）状态机。纯逻辑、零依赖、时钟由调用方注入（单调秒数）。
//!
//! 规则（交接文档 §6.1）：
//! - 专注 → 休息 → 空闲，自动流转；
//! - 只有「完整结束一个专注时段」才产生奖励事件，中途取消不给；
//! - 「无操作」只用最后一次输入的时间戳判断，不记录任何输入内容。
//!
//! 接线方式：后台线程每秒调用 `tick(now)`，把返回的事件 `emit` 给前端；
//! 输入钩子线程在收到输入事件时调用 `note_input(now)`。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Focus,
    Break,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FocusConfig {
    pub focus_secs: u64,
    pub break_secs: u64,
    pub idle_threshold_secs: u64,
}

impl Default for FocusConfig {
    fn default() -> Self {
        Self {
            focus_secs: 25 * 60,
            break_secs: 5 * 60,
            idle_threshold_secs: 30,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusEvent {
    FocusStarted { session: u64 },
    /// 完整结束一个专注时段；奖励金额由经济模块按配置决定。
    FocusCompleted { session: u64 },
    FocusCancelled { session: u64 },
    BreakStarted { session: u64 },
    BreakEnded { session: u64 },
}

#[derive(Debug)]
pub struct FocusMachine {
    cfg: FocusConfig,
    phase: Phase,
    phase_started: u64,
    session: u64,
    last_input: u64,
}

impl FocusMachine {
    pub fn new(cfg: FocusConfig, now: u64) -> Self {
        Self {
            cfg,
            phase: Phase::Idle,
            phase_started: now,
            session: 0,
            last_input: now,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn session(&self) -> u64 {
        self.session
    }

    /// 修改配置；对已在进行的时段，下一次 tick 起按新时长判断。
    pub fn set_config(&mut self, cfg: FocusConfig) {
        self.cfg = cfg;
    }

    /// 开始专注。已在专注/休息中则忽略（返回空）。
    pub fn start(&mut self, now: u64) -> Vec<FocusEvent> {
        if self.phase != Phase::Idle {
            return Vec::new();
        }
        self.session += 1;
        self.phase = Phase::Focus;
        self.phase_started = now;
        vec![FocusEvent::FocusStarted { session: self.session }]
    }

    /// 取消。专注中取消 → 不给奖励；休息中取消 → 直接回到空闲（奖励早已结算）。
    pub fn cancel(&mut self, now: u64) -> Vec<FocusEvent> {
        match self.phase {
            Phase::Idle => Vec::new(),
            Phase::Focus => {
                self.phase = Phase::Idle;
                self.phase_started = now;
                vec![FocusEvent::FocusCancelled { session: self.session }]
            }
            Phase::Break => {
                self.phase = Phase::Idle;
                self.phase_started = now;
                vec![FocusEvent::BreakEnded { session: self.session }]
            }
        }
    }

    /// 推进时间。可能一次返回多个事件（例如长时间挂起后恢复）。
    pub fn tick(&mut self, now: u64) -> Vec<FocusEvent> {
        let mut out = Vec::new();
        loop {
            let elapsed = now.saturating_sub(self.phase_started);
            match self.phase {
                Phase::Focus if elapsed >= self.cfg.focus_secs => {
                    let end = self.phase_started + self.cfg.focus_secs;
                    out.push(FocusEvent::FocusCompleted { session: self.session });
                    self.phase = Phase::Break;
                    self.phase_started = end;
                    out.push(FocusEvent::BreakStarted { session: self.session });
                }
                Phase::Break if elapsed >= self.cfg.break_secs => {
                    out.push(FocusEvent::BreakEnded { session: self.session });
                    self.phase = Phase::Idle;
                    self.phase_started = self.phase_started + self.cfg.break_secs;
                }
                _ => break,
            }
        }
        out
    }

    /// 记录一次输入（只有时间，没有内容）。
    pub fn note_input(&mut self, now: u64) {
        self.last_input = self.last_input.max(now);
    }

    /// 专注中且无操作超过阈值 → 播放猫咖动画；一有输入立即为 false。
    pub fn should_play_cafe(&self, now: u64) -> bool {
        self.phase == Phase::Focus
            && now.saturating_sub(self.last_input) >= self.cfg.idle_threshold_secs
    }

    /// 当前阶段剩余秒数（空闲返回 0）。
    pub fn remaining(&self, now: u64) -> u64 {
        let total = match self.phase {
            Phase::Idle => return 0,
            Phase::Focus => self.cfg.focus_secs,
            Phase::Break => self.cfg.break_secs,
        };
        total.saturating_sub(now.saturating_sub(self.phase_started))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> FocusConfig {
        FocusConfig { focus_secs: 100, break_secs: 20, idle_threshold_secs: 30 }
    }

    #[test]
    fn full_cycle_emits_reward_once() {
        let mut m = FocusMachine::new(cfg(), 0);
        assert_eq!(m.start(0), vec![FocusEvent::FocusStarted { session: 1 }]);
        assert!(m.tick(99).is_empty());
        assert_eq!(
            m.tick(100),
            vec![FocusEvent::FocusCompleted { session: 1 }, FocusEvent::BreakStarted { session: 1 }]
        );
        assert!(m.tick(110).is_empty());
        assert_eq!(m.tick(120), vec![FocusEvent::BreakEnded { session: 1 }]);
        assert_eq!(m.phase(), Phase::Idle);
        assert!(m.tick(500).is_empty(), "no second reward");
    }

    #[test]
    fn cancel_during_focus_gives_no_reward() {
        let mut m = FocusMachine::new(cfg(), 0);
        m.start(0);
        assert_eq!(m.cancel(50), vec![FocusEvent::FocusCancelled { session: 1 }]);
        assert!(m.tick(1000).is_empty());
        assert_eq!(m.phase(), Phase::Idle);
    }

    #[test]
    fn cancel_during_break_keeps_earlier_reward_semantics() {
        let mut m = FocusMachine::new(cfg(), 0);
        m.start(0);
        m.tick(100);
        assert_eq!(m.cancel(105), vec![FocusEvent::BreakEnded { session: 1 }]);
    }

    #[test]
    fn start_is_ignored_unless_idle_and_sessions_increase() {
        let mut m = FocusMachine::new(cfg(), 0);
        m.start(0);
        assert!(m.start(10).is_empty());
        m.tick(120);
        assert_eq!(m.start(130), vec![FocusEvent::FocusStarted { session: 2 }]);
    }

    #[test]
    fn long_suspend_resolves_all_transitions_in_one_tick() {
        let mut m = FocusMachine::new(cfg(), 0);
        m.start(0);
        let ev = m.tick(10_000);
        assert_eq!(ev.len(), 3);
        assert_eq!(ev[0], FocusEvent::FocusCompleted { session: 1 });
        assert_eq!(m.phase(), Phase::Idle);
    }

    #[test]
    fn cafe_animation_only_when_focus_and_idle() {
        let mut m = FocusMachine::new(cfg(), 0);
        assert!(!m.should_play_cafe(1000), "idle phase never plays cafe");
        m.start(0);
        assert!(!m.should_play_cafe(29));
        assert!(m.should_play_cafe(30));
        m.note_input(40);
        assert!(!m.should_play_cafe(41), "any input switches back immediately");
        assert!(m.should_play_cafe(70));
        m.tick(100);
        assert!(!m.should_play_cafe(500), "break phase never plays cafe");
    }

    #[test]
    fn remaining_counts_down() {
        let mut m = FocusMachine::new(cfg(), 0);
        assert_eq!(m.remaining(5), 0);
        m.start(10);
        assert_eq!(m.remaining(10), 100);
        assert_eq!(m.remaining(60), 50);
        assert_eq!(m.remaining(999), 0);
    }

    #[test]
    fn out_of_order_clock_does_not_panic() {
        let mut m = FocusMachine::new(cfg(), 100);
        m.start(100);
        assert!(m.tick(50).is_empty());
        assert_eq!(m.remaining(50), 100);
        m.note_input(10);
        assert!(!m.should_play_cafe(50));
    }
}
