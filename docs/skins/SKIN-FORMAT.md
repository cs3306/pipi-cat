# 皮肤包格式 v1（`.petskin`）

皮肤包是**一个 JSON 文件**，只含数据（颜色或图片），不含脚本。安装时软件会逐项校验，不合格直接拒绝。

## 通用字段（全部必填，除 description）

| 字段 | 说明 |
|---|---|
| `schema` | 固定为 `1` |
| `id` | 小写字母、数字、连字符，3–30 个字符，如 `sunny-cat`。同 id 再次安装会替换旧的 |
| `name` | 显示名，1–40 字 |
| `author` | 作者，1–60 字 |
| `license` | 皮肤本身的许可证（如 `CC-BY-4.0`、`CC0-1.0`、`All rights reserved`），1–60 字。**必填**，安装前会显示给用户 |
| `version` | 版本号字符串 |
| `description` | 可选，最多 300 字 |
| `kind` | `"palette"`（颜色皮肤）或 `"sprites"`（图片皮肤）。`"layered"` 为将来保留，当前版本会提示需要更新 |

## 颜色皮肤（`kind: "palette"`）

多一个 `palette` 对象，字段与上游猫皮肤相同：`furColor`（必填）、`outlineColor`、`eyeColorTop`、`noseColor`、`accentColor`、`pattern`（solid/bicolor/tuxedo/tabby/calico/siamese）、`spots`（最多 24 个斑点）等。
所有名字里带 `color` 的字段必须是 `#rgb`、`#rgba`、`#rrggbb` 或 `#rrggbbaa`。不能含图片。

## 图片皮肤（`kind: "sprites"`）

多一个 `sprites` 对象，键为状态名，值为 `data:image/png;base64,...` 或 `data:image/webp;base64,...`：

| 键 | 何时显示 |
|---|---|
| `idle` | 默认（**必填**） |
| `blink` | 随机眨眼（约 140 毫秒） |
| `happy` | 打字较快、或做「开心」反应时 |
| `shy` | 被「歪头」类反应触发时（约 1.2 秒） |

限制：每张图 ≤ 1.5 MB，全部图片合计 ≤ 4 MB；PNG 每边 ≤ 2048 像素；整个文件 ≤ 8 MB。软件检查图片的**真实文件头**，不看扩展名；SVG 不被接受。
图片会被等比缩放进约 300 × 260 的区域，底边对齐猫的位置；键盘和鼠标仍由软件绘制并盖在图片前面。透明背景请使用带 alpha 的 PNG/WebP。

## 制作

1. 建一个文件夹，放 `skin.json`（通用字段 + `kind`），再放 `palette.json`（颜色皮肤）或 `idle.png`、`blink.png`…（图片皮肤）。
2. 运行 `node tools/pack-skin.mjs <文件夹> [输出.petskin]`。
3. 示例见 `docs/skins/examples/sunny-palette/`。

## 分发与许可

- 本软件不提供在线商店，也不联网下载皮肤；分发方式由作者自己决定。
- 皮肤的版权与许可证属于皮肤作者，与本软件的许可证无关。请不要打包你没有权利分发的图片（例如他人的角色形象）。
- 内置皮肤「大肥鱼」的素材许可见 `src/assets/dafeiyu/LICENSE-MIT.txt`。

## kind: "layered"（分层皮肤）
`{ schema:1, id, name, author, license, version, kind:"layered", rig:{ scale?, parts:{ torso, head, limbs?, tail? } } }`。
字段含义、降级规则与限制见 `RIG-SPEC.md`。示例：`examples/blocky-rig/blocky-orange.petskin`（程序生成的测试皮肤，CC0）。
分层皮肤目前只能用制作器生成（打包脚本 `tools/pack-skin.mjs` 暂不支持这种种类）。

## 安装位置与文件管理
- 已安装的皮肤是 `app_data/skins/<id>.petskin`（已校验的原文）。同 id 再次安装时，旧文件保留为 `<id>.petskin.prev`（只留一代）。
- 设置 → 皮肤 →「打开皮肤文件夹」可以直接看到这些文件。**手动复制进去的文件不会自动生效**：它会在列表里显示「未登记」，必须点「重新安装…」并在确认卡里确认（这样每个皮肤都经过作者/许可证展示与校验）。
- 颜色皮肤另外登记在 `cats.json`（id = `skin-<id>`）；皮肤文件被手动删除后，对应的悬空条目会被自动清理。
- 颜色皮肤 palette 里的可选字段：`schemaVersion`（1 或 2）、`apronColor`、`mouthInnerColor`、`tongueColor`（均为 `#rrggbb`），缺省时按毛色推导。
