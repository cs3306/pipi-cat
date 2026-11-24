// 把前端的诊断信息写进后端日志（%APPDATA%\pipi-cat\pipi-cat.log）。日志失败绝不能影响界面。
import { invoke } from '@tauri-apps/api/core';

export type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(level: LogLevel, tag: string, msg: string): void {
  try {
    void invoke('log_event', { level, tag, msg }).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** 捕获未处理的错误与 Promise 拒绝，并记录页面基本信息（含 WebView2 版本，在 userAgent 里）。 */
export function installErrorLogging(tag: string): void {
  window.addEventListener('error', (e) => {
    logEvent('error', tag, `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    logEvent('error', tag, `unhandled rejection: ${r instanceof Error ? r.stack || r.message : String(r)}`);
  });
  logEvent(
    'info',
    tag,
    `page loaded; dpr=${window.devicePixelRatio}; inner=${window.innerWidth}x${window.innerHeight}; ua=${navigator.userAgent}`,
  );
}
