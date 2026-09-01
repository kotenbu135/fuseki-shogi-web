// 対局画面が使う経路をそのままNodeで1局通す。ブラウザを立てずに、
//   布石40手（WASMのmovegen + onnxruntime-webの方策）
//     → 41手目の裁定
//       → 通常フェーズ（shogiops + やねうら王WASM）
// までを1本に繋いで、途中で壊れないことを見る。src/ のモジュールを
// ブラウザと同じものを同じ順で呼んでいる（onnxruntime-web/wasm はNodeでも動く）。
//
//   node test/pipeline_smoke.mjs [通常フェーズの手数] [movetime ms] [モデル.onnx]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fuseki, BLACK, WHITE } from '../src/fuseki.js';
import { FusekiPolicy } from '../src/policy.js';
import { NormalEngine } from '../src/normal.js';
import { Game } from '../src/game.js';
import { makeSfen, parseSfen } from 'shogiops/sfen';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NORMAL_PLIES = Number(process.argv[2] || 6);
const MOVETIME = Number(process.argv[3] || 1000);
const MODEL = process.argv[4] || path.join(ROOT, 'models/fuseki_rollout_iter38.onnx');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) { failures++; console.log(`  NG ${label} ${detail}`); }
  return cond;
};

if (!fs.existsSync(MODEL)) {
  console.error(`models/fuseki_rollout_iter38.onnx が無い。開発用リポジトリからコピーすること（models/README.md）。`);
  process.exit(1);
}

// 乱数を固定して再現できるようにする（本番はMath.random）。
let seed = 20260901n;
const rng = () => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
  return Number(seed >> 40n) / 16777216;
};

const t0 = Date.now();
const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);
console.log(`布石WASM初期化: ${Date.now() - t0}ms`);

const t1 = Date.now();
const policy = await FusekiPolicy.load({ model: new Uint8Array(fs.readFileSync(MODEL)) });
console.log(`布石方策(onnxruntime-web)ロード: ${Date.now() - t1}ms`);

const require = createRequire(import.meta.url);
const t2 = Date.now();
const engine = await NormalEngine.load({ factory: require('@mizarjp/yaneuraou.k-p'), threads: 2, hashMb: 64 });
console.log(`やねうら王WASM初期化: ${Date.now() - t2}ms\n`);

const game = new Game({ fuseki, policy, engine, humanColor: 'sente', movetimeMs: MOVETIME });

// ---- 布石フェーズ40手 ----
const t3 = Date.now();
for (let i = 0; i < 40; i++) {
  const expectedColor = i % 2 === 0 ? 'sente' : 'gote';
  check(`${i + 1}手目の手番`, game.turnColor === expectedColor, `${game.turnColor}`);
  const dests = game.dropDests();
  check(`${i + 1}手目に打てる駒がある`, dests.size > 0);
  const picked = await policy.pick(fuseki, { rng });
  // 人間の入力と同じ経路（USI文字列 → 合法手照合）を通す
  game.playFusekiDrop(picked.move.usi);
}
const fusekiMs = Date.now() - t3;
console.log(`布石40手: ${fusekiMs}ms (1手あたり ${(fusekiMs / 40).toFixed(0)}ms)`);
console.log(`棋譜: ${game.fusekiMoves.join(' ')}`);

check('40手打ち切った', game.fusekiMoves.length === 40);
check('全9筋に各色の歩がちょうど1枚', filesWithOnePawnEach(game.boardPieces));

// ---- 41手目の裁定 ----
if (game.phase === 'over') {
  console.log(`\n41手目の裁定で決着: 勝ち=${game.result.winner} 理由=${game.result.reason}`);
  check('裁定の理由が布石の玉取り', game.result.reason === 'fuseki_king_capture');
  check('裁定の勝者は先手', game.result.winner === 'sente');
} else {
  check('通常フェーズへ移った', game.phase === 'normal', game.phase);
  console.log(`\n41手目局面: ${game.finalSfen}`);
  check('SFENの手数が41', game.finalSfen.endsWith(' 41'));
  check('後手玉は先手の利きに当たっていない', !fuseki.isKingAttacked(WHITE));

  // 成りの設定。shogigroundの既定は promotesTo: () => undefined で、渡し忘れると
  // ダイアログが一度も開かず「人間だけ成れない」対局画面になる。
  const prom = game.promotion();
  check('成り駒の対応が入っている', prom.promotesTo('pawn') === 'tokin' && prom.unpromotesTo('dragon') === 'rook');
  const promotable = [...game.moveDests()].flatMap(([orig, dests]) => dests.map(dest => [orig, dest]))
    .find(([orig, dest]) => prom.movePromotionDialog(orig, dest));
  if (promotable) console.log(`  成りを選べる手の例: ${promotable.join('')}`);

  // ---- 通常フェーズ ----
  const t4 = Date.now();
  for (let i = 0; i < NORMAL_PLIES && game.phase === 'normal'; i++) {
    const before = game.position.turn;
    const evaluated = await game.playAiMove();
    if (game.phase === 'over') { console.log(`  終局: ${game.result.reason}`); break; }
    const usi = game.normalMoves[game.normalMoves.length - 1];
    const d = evaluated ? `depth=${evaluated.depth} score=${evaluated.scoreKind} ${evaluated.score}` : '';
    console.log(`  ${41 + i}手目 ${before} ${usi.padEnd(6)} ${d}`);
    check(`${41 + i}手目で手番が入れ替わった`, game.phase === 'over' || game.position.turn !== before);
  }
  // 人間の着手の経路（AIのbestmoveではなく playNormalMove）も1手通す。
  if (game.phase === 'normal') {
    // moveDests()の先頭を決め打って `orig+dest` を指してはいけない。成りが**強制**される手
    // （桂が1〜2段目へ跳ぶ、歩・香が1段目へ行く）は接尾辞 '+' が無いと非合法で、
    // 盤面によってここで落ちる。実際にiter4の局面で 7d6b が弾かれた。
    // 成り無し→成り有りの順に試し、通った最初の1手を人間の着手とする。
    const pairs = [...game.moveDests()].flatMap(([orig, dests]) => dests.map(d => [orig, d]));
    const before = game.normalMoves.length;
    let played = null;
    for (const [orig, dest] of pairs) {
      for (const usi of [`${orig}${dest}`, `${orig}${dest}+`]) {
        try { game.playNormalMove(usi); played = usi; break; } catch { /* 次の候補へ */ }
      }
      if (played) break;
    }
    check('人間の着手が通った', played !== null && game.normalMoves.length === before + 1,
      `${played ?? '（候補 ' + pairs.length + '手すべてが非合法）'} ${game.kifu.at(-1)?.text ?? ''}`);
    // 非合法手を '1a1b' のように決め打つと、盤面によっては**本当に合法**で
    // 弾かれない（実際にiter4の局面で起きた）。合法手一覧から作る:
    // ある駒の移動先として挙がっていないマスは、その駒からは必ず非合法である。
    const [orig2, dests2] = [...game.moveDests()][0];
    const all = [];
    for (const f of '123456789') for (const r of 'abcdefghi') all.push(f + r);
    const illegalDest = all.find(sq => sq !== orig2 && !dests2.includes(sq));
    let rejected = false;
    try { game.playNormalMove(`${orig2}${illegalDest}`); } catch { rejected = true; }
    check('非合法手は弾かれる', rejected, `${orig2}${illegalDest}`);
  }

  const normalMs = Date.now() - t4;
  console.log(`通常フェーズ ${game.normalMoves.length}手: ${normalMs}ms`);
  check('通常フェーズが1手以上進んだ', game.normalMoves.length > 0);

  // 進行後の局面がSFENとして往復できること（表示と真実がズレていない）
  const roundtrip = parseAndRemake(game);
  check('局面のSFENラウンドトリップ', roundtrip.ok, roundtrip.detail);
}

engine.terminate();
console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);

function filesWithOnePawnEach(pieces) {
  for (const color of ['sente', 'gote']) {
    for (let file = 1; file <= 9; file++) {
      let n = 0;
      for (const rank of 'abcdefghi') {
        const p = pieces.get(`${file}${rank}`);
        if (p && p.color === color && p.role === 'pawn') n++;
      }
      if (n !== 1) return false;
    }
  }
  return true;
}

function parseAndRemake(game) {
  const sfen = makeSfen(game.position);
  const again = parseSfen('standard', sfen, false);
  if (again.isErr) return { ok: false, detail: String(again.error) };
  return { ok: makeSfen(again.unwrap()) === sfen, detail: sfen };
}
