//! 金币与零食的纯逻辑（无 IO、无时钟）。
//!
//! 规则：只有完整结束一个专注时段才结算；喂食扣币、只触发动画、不改变任何数值。
//! 结算以「专注开始的 Unix 秒」作为时段 id，跨进程重启也不会重复（计数器每次启动会从 1 重来，不能用）。

pub const MAX_SETTLED: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GameState {
    pub coins: u64,
    /// 已结算过的时段 id（最近 MAX_SETTLED 个）。
    pub settled: Vec<u64>,
    pub completed: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Snack {
    pub id: &'static str,
    pub price: u64,
    /// 前端动画 id。
    pub animation: &'static str,
}

/// 1.0 beta 只有两种零食；猫薄荷（兴奋状态）暂缓。
pub const SNACKS: [Snack; 2] = [
    Snack { id: "churu", price: 5, animation: "snack.churu" },
    Snack { id: "canned", price: 15, animation: "snack.canned" },
];

pub fn snack(id: &str) -> Option<&'static Snack> {
    SNACKS.iter().find(|s| s.id == id)
}

/// 结算一个完整的专注时段；同一 id 重复结算返回 0。返回实际发放的金额。
pub fn settle(state: &mut GameState, session_id: u64, reward: u64) -> u64 {
    if state.settled.contains(&session_id) {
        return 0;
    }
    state.settled.push(session_id);
    if state.settled.len() > MAX_SETTLED {
        let drop = state.settled.len() - MAX_SETTLED;
        state.settled.drain(0..drop);
    }
    state.coins = state.coins.saturating_add(reward);
    state.completed += 1;
    reward
}

#[derive(Debug, PartialEq, Eq)]
pub enum BuyError {
    Unknown,
    Insufficient { need: u64 },
}

pub fn buy(state: &mut GameState, id: &str) -> Result<&'static Snack, BuyError> {
    let s = snack(id).ok_or(BuyError::Unknown)?;
    if state.coins < s.price {
        return Err(BuyError::Insufficient { need: s.price - state.coins });
    }
    state.coins -= s.price;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settle_is_idempotent_per_session() {
        let mut g = GameState::default();
        assert_eq!(settle(&mut g, 1_700_000_000, 10), 10);
        assert_eq!(settle(&mut g, 1_700_000_000, 10), 0);
        assert_eq!(g.coins, 10);
        assert_eq!(g.completed, 1);
        assert_eq!(settle(&mut g, 1_700_000_100, 10), 10);
        assert_eq!(g.coins, 20);
    }

    #[test]
    fn settled_history_is_bounded() {
        let mut g = GameState::default();
        for i in 0..(MAX_SETTLED as u64 + 20) {
            settle(&mut g, i + 1, 1);
        }
        assert_eq!(g.settled.len(), MAX_SETTLED);
        assert_eq!(g.completed, MAX_SETTLED as u64 + 20);
    }

    #[test]
    fn buy_deducts_or_rejects() {
        let mut g = GameState { coins: 14, ..Default::default() };
        assert_eq!(buy(&mut g, "churu").unwrap().id, "churu");
        assert_eq!(g.coins, 9);
        assert_eq!(buy(&mut g, "canned"), Err(BuyError::Insufficient { need: 6 }));
        assert_eq!(g.coins, 9, "failed purchase does not deduct");
        assert_eq!(buy(&mut g, "nope"), Err(BuyError::Unknown));
        assert_eq!(buy(&mut g, "toString"), Err(BuyError::Unknown));
    }
}
