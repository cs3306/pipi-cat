//! 极小的 xorshift64 随机数（猫叫间隔、叫声次数用，不用于任何安全目的）。

pub struct Rng(u64);

impl Rng {
    /// 种子为 0 时会被换成固定非零值。
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// 闭区间 [lo, hi]；hi <= lo 时返回 lo。
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.next_u64() % (hi - lo + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_inclusive_and_deterministic() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..500 {
            let v = a.range(3, 5);
            assert!((3..=5).contains(&v));
            assert_eq!(v, b.range(3, 5));
        }
        assert_eq!(Rng::new(0).range(7, 7), 7);
        assert_ne!(Rng::new(0).next_u64(), 0);
    }
}
