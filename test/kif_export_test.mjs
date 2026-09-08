// 41手目の局面から先だけのKIF（Game.kifFromMove41）を Game 単体で見る。
//
// 見るのは次の不変条件:
//   - 盤面図を shogiops の parseKifHeader で読み戻すと、41手目の局面（盤・持ち駒・手番）に一致する
//   - 指し手の行を parseKifMoveOrDrop で読み戻して並べ直すと、対局の局面に一致する（「同　」込み）
//   - 終局は終端の手（投了・詰み・千日手…）と「まで◯手で…」の行になる
//   - 布石が終わる前は null
//
//   node test/kif_export_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSfen, makeSfen } from 'shogiops/sfen';
import { makeUsi, parseUsi } from 'shogiops/util';
import { parseKifHeader, parseKifMoveOrDrop, normalizedKifLines } from 'shogiops/notation/kif';
import { Fuseki } from '../src/fuseki.js';
import { Game } from '../src/game.js';

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

const SAMPLES = fs.readFileSync(path.join(HERE, 'sample_sfens.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l).sfen);
const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);

/** 通常フェーズに入った直後の Game を、41手目局面の見本から直接作る（eval_record_test と同じ手）。 */
function normalGame(sfen41, { humanColor = 'sente' } = {}) {
  const g = new Game({ fuseki, policy: null, engine: null, humanColor });
  for (let i = 0; i < 40; i++) g.kifu.push({ ply: i + 1, color: i % 2 ? 'gote' : 'sente', usi: 'P*5e', actor: 'ai', text: '', snapshot: null });
  g.position = parseSfen('standard', sfen41, false).unwrap();
  g.finalSfen = sfen41;
  g.phase = 'normal';
  return g;
}
/** 盤・持ち駒・手番だけのSFEN（手数を落とす）。 */
const sfen3 = pos => makeSfen(pos).split(' ').slice(0, 3).join(' ');

/**
 * 「取って取り返す」（同　が出る）手順を探す。見本のどれかには必ずある。
 * 返り値は [取る手, 同で取り返す手] と、その見本のSFEN。
 */
function findRecapture() {
  for (const sfen of SAMPLES) {
    const pos = parseSfen('standard', sfen, false).unwrap();
    for (const [from, tos] of pos.allMoveDests()) {
      for (const to of tos) {
        if (!pos.board.has(to)) continue;
        const usi1 = legalUsi(pos, from, to);
        if (!usi1) continue;
        const p2 = pos.clone();
        p2.play(parseUsi(usi1));
        if (p2.outcome()) continue;
        for (const [from2, tos2] of p2.allMoveDests()) {
          if (!tos2.has(to)) continue;
          const usi2 = legalUsi(p2, from2, to);
          if (usi2) return { sfen, usis: [usi1, usi2] };
        }
      }
    }
  }
  throw new Error('取り合いになる見本が無い');
}
/** KIFの行。normalizedKifLines は記号を全角に直すので、行の形を見るときはこちら。 */
const rawLines = kif => kif.trimEnd().split('\n');
/**
 * KIFの指し手の行だけ（「   1 ７六歩(77)   ( 0:00/00:00:00)」→「７六歩(77)」）。
 * 「同　」の全角空白は JS の \s に入るので、消費時間の括弧「( 0:00/」を目印に切る。
 */
function moveTexts(kif) {
  return rawLines(kif)
    .map(l => /^\s*\d+\s+(.+?)\s*\(\s*\d+:\d+\//.exec(l))
    .filter(Boolean)
    .map(m => m[1]);
}
/**
 * from→to の合法手のUSI。成らないと非合法な手（行き所の無い歩・桂・香）は成る。
 * どちらも非合法なら null。
 */
function legalUsi(pos, from, to) {
  for (const promotion of [false, true]) {
    const md = { from, to, promotion };
    if (pos.isLegal(md)) return makeUsi(md);
  }
  return null;
}
/** KIFを読み戻して、終わりの局面を並べる。終端の手（投了など）は指し手ではないので無視。 */
function replay(kif) {
  const pos = parseKifHeader(kif).unwrap();
  let lastDest;
  for (const text of moveTexts(kif)) {
    const md = parseKifMoveOrDrop(text, lastDest);
    if (!md) continue;   // 投了・詰みなどの終端
    if (!pos.isLegal(md)) throw new Error(`読み戻した手が非合法: ${text}`);
    pos.play(md);
    lastDest = md.to;
  }
  return pos;
}

console.log('kif_export_test');

await check('布石が終わる前は null', () => {
  const g = new Game({ fuseki, policy: null, engine: null });
  eq(g.kifFromMove41(), null, 'kifFromMove41');
});

const { sfen, usis } = findRecapture();

await check('盤面図を読み戻すと41手目の局面に一致する', () => {
  const g = normalGame(sfen);
  const kif = g.kifFromMove41({ sente: 'あなた', gote: 'AIレベル3', notes: ['布石将棋'] });
  const back = parseKifHeader(kif).unwrap();
  eq(sfen3(back), sfen.split(' ').slice(0, 3).join(' '), '読み戻した局面');
  const lines = normalizedKifLines(kif);
  if (!lines.includes('先手：あなた') || !lines.includes('後手：AIレベル3')) throw new Error('対局者の行が無い');
  if (!lines.some(l => l.startsWith('手合割：その他'))) throw new Error('手合割の行が無い');
  if (!lines.includes('# 布石将棋')) throw new Error('コメント行が無い');
  eq(moveTexts(kif).length, 0, '指し手の行');
});

await check('取って取り返す手順が「同　」で書かれ、読み戻すと局面が一致する', () => {
  const g = normalGame(sfen);
  for (const usi of usis) g.playNormalMove(usi);
  const kif = g.kifFromMove41();
  const texts = moveTexts(kif);
  eq(texts.length, 2, '指し手の行数');
  if (!texts[1].startsWith('同')) throw new Error(`2手目が「同」でない: ${texts[1]}`);
  eq(sfen3(replay(kif)), sfen3(g.position), '読み戻した局面');
  eq(kif.endsWith('\n'), true, '末尾の改行');
});

await check('数手進めて読み戻すと局面が一致する（打つ手を含む）', () => {
  const g = normalGame(sfen);
  const seen = { drop: false };
  for (let i = 0; i < 24 && g.phase === 'normal'; i++) {
    // 打てる手があれば打つ（打の書き方も通す）。無ければ最初の合法手。
    let usi = null;
    // allDropDests の鍵は「sente pawn」の形（PieceName）。
    for (const [name, tos] of g.position.allDropDests()) {
      const role = name.split(' ')[1];
      for (const to of tos) { if (g.position.isLegal({ role, to })) { usi = makeUsi({ role, to }); break; } }
      if (usi) break;
    }
    if (usi) seen.drop = true;
    else for (const [from, tos] of g.position.allMoveDests()) { for (const to of tos) { usi = legalUsi(g.position, from, to); if (usi) break; } if (usi) break; }
    g.playNormalMove(usi);
  }
  const kif = g.kifFromMove41();
  eq(moveTexts(kif).length, g.normalMoves.length, '指し手の行数');
  eq(sfen3(replay(kif)), sfen3(g.position), '読み戻した局面');
  eq(seen.drop, true, '打つ手を含む');
});

await check('投了は「投了」と「まで◯手で…の勝ち」になる', () => {
  const g = normalGame(sfen, { humanColor: 'sente' });
  for (const usi of usis) g.playNormalMove(usi);
  g.resign();   // 先手（人間）の投了 → 後手の勝ち
  const kif = g.kifFromMove41();
  const lines = rawLines(kif);
  if (!lines.some(l => /^\s*3 投了/.test(l))) throw new Error(`終端の手が無い:\n${kif}`);
  eq(lines.at(-1), 'まで2手で後手の勝ち', '末尾');
  eq(sfen3(replay(kif)), sfen3(g.position), '読み戻した局面');
});

await check('千日手・連続王手・入玉宣言・中断の終端', () => {
  const g = normalGame(sfen);
  g.result = { winner: null, reason: 'sennichite' }; g.phase = 'over';
  let lines = rawLines(g.kifFromMove41());
  eq(lines.at(-2), '   1 千日手        ( 0:00/00:00:00)', '千日手の行');
  eq(lines.at(-1), 'まで0手で千日手', '千日手の末尾');
  // 41手目の手番は先手。先手が勝ったなら手番側の反則勝ち、後手が勝ったなら手番側の反則負け。
  g.result = { winner: 'sente', reason: 'perpetual_check' };
  eq(rawLines(g.kifFromMove41()).at(-2), '   1 反則勝ち       ( 0:00/00:00:00)', '手番側の反則勝ち');
  g.result = { winner: 'gote', reason: 'perpetual_check' };
  eq(rawLines(g.kifFromMove41()).at(-2), '   1 反則負け       ( 0:00/00:00:00)', '手番側の反則負け');
  g.result = { winner: 'sente', reason: 'ai_nyugyoku_declaration' };
  lines = rawLines(g.kifFromMove41());
  eq(lines.at(-2), '   1 入玉勝ち       ( 0:00/00:00:00)', '入玉宣言');
  eq(lines.at(-1), 'まで0手で先手の勝ち', '入玉宣言の末尾');
  g.result = { winner: null, reason: 'aborted' };
  eq(rawLines(g.kifFromMove41()).at(-1), 'まで0手で中断', '中断');
});

console.log(failures ? `NG: ${failures}件` : 'all OK');
process.exit(failures ? 1 : 0);
