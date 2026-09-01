// 対局画面のエントリ。3つのエンジンを起こし、Gameを回し、盤へ映す。
//
// アセットの場所をここで決めているのは、src/ の他のモジュールを環境に依存させないため。
// test/pipeline_smoke.mjs は同じモジュールをNodeから別のパスで起こしている。
import { Fuseki } from './fuseki.js';
import { FusekiPolicy } from './policy.js';
import { NormalEngine, loadYaneuraOuFactory } from './normal.js';
import { Game, SENTE, GOTE } from './game.js';
import { createBoard, showIdleBoard, showSnapshot, syncBoard } from './board.js';
import { Sound, VOICES } from './sound.js';

const ASSETS = {
  fuseki: new URL('./vendor/fuseki/fuseki.mjs', import.meta.url).href,
  // onnxruntime-web は bundle 版を使っているのでJSグルーは同梱されている。
  // 差し替えるのは .wasm だけ（文字列で渡すと .mjs も外部から取りにいってしまう）。
  ortWasm: { wasm: new URL('./vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href },
  // ファイル名は build.mjs が define で渡す（--model で差し替えられる）。
  // esbuildを通さずに素で読み込んだときのために既定値を持たせる。ここだけは
  // build.mjs の PUBLIC_MODEL と二重に持つことになるので、片方を変えたら両方直す。
  model: new URL(`./models/${typeof __MODEL_FILE__ === 'undefined'
    ? 'fuseki_degct_b3_iter4.onnx' : __MODEL_FILE__}`, import.meta.url).href,
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
  color: el('opt-color'), movetime: el('opt-movetime'), volume: el('opt-volume'),
  scale: el('opt-scale'),
  newGame: el('btn-new'), resign: el('btn-resign'), flip: el('btn-flip'),
  navFirst: el('nav-first'), navPrev: el('nav-prev'),
  navNext: el('nav-next'), navLast: el('nav-last'),
  seatTop: el('seat-top'), seatBottom: el('seat-bottom'),
  seatTopName: el('seat-top-name'), seatBottomName: el('seat-bottom-name'),
  clockTop: el('clock-top'), clockBottom: el('clock-bottom'),
};

// 盤の大きさ。localStorageに残す。
const SCALE_KEY = 'fuseki-board-scale';
function applyScale(pct) {
  const root = document.documentElement.style;
  root.setProperty('--board-scale', `${pct}%`);
  root.setProperty('--board-scale-f', String(pct / 100));
  try { localStorage.setItem(SCALE_KEY, String(pct)); } catch { /* 残せなくても効く */ }
}
{
  let saved = 100;
  try {
    const v = Number.parseInt(localStorage.getItem(SCALE_KEY) ?? '', 10);
    if (v >= 70 && v <= 115) saved = v;
  } catch { /* 読めなければ既定 */ }
  ui.scale.value = String(saved);
  applyScale(saved);
  ui.scale.addEventListener('input', () => applyScale(Number(ui.scale.value)));
}

const sound = new Sound();
// 音は合成なので、鳴っているかを外から数値で確かめられるようにしておく。
// test/browser_smoke.mjs が OfflineAudioContext に差し替えて振幅を見る。
globalThis.__VOICES = VOICES;
ui.volume.value = String(Math.round(sound.volume * 100));
ui.volume.addEventListener('input', () => {
  sound.setVolume(Number(ui.volume.value) / 100);
  sound.unlock();          // スライダーを動かすのも利用者の操作なので、ここで起こしてよい
});
let soundedKifu = 0;       // 音を鳴らし終えた手数
let soundedOver = false;

// 棋譜のどこを見ているか。null なら対局中の（最新の）局面。
// 0 は初手より前（空の盤）、n は n手目を指した直後。
let viewPly = null;

// 時計。1手ごとの持ち時間ではなく、その色が考えた累計を数え上げる。
// 布石将棋に時間切れ負けのルールは無いので、減らすのではなく増やす。
const clock = { sente: 0, gote: 0, running: null, since: 0 };
let clockTimer = null;

/** 手番が変わったところで、前の手番の消費を確定して次を回し始める。 */
function tickClock(turn) {
  const now = performance.now();
  if (clock.running && clock.running !== turn) {
    clock[clock.running] += now - clock.since;
    clock.running = null;
  }
  if (turn && clock.running !== turn) {
    clock.running = turn;
    clock.since = now;
  }
  if (!turn && clock.running) {
    clock[clock.running] += now - clock.since;
    clock.running = null;
  }
}

function clockMs(color) {
  const extra = clock.running === color ? performance.now() - clock.since : 0;
  return clock[color] + extra;
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const mmss = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  // 布石フェーズのAIはNN前向き1回で、1手が数十msで終わる。秒までしか出さないと
  // 何手指しても 0:00 のままで、時計が壊れているように見える。10秒未満は
  // 小数第1位まで出して、速さがそのまま見えるようにする。
  return total < 10 ? `${mmss}.${Math.floor(ms / 100) % 10}` : mmss;
}

let engines = null;   // { fuseki, policy, engine }
let game = null;
let sg = null;
let orientation = SENTE;
let busy = false;     // AIが考えている間の二重駆動を防ぐ

/** 盤を1枚だけ作る。対局前から出しておきたいので、起動時にも呼ぶ。 */
function ensureBoard() {
  if (!sg) {
    sg = createBoard({
      wrapEl: el('board'), orientation, onDrop: handleDrop, onMove: handleMove,
    });
  } else if (sg.state.orientation !== orientation) {
    sg.toggleOrientation();
  }
  return sg;
}

boot();

async function boot() {
  // エンジン3本のロードには時間がかかる。その間に盤を出しておかないと、
  // 待っている人の前にあるのがパネルだけの空白になる。
  ensureBoard();
  showIdleBoard(sg);
  renderSeats();
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

ui.newGame.addEventListener('click', () => {
  // AudioContext は利用者の操作の中でしか起こせない。対局開始のクリックが最初の機会。
  sound.unlock();
  startGame();
});
ui.resign.addEventListener('click', () => {
  if (!game || game.phase === 'over') return;
  game.resign();
  render();
});
// 対局前に手番を変えたら、盤の向きも先に合わせる（対局開始を押す前に確かめられる）。
ui.color.addEventListener('change', () => {
  if (game && game.phase !== 'over') return;
  orientation = ui.color.value === GOTE ? GOTE : SENTE;
  ensureBoard();
  showIdleBoard(sg);
  renderSeats();
});

ui.navFirst.addEventListener('click', () => goToPly(0));
ui.navPrev.addEventListener('click', () => goToPly((viewPly === null ? game?.kifu.length ?? 0 : viewPly) - 1));
ui.navNext.addEventListener('click', () => goToPly((viewPly ?? 0) + 1));
ui.navLast.addEventListener('click', () => goToPly(null));

// 棋譜の行を押したらその局面へ。lishogiと同じ。
ui.kifu.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (li) goToPly([...ui.kifu.children].indexOf(li) + 1);
});

// 矢印キーでも動かす。入力欄に居るときは奪わない。
document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = game?.kifu.length ?? 0;
  const at = viewPly === null ? n : viewPly;
  if (e.key === 'ArrowLeft') goToPly(at - 1);
  else if (e.key === 'ArrowRight') goToPly(at + 1);
  else if (e.key === 'Home') goToPly(0);
  else if (e.key === 'End') goToPly(null);
  else return;
  e.preventDefault();
});

ui.flip.addEventListener('click', () => {
  if (!sg) return;
  // set({orientation}) では駄目。向きはマスのsgKeyと駒台の色に焼き込まれていて、
  // 変更には再ラップが要る。それをやるのが toggleOrientation。
  sg.toggleOrientation();
  orientation = sg.state.orientation;
  renderSeats();
});

function startGame() {
  if (busy || !engines) return;
  const humanColor = ui.color.value === GOTE ? GOTE : SENTE;
  orientation = humanColor;
  game = new Game({ ...engines, humanColor, movetimeMs: Number(ui.movetime.value) });
  soundedKifu = 0;
  soundedOver = false;
  viewPly = null;
  clock.sente = clock.gote = 0;
  clock.running = null;
  // 時計は手番が変わったときにしか進まないので、表示だけ別に回す。
  clearInterval(clockTimer);
  clockTimer = setInterval(renderSeats, 250);

  ensureBoard();
  // 対局中に押せると、進行中の対局が黙って消える。投了で終わらせてから始める
  // （lishogiも対局中に新規対局は始められない）。
  ui.newGame.disabled = true;
  ui.resign.disabled = false;
  render();
  drive();
}

/** 人間の駒打ち。布石フェーズと通常フェーズで指し手の意味が違う。 */
function handleDrop(piece, key) {
  if (!game || !game.isHumanTurn || viewPly !== null) return render();
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
  if (!game || !game.isHumanTurn || viewPly !== null) return render();
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

/** 盤に何を映すか。過去を見ている間は対局中の局面を出さない。 */
function renderBoard() {
  if (!sg || !game) return;
  const reviewing = viewPly !== null;
  // .sg-wrap は shogiground が #board に足したクラス。内部を覗かず自分の要素を触る。
  el('board').classList.toggle('reviewing', reviewing);
  if (!reviewing) return void syncBoard(sg, game);
  if (viewPly === 0) return void showIdleBoard(sg);
  showSnapshot(sg, game.kifu[viewPly - 1].snapshot);
}

/** さかのぼる操作。対局中の局面へ戻るまで盤は触れない。 */
function goToPly(ply) {
  if (!game || !game.kifu.length) return;
  const last = game.kifu.length;
  viewPly = ply === null || ply >= last ? null : Math.max(0, ply);
  render();
}

function renderNav() {
  const n = game ? game.kifu.length : 0;
  const at = viewPly === null ? n : viewPly;
  ui.navFirst.disabled = ui.navPrev.disabled = n === 0 || at === 0;
  ui.navNext.disabled = ui.navLast.disabled = n === 0 || viewPly === null;
}

/** 席の名前・手番の印・時計。対局前でも呼べる。 */
function renderSeats() {
  const humanColor = game ? game.humanColor : (ui.color.value === GOTE ? GOTE : SENTE);
  // 下が手前（自分）。盤を反転しても席の並びは動かさない。
  const bottom = orientation;
  const top = bottom === SENTE ? GOTE : SENTE;
  const label = c => `${c === SENTE ? '先手' : '後手'}（${c === humanColor ? 'あなた' : '布石AI'}）`;
  ui.seatTopName.textContent = label(top);
  ui.seatBottomName.textContent = label(bottom);
  ui.clockTop.textContent = formatClock(clockMs(top));
  ui.clockBottom.textContent = formatClock(clockMs(bottom));
  const turn = game && game.phase !== 'over' ? game.turnColor : null;
  ui.seatTop.classList.toggle('turn', turn === top);
  ui.seatBottom.classList.toggle('turn', turn === bottom);
  // 考えているのはAIのときだけ。人間の番で脈を打たせると急かしているように見える。
  const thinking = busy && turn !== null && turn !== humanColor;
  ui.seatTop.classList.toggle('thinking', thinking && turn === top);
  ui.seatBottom.classList.toggle('thinking', thinking && turn === bottom);
}

function render() {
  // 対局前は空の盤と満杯の駒台を出し、読み出しは空にしておく。
  if (!game) {
    if (sg) showIdleBoard(sg);
    ui.ply.textContent = ui.phase.textContent = ui.evaluation.textContent = '—';
    renderSeats();
    renderNav();
    return;
  }
  renderBoard();

  ui.ply.textContent = game.phase === 'over' ? `${game.kifu.length}手で終局` : `${game.ply}手目`;
  ui.phase.textContent = game.phase === 'fuseki'
    ? `布石（残り${40 - game.fusekiMoves.length}手）`
    : game.phase === 'normal' ? '通常' : '終局';
  ui.evaluation.textContent = formatEval(game.lastEval);
  tickClock(game.phase === 'over' ? null : game.turnColor);
  renderSeats();
  renderKifu();
  renderNav();
  playMoveSounds();

  if (game.phase === 'over') {
    clearInterval(clockTimer);
    clockTimer = null;
    const { winner, reason } = game.result;
    const who = winner === null ? '引き分け'
      : `${winner === SENTE ? '先手' : '後手'}の勝ち${winner === game.humanColor ? '（あなた）' : ''}`;
    setStatus(who, RESULT_TEXT[reason] ?? reason);
    ui.resign.disabled = true;
    ui.newGame.disabled = false;
  } else if (viewPly !== null) {
    setStatus(`${viewPly}手目までを表示中`, '盤には触れない。最新へ戻すと指せる（→ / End）。');
  } else if (game.isHumanTurn) {
    setStatus(game.phase === 'fuseki' ? 'あなたの番。駒台から駒を打つ。' : 'あなたの番。');
  } else {
    setStatus('AIが考えている…', game.phase === 'fuseki' ? '布石方策（探索なし）' : 'やねうら王');
  }
}

/** 棋譜が伸びたぶんだけ音を鳴らす。render()は何度も呼ばれるので、
 *  鳴らした位置を覚えておかないと同じ手で何度も鳴る。 */
function playMoveSounds() {
  if (game.kifu.length > soundedKifu) {
    const last = game.kifu[game.kifu.length - 1];
    // 王手は駒音を含んだ別の音にする（lishogiも王手だけ差し替えている）。
    sound.play(game.checks() ? 'check' : last.capture ? 'capture' : 'move');
    soundedKifu = game.kifu.length;
  }
  if (game.phase === 'over' && !soundedOver) {
    soundedOver = true;
    const { winner } = game.result;
    sound.play(winner === null ? 'draw' : winner === game.humanColor ? 'win' : 'lose');
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
  // 塗るのは「今見ている手」。対局中の局面なら最後の手。
  const at = viewPly === null ? game.kifu.length : viewPly;
  const cur = at > 0 ? ui.kifu.children[at - 1] : null;
  for (const li of ui.kifu.querySelectorAll('li.current')) if (li !== cur) li.classList.remove('current');
  if (cur) {
    cur.classList.add('current');
    // さかのぼっているときだけ視界に入れる。対局中は下端に貼り付いていてほしい。
    if (viewPly !== null) cur.scrollIntoView({ block: 'nearest' });
  }
  if (viewPly === null) ui.kifu.scrollTop = ui.kifu.scrollHeight;
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
