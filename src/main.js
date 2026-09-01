// 対局画面のエントリ。3つのエンジンを起こし、Gameを回し、盤へ映す。
//
// アセットの場所をここで決めているのは、src/ の他のモジュールを環境に依存させないため。
// test/pipeline_smoke.mjs は同じモジュールをNodeから別のパスで起こしている。
import { Fuseki } from './fuseki.js';
import { FusekiPolicy } from './policy.js';
import { NormalEngine, loadYaneuraOuFactory } from './normal.js';
import { Game, SENTE, GOTE } from './game.js';
import { createBoard, syncBoard } from './board.js';

const ASSETS = {
  fuseki: new URL('./vendor/fuseki/fuseki.mjs', import.meta.url).href,
  // onnxruntime-web は bundle 版を使っているのでJSグルーは同梱されている。
  // 差し替えるのは .wasm だけ（文字列で渡すと .mjs も外部から取りにいってしまう）。
  ortWasm: { wasm: new URL('./vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href },
  // ファイル名は build.mjs が define で渡す（--model で差し替えられる）。
  // esbuildを通さずに素で読み込んだときのために既定値を持たせる。
  model: new URL(`./models/${typeof __MODEL_FILE__ === 'undefined'
    ? 'fuseki_rollout_iter38.onnx' : __MODEL_FILE__}`, import.meta.url).href,
  yaneuraou: new URL('./vendor/yaneuraou/yaneuraou.k-p.js', import.meta.url).href,
};

// 布石フェーズの駒打ちのUSI表記（打つ駒の文字は手番に関わらず大文字）。
const USI_LETTER = {
  pawn: 'P', lance: 'L', knight: 'N', silver: 'S', bishop: 'B', rook: 'R', gold: 'G', king: 'K',
};

const el = id => document.getElementById(id);
const ui = {
  statusLine: el('status-line'), statusSub: el('status-sub'),
  ply: el('readout-ply'), phase: el('readout-phase'), evaluation: el('readout-eval'),
  kifu: el('kifu'),
  color: el('opt-color'), movetime: el('opt-movetime'),
  newGame: el('btn-new'), resign: el('btn-resign'), flip: el('btn-flip'),
};

let engines = null;   // { fuseki, policy, engine }
let game = null;
let sg = null;
let orientation = SENTE;
let busy = false;     // AIが考えている間の二重駆動を防ぐ

boot();

async function boot() {
  try {
    setStatus('布石フェーズのルールを読み込んでいる…');
    const fuseki = await Fuseki.load(ASSETS.fuseki);

    setStatus('布石方策を読み込んでいる…', '約30MB');
    const policy = await FusekiPolicy.load({ model: ASSETS.model, wasmPaths: ASSETS.ortWasm });

    // やねうら王はSharedArrayBufferを使う。COOP/COEPが立っていない配信では
    // 1スレッドに落ちる（_headers を参照）。
    const threads = globalThis.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    setStatus('通常フェーズのエンジンを起こしている…', `${threads}スレッド`);
    const engine = await NormalEngine.load({
      factory: await loadYaneuraOuFactory(ASSETS.yaneuraou), threads, hashMb: 64,
    });

    engines = { fuseki, policy, engine };
    ui.newGame.disabled = false;
    setStatus('準備できた。対局開始を押す。', threads === 1
      ? 'SharedArrayBufferが無いため通常フェーズは1スレッドで動く' : '');
  } catch (e) {
    setStatus('起動に失敗した', e.message);
    console.error(e);
  }
}

ui.newGame.addEventListener('click', () => startGame());
ui.resign.addEventListener('click', () => {
  if (!game || game.phase === 'over') return;
  game.resign();
  render();
});
ui.flip.addEventListener('click', () => {
  if (!sg) return;
  // set({orientation}) では駄目。向きはマスのsgKeyと駒台の色に焼き込まれていて、
  // 変更には再ラップが要る。それをやるのが toggleOrientation。
  sg.toggleOrientation();
  orientation = sg.state.orientation;
});

function startGame() {
  if (busy || !engines) return;
  const humanColor = ui.color.value === GOTE ? GOTE : SENTE;
  orientation = humanColor;
  game = new Game({ ...engines, humanColor, movetimeMs: Number(ui.movetime.value) });

  if (!sg) {
    sg = createBoard({
      wrapEl: el('board'), handTopEl: el('hand-top'), handBottomEl: el('hand-bottom'),
      orientation, onDrop: handleDrop, onMove: handleMove,
    });
  } else if (sg.state.orientation !== orientation) {
    sg.toggleOrientation();
  }
  ui.resign.disabled = false;
  render();
  drive();
}

/** 人間の駒打ち。布石フェーズと通常フェーズで指し手の意味が違う。 */
function handleDrop(piece, key) {
  if (!game || !game.isHumanTurn) return render();
  try {
    if (game.phase === 'fuseki') game.playFusekiDrop(`${USI_LETTER[piece.role]}*${key}`);
    else game.playNormalMove(`${USI_LETTER[piece.role]}*${key}`);
  } catch (e) {
    setStatus('その手は指せない', e.message);
  }
  render();
  drive();
}

/** 人間の移動（通常フェーズのみ）。 */
function handleMove(orig, dest, prom) {
  if (!game || !game.isHumanTurn) return render();
  try {
    game.playNormalMove(`${orig}${dest}${prom ? '+' : ''}`);
  } catch (e) {
    setStatus('その手は指せない', e.message);
  }
  render();
  drive();
}

/** 人間の手番になるか終局するまでAIに指させる。 */
async function drive() {
  if (busy || !game) return;
  busy = true;
  try {
    while (game.phase !== 'over' && !game.isHumanTurn) {
      render();
      await game.playAiMove();
      render();
    }
  } catch (e) {
    setStatus('エンジンでエラーが起きた', e.message);
    console.error(e);
  } finally {
    busy = false;
    render();
  }
}

// ---- 表示 ----

const RESULT_TEXT = {
  fuseki_king_capture: '41手目に玉を取れる形で布石が終わった',
  checkmate: '詰み',
  stalemate: '指す手が無い',
  draw: '引き分け',
  human_resign: '投了',
  ai_resign: 'AIの投了',
  ai_nyugyoku_declaration: 'AIの入玉宣言',
  engine_illegal_move: 'エンジンが非合法手を返した',
};

function render() {
  if (!game) return;
  if (sg) syncBoard(sg, game);

  ui.ply.textContent = game.phase === 'over' ? `${game.kifu.length}手で終局` : `${game.ply}手目`;
  ui.phase.textContent = game.phase === 'fuseki'
    ? `布石（残り${40 - game.fusekiMoves.length}手）`
    : game.phase === 'normal' ? '通常' : '終局';
  ui.evaluation.textContent = formatEval(game.lastEval);
  renderKifu();

  if (game.phase === 'over') {
    const { winner, reason } = game.result;
    const who = winner === null ? '引き分け'
      : `${winner === SENTE ? '先手' : '後手'}の勝ち${winner === game.humanColor ? '（あなた）' : ''}`;
    setStatus(who, RESULT_TEXT[reason] ?? reason);
    ui.resign.disabled = true;
  } else if (game.isHumanTurn) {
    setStatus(game.phase === 'fuseki' ? 'あなたの番。駒台から駒を打つ。' : 'あなたの番。');
  } else {
    setStatus('AIが考えている…', game.phase === 'fuseki' ? '布石方策（探索なし）' : 'やねうら王');
  }
}

function renderKifu() {
  // 追加された分だけ足す。1手ごとに全消しすると自動スクロールが跳ねる。
  while (ui.kifu.childElementCount > game.kifu.length) ui.kifu.lastElementChild.remove();
  for (let i = ui.kifu.childElementCount; i < game.kifu.length; i++) {
    const entry = game.kifu[i];
    const li = document.createElement('li');
    li.className = entry.color === SENTE ? 'sente' : 'gote';
    li.innerHTML = `<span class="n">${entry.ply}</span><span class="m">${entry.text}</span>`;
    ui.kifu.appendChild(li);
  }
  ui.kifu.scrollTop = ui.kifu.scrollHeight;
}

function formatEval(evaluation) {
  if (!evaluation) return '—';
  if (evaluation.kind === 'policy') {
    // 布石専用ネットは価値ヘッドを持たない（採点はやねうら王がやる）ので勝率が出ない。
    // その場合は方策が採用手に与えた確率を出す。undefinedを%にして "NaN%" と
    // 表示させないこと。
    // 布石の合法手は序盤で288手あるので、整数%だと採用手が "0%" になる。小数1桁にする。
    if (evaluation.winRate == null)
      return `採用手の確率 ${(evaluation.probability * 100).toFixed(1)}%`;
    return `勝率 ${(evaluation.winRate * 100).toFixed(0)}%（手番側）`;
  }
  if (evaluation.scoreKind === 'mate') return `${evaluation.score > 0 ? '' : '-'}${Math.abs(evaluation.score)}手詰`;
  if (evaluation.scoreKind === 'cp') return `${evaluation.score > 0 ? '+' : ''}${evaluation.score}（深さ${evaluation.depth ?? '?'}）`;
  return '—';
}

function setStatus(line, sub = '') {
  ui.statusLine.textContent = line;
  ui.statusSub.textContent = sub;
}
