// 終局した Game から、表示に使う値がどれも取り出せることを見る。
//
// 表示の取り出し口（boardSfen / hands / _snapshot / turnColor / dropDests …）は
// 「布石フェーズか通常フェーズか」で中身が変わる。ここが phase で分岐していると、
// **布石フェーズのまま終局した**ときに phase が 'over' になる一方 position は null の
// ままなので、makeSfen(null) を呼んで落ちる。落ちると main.js の render() が途中で
// 止まり、盤も表示も固まって新規対局も始められなくなる。
//
// この状態に入る道は2つある。
//   1. 布石フェーズの途中で投了する
//   2. 41手目の裁定で決着する（fuseki_king_capture）
// 2 は「40手完了時点で手番側が相手玉を取れる形」で、普通に起こる。
// どちらも AI の指し手次第でしか再現できないので、道ではなく**状態**を直接作って
// 不変条件を留める。ブラウザもエンジンも要らないので数秒で終わる。
//
//   node test/game_terminal_test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fuseki } from '../src/fuseki.js';
import { Game } from '../src/game.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  OK ${label}`);
  } catch (e) {
    failures++;
    console.log(`  NG ${label} — ${e.message}`);
  }
};

const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);

/** 表示に使う口を全部叩く。1つでも投げたらそこで失敗になる。 */
function readEverything(game) {
  const out = {
    turnColor: game.turnColor,
    ply: game.ply,
    isHumanTurn: game.isHumanTurn,
    board: game.boardSfen(),
    hands: game.hands(),
    checks: game.checks(),
    promotion: game.promotion(),
    dropDests: game.dropDests(),
    moveDests: game.moveDests(),
    snapshot: game._snapshot(),
  };
  if (typeof out.board !== 'string' || out.board.length === 0)
    throw new Error(`boardSfen が空: ${JSON.stringify(out.board)}`);
  if (!(out.hands instanceof Map)) throw new Error('hands がMapでない');
  if (!(out.snapshot.hands instanceof Map)) throw new Error('snapshot.hands がMapでない');
  return out;
}

const newGame = () => new Game({ fuseki, policy: null, engine: null, humanColor: 'sente' });

console.log('--- 布石フェーズのまま終局した Game ---');

check('打つ前に投了しても値が取り出せる', () => {
  const g = newGame();
  g.resign();
  if (g.phase !== 'over') throw new Error(`phase が over でない: ${g.phase}`);
  const r = readEverything(g);
  if (r.board !== '9/9/9/9/9/9/9/9/9') throw new Error(`空の盤にならない: ${r.board}`);
  if (r.turnColor !== null) throw new Error(`終局後の手番が null でない: ${r.turnColor}`);
  if (r.dropDests.size !== 0) throw new Error('終局後に打てる手が出ている');
});

check('数手打ってから投了しても値が取り出せる', () => {
  const g = newGame();
  for (const usi of ['P*5g', 'P*5c', 'K*5i', 'K*5a']) g.playFusekiDrop(usi);
  g.resign();
  const r = readEverything(g);
  const pieces = r.board.replace(/[0-9/]/g, '').length;
  if (pieces !== 4) throw new Error(`打った4枚が盤に無い: ${r.board}`);
  if (r.snapshot.board !== r.board) throw new Error('控えと現在の盤が食い違う');
});

check('41手目の裁定で決着した形でも値が取り出せる', () => {
  // _transitionToNormal() が position を作る前に _end() する経路と同じ状態。
  const g = newGame();
  for (const usi of ['P*5g', 'P*5c']) g.playFusekiDrop(usi);
  g._end('sente', 'fuseki_king_capture');
  if (g.position !== null) throw new Error('position が作られてしまっている');
  readEverything(g);
});

console.log('--- 布石フェーズの途中（終局していない） ---');

check('打っている途中でも値が取り出せる', () => {
  const g = newGame();
  g.playFusekiDrop('P*5g');
  const r = readEverything(g);
  if (r.turnColor !== 'gote') throw new Error(`1手打った後の手番: ${r.turnColor}`);
  if (r.dropDests.size === 0) throw new Error('打てる手が出ていない');
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
