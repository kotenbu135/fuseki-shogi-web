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
   * @param {'sente'|'gote'} humanColor
   */
  constructor({ fuseki, policy, engine, humanColor = SENTE, movetimeMs = 1000 }) {
    this.fuseki = fuseki;
    this.policy = policy;
    this.engine = engine;
    this.humanColor = humanColor;
    this.movetimeMs = movetimeMs;

    this.phase = 'fuseki';           // 'fuseki' | 'normal' | 'over'
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
    if (this.phase === 'fuseki') return COLOR_NAME[this.fuseki.turn];
    if (this.phase === 'normal') return this.position.turn;
    return null;
  }

  get isHumanTurn() { return this.phase !== 'over' && this.turnColor === this.humanColor; }
  get aiColor() { return this.humanColor === SENTE ? GOTE : SENTE; }
  get ply() { return this.phase === 'fuseki' ? this.fuseki.ply + 1 : 40 + this.normalMoves.length + 1; }

  // ---- 盤の表示状態（ルールは含まない） ----

  boardSfen() {
    if (this.phase === 'fuseki') return boardMapToSfen(this.boardPieces);
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
    if (this.phase === 'fuseki')
      return new Map([[SENTE, this.fuseki.remaining(BLACK)], [GOTE, this.fuseki.remaining(WHITE)]]);
    const toMap = color => new Map([...this.position.hands[color]].filter(([, n]) => n > 0));
    return new Map([[SENTE, toMap(SENTE)], [GOTE, toMap(GOTE)]]);
  }

  /** shogiground の droppable.dests。手番側の駒打ちのみを入れる。 */
  dropDests() {
    const dests = new Map();
    if (this.phase === 'over') return dests;
    const color = this.turnColor;
    if (this.phase === 'fuseki') {
      for (const d of this.fuseki.legalDrops()) {
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
    this._assertTurn('fuseki');
    const move = this.fuseki.drop(usi);      // 非合法ならここで例外
    this._recordFusekiMove(move);
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
    if (this.phase === 'fuseki') return this._aiFusekiMove();
    if (this.phase === 'normal') return this._aiNormalMove();
    return null;
  }

  async _aiFusekiMove() {
    const picked = await this.policy.pick(this.fuseki);
    if (this.phase !== 'fuseki') return null;   // 考えている間に終局していたら捨てる
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
    const { usi, info } = await this.engine.bestMove({
      sfen: this.finalSfen, moves: this.normalMoves, movetimeMs: this.movetimeMs,
    });
    if (this.phase !== 'normal') return null;
    if (usi === 'resign') { this._end(this.humanColor, 'ai_resign'); return null; }
    if (usi === 'win') { this._end(this.aiColor, 'ai_nyugyoku_declaration'); return null; }
    const md = parseUsi(usi);
    // やねうら王のbestmoveをそのまま信じない。非合法手を適用すると盤が静かに壊れる。
    if (!md || !this.position.isLegal(md)) { this._end(this.humanColor, 'engine_illegal_move'); return null; }
    this._applyNormalMove(usi, md);
    this.lastEval = { kind: 'search', ...info };
    return this.lastEval;
  }

  // ---- 内部 ----

  _assertTurn(phase) {
    if (this.phase !== phase) throw new Error(`${phase}フェーズではない（現在: ${this.phase}）`);
  }

  _recordFusekiMove(move) {
    const color = COLOR_NAME[this.fusekiMoves.length % 2];
    const key = usiDropSquare(move.usi);
    const square = parseSquareName(key);
    this.kifu.push({
      ply: this.fusekiMoves.length + 1, color, usi: move.usi,
      text: `${MARK[color]}${makeJapaneseSquare(square)}${kanjiOf(move.role)}打`,
    });
    this.fusekiMoves.push(move.usi);
    this.boardPieces.set(key, { role: move.role, color });
    this.lastDests = [key];
    this._lastDestSquare = square;
    // 控えは _transitionToNormal() の前に取る。40手目の控えは布石が終わった
    // 時点の盤で、41手目の裁定より前の姿でなければならない。
    this.kifu[this.kifu.length - 1].snapshot = this._snapshot();
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

  _end(winner, reason) {
    this.phase = 'over';
    this.result = { winner, reason };
  }

  resign() {
    if (this.phase !== 'over') this._end(this.aiColor, 'human_resign');
  }
}

/** "P*5e" の着手先。USIのマス表記は shogiops / shogiground のマス名と同じ綴り。 */
export function usiDropSquare(usi) { return usi.slice(2); }

/** 表示用の盤SFEN。Map<key, {role, color}> を並べるだけで、ルールの判断は無い。 */
function boardMapToSfen(pieces) {
  const FORSYTH = {
    pawn: 'p', lance: 'l', knight: 'n', silver: 's', gold: 'g',
    bishop: 'b', rook: 'r', king: 'k',
    tokin: '+p', promotedlance: '+l', promotedknight: '+n', promotedsilver: '+s',
    horse: '+b', dragon: '+r',
  };
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
