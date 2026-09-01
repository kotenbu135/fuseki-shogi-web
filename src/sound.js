// 対局音。WebAudioで合成していて、音のファイルは1つも持たない。
//
// lishogiの音を借りていないのは、あちらの音源が AGPLv3+（nes, sfx）か
// 個別許諾（chisei_mazawa, sakura_ajisai）で、GPL-3.0-onlyのこの配布物に
// 混ぜられないため。駒音は短い減衰なので、合成すれば素性の問題が消えるうえ
// 転送量も0になる。
//
// 鳴らす場面はlishogiのround/ctrl.tsに合わせてある:
//   着手 / 駒を取る / 王手 / 終局（勝ち・負け・引き分け）

const STORE_KEY = 'fuseki-sound';

/** 駒が盤に当たる音。木の板を弾いたときの、高い当たりと低い胴鳴り。 */
function komaOto(ctx, t, { gain = 1, pitch = 1, thud = 0 } = {}) {
  // 当たりの成分。短いノイズを帯域で削って「パチッ」にする。
  const len = Math.ceil(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400 * pitch;
  bp.Q.value = 1.4;

  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.9 * gain, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

  noise.connect(bp).connect(ng).connect(ctx.destination);
  noise.start(t);
  noise.stop(t + 0.05);

  // 胴鳴り。盤の低い響きで、これが無いと乾いた雑音にしか聞こえない。
  for (const [f, a, dur] of [[190 * pitch, 0.5, 0.09], [320 * pitch, 0.22, 0.06]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.72, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(a * gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  // 駒を取ったときだけ、下に一撃足して重くする。
  if (thud) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t + 0.012);
    osc.frequency.exponentialRampToValueAtTime(62, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(thud * gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    osc.connect(g).connect(ctx.destination);
    osc.start(t + 0.012);
    osc.stop(t + 0.18);
  }
}

/** 単音。終局や王手の合図に使う。 */
function tone(ctx, t, freq, dur, gain = 0.28, type = 'sine') {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.01);
}

/** 各音の中身。ctx と開始時刻を受け取って鳴らすだけにしてあるので、
 *  OfflineAudioContext に差し替えれば鳴っているかを数値で確かめられる。 */
export const VOICES = {
  move: (ctx, t) => komaOto(ctx, t, { gain: 0.85 }),
  capture: (ctx, t) => komaOto(ctx, t, { gain: 1, pitch: 0.92, thud: 0.42 }),
  check: (ctx, t) => {
    komaOto(ctx, t, { gain: 0.85 });
    tone(ctx, t + 0.04, 880, 0.16, 0.2, 'triangle');
    tone(ctx, t + 0.14, 1320, 0.2, 0.16, 'triangle');
  },
  win: (ctx, t) => [523.25, 659.25, 783.99].forEach((f, i) => tone(ctx, t + i * 0.11, f, 0.34)),
  lose: (ctx, t) => [493.88, 415.30, 329.63].forEach((f, i) => tone(ctx, t + i * 0.13, f, 0.4, 0.24)),
  draw: (ctx, t) => [440, 440].forEach((f, i) => tone(ctx, t + i * 0.16, f, 0.26, 0.22)),
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = readVolume();
  }

  /** AudioContext は利用者の操作の中でしか起こせない（ブラウザの自動再生規制）。
   *  対局開始のクリックから呼ぶ。 */
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem(STORE_KEY, String(this.volume)); } catch { /* 保存できなくても鳴る */ }
  }

  play(name) {
    if (!this.ctx || this.volume <= 0) return;
    const voice = VOICES[name];
    if (!voice) return;
    // 音量はマスターで掛けず、各音のgainに掛ける。終局音と駒音で
    // 元の大きさが違うので、比を保ったまま絞りたい。
    const master = this.ctx.createGain();
    master.gain.value = this.volume;
    const dest = this.ctx.destination;
    // destination を差し替えた薄いプロキシを渡す。各voiceは connect(ctx.destination)
    // としか書いていないので、これだけでマスター経由になる。
    voice({ ...proxyOf(this.ctx), destination: master }, this.ctx.currentTime + 0.001);
    master.connect(dest);
  }
}

// createGain などは ctx に束縛されたメソッドなので、スプレッドでは持ち出せない。
// 必要なものだけ bind して渡す。
function proxyOf(ctx) {
  return {
    sampleRate: ctx.sampleRate,
    get currentTime() { return ctx.currentTime; },
    createBuffer: ctx.createBuffer.bind(ctx),
    createBufferSource: ctx.createBufferSource.bind(ctx),
    createBiquadFilter: ctx.createBiquadFilter.bind(ctx),
    createGain: ctx.createGain.bind(ctx),
    createOscillator: ctx.createOscillator.bind(ctx),
  };
}

function readVolume() {
  try {
    const v = Number.parseFloat(localStorage.getItem(STORE_KEY) ?? '');
    return v >= 0 && v <= 1 ? v : 0.7;
  } catch {
    return 0.7;
  }
}
