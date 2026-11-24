//! 安静时段（本地分钟数，0..1440），支持跨午夜。

/// `start == end` 视为空区间（不安静）。
pub fn in_quiet_hours(enabled: bool, start_minute: u32, end_minute: u32, now_minute: u32) -> bool {
    if !enabled || start_minute == end_minute {
        return false;
    }
    if start_minute < end_minute {
        now_minute >= start_minute && now_minute < end_minute
    } else {
        now_minute >= start_minute || now_minute < end_minute
    }
}

/// Unix 秒 + 本地与 UTC 的偏移秒 → 本地一天中的第几分钟。
pub fn local_minute_of_day(unix_secs: i64, utc_offset_secs: i64) -> u32 {
    (((unix_secs + utc_offset_secs).rem_euclid(86_400)) / 60) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_day_and_overnight() {
        assert!(in_quiet_hours(true, 540, 720, 540));
        assert!(in_quiet_hours(true, 540, 720, 719));
        assert!(!in_quiet_hours(true, 540, 720, 720));
        assert!(!in_quiet_hours(true, 540, 720, 100));
        assert!(in_quiet_hours(true, 1320, 420, 1400));
        assert!(in_quiet_hours(true, 1320, 420, 30));
        assert!(!in_quiet_hours(true, 1320, 420, 800));
    }

    #[test]
    fn disabled_or_empty_interval_is_never_quiet() {
        assert!(!in_quiet_hours(false, 0, 1000, 5));
        assert!(!in_quiet_hours(true, 100, 100, 100));
    }

    #[test]
    fn local_minute_wraps_correctly() {
        assert_eq!(local_minute_of_day(0, 0), 0);
        assert_eq!(local_minute_of_day(3600, 0), 60);
        assert_eq!(local_minute_of_day(0, -3600), 23 * 60); // UTC-1
        assert_eq!(local_minute_of_day(86_399, 0), 1439);
    }
}
