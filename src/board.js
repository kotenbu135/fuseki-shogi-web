// shogiground の生成と、Gameの状態からの同期。
//
// shogigroundは駒を動かした結果を自分の中にも持つが、真実はGameの側にある。
// 着手のたびに sync() で局面まるごと入れ直しているのはそのため（差分更新にすると
// 「盤には映っているがルール上は存在しない駒」が生まれうる）。
import { Shogiground } from 'shogiground';
import { handsToSfen } from 'shogiground/sfen';
import { SENTE, GOTE } from './game.js';

// 布石フェーズでは玉も持ち駒から打つ。shogigroundの既定（state.js）は玉を含まないので足す。
export const HAND_ROLES = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];

const EMPTY_BOARD = '9/9/9/9/9/9/9/9/9';

// 布石の初期持ち駒（片側20枚）。対局前の見本と、対局開始前の盤に使う。
const INITIAL_HAND = new Map([
  ['king', 1], ['rook', 1], ['bishop', 1], ['gold', 2],
  ['silver', 2], ['knight', 2], ['lance', 2], ['pawn', 9],
]);

export function createBoard({ wrapEl, orientation, onDrop, onMove }) {
  return Shogiground(
    {
      orientation,
      coordinates: { enabled: true, files: 'numeric', ranks: 'japanese' },
      // inlined にすると shogiground が .sg-wrap の直下へ
      //   sg-hand-wrap / sg-board / sg-hand-wrap
      // の順で駒台を作る。これが lishogi の grid-template-areas がそのまま乗る形で、
      // 駒台を盤の左右へ回すにはこれでないと駄目（外に置いた要素はgridに入らない）。
      // 駒台のDOMは shogiground が持つので、HTML側に器を置かないこと。
      hands: { roles: HAND_ROLES, inlined: true },
      highlight: { lastDests: true, check: true, hovered: true },
      animation: { enabled: true, duration: 250 },
      // 駒はマスいっぱいに描く（既定のtrueだと半分の大きさになる）。
      scaleDownPieces: false,
      // 先読みの手は扱わない（布石フェーズには王手の概念が無く、意味が変わってしまう）。
      premovable: { enabled: false },
      predroppable: { enabled: false },
      draggable: { showGhost: true, deleteOnDropOff: false },
      movable: { free: false, showDests: true, events: { after: onMove } },
      droppable: { free: false, showDests: true, events: { after: onDrop } },
      // 矢印描画は使わない。visibleを落とさないと、盤の中にSVGが2枚
      // 通常フローで挿さって盤の高さが正方形でなくなる。
      drawable: { enabled: false, visible: false },
    },
    { board: wrapEl },
  );
}

/**
 * 対局前の盤。空の盤と満杯の駒台を出す。
 *
 * viewOnly は使わない。shogiground の set() は true→false の切り替えを
 * 落としてしまう（api.ts の forceRedrawProps が `cRes &&` で偽値を弾くため）ので、
 * 一度 viewOnly で作ると対局開始後もドラッグ用のDOMが生えてこない。
 * 代わりに activeColor を空にする。isMovable/isDroppable が
 * activeColor と駒の色の一致を要求するので、これだけで盤は触れなくなる。
 */
export function showIdleBoard(sg) {
  sg.set({
    sfen: {
      board: EMPTY_BOARD,
      hands: handsToSfen(new Map([[SENTE, INITIAL_HAND], [GOTE, INITIAL_HAND]]), HAND_ROLES),
    },
    turnColor: SENTE,
    activeColor: undefined,
    lastDests: [],
    checks: false,
    movable: { dests: new Map() },
    droppable: { dests: new Map() },
  });
}

/**
 * 棋譜をさかのぼって表示する。控え（Game._snapshot）をそのまま流し込む。
 * activeColor を空にして触れなくするのは showIdleBoard と同じ理由。
 */
export function showSnapshot(sg, snap) {
  sg.set({
    sfen: { board: snap.board, hands: handsToSfen(snap.hands, HAND_ROLES) },
    activeColor: undefined,
    lastDests: snap.lastDests,
    checks: false,
    movable: { dests: new Map() },
    droppable: { dests: new Map() },
  });
}

/** Gameの現在の局面を盤へ映す。 */
export function syncBoard(sg, game) {
  const humanTurn = game.isHumanTurn;
  sg.set({
    sfen: {
      board: game.boardSfen(),
      hands: handsToSfen(game.hands(), HAND_ROLES),
    },
    turnColor: game.turnColor ?? SENTE,
    // 触れるのは常に人間の色だけ。shogigroundは activeColor と turnColor が
    // 一致した色しか動かさないので、AIの手番では自動的に操作できなくなる。
    activeColor: game.humanColor,
    lastDests: game.lastDests,
    checks: game.checks(),
    movable: { dests: humanTurn ? game.moveDests() : new Map() },
    droppable: { dests: humanTurn ? game.dropDests() : new Map() },
    promotion: game.promotion(),
  });
}
