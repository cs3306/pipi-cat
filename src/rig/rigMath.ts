// 分层皮肤渲染用到的纯数学（可用 node 测试）。

import { twoBoneIK } from '../pose/pose.ts';

/** 两段肢体：给定段长、静止方向角、目标（相对肩）和弯折方向，返回两段各自需要旋转的角度。 */
export function solveTwoSegments(
  len0: number,
  len1: number,
  rest0: number,
  rest1: number,
  target: { x: number; y: number },
  bend: 1 | -1,
): { rot0: number; rot1: number; elbow: { x: number; y: number }; end: { x: number; y: number } } {
  const ik = twoBoneIK({ x: 0, y: 0 }, target, Math.max(1, len0), Math.max(1, len1), bend);
  const dir0 = Math.atan2(ik.elbow.y, ik.elbow.x);
  const dir1 = Math.atan2(ik.end.y - ik.elbow.y, ik.end.x - ik.elbow.x);
  return { rot0: dir0 - rest0, rot1: dir1 - rest1, elbow: ik.elbow, end: ik.end };
}

/** 单片肢体：旋转到指向目标，并沿长度方向拉伸（限制 0.8..1.25）。 */
export function solveSingleLimb(restAngle: number, restLen: number, target: { x: number; y: number }): { rot: number; stretch: number } {
  const dist = Math.hypot(target.x, target.y);
  if (dist < 1e-6 || restLen < 1e-6) return { rot: 0, stretch: 1 };
  return { rot: Math.atan2(target.y, target.x) - restAngle, stretch: Math.min(1.25, Math.max(0.8, dist / restLen)) };
}

/** 尾巴 n 段的相对旋转角（每段相对上一段）。 */
export function tailRelAngles(n: number, tail: { angle: number; curl: number; sway: number }, calm: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(tail.angle / n + tail.curl * 0.35 + Math.sin(tail.sway - i * 0.9) * 0.12 * calm);
  }
  return out;
}

