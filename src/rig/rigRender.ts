// 分层皮肤渲染器：只消费姿态（RigPose），不读引擎内部。
// 视觉效果（位置、层叠、肢体够取、尾巴摆动）未经真机验证——构建环境看不到画面。
//
// 坐标约定：原点 = 皮肤的地面锚点（底边中点）；各部位的 attach 是「支点所在位置」，单位像素（乘 scale）。
// 肢体/尾巴图片：从 pivot 指向 end 的方向是「静止方向」；单片肢体旋转+拉伸去够目标，
// 带 segments 的肢体用两段 IK，尾巴按段链式弯曲。缺什么就降级，不报错。

import { clampRigPose, poseFromInput, type RigInput, type RigPose } from './rigPose';
import { solveSingleLimb, solveTwoSegments, tailRelAngles } from './rigMath';
import { imgKey, LIMB_IDS, type LimbId, type PartDef, type RigDef, type SegDef } from './rigTypes';

export interface SkinAdjust {
  scale: number;
  dy: number;
}

// ───────── 渲染 ─────────

interface Drawable {
  z: number;
  order: number;
  fn: () => void;
}

export class LayeredSkin {
  private nextBlinkAt = 0;
  private blinkUntil = 0;

  constructor(
    readonly def: RigDef,
    private readonly imgs: Map<string, HTMLImageElement>,
  ) {}

  private img(key: string): HTMLImageElement | null {
    const i = this.imgs.get(key);
    return i && i.naturalWidth > 0 && i.naturalHeight > 0 ? i : null;
  }

  private blink(now: number, closed: number): number {
    if (closed > 0.5) return closed;
    if (this.nextBlinkAt === 0) this.nextBlinkAt = now + 2500 + Math.random() * 3500;
    if (now >= this.nextBlinkAt) {
      this.blinkUntil = now + 140;
      this.nextBlinkAt = now + 2500 + Math.random() * 3500;
    }
    return now < this.blinkUntil ? 1 : closed;
  }

  /** 以 (anchorX, anchorY) 为地面锚点绘制。input 来自引擎；pose 由适配器给出。 */
  draw(
    ctx: CanvasRenderingContext2D,
    anchorX: number,
    anchorY: number,
    input: RigInput,
    adj: SkinAdjust,
    /** 'back'：躯干/头/尾；'front'：四肢（引擎在键盘之后调用，爪子才会按在键盘上）；默认 all */
    phase: 'all' | 'back' | 'front' = 'all',
  ): void {
    const pose: RigPose = clampRigPose(poseFromInput(input));
    pose.eyesClosed = this.blink(input.now, pose.eyesClosed);
    const s = this.def.scale * adj.scale;
    const base = ctx.getTransform();
    const items: Drawable[] = [];
    let order = 0;
    const add = (z: number, fn: () => void, front = false): void => {
      if (phase === 'back' && front) return;
      if (phase === 'front' && !front) return;
      items.push({ z, order: order++, fn });
    };

    const torsoAttach = this.def.torso.attach;
    const frame = (fn: () => void): void => {
      ctx.save();
      ctx.translate(anchorX + pose.torsoDx, anchorY + adj.dy + pose.torsoDy);
      // 躯干的前倾与压缩以躯干支点为中心，其他部位跟着动
      ctx.translate(torsoAttach[0] * s, torsoAttach[1] * s);
      ctx.rotate(pose.lean * 0.08);
      ctx.scale(1, pose.squash);
      ctx.translate(-torsoAttach[0] * s, -torsoAttach[1] * s);
      fn();
      ctx.restore();
    };

    const drawImg = (key: string, pivot: [number, number], scaleX = 1): void => {
      const im = this.img(key);
      if (!im) return;
      const w = im.naturalWidth * s;
      const h = im.naturalHeight * s;
      ctx.drawImage(im, -pivot[0] * w * scaleX, -pivot[1] * h, w * scaleX, h);
    };

    // 躯干
    add(this.def.torso.z, () =>
      frame(() => {
        ctx.translate(torsoAttach[0] * s, torsoAttach[1] * s);
        drawImg(imgKey.torso, this.def.torso.pivot);
      }),
    );

    // 头
    const head = this.def.head;
    add(head.z, () =>
      frame(() => {
        ctx.translate(head.attach[0] * s + pose.gazeX * 2 * s, head.attach[1] * s + pose.nod * 3 * s);
        ctx.rotate(pose.headTilt);
        let key: string = imgKey.head;
        if (pose.eyesClosed > 0.6 && head.eyesClosedImage && this.img(imgKey.headEyes)) key = imgKey.headEyes;
        else if (pose.mouthOpen > 0.5 && head.mouthOpenImage && this.img(imgKey.headMouth)) key = imgKey.headMouth;
        else if (pose.eyesClosed > 0.6 && !head.eyesClosedImage) {
          // 没有闭眼图：头部以支点为中心纵向微压缩，当作眨眼
          ctx.scale(1, 1 - 0.03 * pose.eyesClosed);
        }
        drawImg(key, head.pivot);
      }),
    );

    // 四肢
    for (const id of LIMB_IDS) {
      const part = this.def.limbs[id];
      if (!part) continue;
      add(part.z, () => frame(() => this.drawLimb(ctx, base, id, part, pose, s)), true);
    }

    // 尾巴
    const tail = this.def.tail;
    if (tail) add(tail.z, () => frame(() => this.drawTail(ctx, tail, pose, s)));

    items.sort((a, b) => a.z - b.z || a.order - b.order);
    for (const it of items) it.fn();
  }

  private drawLimb(ctx: CanvasRenderingContext2D, base: DOMMatrix, id: LimbId, part: PartDef, pose: RigPose, s: number): void {
    ctx.translate(part.attach[0] * s, part.attach[1] * s);
    const lp = pose.limbs[id];
    let local: { x: number; y: number } | null = null;
    if (lp.target) {
      const p = ctx.getTransform().inverse().multiply(base).transformPoint({ x: lp.target.x, y: lp.target.y });
      local = { x: p.x, y: p.y };
    }
    const bend: 1 | -1 = id === 'fl' || id === 'hl' ? -1 : 1;
    const segs = part.segments;

    const segVec = (seg: { pivot: [number, number]; end: [number, number] }, w: number, h: number): { len: number; ang: number } => {
      const dx = (seg.end[0] - seg.pivot[0]) * w * s;
      const dy = (seg.end[1] - seg.pivot[1]) * h * s;
      return { len: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) };
    };
    const drawSeg = (key: string, seg: { pivot: [number, number] }): void => {
      const im = this.img(key);
      if (!im) return;
      const w = im.naturalWidth * s;
      const h = im.naturalHeight * s;
      ctx.drawImage(im, -seg.pivot[0] * w, -seg.pivot[1] * h, w, h);
    };

    if (segs && segs.length >= 2) {
      const i0 = this.img(imgKey.seg(imgKey.limb(id), 0));
      const i1 = this.img(imgKey.seg(imgKey.limb(id), 1));
      if (!i0 || !i1) return;
      const v0 = segVec(segs[0], i0.naturalWidth, i0.naturalHeight);
      const v1 = segVec(segs[1], i1.naturalWidth, i1.naturalHeight);
      let rot0 = 0;
      let rot1 = 0;
      if (local) {
        const r = solveTwoSegments(v0.len, v1.len, v0.ang, v1.ang, local, bend);
        rot0 = r.rot0;
        rot1 = r.rot1;
      }
      ctx.save();
      ctx.rotate(rot0);
      drawSeg(imgKey.seg(imgKey.limb(id), 0), segs[0]);
      // 第二段的支点在第一段的 end 处（按第一段静止方向的向量）
      ctx.translate(Math.cos(v0.ang) * v0.len, Math.sin(v0.ang) * v0.len);
      // rot1 是相对局部坐标系的总旋转；当前坐标系已转过 rot0，所以补差值
      ctx.rotate(rot1 - rot0);
      drawSeg(imgKey.seg(imgKey.limb(id), 1), segs[1]);
      ctx.restore();
      return;
    }

    const im = this.img(imgKey.limb(id));
    if (!im || !part.end) return;
    const v = segVec({ pivot: part.pivot, end: part.end }, im.naturalWidth, im.naturalHeight);
    ctx.save();
    if (local) {
      const r = solveSingleLimb(v.ang, v.len, local);
      ctx.rotate(r.rot);
      ctx.rotate(v.ang);
      ctx.scale(r.stretch, 1);
      ctx.rotate(-v.ang);
    }
    drawSeg(imgKey.limb(id), part);
    ctx.restore();
  }

  private drawTail(ctx: CanvasRenderingContext2D, tail: PartDef, pose: RigPose, s: number): void {
    ctx.translate(tail.attach[0] * s, tail.attach[1] * s);
    const calm = Math.max(0, 1 - Math.abs(pose.tail.angle));
    const segs = tail.segments;
    const draw = (key: string, pivot: [number, number]): void => {
      const im = this.img(key);
      if (!im) return;
      const w = im.naturalWidth * s;
      const h = im.naturalHeight * s;
      ctx.drawImage(im, -pivot[0] * w, -pivot[1] * h, w, h);
    };
    if (segs && segs.length >= 1) {
      const rel = tailRelAngles(segs.length, pose.tail, calm);
      ctx.save();
      segs.forEach((seg: SegDef, i) => {
        const im = this.img(imgKey.seg(imgKey.tail, i));
        if (!im) return;
        ctx.rotate(rel[i]);
        draw(imgKey.seg(imgKey.tail, i), seg.pivot);
        // 下一段接在这一段的 end 处
        ctx.translate((seg.end[0] - seg.pivot[0]) * im.naturalWidth * s, (seg.end[1] - seg.pivot[1]) * im.naturalHeight * s);
      });
      ctx.restore();
      return;
    }
    const [rel] = tailRelAngles(1, pose.tail, calm);
    ctx.save();
    ctx.rotate(rel);
    draw(imgKey.tail, tail.pivot);
    ctx.restore();
  }
}
