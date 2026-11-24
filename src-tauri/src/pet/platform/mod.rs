//! 平台层：所有操作系统相关调用集中在这里，其余代码不出现 cfg(windows) 和 Win32。
//! 两套实现签名完全一致：`windows.rs`（真实实现）与 `other.rs`（保证非 Windows 也能编译，功能关闭）。

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use self::other::*;
