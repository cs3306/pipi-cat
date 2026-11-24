// 皮肤制作器的纯逻辑：根据表单内容构建 .petskin，并做和后端一致的预检。
// 预检只是为了让用户早点看到问题；真正的校验始终在安装时由后端（pet-core）再做一次。
// 不依赖 DOM / Tauri，可以用 node 直接测试。

export const SLOTS = ['idle', 'blink', 'happy', 'shy'] as const;
export type Slot = (typeof SLOTS)[number];

export const LIMITS = {
  idMin: 3,
  idMax: 30,
  imageBytes: 1_500_000,
  totalImageBytes: 4_000_000,
  packBytes: 8_000_000,
  pngSide: 2048,
  spots: 24,
} as const;

export interface MakerMeta {
  id: string;
  name: string;
  author: string;
  license: string;
  version: string;
  description?: string;
}

export interface MakerInput {
  meta: MakerMeta;
  kind: 'palette' | 'sprites' | 'layered';
  palette?: Record<string, unknown>;
  /** 分层皮肤：与皮肤包里的 rig 同形 { scale, parts: { torso, head, limbs?, tail? } } */
  rig?: Record<string, unknown>;
  /** data:image/png;base64,... 或 data:image/webp;base64,... */
  sprites?: Partial<Record<Slot, string>>;
}

export type BuildResult = { ok: true; pack: Record<string, unknown>; json: string } | { ok: false; errors: string[] };

// 与后端 pet-core::skin::is_hex_color 一致：#rgb / #rgba / #rrggbb / #rrggbbaa
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ID = /^[a-z0-9][a-z0-9-]{2,29}$/;

export const isHexColor = (s: unknown): s is string => typeof s === 'string' && HEX.test(s);

const RGB_RE = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/i;

/** `rgba(210, 212, 216, 0.64)` → `#d2d4d8a3`。内置猫用 rgba 写半透明，皮肤格式只认十六进制。无法识别的原样返回。 */
export function rgbToHex(s: string): string {
  const m = RGB_RE.exec(s.trim());
  if (!m) return s;
  const ch = (x: string): number => Math.min(255, Number(x));
  const h2 = (n: number): string => n.toString(16).padStart(2, '0');
  let out = '#' + h2(ch(m[1])) + h2(ch(m[2])) + h2(ch(m[3]));
  if (m[4] !== undefined) {
    const a = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    if (Number.isFinite(a) && a < 1) out += h2(Math.round(Math.max(0, a) * 255));
  }
  return out;
}

/** 把调色盘里所有「…Color」字段的 rgb()/rgba() 转成十六进制，并去掉值为 null 的颜色字段。不改动原对象。 */
export function normalizeColors<T>(v: T, key = ''): T {
  if (typeof v === 'string' && /color$/i.test(key)) return rgbToHex(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => normalizeColors(x, key)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null && /color$/i.test(k)) continue;
      out[k] = normalizeColors(x, k);
    }
    return out as T;
  }
  return v;
}

/** 把名字转成合法 id 的建议值（可能不够长，调用方需要再检查）。 */
export function suggestId(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.idMax);
  return s;
}

function b64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 检查一张图片的 data URI：真实文件头、大小、PNG 尺寸。返回错误码或 null。 */
export function imageError(dataUri: string): string | null {
  const m = /^data:image\/(png|webp);base64,(.*)$/s.exec(dataUri);
  if (!m) return 'not-an-image';
  const bytes = b64Bytes(m[2]);
  if (!bytes) return 'not-an-image';
  if (bytes.length > LIMITS.imageBytes) return 'image-too-large';
  const isPng = bytes.length > 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
  const isWebp =
    bytes.length > 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!isPng && !isWebp) return 'not-an-image';
  if (isPng) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    if (w === 0 || h === 0 || w > LIMITS.pngSide || h > LIMITS.pngSide) return 'image-dimensions';
  }
  return null;
}

export function paletteErrors(p: Record<string, unknown> | undefined): string[] {
  if (!p || typeof p !== 'object') return ['palette-needs-furColor'];
  const errs: string[] = [];
  if (typeof p.furColor !== 'string') errs.push('palette-needs-furColor');
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string' && /color$/i.test(key) && !isHexColor(v)) errs.push('bad-color');
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const [k, v] of Object.entries(p)) walk(v, k);
  if (Array.isArray(p.spots) && p.spots.length > LIMITS.spots) errs.push('too-many-spots');
  return [...new Set(errs)];
}

export const RIG_LIMITS = { images: 16, totalImageBytes: 6_000_000, packBytes: 12_000_000, segments: 3, minEnd: 0.05 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inUnit = (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 1;
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** 分层皮肤的预检（与后端 pet-core::rig + pet/skins.rs 的规则一致；后端仍会再校验）。 */
export function rigErrors(rig: unknown): string[] {
  const errs: string[] = [];
  const parts = isObj(rig) && isObj(rig.parts) ? rig.parts : null;
  if (!parts) return ['rig-missing'];
  const scale = (rig as Record<string, unknown>).scale;
  if (scale !== undefined && !(typeof scale === 'number' && scale >= 0.1 && scale <= 4)) errs.push('bad-scale');
  let count = 0;
  let total = 0;
  const image = (name: string, uri: unknown): void => {
    if (typeof uri !== 'string') return;
    count++;
    total += Math.floor((uri.length * 3) / 4);
    const e = imageError(uri);
    if (e) errs.push(`${e}:${name}`);
  };
  const part = (name: string, p: unknown, top: boolean): void => {
    if (!isObj(p)) {
      errs.push(`bad-part:${name}`);
      return;
    }
    const segs = top && Array.isArray(p.segments) ? p.segments : [];
    image(name, p.image);
    if (p.image === undefined && segs.length === 0) errs.push(`missing-image:${name}`);
    if (p.pivot !== undefined && !(isPair(p.pivot) && inUnit(p.pivot[0]) && inUnit(p.pivot[1]))) errs.push(`bad-pivot:${name}`);
    if (p.end !== undefined) {
      const pv = isPair(p.pivot) ? p.pivot : [0.5, 0.5];
      const ok = isPair(p.end) && inUnit(p.end[0]) && inUnit(p.end[1]) && Math.hypot(p.end[0] - pv[0], p.end[1] - pv[1]) >= RIG_LIMITS.minEnd;
      if (!ok) errs.push(`bad-end:${name}`);
    } else if (!top) errs.push(`missing-end:${name}`);
    if (top) {
      if (p.attach !== undefined && !(isPair(p.attach) && Math.abs(p.attach[0]) <= 2000 && Math.abs(p.attach[1]) <= 2000)) errs.push(`bad-attach:${name}`);
      if (p.z !== undefined && !(Number.isInteger(p.z) && (p.z as number) >= -100 && (p.z as number) <= 100)) errs.push(`bad-z:${name}`);
      if (segs.length > RIG_LIMITS.segments) errs.push(`too-many-segments:${name}`);
      segs.slice(0, RIG_LIMITS.segments).forEach((sg, i) => part(`${name}.seg${i}`, sg, false));
      if (name === 'head') {
        image('head.eyesClosedImage', p.eyesClosedImage);
        image('head.mouthOpenImage', p.mouthOpenImage);
      }
    }
  };
  if (!isObj(parts.torso) || parts.torso.image === undefined) errs.push('missing-torso');
  else part('torso', parts.torso, true);
  if (!isObj(parts.head) || parts.head.image === undefined) errs.push('missing-head');
  else part('head', parts.head, true);
  if (parts.tail !== undefined) part('tail', parts.tail, true);
  if (parts.limbs !== undefined) {
    if (!isObj(parts.limbs)) errs.push('bad-part:limbs');
    else for (const [k, v] of Object.entries(parts.limbs)) {
      if (['fl', 'fr', 'hl', 'hr'].includes(k)) part(`limb.${k}`, v, true);
      else errs.push(`unknown-limb:${k}`);
    }
  }
  if (count > RIG_LIMITS.images) errs.push('too-many-images');
  if (total > RIG_LIMITS.totalImageBytes) errs.push('images-total-too-large');
  return errs;
}

export function buildPack(input: MakerInput): BuildResult {
  const errors: string[] = [];
  const m = input.meta;
  if (!ID.test(m.id)) errors.push('bad-id');
  if (!m.name.trim()) errors.push('missing-name');
  if (!m.author.trim()) errors.push('missing-author');
  if (!m.license.trim()) errors.push('missing-license');
  if (!m.version.trim()) errors.push('missing-version');

  const pack: Record<string, unknown> = {
    schema: 1,
    id: m.id,
    name: m.name.trim(),
    author: m.author.trim(),
    license: m.license.trim(),
    version: m.version.trim(),
    kind: input.kind,
  };
  if (m.description?.trim()) pack.description = m.description.trim();

  if (input.kind === 'palette') {
    errors.push(...paletteErrors(input.palette));
    pack.palette = input.palette;
  } else if (input.kind === 'layered') {
    errors.push(...rigErrors(input.rig));
    pack.rig = input.rig;
  } else {
    const sprites: Record<string, string> = {};
    let total = 0;
    if (!input.sprites?.idle) errors.push('missing-idle-image');
    for (const slot of SLOTS) {
      const uri = input.sprites?.[slot];
      if (!uri) continue;
      const e = imageError(uri);
      if (e) errors.push(e);
      total += Math.floor((uri.length * 3) / 4);
      sprites[slot] = uri;
    }
    if (total > LIMITS.totalImageBytes) errors.push('pack-too-large');
    pack.sprites = sprites;
  }

  const json = JSON.stringify(pack);
  if (json.length > (input.kind === 'layered' ? RIG_LIMITS.packBytes : LIMITS.packBytes)) errors.push('pack-too-large');
  const uniq = [...new Set(errors)];
  return uniq.length ? { ok: false, errors: uniq } : { ok: true, pack, json };
}
