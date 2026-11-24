// 姿态（Pose）接口与两段式反向运动学（two-bone IK）。
//
// 设计目标（交接文档 §6.9）：动画只输出「姿态」，角色只负责把姿态画出来。
// 动画给出键盘/桌面坐标系下的手部目标，角色用 two-bone IK 去够，
// 因此动画与肢体长短无关。本文件不依赖 catEngine，可单独测试。

export interface Vec2 {
  x: number;
  y: number;
}

/** 站姿：四脚（猫、狗…）或直立（人物）。 */
export type Stance = 'quadruped' | 'upright';

/** 道具挂点。 */
export type PropSlot = 'head' | 'torso' | 'mouth';

export interface Pose {
  /** 左右「手」（四脚=前肢，直立=手臂）的目标位置，画布逻辑坐标。 */
  leftHand: Vec2;
  rightHand: Vec2;
  /** 头部倾斜，弧度，正值=顺时针。 */
  headTilt: number;
  /** 视线，各轴 -1..1（相对头部中心）。 */
  gaze: Vec2;
  /** 躯干前倾，-1..1。 */
  torsoLean: number;
  /** 耳朵抖动 0..1（无耳朵的角色忽略）。 */
  earTwitchL: number;
  earTwitchR: number;
  /** 张嘴程度 0..1。 */
  mouthOpen: number;
  /** 闭眼程度 0..1（眨眼/眯眼）。 */
  eyesClosed: number;
  /** 各挂点上的道具 id；缺省=无。 */
  props: Partial<Record<PropSlot, string>>;
}

export function neutralPose(): Pose {
  return {
    leftHand: { x: 0, y: 0 },
    rightHand: { x: 0, y: 0 },
    headTilt: 0,
    gaze: { x: 0, y: 0 },
    torsoLean: 0,
    earTwitchL: 0,
    earTwitchR: 0,
    mouthOpen: 0,
    eyesClosed: 0,
    props: {},
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

/** 姿态插值。数值字段线性插值；道具取 t<0.5 用 a，否则用 b（道具不可连续混合）。 */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const k = clamp(t, 0, 1);
  return {
    leftHand: lerpVec(a.leftHand, b.leftHand, k),
    rightHand: lerpVec(a.rightHand, b.rightHand, k),
    headTilt: lerp(a.headTilt, b.headTilt, k),
    gaze: lerpVec(a.gaze, b.gaze, k),
    torsoLean: lerp(a.torsoLean, b.torsoLean, k),
    earTwitchL: lerp(a.earTwitchL, b.earTwitchL, k),
    earTwitchR: lerp(a.earTwitchR, b.earTwitchR, k),
    mouthOpen: lerp(a.mouthOpen, b.mouthOpen, k),
    eyesClosed: lerp(a.eyesClosed, b.eyesClosed, k),
    props: { ...(k < 0.5 ? a.props : b.props) },
  };
}

/** 把姿态的各标量限制在合法范围内（动画写错也不会把角色画坏）。 */
export function clampPose(p: Pose): Pose {
  return {
    ...p,
    headTilt: clamp(p.headTilt, -1.2, 1.2),
    gaze: { x: clamp(p.gaze.x, -1, 1), y: clamp(p.gaze.y, -1, 1) },
    torsoLean: clamp(p.torsoLean, -1, 1),
    earTwitchL: clamp(p.earTwitchL, 0, 1),
    earTwitchR: clamp(p.earTwitchR, 0, 1),
    mouthOpen: clamp(p.mouthOpen, 0, 1),
    eyesClosed: clamp(p.eyesClosed, 0, 1),
  };
}

export interface IKResult {
  /** 肘（或前肢中段）位置。 */
  elbow: Vec2;
  /** 末端（腕/爪）实际位置；够不到时落在可达范围的边界上。 */
  end: Vec2;
  /** 目标是否超出可达范围（已被夹到边界）。 */
  clamped: boolean;
}

/**
 * 两段式 IK。
 * @param shoulder 肩（根部）位置
 * @param target 目标位置
 * @param upper 上段长度（>0）
 * @param lower 下段长度（>0）
 * @param bend 弯折方向：+1 / -1，决定肘在肩—目标连线的哪一侧
 *
 * 目标太近（小于 |upper-lower|）或太远（大于 upper+lower）时夹到可达环带内，
 * 不会产生 NaN。
 */
export function twoBoneIK(shoulder: Vec2, target: Vec2, upper: number, lower: number, bend: 1 | -1): IKResult {
  if (!(upper > 0) || !(lower > 0)) {
    throw new RangeError('twoBoneIK: segment lengths must be positive');
  }
  const dx = target.x - shoulder.x;
  const dy = target.y - shoulder.y;
  let dist = Math.hypot(dx, dy);
  const minReach = Math.abs(upper - lower) + 1e-6;
  const maxReach = upper + lower - 1e-6;

  // 目标与肩重合：方向未定义，取向下（画布 y 向下）。
  const ux = dist > 1e-9 ? dx / dist : 0;
  const uy = dist > 1e-9 ? dy / dist : 1;

  let clamped = false;
  if (dist > maxReach) {
    dist = maxReach;
    clamped = true;
  } else if (dist < minReach) {
    dist = minReach;
    clamped = true;
  }

  // 余弦定理：肩到肘在连线上的投影 a 与垂直偏移 h。
  const a = (upper * upper - lower * lower + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, upper * upper - a * a));

  const px = shoulder.x + ux * a;
  const py = shoulder.y + uy * a;
  // 垂直方向（连线逆时针旋转 90°）乘 bend。
  const elbow: Vec2 = { x: px + -uy * h * bend, y: py + ux * h * bend };
  const end: Vec2 = { x: shoulder.x + ux * dist, y: shoulder.y + uy * dist };
  return { elbow, end, clamped };
}
