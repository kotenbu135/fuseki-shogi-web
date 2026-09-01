// shogiground の生成と、Gameの状態からの同期。
//
// shogigroundは駒を動かした結果を自分の中にも持つが、真実はGameの側にある。
// 着手のたびに sync() で局面まるごと入れ直しているのはそのため（差分更新にすると
// 「盤には映っているがルール上は存在しない駒」が生まれうる）。
import { Shogiground } from 'shogiground';
import { handsToSfen } from 'shogiground/sfen';
import { SENTE } from './game.js';

// 布石フェーズでは玉も持ち駒から打つ。shogigroundの既定（state.js）は玉を含まないので足す。
export const HAND_ROLES = ['king', 'rook', 'bishop', 'gold', 'silver', 'knight', 'lance', 'pawn'];

export function createBoard({ wrapEl, handTopEl, handBottomEl, orientation, onDrop, onMove }) {
  return Shogiground(
    {
      orientation,
      coordinates: { enabled: true, files: 'numeric', ranks: 'japanese' },
      hands: { roles: HAND_ROLES },
      highlight: { lastDests: true, check: true, hovered: true },
      animation: { enabled: true, duration: 180 },
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
    { board: wrapEl, hands: { top: handTopEl, bottom: handBottomEl } },
  );
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
