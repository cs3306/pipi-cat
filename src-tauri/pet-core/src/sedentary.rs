//! 久坐判定：连续「有操作」达到 limit 就提醒；无操作 ≥ away 视为起身并重新计时。

pub struct Sedentary {
    since: u64,
}

impl Sedentary {
    pub fn new(now: u64) -> Self {
        Self { since: now }
    }

    /// 外部事件（开始专注、进入休息）也算起身。
    pub fn reset(&mut self, now: u64) {
        self.since = now;
    }

    /// 每秒调用一次。返回 true 表示该提醒了（并自动重新计时）。
    pub fn tick(&mut self, now: u64, idle_secs: u64, away_secs: u64, limit_secs: u64) -> bool {
        if idle_secs >= away_secs {
            self.since = now;
            return false;
        }
        if now.saturating_sub(self.since) >= limit_secs {
            self.since = now;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_after_continuous_activity() {
        let mut s = Sedentary::new(0);
        let mut fired = 0;
        for t in 1..=3000 {
            if s.tick(t, 0, 300, 3000) {
                fired += 1;
            }
        }
        assert_eq!(fired, 1);
    }

    #[test]
    fn leaving_the_desk_resets_the_clock() {
        let mut s = Sedentary::new(0);
        for t in 1..=2900 {
            assert!(!s.tick(t, 0, 300, 3000));
        }
        assert!(!s.tick(2901, 300, 300, 3000)); // 离开 5 分钟
        for t in 2902..=5800 {
            assert!(!s.tick(t, 0, 300, 3000)); // 重新计时，没到 3000 秒
        }
    }

    #[test]
    fn external_reset_counts_as_a_break() {
        let mut s = Sedentary::new(0);
        s.reset(2990);
        assert!(!s.tick(3000, 0, 300, 3000));
    }
}
