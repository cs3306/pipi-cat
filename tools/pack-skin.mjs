#!/usr/bin/env node
// 把一个文件夹打包成 .petskin（单个 JSON 文件，图片以 data URI 内嵌）。无需任何依赖。
//
// 文件夹结构：
//   skin.json      元数据：{ "id", "name", "author", "license", "version", "description"?, "kind" }
//   palette.json   kind = "palette" 时必须有：颜色/斑点配置（见 docs/skins/SKIN-FORMAT.md）
//   idle.png|webp  kind = "sprites" 时必须有；blink / happy / shy 可选
//
// 用法：node tools/pack-skin.mjs <文件夹> [输出文件]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const SLOTS = ['idle', 'blink', 'happy', 'shy'];

export function buildPack(dir) {
  const metaPath = join(dir, 'skin.json');
  if (!existsSync(metaPath)) throw new Error(`找不到 ${metaPath}`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const pack = { schema: 1, ...meta };
  if (pack.kind === 'palette') {
    const palPath = join(dir, 'palette.json');
    if (!existsSync(palPath)) throw new Error('palette 皮肤需要 palette.json');
    pack.palette = JSON.parse(readFileSync(palPath, 'utf8'));
  } else if (pack.kind === 'sprites') {
    pack.sprites = {};
    for (const slot of SLOTS) {
      for (const ext of ['png', 'webp']) {
        const f = join(dir, `${slot}.${ext}`);
        if (existsSync(f)) {
          pack.sprites[slot] = `data:image/${ext};base64,${readFileSync(f).toString('base64')}`;
          break;
        }
      }
    }
    if (!pack.sprites.idle) throw new Error('图片皮肤必须有 idle.png 或 idle.webp');
  } else {
    throw new Error(`kind 必须是 "palette" 或 "sprites"（当前: ${pack.kind}）`);
  }
  for (const k of ['id', 'name', 'author', 'license', 'version']) {
    if (!pack[k] || !String(pack[k]).trim()) throw new Error(`skin.json 缺少 ${k}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(pack.id)) throw new Error('id 只能用小写字母、数字、连字符，3 到 30 个字符');
  return pack;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pack-skin.mjs')) {
  const [dirArg, outArg] = process.argv.slice(2);
  if (!dirArg) {
    console.error('用法: node tools/pack-skin.mjs <文件夹> [输出文件]');
    process.exit(2);
  }
  try {
    const dir = resolve(dirArg);
    const pack = buildPack(dir);
    const out = resolve(outArg ?? `${basename(dir)}.petskin`);
    writeFileSync(out, JSON.stringify(pack));
    console.log(`已生成 ${out}`);
    console.log('提示：安装时软件会再次校验；图片会检查真实文件头，颜色必须是 #rgb/#rrggbb。');
  } catch (e) {
    console.error(`打包失败：${e.message}`);
    process.exit(1);
  }
}
