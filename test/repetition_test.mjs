// 千日手の判定（src/game.js の _recordRepetition）を Game 単体で通す。
//
// shogiops の outcome() は詰み系だけで、同じ局面の繰り返しを見ない。Game が通常フェーズの
// 局面の鍵（盤・持ち駒・手番）を数え、4回目で終局させる。繰り返しのあいだ一方が王手を
// かけ続けていれば（連続王手の千日手）その側の負け、そうでなければ引き分け。
// 布石を40手打つ代わりに、通常フェーズの局面を直接入れて指す。
//
//   node test/repetition_test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSfen, makeSfen } from 'shogiops/sfen';
import { Fuseki } from '../src/fuseki.js';
import { Game } from '../src/game.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK ${label}`); }
  catch (e) { failures++; console.log(`  NG ${label} — ${e.message}`); }
};
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
};

const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);

/** 通常フェーズの局面を直接持つ Game。 */
function gameAt(sfen) {
  const g = new Game({ fuseki, policy: null, engine: null, humanColor: 'sente', opponent: 'remote' });
  g.position = parseSfen('standard', sfen, false).unwrap();
  g.finalSfen = sfen;
  g.phase = 'normal';
  g._history = [{ key: makeSfen(g.position).split(' ').slice(0, 3).join(' '), check: g.position.isCheck() }];
  return g;
}

check('同じ局面が4回で引き分け（王手を含まない繰り返し）', () => {
  const g = gameAt('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1');
  const cycle = ['5i5h', '5a5b', '5h5i', '5b5a'];
  for (let k = 0; k < 2; k++) for (const m of cycle) { g.playNormalMove(m); eq(g.phase, 'normal', `${k}周目 ${m}`); }
  // 3周目の最後で初期局面が4回目。
  for (const m of cycle.slice(0, 3)) { g.playNormalMove(m); eq(g.phase, 'normal', m); }
  g.playNormalMove('5b5a');
  eq(g.phase, 'over', '4回目で終局');
  eq(g.result.reason, 'sennichite', '理由');
  eq(g.result.winner, null, '引き分け');
});

check('連続王手の千日手は王手をかけ続けた側の負け', () => {
  // 先手の飛車が5筋と4筋を往復して王手をかけ続け、後手玉が5一と4一を往復する。
  const g = gameAt('4k4/9/9/9/9/9/9/9/3R4K b - 1');
  const cycle = ['6i5i', '5a4a', '5i4i', '4a5a', '4i5i', '5a4a', '5i4i', '4a5a'];
  g.playNormalMove('6i5i'); g.playNormalMove('5a4a'); g.playNormalMove('5i4i'); g.playNormalMove('4a5a');
  // ここから「飛車5一の王手」の局面が繰り返す。
  let over = false;
  for (let k = 0; k < 4 && !over; k++) {
    for (const m of cycle.slice(4)) {   // 4i5i, 5a4a, 5i4i, 4a5a
      g.playNormalMove(m);
      if (g.phase === 'over') { over = true; break; }
    }
  }
  eq(g.phase, 'over', '終局');
  eq(g.result.reason, 'perpetual_check', '理由');
  eq(g.result.winner, 'gote', '王手をかけ続けた先手の負け');
});

check('待った（undoTo）で戻すと繰り返しの数え直しになる', () => {
  const g = gameAt('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1');
  const cycle = ['5i5h', '5a5b', '5h5i', '5b5a'];
  for (let k = 0; k < 2; k++) for (const m of cycle) g.playNormalMove(m);
  eq(g._history.length, 9, '履歴の長さ');
  // Game.undoTo は布石から作り直すので、ここでは履歴が _reset で空になることだけ見る。
  g._reset();
  eq(g._history.length, 0, 'リセットで空');
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
