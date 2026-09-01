// 41手目の裁定（docs/rules.md）が、shogiops の Position を作る**前**に効いていることの確認。
//
// 40手打ち終えた時点で手番側（先手）が相手玉を取れる局面は、shogiops が
// ERR_OPPOSITE_CHECK で弾く。裁定を後回しにすると「先手の勝ちが確定した局面」が
// 「SFENの解析エラー」として出てくる。ここではその局面を実際に作り、
//   - Game が例外ではなく fuseki_king_capture で終局すること
//   - その局面は確かに shogiops が受理しないこと（＝順序を入れ替えたら壊れること）
// を見る。
//
// 方策は使わず一様乱数で打つ（NNを通さないぶん速く、裁定に当たる率も高い）。
//
//   node test/adjudication_test.mjs [試行する局数]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSfen } from 'shogiops/sfen';
import { Fuseki, WHITE } from '../src/fuseki.js';
import { Game } from '../src/game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = Number(process.argv[2] || 60);

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

let seed = 1234567n;
const rng = () => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
  return Number(seed >> 40n) / 16777216;
};

const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);

let adjudicated = 0, normal = 0, firstCase = null;
for (let g = 0; g < GAMES; g++) {
  const game = new Game({ fuseki, policy: null, engine: null, humanColor: 'sente' });
  for (let i = 0; i < 40; i++) {
    const legal = fuseki.legalDrops();
    game.playFusekiDrop(legal[Math.floor(rng() * legal.length)].usi);
  }
  if (game.phase === 'over') {
    adjudicated++;
    if (!firstCase) firstCase = { sfen: fuseki.toSfen(), result: game.result, moves: game.fusekiMoves.length };
  } else {
    normal++;
    // 通常フェーズへ渡した局面は、shogiopsが受理できるものだけであること。
    if (parseSfen('standard', game.finalSfen, false).isErr) {
      failures++;
      console.log(`  NG 通常フェーズへ渡した局面をshogiopsが弾いた: ${game.finalSfen}`);
    }
  }
}

console.log(`${GAMES}局: 41手目の裁定で決着 ${adjudicated}局 / 通常フェーズへ ${normal}局\n`);
check('裁定が1局以上発火した（発火しないとこのテストは何も見ていない）', adjudicated > 0);

if (firstCase) {
  console.log(`  例: ${firstCase.sfen}`);
  check('40手で終局している', firstCase.moves === 40);
  check('理由が fuseki_king_capture', firstCase.result.reason === 'fuseki_king_capture', firstCase.result.reason);
  check('勝者は41手目の手番側（先手）', firstCase.result.winner === 'sente', String(firstCase.result.winner));

  // 裁定を Position の後ろに回したらどうなるか、を実際に見せる。
  const parsed = parseSfen('standard', firstCase.sfen, false);
  check('shogiops はこの局面を受理しない', parsed.isErr, parsed.isErr ? String(parsed.error) : '受理してしまった');
  check('WASM側の最終検査も弾く', !fuseki.verifyFinalSfen(firstCase.sfen));
}

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
