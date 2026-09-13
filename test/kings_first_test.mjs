// 天秤将棋（開発リポジトリ docs/rules.md「天秤将棋」）の状態機械を
// Game 単体で通す。ブラウザもエンジンも要らず、価値表は小さな作り物で足りる。
//
// 見るのは次の不変条件:
//   - kings → choose → fuseki の遷移と、選択で初めて色が決まること
//   - 置く役は色に関わらず両方の玉を置き、玉以外は置けないこと
//   - AIの置く役は帯から、AIの選ぶ役は V > 0.5 で先手側を取ること
//   - 待ったが選択をまたいで戻れ、戻れば色が再び未定になること
//   - 手順（tokens）が往復すること（手順の読み込みと待ったの経路）
//   - 選ぶ前に投了しても表示の口が全部読めること（game_terminal_test と同じ理由）
//   - 通常モードが何も変わっていないこと
//   - 二飛香が天秤将棋（2版）にだけ効き、布石将棋と旧ルール（1版）には効かないこと
//
//   node test/kings_first_test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fuseki, FUSEKI_RULE_NIHIKYO } from '../src/fuseki.js';
import { Game, rulesForTokens } from '../src/game.js';
import { KingTable } from '../src/kings.js';

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
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
};
const throws = (fn, what) => {
  try { fn(); } catch { return; }
  throw new Error(`${what} が例外にならない`);
};

const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);

// 作り物の表。全組 0.5 にしたうえで、数組だけ偏らせる。帯は2組。
function makeTable() {
  const pairs = {};
  for (const fb of '123456789') for (const rb of 'fghi')
    for (const fw of '123456789') for (const rw of 'abcd')
      pairs[`${fb}${rb},${fw}${rw}`] = { v: 0.5 };
  pairs['5i,5a'] = { v: 0.7 };   // 先手が良い
  pairs['5h,5b'] = { v: 0.3 };   // 後手が良い
  return new KingTable({ format: 'king_pair_table/1', model: 'iter538.npz', band: ['9i,1a', '1i,9a'], pairs });
}
const table = makeTable();
const newGame = (humanRole, extra = {}) =>
  new Game({ fuseki, policy: null, engine: null, mode: 'kings-first', humanRole, kingTable: table, ...extra });

/** 表示に使う口を全部叩く（game_terminal_test と同じ）。 */
function readEverything(game) {
  const out = {
    turnColor: game.turnColor, ply: game.ply, isHumanTurn: game.isHumanTurn,
    board: game.boardSfen(), hands: game.hands(), checks: game.checks(),
    promotion: game.promotion(), dropDests: game.dropDests(), moveDests: game.moveDests(),
    snapshot: game._snapshot(), sfen: game.sfen(), activeColor: game.activeColor,
  };
  if (typeof out.board !== 'string' || !out.board.length) throw new Error('boardSfen が空');
  return out;
}

console.log('--- 価値表 ---');

check('世代がずれた表は落とす', () => {
  throws(() => new KingTable(table.data, { modelFile: 'fuseki_degct_b3_iter38.onnx' }), '世代違い');
  new KingTable(table.data, { modelFile: 'fuseki_degct_b3_iter538.onnx' });
});

check('形式の違う表は落とす', () => {
  throws(() => new KingTable({ format: 'x', pairs: {}, band: [] }), '形式違い');
});

check('置く役は帯のうち釣り合う順に48組を引く', () => {
  // 帯の大きさは表の測定誤差で決まってしまう（同じ規則で10組にも23組にもなった）ので、
  // 置く役の集合は組数で固定する。釣り合わない側の余りは落とす。
  const pairs = {};
  for (const fb of '123456789') for (const rb of 'fghi')
    for (const fw of '123456789') for (const rw of 'abcd')
      pairs[`${fb}${rb},${fw}${rw}`] = { v: 0.5 };
  // 帯を60組つくり、0.5から遠い順が分かるように V をずらす。
  const band = [];
  outer:
  for (const rw of 'abcd') for (const fw of '123456789')
    for (const rb of 'fghi') for (const fb of '123456789') {
      if (band.length >= 60) break outer;
      const k = `${fb}${rb},${fw}${rw}`;
      pairs[k] = { v: 0.5 + 0.001 * band.length };
      band.push(k);
    }
  eq(band.length, 60, '試験の帯は60組');
  const t = new KingTable({ format: 'king_pair_table/1', model: 'iter538.npz',
                            band_floor: 0.01, band, pairs });
  const pool = t.balancedPool();
  eq(pool.length, 48, '48組に固定する');
  eq(pool.sort().join(' '), band.slice(0, 48).sort().join(' '), '釣り合う順に取る');
  for (const k of band.slice(48)) if (pool.includes(k)) throw new Error(`遠い組を入れた: ${k}`);

  const seen = new Set();
  for (let i = 0; i < 4000; i++) seen.add(t.placerPick().join(','));
  eq(seen.size, 48, '集合の中では一様に引く（多様性を残すために広げた）');

  // 帯が48組より少ないときは帯ぜんぶ。誤差ぶんより外へは出ない。
  const small = new KingTable({ format: 'king_pair_table/1', model: 'iter538.npz',
                               band_floor: 0.01, band: band.slice(0, 5), pairs });
  eq(small.balancedPool().length, 5, '帯が短ければ帯ぜんぶ');
});

check('置く役は帯から引き、選ぶ役は V で決める', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(table.placerPick().join(','));
  eq([...seen].sort().join(' '), '1i,9a 9i,1a', '帯から引いた組');
  eq(table.chooserPick('5i', '5a'), 'sente', 'V=0.7');
  eq(table.chooserPick('5h', '5b'), 'gote', 'V=0.3');
  eq(table.chooserPick('9i', '1a'), 'gote', 'V=0.5 は先手側でない');
});

console.log('--- AIが置く役、人間が選ぶ役 ---');

check('AIが両玉を置くと選択へ移り、色はまだ無い', () => {
  const g = newGame('chooser', { rng: () => 0 });
  eq(g.phase, 'kings', '最初のフェーズ');
  eq(g.isHumanTurn, false, 'AIの番');
  eq(g.humanColor, null, '色は未定');
  g.playAiMove();
  eq(g.phase, 'kings', '1手目の後');
  eq(g.turnColor, 'gote', '1手目の後の盤の手番');
  eq(g.isHumanTurn, false, '2手目もAI（置く役が続けて置く）');
  g.playAiMove();
  eq(g.phase, 'choose', '2手目の後');
  eq(g.fusekiMoves.join(' '), 'K*9i K*1a', 'rng=0 なら帯の先頭');
  eq(g.kingSquares.sente, '9i', '先手玉');
  eq(g.kingSquares.gote, '1a', '後手玉');
  eq(g.isHumanTurn, true, '選ぶのは人間');
  eq(g.turnColor, null, '選択の最中に手番は無い');
  eq(g.activeColor, undefined, '選択の最中に盤は触れない');
  eq(g.lastEval.kind, 'kings', '評価は表の値');
  const r = readEverything(g);
  eq(r.dropDests.size, 0, '選択の最中に打てる手');
  eq(g.kifu.length, 2, '棋譜は2行');
  eq(g.kifu[0].actor, 'ai', '1手目はAIの手');
  eq(g.kifu[1].actor, 'ai', '2手目もAIの手');
});

check('人間が先手側を選ぶと色が決まり、3手目は先手番', () => {
  const g = newGame('chooser', { rng: () => 0 });
  g.playAiMove(); g.playAiMove();
  throws(() => g.playFusekiDrop('P*5g'), '選ぶ前の駒打ち');
  throws(() => g.choose('sente-ish'), '不正な側');
  g.choose('sente');
  eq(g.phase, 'fuseki', '選択の後');
  eq(g.chosen, 'sente', '選んだ側');
  eq(g.humanColor, 'sente', '選ぶ役が先手側を取った');
  eq(g.aiColor, 'gote', 'AIは後手');
  eq(g.turnColor, 'sente', '3手目は先手番');
  eq(g.isHumanTurn, true, '3手目は人間');
  eq(g.activeColor, 'sente', '触れるのは先手の駒');
  eq(g.kifu.length, 3, '選択が1行');
  eq(g.kifu[2].ply, null, '選択の行に手数は無い');
  eq(g.kifu[2].actor, 'human', '選択は人間の手');
  eq(g.tokens().join(' '), 'K*9i K*1a choose:sente', '手順');
  eq(g.moveCount, 2, '指し手の数に選択は入らない');
  const dests = g.dropDests();
  if (![...dests.keys()].every(k => k.startsWith('sente '))) throw new Error('先手以外の駒が打てる');
  if (dests.has('sente king')) throw new Error('置いた玉がまた打てる');
});

check('人間が後手側を選ぶと、3手目はAIの先手', () => {
  const g = newGame('chooser', { rng: () => 0 });
  g.playAiMove(); g.playAiMove();
  g.choose('gote');
  eq(g.humanColor, 'gote', '人間は後手');
  eq(g.turnColor, 'sente', '3手目は先手番');
  eq(g.isHumanTurn, false, '3手目はAI');
});

console.log('--- 人間が置く役、AIが選ぶ役 ---');

check('置く役は先手玉、次に後手玉を置く。玉以外は置けない', () => {
  const g = newGame('placer');
  eq(g.isHumanTurn, true, '置くのは人間');
  eq(g.activeColor, 'sente', '1手目は先手の駒台');
  const d1 = g.dropDests();
  eq([...d1.keys()].join(','), 'sente king', '1手目の候補は先手玉だけ');
  eq(d1.get('sente king').length, 36, '先手陣36マス');
  throws(() => g.playFusekiDrop('P*5g'), '1手目に歩');
  g.playFusekiDrop('K*5i');
  eq(g.phase, 'kings', '1手目の後');
  eq(g.isHumanTurn, true, '2手目も人間');
  eq(g.activeColor, 'gote', '2手目は後手の駒台');
  eq([...g.dropDests().keys()].join(','), 'gote king', '2手目の候補は後手玉だけ');
  throws(() => g.playFusekiDrop('K*5i'), '既に埋まったマス');
  throws(() => g.playFusekiDrop('K*5e'), '後手陣の外');
  g.playFusekiDrop('K*5a');
  eq(g.phase, 'choose', '両玉の後');
  eq(g.isHumanTurn, false, '選ぶのはAI');
  eq(g.kifu[0].actor, 'human', '1手目は人間の手（色は先手）');
  eq(g.kifu[1].actor, 'human', '2手目も人間の手（色は後手）');
  eq(g.kifu[1].color, 'gote', '2手目の色は後手');
});

check('AIの選ぶ役は表の V で側を決め、置く役はその反対の色になる', () => {
  const g = newGame('placer');
  g.playFusekiDrop('K*5i'); g.playFusekiDrop('K*5a');   // V=0.7 → AIは先手側
  g.playAiMove();
  eq(g.phase, 'fuseki', '選択の後');
  eq(g.chosen, 'sente', 'AIは先手側');
  eq(g.humanColor, 'gote', '置く役は後手');
  eq(g.kifu[2].actor, 'ai', '選択はAIの手');
  eq(g.isHumanTurn, false, '3手目はAI');

  const h = newGame('placer');
  h.playFusekiDrop('K*5h'); h.playFusekiDrop('K*5b');   // V=0.3 → AIは後手側
  h.playAiMove();
  eq(h.chosen, 'gote', 'AIは後手側');
  eq(h.humanColor, 'sente', '置く役は先手');
  eq(h.isHumanTurn, true, '3手目は人間');
});

console.log('--- 待ったと手順の往復 ---');

check('選択をまたいで戻すと色が未定に戻り、同じ手順で復元できる', () => {
  const g = newGame('chooser', { rng: () => 0 });
  g.playAiMove(); g.playAiMove();
  g.choose('gote');
  // 3手目（AIの先手）と4手目（人間の後手）の代わりに直接置く。
  g.playFusekiDrop('P*5g'); g.playFusekiDrop('P*5c');
  eq(g.kifu.length, 5, '棋譜5行');
  const tokens = g.tokens();
  eq(tokens.join(' '), 'K*9i K*1a choose:gote P*5g P*5c', '手順');

  g.undoTo(2);
  eq(g.phase, 'choose', '選択まで戻った');
  eq(g.humanColor, null, '色は未定に戻る');
  eq(g.chosen, null, '選択は消える');
  eq(g.boardSfen(), '8k/9/9/9/9/9/9/9/K8', '両玉だけの盤');

  g.undoTo(0);
  eq(g.phase, 'kings', '最初まで戻った');
  eq(g.boardSfen(), '9/9/9/9/9/9/9/9/9', '空の盤');

  for (const t of tokens) g.play(t);
  eq(g.tokens().join(' '), tokens.join(' '), '往復');
  eq(g.humanColor, 'gote', '色が戻る');
  eq(g.phase, 'fuseki', 'フェーズが戻る');
  eq(g.kifu.length, 5, '棋譜の行数が戻る');
});

check('通常モードの手順に選択は入れられない', () => {
  const g = new Game({ fuseki, policy: null, engine: null, humanColor: 'sente' });
  eq(g.mode, 'standard', '既定は通常モード');
  eq(g.phase, 'fuseki', '通常モードは布石から');
  throws(() => g.play('choose:sente'), '通常モードの選択');
  g.play('P*5g');
  eq(g.tokens().join(' '), 'P*5g', '通常モードの手順に選択は無い');
  eq(g.kifu[0].actor, 'human', '通常モードでも actor が付く');
});

console.log('--- 二飛香（天秤将棋の2版） ---');

// GitHub Issue #1 の「確認用の手順」。24手目は後手番。
const NIHIKYO_24 = 'K*8g K*6b choose:sente P*1g R*8a S*7g N*7c S*9g P*4d L*5g S*6c P*8f B*3b B*3f P*8d G*8h P*3d P*5i G*7b N*4f P*7d P*9f P*9d G*6h';
const NIHIKYO_40 = `${NIHIKYO_24} P*1d P*2h G*5b P*4g S*4c P*7f P*6d N*6f P*2d P*3g N*5d R*2f P*5c P*6g L*2c L*7i L*5a`;
// 後手玉 5c に先手の飛 5f が当たったまま39手を打ち終え、後手の最後の1枚は香。
// 遮る 5d は、5b に後手の香があるので二飛香で打てない。
const BLOCK_ONLY_BY_LANCE = 'K*5i K*5c choose:sente R*5f P*5a P*1f L*5b P*2f P*1a P*3f P*2a P*4f P*3a P*5g P*4a ' +
  'P*6f P*6a P*7f P*7a P*8f P*8a P*9f P*9a L*1g N*1b L*2g N*1c N*1h S*1d N*1i S*2b S*2h G*2c S*2i G*2d G*3g B*3b G*3h R*3c B*3i';

/** 天秤将棋で手順を入れ、手番側の合法手を返す。 */
const playKings = (tokens, extra = {}) => {
  const g = newGame('placer', extra);
  for (const t of tokens.split(' ')) g.play(t);
  return { g, legal: new Set(g.fuseki.legalDrops().map(d => d.usi)) };
};
/** 同じ駒打ちを布石将棋で並べる（選択のトークンを抜くだけ。手番の色は同じ）。 */
const playStandard = tokens => {
  const g = new Game({ fuseki, policy: null, engine: null, humanColor: 'sente' });
  for (const t of tokens.split(' ')) if (!t.startsWith('choose:')) g.play(t);
  return new Set(g.fuseki.legalDrops().map(d => d.usi));
};

check('後手の反則: 8筋に後手の飛があれば香を打てない', () => {
  const { g, legal } = playKings(NIHIKYO_24);
  eq(g.turnColor, 'gote', '24手目は後手');
  eq(legal.has('L*8c'), false, 'L*8c');
  eq(legal.has('P*1d'), true, 'P*1d');
  throws(() => g.play('L*8c'), 'L*8c を指す');
});

check('先手の反則: 5筋に先手の飛があれば香を打てない', () => {
  const { legal } = playKings('K*5i K*5a choose:sente R*5h P*1c');
  eq(legal.has('L*5g'), false, 'L*5g');
  eq(legal.has('L*4g'), true, 'L*4g');
});

check('相手の飛・香は数えない', () => {
  const { g, legal } = playKings('K*5i K*5a choose:sente R*5h');
  eq(g.turnColor, 'gote', '後手番');
  eq(legal.has('L*5c'), true, 'L*5c');
});

check('布石将棋と旧ルール（1版）では同じ手が合法のまま', () => {
  eq(playStandard(NIHIKYO_24).has('L*8c'), true, '布石将棋の L*8c');
  eq(playStandard('K*5i K*5a choose:sente R*5h P*1c').has('L*5g'), true, '布石将棋の L*5g');
  eq(playKings(NIHIKYO_24, { balanceRules: 1 }).legal.has('L*8c'), true, '1版の L*8c');
});

check('二飛香に合う40手は、2版でも1版でも41手目まで入る', () => {
  for (const balanceRules of [2, 1]) eq(playKings(NIHIKYO_40, { balanceRules }).g.phase, 'normal', `${balanceRules}版`);
});

check('40手目: 遮る手が二飛香で打てなければ制限が外れ、二飛香は外れない', () => {
  const { g, legal } = playKings(BLOCK_ONLY_BY_LANCE);
  eq(g.fuseki.isKingAttacked(1), true, '後手玉に飛が当たっている');
  eq(legal.has('L*5d'), false, '遮る L*5d は二飛香');
  if (!legal.size) throw new Error('打てる手が無い');
  for (const u of legal) if (u.slice(2, 3) === '3' || u.slice(2, 3) === '5') throw new Error(`飛・香のある筋に打てる: ${u}`);
  g.play([...legal][0]);
  eq(g.result?.reason, 'fuseki_king_capture', '41手目の裁定');
  eq(g.result.winner, 'sente', '先手の勝ち');
  eq([...playKings(BLOCK_ONLY_BY_LANCE, { balanceRules: 1 }).legal].join(' '), 'L*5d', '1版では遮る手だけ');
});

check('版の無い手順の版を決める（二飛香に当たる手順は1版で再生する）', () => {
  eq(rulesForTokens(fuseki, NIHIKYO_40.split(' ')), 2, '二飛香に合う手順');
  eq(rulesForTokens(fuseki, `${NIHIKYO_24} L*8c`.split(' ')), 1, '二飛香に当たる旧ルールの手順');
  eq(rulesForTokens(fuseki, `${NIHIKYO_24} K*5e`.split(' ')), 2, 'どちらの版でも入らない手順');
});

check('待ったで作り直しても版は変わらない。布石将棋に旗は立たない', () => {
  const { g } = playKings(`${NIHIKYO_24} P*1d P*2h`);
  g.undoTo(g.tokens().length - 2);
  eq(g.fuseki.legalDrops().some(d => d.usi === 'L*8c'), false, '戻した局面でも二飛香');
  eq(g.fusekiRules, FUSEKI_RULE_NIHIKYO, '天秤将棋の旗');
  eq(new Game({ fuseki, policy: null, engine: null }).fusekiRules, 0, '布石将棋の旗');
  throws(() => newGame('placer', { balanceRules: 3 }), '知らない版');
});

console.log('--- 選ぶ前の終局 ---');

check('選ぶ前に投了しても表示の口が全部読める', () => {
  const g = newGame('chooser', { rng: () => 0 });
  g.playAiMove(); g.playAiMove();
  g.resign();
  eq(g.phase, 'over', '終局');
  eq(g.result.winner, null, '勝った色は無い');
  eq(g.result.winnerIs, 'ai', '勝ったのはAI');
  const r = readEverything(g);
  eq(r.turnColor, null, '終局後の手番');
  eq(r.dropDests.size, 0, '終局後に打てる手');
});

check('選んだ後の投了は色が付く', () => {
  const g = newGame('placer');
  g.playFusekiDrop('K*5i'); g.playFusekiDrop('K*5a');
  g.playAiMove();   // AIは先手側
  g.resign();
  eq(g.result.winner, 'sente', 'AI（先手）の勝ち');
  eq(g.result.winnerIs, 'ai', '勝ったのはAI');
});

check('置く前に時間切れになっても壊れない', () => {
  const g = newGame('placer');
  g.timeout();
  eq(g.result.reason, 'human_timeout', '理由');
  eq(g.result.winnerIs, 'ai', '勝ったのはAI');
  readEverything(g);
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
