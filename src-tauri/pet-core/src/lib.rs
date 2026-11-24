//! 桌面宠物的纯逻辑核心：不依赖 Tauri、不依赖操作系统 API、不依赖第三方 crate。
//! 所有时间都由调用方传入（单调秒或 Unix 秒），因此全部可确定性单测。

pub mod ai;
pub mod economy;
pub mod overrides;
pub mod focus;
pub mod quiet;
pub mod rig;
pub mod rng;
pub mod sedentary;
pub mod skin;
pub mod tasks;
