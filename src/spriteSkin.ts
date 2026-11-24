// 图片皮肤：用皮肤包里的 idle / blink / happy / shy 四张图替代猫身体。
// 键盘、鼠标、气泡和玩法效果层仍由引擎绘制；这里只负责选图和画图。
// 视觉效果未经真机验证（构建环境看不到画面）。

import { pet } from './petBridge';

export type SpriteSlot = 'idle' | 'blink' | 'happy' | 'shy';

export interface SpriteMood {
  happy: boolean;
  shy: boolean;
  /** 引擎的呼吸值（约 -1.6..1.6） */
  breath: number;
}

export class SpriteSkin {
  private nextBlinkAt = 0;
  private blinkUntil = 0;

  constructor(private readonly imgs: Partial<Record<SpriteSlot, HTMLImageElement>>) {}

  private pick(now: number, mood: SpriteMood): SpriteSlot {
    if (mood.shy && this.imgs.shy) return 'shy';
    if (mood.happy && this.imgs.happy) return 'happy';
    if (this.imgs.blink) {
      if (this.nextBlinkAt === 0) this.nextBlinkAt = now + 2500 + Math.random() * 3500;
      if (now >= this.nextBlinkAt) {
        this.blinkUntil = now + 140;
        this.nextBlinkAt = now + 2500 + Math.random() * 3500;
      }
      if (now < this.blinkUntil) return 'blink';
    }
    return 'idle';
  }

  /** 以 (cx, bottomY) 为底边中点，等比缩放进 maxW×maxH。 */
  draw(ctx: CanvasRenderingContext2D, cx: number, bottomY: number, maxW: number, maxH: number, now: number, mood: SpriteMood): void {
    const img = this.imgs[this.pick(now, mood)] ?? this.imgs.idle;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const fit = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const w = img.naturalWidth * fit;
    const h = img.naturalHeight * fit;
    const squash = 1 + mood.breath * 0.006;
    ctx.save();
    ctx.translate(cx, bottomY);
    ctx.scale(1 / squash, squash);
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
  }
}

const cache = new Map<string, Promise<SpriteSkin | null>>();

export function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = uri;
  });
}

/** 颜色皮肤或不存在的皮肤返回 null。结果按 id 缓存，安装/卸载后调用 clearSpriteCache。 */
export function loadSpriteSkin(id: string): Promise<SpriteSkin | null> {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      try {
        const map = await pet.skinSprites(id);
        const imgs: Partial<Record<SpriteSlot, HTMLImageElement>> = {};
        for (const slot of ['idle', 'blink', 'happy', 'shy'] as const) {
          if (map[slot]) imgs[slot] = await loadImage(map[slot]);
        }
        return imgs.idle ? new SpriteSkin(imgs) : null;
      } catch {
        return null;
      }
    })();
    cache.set(id, p);
  }
  return p;
}

export function clearSpriteCache(): void {
  cache.clear();
}
