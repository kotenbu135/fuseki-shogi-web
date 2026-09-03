// 1対局分の状態機械。局面の真実を持つのはこのクラスだけで、shogigroundは表示、
// エンジンは「手の候補を言うだけの相手」として扱う。
//
// フェーズごとにルールの持ち主が違う:
//   布石フェーズ(1〜40手) … WASM（cppshogi）。合法手も利きも特徴量もここが出す。
//   通常フェーズ(41手目〜) … shogiops。
// その境目にある41手目の裁定だけがどちらにも属さないので、このファイルが持つ。
import { makeSfen, parseSfen } from 'shogiops/sfen';
import { parseUsi, makeSquareName, parseSquareName } from 'shogiops/util';
import { pieceCanPromote, pieceForcePromote, promote, unpromote } from 'shogiops/variant/util';
import { makeJapaneseMoveOrDrop } from 'shogiops/notation/japanese';
import { makeJapaneseSquare, roleToKanji } from 'shogiops/notation/util';
import { BLACK, WHITE } from './fuseki.js';

export const SENTE = 'sente';
export const GOTE = 'gote';

/** cppshogi の Color を shogiops / shogiground の色名へ。両者は同じ語彙を使っている。 */
const COLOR_NAME = [SENTE, GOTE];

const canPromote = pieceCanPromote('standard');
const forcePromote = pieceForcePromote('standard');
const promoteRole = promote('standard');
const unpromoteRole = unpromote('standard');
const kanjiOf = roleToKanji('standard');
const MARK = { [SENTE]: '▲', [GOTE]: '△' };

export class Game {
  /**
   * @param {Fuseki} fuseki 布石フェーズの局面（WASM）
   * @param {FusekiPolicy} policy 布石フェーズのAI
   * @param {NormalEngine} engine 通常フェーズのAI
   * @param {'sente'|'gote'} humanColor 通常モードの人間の色。両玉先置きでは選択まで未定
   * @param {'standard'|'kings-first'} [mode] 両玉先置き（docs/rules.md「両玉先置きモード」）
   * @param {'placer'|'chooser'|null} [humanRole] 両玉先置きでの人間の役
   * @param {import('./kings.js').KingTable|null} [kingTable] 置く役・選ぶ役のAIが引く価値表
   */
  constructor({ fuseki, policy, engine, humanColor = SENTE, movetimeMs = 1000, temperature = 1,
                mode = 'standard', humanRole = null, kingTable = null, rng = Math.random }) {
    this.fuseki = fuseki;
    this.policy = policy;
    this.engine = engine;
    this.mode = mode;
    this.kingTable = kingTable;
    this.rng = rng;
    if (mode === 'kings-first') {
      if (humanRole !== 'placer' && humanRole !== 'chooser')
        throw new Error(`両玉先置きの人間の役は placer か chooser: ${humanRole}`);
      this.humanRole = humanRole;
      // 色は選ぶ役が決めるまで無い。役（置く役・選ぶ役）と色（先手・後手）は別物で、
      // 一致するとは限らない。
      this.humanColor = null;
    } else {
      this.humanRole = null;
      this.humanColor = humanColor;
    }
    this.movetimeMs = movetimeMs;
    // 布石方策のサンプリング温度。1より下げないこと（policy.js 冒頭）。
    // 弱くする方向にだけ使い、強くする側は movetimeMs で作る。
    this.temperature = temperature;
    // 待った（undoTo）で局面を作り直した回数。AIが考えている最中に戻されたかを
    // 見分けるためだけに使う。phase を見るだけでは足りない（undoTo の注記を参照）。
    this.epoch = 0;

    // 'kings' | 'choose' | 'fuseki' | 'normal' | 'over'。kings と choose は両玉先置きだけ。
    this.phase = mode === 'kings-first' ? 'kings' : 'fuseki';
    this.chosen = null;              // 両玉先置きで選ばれた側（'sente'|'gote'）
    this._aiKingsPlan = null;        // AIの置く役が決めた両玉のマス [先手玉, 後手玉]
    this.fusekiMoves = [];           // USIの駒打ち列（例: "P*5e"）
    this.normalMoves = [];           // 41手目以降のUSI
    this.position = null;            // shogiops の Position（通常フェーズのみ）
    this.finalSfen = null;           // 41手目局面のSFEN
    this.result = null;              // { winner: 'sente'|'gote'|null, reason: string }
    this.lastDests = [];             // 直前の着手のマス（表示用）
    this.lastEval = null;            // 直近のAIの評価（表示用）
    this.kifu = [];                  // { ply, color, text, usi } 表示用の棋譜
    this._lastDestSquare = undefined;// 「同」の判定に使う直前の着手先

    this.fuseki.reset();
    this.boardPieces = new Map();    // 布石フェーズの表示用。打った手をそのまま並べるだけ。
  }

  // ---- 手番 ----

  get turnColor() {
    if (this.phase === 'kings' || this.phase === 'fuseki') return COLOR_NAME[this.fuseki.turn];
    if (this.phase === 'normal') return this.position.turn;
    return null;   // 選択の最中と終局後
  }

  /** 人間が動く番か。両玉先置きの冒頭は役で決まり、色では決まらない。 */
  get isHumanTurn() {
    if (this.phase === 'kings') return this.humanRole === 'placer';
    if (this.phase === 'choose') return this.humanRole === 'chooser';
    return this.phase !== 'over' && this.turnColor === this.humanColor;
  }
  get aiColor() {
    if (this.humanColor === null) return null;
    return this.humanColor === SENTE ? GOTE : SENTE;
  }
  /**
   * 盤で人間が触れる駒の色。置く役は自分の色に関わらず手番の色の玉を置く
   * （1手目は先手の駒台の玉、2手目は後手の駒台の玉）。
   */
  get activeColor() {
    if (this.phase === 'kings') return this.humanRole === 'placer' ? this.turnColor : undefined;
    if (this.phase === 'fuseki' || this.phase === 'normal') return this.humanColor ?? undefined;
    return undefined;
  }
  get ply() { return this.position ? 40 + this.normalMoves.length + 1 : this.fuseki.ply + 1; }
  /** 指し手の数。棋譜の行数とは違う（両玉先置きは選択の行が1つ挟まる）。 */
  get moveCount() { return this.fusekiMoves.length + this.normalMoves.length; }
  /** 両玉先置きで置かれた両玉のマス（USI）。まだなら null。 */
  get kingSquares() {
    return {
      sente: this.fusekiMoves[0]?.slice(2) ?? null,
      gote: this.fusekiMoves[1]?.slice(2) ?? null,
    };
  }

  // ---- 盤の表示状態（ルールは含まない） ----

  // 盤と持ち駒の取り出しは phase ではなく position の有無で分ける。
  // 布石フェーズの途中で投了すると phase は 'over' になるが position は null のままで、
  // phase で分けると makeSfen(null) を呼んで落ちる（盤が固まり、新規対局も始められなくなる）。
  // position があるのは41手目の移行を通ったときだけなので、これが正しい判定になる。
  boardSfen() {
    if (!this.position) return boardMapToSfen(this.boardPieces);
    return makeSfen(this.position).split(' ')[0];
  }

  /** 持ち駒。布石フェーズは「まだ打っていない駒」、通常フェーズは取った駒。 */
  /**
   * 棋譜から局面を戻すための控え。過去の局面は指し手から再生できない
   * （布石フェーズにはPositionが無く、通常フェーズも41手目の局面を作り直す必要がある）ので、
   * 1手ごとにそのときの盤と駒台をそのまま取っておく。1局200手でも数十KBに収まる。
   * Mapは持ち回すと後で書き換わるおそれがあるので、必ず複製する。
   */
  _snapshot() {
    return {
      board: this.boardSfen(),
      hands: new Map([...this.hands()].map(([color, m]) => [color, new Map(m)])),
      lastDests: [...this.lastDests],
    };
  }

  hands() {
    if (!this.position)
      return new Map([[SENTE, this.fuseki.remaining(BLACK)], [GOTE, this.fuseki.remaining(WHITE)]]);
    const toMap = color => new Map([...this.position.hands[color]].filter(([, n]) => n > 0));
    return new Map([[SENTE, toMap(SENTE)], [GOTE, toMap(GOTE)]]);
  }

  /** shogiground の droppable.dests。手番側の駒打ちのみを入れる。 */
  dropDests() {
    const dests = new Map();
    // 選択の最中は手番が無く、position も無い。else 側へ落ちると null を叩く。
    if (this.phase === 'over' || this.phase === 'choose') return dests;
    const color = this.turnColor;
    if (this.phase === 'kings' || this.phase === 'fuseki') {
      for (const d of this.fuseki.legalDrops()) {
        // 両玉先置きの1・2手目は玉だけ。合法手そのものは変わらない（movegen は無変更）。
        if (this.phase === 'kings' && d.role !== 'king') continue;
        const name = `${color} ${d.role}`;
        if (!dests.has(name)) dests.set(name, []);
        dests.get(name).push(usiDropSquare(d.usi));
      }
    } else {
      for (const [name, squares] of this.position.allDropDests())
        if (name.startsWith(color)) dests.set(name, [...squares].map(makeSquareName));
    }
    return dests;
  }

  /** shogiground の movable.dests。布石フェーズは移動できないので空。 */
  moveDests() {
    const dests = new Map();
    if (this.phase !== 'normal') return dests;
    for (const [from, tos] of this.position.allMoveDests())
      if (tos.nonEmpty()) dests.set(makeSquareName(from), [...tos].map(makeSquareName));
    return dests;
  }

  /** shogiground の成り判定。通常フェーズのルールをshogiopsから引く。 */
  promotion() {
    const pieceAt = key => this.position?.board.get(parseSquareName(key));
    return {
      movePromotionDialog: (orig, dest) => {
        if (this.phase !== 'normal') return false;
        const piece = pieceAt(orig);
        if (!piece) return false;
        const from = parseSquareName(orig), to = parseSquareName(dest);
        return canPromote(piece, from, to, this.position.board.get(to)) && !forcePromote(piece, to);
      },
      forceMovePromotion: (orig, dest) => {
        if (this.phase !== 'normal') return false;
        const piece = pieceAt(orig);
        return !!piece && forcePromote(piece, parseSquareName(dest));
      },
      dropPromotionDialog: () => false,
      forceDropPromotion: () => false,
      // shogigroundの既定は promotesTo: () => undefined で、これを渡さないと
      // basePromotionDialog() が常に false を返し、成りのダイアログが開かない。
      promotesTo: promoteRole,
      unpromotesTo: unpromoteRole,
    };
  }

  checks() {
    return this.phase === 'normal' && this.position.isCheck() ? this.position.turn : false;
  }

  // ---- 人間の着手 ----

  /** 布石フェーズ。usi は "P*5e" 形式。合法性はWASMの合法手一覧と照合される。 */
  playFusekiDrop(usi) {
    this._assertTurn(['kings', 'fuseki']);
    if (this.phase === 'kings' && !usi.startsWith('K*'))
      throw new Error(`両玉先置きの1・2手目に置けるのは玉だけ: ${usi}`);
    const move = this.fuseki.drop(usi);      // 非合法ならここで例外
    this._recordFusekiMove(move);
  }

  /** 両玉先置きの選択。選ぶ役が先手側か後手側かを宣言する。局面は変わらない。 */
  choose(side) {
    this._assertTurn('choose');
    if (side !== SENTE && side !== GOTE) throw new Error(`選べるのは先手側か後手側: ${side}`);
    const actor = this.humanRole === 'chooser' ? 'human' : 'ai';
    this.chosen = side;
    this.humanColor = this.humanRole === 'chooser' ? side : (side === SENTE ? GOTE : SENTE);
    this.phase = 'fuseki';
    // 棋譜には1行として残す。手数は持たない（3手目は次の駒打ち）。
    this.kifu.push({
      ply: null, color: side, usi: `choose:${side}`, actor,
      text: `${MARK[side]}側を選択`, snapshot: this._snapshot(),
    });
  }

  /**
   * 手順のトークンを1つ適用する。待った（undoTo）と手順の読み込みが使う。
   * 駒打ち "P*5e"、通常の指し手 "7g7f"、両玉先置きの選択 "choose:sente"。
   */
  play(token) {
    if (token.startsWith('choose:')) {
      if (this.mode !== 'kings-first') throw new Error('選択（choose:）は両玉先置きの手順にしか無い');
      return this.choose(token.slice('choose:'.length));
    }
    if (this.phase === 'kings' || this.phase === 'fuseki') return this.playFusekiDrop(token);
    if (this.phase === 'normal') return this.playNormalMove(token);
    throw new Error(`${this.phase === 'choose' ? '側を選ぶ前' : '終局後'}に指し手は入れられない: ${token}`);
  }

  /** 手順。棋譜の行と1対1で、両玉先置きでは2手目の後に選択のトークンが挟まる。 */
  tokens() {
    const f = this.fusekiMoves;
    const head = this.chosen ? [...f.slice(0, 2), `choose:${this.chosen}`, ...f.slice(2)] : [...f];
    return [...head, ...this.normalMoves];
  }

  /** 通常フェーズ。usi は "7g7f" / "P*5e" 形式。 */
  playNormalMove(usi) {
    this._assertTurn('normal');
    const md = parseUsi(usi);
    if (!md || !this.position.isLegal(md)) throw new Error(`通常フェーズの合法手ではない: ${usi}`);
    this._applyNormalMove(usi, md);
  }

  // ---- AIの着手 ----

  /** 手番側の手をAIに指させる。返り値は表示用の情報。 */
  async playAiMove() {
    if (this.phase === 'kings') return this._aiKingsMove();
    if (this.phase === 'choose') return this._aiChoose();
    if (this.phase === 'fuseki') return this._aiFusekiMove();
    if (this.phase === 'normal') return this._aiNormalMove();
    return null;
  }

  /**
   * AIの置く役。1手目で両玉の組を価値表から引き、2手目はその続き。
   * 探索はしない（表を引くだけ）。表が無ければ両玉先置きは始められない。
   */
  _aiKingsMove() {
    if (!this.kingTable) throw new Error('両玉の価値表が読み込まれていない');
    const n = this.fusekiMoves.length;
    if (n === 0) this._aiKingsPlan = this.kingTable.placerPick(this.rng);
    if (!this._aiKingsPlan) throw new Error('AIの両玉の予定が無い（1手目の前に局面が変わった）');
    this._recordFusekiMove(this.fuseki.drop(`K*${this._aiKingsPlan[n]}`));
    if (this.phase !== 'choose') return null;
    const { sente, gote } = this.kingSquares;
    this.lastEval = { kind: 'kings', winRate: this.kingTable.v(sente, gote) };
    return this.lastEval;
  }

  /** AIの選ぶ役。表の先手勝率が 50% を超えていれば先手側。 */
  _aiChoose() {
    if (!this.kingTable) throw new Error('両玉の価値表が読み込まれていない');
    const { sente, gote } = this.kingSquares;
    this.choose(this.kingTable.chooserPick(sente, gote));
    this.lastEval = { kind: 'kings', winRate: this.kingTable.v(sente, gote) };
    return this.lastEval;
  }

  async _aiFusekiMove() {
    const epoch = this.epoch;
    const picked = await this.policy.pick(this.fuseki, { temperature: this.temperature });
    // 考えている間に終局していたら捨てる。epoch も見るのは、待ったで局面を
    // 作り直されても phase は 'fuseki' のままだから。Fuseki.drop() は
    // legalDrops() が返した手そのものを渡されると照合を飛ばして fw_do_drop を
    // 直に呼ぶので、古い局面のために選んだ手が例外も出さずに盤へ入る。
    if (this.epoch !== epoch || this.phase !== 'fuseki') return null;
    this.fuseki.drop(picked.move);
    this._recordFusekiMove(picked.move);
    // 40手目なら _recordFusekiMove の中で通常フェーズへ移っている（_transitionToNormal）。
    // その場合は布石の評価を残さない。残すと、41手目の人間の手番でフェーズだけ「通常」に
    // 変わり、評価には布石の「採用手の確率」が出たままになる。
    if (this.phase !== 'fuseki') return null;
    this.lastEval = { kind: 'policy', winRate: picked.value, probability: picked.probability, candidates: picked.candidates };
    return this.lastEval;
  }

  async _aiNormalMove() {
    const epoch = this.epoch;
    const { usi, info } = await this.engine.bestMove({
      sfen: this.finalSfen, moves: this.normalMoves, movetimeMs: this.movetimeMs,
    });
    // 待ったで戻されていたら捨てる。ここを見ないと、古い局面の手が isLegal で
    // 弾かれて「エンジンが非合法手を返した」負けに化ける。
    if (this.epoch !== epoch || this.phase !== 'normal') return null;
    if (usi === 'resign') { this._end(this.humanColor, 'ai_resign'); return null; }
    if (usi === 'win') { this._end(this.aiColor, 'ai_nyugyoku_declaration'); return null; }
    const md = parseUsi(usi);
    // やねうら王のbestmoveをそのまま信じない。非合法手を適用すると盤が静かに壊れる。
    if (!md || !this.position.isLegal(md)) { this._end(this.humanColor, 'engine_illegal_move'); return null; }
    const mover = this.aiColor;
    this._applyNormalMove(usi, md);
    // side は「この評価値が誰から見た値か」。USIの score は探索した側から見た値で、
    // ここではAI。人間の手番に画面が聞いたぶんは main.js が humanColor を入れる。
    this.lastEval = { kind: 'search', ...info, side: mover };
    return this.lastEval;
  }

  // ---- 内部 ----

  _assertTurn(phase) {
    const want = Array.isArray(phase) ? phase : [phase];
    if (!want.includes(this.phase))
      throw new Error(`${want.join('/')}フェーズではない（現在: ${this.phase}）`);
  }

  _recordFusekiMove(move) {
    const color = COLOR_NAME[this.fusekiMoves.length % 2];
    // 誰の手か。待ったが「自分の直前の一手」を探すのに使う。両玉先置きの置く役は
    // 両方の色の玉を置くので、色から人間の手かは決まらない。役で決める。
    const actor = this.phase === 'kings'
      ? (this.humanRole === 'placer' ? 'human' : 'ai')
      : (color === this.humanColor ? 'human' : 'ai');
    const key = usiDropSquare(move.usi);
    const square = parseSquareName(key);
    this.kifu.push({
      ply: this.fusekiMoves.length + 1, color, usi: move.usi, actor,
      text: `${MARK[color]}${fusekiDropText(move.usi, move.role)}打`,
    });
    this.fusekiMoves.push(move.usi);
    this.boardPieces.set(key, { role: move.role, color });
    this.lastDests = [key];
    this._lastDestSquare = square;
    // 控えは _transitionToNormal() の前に取る。40手目の控えは布石が終わった
    // 時点の盤で、41手目の裁定より前の姿でなければならない。
    this.kifu[this.kifu.length - 1].snapshot = this._snapshot();
    // 両玉が置かれたら選択へ。盤も手番も変えない（3手目は先手番のまま）。
    if (this.phase === 'kings' && this.fusekiMoves.length === 2) {
      this.phase = 'choose';
      return;
    }
    if (this.fuseki.isPlacementDone) this._transitionToNormal();
  }

  _transitionToNormal() {
    // 41手目の裁定（docs/rules.md）: 40手完了時点で手番側が相手玉を取れるなら手番側の勝ち。
    //
    // これを Position を作る前に置くのが要点。shogiops には chessops の
    // ignoreImpossibleCheck 相当が無く、その局面は parseSfen が ERR_OPPOSITE_CHECK で
    // 弾く（test/shogiops_smoke.mjs の 80件中1件がこれ）。裁定を後回しにすると、
    // 「勝敗が確定している局面」が「SFENの解析エラー」として出てくる。
    const mover = this.fuseki.turn;
    if (mover !== BLACK) throw new Error(`40手完了時の手番が先手でない（turn=${mover}）`);
    if (this.fuseki.isKingAttacked(1 - mover)) {
      this._end(COLOR_NAME[mover], 'fuseki_king_capture');
      return;
    }

    const sfen = this.fuseki.toSfen();
    // 裁定を通ったのに弾かれるなら、裁定と検査のどちらかが壊れている。握り潰さない。
    if (!this.fuseki.verifyFinalSfen(sfen)) throw new Error(`41手目の裁定を通ったSFENが検査で弾かれた: ${sfen}`);
    const parsed = parseSfen('standard', sfen, false);
    if (parsed.isErr) throw new Error(`41手目局面をshogiopsが受理しない: ${parsed.error} / ${sfen}`);

    this.position = parsed.unwrap();
    this.finalSfen = sfen;
    this.phase = 'normal';
    this.engine?.newGame();
    // 布石フェーズの評価を持ち越さない。価値ヘッドの無いネットでは布石の評価は
    // 「採用手の確率」で、通常フェーズの評価（やねうら王の評価値）とは別物。
    // 消さないと、41手目の人間の手番でフェーズだけ「通常」に変わり、評価には
    // 布石の確率が出たままになる。
    this.lastEval = null;

    // 布石フェーズは王手放置を見ないため、40手完了時点で既に詰んでいることがある
    // （webapp/backend/game.py と同じ理由。ここで見ないと「AIの投了」に化ける）。
    this._checkNormalGameOver();
  }

  _applyNormalMove(usi, md) {
    // 棋譜の文字列は指す前の局面でないと作れない（どの駒が動いたかの区別が要る）。
    const color = this.position.turn;
    const text = makeJapaneseMoveOrDrop(this.position, md, this._lastDestSquare);
    // 駒を取ったかは指す前にしか分からない。音を出し分けるのに使う。
    const capture = this.position.board.get(md.to) !== undefined;
    this.position.play(md);
    this.kifu.push({
      ply: 40 + this.normalMoves.length + 1, color, usi, capture,
      actor: color === this.humanColor ? 'human' : 'ai',
      text: `${MARK[color]}${text ?? usi}`,
    });
    this.normalMoves.push(usi);
    this._lastDestSquare = md.to;
    this.lastDests = 'from' in md
      ? [makeSquareName(md.from), makeSquareName(md.to)]
      : [makeSquareName(md.to)];
    this.kifu[this.kifu.length - 1].snapshot = this._snapshot();
    this._checkNormalGameOver();
  }

  _checkNormalGameOver() {
    const outcome = this.position.outcome();
    if (outcome) this._end(outcome.winner ?? null, outcome.result);
  }

  /**
   * winnerIs は「人間とAIのどちらが勝ったか」。両玉先置きで側を選ぶ前に投了すると
   * 勝った色が無い（winner が null）ので、色とは別に持つ。
   */
  _end(winner, reason, winnerIs) {
    this.phase = 'over';
    if (winnerIs === undefined)
      winnerIs = winner === null ? null : winner === this.humanColor ? 'human' : 'ai';
    this.result = { winner, reason, winnerIs };
  }

  resign() {
    if (this.phase !== 'over') this._end(this.aiColor, 'human_resign', 'ai');
  }

  /**
   * 人間の持ち時間が切れた。時計はUI側（main.js）が持っているので、判定もあちらから呼ぶ。
   * 布石将棋そのものに時間切れ負けのルールは無く、これは対局画面が乗せている取り決め。
   */
  timeout() {
    if (this.phase !== 'over') this._end(this.aiColor, 'human_timeout', 'ai');
  }

  /**
   * 読み筋を日本語の指し手に直す。いまの局面の複製を1手ずつ進めて作る。
   * 別の局面の読み筋が遅れて届くことがあるので、非合法手に当たったらそこで止める
   * （途中まででも読める。例外にすると表示だけのために対局が止まる）。
   */
  pvText(pv) {
    if (!this.position || !pv?.length) return '';
    const pos = this.position.clone();
    let lastDest = this._lastDestSquare;
    const out = [];
    for (const usi of pv) {
      const md = parseUsi(usi);
      if (!md || !pos.isLegal(md)) break;
      const color = pos.turn;
      const text = makeJapaneseMoveOrDrop(pos, md, lastDest);
      out.push(`${MARK[color]}${text ?? usi}`);
      pos.play(md);
      lastDest = md.to;
    }
    return out.join(' ');
  }

  /**
   * 表示・共有用のSFEN。
   *
   * **布石フェーズのものは布石将棋の拡張**で、持ち駒に玉が入る。ふつうの将棋ソフトでは
   * 読めない。41手目以降は標準のSFENなのでそのまま読める。
   *
   * fuseki.toSfen() は使わない。あちらはまだ打っていない駒を落として持ち駒を '-' にする
   * （ply5 で `9/5g3/4p4/9/9/9/4P4/5G3/4K4 w - 6` が返り、15枚が消える）。
   */
  sfen() {
    if (this.position) return makeSfen(this.position);
    const turn = this.fusekiMoves.length % 2 === 0 ? 'b' : 'w';
    return `${this.boardSfen()} ${handsSfen(this.hands())} ${turn} ${this.fusekiMoves.length + 1}`;
  }

  /**
   * 待った。棋譜の先頭 n 行だけ残して、あとは無かったことにする（n は tokens() の数）。
   *
   * 差分で1手ずつ戻さないのは、布石フェーズのWASMにundoが無い（fuseki.js は
   * fw_reset しか持たない）ため。加えて40/41の境目をまたいで戻すときは
   * position を null に、phase を 'fuseki' に戻す必要があり、全再生ならこの
   * 境目を特別扱いせずに済む。両玉先置きの選択をまたいで戻すときも同じで、
   * 選択より前へ戻れば色は再び未定になる。
   *
   * 再生は安い。布石40手は fw_do_drop を呼ぶだけでNNを通らず、通常フェーズも
   * position.play の再適用だけで、エンジンには一度も問い合わせない。
   * ただし40手目を通ると _transitionToNormal() が usinewgame を再送する。
   */
  undoTo(n) {
    const tokens = this.tokens().slice(0, Math.max(0, n));
    // 先に上げる。これを見てAIが自分の考えた手を捨てる。
    this.epoch++;
    this._reset();
    for (const t of tokens) this.play(t);
  }

  _reset() {
    this.fuseki.reset();
    this.boardPieces.clear();
    this.kifu.length = 0;
    this.fusekiMoves.length = 0;
    this.normalMoves.length = 0;
    this.position = null;
    this.finalSfen = null;
    this.phase = this.mode === 'kings-first' ? 'kings' : 'fuseki';
    this.chosen = null;
    this._aiKingsPlan = null;
    if (this.mode === 'kings-first') this.humanColor = null;
    this.result = null;
    this.lastDests = [];
    this.lastEval = null;
    this._lastDestSquare = undefined;
  }
}

/**
 * 持ち駒のSFEN表記。標準の並び（飛角金銀桂香歩）のあとに玉を足す。
 * 玉が持ち駒に入るのは布石将棋だけなので、この部分が拡張になる。
 */
function handsSfen(hands) {
  const ORDER = ['rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn', 'king'];
  let out = '';
  for (const color of [SENTE, GOTE]) {
    for (const role of ORDER) {
      const n = hands.get(color)?.get(role) ?? 0;
      if (!n) continue;
      const f = FORSYTH[role];
      out += (n > 1 ? n : '') + (color === SENTE ? f.toUpperCase() : f);
    }
  }
  return out || '-';
}

/** 布石の駒打ちの日本語表記（手番の印は付けない）。棋譜と候補手の表示で共有する。 */
export function fusekiDropText(usi, role) {
  return `${makeJapaneseSquare(parseSquareName(usiDropSquare(usi)))}${kanjiOf(role)}`;
}

/** "P*5e" の着手先。USIのマス表記は shogiops / shogiground のマス名と同じ綴り。 */
export function usiDropSquare(usi) { return usi.slice(2); }

const FORSYTH = {
  pawn: 'p', lance: 'l', knight: 'n', silver: 's', gold: 'g',
  bishop: 'b', rook: 'r', king: 'k',
  tokin: '+p', promotedlance: '+l', promotedknight: '+n', promotedsilver: '+s',
  horse: '+b', dragon: '+r',
};

/** 表示用の盤SFEN。Map<key, {role, color}> を並べるだけで、ルールの判断は無い。 */
function boardMapToSfen(pieces) {
  const ranks = [];
  for (const rank of 'abcdefghi') {
    let row = '', empty = 0;
    for (let file = 9; file >= 1; file--) {
      const p = pieces.get(`${file}${rank}`);
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const f = FORSYTH[p.role];
      row += p.color === SENTE ? f.toUpperCase() : f;
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  return ranks.join('/');
}
