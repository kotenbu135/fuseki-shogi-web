// 天秤将棋（開発リポジトリ docs/rules.md「天秤将棋」）の置く役と選ぶ役。
//
// どちらも新しいエンジンではなく、**両玉のマスの組の価値表** V(kb, kw) を引くだけ。
// V は「先手玉を kb、後手玉を kw に置き、以後を布石エンジンが置き、41手目から
// やねうら王が指したときの先手勝率」（36×36 = 1,296組）。
//
// **帯の48組だけは実対局の勝敗そのもの**（1組600局以上）で、残りはロールアウトを
// やねうら王で採点した値。置く役が引くのは帯だけなので、そこだけ実測に替えてある。
// ロールアウト由来のVは帯の中では当たらない（範囲制限で相関が潰れる）。
//
// 表は布石エンジンに従属する。エンジンを差し替えたら表も作り直す必要があり、
// 世代がずれていれば load() が落とす（置く役が偏った組を置き続ける壊れ方をするため）。
// 置く役が引く組の数。**開発リポジトリ scripts/kings_first_arena.py の
// `--pool-size` と対の値**で、片方だけ変えるとアリーナがサイトを測らなくなる。
//
// 10 / 32 / 48 組を実対局で比べ、48組が最良だった（先手勝率 47.0 / 47.1 / 48.3%、
// 最善を尽くす選ぶ役の取り分 55.1 / 55.5 / 53.8%）。差はいずれも1σ前後で有意ではないが、
// 「広げると釣り合いが崩れる」証拠は無かったので、多様性の大きいほうを取る。
const POOL_SIZE = 48;

export class KingTable {
  /**
   * @param {string} url 表のJSON
   * @param {{modelFile?: string}} [opts] 布石エンジンのファイル名。世代（iterN）を突き合わせる
   */
  static async load(url, opts = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`両玉の価値表を読めない: ${res.status} ${url}`);
    return new KingTable(await res.json(), opts);
  }

  constructor(data, { modelFile } = {}) {
    if (data?.format !== 'king_pair_table/1')
      throw new Error(`両玉の価値表の形式が違う: ${data?.format}`);
    if (!data.pairs || !Array.isArray(data.band))
      throw new Error('両玉の価値表に pairs / band が無い');
    if (modelFile) {
      const gen = s => (String(s).match(/iter(\d+)/) ?? [])[1];
      if (gen(modelFile) !== gen(data.model))
        throw new Error(`両玉の価値表（${data.model}）と布石エンジン（${modelFile}）の世代が違う`);
    }
    this.data = data;
  }

  /** 先手玉 kb・後手玉 kw（USIのマス、例 '5i' と '5a'）のときの先手勝率。 */
  v(kb, kw) {
    const p = this.data.pairs[`${kb},${kw}`];
    if (!p) throw new Error(`両玉の価値表に無い組: ${kb},${kw}`);
    return p.v;
  }

  /**
   * 置く役。釣り合いの帯のうち、**最も釣り合う組**から一様に1組引く。
   * 返り値は [先手玉のマス, 後手玉のマス]。
   *
   * 帯の定義は |V − 0.5| <= max(band_floor, 2·SE) で、幅の大半は band_floor（設計上の
   * 許容＝1pt）ではなく 2·SE、つまり**こちらの測定誤差**で決まっている。iter171 の表では
   * 2·SE ≈ 4.4pt もあり、帯156組から一様に引くと平均 |V − 0.5| ぶんを選ぶ役に献上する。
   * 実測（開発リポジトリ scripts/kings_first_arena.py、やねうら王200k）:
   *
   *   置く役の戦略                     置く役の勝率
   *   ランダム（36×36一様）      800局   23.8% ± 1.5
   *   帯156組から一様            4000局   46.3% ± 0.8   ← 以前の実装。選ぶ役に4.6σで負ける
   *   band_floor 以内の21組      4200局   （下の SHIPPED_PLACER_RATE）
   *
   * 測定誤差が広げた幅を置く役が使う理由は無いので band_floor まで絞る。ただし多様性は
   * 残す（決定的にすると毎局同じ玉の組になる）ので、絞った集合の中では一様に引き、
   * 集合が小さすぎるときは帯の中で釣り合う順に MIN_POOL 組まで広げる。
   */
  placerPick(rng = Math.random) {
    const pool = this.balancedPool();
    if (!pool.length) {
      let best = null;
      for (const [key, p] of Object.entries(this.data.pairs))
        if (!best || Math.abs(p.v - 0.5) < Math.abs(best.v - 0.5)) best = { key, v: p.v };
      return best.key.split(',');
    }
    return pool[Math.floor(rng() * pool.length)].split(',');
  }

  /** 置く役が引く候補。帯のうち、釣り合う順に POOL_SIZE 組。
   *
   * 以前は |V − 0.5| <= band_floor だけで絞っていた。帯そのものが
   * |V − 0.5| <= max(band_floor, 2SE) で決まるので、この規則だと
   * **集合の大きさがその表の測定誤差で決まってしまう**（同じ規則で 10組にも
   * 23組にもなった）。組数を固定すれば、世代が変わっても置く役の引き出しは
   * 同じ広さになる。上限は帯そのもの（誤差ぶんより外へは出ない）。
   */
  balancedPool() {
    const dist = k => Math.abs(this.data.pairs[k].v - 0.5);
    const band = this.data.band.filter(k => this.data.pairs[k]);
    return [...band].sort((a, b) => dist(a) - dist(b)).slice(0, Math.min(POOL_SIZE, band.length));
  }

  /** 選ぶ役。先手勝率が 50% を超えていれば先手側。 */
  chooserPick(kb, kw) {
    return this.v(kb, kw) > 0.5 ? 'sente' : 'gote';
  }
}
