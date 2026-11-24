// 图片分层角色的清单文件（manifest）格式与校验。
// 首版：用户提供透明 PNG 分层 + 清单 JSON；之后再做可视化编辑器。（交接文档 §6.9）
//
// 安全约束：清单里的图层路径只能是「角色文件夹内的相对路径」，
// 拒绝绝对路径、盘符、`..`、反斜杠、非图片扩展名——避免读取任意位置的文件。
// 因此 MCP 不应接受清单/路径写入（只允许切换与缩放）。

import { type PropSlot, type Stance } from '../pose/pose.ts';

export const MANIFEST_SCHEMA_VERSION = 1;

export interface LayerDef {
  id: string;
  /** 角色文件夹内的相对路径，如 "head.png"。 */
  file: string;
  /** 旋转转轴，相对图片左上角、像素。 */
  pivot: { x: number; y: number };
  /** 绘制顺序，小的在下。 */
  z: number;
  /** 可选图层缺失时降级而不是报错。 */
  optional?: boolean;
}

/** 手臂：整段，或上下两段（两段效果更好）。 */
export interface LimbDef {
  upper: string; // LayerDef.id
  lower?: string; // 缺省=整段，只能转动加拉伸，效果较僵硬
  /** 肩在身体图上的位置。 */
  shoulder: { x: number; y: number };
  bend: 1 | -1;
}

export interface CharacterManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  stance: Stance;
  layers: LayerDef[];
  leftArm: LimbDef;
  rightArm: LimbDef;
  /** 头部/躯干等必需图层 id。 */
  head: string;
  torso: string;
  /** 可选表情图层 id。 */
  eyesClosed?: string;
  mouthOpen?: string;
  /** 道具挂点，相对躯干图。 */
  propAnchors?: Partial<Record<PropSlot, { x: number; y: number }>>;
}

export type Degradation = 'no-blink' | 'no-mouth' | 'single-segment-arm';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: CharacterManifest;
  /** 缺失可选部件时的降级说明，UI 可显示。 */
  degradations: Degradation[];
}

const ALLOWED_EXT = /\.(png|webp)$/i;

/** 路径是否是安全的、角色文件夹内的相对路径。 */
export function isSafeRelativeImagePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (p.includes('\\') || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return ALLOWED_EXT.test(p);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown): v is { x: number; y: number } =>
  typeof v === 'object' && v !== null && isNum((v as any).x) && isNum((v as any).y);

export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const degradations: Degradation[] = [];
  const fail = (): ValidationResult => ({ ok: false, errors, degradations });

  if (typeof raw !== 'object' || raw === null) {
    errors.push('manifest must be an object');
    return fail();
  }
  const m = raw as Record<string, any>;

  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(m.id)) errors.push('id must match [a-z0-9][a-z0-9_-]{0,47}');
  if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 40) errors.push('name must be 1..40 chars');
  if (m.stance !== 'quadruped' && m.stance !== 'upright') errors.push("stance must be 'quadruped' or 'upright'");

  const layerIds = new Set<string>();
  const layers: LayerDef[] = [];
  if (!Array.isArray(m.layers) || m.layers.length === 0 || m.layers.length > 64) {
    errors.push('layers must be a non-empty array (max 64)');
  } else {
    for (const [i, l] of m.layers.entries()) {
      const at = `layers[${i}]`;
      if (typeof l !== 'object' || l === null) {
        errors.push(`${at} must be an object`);
        continue;
      }
      if (typeof l.id !== 'string' || l.id.length === 0) errors.push(`${at}.id required`);
      else if (layerIds.has(l.id)) errors.push(`${at}.id duplicated: ${l.id}`);
      else layerIds.add(l.id);
      if (!isSafeRelativeImagePath(l.file)) errors.push(`${at}.file must be a safe relative .png/.webp path`);
      if (!isPt(l.pivot)) errors.push(`${at}.pivot must be {x,y}`);
      if (!isNum(l.z)) errors.push(`${at}.z must be a number`);
      layers.push(l as LayerDef);
    }
  }

  const need = (key: string, id: unknown, optional: boolean): boolean => {
    if (typeof id !== 'string' || !layerIds.has(id)) {
      if (!optional) errors.push(`${key} must reference an existing layer id`);
      return false;
    }
    return true;
  };

  need('head', m.head, false);
  need('torso', m.torso, false);

  const checkLimb = (key: 'leftArm' | 'rightArm') => {
    const a = m[key];
    if (typeof a !== 'object' || a === null) {
      errors.push(`${key} required`);
      return;
    }
    need(`${key}.upper`, a.upper, false);
    if (a.lower === undefined) {
      if (!degradations.includes('single-segment-arm')) degradations.push('single-segment-arm');
    } else {
      need(`${key}.lower`, a.lower, false);
    }
    if (!isPt(a.shoulder)) errors.push(`${key}.shoulder must be {x,y}`);
    if (a.bend !== 1 && a.bend !== -1) errors.push(`${key}.bend must be 1 or -1`);
  };
  checkLimb('leftArm');
  checkLimb('rightArm');

  if (m.eyesClosed === undefined || !need('eyesClosed', m.eyesClosed, true)) {
    if (m.eyesClosed !== undefined) errors.push('eyesClosed must reference an existing layer id');
    else degradations.push('no-blink');
  }
  if (m.mouthOpen === undefined || !need('mouthOpen', m.mouthOpen, true)) {
    if (m.mouthOpen !== undefined) errors.push('mouthOpen must reference an existing layer id');
    else degradations.push('no-mouth');
  }

  if (m.propAnchors !== undefined) {
    if (typeof m.propAnchors !== 'object' || m.propAnchors === null) errors.push('propAnchors must be an object');
    else {
      for (const [slot, pt] of Object.entries(m.propAnchors)) {
        if (slot !== 'head' && slot !== 'torso' && slot !== 'mouth') errors.push(`propAnchors.${slot}: unknown slot`);
        else if (!isPt(pt)) errors.push(`propAnchors.${slot} must be {x,y}`);
      }
    }
  }

  if (errors.length > 0) return fail();
  return { ok: true, errors, manifest: m as CharacterManifest, degradations };
}
