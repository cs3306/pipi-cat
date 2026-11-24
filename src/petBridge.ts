// 宠物玩法的前后端桥：类型 + invoke 封装。命令与事件名见 src-tauri/src/pet/mod.rs 文件头；命令属于内联插件 "pet"。
import { invoke } from '@tauri-apps/api/core';

export interface PetSettings {
  schemaVersion: number;
  language: 'auto' | 'zh' | 'en';
  fileReactions: boolean;
  fileReactionsAsked: boolean;
  muteFileReactionsInFocus: boolean;
  focusMinutes: number;
  breakMinutes: number;
  rewardPerSession: number;
  idleThresholdSecs: number;
  cafeEnabled: boolean;
  meowEnabled: boolean;
  meowVolume: number;
  meowMinMinutes: number;
  meowMaxMinutes: number;
  quietEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  shutdownForceDefault: boolean;
  /** 文件反应监听的位置：desktop | downloads | documents */
  watchFolders: Array<'desktop' | 'downloads' | 'documents'>;
  /** 专注时猫的显示方式：正常 / 变淡 / 隐藏（隐藏时计时照常，结束与提醒前会先显示）。 */
  focusView: 'normal' | 'dim' | 'hidden';
  /** 临时停用对默认皮肤的覆盖（托盘「使用内置外观」同款）。 */
  ignoreOverrides: boolean;
}

export interface MakerAiConfig {
  baseUrl: string;
  model: string;
  remember: boolean;
  /** 密钥本身永远不会回传给界面，只告诉界面有没有。 */
  hasKey: boolean;
}

export interface SkinSummary {
  id: string;
  catId: string;
  name: string;
  author: string;
  license: string;
  version: string;
  description: string;
  kind: 'palette' | 'sprites' | string;
  bytes: number;
  installed: boolean;
  /** 已登记进猫列表。手动复制进文件夹的皮肤是 false，需要在设置里「重新安装」走确认卡。 */
  registered: boolean;
  /** 同 id 更新过，有上一代可以回退。 */
  hasPrevious: boolean;
}

export interface OverrideStatus {
  id: string;
  name: string;
  active: boolean;
  hasOverride: boolean;
  needsReview: boolean;
  corrupt: boolean;
  canUndo: boolean;
}

export interface BuiltinLook {
  id: string;
  name: string;
  /** 内置外观的颜色配置（起点）。 */
  builtin: Record<string, unknown>;
  /** 当前覆盖（若有且有效）。 */
  override: Record<string, unknown> | null;
}

export type FocusPhase = 'idle' | 'focus' | 'break';

export interface PetStatus {
  phase: FocusPhase;
  remaining: number;
  session: number;
  coins: number;
  completed: number;
  cafe: boolean;
}

export type TaskKind = 'interval' | 'daily' | 'weekly' | 'once' | 'sedentary';

export interface TaskDto {
  id: string;
  name: string;
  enabled: boolean;
  kind: TaskKind;
  everyMinutes: number;
  awayMinutes: number;
  minuteOfDay: number;
  daysMask: number;
  at: number;
  leadMinutes: number;
  message: string;
  animation: string;
  sound: boolean;
}

export interface ShutdownStatus {
  scheduled: boolean;
  dueAt?: number;
  force?: boolean;
}

export interface ReminderEvent {
  id: string;
  name: string;
  message: string;
  animation: string;
  sound: boolean;
  missed: boolean;
}

export interface SnackInfo {
  id: 'churu' | 'canned';
  price: number;
}

export const pet = {
  getSettings: () => invoke<PetSettings>('plugin:pet|pet_get_settings'),
  updateSettings: (patch: PetSettings) => invoke<PetSettings>('plugin:pet|pet_update_settings', { patch }),
  status: () => invoke<PetStatus>('plugin:pet|pet_status'),
  focusStart: () => invoke<PetStatus>('plugin:pet|focus_start'),
  focusCancel: () => invoke<PetStatus>('plugin:pet|focus_cancel'),
  buySnack: (id: string) => invoke<{ coins: number; id: string }>('plugin:pet|buy_snack', { id }),
  snackCatalog: () => invoke<SnackInfo[]>('plugin:pet|snack_catalog'),
  tasksGet: () => invoke<TaskDto[]>('plugin:pet|tasks_get'),
  tasksSave: (list: TaskDto[]) => invoke<void>('plugin:pet|tasks_save', { list }),
  snooze: (id: string, minutes: number) => invoke<void>('plugin:pet|reminder_snooze', { id, minutes }),
  listMeowFiles: () => invoke<string[]>('plugin:pet|list_meow_files'),
  readMeowFile: (name: string) => invoke<number[]>('plugin:pet|read_meow_file', { name }),
  openMeowFolder: () => invoke<void>('plugin:pet|open_meow_folder'),
  shutdownSchedule: (seconds: number, force: boolean) =>
    invoke<ShutdownStatus>('plugin:pet|shutdown_schedule', { seconds, force }),
  shutdownCancel: () => invoke<ShutdownStatus>('plugin:pet|shutdown_cancel'),
  shutdownStatus: () => invoke<ShutdownStatus>('plugin:pet|shutdown_status'),
  openSettings: () => invoke<void>('plugin:pet|open_settings'),
  skinInspect: (json: string) => invoke<SkinSummary>('plugin:pet|skin_inspect', { json }),
  skinInstall: (json: string) => invoke<SkinSummary>('plugin:pet|skin_install', { json }),
  skinList: () => invoke<SkinSummary[]>('plugin:pet|skin_list'),
  skinRemove: (id: string) => invoke<boolean>('plugin:pet|skin_remove', { id }),
  skinSprites: (id: string) => invoke<Record<string, string>>('plugin:pet|skin_sprites', { id }),
  skinRig: (id: string) => invoke<Record<string, unknown> | null>('plugin:pet|skin_rig', { id }),
  /** target：builtin:<id> 复制内置猫 / override:<id> 修改默认皮肤 / skin:<id> 编辑已安装皮肤 */
  openMaker: (target?: string) => invoke<void>('plugin:pet|open_maker', { target: target ?? null }),
  skinRead: (id: string) => invoke<string>('plugin:pet|skin_read', { id }),
  skinRollback: (id: string) => invoke<SkinSummary>('plugin:pet|skin_rollback', { id }),
  skinOpenFolder: () => invoke<void>('plugin:pet|skin_open_folder'),
  skinOverrideStatus: () => invoke<OverrideStatus[]>('plugin:pet|skin_override_status'),
  skinBuiltinLook: (id: string) => invoke<BuiltinLook>('plugin:pet|skin_builtin_look', { id }),
  skinOverrideSave: (id: string, palette: Record<string, unknown>) =>
    invoke<void>('plugin:pet|skin_override_save', { id, palette }),
  skinOverrideUndo: (id: string) => invoke<boolean>('plugin:pet|skin_override_undo', { id }),
  skinOverrideReset: (id: string) => invoke<boolean>('plugin:pet|skin_override_reset', { id }),
  skinOverrideResetAll: () => invoke<number>('plugin:pet|skin_override_reset_all'),
  skinOverrideKeep: (id: string) => invoke<void>('plugin:pet|skin_override_keep', { id }),
  skinOverrideIgnore: (ignore: boolean) => invoke<void>('plugin:pet|skin_override_ignore', { ignore }),
  makerAiGetConfig: () => invoke<MakerAiConfig>('plugin:pet|maker_ai_get_config'),
  makerAiSetConfig: (baseUrl: string, model: string, remember: boolean, apiKey?: string) =>
    invoke<MakerAiConfig>('plugin:pet|maker_ai_set_config', { baseUrl, model, remember, apiKey }),
  makerAiPalette: (prompt: string) => invoke<Record<string, unknown>>('plugin:pet|maker_ai_palette', { prompt }),
};

/** 错误可能是字符串，也可能是 Error。 */
export function errText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
}
