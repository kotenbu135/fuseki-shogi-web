// 玉分け将棋（開発リポジトリ docs/rules.md「玉分け将棋」）の置く役と選ぶ役。
//
// どちらも新しいエンジンではなく、**両玉のマスの組の価値表** V(kb, kw) を引くだけ。
// V は「先手玉を kb、後手玉を kw に置き、以後を布石エンジンが置き、41手目から
// やねうら王が指したときの先手勝率」で、開発リポジトリの scripts/king_pair_table.py が
// 布石エンジンのロールアウトをやねうら王で採点して作る（36×36 = 1,296組）。
//
// 表は布石エンジンに従属する。エンジンを差し替えたら表も作り直す必要があり、
// 世代がずれていれば load() が落とす（置く役が偏った組を置き続ける壊れ方をするため）。
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

  /** 置く役が引く候補。帯のうち |V − 0.5| <= band_floor の組（少なければ釣り合う順に補う）。 */
  balancedPool() {
    const MIN_POOL = 8;
    const floor = Number.isFinite(this.data.band_floor) ? this.data.band_floor : 0.01;
    const dist = k => Math.abs(this.data.pairs[k].v - 0.5);
    const band = this.data.band.filter(k => this.data.pairs[k]);
    const near = band.filter(k => dist(k) <= floor);
    if (near.length >= MIN_POOL || near.length === band.length) return near;
    return [...band].sort((a, b) => dist(a) - dist(b)).slice(0, Math.min(MIN_POOL, band.length));
  }

  /** 選ぶ役。先手勝率が 50% を超えていれば先手側。 */
  chooserPick(kb, kw) {
    return this.v(kb, kw) > 0.5 ? 'sente' : 'gote';
  }
}
