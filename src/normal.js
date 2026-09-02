// 通常フェーズ（41手目以降）のAI。素の将棋なので、やねうら王のWASMビルドに任せる。
//
// このモジュールはUSIの往復だけを担当する。返ってきた bestmove を信用して盤に
// 適用してはいけない（webapp/backend/game.py と同じ理由）。合法性の照合は
// 呼び出し側が shogiops の Position::isLegal で行う。

/**
 * ブラウザ側のローダ。@mizarjp/yaneuraou.k-p はCJSで、Emscriptenが
 * document.currentScript.src からの相対で .wasm / .worker.js を探す。
 * バンドルに入れるとその解決先が壊れるため、classic scriptとして読んでグローバルを取る。
 */
export function loadYaneuraOuFactory(scriptUrl) {
  return new Promise((resolve, reject) => {
    if (globalThis.YaneuraOu_K_P) return resolve(globalThis.YaneuraOu_K_P);
    const el = document.createElement('script');
    el.src = scriptUrl;
    el.onload = () => globalThis.YaneuraOu_K_P
      ? resolve(globalThis.YaneuraOu_K_P)
      : reject(new Error('やねうら王を読み込んだがグローバルが生えていない'));
    el.onerror = () => reject(new Error(`やねうら王を読み込めない: ${scriptUrl}`));
    document.head.appendChild(el);
  });
}

export class NormalEngine {
  /**
   * @param {Function} factory EmscriptenModuleFactory（loadYaneuraOuFactory の戻り）
   * @param {number} [threads] SharedArrayBufferが使えないと1スレッドに落ちる
   */
  static async load({ factory, threads = 1, hashMb = 64 }) {
    const module = await factory();
    const engine = new NormalEngine(module);
    module.addMessageListener(line => engine._onLine(line));
    module.postMessage('usi');
    await engine._waitFor(l => l === 'usiok');
    module.postMessage(`setoption name USI_Hash value ${hashMb}`);
    module.postMessage(`setoption name Threads value ${threads}`);
    module.postMessage('isready');
    await engine._waitFor(l => l === 'readyok', 60000);
    return engine;
  }

  constructor(module) {
    this.module = module;
    this._waiters = [];
    this.lastInfo = null;   // 直近の探索情報（depth / score / nps / pv）。UIの表示用。
    // 探索は1つずつ。人間の手番に表示のための解析を走らせるようになったので、
    // 対局の指し手と重なりうる。
    this._chain = Promise.resolve();
    this._searching = false;
  }

  _onLine(line) {
    if (line.startsWith('info') && line.includes(' score ')) this.lastInfo = parseInfo(line);
    for (const w of this._waiters.slice()) {
      if (w.match(line)) {
        this._waiters.splice(this._waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
    }
  }

  _waitFor(match, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      w.timer = setTimeout(() => {
        this._waiters.splice(this._waiters.indexOf(w), 1);
        reject(new Error('やねうら王が応答しない'));
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  newGame() { this.module.postMessage('usinewgame'); }

  /**
   * 探索を1本ずつ順番に流す。
   *
   * 1つのエンジンに go を重ねてはいけない。重ねると bestmove の待ち合わせが交差して、
   * 解析の待ち手に対局の指し手が返る（またはその逆）。落ちずに、盤に入る手だけが
   * 入れ替わる壊れ方をする。
   */
  _go({ sfen, moves = [], movetimeMs = 1000 }) {
    const run = async () => {
      this._searching = true;
      this.lastInfo = null;
      const position = `position sfen ${sfen}` + (moves.length ? ` moves ${moves.join(' ')}` : '');
      this.module.postMessage(position);
      this.module.postMessage(`go movetime ${movetimeMs}`);
      try {
        const line = await this._waitFor(l => l.startsWith('bestmove'));
        return { usi: line.split(' ')[1], info: this.lastInfo };
      } finally {
        this._searching = false;
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.then(() => {}, () => {});
    return p;
  }

  /** 走っている探索を早めに切り上げる。指し手を待たせないために使う。 */
  stopSearch() {
    if (this._searching) this.module.postMessage('stop');
  }

  /**
   * 局面を渡して1手考えさせる。返るのはUSIの指し手か 'resign' / 'win'。
   * @param {string} sfen 41手目局面のSFEN（布石フェーズが作ったもの）
   * @param {string[]} moves そこからの指し手
   */
  bestMove(opts) {
    // 表示のための解析が走っていたら切り上げる。対局の手をそのぶん待たせない。
    this.stopSearch();
    return this._go(opts);
  }

  /** 表示のためだけの解析。指し手は使わず、深さ・NPS・読み筋だけ取る。 */
  async analyze(opts) {
    return (await this._go(opts)).info;
  }

  terminate() { this.module.terminate(); }
}

function parseInfo(line) {
  const depth = line.match(/depth (\d+)/);
  const score = line.match(/score (cp|mate) (-?\d+)/);
  const nps = line.match(/nps (\d+)/);
  // pv は行末まで取る。USIの規約上 pv の後ろに別のトークンは来ない。
  const pv = line.match(/ pv (.+)$/);
  return {
    depth: depth ? Number(depth[1]) : undefined,
    scoreKind: score ? score[1] : undefined,
    score: score ? Number(score[2]) : undefined,
    nps: nps ? Number(nps[1]) : undefined,
    pv: pv ? pv[1].trim().split(/\s+/) : undefined,
  };
}
