// 统一加载自定义皮肤：先问后端是不是分层皮肤，不是再按图片皮肤处理。

import { pet } from './petBridge';
import { parseRig, imageRefs } from './rig/rigTypes';
import { LayeredSkin } from './rig/rigRender';
import { clearSpriteCache, loadImage, loadSpriteSkin, type SpriteSkin } from './spriteSkin';

export type LoadedSkin = { kind: 'sprites'; skin: SpriteSkin } | { kind: 'layered'; skin: LayeredSkin } | null;

const cache = new Map<string, Promise<LoadedSkin>>();

/** 从 RigDef 的内嵌图片构建渲染器（制作器预览与安装后的皮肤共用）。 */
export async function buildLayeredSkin(raw: unknown): Promise<LayeredSkin | null> {
  const def = parseRig(raw);
  if (!def) return null;
  const imgs = new Map<string, HTMLImageElement>();
  for (const [key, uri] of imageRefs(def)) {
    try {
      imgs.set(key, await loadImage(uri));
    } catch {
      /* 坏图：该部位降级为不画 */
    }
  }
  return imgs.has('torso') && imgs.has('head') ? new LayeredSkin(def, imgs) : null;
}

export function loadSkin(id: string): Promise<LoadedSkin> {
  let p = cache.get(id);
  if (!p) {
    p = (async (): Promise<LoadedSkin> => {
      try {
        const raw = await pet.skinRig(id);
        if (raw) {
          const skin = await buildLayeredSkin(raw);
          return skin ? { kind: 'layered', skin } : null;
        }
      } catch {
        /* 落到图片皮肤 */
      }
      const sprite = await loadSpriteSkin(id);
      return sprite ? { kind: 'sprites', skin: sprite } : null;
    })();
    cache.set(id, p);
  }
  return p;
}

export function clearSkinCache(): void {
  cache.clear();
  clearSpriteCache();
}
