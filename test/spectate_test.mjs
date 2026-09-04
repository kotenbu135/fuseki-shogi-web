// 観戦（AI同士）の Game を単体で見る。ブラウザもエンジンも要らない。
//
//   - 人間の手番は一度も来ない（布石将棋・玉分け将棋とも）
//   - 玉分け将棋で先後が選ばれても人間の色は付かない
//   - 待ったの対象（actor が human の行）が無い
//   - 中断すると勝敗なしで終局し、表示の口が全部読める
//   - AIの投了は手番の相手の勝ち。勝者はあるが winnerIs は無い
//
//   node test/spectate_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSfen } from 'shogiops/sfen';
import { Fuseki } from '../src/fuseki.js';
import { Game } from '../src/game.js';
import { KingTable } from '../src/kings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  OK ${label}`);
  } catch (e) {
    failures++;
    console.log(`  NG ${label} — ${e.message}`);
  }
};
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
};

const SAMPLE_41 = JSON.parse(
  fs.readFileSync(path.join(HERE, 'sample_sfens.jsonl'), 'utf8').split('\n')[0]).sfen;
const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);

function makeTable() {
  const pairs = {};
  for (const fb of '123456789') for (const rb of 'fghi')
    for (const fw of '123456789') for (const rw of 'abcd') pairs[`${fb}${rb},${fw}${rw}`] = { v: 0.5 };
  pairs['9i,1a'] = { v: 0.7 };
  return new KingTable({ format: 'king_pair_table/1', model: 'iter171.npz', band: ['9i,1a'], pairs });
}
/** 表示に使う口を全部叩く（game_terminal_test と同じ）。 */
function readEverything(g) {
  const out = { turnColor: g.turnColor, ply: g.ply, isHumanTurn: g.isHumanTurn, board: g.boardSfen(),
    hands: g.hands(), checks: g.checks(), dropDests: g.dropDests(), moveDests: g.moveDests(), snapshot: g._snapshot() };
  if (typeof out.board !== 'string') throw new Error('boardSfen が文字列でない');
  return out;
}

console.log('--- 布石将棋の観戦 ---');

await check('人間の手番が来ず、色も無く、待ったの対象も無い', () => {
  const g = new Game({ fuseki, policy: null, engine: null, spectate: true });
  eq(g.spectate, true, 'spectate');
  eq(g.humanColor, null, '色');
  eq(g.isHumanTurn, false, '開始時');
  eq(g.activeColor, undefined, '盤で触れる色');
  for (const usi of ['P*5g', 'P*5c', 'K*5i', 'K*5a']) g.playFusekiDrop(usi);
  eq(g.isHumanTurn, false, '4手後');
  eq(g.kifu.every(e => e.actor === 'ai'), true, '全部AIの手');
  readEverything(g);
});

await check('中断すると勝敗なしで終局する', () => {
  const g = new Game({ fuseki, policy: null, engine: null, spectate: true });
  g.playFusekiDrop('P*5g');
  g.abort();
  eq(g.phase, 'over', '終局');
  eq(g.result.winner, null, '勝者なし');
  eq(g.result.reason, 'aborted', '理由');
  eq(g.result.winnerIs, null, 'winnerIs');
  g.abort();
  eq(g.result.reason, 'aborted', '二度目は何もしない');
  readEverything(g);
});

await check('通常フェーズでAIが投了すると手番の相手の勝ち、winnerIs は無い', async () => {
  const g = new Game({ fuseki, policy: null, engine: null, spectate: true });
  for (let i = 0; i < 40; i++) g.kifu.push({ ply: i + 1, color: i % 2 ? 'gote' : 'sente', usi: 'P*5e', actor: 'ai', text: '' });
  g.position = parseSfen('standard', SAMPLE_41, false).unwrap();
  g.finalSfen = SAMPLE_41;
  g.phase = 'normal';
  eq(g.isHumanTurn, false, '通常フェーズでも人間の番は来ない');
  g.engine = { newGame() {}, async bestMove() { return { usi: 'resign', info: { scoreKind: 'cp', score: -900 } }; } };
  await g.playAiMove();   // 先手番のAIが投了
  eq(g.phase, 'over', '終局');
  eq(g.result.winner, 'gote', '後手の勝ち');
  eq(g.result.winnerIs, null, 'winnerIs');
  eq(g.kifu[39].eval.score, -900, '根の評価は先手から見て -900');
});

console.log('--- 玉分け将棋の観戦 ---');

await check('AIが両玉を置いて選んでも人間の色は付かず、手番も来ない', async () => {
  const g = new Game({ fuseki, policy: null, engine: null, mode: 'kings-first', spectate: true, kingTable: makeTable() });
  eq(g.humanRole, null, '役');
  eq(g.isHumanTurn, false, '置く段');
  await g.playAiMove();
  await g.playAiMove();
  eq(g.phase, 'choose', '選ぶ段');
  eq(g.isHumanTurn, false, '選ぶ段でも人間の番ではない');
  await g.playAiMove();
  eq(g.phase, 'fuseki', '3手目へ');
  eq(g.chosen, 'sente', '表の 0.7 で先手を取る');
  eq(g.humanColor, null, '人間の色は無いまま');
  eq(g.isHumanTurn, false, '布石');
  eq(g.kifu[1].eval?.kind, 'kings', '2手目の行に表の値');
  eq(g.tokens().join(' '), 'K*9i K*1a choose:sente', '手順');
  readEverything(g);
});

await check('待ったで選択より前へ戻っても色は無いまま', async () => {
  const g = new Game({ fuseki, policy: null, engine: null, mode: 'kings-first', spectate: true, kingTable: makeTable() });
  for (let i = 0; i < 3; i++) await g.playAiMove();
  g.undoTo(2);
  eq(g.phase, 'choose', '選ぶ段に戻る');
  eq(g.humanColor, null, '色');
  eq(g.isHumanTurn, false, '手番');
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
