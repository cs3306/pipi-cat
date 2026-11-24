# NOTICE

本软件是开源项目 **KuroCat**（<https://github.com/qianyiai/kurocat>，MIT 许可证，© 2026 KuroCat Contributors）的二次开发版本。

- 上游的版权与许可声明见 `LICENSE`，必须随本软件的所有副本一并保留。
- 内置皮肤「大肥鱼（鲸鱼娘）」的运行时素材基于 MIT 项目 PC2005-cloud/dsh-pet（参考衍生 QCYTSN/dsh-dafeiyu），许可声明见 `src/assets/dafeiyu/LICENSE-MIT.txt`。
- 本二次开发版新增部分的版权归其作者所有：`Copyright (c) 2026 <在此填写你的名字或组织>`（发布前请填写，并按 MIT 在 `LICENSE` 里追加同样一行）。

This software is a derivative of **KuroCat** (MIT License, © 2026 KuroCat Contributors). The upstream copyright and permission notice (see `LICENSE`) must be kept in all copies. The bundled "Dafeiyu" skin assets are MIT-licensed by their original authors (see `src/assets/dafeiyu/LICENSE-MIT.txt`). Additions in this derivative: `Copyright (c) 2026 <fill in your name or organisation>`.

## 第三方依赖 / Third-party

新增依赖：`notify`（文件系统通知，CC0-1.0 / 部分代码另含 Artistic-2.0 双许可，以其发布版本的 LICENSE 为准）。Tauri 及其他依赖的许可证清单请在发布前用 `cargo about` 或 `cargo license` 生成，并随安装包提供。

Added dependency: `notify` (filesystem notifications; CC0-1.0, with some code dual-licensed under Artistic-2.0 — see the LICENSE of the released version). Generate the full list for all Rust dependencies with `cargo about` / `cargo license` before release and ship it with the installer.

## 皮肤包 / Skin packs

用户自行安装的皮肤包（.petskin）版权与许可证归其作者，与本软件的许可证无关；安装前界面会显示作者与许可证。本软件不内置在线商店，也不联网下载皮肤。

User-installed skin packs (.petskin) belong to their authors under their own licences, independent of this software's licence; the author and licence are shown before installing. The app has no online store and downloads nothing.

- `ureq`（HTTP 客户端，MIT/Apache-2.0）及其依赖（rustls 等）：完整清单发布前用 cargo-about 生成。
