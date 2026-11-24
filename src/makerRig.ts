// 制作器里的「分层皮肤」编辑区：选图、摆放（支点/挂点/层级）、可选的分段。
// 每次修改直接改 rig（与皮肤包里的 rig 同形的 JSON），再回调 onChange 刷新预览与校验。
// 视觉与交互未经真机验证。

import { loadImage } from './spriteSkin';
import { imageError } from './makerPack';

type Pair = [number, number];
export interface RigState {
  scale: number;
  parts: {
    torso?: PartJson;
    head?: PartJson;
    limbs?: Partial<Record<'fl' | 'fr' | 'hl' | 'hr', PartJson>>;
    tail?: PartJson;
  };
}
interface SegJson { image: string; pivot: Pair; end: Pair }
interface PartJson {
  image?: string;
  pivot: Pair;
  end?: Pair;
  attach: Pair;
  z: number;
  segments?: SegJson[];
  eyesClosedImage?: string;
  mouthOpenImage?: string;
}

type Tr = (k: string) => string;
type H = (tag: string, attrs?: Record<string, unknown>, ...kids: Array<Node | string>) => HTMLElement;

export function emptyRig(): RigState {
  return { scale: 1, parts: {} };
}

async function pickImage(file: File): Promise<{ uri: string; w: number; h: number } | string> {
  const uri = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const e = imageError(uri);
  if (e) return e;
  const im = await loadImage(uri);
  return { uri, w: im.naturalWidth, h: im.naturalHeight };
}

type Kind = 'torso' | 'head' | 'fl' | 'fr' | 'hl' | 'hr' | 'tail';
const LABEL: Record<Kind, string> = { torso: 'rig.torso', head: 'rig.head', fl: 'rig.fl', fr: 'rig.fr', hl: 'rig.hl', hr: 'rig.hr', tail: 'rig.tail' };

/** 选图后给出一组可用的初始摆放，用户再用滑块微调。尺寸为图片像素（未乘 scale）。 */
function defaults(kind: Kind, uri: string, w: number, h: number, rig: RigState): PartJson {
  const torso = rig.parts.torso;
  const tw = torso ? (torso as PartJson & { _w?: number })._w ?? w : w;
  const th = torso ? (torso as PartJson & { _h?: number })._h ?? h : h;
  switch (kind) {
    case 'torso':
      return { image: uri, pivot: [0.5, 1], attach: [0, 0], z: 10 };
    case 'head':
      return { image: uri, pivot: [0.5, 0.9], attach: [0, Math.round(-th * 0.85)], z: 20 };
    case 'fl':
      return { image: uri, pivot: [0.5, 0.1], end: [0.5, 0.95], attach: [Math.round(-tw * 0.22), Math.round(-th * 0.55)], z: 30 };
    case 'fr':
      return { image: uri, pivot: [0.5, 0.1], end: [0.5, 0.95], attach: [Math.round(tw * 0.22), Math.round(-th * 0.55)], z: 30 };
    case 'hl':
      return { image: uri, pivot: [0.5, 0.1], end: [0.5, 0.95], attach: [Math.round(-tw * 0.25), Math.round(-th * 0.15)], z: 8 };
    case 'hr':
      return { image: uri, pivot: [0.5, 0.1], end: [0.5, 0.95], attach: [Math.round(tw * 0.25), Math.round(-th * 0.15)], z: 8 };
    case 'tail':
      return { image: uri, pivot: [0.05, 0.5], end: [0.95, 0.5], attach: [Math.round(tw * 0.4), Math.round(-th * 0.25)], z: 5 };
  }
}

function getPart(rig: RigState, kind: Kind): PartJson | undefined {
  if (kind === 'torso' || kind === 'head' || kind === 'tail') return rig.parts[kind];
  return rig.parts.limbs?.[kind];
}
function setPart(rig: RigState, kind: Kind, p: PartJson | undefined): void {
  if (kind === 'torso' || kind === 'head' || kind === 'tail') {
    if (p) rig.parts[kind] = p;
    else delete rig.parts[kind];
    return;
  }
  rig.parts.limbs ??= {};
  if (p) rig.parts.limbs[kind] = p;
  else delete rig.parts.limbs[kind];
  if (Object.keys(rig.parts.limbs).length === 0) delete rig.parts.limbs;
}

export function renderRigEditor(
  box: HTMLElement,
  rig: RigState,
  onChange: () => void,
  tr: Tr,
  h: H,
  toast: (m: string, err?: boolean) => void,
): void {
  box.replaceChildren();

  const num = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): HTMLElement => {
    const range = h('input', { type: 'range', min, max, step, value: get() }) as HTMLInputElement;
    const box2 = h('input', { type: 'number', min, max, step, value: get(), style: 'width:76px' }) as HTMLInputElement;
    const apply = (v: number): void => {
      if (!Number.isFinite(v)) return;
      const c = Math.min(max, Math.max(min, v));
      set(c);
      range.value = String(c);
      box2.value = String(c);
      onChange();
    };
    range.addEventListener('input', () => apply(Number(range.value)));
    box2.addEventListener('change', () => apply(Number(box2.value)));
    return h('div', { class: 'row' }, h('label', {}, label), range, box2);
  };

  const imageButton = (label: string, get: () => string | undefined, set: (uri: string | undefined, w: number, h2: number) => void, clearable: boolean): HTMLElement => {
    const thumb = h('img', { alt: '', style: 'width:40px;height:40px;object-fit:contain' });
    const file = h('input', { type: 'file', accept: 'image/png,image/webp', style: 'display:none' }) as HTMLInputElement;
    const refresh = (): void => {
      const u = get();
      if (u) thumb.setAttribute('src', u);
      else thumb.removeAttribute('src');
    };
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const r = await pickImage(f);
      if (typeof r === 'string') {
        toast(tr(`err.${r}`), true);
        return;
      }
      set(r.uri, r.w, r.h);
      refresh();
      onChange();
    });
    refresh();
    return h('div', { class: 'slot' }, thumb, h('span', { style: 'min-width:130px' }, label),
      h('button', { class: 'btn', onclick: () => file.click() }, tr('choose')),
      clearable ? h('button', { class: 'btn', onclick: () => { set(undefined, 0, 0); refresh(); onChange(); } }, tr('clear')) : '',
      file);
  };

  const pairRows = (p: { pivot: Pair; end?: Pair; attach?: Pair }, withEnd: boolean, withAttach: boolean): HTMLElement[] => {
    const rows: HTMLElement[] = [
      num(tr('rig.pivotX'), () => p.pivot[0], (v) => (p.pivot[0] = v), 0, 1, 0.01),
      num(tr('rig.pivotY'), () => p.pivot[1], (v) => (p.pivot[1] = v), 0, 1, 0.01),
    ];
    if (withEnd && p.end) {
      rows.push(num(tr('rig.endX'), () => p.end![0], (v) => (p.end![0] = v), 0, 1, 0.01));
      rows.push(num(tr('rig.endY'), () => p.end![1], (v) => (p.end![1] = v), 0, 1, 0.01));
    }
    if (withAttach && p.attach) {
      rows.push(num(tr('rig.attachX'), () => p.attach![0], (v) => (p.attach![0] = v), -600, 600, 1));
      rows.push(num(tr('rig.attachY'), () => p.attach![1], (v) => (p.attach![1] = v), -600, 600, 1));
    }
    return rows;
  };

  // 整体缩放 + 自动适配
  box.append(
    num(tr('rig.scale'), () => rig.scale, (v) => (rig.scale = v), 0.1, 4, 0.05),
    h('p', { class: 'desc' }, tr('rig.help')),
  );

  const kinds: Kind[] = ['torso', 'head', 'fl', 'fr', 'hl', 'hr', 'tail'];
  for (const kind of kinds) {
    const part = getPart(rig, kind);
    const isLimbOrTail = kind !== 'torso' && kind !== 'head';
    const inner: HTMLElement[] = [
      imageButton(tr(LABEL[kind]), () => getPart(rig, kind)?.image, (uri, w, hh) => {
        if (!uri) {
          setPart(rig, kind, undefined);
        } else {
          const next = defaults(kind, uri, w, hh, rig);
          if (kind === 'torso') {
            // 记住躯干的像素尺寸，后面的部位按它算初始位置
            Object.assign(next, { _w: w, _h: hh });
            rig.scale = Math.min(4, Math.max(0.1, Math.round((260 / Math.max(hh, 1)) * 100) / 100));
          }
          setPart(rig, kind, { ...getPart(rig, kind), ...next });
        }
        renderRigEditor(box, rig, onChange, tr, h, toast);
      }, kind !== 'torso' && kind !== 'head'),
    ];
    if (part) {
      inner.push(...pairRows(part, isLimbOrTail, true));
      inner.push(num(tr('rig.z'), () => part.z, (v) => (part.z = Math.round(v)), -100, 100, 1));
      if (kind === 'head') {
        inner.push(
          imageButton(tr('rig.eyes'), () => part.eyesClosedImage, (uri) => { if (uri) part.eyesClosedImage = uri; else delete part.eyesClosedImage; }, true),
          imageButton(tr('rig.mouth'), () => part.mouthOpenImage, (uri) => { if (uri) part.mouthOpenImage = uri; else delete part.mouthOpenImage; }, true),
        );
      }
      if (isLimbOrTail) inner.push(segmentsEditor(part));
    }
    box.append(h('details', { open: kind === 'torso' || kind === 'head' || undefined }, h('summary', {}, tr(LABEL[kind])), ...inner));
  }

  function segmentsEditor(part: PartJson): HTMLElement {
    const list = part.segments ?? [];
    const rows: HTMLElement[] = [h('p', { class: 'desc' }, tr('rig.segHelp'))];
    list.forEach((seg, i) => {
      rows.push(
        imageButton(`${tr('rig.seg')} ${i + 1}`, () => seg.image, (uri) => {
          if (uri) {
            seg.image = uri;
          } else {
            list.splice(i, 1);
            if (list.length === 0) delete part.segments;
            renderRigEditor(box, rig, onChange, tr, h, toast);
          }
        }, true),
        ...pairRows(seg, true, false),
      );
    });
    if (list.length < 3) {
      const file = h('input', { type: 'file', accept: 'image/png,image/webp', style: 'display:none' }) as HTMLInputElement;
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        const r = await pickImage(f);
        if (typeof r === 'string') {
          toast(tr(`err.${r}`), true);
          return;
        }
        (part.segments ??= []).push({ image: r.uri, pivot: [0.5, 0.1], end: [0.5, 0.95] });
        renderRigEditor(box, rig, onChange, tr, h, toast);
        onChange();
      });
      rows.push(h('button', { class: 'btn', onclick: () => file.click() }, tr('rig.addSeg')), file);
    }
    return h('details', {}, h('summary', {}, tr('advanced') + ' · ' + tr('rig.seg')), ...rows);
  }
}

/** 导出前去掉仅用于编辑器的临时字段（_w/_h）。 */
export function cleanRig(rig: RigState): RigState {
  const copy = JSON.parse(JSON.stringify(rig)) as RigState;
  for (const p of [copy.parts.torso, copy.parts.head, copy.parts.tail, ...Object.values(copy.parts.limbs ?? {})]) {
    if (p) {
      const q = p as unknown as Record<string, unknown>;
      delete q._w;
      delete q._h;
    }
  }
  return copy;
}
