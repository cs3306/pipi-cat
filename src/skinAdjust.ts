// 每个皮肤各自的缩放与上下偏移（设置 →皮肤 →「高级」）。不进皮肤包，只存在本机。
// 用 localStorage：设置窗口与猫窗口同源，可共享，并通过 storage 事件即时同步。
// localStorage 可能不可用或为空，所有读写都包 try/catch，失败就用默认值。

import type { SkinAdjust } from './rig/rigRender';

const KEY = 'kuro-skin-adjust';
export const DEFAULT_ADJUST: SkinAdjust = { scale: 1, dy: 0 };

type Store = Record<string, SkinAdjust>;

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function sanitizeAdjust(a: Partial<SkinAdjust> | undefined): SkinAdjust {
  const scale = typeof a?.scale === 'number' && Number.isFinite(a.scale) ? Math.min(2, Math.max(0.4, a.scale)) : 1;
  const dy = typeof a?.dy === 'number' && Number.isFinite(a.dy) ? Math.min(120, Math.max(-120, a.dy)) : 0;
  return { scale, dy };
}

export function getAdjust(skinId: string): SkinAdjust {
  return sanitizeAdjust(readAll()[skinId]);
}

export function setAdjust(skinId: string, a: SkinAdjust): void {
  try {
    const all = readAll();
    const clean = sanitizeAdjust(a);
    if (clean.scale === 1 && clean.dy === 0) delete all[skinId];
    else all[skinId] = clean;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 忽略 */
  }
}

export const ADJUST_STORAGE_KEY = KEY;
