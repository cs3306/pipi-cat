// 皮肤制作器窗口（独立窗口，随本体打包）。
// 功能：基本信息 → 颜色皮肤（调色板）或图片皮肤（四张图）→ 实时预览 → 导出 .petskin / 安装到本软件。
// AI 功能（可选）：把你写的描述发给你自己填写的接口，换回一份调色板；与本体的 MCP 接口完全无关。
// 预览直接复用猫的绘制引擎；视觉效果未经真机验证。

import { KuroCatEngine } from './catEngine';
import { listen } from '@tauri-apps/api/event';
import { getLang } from './i18n';
import { errText, pet, type SkinSummary } from './petBridge';
import { loadImage, SpriteSkin, type SpriteSlot } from './spriteSkin';
import { LayeredSkin } from './rig/rigRender';
import { imageRefs, parseRig } from './rig/rigTypes';
import { cleanRig, emptyRig, renderRigEditor, type RigState } from './makerRig';
import { buildPack, imageError, isHexColor, normalizeColors, paletteErrors, suggestId, SLOTS, type Slot } from './makerPack';
import type { CatPattern, CatSkinConfig } from './catSkins';
import { installErrorLogging, logEvent } from './applog';

installErrorLogging('maker');

type Dict = Record<string, string>;
const ZH: Dict = {
  title: '皮肤制作器',
  intro: '做一个自己的猫皮肤：可以调颜色，也可以换成自己的图片。做好后导出成 .petskin 分享，或者直接安装到这个软件。',
  basics: '基本信息',
  name: '名称', id: '标识（id）', idHint: '小写字母、数字、连字符，3 到 30 个字符', author: '作者', license: '许可证', version: '版本', description: '简介',
  kind: '类型', kindPalette: '颜色皮肤', kindSprites: '图片皮肤',
  kindLayered: '分层皮肤（头、躯干、四肢、尾巴）',
  'rig.torso': '躯干（必填）', 'rig.head': '头（必填）', 'rig.fl': '左前肢', 'rig.fr': '右前肢', 'rig.hl': '左后肢', 'rig.hr': '右后肢', 'rig.tail': '尾巴',
  'rig.scale': '整体缩放', 'rig.help': '每个部位一张图（PNG/WebP）。「支点」是图上的转轴位置，「挂点」是支点放在角色上的位置；肢体和尾巴还有「终点」（静止时指向的方向）。选图后会给一组初始值，用滑块微调，右边实时预览。',
  'rig.pivotX': '支点 X', 'rig.pivotY': '支点 Y', 'rig.endX': '终点 X', 'rig.endY': '终点 Y', 'rig.attachX': '挂点 X', 'rig.attachY': '挂点 Y', 'rig.z': '层级',
  'rig.eyes': '闭眼版头部图', 'rig.mouth': '张嘴版头部图', 'rig.seg': '分段', 'rig.addSeg': '添加一段（最多 3 段）',
  'rig.segHelp': '分段是可选的高级功能：肢体用 2 段（上下两段，关节弯曲），尾巴用 2–3 段（链式弯曲）。添加分段后，上面那张单图不再使用。',
  'err.rig-missing': '缺少分层数据', 'err.missing-torso': '缺少躯干图', 'err.missing-head': '缺少头部图', 'err.bad-scale': '整体缩放超出范围（0.1–4）',
  'err.bad-pivot': '支点超出 0..1', 'err.bad-end': '终点不合法（需在 0..1，并且离支点不能太近）', 'err.bad-attach': '挂点超出范围', 'err.bad-z': '层级超出范围（-100..100）',
  'err.too-many-segments': '分段太多（最多 3 段）', 'err.too-many-images': '图片太多（最多 16 张）', 'err.images-total-too-large': '图片总大小超过 6 MB',
  'err.missing-image': '缺少图片', 'err.missing-end': '分段缺少终点', 'err.unknown-limb': '未知的肢体', 'err.bad-part': '部位数据不合法',

  colors: '颜色', pattern: '花纹',
  fur: '毛色', furSecondary: '次要毛色', outline: '描边', eyeTop: '眼睛（上）', eyeBottom: '眼睛（下）', earInner: '耳朵内侧', tail: '尾巴', nose: '鼻子', blush: '腮红',
  p_solid: '纯色', p_bicolor: '双色', p_tuxedo: '燕尾服', p_tabby: '虎斑', p_calico: '三花', p_siamese: '暹罗',
  unset: '不设置',
  images: '图片', imagesDesc: 'idle 必填，其余可选。PNG 或 WebP，单张不超过 1.5 MB，PNG 每边不超过 2048。',
  slot_idle: '平时 (idle)', slot_blink: '眨眼 (blink)', slot_happy: '开心 (happy)', slot_shy: '害羞 (shy)',
  choose: '选择图片', clear: '清除',
  advanced: '高级', rawJson: '调色板 JSON（直接编辑，失焦后生效）', rawBad: 'JSON 无法解析',
  ai: '用 AI 生成配色', aiDesc: '写几句描述，让 AI 给出一份调色板，然后在上面微调。需要你自己的接口；只有点击「生成」时才会联网。',
  aiNotice: '点击生成时，只会把下面这段描述（和固定的字段说明）发送到你填写的地址，不发送其他任何内容。这和本体的 MCP 接口是两回事。',
  aiBase: '接口地址', aiBaseHint: '例如 https://api.example.com/v1（必须 https；本机模型可用 http://localhost:端口）',
  aiModel: '模型', aiKey: 'API 密钥', aiKeySaved: '（已保存，留空则不修改）', aiRemember: '记住密钥（明文保存在本机文件里，默认不勾选）',
  aiPrompt: '描述', aiPromptHint: '例如：夕阳色的橘猫，绿眼睛，尾巴尖是白色', aiGo: '生成', aiBusy: '生成中…', aiDone: '已填入调色板，请在预览里检查',
  export: '导出 .petskin', install: '安装到本软件', installConfirm: '安装', cancel: '取消', installed: '已安装', exported: '已导出',
  confirmTitle: '安装这个皮肤？', replace: '已存在同名皮肤，将被替换。',
  fixFirst: '请先修正：',
  'err.bad-id': 'id 不合法', 'err.missing-name': '缺少名称', 'err.missing-author': '缺少作者', 'err.missing-license': '缺少许可证', 'err.missing-version': '缺少版本',
  'err.bad-color': '有颜色格式不对（需要 #rgb 或 #rrggbb）', 'err.palette-needs-furColor': '缺少毛色', 'err.too-many-spots': '斑点太多（最多 24 个）',
  'err.not-an-image': '图片不是有效的 PNG/WebP', 'err.image-too-large': '图片超过 1.5 MB', 'err.image-dimensions': 'PNG 尺寸不合法（每边最大 2048）',
  'err.missing-idle-image': '必须有 idle 图片', 'err.pack-too-large': '皮肤包太大',
  'err.ai-not-configured': '请先填写接口地址和模型', 'err.ai-empty-prompt': '请先写描述', 'err.ai-no-json': 'AI 没有返回可用的内容，请换个说法再试', 'err.ai-bad-json': 'AI 返回的内容无法解析，请再试一次',
  'err.ai-bad-response': '接口返回的格式不是 OpenAI 兼容格式', 'err.ai-invalid': 'AI 返回的配色没有通过校验', 'err.endpoint-needs-https': '地址必须是 https（本机地址除外）', 'err.endpoint-invalid': '地址格式不对',
  'err.ai-request-failed': '请求失败',
  open: '打开已有', openBuiltin: '从内置猫开始…', openInstalled: '打开已安装的皮肤…', openFile: '从文件打开…', loaded: '已载入',
  copyOf: '副本', overrideTitle: '修改默认皮肤的外观', apply: '应用到这只猫', toBuiltin: '回到内置起点', applied: '已应用，立即生效',
  overrideDesc: '这里改的是内置猫的外观，应用后立即生效；内置外观本身不会被改动，之后可以在 设置 → 皮肤 里撤销上一次或恢复默认。',
  editingDesc: '正在编辑已安装的皮肤。安装会替换它，并保留上一版（可在 设置 → 皮肤 回退）。id 不能改。',
  b_black: '小黑猫', b_ragdoll: '布偶猫', 'b_orange-tabby': '大橘猫', b_calico: '三花猫', b_tuxedo: '奶牛猫', b_siamese: '暹罗猫',
  'err.not-overridable': '这只猫不能覆盖外观', 'err.does-not-fit-cat': '配色无法套用到这只猫', 'err.bad-schemaVersion': 'schemaVersion 只能是 1 或 2',
  'err.not-copyable': '这只猫不能作为起点', 'err.bad-file': '文件不是有效的皮肤包',
};
const EN: Dict = {
  title: 'Skin Maker',
  intro: 'Make your own cat skin: tweak colours or use your own images. Export a .petskin to share, or install it straight into this app.',
  basics: 'Basics',
  name: 'Name', id: 'ID', idHint: 'lowercase letters, digits, hyphens; 3–30 characters', author: 'Author', license: 'Licence', version: 'Version', description: 'Description',
  kind: 'Type', kindPalette: 'Colour skin', kindSprites: 'Image skin',
  kindLayered: 'Layered skin (head, torso, limbs, tail)',
  'rig.torso': 'Torso (required)', 'rig.head': 'Head (required)', 'rig.fl': 'Front left limb', 'rig.fr': 'Front right limb', 'rig.hl': 'Hind left limb', 'rig.hr': 'Hind right limb', 'rig.tail': 'Tail',
  'rig.scale': 'Overall scale', 'rig.help': 'One image (PNG/WebP) per part. "Pivot" is the hinge point on the image, "attach" is where that pivot sits on the character; limbs and tail also have an "end" point (the rest direction). Picking an image fills in starting values; fine-tune with the sliders and watch the live preview.',
  'rig.pivotX': 'Pivot X', 'rig.pivotY': 'Pivot Y', 'rig.endX': 'End X', 'rig.endY': 'End Y', 'rig.attachX': 'Attach X', 'rig.attachY': 'Attach Y', 'rig.z': 'Layer',
  'rig.eyes': 'Eyes-closed head image', 'rig.mouth': 'Mouth-open head image', 'rig.seg': 'Segment', 'rig.addSeg': 'Add a segment (max 3)',
  'rig.segHelp': 'Segments are an optional advanced feature: limbs use 2 (upper/lower with a joint), tails 2–3 (chain bend). Once you add segments, the single image above is no longer used.',
  'err.rig-missing': 'Layer data is missing', 'err.missing-torso': 'Torso image is missing', 'err.missing-head': 'Head image is missing', 'err.bad-scale': 'Overall scale out of range (0.1–4)',
  'err.bad-pivot': 'Pivot outside 0..1', 'err.bad-end': 'Invalid end point (within 0..1 and not too close to the pivot)', 'err.bad-attach': 'Attach point out of range', 'err.bad-z': 'Layer out of range (-100..100)',
  'err.too-many-segments': 'Too many segments (max 3)', 'err.too-many-images': 'Too many images (max 16)', 'err.images-total-too-large': 'Images exceed 6 MB in total',
  'err.missing-image': 'Image is missing', 'err.missing-end': 'Segment is missing its end point', 'err.unknown-limb': 'Unknown limb', 'err.bad-part': 'Invalid part data',

  colors: 'Colours', pattern: 'Pattern',
  fur: 'Fur', furSecondary: 'Secondary fur', outline: 'Outline', eyeTop: 'Eye (top)', eyeBottom: 'Eye (bottom)', earInner: 'Inner ear', tail: 'Tail', nose: 'Nose', blush: 'Blush',
  p_solid: 'Solid', p_bicolor: 'Bicolour', p_tuxedo: 'Tuxedo', p_tabby: 'Tabby', p_calico: 'Calico', p_siamese: 'Siamese',
  unset: 'unset',
  images: 'Images', imagesDesc: 'idle is required, the rest are optional. PNG or WebP, max 1.5 MB each, PNG max 2048 per side.',
  slot_idle: 'Idle', slot_blink: 'Blink', slot_happy: 'Happy', slot_shy: 'Shy',
  choose: 'Choose image', clear: 'Clear',
  advanced: 'Advanced', rawJson: 'Palette JSON (edit directly; applies on blur)', rawBad: 'Cannot parse JSON',
  ai: 'Generate colours with AI', aiDesc: 'Describe the look and let an AI propose a palette, then fine-tune it above. Needs your own endpoint; nothing goes online until you click Generate.',
  aiNotice: 'When you click Generate, only the description below (plus a fixed field guide) is sent to the address you entered — nothing else. This is separate from the app\'s MCP interface.',
  aiBase: 'Endpoint', aiBaseHint: 'e.g. https://api.example.com/v1 (https required; local models may use http://localhost:port)',
  aiModel: 'Model', aiKey: 'API key', aiKeySaved: '(saved; leave empty to keep)', aiRemember: 'Remember key (stored in plain text on this PC; off by default)',
  aiPrompt: 'Description', aiPromptHint: 'e.g. a sunset-orange cat with green eyes and a white tail tip', aiGo: 'Generate', aiBusy: 'Generating…', aiDone: 'Palette filled in — check the preview',
  export: 'Export .petskin', install: 'Install into this app', installConfirm: 'Install', cancel: 'Cancel', installed: 'Installed', exported: 'Exported',
  confirmTitle: 'Install this skin?', replace: 'A skin with this id exists and will be replaced.',
  fixFirst: 'Please fix first:',
  'err.bad-id': 'Invalid id', 'err.missing-name': 'Name is missing', 'err.missing-author': 'Author is missing', 'err.missing-license': 'Licence is missing', 'err.missing-version': 'Version is missing',
  'err.bad-color': 'A colour is invalid (use #rgb or #rrggbb)', 'err.palette-needs-furColor': 'Fur colour is missing', 'err.too-many-spots': 'Too many spots (max 24)',
  'err.not-an-image': 'Not a valid PNG/WebP image', 'err.image-too-large': 'Image exceeds 1.5 MB', 'err.image-dimensions': 'PNG dimensions invalid (max 2048 per side)',
  'err.missing-idle-image': 'An idle image is required', 'err.pack-too-large': 'Pack is too large',
  'err.ai-not-configured': 'Enter an endpoint and model first', 'err.ai-empty-prompt': 'Write a description first', 'err.ai-no-json': 'The AI returned nothing usable; try rephrasing', 'err.ai-bad-json': 'The AI reply could not be parsed; try again',
  'err.ai-bad-response': 'The endpoint did not answer in OpenAI-compatible format', 'err.ai-invalid': 'The AI palette failed validation', 'err.endpoint-needs-https': 'Endpoint must be https (local addresses excepted)', 'err.endpoint-invalid': 'Invalid endpoint',
  'err.ai-request-failed': 'Request failed',
  open: 'Open existing', openBuiltin: 'Start from a built-in cat…', openInstalled: 'Open an installed skin…', openFile: 'Open from file…', loaded: 'Loaded',
  copyOf: 'copy', overrideTitle: 'Change a default skin\'s look', apply: 'Apply to this cat', toBuiltin: 'Back to built-in starting point', applied: 'Applied — takes effect immediately',
  overrideDesc: 'You are changing the look of a built-in cat. It takes effect as soon as you apply; the built-in look itself is never modified, and you can undo or restore it in Settings → Skins.',
  editingDesc: 'Editing an installed skin. Installing replaces it and keeps the previous version (roll back in Settings → Skins). The id cannot change.',
  b_black: 'Black cat', b_ragdoll: 'Ragdoll', 'b_orange-tabby': 'Orange tabby', b_calico: 'Calico', b_tuxedo: 'Tuxedo', b_siamese: 'Siamese',
  'err.not-overridable': 'This cat cannot be overridden', 'err.does-not-fit-cat': 'These colours cannot be applied to this cat', 'err.bad-schemaVersion': 'schemaVersion must be 1 or 2',
  'err.not-copyable': 'This cat cannot be used as a starting point', 'err.bad-file': 'Not a valid skin pack',
};
const D = getLang() === 'zh' ? ZH : EN;
const tr = (k: string): string => D[k] ?? k;
/** 后端错误码形如 `ai-invalid:bad-color|x` 或 `ai-request-failed:详情`。 */
function errMsg(raw: string): string {
  const [code, rest] = [raw.split(':')[0], raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : ''];
  const base = D[`err.${code}`];
  if (!base) return raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
  if (code === 'ai-request-failed' && rest) return `${base}: ${rest}`;
  if (code === 'ai-invalid' && rest) return `${base}: ${rest.split('|').map((c) => D[`err.${c}`] ?? c).join('、')}`;
  if (rest) return `${base} (${rest})`;
  return base;
}

// ───────── 状态 ─────────
const state = {
  meta: { id: '', name: '', author: '', license: 'CC-BY-4.0', version: '1.0.0', description: '' },
  idTouched: false,
  /** new：新建；override：修改默认皮肤；edit：编辑已安装皮肤（id 固定）。 */
  mode: { type: 'new' } as { type: 'new' } | { type: 'override'; id: string } | { type: 'edit'; id: string },
  kind: 'palette' as 'palette' | 'sprites' | 'layered',
  rig: emptyRig() as RigState,
  palette: { furColor: '#d9b48a', eyeColorTop: '#3a8f4a', pattern: 'solid' } as Record<string, unknown>,
  sprites: {} as Partial<Record<Slot, string>>,
};

// ───────── 小工具 ─────────
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of kids) el.append(c);
  return el;
}
let toastTimer = 0;
function toast(msg: string, err = false): void {
  if (err) logEvent('error', 'maker', msg);
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.className = `toast show${err ? ' err' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = 'toast'), 3200);
}
function fileToDataUri(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('image'));
    i.src = src;
  });
}

// ───────── 预览 ─────────
const canvas = document.getElementById('preview') as HTMLCanvasElement;
const engine = new KuroCatEngine(canvas, { embedded: true });
engine.setRenderScale(1.0);
engine.resize();
engine.start();
let previewSeq = 0;

const imgCache = new Map<string, Promise<HTMLImageElement>>();
function cachedImage(uri: string): Promise<HTMLImageElement> {
  let p = imgCache.get(uri);
  if (!p) {
    p = loadImage(uri);
    imgCache.set(uri, p);
    if (imgCache.size > 60) imgCache.delete(imgCache.keys().next().value as string);
  }
  return p;
}
let previewTimer = 0;
function schedulePreview(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void refreshPreview(), 60);
}

async function refreshPreview(): Promise<void> {
  const seq = ++previewSeq;
  if (state.kind === 'layered') {
    engine.setSpriteSkin(null);
    const def = parseRig(cleanRig(state.rig));
    if (!def) {
      engine.setLayeredSkin(null);
      engine.setCatAppearance('black', null);
      return;
    }
    const imgs = new Map<string, HTMLImageElement>();
    for (const [key, uri] of imageRefs(def)) {
      try { imgs.set(key, await cachedImage(uri)); } catch { /* 坏图：该部位不画 */ }
    }
    if (seq !== previewSeq) return;
    engine.setLayeredSkin(imgs.has('torso') && imgs.has('head') ? new LayeredSkin(def, imgs) : null);
    engine.setCatAppearance('black', null);
    return;
  }
  engine.setLayeredSkin(null);
  if (state.kind === 'palette') {
    engine.setSpriteSkin(null);
    const cfg = { id: 'preview', name: 'preview', eyeColorTop: '#222222', ...state.palette } as unknown as CatSkinConfig;
    if (!isHexColor(cfg.furColor)) cfg.furColor = '#d9b48a';
    engine.setCatAppearance('preview', cfg);
  } else {
    const imgs: Partial<Record<SpriteSlot, HTMLImageElement>> = {};
    for (const s of SLOTS) {
      const uri = state.sprites[s];
      if (uri && !imageError(uri)) {
        try { imgs[s] = await loadImg(uri); } catch { /* 忽略坏图 */ }
      }
    }
    if (seq !== previewSeq) return;
    engine.setSpriteSkin(imgs.idle ? new SpriteSkin(imgs) : null);
    engine.setCatAppearance('black', null);
  }
}

// ───────── 表单 ─────────
const form = document.getElementById('form')!;
const actions = document.getElementById('actions')!;
let kindSection: HTMLElement;
let rawArea: HTMLTextAreaElement | null = null;
const colorSetters: Array<() => void> = [];

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const r = h('div', { class: 'row' }, h('label', {}, label), input);
  if (hint) r.append(h('span', { class: 'muted' }, hint));
  return r;
}
function textInput(get: () => string, set: (v: string) => void, extra: Record<string, unknown> = {}): HTMLInputElement {
  const i = h('input', { type: 'text', value: get(), ...extra });
  i.addEventListener('input', () => { set(i.value); onChange(); });
  return i;
}

const COLOR_FIELDS: Array<[string, string, boolean]> = [
  ['furColor', 'fur', true], ['furSecondaryColor', 'furSecondary', false], ['outlineColor', 'outline', false],
  ['eyeColorTop', 'eyeTop', true], ['eyeColorBottom', 'eyeBottom', false], ['earInnerColor', 'earInner', false],
  ['tailColor', 'tail', false], ['noseColor', 'nose', false], ['blushColor', 'blush', false],
];

function colorRow(key: string, labelKey: string, required: boolean): HTMLElement {
  const picker = h('input', { type: 'color' });
  const on = h('input', { type: 'checkbox' });
  const sync = (): void => {
    const v = state.palette[key];
    const set = typeof v === 'string' && isHexColor(v);
    on.checked = set;
    picker.disabled = !set;
    if (set) picker.value = expandHex((v as string).length > 7 ? (v as string).slice(0, 7) : (v as string));
  };
  colorSetters.push(sync);
  picker.addEventListener('input', () => { state.palette[key] = picker.value; syncRaw(); onChange(); });
  on.addEventListener('change', () => {
    if (on.checked) state.palette[key] = picker.value || '#888888';
    else delete state.palette[key];
    sync(); syncRaw(); onChange();
  });
  sync();
  const row = h('div', { class: 'row' }, h('label', {}, tr(labelKey)), picker);
  if (!required) row.append(on);
  return row;
}
function expandHex(c: string): string {
  return /^#[0-9a-fA-F]{3}$/.test(c) ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
}
function syncRaw(): void {
  if (rawArea) rawArea.value = JSON.stringify(state.palette, null, 2);
}

function renderKindSection(): void {
  kindSection.replaceChildren();
  colorSetters.length = 0;
  rawArea = null;
  if (state.kind === 'palette') {
    kindSection.append(h('h2', {}, tr('colors')));
    for (const [k, l, req] of COLOR_FIELDS) kindSection.append(colorRow(k, l, req));
    const sel = h('select', {});
    for (const p of ['solid', 'bicolor', 'tuxedo', 'tabby', 'calico', 'siamese'] as CatPattern[]) sel.append(h('option', { value: p }, tr(`p_${p}`)));
    sel.value = String(state.palette.pattern ?? 'solid');
    sel.addEventListener('change', () => { state.palette.pattern = sel.value; syncRaw(); onChange(); });
    kindSection.append(field(tr('pattern'), sel));

    rawArea = h('textarea', { rows: 10, spellcheck: false });
    syncRaw();
    rawArea.addEventListener('blur', () => {
      try {
        const v = JSON.parse(rawArea!.value);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('x');
        state.palette = v;
        colorSetters.forEach((f) => f());
        sel.value = String(state.palette.pattern ?? 'solid');
        onChange();
      } catch { toast(tr('rawBad'), true); }
    });
    kindSection.append(h('details', {}, h('summary', {}, tr('advanced')), h('p', { class: 'desc' }, tr('rawJson')), rawArea));
    kindSection.append(aiSection());
  } else if (state.kind === 'layered') {
    const box = h('div', {});
    kindSection.append(h('h2', {}, tr('kindLayered')), box);
    renderRigEditor(box, state.rig, onChange, tr, h as never, toast);
  } else {
    kindSection.append(h('h2', {}, tr('images')), h('p', { class: 'desc' }, tr('imagesDesc')));
    for (const s of SLOTS) kindSection.append(slotRow(s));
  }
}

function slotRow(slot: Slot): HTMLElement {
  const thumb = h('img', { alt: '' });
  const file = h('input', { type: 'file', accept: 'image/png,image/webp', style: 'display:none' });
  const refresh = (): void => { const u = state.sprites[slot]; if (u) thumb.setAttribute('src', u); else thumb.removeAttribute('src'); };
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    const uri = await fileToDataUri(f);
    const e = imageError(uri);
    if (e) { toast(errMsg(e), true); return; }
    state.sprites[slot] = uri;
    refresh(); onChange();
  });
  refresh();
  return h('div', { class: 'slot' }, thumb, h('span', { style: 'min-width:110px' }, tr(`slot_${slot}`)),
    h('button', { class: 'btn', onclick: () => file.click() }, tr('choose')),
    slot === 'idle' ? '' : h('button', { class: 'btn', onclick: () => { delete state.sprites[slot]; refresh(); onChange(); } }, tr('clear')),
    file);
}

function aiSection(): HTMLElement {
  const base = h('input', { type: 'text', placeholder: 'https://…/v1' });
  const model = h('input', { type: 'text' });
  const key = h('input', { type: 'password', autocomplete: 'off' });
  const remember = h('input', { type: 'checkbox' });
  const prompt = h('textarea', { maxlength: 500, placeholder: tr('aiPromptHint') });
  const go = h('button', { class: 'btn' }, tr('aiGo'));
  pet.makerAiGetConfig().then((c) => {
    base.value = c.baseUrl; model.value = c.model; remember.checked = c.remember;
    if (c.hasKey) key.placeholder = tr('aiKeySaved');
  }).catch(() => {});
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = tr('aiBusy');
    try {
      await pet.makerAiSetConfig(base.value, model.value, remember.checked, key.value ? key.value : undefined);
      key.value = '';
      const pal = await pet.makerAiPalette(prompt.value);
      state.palette = pal;
      colorSetters.forEach((f) => f()); syncRaw();
      renderKindSection(); onChange();
      toast(tr('aiDone'));
    } catch (e) { toast(errMsg(errText(e)), true); }
    finally { go.disabled = false; go.textContent = tr('aiGo'); }
  });
  return h('details', { class: 'ai' }, h('summary', {}, tr('ai')),
    h('p', { class: 'desc' }, tr('aiDesc')),
    h('div', { class: 'card warn' }, tr('aiNotice')),
    field(tr('aiBase'), base, tr('aiBaseHint')), field(tr('aiModel'), model), field(tr('aiKey'), key),
    h('div', { class: 'row' }, remember, h('span', {}, tr('aiRemember'))),
    h('div', {}, h('label', {}, tr('aiPrompt')), prompt), h('div', { class: 'row' }, go));
}

// ───────── 导出 / 安装 ─────────
const msgBox = h('div', { class: 'errs' });
const confirmBox = h('div', {});
const btnExport = h('button', { class: 'btn' }, tr('export'));
const btnInstall = h('button', { class: 'btn' }, tr('install'));
const btnApply = h('button', { class: 'btn' }, tr('apply'));
const btnBuiltin = h('button', { class: 'btn' }, tr('toBuiltin'));
const exportRow = h('div', { class: 'row' }, btnExport, btnInstall);
const overrideRow = h('div', { class: 'row' }, btnApply, btnBuiltin);
actions.append(msgBox, exportRow, overrideRow, confirmBox);
function syncActions(): void {
  const ov = state.mode.type === 'override';
  exportRow.style.display = ov ? 'none' : '';
  overrideRow.style.display = ov ? '' : 'none';
}
btnApply.addEventListener('click', async () => {
  if (state.mode.type !== 'override') return;
  try {
    await pet.skinOverrideSave(state.mode.id, state.palette);
    toast(tr('applied'));
  } catch (e) { toast(errMsg(errText(e)), true); }
});
btnBuiltin.addEventListener('click', () => {
  if (state.mode.type === 'override') void loadTarget(`builtin:${state.mode.id}`, true);
});

function currentBuild() {
  return buildPack({
    meta: state.meta,
    kind: state.kind,
    palette: state.kind === 'palette' ? state.palette : undefined,
    sprites: state.sprites,
    rig: state.kind === 'layered' ? (cleanRig(state.rig) as unknown as Record<string, unknown>) : undefined,
  });
}
function onChange(): void {
  schedulePreview();
  confirmBox.replaceChildren();
  if (state.mode.type === 'override') {
    const errs = paletteErrors(state.palette);
    msgBox.textContent = errs.length ? `${tr('fixFirst')} ${errs.map(errMsg).join('；')}` : '';
    btnApply.disabled = errs.length > 0;
    return;
  }
  const r = currentBuild();
  msgBox.textContent = r.ok ? '' : `${tr('fixFirst')} ${r.errors.map(errMsg).join('；')}`;
  btnExport.disabled = btnInstall.disabled = !r.ok;
}

btnExport.addEventListener('click', () => {
  const r = currentBuild();
  if (!r.ok) return;
  const url = URL.createObjectURL(new Blob([r.json], { type: 'application/json' }));
  const a = h('a', { href: url, download: `${state.meta.id}.petskin` });
  document.body.append(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(tr('exported'));
});

btnInstall.addEventListener('click', async () => {
  const r = currentBuild();
  if (!r.ok) return;
  try {
    const s: SkinSummary = await pet.skinInspect(r.json);
    confirmBox.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, `${tr('confirmTitle')} ${s.name}`),
      h('p', { class: 'desc' }, `${tr('author')}: ${s.author}  ·  ${tr('license')}: ${s.license}  ·  ${tr('version')}: ${s.version}`),
      s.installed ? h('p', { class: 'desc' }, tr('replace')) : '',
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          try { await pet.skinInstall(r.json); confirmBox.replaceChildren(); toast(tr('installed')); }
          catch (e) { toast(errMsg(errText(e)), true); }
        } }, tr('installConfirm')),
        h('button', { class: 'btn', onclick: () => confirmBox.replaceChildren() }, tr('cancel')))));
  } catch (e) { toast(errMsg(errText(e)), true); }
});

// ───────── 组装页面 ─────────
const BUILTIN_IDS = ['black', 'ragdoll', 'orange-tabby', 'calico', 'tuxedo', 'siamese'];

function openBar(): HTMLElement {
  const builtin = h('select', {}, h('option', { value: '' }, tr('openBuiltin')));
  for (const id of BUILTIN_IDS) builtin.append(h('option', { value: id }, tr(`b_${id}`)));
  builtin.addEventListener('change', () => { const v = builtin.value; builtin.value = ''; if (v) void loadTarget(`builtin:${v}`); });
  const installed = h('select', {}, h('option', { value: '' }, tr('openInstalled')));
  pet.skinList().then((list) => { for (const sk of list) installed.append(h('option', { value: sk.id }, `${sk.name} (${sk.id})`)); }).catch(() => {});
  installed.addEventListener('change', () => { const v = installed.value; installed.value = ''; if (v) void loadTarget(`skin:${v}`); });
  const file = h('input', { type: 'file', accept: '.petskin,.json', style: 'display:none' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      if (f.size > 13_000_000) throw new Error('pack-too-large');
      loadPack(JSON.parse(await f.text()), { type: 'new' });
      toast(tr('loaded'));
    } catch (e) { toast(errMsg(e instanceof SyntaxError ? 'bad-file' : errText(e)), true); }
  });
  return h('div', { class: 'row' }, h('label', {}, tr('open')), builtin, installed,
    h('button', { class: 'btn', onclick: () => file.click() }, tr('openFile')), file);
}

/** 把一份皮肤包（已解析的 JSON）装进制作器。不可信输入：只取已知字段，其余忽略；最终仍由 buildPack 与后端校验。 */
function loadPack(raw: unknown, mode: typeof state.mode): void {
  if (!raw || typeof raw !== 'object') throw new Error('bad-file');
  const p = raw as Record<string, unknown>;
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const kind = p.kind === 'sprites' || p.kind === 'layered' ? p.kind : 'palette';
  state.meta = { id: str(p.id), name: str(p.name), author: str(p.author), license: str(p.license, 'CC-BY-4.0'), version: str(p.version, '1.0.0'), description: str(p.description) };
  state.idTouched = true;
  state.kind = kind;
  state.mode = mode;
  state.palette = kind === 'palette' && p.palette && typeof p.palette === 'object' && !Array.isArray(p.palette) ? { ...(p.palette as Record<string, unknown>) } : { furColor: '#d9b48a', eyeColorTop: '#3a8f4a', pattern: 'solid' };
  state.sprites = {};
  if (kind === 'sprites' && p.sprites && typeof p.sprites === 'object') {
    for (const slot of SLOTS) { const u = (p.sprites as Record<string, unknown>)[slot]; if (typeof u === 'string') state.sprites[slot] = u; }
  }
  state.rig = kind === 'layered' && p.rig && typeof p.rig === 'object' ? (p.rig as RigState) : emptyRig();
  rebuild();
}

/** target：builtin:<id> / override:<id> / skin:<id>（与后端 open_maker 的 target 一致）。 */
async function loadTarget(target: string, keepName = false): Promise<void> {
  const [type, id] = target.split(':');
  try {
    if (type === 'skin') {
      loadPack(JSON.parse(await pet.skinRead(id)), { type: 'edit', id });
    } else if (type === 'builtin' || type === 'override') {
      const look = await pet.skinBuiltinLook(id);
      const pal = normalizeColors({ ...(type === 'override' && look.override ? look.override : look.builtin) });
      const base = tr(`b_${id}`) === `b_${id}` ? look.name : tr(`b_${id}`);
      state.kind = 'palette';
      state.palette = pal;
      state.sprites = {};
      state.rig = emptyRig();
      if (type === 'override') {
        state.mode = { type: 'override', id };
        state.meta = { ...state.meta, name: base };
      } else {
        state.mode = { type: 'new' };
        state.idTouched = false;
        state.meta = { id: suggestId(`${base} ${tr('copyOf')}`), name: `${base} ${tr('copyOf')}`, author: state.meta.author, license: state.meta.license || 'CC-BY-4.0', version: '1.0.0', description: '' };
      }
      rebuild();
    }
    if (!keepName) toast(tr('loaded'));
  } catch (e) { toast(errMsg(errText(e)), true); }
}

function rebuild(): void {
  form.replaceChildren();
  colorSetters.length = 0;
  build();
}

function build(): void {
  const kindSel = h('select', {}, h('option', { value: 'palette' }, tr('kindPalette')), h('option', { value: 'sprites' }, tr('kindSprites')), h('option', { value: 'layered' }, tr('kindLayered')));
  kindSel.addEventListener('change', () => { state.kind = kindSel.value as 'palette' | 'sprites' | 'layered'; renderKindSection(); onChange(); });
  kindSection = h('div', {});
  let idInput: HTMLInputElement;
  const nameInput = textInput(() => state.meta.name, (v) => {
    state.meta.name = v;
    if (!state.idTouched) { state.meta.id = suggestId(v); idInput.value = state.meta.id; }
  });
  idInput = textInput(() => state.meta.id, (v) => { state.meta.id = v; state.idTouched = true; });
  kindSel.value = state.kind;
  if (state.mode.type === 'override') {
    const id = state.mode.id;
    form.append(
      h('h1', {}, `${tr('overrideTitle')}：${state.meta.name || tr(`b_${id}`)}`), h('p', { class: 'desc' }, tr('overrideDesc')), openBar(), kindSection);
  } else {
    idInput.disabled = state.mode.type === 'edit';
    nameInput.value = state.meta.name;
    idInput.value = state.meta.id;
    form.append(
      h('h1', {}, tr('title')), h('p', { class: 'desc' }, tr('intro')),
      state.mode.type === 'edit' ? h('p', { class: 'desc' }, tr('editingDesc')) : '',
      openBar(),
      h('h2', {}, tr('basics')),
      field(tr('name'), nameInput), field(tr('id'), idInput, tr('idHint')),
      field(tr('author'), textInput(() => state.meta.author, (v) => (state.meta.author = v))),
      field(tr('license'), textInput(() => state.meta.license, (v) => (state.meta.license = v))),
      field(tr('version'), textInput(() => state.meta.version, (v) => (state.meta.version = v))),
      field(tr('description'), textInput(() => state.meta.description, (v) => (state.meta.description = v))),
      field(tr('kind'), kindSel), kindSection);
  }
  syncActions();
  renderKindSection();
  onChange();
}
build();

// 从设置页打开时带的起点；已经开着时，设置页会发事件来切换。
const startTarget = new URLSearchParams(location.search).get('target');
if (startTarget && /^(builtin|override|skin):[a-z0-9-]{1,36}$/.test(startTarget)) void loadTarget(startTarget, true);
void listen<string>('kuro-maker-load', (ev) => {
  if (typeof ev.payload === 'string' && /^(builtin|override|skin):[a-z0-9-]{1,36}$/.test(ev.payload)) void loadTarget(ev.payload);
});
