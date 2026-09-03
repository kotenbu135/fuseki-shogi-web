// 両玉先置きモード（開発リポジトリ docs/rules.md「両玉先置きモード」）の置く役と選ぶ役。
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
   * 置く役。釣り合いの帯（|V − 0.5| が誤差の範囲）から一様に1組引く。
   * 帯が空なら |V − 0.5| 最小の組。返り値は [先手玉のマス, 後手玉のマス]。
   * 帯の中でランダムなのは多様性の供給源であって、決定的にしないこと。
   */
  placerPick(rng = Math.random) {
    const band = this.data.band;
    if (band.length) return band[Math.floor(rng() * band.length)].split(',');
    let best = null;
    for (const [key, p] of Object.entries(this.data.pairs))
      if (!best || Math.abs(p.v - 0.5) < Math.abs(best.v - 0.5)) best = { key, v: p.v };
    return best.key.split(',');
  }

  /** 選ぶ役。先手勝率が 50% を超えていれば先手側。 */
  chooserPick(kb, kw) {
    return this.v(kb, kw) > 0.5 ? 'sente' : 'gote';
  }
}
