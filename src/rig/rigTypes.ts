// 分层皮肤（kind: "layered"）的数据结构与宽松解析。格式见 docs/skins/RIG-SPEC.md。
// 解析只做「整理」：越界的数值夹回范围，坏掉的可选部位丢弃（降级），不会因为一个可选字段出错而整体失败。
// 真正的安全校验在后端（pet-core::rig + pet/skins.rs），这里是第二道防线与渲染前的规整。

export const LIMB_IDS = ['fl', 'fr', 'hl', 'hr'] as const;
export type LimbId = (typeof LIMB_IDS)[number];
export type Pair = [number, number];

export interface SegDef {
  image: string;
  pivot: Pair;
  end: Pair;
}

export interface PartDef {
  /** 有 segments 时可省略 */
  image?: string;
  pivot: Pair;
  /** 肢体/尾巴：支点指向「远端」的点（归一化）。躯干/头不需要。 */
  end?: Pair;
  /** 支点放在锚点坐标系中的位置（像素，未乘 scale） */
  attach: Pair;
  z: number;
  segments?: SegDef[];
  /** 仅头部：整张替换用的图（与 image 同尺寸同支点） */
  eyesClosedImage?: string;
  mouthOpenImage?: string;
}

export interface RigDef {
  scale: number;
  torso: PartDef;
  head: PartDef;
  limbs: Partial<Record<LimbId, PartDef>>;
  tail?: PartDef;
}

export const MAX_SEGMENTS = 3;
export const MIN_END_DIST = 0.05;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isUri = (v: unknown): v is string => typeof v === 'string' && /^data:image\/(png|webp);base64,/.test(v);

function pair(v: unknown, fallback: Pair, lo: number, hi: number): Pair {
  if (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])) return [clamp(v[0], lo, hi), clamp(v[1], lo, hi)];
  return fallback;
}

export const DEFAULT_END = { limb: [0.5, 0.95] as Pair, tail: [0.95, 0.5] as Pair, seg: [0.5, 0.95] as Pair };

/** end 太靠近 pivot 时方向没有意义，用默认值替代。 */
function fixEnd(pivot: Pair, end: Pair, fallback: Pair): Pair {
  return Math.hypot(end[0] - pivot[0], end[1] - pivot[1]) < MIN_END_DIST ? fallback : end;
}

function parseSeg(raw: unknown): SegDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isUri(o.image)) return null;
  const pivot = pair(o.pivot, [0.5, 0.1], 0, 1);
  return { image: o.image, pivot, end: fixEnd(pivot, pair(o.end, DEFAULT_END.seg, 0, 1), DEFAULT_END.seg) };
}

function parsePart(raw: unknown, kind: 'body' | 'limb' | 'tail'): PartDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const segs = Array.isArray(o.segments) && kind !== 'body'
    ? o.segments.slice(0, MAX_SEGMENTS).map(parseSeg).filter((s): s is SegDef => s !== null)
    : [];
  const image = isUri(o.image) ? o.image : undefined;
  // 没有任何可画的东西就丢弃
  if (!image && segs.length === 0) return null;
  const pivot = pair(o.pivot, kind === 'tail' ? [0.05, 0.5] : kind === 'limb' ? [0.5, 0.1] : [0.5, 1], 0, 1);
  const part: PartDef = {
    image,
    pivot,
    attach: pair(o.attach, [0, 0], -2000, 2000),
    z: isNum(o.z) ? Math.round(clamp(o.z, -100, 100)) : 0,
  };
  if (kind !== 'body') {
    const fb = kind === 'tail' ? DEFAULT_END.tail : DEFAULT_END.limb;
    part.end = fixEnd(pivot, pair(o.end, fb, 0, 1), fb);
  }
  if (segs.length) part.segments = segs;
  if (isUri(o.eyesClosedImage)) part.eyesClosedImage = o.eyesClosedImage;
  if (isUri(o.mouthOpenImage)) part.mouthOpenImage = o.mouthOpenImage;
  return part;
}

/** 宽松解析 pack.rig；缺少可画的躯干或头部时返回 null。 */
export function parseRig(raw: unknown): RigDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const parts = r.parts as Record<string, unknown> | undefined;
  if (!parts || typeof parts !== 'object') return null;
  const torso = parsePart(parts.torso, 'body');
  const head = parsePart(parts.head, 'body');
  if (!torso || !torso.image || !head || !head.image) return null;
  const limbs: RigDef['limbs'] = {};
  const lraw = (parts.limbs ?? {}) as Record<string, unknown>;
  for (const id of LIMB_IDS) {
    const p = parsePart(lraw[id], 'limb');
    if (p) limbs[id] = p;
  }
  const tail = parsePart(parts.tail, 'tail') ?? undefined;
  return { scale: isNum(r.scale) ? clamp(r.scale, 0.1, 4) : 1, torso, head, limbs, tail };
}

/** 图片键名，前后端、制作器、渲染器共用。 */
export const imgKey = {
  torso: 'torso',
  head: 'head',
  headEyes: 'head.eyesClosed',
  headMouth: 'head.mouthOpen',
  limb: (id: LimbId) => `limb.${id}`,
  tail: 'tail',
  seg: (base: string, i: number) => `${base}.seg${i}`,
};

/** 列出一个 RigDef 用到的所有图片：[键, data URI]。 */
export function imageRefs(def: RigDef): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (key: string, p: PartDef): void => {
    if (p.image) out.push([key, p.image]);
    p.segments?.forEach((s, i) => out.push([imgKey.seg(key, i), s.image]));
  };
  add(imgKey.torso, def.torso);
  add(imgKey.head, def.head);
  if (def.head.eyesClosedImage) out.push([imgKey.headEyes, def.head.eyesClosedImage]);
  if (def.head.mouthOpenImage) out.push([imgKey.headMouth, def.head.mouthOpenImage]);
  for (const id of LIMB_IDS) if (def.limbs[id]) add(imgKey.limb(id), def.limbs[id]!);
  if (def.tail) add(imgKey.tail, def.tail);
  return out;
}
