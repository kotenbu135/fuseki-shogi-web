// 棋譜の行ごとの評価（Game.recordEval / kifu[i].eval / positionAt）を Game 単体で見る。
//
// 見るのは次の不変条件:
//   - 残す評価は常に先手から見た値（USIの score は探索した側から見た値）
//   - AIの探索1回で、根（直前の手の行）と AIの手の行の両方が埋まり、値は同じ
//   - 人間の手番の解析（analysis）は読み筋から写した値（pv）を置き換える
//   - positionAt が40手目（41手目の局面）と通常フェーズの行だけ Position を返す
//   - 待った（undoTo）で残る行の評価が消えない
//   - 玉分け将棋の2手目の行に表の値が入る
//
//   node test/eval_record_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSfen, makeSfen } from 'shogiops/sfen';
import { makeUsi } from 'shogiops/util';
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

/** 通常フェーズに入った直後の Game を、41手目局面の見本から直接作る（game_terminal_test と同じ手）。 */
function normalGame({ humanColor = 'sente', engine = null } = {}) {
  const g = new Game({ fuseki, policy: null, engine, humanColor });
  // 40手ぶんの行が要る（棋譜の添字と手数の対応を本物と揃える）。中身は見ない。
  for (let i = 0; i < 40; i++) g.kifu.push({ ply: i + 1, color: i % 2 ? 'gote' : 'sente', usi: 'P*5e', actor: 'ai', text: '', snapshot: null });
  g.position = parseSfen('standard', SAMPLE_41, false).unwrap();
  g.finalSfen = SAMPLE_41;
  g.phase = 'normal';
  return g;
}
/** 局面の合法手を1つ。 */
function anyMove(pos) {
  for (const [from, tos] of pos.allMoveDests()) for (const to of tos) return makeUsi({ from, to });
  throw new Error('合法手が無い');
}
/** 返す手と info を決め打ちできる偽のエンジン。 */
function fakeEngine(answer) {
  return { newGame() {}, async bestMove() { return typeof answer === 'function' ? answer() : answer; } };
}

console.log('--- 先手から見た値に直す ---');

await check('先手が探索した値はそのまま、後手が探索した値は符号が返る', () => {
  const g = normalGame();
  const info = { scoreKind: 'cp', score: 120, depth: 10, pv: ['7g7f'] };
  eq(g.recordEval(39, info, 'sente', 'root').score, 120, '先手の探索');
  eq(g.recordEval(39, info, 'gote', 'root').score, -120, '後手の探索');
  eq(g.kifu[39].eval.source, 'root', '出所');
});

await check('詰みの手数も裏返る（後手の「3手詰」は先手から見て -3）', () => {
  const g = normalGame();
  const ev = g.recordEval(39, { scoreKind: 'mate', score: 3 }, 'gote', 'root');
  eq(ev.scoreKind, 'mate', '種別');
  eq(ev.score, -3, '値');
});

await check('score の無い info や範囲外の行は残さない', () => {
  const g = normalGame();
  eq(g.recordEval(39, null, 'sente', 'root'), null, 'info が null');
  eq(g.recordEval(39, { depth: 3 }, 'sente', 'root'), null, 'score 無し');
  eq(g.recordEval(99, { scoreKind: 'cp', score: 1 }, 'sente', 'root'), null, '範囲外');
  eq(g.kifu[39].eval, undefined, '何も残っていない');
});

console.log('--- AIの探索1回で2行が埋まる ---');

await check('後手AIの探索: 根（40手目の行）と41手目の行に同じ先手視点の値', async () => {
  // 人間が先手。41手目を人間が指し、後手AIが探索する。
  const g = normalGame({ humanColor: 'sente' });
  g.playNormalMove(anyMove(g.position));           // 41手目（人間）
  const reply = anyMove(g.position);
  g.engine = fakeEngine({ usi: reply, info: { scoreKind: 'cp', score: 80, depth: 12, pv: [reply, '7g7f'] } });
  await g.playAiMove();                             // 42手目（AI・後手）
  eq(g.kifu.length, 42, '行数');
  eq(g.kifu[40].eval.score, -80, '41手目の行（根）: 後手から +80 → 先手から -80');
  eq(g.kifu[40].eval.source, 'root', '根の出所');
  eq(g.kifu[41].eval.score, -80, '42手目の行: 同じ値');
  eq(g.kifu[41].eval.source, 'pv', '写した値');
  eq(g.kifu[41].eval.pv.join(' '), '7g7f', '読み筋は先頭を落とす');
  eq(g.lastEval, g.kifu[41].eval, 'lastEval は最後の行の評価');
});

await check('先手AIの41手目: 根は40手目の行（41手目局面）', async () => {
  const g = normalGame({ humanColor: 'gote' });
  const mv = anyMove(g.position);
  g.engine = fakeEngine({ usi: mv, info: { scoreKind: 'cp', score: 50, depth: 9, pv: [mv] } });
  await g.playAiMove();
  eq(g.kifu[39].eval.score, 50, '40手目の行');
  eq(g.kifu[40].eval.score, 50, '41手目の行');
});

await check('解析（analysis）が読み筋から写した値を置き換える', async () => {
  const g = normalGame({ humanColor: 'gote' });
  const mv = anyMove(g.position);
  g.engine = fakeEngine({ usi: mv, info: { scoreKind: 'cp', score: 50, depth: 9, pv: [mv] } });
  await g.playAiMove();
  const ev = g.recordEval(40, { scoreKind: 'cp', score: -30, depth: 14 }, 'gote', 'analysis');
  eq(ev.score, 30, '後手の解析 -30 → 先手から +30');
  eq(g.kifu[40].eval.source, 'analysis', '置き換わった');
});

await check('AIの投了は手番の相手の勝ち（根の評価は残る）', async () => {
  const g = normalGame({ humanColor: 'gote' });
  g.engine = fakeEngine({ usi: 'resign', info: { scoreKind: 'mate', score: -5 } });
  await g.playAiMove();
  eq(g.phase, 'over', '終局');
  eq(g.result.winner, 'gote', '勝者');
  eq(g.result.winnerIs, 'human', '人間の勝ち');
  eq(g.kifu[39].eval.score, -5, '根の評価（先手が詰まされる）');
});

console.log('--- positionAt ---');

await check('40手目の行は41手目の局面、通常フェーズの行はその手の後、布石の途中は null', () => {
  const g = normalGame();
  const mv = anyMove(g.position);
  g.playNormalMove(mv);
  eq(g.positionAt(10), null, '布石の途中');
  eq(makeSfen(g.positionAt(39)).split(' ')[0], SAMPLE_41.split(' ')[0], '40手目の行');
  eq(makeSfen(g.positionAt(40)), makeSfen(g.position), '41手目の行');
  eq(g.positionAt(99), null, '範囲外');
});

await check('finalSfen が無ければ null', () => {
  const g = new Game({ fuseki, policy: null, engine: null, humanColor: 'sente' });
  g.playFusekiDrop('P*5g');
  eq(g.positionAt(0), null, '布石フェーズ');
});

console.log('--- 待ったで評価が残る ---');

await check('undoTo の後も残る行の評価はそのまま', () => {
  const g = new Game({ fuseki, policy: null, engine: null, humanColor: 'sente' });
  for (const usi of ['P*5g', 'P*5c', 'K*5i', 'K*5a']) g.playFusekiDrop(usi);
  g.kifu[1].eval = { kind: 'policy', probability: .2 };
  g.kifu[3].eval = { kind: 'policy', probability: .1 };
  g.undoTo(3);
  eq(g.kifu.length, 3, '行数');
  eq(g.kifu[1].eval.probability, .2, '2手目の評価');
  eq(g.kifu[2].eval, undefined, '3手目には無かった');
  eq(g.lastEval, null, '最後の行に評価が無ければ lastEval も無い');
});

console.log('--- 玉分け将棋 ---');

await check('2手目の行に表の値が入る（置いたのが人間でも）', () => {
  const pairs = {};
  for (const fb of '123456789') for (const rb of 'fghi')
    for (const fw of '123456789') for (const rw of 'abcd') pairs[`${fb}${rb},${fw}${rw}`] = { v: 0.5 };
  pairs['5i,5a'] = { v: 0.62 };
  const table = new KingTable({ format: 'king_pair_table/1', model: 'iter171.npz', band: ['9i,1a'], pairs });
  const g = new Game({ fuseki, policy: null, engine: null, mode: 'kings-first', humanRole: 'placer', kingTable: table });
  g.playFusekiDrop('K*5i');
  eq(g.kifu[0].eval, undefined, '1手目には無い');
  g.playFusekiDrop('K*5a');
  eq(g.kifu[1].eval.kind, 'kings', '種別');
  eq(g.kifu[1].eval.winRate, 0.62, '値');
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
