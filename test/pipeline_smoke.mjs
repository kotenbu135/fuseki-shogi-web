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
const MODEL = process.argv[4] || path.join(ROOT, 'models/fuseki_degct_b3_iter46.onnx');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) { failures++; console.log(`  NG ${label} ${detail}`); }
  return cond;
};

if (!fs.existsSync(MODEL)) {
  console.error(`models/fuseki_degct_b3_iter46.onnx が無い。開発用リポジトリからコピーすること（models/README.md）。`);
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
// 打った手数と盤上の枚数が合うこと。同じマスへ二重に打つと Map が上書きされて
// 静かに1枚減る（ブラウザのテストで39枚と数えたことがあり、そこを切り分けるために足した）。
check('盤上の枚数が打った手数と合う', game.boardPieces.size === 40, `${game.boardPieces.size}枚`);
check('SFENの駒数も40', game.boardSfen().replace(/[0-9/+]/g, '').length === 40, game.boardSfen());
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
    // 読み筋とNPSは対局画面がそのまま出す（main.js の renderEngine）。
    // normal.js の parseInfo が拾い損ねると、画面から静かに消えるだけで誰も気づかない。
    check(`${41 + i}手目に読み筋とNPSが付いている`,
      !evaluated || (Array.isArray(evaluated.pv) && evaluated.pv.length > 0 && evaluated.nps > 0),
      evaluated ? `pv=${(evaluated.pv ?? []).slice(0, 3).join(' ')} nps=${evaluated.nps}` : '（評価なし）');
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

// ---- 待った（undoTo） ----
// 切り詰めて最初から再生する実装なので、戻して同じ手を指し直せば元の局面に戻る。
// 40/41の境目をまたいで戻る場合（position を null に、phase を 'fuseki' に戻す）も
// 同じ経路を通る。
{
  const all = [...game.fusekiMoves, ...game.normalMoves];
  if (all.length >= 2) {
    const beforeSfen = game.boardSfen();
    const beforePhase = game.phase;
    const beforeKifu = game.kifu.map(e => e.text).join(' ');
    const keep = all.length - 2;
    const epoch = game.epoch;
    game.undoTo(keep);
    check('待ったで手数が減る', game.kifu.length === keep, `${game.kifu.length}手`);
    check('待ったでepochが上がる', game.epoch === epoch + 1, `${game.epoch}`);
    for (const usi of all.slice(keep)) {
      if (game.phase === 'fuseki') game.playFusekiDrop(usi);
      else game.playNormalMove(usi);
    }
    check('指し直すと同じ局面に戻る', game.boardSfen() === beforeSfen, game.boardSfen());
    check('指し直すとフェーズも戻る', game.phase === beforePhase, game.phase);
    check('指し直すと棋譜も同じ', game.kifu.map(e => e.text).join(' ') === beforeKifu);
  }
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
