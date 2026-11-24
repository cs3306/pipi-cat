// 分层皮肤用的姿态：动画/引擎状态只产出这个，渲染器只消费这个。
// 与 src/pose/pose.ts（早期脚手架，面向手部目标）互不依赖；这里的字段与 RIG-SPEC 的姿态表一一对应。
// 纯逻辑，可用 node 测试。

export interface Vec2 {
  x: number;
  y: number;
}

export type LimbId = 'fl' | 'fr' | 'hl' | 'hr';

export interface LimbPose {
  /** 要够到的点（画布逻辑坐标）；null = 回到静止位置 */
  target: Vec2 | null;
  planted: boolean;
}

export interface RigPose {
  torsoDx: number;
  torsoDy: number;
  /** 前倾 -1..1 */
  lean: number;
  /** 压缩 0.9..1.1 */
  squash: number;
  /** 头部倾斜（弧度，±1.2） */
  headTilt: number;
  /** 点头 -1..1 */
  nod: number;
  gazeX: number;
  gazeY: number;
  eyesClosed: number;
  mouthOpen: number;
  /** 耳朵抖动（1.0 里没有耳朵图层，仅保留通道） */
  earL: number;
  earR: number;
  limbs: Record<LimbId, LimbPose>;
  /** angle：整体偏转（弧度）；curl：卷曲 -1..1；sway：摆动相位（弧度） */
  tail: { angle: number; curl: number; sway: number };
}

export function neutralRigPose(): RigPose {
  const rest: LimbPose = { target: null, planted: false };
  return {
    torsoDx: 0,
    torsoDy: 0,
    lean: 0,
    squash: 1,
    headTilt: 0,
    nod: 0,
    gazeX: 0,
    gazeY: 0,
    eyesClosed: 0,
    mouthOpen: 0,
    earL: 0,
    earR: 0,
    limbs: { fl: { ...rest }, fr: { ...rest }, hl: { ...rest }, hr: { ...rest } },
    tail: { angle: 0, curl: 0, sway: 0 },
  };
}

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);

/** 把所有字段夹到合法范围；NaN 变成范围中点（坏动画不会把角色画坏）。 */
export function clampRigPose(p: RigPose): RigPose {
  const limb = (l: LimbPose): LimbPose => ({
    target: l.target && Number.isFinite(l.target.x) && Number.isFinite(l.target.y) ? { x: l.target.x, y: l.target.y } : null,
    planted: !!l.planted,
  });
  return {
    torsoDx: clamp(p.torsoDx, -200, 200),
    torsoDy: clamp(p.torsoDy, -200, 200),
    lean: clamp(p.lean, -1, 1),
    squash: clamp(p.squash, 0.9, 1.1),
    headTilt: clamp(p.headTilt, -1.2, 1.2),
    nod: clamp(p.nod, -1, 1),
    gazeX: clamp(p.gazeX, -1, 1),
    gazeY: clamp(p.gazeY, -1, 1),
    eyesClosed: clamp(p.eyesClosed, 0, 1),
    mouthOpen: clamp(p.mouthOpen, 0, 1),
    earL: clamp(p.earL, 0, 1),
    earR: clamp(p.earR, 0, 1),
    limbs: { fl: limb(p.limbs.fl), fr: limb(p.limbs.fr), hl: limb(p.limbs.hl), hr: limb(p.limbs.hr) },
    tail: { angle: clamp(p.tail.angle, -1.5, 1.5), curl: clamp(p.tail.curl, -1, 1), sway: Number.isFinite(p.tail.sway) ? p.tail.sway : 0 },
  };
}

/** 引擎每帧交给适配器的只读快照（引擎自己组装，见 catEngine.getRigInput）。 */
export interface RigInput {
  /** performance.now()，毫秒 */
  now: number;
  breath: number;
  typingEnergy: number;
  sleep: number;
  squint: number;
  happy: boolean;
  shy: boolean;
  headTilt: number;
  earL: number;
  earR: number;
  left: { active: boolean; x: number; y: number };
  right: { active: boolean; x: number; y: number };
  tail: { reach: number; tipX: number };
  anchorX: number;
}

/** 姿态适配器：引擎状态 → 姿态。后肢目前没有对应的引擎状态，保持静止。 */
export function poseFromInput(i: RigInput): RigPose {
  const p = neutralRigPose();
  const typing = Math.min(1, Math.max(0, i.typingEnergy));
  p.torsoDy = i.breath * 0.8;
  p.squash = 1 + i.breath * 0.006 - Math.min(1, i.sleep) * 0.03;
  p.lean = typing * 0.25;
  p.headTilt = i.headTilt + (i.shy ? 0.15 : 0);
  p.nod = typing > 0.3 ? Math.sin(i.now / 90) * 0.3 * typing : 0;
  p.eyesClosed = Math.max(i.sleep > 0.35 ? 1 : 0, i.squint, i.happy ? 0.8 : 0, i.shy ? 0.6 : 0);
  p.earL = i.earL;
  p.earR = i.earR;
  if (i.left.active) p.limbs.fl = { target: { x: i.left.x, y: i.left.y }, planted: true };
  if (i.right.active) p.limbs.fr = { target: { x: i.right.x, y: i.right.y }, planted: true };
  if (i.tail.reach > 0.1) {
    p.tail.angle = Math.max(-1, Math.min(1, (i.tail.tipX - i.anchorX) / 220)) * 0.7;
    p.tail.curl = Math.min(1, i.tail.reach) * 0.5;
  }
  p.tail.sway = (i.now / 1000) * 1.6;
  return clampRigPose(p);
}
