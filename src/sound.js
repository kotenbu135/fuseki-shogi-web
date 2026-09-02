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

/** 帯域を削った短いノイズ。駒が当たった瞬間の「芯」を作る。 */
function noiseBurst(ctx, t, { dur, freq, q, type, gain }) {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // 3乗で落とす。1乗だと尾を引いて「シャッ」と擦れた音になる。
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
  src.stop(t + dur + 0.005);
}

/** 木の共振。音程は動かさない。下げると「ボヨン」と鳴ってゴムに聞こえる。 */
function woodMode(ctx, t, freq, gain, dur) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const g = ctx.createGain();
  // 0から1msで立ち上げる。いきなり最大にすると波形が切れてデジタル臭い
  // クリックが乗るが、長く取ると当たりの鋭さが鈍る。
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.005);
}

/**
 * 駒が盤に当たる音。榧の盤に黄楊の駒。
 *
 * 3つの層でできている。
 *   1. 当たり   6msで消える明るいノイズ。「パチッ」の芯はここだけで出る。
 *   2. 木の響き 整数倍でない3つの山。木は弦ではないので倍音が並ばない。
 *   3. 盤の胴   200Hz前後を小さく。重さを足すだけで、主役にはしない。
 *
 * 前の版が鈍く聞こえたのは、当たりのノイズを45msも伸ばし（芯ではなく擦れになる）、
 * 190Hzの三角波を0.5という大きさで鳴らしていたため。低い唸りが主役になっていた。
 * さらに響きの音程を0.72倍まで下げていて、木ではなくゴムの弾みに聞こえていた。
 */
function komaOto(ctx, t, { gain = 1, pitch = 1, thud = 0 } = {}) {
  // 同じ波形が続くと機械に聞こえる。1回ごとに少しだけ散らす。
  const p = pitch * (1 + (Math.random() - 0.5) * 0.08);
  const g0 = gain * (1 + (Math.random() - 0.5) * 0.18);

  // 1. 当たり。短いほど固くなる。ここを伸ばすと途端に鈍る。
  noiseBurst(ctx, t, { dur: 0.006, freq: 4200 * p, q: 0.7, type: 'highpass', gain: 0.5 * g0 });
  noiseBurst(ctx, t, { dur: 0.018, freq: 1900 * p, q: 1.1, type: 'bandpass', gain: 0.42 * g0 });

  // 2. 木の響き。どれも短い。木は鳴り続けない。
  for (const [f, a, dur] of [[1180, 0.20, 0.055], [1960, 0.12, 0.040], [3050, 0.07, 0.028]])
    woodMode(ctx, t, f * p, a * g0, dur);

  // 3. 盤の胴。
  woodMode(ctx, t, 205 * p, 0.13 * g0, 0.075);

  // 駒を取ったときだけ、下に一撃足して重くする。前の版より短く、低く残さない。
  if (thud) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t + 0.006);
    osc.frequency.exponentialRampToValueAtTime(85, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(thud * g0, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(g).connect(ctx.destination);
    osc.start(t + 0.006);
    osc.stop(t + 0.12);
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
  // 駒を取るのは2つの音でできている。弾かれた駒が鳴り、そのあと自分の駒が盤に着く。
  // 1つの音を重くするより、この間（22ms）のほうが「取った」に聞こえる。
  capture: (ctx, t) => {
    komaOto(ctx, t, { gain: 0.5, pitch: 1.15 });
    komaOto(ctx, t + 0.022, { gain: 0.95, pitch: 0.95, thud: 0.3 });
  },
  check: (ctx, t) => {
    komaOto(ctx, t, { gain: 0.85 });
    // 駒音が明るくなったぶん、合図は控えめにする。三角波だと1320Hzが耳に刺さる。
    tone(ctx, t + 0.05, 880, 0.16, 0.15);
    tone(ctx, t + 0.15, 1320, 0.2, 0.11);
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
    // 鳴らし終えたら音のグラフから外す。1局200手でも繋ぎっぱなしにしない。
    // いちばん長い音（負け）で0.7秒なので、その倍を取っておけば足りる。
    setTimeout(() => master.disconnect(), 1500);
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
