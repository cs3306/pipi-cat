// 动画注册表：通用动画只写一份，个别动画提供「站姿覆盖版」，缺省回退通用版。
// （交接文档 §6.9）

import { type Pose, type Stance } from './pose.ts';

export interface AnimContext {
  /** 当前动画内已过去的秒数。 */
  t: number;
  /** 键盘/桌面坐标系下常用锚点，由引擎在调用前填好。 */
  anchors: Record<string, { x: number; y: number }>;
  stance: Stance;
}

export interface PoseAnimation {
  id: string;
  /** 动画总时长（秒）；null=循环/由外部结束。 */
  duration: number | null;
  sample(ctx: AnimContext): Pose;
}

export interface AnimationEntry {
  generic: PoseAnimation;
  /** 只有少数动画需要按站姿覆盖。 */
  overrides?: Partial<Record<Stance, PoseAnimation>>;
}

export class AnimationRegistry {
  private entries = new Map<string, AnimationEntry>();

  register(entry: AnimationEntry): void {
    if (this.entries.has(entry.generic.id)) {
      throw new Error(`animation already registered: ${entry.generic.id}`);
    }
    this.entries.set(entry.generic.id, entry);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 取指定站姿的动画；没有覆盖版就回退通用版；id 不存在返回 null。 */
  resolve(id: string, stance: Stance): PoseAnimation | null {
    const e = this.entries.get(id);
    if (!e) return null;
    return e.overrides?.[stance] ?? e.generic;
  }
}
