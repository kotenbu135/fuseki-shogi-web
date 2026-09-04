// ホームの盤。布石エンジン（方策ネット）に40手打たせ、駒を順に落として見せる。
//
// ルール説明の文章を読まなくても「空の盤に交互に20枚」が見えるようにするためのもので、
// 対局には関わらない。局面は自分専用の Fuseki（WASMをもう1つ起こす）に持ち、対局の
// 局面には触らない。手は対局と同じ方策から温度1で引く（合法手はWASMが出すので、
// 布石のルールをここに書かない）。
//
// シードは日付＋通し番号。同じ日に開いた人は同じ順で同じ布石を見る。乱数は方策の
// 抽選にだけ使い、描画には使わない。
import { Fuseki } from './fuseki.js';

const PLIES = 40;
const STEP_MS = 150;     // 1手の間。方策の推論（約10ms）はこの中に吸収される
const DROP_MS = 220;     // 駒が落ちる動き
const HOLD_MS = 3000;    // 打ち終えてから次までの間
const FADE_MS = 600;
const PAPER = '#fbf3d5', PAPER_EDGE = '#5a4322', KING = '#b23a2c';

/** mulberry32。1つの seed から同じ列が出る。 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 今日の番号。YYYYMMDD00 から通し番号を足す。 */
function daySeed() {
  const d = new Date();
  return (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) * 100;
}

export class HomeBoard {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{fusekiUrl: string, policy: import('./policy.js').FusekiPolicy}} engines
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fuseki = null;
    this.policy = null;
    this.placed = [];          // { col, row, king, gote, t }
    this.plan = null;          // 生成中の手順を作る非同期の仕事
    this.phase = 'idle';       // idle | drop | hold | fade
    this.fade = 1;
    this.n = 0;
    this.raf = null;
    this.last = 0;
    this.sinceMove = 0;
    this.hold = 0;
    this.active = false;
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._resize = () => this.fit();
    addEventListener('resize', this._resize);
    this.fit();
    this.draw();
  }

  /** エンジンが起きたら呼ぶ。以後、見えているあいだ布石を打ち続ける。 */
  async start({ fusekiUrl, policy }) {
    if (this.fuseki) return;
    this.policy = policy;
    this.fuseki = await Fuseki.load(fusekiUrl);
    this.resume();
  }

  /** ホームが見えなくなったら止める（対局中に裏でNNを回さない）。 */
  pause() {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }
  resume() {
    if (!this.fuseki || this.active || document.hidden) return;
    this.active = true;
    if (this.phase === 'idle') this.next();
    this.last = 0;
    this.raf = requestAnimationFrame(ts => this.frame(ts));
  }

  /** 次の布石。方策に40手打たせて手順を作り、順に落とす。 */
  next() {
    const seed = daySeed() + (this.n++ % 100);
    const rng = seeded(seed);
    const fuseki = this.fuseki, policy = this.policy;
    this.placed = [];
    this.fade = 1;
    this.phase = 'drop';
    this.sinceMove = 0;
    const gen = this.plan = { moves: [], done: false, seed };
    (async () => {
      fuseki.reset();
      for (let i = 0; i < PLIES && this.plan === gen; i++) {
        const { move } = await policy.pick(fuseki, { temperature: 1, rng });
        fuseki.drop(move);
        // sq は cppshogi の Square（file*9+rank、file 0 = 1筋）。表示は左が9筋。
        const file = Math.floor(move.sq / 9), rank = move.sq % 9;
        gen.moves.push({ col: 8 - file, row: rank, king: move.role === 'king', gote: i % 2 === 1 });
      }
      gen.done = true;
    })().catch(e => { console.warn('ホームの盤を止めた:', e.message); this.pause(); });
  }

  frame(ts) {
    if (!this.active) return;
    const dt = this.last ? Math.min(0.05, (ts - this.last) / 1000) : 0;
    this.last = ts;
    const gen = this.plan;
    if (this.phase === 'drop') {
      this.sinceMove += dt * 1000;
      if (gen && this.placed.length < gen.moves.length && this.sinceMove >= STEP_MS) {
        this.sinceMove = 0;
        this.placed.push({ ...gen.moves[this.placed.length], t: this.reduce ? 1 : 0 });
      }
      for (const p of this.placed) p.t = Math.min(1, p.t + dt * 1000 / DROP_MS);
      if (gen?.done && this.placed.length === PLIES && this.placed.every(p => p.t >= 1)) {
        this.phase = 'hold';
        this.hold = 0;
      }
    } else if (this.phase === 'hold') {
      this.hold += dt * 1000;
      if (this.hold >= HOLD_MS) this.phase = 'fade';
    } else if (this.phase === 'fade') {
      this.fade = Math.max(0, this.fade - dt * 1000 / (this.reduce ? 1 : FADE_MS));
      if (this.fade <= 0) this.next();
    }
    this.draw();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  /** キャンバスの実寸を表示の寸法と端末の倍率に合わせる。 */
  fit() {
    const c = this.canvas;
    const w = c.clientWidth || 300;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const px = Math.round(w * dpr);
    if (c.width !== px) { c.width = px; c.height = px; }
    if (!this.active) this.draw();
  }

  draw() {
    const { ctx, canvas: c } = this;
    const W = c.width;
    const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
    const m = W * 0.04, s = (W - 2 * m) / 9;
    ctx.clearRect(0, 0, W, W);
    ctx.globalAlpha = 1;
    // 盤。対局画面と同じ色。木目は描かない（小さいので縞にしか見えない）。
    ctx.fillStyle = css('--board') || '#f9b34e';
    ctx.fillRect(m, m, 9 * s, 9 * s);
    ctx.lineWidth = Math.max(2, W / 240);
    ctx.strokeStyle = css('--board-edge') || '#6f5027';
    ctx.strokeRect(m, m, 9 * s, 9 * s);
    ctx.lineWidth = Math.max(1, W / 600);
    ctx.strokeStyle = '#000';
    for (let i = 1; i < 9; i++) {
      ctx.beginPath(); ctx.moveTo(m + i * s, m); ctx.lineTo(m + i * s, m + 9 * s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(m, m + i * s); ctx.lineTo(m + 9 * s, m + i * s); ctx.stroke();
    }
    ctx.fillStyle = '#000';
    for (const [x, y] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
      ctx.beginPath(); ctx.arc(m + x * s, m + y * s, s * 0.07, 0, Math.PI * 2); ctx.fill();
    }
    // 駒。紙色の五角形。先手は上向き、後手は下向き。玉だけ朱の縁。
    ctx.globalAlpha = this.fade;
    for (const p of this.placed) {
      const cx = m + (p.col + 0.5) * s, cy = m + (p.row + 0.5) * s, w = s * 0.78, h = s * 0.86;
      const lift = p.t < 1 ? (1 - p.t) ** 2 * s * 0.9 : 0;
      ctx.save();
      ctx.translate(cx, cy - lift);
      if (p.gote) ctx.rotate(Math.PI);
      ctx.beginPath();
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, -h / 2 + h * 0.22);
      ctx.lineTo(w * 0.42, h / 2);
      ctx.lineTo(-w * 0.42, h / 2);
      ctx.lineTo(-w / 2, -h / 2 + h * 0.22);
      ctx.closePath();
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.lineWidth = p.king ? Math.max(2, W / 260) : Math.max(1, W / 520);
      ctx.strokeStyle = p.king ? KING : PAPER_EDGE;
      ctx.stroke();
      if (p.king) {
        ctx.beginPath(); ctx.arc(0, h * 0.08, w * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = KING; ctx.fill();
      }
      ctx.restore();
    }
  }
}
