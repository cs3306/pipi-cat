// 设置窗口（独立普通窗口，可聚焦、可输入）。
// 所有设置即时保存：pet.json 由后端 pet_update_settings 写入，提醒任务由 tasks_save 写入。
// 原有的外观/键盘/缩放等设置仍在猫的右键菜单与托盘菜单里（未迁移，避免与上游冲突）。

import { listen } from '@tauri-apps/api/event';
import { getLang, setLang, t } from './i18n';
import {
  errText,
  pet,
  type OverrideStatus,
  type PetSettings,
  type PetStatus,
  type ShutdownStatus,
  type SkinSummary,
  type SnackInfo,
  type TaskDto,
} from './petBridge';
import { reloadCustomMeows, playMeow } from './meowAudio';
import { getAdjust, setAdjust } from './skinAdjust';
import { installErrorLogging, logEvent } from './applog';

installErrorLogging('settings');

type TabId = 'general' | 'focus' | 'tasks' | 'skins' | 'shutdown' | 'sound' | 'privacy' | 'about';
const TAB_ORDER: TabId[] = ['general', 'focus', 'tasks', 'skins', 'shutdown', 'sound', 'privacy', 'about'];

let settings: PetSettings;
let status: PetStatus | null = null;
let tasks: TaskDto[] = [];
let snacks: SnackInfo[] = [];
let shutdown: ShutdownStatus = { scheduled: false };
let skinList: SkinSummary[] = [];
let overrideList: OverrideStatus[] = [];
let pendingSkin: { json: string; summary: SkinSummary } | null = null;
let tab: TabId = 'general';
let timer: number | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ───────── 小工具 ─────────
type Child = Node | string;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) el.append(c);
  return el;
}

function toast(text: string, err = false): void {
  if (err) logEvent('error', 'settings', text);
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('err', err);
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), err ? 4000 : 1200);
}

let saveTimer: number | null = null;
function saveSettingsSoon(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      settings = await pet.updateSettings(settings);
      toast(t('tasks.saved'));
    } catch (e) {
      toast(errText(e), true);
    }
  }, 350);
}

let taskSaveTimer: number | null = null;
function saveTasksSoon(): void {
  if (taskSaveTimer !== null) window.clearTimeout(taskSaveTimer);
  taskSaveTimer = window.setTimeout(async () => {
    try {
      await pet.tasksSave(tasks);
      toast(t('tasks.saved'));
    } catch (e) {
      toast(t('tasks.error', { e: errText(e) }), true);
    }
  }, 500);
}

function check<K extends keyof PetSettings>(key: K, label: string): HTMLElement {
  const input = h('input', { type: 'checkbox', id: `c-${key}` }) as HTMLInputElement;
  input.checked = Boolean(settings[key]);
  input.addEventListener('change', () => {
    (settings[key] as unknown as boolean) = input.checked;
    saveSettingsSoon();
  });
  return h('div', { class: 'row' }, h('label', { for: `c-${key}` }, label), input);
}

function num<K extends keyof PetSettings>(key: K, label: string, min: number, max: number, unit = ''): HTMLElement {
  const input = h('input', { type: 'number', min, max, id: `n-${key}` }) as HTMLInputElement;
  input.value = String(settings[key]);
  input.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(input.value) || min)));
    input.value = String(v);
    (settings[key] as unknown as number) = v;
    saveSettingsSoon();
  });
  return h('div', { class: 'row' }, h('label', { for: `n-${key}` }, label), input, unit ? h('span', { class: 'muted' }, unit) : '');
}

function minuteToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function timeToMinute(v: string): number {
  const [hh, mm] = v.split(':').map((x) => Number(x));
  return Math.max(0, Math.min(1439, (hh || 0) * 60 + (mm || 0)));
}

// ───────── 各页签 ─────────
function pageGeneral(): HTMLElement[] {
  const sel = h('select', { id: 'lang' }) as HTMLSelectElement;
  for (const [v, label] of [
    ['auto', t('general.language.auto')],
    ['zh', '中文'],
    ['en', 'English'],
  ] as const) {
    const o = h('option', { value: v }, label) as HTMLOptionElement;
    o.selected = settings.language === v;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    settings.language = sel.value as PetSettings['language'];
    setLang(settings.language);
    try {
      settings = await pet.updateSettings(settings);
    } catch (e) {
      toast(errText(e), true);
    }
    renderAll();
  });
  return [
    h('h1', {}, t('tab.general')),
    h('div', { class: 'row' }, h('label', { for: 'lang' }, t('general.language')), sel),
    h('p', { class: 'desc' }, t('general.note')),
  ];
}

function focusLabel(): string {
  return status ? t(`focus.state.${status.phase}`) : '';
}

function pageFocus(): HTMLElement[] {
  const active = !!status && status.phase !== 'idle';
  const startBtn = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        try {
          status = active ? await pet.focusCancel() : await pet.focusStart();
          renderAll();
        } catch (e) {
          toast(errText(e), true);
        }
      },
    },
    active ? t('focus.stop') : t('focus.start'),
  );
  const statusEl = h('div', { class: 'status', id: 'focus-status' });
  const shop = h('div', { class: 'card' }, h('h2', {}, `${t('focus.shop')} · 🪙 ${status?.coins ?? 0}`));
  for (const s of snacks) {
    shop.append(
      h(
        'div',
        { class: 'row' },
        h('label', {}, `${t(`snack.${s.id}`)}  (${s.price} ${t('common.coins')})`),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                await pet.buySnack(s.id);
                status = await pet.status();
                renderAll();
              } catch (e) {
                const m = errText(e);
                toast(m.startsWith('insufficient-coins:') ? t('snack.insufficient', { n: m.split(':')[1] }) : m, true);
              }
            },
          },
          t('focus.buy'),
        ),
      ),
    );
  }
  const page = [
    h('h1', {}, t('focus.title')),
    h('p', { class: 'desc' }, t('focus.desc')),
    h('div', { class: 'row' }, startBtn, statusEl),
    num('focusMinutes', t('focus.minutes'), 1, 180, t('common.minutes')),
    num('breakMinutes', t('focus.break'), 1, 60, t('common.minutes')),
    num('rewardPerSession', t('focus.reward'), 0, 1000, t('common.coins')),
    num('idleThresholdSecs', t('focus.idle'), 5, 600, t('common.seconds')),
    focusViewRow(),
    check('cafeEnabled', t('focus.cafe')),
    check('muteFileReactionsInFocus', t('focus.muteFile')),
    shop,
  ];
  updateFocusStatus(statusEl);
  return page;
}

function focusViewRow(): HTMLElement {
  const sel = h('select', { id: 'focus-view' }) as HTMLSelectElement;
  for (const v of ['normal', 'dim', 'hidden'] as const) {
    const o = h('option', { value: v }, t(`focus.view.${v}`)) as HTMLOptionElement;
    o.selected = settings.focusView === v;
    sel.append(o);
  }
  sel.addEventListener('change', () => {
    settings.focusView = sel.value as PetSettings['focusView'];
    saveSettingsSoon();
  });
  return h('div', {},
    h('div', { class: 'row' }, h('label', { for: 'focus-view' }, t('focus.view')), sel),
    h('p', { class: 'desc' }, t('focus.viewHint')));
}

function updateFocusStatus(el?: HTMLElement): void {
  const target = el ?? document.getElementById('focus-status');
  if (!target || !status) return;
  const m = Math.floor(status.remaining / 60);
  const s = status.remaining % 60;
  target.textContent = `${focusLabel()}${status.phase !== 'idle' ? `  ${m}:${String(s).padStart(2, '0')}` : ''}  ·  🪙 ${status.coins}`;
}

function taskRowBuiltin(task: TaskDto): HTMLElement {
  const en = h('input', { type: 'checkbox', id: `t-${task.id}` }) as HTMLInputElement;
  en.checked = task.enabled;
  en.addEventListener('change', () => {
    task.enabled = en.checked;
    saveTasksSoon();
  });
  const everyInput = h('input', { type: 'number', min: 1, max: 600 }) as HTMLInputElement;
  everyInput.value = String(task.everyMinutes);
  everyInput.addEventListener('change', () => {
    task.everyMinutes = Math.max(task.kind === 'sedentary' ? 5 : 1, Math.min(600, Math.round(Number(everyInput.value) || 1)));
    everyInput.value = String(task.everyMinutes);
    saveTasksSoon();
  });
  const sound = h('input', { type: 'checkbox', id: `ts-${task.id}` }) as HTMLInputElement;
  sound.checked = task.sound;
  sound.addEventListener('change', () => {
    task.sound = sound.checked;
    saveTasksSoon();
  });
  const hint =
    task.kind === 'sedentary'
      ? t('tasks.sitHint', { n: task.everyMinutes, m: task.awayMinutes })
      : t('tasks.everyHint', { n: task.everyMinutes });
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, h('label', { for: `t-${task.id}` }, t(`tasks.${task.id}`)), en),
    h('div', { class: 'row' }, h('label', {}, t('tasks.every')), everyInput, h('span', { class: 'muted' }, hint)),
    h('div', { class: 'row' }, h('label', { for: `ts-${task.id}` }, t('tasks.sound')), sound),
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function toLocalInput(epochSecs: number): string {
  const d = new Date(epochSecs * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function taskRowCustom(task: TaskDto): HTMLElement {
  const bind = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(el: T, fn: (v: T) => void): T => {
    el.addEventListener('change', () => {
      fn(el);
      saveTasksSoon();
    });
    return el;
  };
  const name = bind(h('input', { type: 'text', maxlength: 40 }) as HTMLInputElement, (e) => (task.name = e.value.trim().slice(0, 40)));
  name.value = task.name;
  const msg = bind(h('input', { type: 'text', maxlength: 200 }) as HTMLInputElement, (e) => (task.message = e.value));
  msg.value = task.message;
  const kind = bind(h('select') as HTMLSelectElement, (e) => {
    task.kind = e.value as TaskDto['kind'];
    renderAll();
  });
  for (const k of ['interval', 'daily', 'weekly', 'once'] as const) {
    const o = h('option', { value: k }, t(`tasks.kind.${k}`)) as HTMLOptionElement;
    o.selected = task.kind === k;
    kind.append(o);
  }
  const en = bind(h('input', { type: 'checkbox' }) as HTMLInputElement, (e) => (task.enabled = e.checked));
  en.checked = task.enabled;
  const sound = bind(h('input', { type: 'checkbox' }) as HTMLInputElement, (e) => (task.sound = e.checked));
  sound.checked = task.sound;

  const rows: HTMLElement[] = [
    h('div', { class: 'row' }, h('label', {}, t('tasks.name')), name, en),
    h('div', { class: 'row' }, h('label', {}, t('tasks.message')), msg),
    h('div', { class: 'row' }, h('label', {}, t('tasks.kind')), kind),
  ];
  if (task.kind === 'interval') {
    const every = bind(h('input', { type: 'number', min: 1, max: 1440 }) as HTMLInputElement, (e) => {
      task.everyMinutes = Math.max(1, Math.min(1440, Math.round(Number(e.value) || 1)));
      e.value = String(task.everyMinutes);
    });
    every.value = String(task.everyMinutes);
    rows.push(h('div', { class: 'row' }, h('label', {}, t('tasks.every')), every));
  } else if (task.kind === 'once') {
    const at = bind(h('input', { type: 'datetime-local' }) as HTMLInputElement, (e) => {
      const ms = new Date(e.value).getTime();
      task.at = Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
    });
    at.value = task.at > 0 ? toLocalInput(task.at) : '';
    rows.push(h('div', { class: 'row' }, h('label', {}, t('tasks.time')), at));
  } else {
    const time = bind(h('input', { type: 'time' }) as HTMLInputElement, (e) => (task.minuteOfDay = timeToMinute(e.value)));
    time.value = minuteToTime(task.minuteOfDay);
    rows.push(h('div', { class: 'row' }, h('label', {}, t('tasks.time')), time));
    if (task.kind === 'weekly') {
      const days = h('div', { class: 'days' });
      for (let d = 0; d < 7; d++) {
        const cb = bind(h('input', { type: 'checkbox' }) as HTMLInputElement, (e) => {
          task.daysMask = e.checked ? task.daysMask | (1 << d) : task.daysMask & ~(1 << d);
        });
        cb.checked = (task.daysMask & (1 << d)) !== 0;
        days.append(h('label', {}, cb, t(`day.${d}`)));
      }
      rows.push(h('div', { class: 'row' }, h('label', {}, ''), days));
    }
  }
  rows.push(
    h('div', { class: 'row' }, h('label', {}, t('tasks.sound')), sound),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn danger',
          onclick: () => {
            tasks = tasks.filter((x) => x.id !== task.id);
            saveTasksSoon();
            renderAll();
          },
        },
        t('tasks.delete'),
      ),
    ),
  );
  return h('div', { class: 'card' }, ...rows);
}

function pageTasks(): HTMLElement[] {
  const builtin = tasks.filter((x) => x.id.startsWith('builtin-'));
  const custom = tasks.filter((x) => !x.id.startsWith('builtin-'));
  return [
    h('h1', {}, t('tasks.title')),
    h('p', { class: 'desc' }, t('tasks.desc')),
    ...builtin.map(taskRowBuiltin),
    h('h2', {}, t('tasks.custom')),
    ...custom.map(taskRowCustom),
    h(
      'button',
      {
        class: 'btn',
        onclick: () => {
          tasks.push({
            id: `custom-${Date.now()}`,
            name: '',
            enabled: true,
            kind: 'daily',
            everyMinutes: 60,
            awayMinutes: 5,
            minuteOfDay: 9 * 60,
            daysMask: 0b0111110,
            at: 0,
            leadMinutes: 0,
            message: '',
            animation: 'remind',
            sound: false,
          });
          saveTasksSoon();
          renderAll();
        },
      },
      t('tasks.add'),
    ),
  ];
}

let shutdownMode: 'countdown' | 'at' = 'countdown';
let shutdownMinutes = 60;
let shutdownClock = '23:00';
let shutdownForce = false;

function shutdownStatusText(): string {
  if (!shutdown.scheduled || !shutdown.dueAt) return t('shutdown.none');
  const d = new Date(shutdown.dueAt * 1000);
  return t('shutdown.scheduled', {
    t: d.toLocaleString(),
    f: shutdown.force ? t('shutdown.forced') : '',
  });
}

function pageShutdown(): HTMLElement[] {
  shutdownForce = shutdownForce || settings.shutdownForceDefault;
  const modeSel = h('select', { id: 'sd-mode' }) as HTMLSelectElement;
  for (const m of ['countdown', 'at'] as const) {
    const o = h('option', { value: m }, t(`shutdown.mode.${m}`)) as HTMLOptionElement;
    o.selected = shutdownMode === m;
    modeSel.append(o);
  }
  modeSel.addEventListener('change', () => {
    shutdownMode = modeSel.value as 'countdown' | 'at';
    renderAll();
  });

  let control: HTMLElement;
  if (shutdownMode === 'countdown') {
    const mins = h('input', { type: 'number', min: 1, max: 10080, id: 'sd-min' }) as HTMLInputElement;
    mins.value = String(shutdownMinutes);
    mins.addEventListener('change', () => {
      shutdownMinutes = Math.max(1, Math.min(10080, Math.round(Number(mins.value) || 1)));
      mins.value = String(shutdownMinutes);
    });
    const presets = h('span', {});
    for (const p of [15, 30, 60, 120, 180]) {
      presets.append(
        h(
          'button',
          {
            class: 'btn',
            style: 'margin-right:4px',
            onclick: () => {
              shutdownMinutes = p;
              mins.value = String(p);
            },
          },
          String(p),
        ),
      );
    }
    control = h('div', {}, h('div', { class: 'row' }, h('label', { for: 'sd-min' }, t('shutdown.minutes')), mins), h('div', { class: 'row' }, presets));
  } else {
    const clock = h('input', { type: 'time', id: 'sd-clock' }) as HTMLInputElement;
    clock.value = shutdownClock;
    clock.addEventListener('change', () => (shutdownClock = clock.value || '23:00'));
    control = h('div', { class: 'row' }, h('label', { for: 'sd-clock' }, t('shutdown.clock')), clock);
  }

  const force = h('input', { type: 'checkbox', id: 'sd-force' }) as HTMLInputElement;
  force.checked = shutdownForce;
  force.addEventListener('change', () => (shutdownForce = force.checked));

  const secondsFromUi = (): number => {
    if (shutdownMode === 'countdown') return shutdownMinutes * 60;
    const target = new Date();
    const [hh, mm] = shutdownClock.split(':').map((x) => Number(x));
    target.setHours(hh || 0, mm || 0, 0, 0);
    if (target.getTime() <= Date.now() + 60_000) target.setDate(target.getDate() + 1);
    return Math.round((target.getTime() - Date.now()) / 1000);
  };

  return [
    h('h1', {}, t('shutdown.title')),
    h('p', { class: 'desc' }, t('shutdown.desc')),
    h('div', { class: 'row' }, h('label', { for: 'sd-mode' }, ''), modeSel),
    control,
    h('div', { class: 'row' }, h('label', { for: 'sd-force' }, t('shutdown.force')), force),
    h('p', { class: 'desc' }, t('shutdown.range')),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            if (shutdownForce && !window.confirm(t('shutdown.confirmForce'))) return;
            try {
              shutdown = await pet.shutdownSchedule(secondsFromUi(), shutdownForce);
              renderAll();
            } catch (e) {
              toast(errText(e), true);
            }
          },
        },
        t('shutdown.schedule'),
      ),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            try {
              shutdown = await pet.shutdownCancel();
              renderAll();
            } catch (e) {
              toast(errText(e), true);
            }
          },
        },
        t('shutdown.cancel'),
      ),
    ),
    h('div', { class: 'status', id: 'sd-status' }, shutdownStatusText()),
  ];
}

function pageSound(): HTMLElement[] {
  const vol = h('input', { type: 'range', min: 0, max: 100, id: 'meow-vol' }) as HTMLInputElement;
  vol.value = String(Math.round(settings.meowVolume * 100));
  vol.addEventListener('change', () => {
    settings.meowVolume = Number(vol.value) / 100;
    saveSettingsSoon();
  });
  const qs = h('input', { type: 'time', id: 'q-from' }) as HTMLInputElement;
  qs.value = minuteToTime(settings.quietStartMinute);
  qs.addEventListener('change', () => {
    settings.quietStartMinute = timeToMinute(qs.value);
    saveSettingsSoon();
  });
  const qe = h('input', { type: 'time', id: 'q-to' }) as HTMLInputElement;
  qe.value = minuteToTime(settings.quietEndMinute);
  qe.addEventListener('change', () => {
    settings.quietEndMinute = timeToMinute(qe.value);
    saveSettingsSoon();
  });
  return [
    h('h1', {}, t('sound.title')),
    h('p', { class: 'desc' }, t('sound.desc')),
    check('meowEnabled', t('sound.enable')),
    h('div', { class: 'row' }, h('label', { for: 'meow-vol' }, t('sound.volume')), vol),
    num('meowMinMinutes', t('sound.min'), 1, 240),
    num('meowMaxMinutes', t('sound.max'), 1, 480),
    check('quietEnabled', t('sound.quiet')),
    h('div', { class: 'row' }, h('label', { for: 'q-from' }, t('sound.quietFrom')), qs, h('label', { for: 'q-to', style: 'min-width:0' }, t('sound.quietTo')), qe),
    h('div', { class: 'card' },
      h('h2', {}, t('sound.folder')),
      h('p', { class: 'desc' }, t('sound.folderDesc')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          try { await pet.openMeowFolder(); } catch (e) { toast(errText(e), true); }
        } }, t('sound.openFolder')),
        h('button', { class: 'btn', onclick: async () => {
          try { await reloadCustomMeows(); await playMeow(settings.meowVolume); } catch (e) { toast(errText(e), true); }
        } }, t('sound.test')),
      ),
    ),
  ];
}

function pagePrivacy(): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!settings.fileReactionsAsked) {
    const choose = async (on: boolean) => {
      settings.fileReactions = on;
      if (on && settings.watchFolders.length === 0) settings.watchFolders = ['desktop', 'downloads'];
      settings.fileReactionsAsked = true;
      try {
        settings = await pet.updateSettings(settings);
      } catch (e) {
        toast(errText(e), true);
      }
      renderAll();
    };
    out.push(
      h('div', { class: 'card welcome' },
        h('h2', {}, t('privacy.welcome')),
        h('p', { class: 'desc' }, t('privacy.fileOpsDesc')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => void choose(true) }, t('privacy.welcomeYes')),
          h('button', { class: 'btn', onclick: () => void choose(false) }, t('privacy.welcomeNo')),
        ),
        h('p', { class: 'desc' }, t('privacy.later')),
      ),
    );
  }
  out.push(
    h('h1', {}, t('privacy.title')),
    h('p', { class: 'desc' }, t('privacy.body1')),
    h('p', { class: 'desc' }, t('privacy.body2')),
    h('h2', {}, t('privacy.fileOps')),
    h('p', { class: 'desc' }, t('privacy.fileOpsDesc')),
    check('fileReactions', t('privacy.fileOps')),
    h('h2', {}, t('privacy.folders')),
  );
  for (const f of ['desktop', 'downloads', 'documents'] as const) {
    const cb = h('input', { type: 'checkbox', id: `wf-${f}` }) as HTMLInputElement;
    cb.checked = settings.watchFolders.includes(f);
    cb.addEventListener('change', () => {
      const set = new Set(settings.watchFolders);
      if (cb.checked) set.add(f);
      else set.delete(f);
      settings.watchFolders = [...set];
      saveSettingsSoon();
    });
    out.push(h('div', { class: 'row' }, h('label', { for: `wf-${f}` }, t(`privacy.folder.${f}`)), cb));
  }
  out.push(h('p', { class: 'desc' }, t('privacy.foldersHint')));
  return out;
}

function pageAbout(): HTMLElement[] {
  return [
    h('h1', {}, `${t('about.title')} · ${t('about.beta')}`),
    h('p', { class: 'desc' }, t('about.base')),
    h('p', { class: 'desc' }, t('about.licenses')),
  ];
}

function skinErrText(raw: string): string {
  const codes = raw.split(',');
  const first = codes[0] ?? '';
  const key = first.split(':')[0];
  const known = `skins.err.${key}`;
  const msg = t(known);
  return msg === known ? `${t('skins.err.other')} (${first})` : msg;
}

async function handleSkinFile(file: File): Promise<void> {
  try {
    if (file.size > 8_000_000) throw new Error('pack-too-large');
    const json = await file.text();
    const summary = await pet.skinInspect(json);
    pendingSkin = { json, summary };
    renderAll();
  } catch (e) {
    toast(skinErrText(errText(e)), true);
  }
}

async function reloadSkins(): Promise<void> {
  try {
    [skinList, overrideList] = await Promise.all([pet.skinList(), pet.skinOverrideStatus()]);
  } catch (e) {
    toast(skinErrText(errText(e)), true);
  }
}

/** 默认皮肤：复制成新皮肤 / 修改外观 / 四层回滚。内置皮肤本身永远不被修改。 */
function builtinSection(): HTMLElement[] {
  const out: HTMLElement[] = [h('h2', {}, t('skins.builtinTitle')), h('p', { class: 'desc' }, t('skins.builtinDesc'))];
  const act = (fn: () => Promise<unknown>, okMsg = t('skins.overrideDone')) => async (): Promise<void> => {
    try {
      await fn();
      toast(okMsg);
    } catch (e) {
      toast(skinErrText(errText(e)), true);
    }
    await reloadSkins();
    renderAll();
  };
  for (const o of overrideList) {
    out.push(
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('label', {}, o.hasOverride ? `${o.name}  ·  ${t('skins.customized')}` : o.name),
        ),
        o.needsReview ? h('p', { class: 'desc' }, t('skins.review')) : '',
        o.corrupt ? h('p', { class: 'desc' }, t('skins.corrupt')) : '',
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => { void pet.openMaker(`builtin:${o.id}`).catch((e) => toast(errText(e), true)); } }, t('skins.copyNew')),
          h('button', { class: 'btn', onclick: () => { void pet.openMaker(`override:${o.id}`).catch((e) => toast(errText(e), true)); } }, t('skins.modify')),
          o.needsReview ? h('button', { class: 'btn', onclick: act(() => pet.skinOverrideKeep(o.id)) }, t('skins.keep')) : '',
          o.canUndo ? h('button', { class: 'btn', onclick: act(() => pet.skinOverrideUndo(o.id)) }, t('skins.undo')) : '',
          o.hasOverride
            ? h('button', { class: 'btn danger', onclick: () => { if (window.confirm(t('skins.confirmResetOne'))) void act(() => pet.skinOverrideReset(o.id))(); } }, t('skins.resetOne'))
            : '',
        ),
      ),
    );
  }
  if (overrideList.some((o) => o.hasOverride || o.canUndo)) {
    out.push(
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', onclick: () => { if (window.confirm(t('skins.confirmResetAll'))) void act(() => pet.skinOverrideResetAll())(); } }, t('skins.resetAll')),
      ),
    );
  }
  const ig = h('input', { type: 'checkbox', id: 'c-ignoreOverrides' }) as HTMLInputElement;
  ig.checked = settings.ignoreOverrides;
  ig.addEventListener('change', () => {
    settings.ignoreOverrides = ig.checked;
    void pet.skinOverrideIgnore(ig.checked).then(reloadSkins).then(renderAll).catch((e) => toast(errText(e), true));
  });
  out.push(h('div', { class: 'row' }, h('label', { for: 'c-ignoreOverrides' }, t('skins.ignore')), ig));
  return out;
}

function pageSkins(): HTMLElement[] {
  const out: HTMLElement[] = [h('h1', {}, t('skins.title')), h('p', { class: 'desc' }, t('skins.desc'))];

  if (pendingSkin) {
    const s = pendingSkin.summary;
    out.push(
      h('div', { class: 'card welcome' },
        h('h2', {}, `${t('skins.confirmTitle')} ${s.name}`),
        h('p', { class: 'desc' }, `${t('skins.author')}: ${s.author}  ·  ${t('skins.license')}: ${s.license}  ·  ${t('skins.version')}: ${s.version}  ·  ${t(`skins.kind.${s.kind}`)}`),
        s.description ? h('p', { class: 'desc' }, s.description) : '',
        s.installed ? h('p', { class: 'desc' }, t('skins.replace')) : '',
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => {
            const p = pendingSkin;
            if (!p) return;
            try {
              await pet.skinInstall(p.json);
              pendingSkin = null;
              skinList = await pet.skinList();
              toast(t('skins.done'));
            } catch (e) {
              toast(skinErrText(errText(e)), true);
            }
            renderAll();
          } }, t('skins.confirm')),
          h('button', { class: 'btn', onclick: () => { pendingSkin = null; renderAll(); } }, t('skins.cancel')),
        ),
      ),
    );
  }

  const input = h('input', { type: 'file', accept: '.petskin,.json', style: 'display:none', id: 'skin-file' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) void handleSkinFile(f);
  });
  const drop = h('div', { class: 'card', style: 'text-align:center' },
    h('button', { class: 'btn', onclick: () => input.click() }, t('skins.install')),
    h('button', { class: 'btn', onclick: () => { void pet.openMaker().catch((e) => toast(errText(e), true)); } }, t('skins.openMaker')),
    h('button', { class: 'btn', onclick: () => { void pet.skinOpenFolder().catch((e) => toast(errText(e), true)); } }, t('skins.folder')),
    h('p', { class: 'desc' }, t('skins.drop')),
    h('p', { class: 'desc' }, t('skins.folderNote')),
    input,
  );
  drop.addEventListener('dragover', (ev) => ev.preventDefault());
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const f = (ev as DragEvent).dataTransfer?.files?.[0];
    if (f) void handleSkinFile(f);
  });
  out.push(drop, ...builtinSection(), h('h2', {}, t('skins.installed')));

  if (skinList.length === 0) out.push(h('p', { class: 'desc' }, t('skins.none')));
  for (const s of skinList) {
    out.push(
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('label', {}, `${s.name}  ·  ${t(`skins.kind.${s.kind}`)}`),
          s.hasPrevious ? h('button', { class: 'btn', onclick: async () => {
            try {
              await pet.skinRollback(s.id);
              toast(t('skins.previousDone'));
            } catch (e) {
              toast(skinErrText(errText(e)), true);
            }
            await reloadSkins();
            renderAll();
          } }, t('skins.previous')) : '',
          s.registered ? h('button', { class: 'btn', onclick: () => { void pet.openMaker(`skin:${s.id}`).catch((e) => toast(errText(e), true)); } }, t('skins.edit'))
            : h('button', { class: 'btn', onclick: async () => {
              try {
                const json = await pet.skinRead(s.id);
                pendingSkin = { json, summary: await pet.skinInspect(json) };
              } catch (e) {
                toast(skinErrText(errText(e)), true);
              }
              renderAll();
            } }, t('skins.reinstall')),
          h('button', { class: 'btn danger', onclick: async () => {
            if (!window.confirm(t('skins.confirmRemove'))) return;
            try {
              await pet.skinRemove(s.id);
              skinList = await pet.skinList();
            } catch (e) {
              toast(skinErrText(errText(e)), true);
            }
            renderAll();
          } }, t('skins.remove')),
        ),
        s.registered ? '' : h('p', { class: 'desc' }, t('skins.unregistered')),
        h('p', { class: 'desc' }, `${t('skins.author')}: ${s.author}  ·  ${t('skins.license')}: ${s.license}  ·  ${t('skins.version')}: ${s.version}`),
        s.kind === 'sprites' || s.kind === 'layered' ? skinAdjustBox(s.id) : '',
      ),
    );
  }
  out.push(h('p', { class: 'desc' }, t('skins.howto')));
  return out;
}

/** 「高级」：这个皮肤的大小与上下位置（只存在本机，不进皮肤包）。 */
function skinAdjustBox(id: string): HTMLElement {
  const cur = getAdjust(id);
  const scale = h('input', { type: 'range', min: '0.4', max: '2', step: '0.05', value: String(cur.scale) }) as HTMLInputElement;
  const dy = h('input', { type: 'range', min: '-120', max: '120', step: '2', value: String(cur.dy) }) as HTMLInputElement;
  const apply = (): void => setAdjust(id, { scale: Number(scale.value), dy: Number(dy.value) });
  scale.addEventListener('input', apply);
  dy.addEventListener('input', apply);
  return h('details', {}, h('summary', {}, t('skins.advanced')),
    h('div', { class: 'row' }, h('label', {}, t('skins.adjScale')), scale),
    h('div', { class: 'row' }, h('label', {}, t('skins.adjDy')), dy),
    h('button', { class: 'btn', onclick: () => { scale.value = '1'; dy.value = '0'; apply(); } }, t('skins.adjReset')));
}

const PAGES: Record<TabId, () => HTMLElement[]> = {
  general: pageGeneral,
  focus: pageFocus,
  tasks: pageTasks,
  skins: pageSkins,
  shutdown: pageShutdown,
  sound: pageSound,
  privacy: pagePrivacy,
  about: pageAbout,
};

function renderAll(): void {
  const tabs = $('tabs');
  tabs.replaceChildren(
    ...TAB_ORDER.map((id) => {
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === tab) }, t(`tab.${id}`));
      b.addEventListener('click', () => {
        tab = id;
        location.hash = id;
        renderAll();
      });
      return b;
    }),
  );
  $('panel').replaceChildren(...PAGES[tab]());
  document.title = `KuroCat · ${t(`tab.${tab}`)}`;
  document.documentElement.lang = getLang();
}

async function main(): Promise<void> {
  try {
    [settings, status, tasks, snacks, shutdown, skinList, overrideList] = await Promise.all([
      pet.getSettings(),
      pet.status(),
      pet.tasksGet(),
      pet.snackCatalog(),
      pet.shutdownStatus(),
      pet.skinList(),
      pet.skinOverrideStatus(),
    ]);
  } catch (e) {
    $('panel').textContent = `Backend unavailable: ${errText(e)}`;
    return;
  }
  setLang(settings.language);
  const hash = location.hash.slice(1) as TabId;
  tab = TAB_ORDER.includes(hash) ? hash : settings.fileReactionsAsked ? 'general' : 'privacy';
  renderAll();

  await listen<PetSettings>('kuro-pet-settings', (ev) => {
    settings.ignoreOverrides = ev.payload.ignoreOverrides;
  });
  await listen('kuro-skins-changed', async () => {
    await reloadSkins();
    if (tab === 'skins' && !pendingSkin) renderAll();
  });
  await listen<PetStatus>('kuro-focus', (ev) => {
    status = ev.payload;
    updateFocusStatus();
  });
  await listen<{ coins: number; completed: number }>('kuro-game', async () => {
    try {
      status = await pet.status();
      if (tab === 'focus') renderAll();
    } catch {
      /* ignore */
    }
  });
  await listen<ShutdownStatus>('kuro-shutdown', (ev) => {
    shutdown = ev.payload;
    if (tab === 'shutdown') renderAll();
  });
  timer = window.setInterval(async () => {
    if (tab === 'shutdown') {
      try {
        shutdown = await pet.shutdownStatus();
        const el = document.getElementById('sd-status');
        if (el) el.textContent = shutdownStatusText();
      } catch {
        /* ignore */
      }
    }
  }, 5000);
  window.addEventListener('beforeunload', () => {
    if (timer !== null) window.clearInterval(timer);
  });
}

void main();
