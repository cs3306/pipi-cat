import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  DEFAULT_TAIL_KEY_IDS,
  KuroCatEngine,
  TAIL_KEY_PRESETS,
  type KeyboardOrientation,
  type TailKeyMode,
} from './catEngine';
import { catAudio } from './audio';
import { DEFAULT_BUILTIN_CATS, type CatSkinConfig } from './catSkins';
import { resolveKeyByVk, type KeyboardLayoutId } from './keyboardLayout';
import { setLang, t } from './i18n';
import { playChime, playMeow } from './meowAudio';
import { clearSkinCache, loadSkin } from './skinLoader';
import { ADJUST_STORAGE_KEY, getAdjust } from './skinAdjust';
import { PetEffects } from './petEffects';
import { pet, type FocusPhase, type PetSettings, type PetStatus, type ReminderEvent } from './petBridge';
import { installErrorLogging, logEvent } from './applog';
import { PhysicalPosition } from '@tauri-apps/api/dpi';

installErrorLogging('main');

interface AppSettings {
  x: number | null;
  y: number | null;
  scale: number;
  alwaysOnTop: boolean;
  clickThroughLocked: boolean;
  showKeyBubbles: boolean;
  soundEnabled: boolean;
  autostart: boolean;
  catBreed: string;
  mcpEnabled: boolean;
  mcpPort: number;
  keyboardLayout: KeyboardLayoutId;
  keyboardOrientation: KeyboardOrientation;
  privacyPasswordGuard: boolean;
  tailKeyMode: TailKeyMode;
  tailKeyIds: string[];
  obsEnabled?: boolean;
  obsPort?: number;
  obsHidePet?: boolean;
}

type InputEvent =
  | { kind: 'keyDown'; vk: number; scan: number; repeat: boolean }
  | { kind: 'keyUp'; vk: number; scan: number }
  | { kind: 'mouseDown'; button: string }
  | { kind: 'mouseUp'; button: string }
  | { kind: 'mouseWheel'; delta: number }
  | { kind: 'mouseMove'; x: number; y: number; nx: number; ny: number }
  | { kind: 'privacyTyping' };

interface WindowCursorInfo {
  relX: number;
  relY: number;
  insideWindow: boolean;
  overCat: boolean;
  altOverride?: boolean;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  assetName: string | null;
  downloadUrl: string | null;
  assetSha256: string | null;
  assetSize: number | null;
  installKind: string;
  notesSummary: string;
}

interface UpdateProgressEvent {
  stage: string;
  message: string;
  info: UpdateInfo | null;
}

let appVersion = '4.9.0';
let latestUpdateInfo: UpdateInfo | null = null;
let updateBusy = false;
let dismissedVersion: string | null = null;
let toastAutoHideTimer: number | null = null;
let sliderDragging = false;
let altOverride = false;
let lastKnownLockState: boolean | null = null;
let syncWin7OverlayFn: ((focusMenu?: boolean) => void) | null = null;
let tailPickerOpen = false;
let tailPickerStatusOverride: string | null = null;

const TAIL_MODE_LABELS: Record<TailKeyMode, string> = {
  smart: '智能第三只手',
  custom: '自定义按键',
  edge: '近尾边缘区',
  off: '仅摆动',
};

let settings: AppSettings = {
  x: null,
  y: null,
  scale: 1,
  alwaysOnTop: true,
  clickThroughLocked: false,
  showKeyBubbles: true,
  soundEnabled: true,
  autostart: false,
  catBreed: 'black',
  mcpEnabled: true,
  mcpPort: 27420,
  keyboardLayout: '65',
  keyboardOrientation: 'cat',
  privacyPasswordGuard: true,
  tailKeyMode: 'smart',
  tailKeyIds: [...DEFAULT_TAIL_KEY_IDS],
};

let catList: CatSkinConfig[] = [...DEFAULT_BUILTIN_CATS];

const canvas = document.getElementById('pet-canvas') as HTMLCanvasElement;
const menuEl = document.getElementById('context-menu') as HTMLDivElement;
const breedPillsEl = document.getElementById('breed-pills') as HTMLDivElement;
const scaleSliderEl = document.getElementById('scale-slider') as HTMLInputElement;
const scaleValueEl = document.getElementById('scale-value') as HTMLButtonElement;
const updateToastEl = document.getElementById('update-toast') as HTMLDivElement;
const updateToastTextEl = document.getElementById('update-toast-text') as HTMLSpanElement;
const btnToastInstallEl = document.getElementById('btn-toast-install') as HTMLButtonElement;
const btnToastOpenEl = document.getElementById('btn-toast-open') as HTMLButtonElement;
const btnToastCloseEl = document.getElementById('btn-toast-close') as HTMLButtonElement;
const tailPickerBarEl = document.getElementById('tail-picker-bar') as HTMLDivElement;
const tailPickerTitleEl = document.getElementById('tail-picker-title') as HTMLSpanElement;
const btnTailDoneEl = document.getElementById('btn-tail-done') as HTMLButtonElement;
const tailModeBadgeEl = document.getElementById('tail-mode-badge') as HTMLSpanElement;
const tailKeysCountEl = document.getElementById('tail-keys-count') as HTMLSpanElement;
const engine = new KuroCatEngine(canvas);

// 图片皮肤：id 以 "skin-" 开头的猫可能是图片皮肤，向后端取图；颜色皮肤取回为空，保持普通猫。
let spriteReq = 0;
// ───────── 拖动 ─────────
// 正常用系统原生拖动（startDragging）。个别环境（例如虚拟机）里原生拖动会立刻返回、窗口不动；
// 这时按住鼠标期间改用手动拖动：自己根据鼠标位移设置窗口位置。
let leftDown = false;
let lastOverCat = false;
let overCatLogs = 0;
let manualDrag: { sx: number; sy: number; wx: number; wy: number; lx: number; ly: number; raf: number } | null = null;

function endManualDrag(reason: string): void {
  const m = manualDrag;
  if (!m) return;
  manualDrag = null;
  if (m.raf) cancelAnimationFrame(m.raf);
  canvas.classList.remove('pet-dragging');
  engine.onMouseUp('left');
  void invoke('set_dragging', { dragging: false });
  void invoke('save_window_pos');
  logEvent('info', 'drag', `manual drag ended: ${reason}`);
}

async function beginManualDrag(sx: number, sy: number): Promise<void> {
  try {
    const p = await getCurrentWindow().outerPosition();
    manualDrag = { sx, sy, wx: p.x, wy: p.y, lx: sx, ly: sy, raf: 0 };
    logEvent('info', 'drag', `manual drag started at window (${p.x},${p.y})`);
  } catch (err) {
    logEvent('error', 'drag', `manual drag could not read window position: ${String(err)}`);
    canvas.classList.remove('pet-dragging');
    void invoke('set_dragging', { dragging: false });
  }
}

window.addEventListener('mousemove', (e) => {
  const m = manualDrag;
  if (!m) return;
  if ((e.buttons & 1) === 0) {
    endManualDrag('button released');
    return;
  }
  m.lx = e.screenX;
  m.ly = e.screenY;
  if (m.raf) return;
  m.raf = requestAnimationFrame(() => {
    m.raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const x = Math.round(m.wx + (m.lx - m.sx) * dpr);
    const y = Math.round(m.wy + (m.ly - m.sy) * dpr);
    void getCurrentWindow().setPosition(new PhysicalPosition(x, y));
  });
});
window.addEventListener('mouseup', () => {
  leftDown = false;
  endManualDrag('mouseup');
});
window.addEventListener('blur', () => endManualDrag('window blur'));

async function syncSpriteSkin(catId: string | undefined): Promise<void> {
  const req = ++spriteReq;
  const clear = (): void => {
    engine.setSpriteSkin(null);
    engine.setLayeredSkin(null);
    engine.setSkinAdjust({ scale: 1, dy: 0 });
  };
  if (!catId || !catId.startsWith('skin-')) {
    clear();
    return;
  }
  const skinId = catId.slice('skin-'.length);
  const loaded = await loadSkin(skinId);
  if (req !== spriteReq) return;
  clear();
  if (!loaded) return;
  engine.setSkinAdjust(getAdjust(skinId));
  if (loaded.kind === 'layered') engine.setLayeredSkin(loaded.skin);
  else engine.setSpriteSkin(loaded.skin);
}
let petFx: PetEffects | null = null;

function renderBreedPills(): void {
  if (!breedPillsEl) return;
  breedPillsEl.innerHTML = '';
  for (const cat of catList) {
    const btn = document.createElement('button');
    btn.className = 'breed-pill';
    btn.dataset.breed = cat.id;
    const emoji = cat.emoji ? `${cat.emoji} ` : '🐱 ';
    btn.textContent = `${emoji}${cat.name}`;
    const accent = cat.accentColor || (cat.id === 'ragdoll' ? '#7ac7ff' : '#c8f538');
    btn.style.setProperty('--pill-accent', accent);
    btn.classList.toggle('active', cat.id === settings.catBreed);
    breedPillsEl.appendChild(btn);
  }
}

function updateScaleSliderVisual(scaleVal: number): void {
  const pctNum = Math.round(Math.max(20, Math.min(150, scaleVal * 100)));
  if (scaleSliderEl) {
    scaleSliderEl.value = String(pctNum);
    const fillPct = ((pctNum - 20) / (150 - 20)) * 100;
    scaleSliderEl.style.setProperty('--pct', `${fillPct.toFixed(1)}%`);
  }
  if (scaleValueEl) {
    scaleValueEl.textContent = `${pctNum}%`;
  }
}

function syncMenuUI(): void {
  const setCheck = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.textContent = on ? '✓' : '';
  };
  setCheck('chk-privacy', settings.privacyPasswordGuard !== false);
  setCheck('chk-bubbles', settings.showKeyBubbles);
  setCheck('chk-lock', settings.clickThroughLocked);
  setCheck('chk-sound', settings.soundEnabled);
  setCheck('chk-top', settings.alwaysOnTop);
  setCheck('chk-autostart', settings.autostart);
  setCheck('chk-mcp', settings.mcpEnabled);

  if (!sliderDragging) {
    updateScaleSliderVisual(settings.scale);
  }

  const kbLayout: KeyboardLayoutId = settings.keyboardLayout === '108' ? '108' : '65';
  const kbOrient: KeyboardOrientation = settings.keyboardOrientation === 'viewer' ? 'viewer' : 'cat';
  const tailMode: TailKeyMode =
    settings.tailKeyMode === 'custom' ||
    settings.tailKeyMode === 'edge' ||
    settings.tailKeyMode === 'off'
      ? settings.tailKeyMode
      : 'smart';
  const tailIds = Array.isArray(settings.tailKeyIds) ? settings.tailKeyIds : [...DEFAULT_TAIL_KEY_IDS];

  document.querySelectorAll<HTMLButtonElement>('[data-kblayout]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.kblayout === kbLayout);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-kborient]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.kborient === kbOrient);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tailmode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tailmode === tailMode);
  });
  if (tailModeBadgeEl) {
    tailModeBadgeEl.textContent = TAIL_MODE_LABELS[tailMode];
  }
  if (tailKeysCountEl) {
    tailKeysCountEl.textContent = `${tailIds.length} 键`;
  }
  if (tailPickerTitleEl) {
    tailPickerTitleEl.textContent =
      tailPickerStatusOverride || `🐾 点键帽或敲键盘开关（已选 ${tailIds.length} 键）`;
  }

  const activeCat = catList.find((c) => c.id === settings.catBreed) ?? catList[0];
  renderBreedPills();

  const headerEl = document.getElementById('menu-header');
  if (headerEl && activeCat) {
    const emoji = activeCat.emoji || '🐱';
    headerEl.textContent = `${emoji} KuroCat ${activeCat.name}`;
    headerEl.style.color = activeCat.accentColor || '#c8f538';
  }

  engine.showKeyBubbles = settings.showKeyBubbles;
  engine.setCatAppearance(activeCat?.id || 'black', activeCat);
  void syncSpriteSkin(activeCat?.id);
  if (activeCat?.furColor) petFx?.setFurColor(activeCat.furColor);
  engine.setKeyboardConfig(kbLayout, kbOrient);
  engine.setTailKeyConfig(tailMode, tailIds);
  if (!sliderDragging) {
    engine.setRenderScale(settings.scale);
  }
  catAudio.setEnabled(settings.soundEnabled);
}

function syncWindowInteractiveState(): void {
  const open = !menuEl.classList.contains('hidden') || tailPickerOpen;
  void invoke('set_menu_open', { open });
}

function closeContextMenu(): void {
  if (!menuEl.classList.contains('hidden')) {
    menuEl.classList.add('hidden');
    syncWindowInteractiveState();
    syncWin7OverlayFn?.(false);
  }
  void invoke('close_context_menu');
}

function openContextMenu(_clientX: number, _clientY: number): void {
  // Always pop the dedicated non-overlapping side menu window beside the cat so it NEVER blocks the pet!
  if (!menuEl.classList.contains('hidden')) {
    menuEl.classList.add('hidden');
    syncWindowInteractiveState();
    syncWin7OverlayFn?.(false);
  }
  void invoke('open_context_menu');
}

function openTailPicker(): void {
  closeContextMenu();
  tailPickerOpen = true;
  tailPickerStatusOverride = null;
  tailPickerBarEl.classList.remove('hidden');
  engine.setTailPickerActive(true);
  syncWindowInteractiveState();
  if (settings.tailKeyMode !== 'custom') {
    void applySettingsPatch({ tailKeyMode: 'custom' });
  } else {
    syncMenuUI();
  }
  requestAnimationFrame(() => syncWin7OverlayFn?.(true));
}

function closeTailPicker(): void {
  if (!tailPickerOpen) return;
  tailPickerOpen = false;
  tailPickerStatusOverride = null;
  tailPickerBarEl.classList.add('hidden');
  canvas.classList.remove('tail-key-hover');
  engine.setTailPickerActive(false);
  syncWindowInteractiveState();
  syncWin7OverlayFn?.(false);
}

function toggleTailKeyId(specId: string, label?: string): void {
  const cur = Array.isArray(settings.tailKeyIds) ? [...settings.tailKeyIds] : [];
  const idx = cur.indexOf(specId);
  let added = false;
  if (idx >= 0) {
    cur.splice(idx, 1);
  } else {
    cur.push(specId);
    added = true;
  }
  const keyText = label || specId.toUpperCase();
  tailPickerStatusOverride = added
    ? `🐾 已加「${keyText}」· 共 ${cur.length} 键`
    : `🐾 已取消「${keyText}」· 共 ${cur.length} 键`;
  void applySettingsPatch({ tailKeyMode: 'custom', tailKeyIds: cur });
  if (added) {
    engine.previewTailTap(specId);
  }
}

function applyTailPreset(presetKey: string): void {
  let nextIds: string[] = [];
  let label = '已清空';
  if (presetKey === 'office') {
    nextIds = [...TAIL_KEY_PRESETS.office.ids];
    label = '预设：回车空格';
  } else if (presetKey === 'rightFn') {
    nextIds = [...TAIL_KEY_PRESETS.rightFn.ids];
    label = '预设：方向/小键盘';
  } else if (presetKey === 'edgeMods') {
    nextIds = [...TAIL_KEY_PRESETS.edgeMods.ids];
    label = '预设：外侧功能键';
  }
  tailPickerStatusOverride = `🐾 ${label}（${nextIds.length} 键）`;
  void applySettingsPatch({ tailKeyMode: 'custom', tailKeyIds: nextIds });
  if (nextIds.length > 0) {
    engine.previewTailTap(nextIds[0]);
  }
}

async function applySettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  syncMenuUI();
  settings = await invoke<AppSettings>('update_settings', { patch: settings });
  syncMenuUI();
}

async function copyMcpConfig(): Promise<void> {
  const hint = document.getElementById('mcp-copy-hint');
  try {
    const jsonText = await invoke<string>('get_mcp_config');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(jsonText);
    } else {
      const ta = document.createElement('textarea');
      ta.value = jsonText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (hint) {
      hint.textContent = '✓ 已复制';
      hint.classList.add('copied');
      setTimeout(() => {
        hint.textContent = 'AI 捏猫';
        hint.classList.remove('copied');
      }, 1800);
    }
  } catch (err) {
    console.error('Failed to copy MCP config:', err);
  }
}

async function createDesktopShortcut(): Promise<void> {
  const hint = document.getElementById('shortcut-hint');
  try {
    await invoke<string>('create_desktop_shortcut');
    if (hint) {
      hint.textContent = '✓ 已创建';
      hint.classList.add('copied');
      setTimeout(() => {
        hint.textContent = 'KuroCat';
        hint.classList.remove('copied');
      }, 1800);
    }
  } catch (err) {
    console.error('Failed to create desktop shortcut:', err);
  }
}

function setUpdateHint(text: string, mode: 'default' | 'ready' | 'error' = 'default'): void {
  const hint = document.getElementById('update-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.remove('update-ready', 'update-error');
  if (mode === 'ready') hint.classList.add('update-ready');
  else if (mode === 'error') hint.classList.add('update-error');
}

function hideUpdateToast(): void {
  if (toastAutoHideTimer !== null) {
    window.clearTimeout(toastAutoHideTimer);
    toastAutoHideTimer = null;
  }
  if (!updateToastEl.classList.contains('hidden')) {
    updateToastEl.classList.add('hidden');
    void invoke('set_update_banner_open', { open: false });
    syncWin7OverlayFn?.(false);
  }
}

function showUpdateToast(
  text: string,
  options: { showInstall?: boolean; showOpen?: boolean; autoHideMs?: number; busy?: boolean } = {},
): void {
  if (toastAutoHideTimer !== null) {
    window.clearTimeout(toastAutoHideTimer);
    toastAutoHideTimer = null;
  }
  updateToastTextEl.textContent = text;
  btnToastInstallEl.classList.toggle('hidden', !options.showInstall);
  btnToastInstallEl.disabled = Boolean(options.busy);
  btnToastOpenEl.classList.toggle('hidden', !options.showOpen);
  updateToastEl.classList.remove('hidden');
  void invoke('set_update_banner_open', { open: true });
  requestAnimationFrame(() => syncWin7OverlayFn?.(false));

  if (options.autoHideMs && options.autoHideMs > 0) {
    toastAutoHideTimer = window.setTimeout(() => {
      hideUpdateToast();
    }, options.autoHideMs);
  }
}

function handleUpdateProgressEvent(ev: UpdateProgressEvent, fromManual = false): void {
  if (ev.info) {
    latestUpdateInfo = ev.info;
    appVersion = ev.info.currentVersion || appVersion;
  }

  switch (ev.stage) {
    case 'checking':
      updateBusy = true;
      setUpdateHint('检测中...');
      showUpdateToast('🔍 正在检查新版本...', { busy: true });
      break;
    case 'available':
      updateBusy = false;
      if (latestUpdateInfo?.hasUpdate) {
        const ver = latestUpdateInfo.latestVersion;
        setUpdateHint(`⬆ v${ver}`, 'ready');
        if (fromManual || dismissedVersion !== ver) {
          showUpdateToast(`✨ 发现新版本 v${ver}`, {
            showInstall: Boolean(latestUpdateInfo.downloadUrl),
            showOpen: !latestUpdateInfo.downloadUrl,
          });
        }
      }
      break;
    case 'up_to_date':
      updateBusy = false;
      setUpdateHint(`✓ v${appVersion}`);
      showUpdateToast(`✓ 已是最新版本 v${appVersion}`, { autoHideMs: 2600 });
      break;
    case 'downloading':
    case 'verifying':
    case 'installing':
      updateBusy = true;
      setUpdateHint('更新中...', 'ready');
      showUpdateToast(`⏳ ${ev.message}`, { busy: true });
      break;
    case 'error':
      updateBusy = false;
      setUpdateHint('检查失败', 'error');
      showUpdateToast(`⚠ ${ev.message}`, {
        showOpen: true,
        autoHideMs: 5200,
      });
      break;
  }
}

async function triggerInstallUpdate(): Promise<void> {
  if (updateBusy || !latestUpdateInfo || !latestUpdateInfo.hasUpdate) return;
  updateBusy = true;
  closeContextMenu();
  showUpdateToast(`⏳ 正在下载 v${latestUpdateInfo.latestVersion}...`, { busy: true });
  setUpdateHint('下载中...', 'ready');
  try {
    await invoke('install_update', { info: latestUpdateInfo });
  } catch (err) {
    updateBusy = false;
    const msg = typeof err === 'string' ? err : String(err);
    setUpdateHint('更新失败', 'error');
    showUpdateToast(`⚠ ${msg}`, { showOpen: true, autoHideMs: 6500 });
  }
}

async function triggerManualUpdateCheck(): Promise<void> {
  if (updateBusy) return;
  // If we already know an update is ready, clicking the menu item immediately starts installing it!
  if (latestUpdateInfo?.hasUpdate && latestUpdateInfo.downloadUrl) {
    await triggerInstallUpdate();
    return;
  }
  updateBusy = true;
  setUpdateHint('检测中...');
  closeContextMenu();
  showUpdateToast('🔍 正在检查新版本...', { busy: true });
  try {
    const info = await invoke<UpdateInfo>('check_for_update');
    handleUpdateProgressEvent(
      {
        stage: info.hasUpdate ? 'available' : 'up_to_date',
        message: info.hasUpdate
          ? `发现新版本 v${info.latestVersion}`
          : `已是最新版本 v${info.currentVersion}`,
        info,
      },
      true,
    );
  } catch (err) {
    const msg = typeof err === 'string' ? err : String(err);
    handleUpdateProgressEvent({ stage: 'error', message: msg, info: null }, true);
  }
}

/** 宠物玩法：监听后端事件，驱动效果层、猫的小反应与声音。 */
async function initPet(): Promise<void> {
  try {
    setLang((await pet.getSettings()).language);
  } catch (err) {
    console.error('pet module unavailable:', err);
    return;
  }
  const fx = new PetEffects(engine);
  petFx = fx;
  const activeCat = catList.find((c) => c.id === settings.catBreed) ?? catList[0];
  if (activeCat?.furColor) fx.setFurColor(activeCat.furColor);

  let lastPhase: FocusPhase = 'idle';
  // 专注时猫「变淡」：只在阶段变化或设置变化时应用；提醒弹出时临时恢复不透明（见 kuro-reminder）。
  let focusView: PetSettings['focusView'] = 'normal';
  const applyDim = () => {
    canvas.style.opacity = focusView === 'dim' && lastPhase === 'focus' ? '0.35' : '';
  };
  const onStatus = (st: PetStatus) => {
    fx.setFocus(st.phase, st.remaining);
    if (st.phase !== lastPhase) {
      if (lastPhase === 'idle' && st.phase === 'focus') fx.showBubble(t('bubble.focusStart'), 2200);
      else if (lastPhase === 'focus' && st.phase === 'break') fx.showBubble(t('bubble.breakStart'), 2600);
      else if (lastPhase === 'break' && st.phase === 'idle') fx.showBubble(t('bubble.breakEnd'), 2000);
      lastPhase = st.phase;
      applyDim();
    }
    fx.setCafe(st.cafe);
  };
  try {
    onStatus(await pet.status());
  } catch {
    /* 忽略：下一秒的事件会补上 */
  }

  try {
    focusView = (await pet.getSettings()).focusView ?? 'normal';
    applyDim();
  } catch {
    /* 取不到就保持正常显示 */
  }
  await listen<PetSettings>('kuro-pet-settings', (ev) => {
    setLang(ev.payload.language);
    focusView = ev.payload.focusView ?? 'normal';
    applyDim();
  });
  await listen<PetStatus>('kuro-focus', (ev) => onStatus(ev.payload));
  await listen<{ on: boolean }>('kuro-cafe', (ev) => fx.setCafe(ev.payload.on));
  await listen<{ granted: number }>('kuro-focus-done', (ev) => {
    if (ev.payload.granted > 0) fx.showBubble(t('bubble.focusDone', { n: ev.payload.granted }), 3000);
    engine.petReact('happy', 2200);
  });
  await listen<{ id: 'churu' | 'canned' }>('kuro-snack', (ev) => {
    fx.playSnack(ev.payload.id);
    fx.showBubble(t(`bubble.snack.${ev.payload.id}`), 2200);
  });
  await listen<{ kind: 'created' | 'delete' }>('kuro-fileop', (ev) => {
    if (engine.privacyMode) return;
    fx.showBubble(t(`bubble.${ev.payload.kind}`), 1800);
    engine.petReact(ev.payload.kind === 'created' ? 'tilt' : 'ears');
  });
  await listen<ReminderEvent>('kuro-reminder', (ev) => {
    const r = ev.payload;
    const text = r.message || t(`tasks.msg.${r.id}`);
    fx.showBubble(text === `tasks.msg.${r.id}` ? r.name || r.id : text, 15000);
    engine.petReact('ears');
    canvas.style.opacity = ''; // 变淡模式下，提醒弹出时先恢复不透明
    if (r.sound) playChime();
  });
  await listen<{ count: number; volume: number }>('kuro-meow', (ev) => {
    const n = Math.max(1, Math.min(3, ev.payload.count));
    for (let i = 0; i < n; i++) {
      window.setTimeout(() => {
        fx.showBubble(t('bubble.meow'), 1400);
        engine.petReact('ears');
        void playMeow(ev.payload.volume).catch(() => {});
      }, i * 900);
    }
  });
  await listen<{ seconds: number }>('kuro-shutdown-warning', (ev) => {
    fx.showBubble(t('bubble.shutdown', { s: ev.payload.seconds }), 10000);
    engine.petReact('ears');
  });
}

async function bootstrap(): Promise<void> {
  engine.start();
  void initPet();

  // Hide Windows-only desktop shortcut button on macOS
  if (/Mac/i.test(navigator.platform) || /Macintosh/i.test(navigator.userAgent)) {
    const shortcutBtn = document.getElementById('btn-desktop-shortcut');
    if (shortcutBtn) shortcutBtn.style.display = 'none';
  }

  try {
    const [loadedSettings, loadedCats, loadedVer] = await Promise.all([
      invoke<AppSettings>('get_settings'),
      invoke<CatSkinConfig[]>('get_cats'),
      invoke<string>('get_app_version'),
    ]);
    settings = loadedSettings;
    lastKnownLockState = settings.clickThroughLocked;
    if (Array.isArray(loadedCats) && loadedCats.length > 0) {
      catList = loadedCats;
    }
    if (loadedVer) {
      appVersion = loadedVer;
      setUpdateHint(`v${appVersion}`);
    }
    syncMenuUI();
  } catch (err) {
    console.error('Failed to load settings or cats:', err);
  }

  await listen<UpdateProgressEvent>('kuro-update-status', (ev) => {
    handleUpdateProgressEvent(ev.payload, false);
  });

  btnToastInstallEl.addEventListener('click', (e) => {
    e.stopPropagation();
    void triggerInstallUpdate();
  });

  btnToastOpenEl.addEventListener('click', (e) => {
    e.stopPropagation();
    // 二次开发版：只打开更新检查返回的链接，不再回退到上游仓库地址
    const url = latestUpdateInfo?.releaseUrl;
    if (url) void invoke('open_release_page', { url });
  });

  btnToastCloseEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (latestUpdateInfo?.hasUpdate) {
      dismissedVersion = latestUpdateInfo.latestVersion;
    }
    hideUpdateToast();
  });

  if (scaleSliderEl) {
    scaleSliderEl.addEventListener('pointerdown', () => {
      sliderDragging = true;
    });
    scaleSliderEl.addEventListener('input', () => {
      sliderDragging = true;
      const nextScale = Math.max(0.2, Math.min(1.5, Number(scaleSliderEl.value) / 100));
      updateScaleSliderVisual(nextScale);
      engine.setRenderScale(nextScale);
    });
    const commitSliderScale = () => {
      sliderDragging = false;
      const nextScale = Math.max(0.2, Math.min(1.5, Number(scaleSliderEl.value) / 100));
      void applySettingsPatch({ scale: nextScale });
    };
    scaleSliderEl.addEventListener('change', commitSliderScale);
    scaleSliderEl.addEventListener('pointerup', () => {
      sliderDragging = false;
    });
  }

  if (scaleValueEl) {
    scaleValueEl.addEventListener('click', (e) => {
      e.stopPropagation();
      sliderDragging = false;
      updateScaleSliderVisual(1.0);
      void applySettingsPatch({ scale: 1.0 });
    });
  }

  await listen<AppSettings>('kuro-settings', (ev) => {
    const prevLock = lastKnownLockState;
    settings = ev.payload;
    lastKnownLockState = settings.clickThroughLocked;
    syncMenuUI();
    if (prevLock !== null && prevLock !== settings.clickThroughLocked) {
      if (settings.clickThroughLocked) {
        showUpdateToast('🔒 已锁定穿透（按住 Alt 点击或 ^ 托盘解锁）', { autoHideMs: 4200 });
      } else {
        showUpdateToast('🔓 已解除穿透，可直接拖动或右键', { autoHideMs: 2200 });
      }
    }
  });

  await listen<CatSkinConfig[]>('kuro-cats', (ev) => {
    if (Array.isArray(ev.payload) && ev.payload.length > 0) {
      catList = ev.payload;
      syncMenuUI();
    }
  });

  await listen('kuro-skins-changed', () => {
    clearSkinCache();
    void syncSpriteSkin(settings.catBreed);
  });

  // 设置窗口里调整了某个皮肤的缩放/偏移（同源 localStorage 的 storage 事件）
  window.addEventListener('storage', (ev) => {
    if (ev.key === ADJUST_STORAGE_KEY || ev.key === null) void syncSpriteSkin(settings.catBreed);
  });

  await listen('kuro-open-tail-picker', () => {
    openTailPicker();
  });

  await listen<number>('kuro-scale-preview', (ev) => {
    if (typeof ev.payload === 'number' && Number.isFinite(ev.payload)) {
      engine.setRenderScale(Math.max(0.2, Math.min(1.5, ev.payload)));
    }
  });

  btnTailDoneEl.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTailPicker();
  });

  tailPickerBarEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tailpreset]');
    if (!btn) return;
    e.stopPropagation();
    const preset = btn.dataset.tailpreset;
    if (preset) applyTailPreset(preset);
  });

  await listen<InputEvent>('kuro-input', (ev) => {
    const p = ev.payload;
    switch (p.kind) {
      case 'keyDown':
        if (tailPickerOpen) {
          if (!p.repeat) {
            const spec = resolveKeyByVk(p.vk, settings.keyboardLayout);
            if (spec) {
              toggleTailKeyId(spec.id, spec.bubble || spec.label);
            }
          }
          break;
        }
        engine.onKeyDown(p.vk, p.repeat);
        break;
      case 'keyUp':
        if (!tailPickerOpen) {
          engine.onKeyUp(p.vk);
        }
        break;
      case 'mouseMove':
        engine.onGlobalMouseMove(p.nx, p.ny);
        break;
      case 'mouseDown':
        engine.onMouseDown(p.button);
        break;
      case 'mouseUp':
        engine.onMouseUp(p.button);
        break;
      case 'mouseWheel':
        engine.onMouseWheel();
        break;
      case 'privacyTyping':
        engine.onPrivacyTyping();
        break;
    }
  });

  await listen<boolean>('kuro-privacy', (ev) => {
    engine.setPrivacyMode(Boolean(ev.payload));
  });

  await listen<WindowCursorInfo>('kuro-cursor', (ev) => {
    const c = ev.payload;
    altOverride = Boolean(c.altOverride);
    engine.onWindowCursor(c.relX, c.relY, c.overCat);
    if (c.overCat !== lastOverCat) {
      lastOverCat = c.overCat;
      if (overCatLogs++ < 60) logEvent('info', 'cursor', `over cat -> ${c.overCat}`);
    }
    const interactive = !settings.clickThroughLocked || altOverride;
    canvas.classList.toggle('pet-hover', c.overCat && interactive);
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!tailPickerOpen) return;
    const hit = engine.hitTestKeyAtClientPoint(e.clientX, e.clientY);
    engine.setTailPickerHover(hit ? hit.id : null);
    canvas.classList.toggle('tail-key-hover', Boolean(hit));
  });

  canvas.addEventListener('mouseleave', () => {
    if (!tailPickerOpen) return;
    engine.setTailPickerHover(null);
    canvas.classList.remove('tail-key-hover');
  });

  // Left-click keycap toggle in tail-picker mode, OR drag to reposition transparent window
  canvas.addEventListener('mousedown', async (e) => {
    if (e.button === 0) {
      closeContextMenu();
      if (tailPickerOpen) {
        const hit = engine.hitTestKeyAtClientPoint(e.clientX, e.clientY);
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          toggleTailKeyId(hit.id, hit.bubble || hit.label);
          return;
        }
      }
      if (settings.clickThroughLocked && !altOverride && !e.altKey) {
        logEvent('info', 'drag', 'mousedown ignored: click-through is locked');
        return;
      }
      logEvent('info', 'drag', `mousedown: over_cat=${lastOverCat} screen=(${e.screenX},${e.screenY}) dpr=${window.devicePixelRatio}`);
      leftDown = true;
      canvas.classList.add('pet-dragging');
      void invoke('set_dragging', { dragging: true });
      const t0 = performance.now();
      let nativeFailed = false;
      let manual = false;
      try {
        await getCurrentWindow().startDragging();
      } catch (err) {
        nativeFailed = true;
        logEvent('error', 'drag', `startDragging failed: ${String(err)}`);
      }
      try {
        const dt = Math.round(performance.now() - t0);
        logEvent('info', 'drag', `startDragging returned after ${dt}ms${nativeFailed ? ' (failed)' : ''}; button still down=${leftDown}`);
        if ((nativeFailed || dt < 150) && leftDown) {
          manual = true;
          await beginManualDrag(e.screenX, e.screenY);
        }
      } finally {
        if (!manual || !manualDrag) {
          canvas.classList.remove('pet-dragging');
          engine.onMouseUp('left');
          void invoke('set_dragging', { dragging: false });
          void invoke('save_window_pos');
        }
      }
    }
  });

  // Right-click opens sleek dark glass settings menu
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (tailPickerOpen) {
      closeTailPicker();
    }
    if (settings.clickThroughLocked && !altOverride && !e.altKey) return;
    openContextMenu(e.clientX, e.clientY);
  });

  // Side menu window auto-closes on its own focus loss; do NOT close on main blur (clicking the menu blurs main!)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tailPickerOpen) closeContextMenu();
  });

  menuEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-action], [data-scale], [data-breed], [data-kblayout], [data-kborient], [data-tailmode]',
    );
    if (!target) return;

    const kbLayoutAttr = target.dataset.kblayout;
    if (kbLayoutAttr === '65' || kbLayoutAttr === '108') {
      void applySettingsPatch({ keyboardLayout: kbLayoutAttr });
      closeContextMenu();
      return;
    }

    const kbOrientAttr = target.dataset.kborient;
    if (kbOrientAttr === 'cat' || kbOrientAttr === 'viewer') {
      void applySettingsPatch({ keyboardOrientation: kbOrientAttr });
      closeContextMenu();
      return;
    }

    const tailModeAttr = target.dataset.tailmode;
    if (
      tailModeAttr === 'smart' ||
      tailModeAttr === 'custom' ||
      tailModeAttr === 'edge' ||
      tailModeAttr === 'off'
    ) {
      void applySettingsPatch({ tailKeyMode: tailModeAttr });
      return;
    }

    const breedAttr = target.dataset.breed;
    if (breedAttr) {
      void applySettingsPatch({ catBreed: breedAttr });
      closeContextMenu();
      return;
    }

    const scaleAttr = target.dataset.scale;
    if (scaleAttr) {
      void applySettingsPatch({ scale: Number(scaleAttr) });
      closeContextMenu();
      return;
    }

    switch (target.dataset.action) {
      case 'toggle-privacy':
        void applySettingsPatch({ privacyPasswordGuard: !(settings.privacyPasswordGuard !== false) });
        break;
      case 'toggle-bubbles':
        void applySettingsPatch({ showKeyBubbles: !settings.showKeyBubbles });
        break;
      case 'toggle-lock':
        void applySettingsPatch({ clickThroughLocked: !settings.clickThroughLocked });
        closeContextMenu();
        break;
      case 'toggle-sound':
        void applySettingsPatch({ soundEnabled: !settings.soundEnabled });
        break;
      case 'toggle-top':
        void applySettingsPatch({ alwaysOnTop: !settings.alwaysOnTop });
        break;
      case 'toggle-autostart':
        void applySettingsPatch({ autostart: !settings.autostart });
        break;
      case 'toggle-mcp':
        void applySettingsPatch({ mcpEnabled: !settings.mcpEnabled });
        break;
      case 'copy-mcp':
        void copyMcpConfig();
        break;
      case 'desktop-shortcut':
        void createDesktopShortcut();
        break;
      case 'check-update':
        void triggerManualUpdateCheck();
        break;
      case 'open-tail-picker':
        openTailPicker();
        break;
      case 'reset-pos':
        void invoke('reset_position');
        closeContextMenu();
        break;
      case 'quit':
        void invoke('quit_app');
        break;
    }
  });

  // On Windows 7/8 (where Microsoft WebView2 does not support DirectComposition alpha),
  // stream the live 2D Canvas RGBA pixels via zero-copy binary IPC to a native Win32
  // UpdateLayeredWindow(ULW_ALPHA) presenter window for true 256-level per-pixel anti-aliased
  // transparency (zero white box, zero jagged edges) on both Aero and Win7 Basic desktops.
  try {
    const useWin7Ulw = await invoke<boolean>('is_win7_ulw_mode');
    if (useWin7Ulw) {
      document.documentElement.classList.add('win7-ulw-mode');
      const petCtx = canvas.getContext('2d');
      let win7Visible = true;
      let frameBusy = false;
      let lastPresentMs = 0;
      let lastFrameKey = '';
      let lastOverlayKey = '';

      const syncWin7Overlay = (focusMenu = false) => {
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        const physW = Math.max(1, Math.round(window.innerWidth * dpr));
        const physH = Math.max(1, Math.round(window.innerHeight * dpr));
        const rects: number[] = [];

        if (menuEl && !menuEl.classList.contains('hidden')) {
          const r = menuEl.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            rects.push(
              Math.max(0, Math.floor(r.left * dpr)),
              Math.max(0, Math.floor(r.top * dpr)),
              Math.min(physW, Math.ceil(r.right * dpr)),
              Math.min(physH, Math.ceil(r.bottom * dpr)),
              Math.round(12 * dpr),
            );
          }
        }
        if (tailPickerBarEl && !tailPickerBarEl.classList.contains('hidden')) {
          const r = tailPickerBarEl.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            rects.push(
              Math.max(0, Math.floor(r.left * dpr)),
              Math.max(0, Math.floor(r.top * dpr)),
              Math.min(physW, Math.ceil(r.right * dpr)),
              Math.min(physH, Math.ceil(r.bottom * dpr)),
              Math.round(13 * dpr),
            );
          }
        }
        if (updateToastEl && !updateToastEl.classList.contains('hidden')) {
          const r = updateToastEl.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            const top = Math.max(0, Math.floor(r.top * dpr));
            const bot = Math.min(physH, Math.ceil(r.bottom * dpr));
            rects.push(
              Math.max(0, Math.floor(r.left * dpr)),
              top,
              Math.min(physW, Math.ceil(r.right * dpr)),
              bot,
              Math.max(8, Math.round((bot - top) / 2)),
            );
          }
        }

        const key = rects.join(',');
        if (!focusMenu && key === lastOverlayKey) return;
        lastOverlayKey = key;
        void invoke('win7_sync_overlay', { rects, focusMenu });
      };
      syncWin7OverlayFn = syncWin7Overlay;

      await listen<{ x: number; y: number }>('kuro-win7-contextmenu', (ev) => {
        openContextMenu(ev.payload.x, ev.payload.y);
      });
      await listen('kuro-win7-close-menu', () => {
        closeContextMenu();
      });
      await listen<boolean>('kuro-win7-visibility', (ev) => {
        win7Visible = Boolean(ev.payload);
        if (win7Visible) {
          lastFrameKey = '';
        }
      });

      const presentWin7Frame = () => {
        if (!win7Visible || frameBusy || !petCtx) return;
        const now = performance.now();
        if (now - lastPresentMs < 28) return;
        const w = canvas.width;
        const h = canvas.height;
        if (w < 8 || h < 8) return;

        const imgData = petCtx.getImageData(0, 0, w, h);
        const u32 = new Uint32Array(
          imgData.data.buffer,
          imgData.data.byteOffset,
          imgData.data.byteLength >>> 2,
        );
        let hash = 2166136261 >>> 0;
        hash = Math.imul(hash ^ w, 16777619) >>> 0;
        hash = Math.imul(hash ^ h, 16777619) >>> 0;
        for (let i = 0; i < u32.length; i++) {
          hash = Math.imul(hash ^ u32[i], 16777619) >>> 0;
        }
        const key = `${w}x${h}:${hash}`;
        if (key === lastFrameKey) return;

        lastFrameKey = key;
        lastPresentMs = now;
        frameBusy = true;
        const payload = new Uint8Array(
          imgData.data.buffer,
          imgData.data.byteOffset,
          imgData.data.byteLength,
        );
        void invoke('win7_present_frame', payload, {
          headers: { 'x-w': String(w), 'x-h': String(h) },
        }).finally(() => {
          frameBusy = false;
        });
      };

      engine.onAfterRender = presentWin7Frame;
      // Kick initial presentation immediately & keep overlay bounds in sync if toast/menu resizes
      setTimeout(presentWin7Frame, 30);
      setInterval(() => syncWin7Overlay(false), 200);
    }
  } catch {
    // Non-Win7 or unsupported: keep native transparency untouched
  }
}

void bootstrap();
