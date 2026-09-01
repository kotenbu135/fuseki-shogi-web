// 布石フェーズの局面。ルール（合法手・二歩回避の禁じ手・利きの判定・特徴量抽出）は
// すべて wasm/ のC++実装に委ね、このファイルは呼び出し規約だけを持つ。
//
// JS側でルールを書き直さないのは wasm/build.sh と同じ理由による。62プレーンの特徴量や
// 禁じ手判定がC++版と静かにズレると、方策は「動くが弱い」という気付きにくい壊れ方をする。
// したがってここには盤面の配列も利きの計算も置かない。局面の実体はWASM側に1つだけある。

// cppshogi の Color（engine/dlshogi/cppshogi/color.hpp）
export const BLACK = 0;
export const WHITE = 1;

// cppshogi の PieceType（engine/dlshogi/cppshogi/piece.hpp）。布石で打てるのはこの8種。
// USI文字との対応は load() 時に fw_move_to_usi で照合する（enumがズレたら起動時に落とす）。
const PIECE_TYPES = [
  { pt: 1, usi: 'P', role: 'pawn' },
  { pt: 2, usi: 'L', role: 'lance' },
  { pt: 3, usi: 'N', role: 'knight' },
  { pt: 4, usi: 'S', role: 'silver' },
  { pt: 5, usi: 'B', role: 'bishop' },
  { pt: 6, usi: 'R', role: 'rook' },
  { pt: 7, usi: 'G', role: 'gold' },
  { pt: 8, usi: 'K', role: 'king' },
];

const ROLE_OF_PT = new Map(PIECE_TYPES.map(p => [p.pt, p.role]));
const PT_OF_USI = new Map(PIECE_TYPES.map(p => [p.usi, p.pt]));

/** 布石方策のネット入力の形。ONNXの input1/input2 と一致していなければならない。 */
export const FEATURE_PLANES = { input1: 62, input2: 59, squares: 81 };

export class Fuseki {
  /**
   * @param {string} moduleUrl wasm/dist/fuseki.mjs のURL。バンドルに巻き込むと
   *   fuseki.wasm の解決先が壊れるため、静的importではなく動的importで読む。
   */
  static async load(moduleUrl) {
    const { default: FusekiModule } = await import(moduleUrl);
    const M = await FusekiModule();
    M.ccall('fw_init', null, [], []);

    // 特徴量の形がONNXの入力と一致していること。wasmを再ビルドしてここがズレると
    // 推論は成功したまま方策だけが壊れるので、起動時に落とす。
    const f1 = M.ccall('fw_features1_len', 'number', [], []);
    const f2 = M.ccall('fw_features2_len', 'number', [], []);
    const want1 = FEATURE_PLANES.input1 * FEATURE_PLANES.squares;
    const want2 = FEATURE_PLANES.input2 * FEATURE_PLANES.squares;
    if (f1 !== want1 || f2 !== want2)
      throw new Error(`特徴量の形が合わない: features1=${f1}(期待${want1}) features2=${f2}(期待${want2})`);

    // PieceType enum とUSI文字の対応。ズレていれば駒種を取り違える。
    for (const { pt, usi } of PIECE_TYPES) {
      const got = M.ccall('fw_move_to_usi', 'string', ['number', 'number'], [pt, 0]);
      if (got[0] !== usi) throw new Error(`PieceTypeの対応がズレている: pt=${pt} は '${got[0]}' で '${usi}' ではない`);
    }
    return new Fuseki(M);
  }

  constructor(M) {
    this.M = M;
    this._f1ptr = M.ccall('fw_features1_ptr', 'number', [], []);
    this._f2ptr = M.ccall('fw_features2_ptr', 'number', [], []);
    this._f1len = M.ccall('fw_features1_len', 'number', [], []);
    this._f2len = M.ccall('fw_features2_len', 'number', [], []);
    this.reset();
  }

  reset() { this.M.ccall('fw_reset', null, [], []); }

  get ply() { return this.M.ccall('fw_ply', 'number', [], []); }
  get turn() { return this.M.ccall('fw_turn', 'number', [], []); }
  get isPlacementDone() { return this.M.ccall('fw_is_placement_done', 'number', [], []) === 1; }

  /** 色cの玉が相手の利きに当たっているか。41手目の裁定に使う。 */
  isKingAttacked(color) {
    return this.M.ccall('fw_is_king_attacked', 'number', ['number'], [color]) === 1;
  }

  /** 手番側の合法な駒打ち。[{usi, pt, sq, role}] を返す。 */
  legalDrops() {
    const M = this.M;
    const n = M.ccall('fw_legal_drops', 'number', [], []);
    const ptPtr = M.ccall('fw_drops_pt_ptr', 'number', [], []);
    const sqPtr = M.ccall('fw_drops_sq_ptr', 'number', [], []);
    // ALLOW_MEMORY_GROWTH でHEAPのビューは差し替わりうるので、都度取り直す。
    const pts = M.HEAP32.subarray(ptPtr >> 2, (ptPtr >> 2) + n);
    const sqs = M.HEAP32.subarray(sqPtr >> 2, (sqPtr >> 2) + n);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const pt = pts[i], sq = sqs[i];
      out[i] = {
        pt, sq,
        role: ROLE_OF_PT.get(pt),
        usi: M.ccall('fw_move_to_usi', 'string', ['number', 'number'], [pt, sq]),
      };
    }
    return out;
  }

  /**
   * 駒を打つ。legalDrops() が返した手そのもの、またはそのUSI文字列を受ける。
   * USIで渡された場合は合法手の一覧との照合を兼ねる（人間の入力はここを通す）。
   */
  drop(move) {
    const found = typeof move === 'string' ? this.legalDrops().find(d => d.usi === move) : move;
    if (!found) throw new Error(`布石フェーズの合法手ではない: ${move}`);
    this.M.ccall('fw_do_drop', null, ['number', 'number'], [found.pt, found.sq]);
    return found;
  }

  /** 色cの持ち駒の残数。role -> 枚数。 */
  remaining(color) {
    const hand = new Map();
    for (const { pt, role } of PIECE_TYPES) {
      const n = this.M.ccall('fw_remaining', 'number', ['number', 'number'], [color, pt]);
      if (n > 0) hand.set(role, n);
    }
    return hand;
  }

  /** 40手完了後のSFEN。通常フェーズへそのまま渡せる。 */
  toSfen() { return this.M.ccall('fw_to_sfen', 'string', [], []); }

  /** 「手番側が相手玉を取れる」局面を弾く検査。通常フェーズへ渡す前の最後の門。 */
  verifyFinalSfen(sfen) {
    return this.M.ccall('fw_verify_final_sfen', 'number', ['string'], [sfen]) === 1;
  }

  /** 方策の入力。ONNXへ渡すためHEAPのビューではなくコピーを返す。 */
  policyInputs() {
    const M = this.M;
    M.ccall('fw_make_features', null, [], []);
    return {
      input1: M.HEAPF32.slice(this._f1ptr >> 2, (this._f1ptr >> 2) + this._f1len),
      input2: M.HEAPF32.slice(this._f2ptr >> 2, (this._f2ptr >> 2) + this._f2len),
    };
  }

  /** 指し手 (pt, sq) が方策出力2268次元のどこに載るか。 */
  moveLabel(pt, sq, color) {
    return this.M.ccall('fw_move_label', 'number', ['number', 'number', 'number'], [pt, sq, color]);
  }
}

export { PIECE_TYPES, PT_OF_USI, ROLE_OF_PT };
