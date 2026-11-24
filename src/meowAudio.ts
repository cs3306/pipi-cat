// 猫叫与提醒音：优先播放用户放在自定义文件夹里的音频；没有文件时用 Web Audio 合成。
// 合成音不含任何第三方素材，因此没有版权问题；效果较「电子」，想要真实猫叫请放自己的录音。

import { pet } from './petBridge';

let ctx: AudioContext | null = null;
let customBuffers: AudioBuffer[] | null = null;

function audio(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 重新读取自定义文件夹（设置里点「打开文件夹」后、或启动时调用）。 */
export async function reloadCustomMeows(): Promise<number> {
  const ac = audio();
  const names = await pet.listMeowFiles();
  const out: AudioBuffer[] = [];
  for (const name of names) {
    try {
      const bytes = new Uint8Array(await pet.readMeowFile(name));
      out.push(await ac.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer));
    } catch {
      // 损坏或无法解码的文件直接跳过
    }
  }
  customBuffers = out;
  return out.length;
}

function playBuffer(buf: AudioBuffer, volume: number): void {
  const ac = audio();
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = Math.max(0, Math.min(1, volume));
  src.buffer = buf;
  src.connect(gain).connect(ac.destination);
  src.start();
}

function synthMeow(volume: number): void {
  const ac = audio();
  const t0 = ac.currentTime;
  const dur = 0.55 + Math.random() * 0.15;
  const base = 480 + Math.random() * 120;

  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(base, t0);
  osc.frequency.linearRampToValueAtTime(base * 1.55, t0 + dur * 0.35);
  osc.frequency.linearRampToValueAtTime(base * 0.8, t0 + dur);

  // 颤音
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  lfo.frequency.value = 6;
  lfoGain.gain.value = 9;
  lfo.connect(lfoGain).connect(osc.frequency);

  // 共振峰扫频：「me-ow」的元音变化
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 4;
  bp.frequency.setValueAtTime(900, t0);
  bp.frequency.linearRampToValueAtTime(1900, t0 + dur * 0.4);
  bp.frequency.linearRampToValueAtTime(800, t0 + dur);

  const gain = ac.createGain();
  const peak = 0.5 * Math.max(0, Math.min(1, volume));
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(bp).connect(gain).connect(ac.destination);
  osc.start(t0);
  lfo.start(t0);
  osc.stop(t0 + dur + 0.05);
  lfo.stop(t0 + dur + 0.05);
}

export async function playMeow(volume: number): Promise<void> {
  if (customBuffers === null) {
    try {
      await reloadCustomMeows();
    } catch {
      customBuffers = [];
    }
  }
  if (customBuffers && customBuffers.length > 0) {
    playBuffer(customBuffers[Math.floor(Math.random() * customBuffers.length)], volume);
  } else {
    synthMeow(volume);
  }
}

/** 提醒时的短提示音（两声正弦）。 */
export function playChime(volume = 0.5): void {
  const ac = audio();
  const t0 = ac.currentTime;
  [880, 1175].forEach((f, i) => {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    const s = t0 + i * 0.16;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.25 * volume), s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.3);
    osc.connect(g).connect(ac.destination);
    osc.start(s);
    osc.stop(s + 0.32);
  });
}
