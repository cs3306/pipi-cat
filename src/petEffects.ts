// 宠物玩法效果层：气泡、零食道具、猫咖围裙与小动作、专注倒计时。
// 通过 KuroCatEngine.overlayDraw 在猫之后绘制（逻辑坐标）；所有道具颜色可由皮肤推导。
// 设计取舍：尽量复用引擎已有的反应（耳朵抽动、歪头、眯眼），自己只画简单图形，
// 因此对每个皮肤都能工作，不需要逐个皮肤适配。大肥鱼（图片帧）只显示气泡与倒计时。
//
// 视觉尚未在真机上看过（开发环境没有桌面）；尺寸/位置常量集中在本文件顶部，便于调整。

import type { EngineAnchors, KuroCatEngine } from './catEngine';
import { deriveApronColor } from './skinExt';
import type { FocusPhase } from './petBridge';

const BUBBLE_Y = 34;
const SNACK_MS = 2400;
const MAX_BUBBLE_CHARS = 30;

type SnackKind = 'churu' | 'canned';

interface Bubble {
  text: string;
  born: number;
  until: number;
}

const easeOut = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class PetEffects {
  private bubble: Bubble | null = null;
  private snack: { kind: SnackKind; start: number } | null = null;
  private cafe: { since: number } | null = null;
  private apron = '#f4f1ea';
  private focusPhase: FocusPhase = 'idle';
  private focusRemaining = 0;

  constructor(private readonly engine: KuroCatEngine) {
    engine.overlayDraw = (ctx, a) => this.draw(ctx, a);
  }

  /** 当前皮肤变化时调用，围裙颜色由毛色推导（对比色）。 */
  setFurColor(fur: string): void {
    this.apron = deriveApronColor(fur);
  }

  showBubble(text: string, ms = 2600): void {
    const clipped = text.length > MAX_BUBBLE_CHARS ? `${text.slice(0, MAX_BUBBLE_CHARS - 1)}…` : text;
    const now = performance.now();
    this.bubble = { text: clipped, born: now, until: now + ms };
    this.engine.wake();
  }

  playSnack(kind: SnackKind): void {
    this.snack = { kind, start: performance.now() };
    this.engine.petReact('happy', SNACK_MS);
    this.engine.wake();
  }

  setCafe(on: boolean): void {
    this.cafe = on ? { since: performance.now() } : null;
    this.engine.wake();
  }

  setFocus(phase: FocusPhase, remainingSecs: number): void {
    this.focusPhase = phase;
    this.focusRemaining = remainingSecs;
  }

  /** 返回 true = 仍在播放动画（引擎保持高帧率）。 */
  private draw(ctx: CanvasRenderingContext2D, a: EngineAnchors): boolean {
    const now = performance.now();
    let animating = false;

    if (!a.isDaFeiYu) {
      if (this.cafe) {
        this.drawCafe(ctx, a, now);
        animating = true;
      }
      if (this.snack) {
        if (now - this.snack.start > SNACK_MS) this.snack = null;
        else {
          this.drawSnack(ctx, a, now);
          animating = true;
        }
      }
    }

    if (this.bubble) {
      if (now > this.bubble.until) this.bubble = null;
      else {
        this.drawBubble(ctx, a, now);
        animating = true;
      }
    }
    this.drawFocusPill(ctx, a);
    return animating;
  }

  private drawBubble(ctx: CanvasRenderingContext2D, a: EngineAnchors, now: number): void {
    const b = this.bubble!;
    const age = now - b.born;
    const left = b.until - now;
    const pop = easeOut(age / 180);
    const fade = Math.min(1, left / 260);

    ctx.save();
    ctx.font = '600 13px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    const tw = ctx.measureText(b.text).width;
    const w = Math.min(a.logicalW - 16, tw + 22);
    const h = 28;
    const cx = Math.min(a.logicalW - w / 2 - 8, Math.max(w / 2 + 8, a.head.x));
    const y = BUBBLE_Y - (1 - pop) * 6;

    ctx.globalAlpha = Math.max(0, fade) * pop;
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(38,40,46,0.45)';
    ctx.lineWidth = 1;
    rrect(ctx, cx - w / 2, y, w, h, 9);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    // 小尾巴指向头部
    const tx = Math.min(cx + w / 2 - 14, Math.max(cx - w / 2 + 14, a.head.x));
    ctx.beginPath();
    ctx.moveTo(tx - 6, y + h - 0.5);
    ctx.lineTo(tx, y + h + 8);
    ctx.lineTo(tx + 6, y + h - 0.5);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = '#23262c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.text, cx, y + h / 2 + 0.5);
    ctx.restore();
  }

  private drawFocusPill(ctx: CanvasRenderingContext2D, a: EngineAnchors): void {
    if (this.focusPhase === 'idle') return;
    const m = Math.floor(this.focusRemaining / 60);
    const s = this.focusRemaining % 60;
    const text = `${this.focusPhase === 'focus' ? '🍅' : '☕'} ${m}:${String(s).padStart(2, '0')}`;
    ctx.save();
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 14;
    const x = a.logicalW - w - 8;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(24,26,32,0.78)';
    rrect(ctx, x, 8, w, 20, 10);
    ctx.fill();
    ctx.fillStyle = '#f2f3f5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, 18.5);
    ctx.restore();
  }

  private drawSnack(ctx: CanvasRenderingContext2D, a: EngineAnchors, now: number): void {
    const s = this.snack!;
    const t = (now - s.start) / SNACK_MS;
    const fadeOut = t > 0.85 ? (1 - t) / 0.15 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, fadeOut);

    if (s.kind === 'churu') {
      // 猫条：从右下滑到嘴边，舔的时候轻微来回
      const slide = easeOut(t / 0.25);
      const lick = t > 0.25 ? Math.sin((t - 0.25) * 34) * 2.2 : 0;
      const x = a.mouth.x + 70 - slide * 52 + lick;
      const y = a.mouth.y + 44 - slide * 40;
      ctx.translate(x, y);
      ctx.rotate(-0.55);
      ctx.fillStyle = '#ff9fb4';
      rrect(ctx, -2, -5, 40, 10, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      rrect(ctx, 10, -5, 8, 10, 1.5);
      ctx.fill();
      ctx.fillStyle = '#ffcf5a';
      ctx.beginPath();
      ctx.moveTo(-2, -4);
      ctx.lineTo(-9, -2);
      ctx.lineTo(-9, 2);
      ctx.lineTo(-2, 4);
      ctx.closePath();
      ctx.fill();
    } else {
      // 罐头：落到嘴下方，盖子翘起，吃完飘心
      const drop = easeOut(t / 0.2);
      const x = a.mouth.x;
      const y = a.mouth.y + 34 - (1 - drop) * 30 + (t > 0.2 ? Math.sin((t - 0.2) * 28) * 1.6 : 0);
      ctx.translate(x, y);
      ctx.fillStyle = '#c9ced6';
      rrect(ctx, -17, -2, 34, 24, 4);
      ctx.fill();
      ctx.fillStyle = '#ff9fb4';
      ctx.fillRect(-17, 5, 34, 10);
      ctx.fillStyle = '#e4e8ee';
      ctx.save();
      ctx.translate(15, -2);
      ctx.rotate(-0.9 * Math.min(1, t / 0.25));
      rrect(ctx, -30, -4, 32, 5, 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // 满足的小心心
    if (t > 0.35) {
      ctx.save();
      for (let i = 0; i < 3; i++) {
        const p = (t - 0.35 - i * 0.09) / 0.45;
        if (p < 0 || p > 1) continue;
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = '#ff6f91';
        ctx.font = '700 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('♥', a.head.x + (i - 1) * 24, a.head.y - 52 - p * 26);
      }
      ctx.restore();
    }
  }

  /** 轻量猫咖：围裙 + 擦杯子 / 端盘子 两个小动作循环。 */
  private drawCafe(ctx: CanvasRenderingContext2D, a: EngineAnchors, now: number): void {
    const c = this.cafe!;
    const sec = (now - c.since) / 1000;
    const fadeIn = easeOut(sec / 0.5);
    const cx = a.torso.x;
    const topY = a.torso.y - a.catHeight * 0.2;
    const botY = a.torso.y + 26;

    ctx.save();
    ctx.globalAlpha = fadeIn;

    // 围裙：梯形胸兜 + 颈部带子（尺寸随 K 放大；原来固定 ±24/±44 像素，套在较宽的猫身上显得太小）
    const K = 1.5;
    const halfTop = 24 * K;
    const halfBot = 44 * K;
    const apronBotY = botY + 14;
    ctx.fillStyle = this.apron;
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - halfTop, topY);
    ctx.lineTo(cx + halfTop, topY);
    ctx.lineTo(cx + halfBot, apronBotY);
    ctx.lineTo(cx - halfBot, apronBotY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = this.apron;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - halfTop, topY);
    ctx.quadraticCurveTo(cx, topY - 22 * K, cx + halfTop, topY);
    ctx.stroke();
    // 小口袋
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    rrect(ctx, cx - 14 * K, apronBotY - 22 * K, 28 * K, 14 * K, 3);
    ctx.fill();

    // 8 秒一轮：前 4 秒擦杯子，后 4 秒端盘子
    const phase = sec % 8;
    const cupX = cx + 62 + 20;
    const cupY = botY + 6;
    if (phase < 4) {
      this.drawCup(ctx, cupX, cupY);
      // 抹布画圈
      const ang = phase * 7;
      ctx.strokeStyle = '#8ec5ff';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cupX - 9 + Math.cos(ang) * 4, cupY - 4 + Math.sin(ang) * 3);
      ctx.lineTo(cupX + 9 + Math.cos(ang + 1) * 4, cupY - 4 + Math.sin(ang + 1) * 3);
      ctx.stroke();
      if (Math.sin(phase * 5) > 0.92) this.drawSparkle(ctx, cupX + 12, cupY - 14);
    } else {
      // 托盘 + 杯子左右轻晃着「端」
      const p = phase - 4;
      const sway = Math.sin(p * 2.2) * 6;
      const tx = cx - 8 + sway;
      const ty = botY + 4 + Math.sin(p * 4.4) * 1.2;
      ctx.fillStyle = '#b98a5b';
      ctx.beginPath();
      ctx.ellipse(tx, ty, 34, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      this.drawCup(ctx, tx, ty - 12);
    }
    ctx.restore();
  }

  private drawCup(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.2;
    rrect(ctx, x - 9, y - 10, 18, 14, 3);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 11, y - 3, 4.5, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }

  private drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.fillStyle = '#fff3a8';
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 2, y - 2);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x + 2, y + 2);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 2, y + 2);
    ctx.lineTo(x - 6, y);
    ctx.lineTo(x - 2, y - 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
