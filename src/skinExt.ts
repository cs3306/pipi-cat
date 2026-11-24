// 皮肤配置的新字段（交接文档 §6.8）：围裙色、口腔色、舌头色、schemaVersion。
// 原则：旧皮肤不改也能正常显示新动画（缺省值由毛色推导）；
// 未知字段不静默吞掉，返回给调用方（MCP upsert_cat 用它提示）。
// 只适用于程序绘制的模板角色；大肥鱼（图片帧）不走这套。

export interface SkinExt {
  /** 缺省按旧格式 1；含新字段的皮肤写 2。 */
  schemaVersion?: 1 | 2;
  apronColor?: string;
  mouthInnerColor?: string;
  tongueColor?: string;
}

export interface ResolvedSkinExt {
  schemaVersion: 1 | 2;
  apronColor: string;
  mouthInnerColor: string;
  tongueColor: string;
}

export const DEFAULT_MOUTH_INNER = '#c2566b';
export const DEFAULT_TONGUE = '#ff8fa3';

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

function luminance(hex: string): number {
  const c = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(0) + 0.7152 * c(1) + 0.0722 * c(2);
}

/** 由毛色推导对比色围裙：深毛配浅围裙，浅毛配深围裙。 */
export function deriveApronColor(furColor: string): string {
  if (!isHexColor(furColor)) return '#f4f1ea';
  return luminance(furColor) < 0.4 ? '#f4f1ea' : '#6a7fa5';
}

const KNOWN: ReadonlySet<string> = new Set(['schemaVersion', 'apronColor', 'mouthInnerColor', 'tongueColor']);

/**
 * 从任意输入里取出新字段。
 * - 非法颜色（不是 #rrggbb）→ 丢弃并写入 rejected；
 * - 不属于本扩展的字段不在此处理（由上层皮肤校验决定），故不放进 ignored。
 */
export function sanitizeSkinExt(input: unknown): { value: SkinExt; rejected: string[] } {
  const value: SkinExt = {};
  const rejected: string[] = [];
  if (typeof input !== 'object' || input === null) return { value, rejected };
  const r = input as Record<string, unknown>;

  if (r.schemaVersion !== undefined) {
    if (r.schemaVersion === 1 || r.schemaVersion === 2) value.schemaVersion = r.schemaVersion;
    else rejected.push('schemaVersion');
  }
  for (const key of ['apronColor', 'mouthInnerColor', 'tongueColor'] as const) {
    if (r[key] === undefined) continue;
    if (isHexColor(r[key])) value[key] = (r[key] as string).toLowerCase();
    else rejected.push(key);
  }
  return { value, rejected };
}

/** 列出输入里不被本扩展识别的字段名（供上层与皮肤自身字段对账）。 */
export function unknownExtKeys(input: unknown, otherKnown: ReadonlySet<string>): string[] {
  if (typeof input !== 'object' || input === null) return [];
  return Object.keys(input as object).filter((k) => !KNOWN.has(k) && !otherKnown.has(k));
}

export function resolveSkinExt(furColor: string, ext: SkinExt | undefined): ResolvedSkinExt {
  const e = ext ?? {};
  return {
    schemaVersion: e.schemaVersion ?? 1,
    apronColor: e.apronColor ?? deriveApronColor(furColor),
    mouthInnerColor: e.mouthInnerColor ?? DEFAULT_MOUTH_INNER,
    tongueColor: e.tongueColor ?? DEFAULT_TONGUE,
  };
}
