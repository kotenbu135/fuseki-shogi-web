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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fuseki } from '../src/fuseki.js';
import { Game } from '../src/game.js';
import { parseSfen } from 'shogiops/sfen';

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

// 実際の布石が作った41手目の局面（test/sample_sfens.jsonl の1件目）。
const SAMPLE_41 = JSON.parse(
  fs.readFileSync(path.join(HERE, 'sample_sfens.jsonl'), 'utf8').split('\n')[0]).sfen;

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

console.log('--- 通常フェーズで終局した Game ---');

check('通常フェーズで終局しても値が取り出せる', () => {
  // 40手で終わる形は2つあり、こちらは position が**作られた後**に終局する側。
  //   fuseki_king_capture -> position は null（上の節）
  //   詰み                 -> position はある（この節）
  // 布石フェーズは王手放置を見ないので、41手目の局面が既に詰んでいることがある。
  // 実際に --full を繰り返していて「後手の勝ち / 詰み」で終わる局が出た。
  const g = newGame();
  const parsed = parseSfen('standard', SAMPLE_41, false);
  if (parsed.isErr) throw new Error(`見本のSFENが読めない: ${parsed.error}`);
  g.position = parsed.unwrap();
  g.phase = 'normal';
  const before = readEverything(g);
  if (before.turnColor !== 'sente') throw new Error(`41手目の手番: ${before.turnColor}`);
  g._end('gote', 'checkmate');
  const after = readEverything(g);
  if (after.turnColor !== null) throw new Error('終局後に手番が残っている');
  if (after.board !== before.board) throw new Error('終局で盤が変わってしまう');
  if (after.moveDests.size !== 0 || after.dropDests.size !== 0)
    throw new Error('終局後に指せる手が出ている');
});

console.log('--- 布石フェーズの途中（終局していない） ---');

check('打っている途中でも値が取り出せる', () => {
  const g = newGame();
  g.playFusekiDrop('P*5g');
  const r = readEverything(g);
  if (r.turnColor !== 'gote') throw new Error(`1手打った後の手番: ${r.turnColor}`);
  if (r.dropDests.size === 0) throw new Error('打てる手が出ていない');
});

console.log('--- 時間切れ（持ち時間はUI側、終わらせ方だけがGame側） ---');

check('布石フェーズのまま時間切れでも値が取り出せる', () => {
  // 布石フェーズで終局すると phase は 'over' なのに position は null のまま。
  // 投了と同じ道で、時間切れはその入口が1つ増えたもの。
  const g = newGame();
  g.playFusekiDrop('P*5g');
  g.timeout();
  if (g.phase !== 'over') throw new Error(`phase: ${g.phase}`);
  if (g.result.reason !== 'human_timeout') throw new Error(`reason: ${g.result.reason}`);
  if (g.result.winner !== g.aiColor) throw new Error(`winner: ${g.result.winner}`);
  const r = readEverything(g);
  if (r.turnColor !== null) throw new Error('終局後に手番が残っている');
  if (r.moveDests.size !== 0 || r.dropDests.size !== 0) throw new Error('終局後に指せる手が出ている');
});

check('終局した対局に時間切れを重ねても結果が書き換わらない', () => {
  const g = newGame();
  g.resign();
  g.timeout();
  if (g.result.reason !== 'human_resign') throw new Error(`reason: ${g.result.reason}`);
});

console.log('--- 局面の受け渡し（Game.sfen） ---');

check('布石フェーズのSFENに、まだ打っていない駒が乗る', () => {
  // fuseki.toSfen() は打っていない駒を落として持ち駒を '-' にする（ply5で15枚消えた）。
  // Game.sfen() はそこを自分で組み立てる。
  const g = newGame();
  g.playFusekiDrop('P*5g');
  const hands = g.sfen().split(' ')[1];
  if (hands === '-') throw new Error(`持ち駒が空: ${g.sfen()}`);
  if (!hands.includes('k') || !hands.includes('K')) throw new Error(`玉が持ち駒に無い: ${hands}`);
});

check('SFENの手番と手数が進む', () => {
  const g = newGame();
  if (g.sfen().split(' ').slice(2).join(' ') !== 'b 1') throw new Error(g.sfen());
  g.playFusekiDrop('P*5g');
  if (g.sfen().split(' ').slice(2).join(' ') !== 'w 2') throw new Error(g.sfen());
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
