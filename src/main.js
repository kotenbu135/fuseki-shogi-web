// 対局画面のエントリ。3つのエンジンを起こし、Gameを回し、盤へ映す。
//
// アセットの場所をここで決めているのは、src/ の他のモジュールを環境に依存させないため。
// test/pipeline_smoke.mjs は同じモジュールをNodeから別のパスで起こしている。
import { Fuseki } from './fuseki.js';
import { FusekiPolicy } from './policy.js';
import { NormalEngine, loadYaneuraOuFactory } from './normal.js';
import { Game, SENTE, GOTE, fusekiDropText } from './game.js';
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
    ? 'fuseki_degct_b3_iter46.onnx' : __MODEL_FILE__}`, import.meta.url).href,
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
  color: el('opt-color'), level: el('opt-level'), volume: el('opt-volume'),
  scale: el('opt-scale'), time: el('opt-time'), theme: el('opt-theme'),
  app: document.querySelector('.app'), controls: el('controls'),
  gear: el('btn-settings'), settingsPop: el('display-settings'),
  ioMoves: el('io-moves'), ioSfen: el('io-sfen'), ioNote: el('io-note'),
  ioLoad: el('btn-io-load'), ioCopy: el('btn-io-copy'),
  engine: el('engine'), engineHead: el('engine-head'), enginePv: el('engine-pv'),
  gauge: el('eval-gauge'),
  resultActions: el('result-actions'),
  again: el('btn-again'), replay: el('btn-replay'), copyKifu: el('btn-copy-kifu'),
  newGame: el('btn-new'), resign: el('btn-resign'), flip: el('btn-flip'), undo: el('btn-undo'),
  navFirst: el('nav-first'), navPrev: el('nav-prev'),
  navNext: el('nav-next'), navLast: el('nav-last'),
  seatTop: el('seat-top'), seatBottom: el('seat-bottom'),
  seatTopName: el('seat-top-name'), seatBottomName: el('seat-bottom-name'),
  clockTop: el('clock-top'), clockBottom: el('clock-bottom'),
};

// 配色。自動（端末に合わせる）／明るい／暗い。localStorageに残す。
// CSS側は :root（明るい）、@media prefers-color-scheme + :not([data-theme="light"])、
// :root[data-theme="dark"] の3段で受ける。
const THEME_KEY = 'fuseki-theme';
function applyTheme(v) {
  const root = document.documentElement;
  if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v);
  else root.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, v); } catch { /* 残せなくても効く */ }
}
{
  let saved = 'auto';
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') saved = v;
  } catch { /* 読めなければ自動 */ }
  ui.theme.value = saved;
  applyTheme(saved);
  ui.theme.addEventListener('change', () => applyTheme(ui.theme.value));
}

// 表示の設定は歯車の中。対局中も触れる（対局の設定は対局前だけ）。
function closeSettings() {
  ui.settingsPop.hidden = true;
  ui.gear.setAttribute('aria-expanded', 'false');
}
ui.gear.addEventListener('click', () => {
  const open = ui.settingsPop.hidden;
  ui.settingsPop.hidden = !open;
  ui.gear.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => {
  if (ui.settingsPop.hidden) return;
  if (e.target.closest('#display-settings, #btn-settings')) return;
  closeSettings();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !ui.settingsPop.hidden) { closeSettings(); ui.gear.focus(); }
});

// AIの強さ。レベル → (やねうら王の思考時間, 布石方策のサンプリング温度)。
//
// 温度は1より下げない。policy.js の冒頭が「argmaxにすると同じ布石ばかりになり
// 棋風が別物になる」と止めている。強くする側は思考時間だけで作り、弱くする側だけを
// 温度で作る。したがって布石フェーズの強さが動くのはレベル1〜2で、3〜5の差は
// 通常フェーズにしか出ない（<option> のラベルにそう書いてある）。
//
// レベル3が既定で、movetime 1000 / 温度1 はレベルを入れる前の挙動と同じ。
// レベル1は500ms以下にしておくこと（test/browser_smoke.mjs の --full が
// 1局通すのにレベル1を選ぶ）。
const LEVELS = {
  1: { movetimeMs: 300, temperature: 3.0 },
  2: { movetimeMs: 500, temperature: 1.8 },
  3: { movetimeMs: 1000, temperature: 1.0 },
  4: { movetimeMs: 3000, temperature: 1.0 },
  5: { movetimeMs: 10000, temperature: 1.0 },
};
let aiLevel = 3;
{
  const v = Number(ui.level.value);
  if (LEVELS[v]) aiLevel = v;
  // 対局中は select が無効なので、この2つがずれることはない。
  ui.level.addEventListener('change', () => {
    const n = Number(ui.level.value);
    if (LEVELS[n]) aiLevel = n;
    renderSeats();
  });
}
// 対局前に持ち時間を変えたら、席の時計もその場で書き換える。
{
  ui.time.addEventListener('change', renderSeats);
}

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
globalThis.__sound = sound;   // AudioContextが本当に起きたかを外から見るため
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

// 時計。既定（無制限）では1手ごとの持ち時間ではなく、その色が考えた累計を数え上げる。
// 布石将棋に時間切れ負けのルールは無いので、減らすのではなく増やす。
// 持ち時間を選んだときだけ、**人間側に限って**減る時計を重ねる（下の humanClock）。
// AI側は常に累計のまま。AIの予算はレベル（1手あたりの思考時間）が決めている。
const clock = { sente: 0, gote: 0, running: null, since: 0 };
let clockTimer = null;

// 人間側の持ち時間。null は無制限で、そのときは上の累計だけが動く。
//
// 秒読みは「本時間を使い切ってから1手 byoyomiMs」。本時間から先に減り、
// 尽きたら手番ごとに byoyomiMs が配られる。加算（フィッシャー）は着手の確定時に足す。
const TIME_CONTROLS = {
  none: null,
  '3m': { initialMs: 180000 },
  '10s': { initialMs: 0, byoyomiMs: 10000 },
  '10m+30s': { initialMs: 600000, byoyomiMs: 30000 },
  '5m+5s': { initialMs: 300000, incrementMs: 5000 },
};
let timeCtl = null;      // TIME_CONTROLS のどれか（無制限なら null）
let humanClock = null;   // { mainMs } 本時間の残り

/** 人間の手番で、その手にいま何ms使っているか。手番でなければ0。 */
function usedThisTurnMs() {
  if (!game || !timeCtl || clock.running !== game.humanColor) return 0;
  return performance.now() - clock.since;
}

/** 人間の時計のいまの姿。本時間が尽きていれば秒読みに入る。 */
function humanClockState() {
  const used = usedThisTurnMs();
  const by = timeCtl.byoyomiMs ?? 0;
  if (humanClock.mainMs > used) return { mainMs: humanClock.mainMs - used, byMs: by, inByoyomi: false };
  return { mainMs: 0, byMs: Math.max(0, by - (used - humanClock.mainMs)), inByoyomi: true };
}

/** 人間の手番が終わった。使ったぶんを本時間から引き、加算があれば足す。 */
function commitHumanTurn(usedMs) {
  humanClock.mainMs = Math.max(0, humanClock.mainMs - usedMs) + (timeCtl.incrementMs ?? 0);
}

/** 手番が変わったところで、前の手番の消費を確定して次を回し始める。 */
function tickClock(turn) {
  const now = performance.now();
  const stop = () => {
    const used = now - clock.since;
    clock[clock.running] += used;
    // 人間の手番が閉じた瞬間に、持ち時間を確定させる。
    if (timeCtl && game && clock.running === game.humanColor) commitHumanTurn(used);
    clock.running = null;
  };
  if (clock.running && clock.running !== turn) stop();
  if (turn && clock.running !== turn) {
    clock.running = turn;
    clock.since = now;
  }
  if (!turn && clock.running) stop();
}

function clockMs(color) {
  const extra = clock.running === color ? performance.now() - clock.since : 0;
  return clock[color] + extra;
}

/**
 * 席に出す時計の文字列。
 *
 * 無制限のときは数えない。増えていく数字を時計の場所に置くと、持ち時間が
 * あるように見えて紛らわしい。時間の制約が無いことをそのまま書く。
 * 持ち時間があるときは、人間側は残り、AI側は考えた累計（AIの予算はレベルが決める）。
 */
function clockText(color) {
  // 対局前は選んでいる設定を見せる。対局中は始めたときの設定のまま。
  const tc = game ? timeCtl : (TIME_CONTROLS[ui.time.value] ?? null);
  if (!tc) return '無制限';
  if (!game) {
    // 10秒将棋は本時間0なので、0:00 と出すと切れているように見える。
    return tc.initialMs === 0 && tc.byoyomiMs
      ? `秒読み ${(tc.byoyomiMs / 1000).toFixed(1)}`
      : formatClock(tc.initialMs);
  }
  if (color !== game.humanColor) return formatClock(clockMs(color));
  const st = humanClockState();
  // 秒読み中は小数第1位まで。ここは1秒が意味を持つ場面なので秒だけでは足りない。
  // 秒読みの無い設定（切れ負け・加算）では出さない。本時間が0になった＝そこで負け。
  if (st.inByoyomi && (tc.byoyomiMs ?? 0) > 0) return `秒読み ${(st.byMs / 1000).toFixed(1)}`;
  return formatClock(st.mainMs);
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
  renderSettingsEnabled();
  try {
    setStatus('布石フェーズのルールを読み込んでいる…');
    const fuseki = await Fuseki.load(ASSETS.fuseki);

    // 内訳は onnxruntime-web の .wasm 13.3MB と重み 1.9MB（dist/ の実測）。
    // ここが起動でいちばん待たされる。数字を直すときは両方を測り直すこと。
    setStatus('布石方策を読み込んでいる…', '約15MB');
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
    setStatus('対局開始を押してください', threads === 1
      ? 'SharedArrayBufferが無いため通常フェーズは1スレッドで動く' : '');
  } catch (e) {
    setStatus('起動に失敗した', e.message);
    console.error(e);
  }
}

// AudioContext は利用者の操作の中でしか起こせない。対局開始のクリックが最初の機会。
function newGameClicked() {
  sound.unlock();
  startGame();
}
ui.newGame.addEventListener('click', newGameClicked);
ui.again.addEventListener('click', newGameClicked);
ui.replay.addEventListener('click', () => goToPly(0));
ui.copyKifu.addEventListener('click', () => game && copyText(kifuText(), ui.copyKifu, '棋譜をコピー'));
ui.ioCopy.addEventListener('click', () => game && copyText(movesText(), ui.ioCopy, '手順をコピー'));
ui.ioLoad.addEventListener('click', loadMoves);

// 待った。AI相手なので相手の合意は要らない。自分の直前の一手を取り消す。
ui.undo.addEventListener('click', () => {
  const n = undoTarget();
  if (n < 0 || busy || viewPly !== null || !game || game.phase === 'over') return;
  game.undoTo(n);
  // 戻した手をもう一度鳴らさない。
  soundedKifu = Math.min(soundedKifu, game.kifu.length);
  viewPly = null;
  disarmResign();
  render();
  // 普通は自分の手番に戻るので何も起きない。後手を持って0手目まで戻したときだけ効く。
  drive();
});

/** 待ったで戻す先の手数。自分がまだ1手も指していなければ -1。 */
function undoTarget() {
  if (!game) return -1;
  const k = game.kifu;
  let n = k.length;
  while (n > 0 && k[n - 1].color !== game.humanColor) n--;   // AIの手を飛ばす
  return n - 1;                                             // 自分の手を1つ消す
}
// 投了は取り消せない。1回目は確認に変え、2回目で確定する（lishogiも2段階）。
let resignArmed = null;
function disarmResign() {
  clearTimeout(resignArmed);
  resignArmed = null;
  ui.resign.textContent = '投了';
  ui.resign.classList.remove('armed');
}
ui.resign.addEventListener('click', () => {
  if (!game || game.phase === 'over') return;
  if (!resignArmed) {
    ui.resign.textContent = '本当に投了？';
    ui.resign.classList.add('armed');
    // 押しっぱなしにしておくと誤爆するので、少し経ったら戻す。
    resignArmed = setTimeout(disarmResign, 4000);
    return;
  }
  disarmResign();
  game.resign();
  render();
});
/** 対局開始時の人間の色。ランダムはここで決まる。 */
function chosenColor() {
  if (ui.color.value === 'random') return Math.random() < .5 ? SENTE : GOTE;
  return ui.color.value === GOTE ? GOTE : SENTE;
}

// 対局前に手番を変えたら、盤の向きも先に合わせる（対局開始を押す前に確かめられる）。
// ランダムのときは決まっていないので回さない。対局開始の瞬間に回る。
ui.color.addEventListener('change', () => {
  if (game && game.phase !== 'over') return;
  if (ui.color.value !== 'random') {
    orientation = ui.color.value === GOTE ? GOTE : SENTE;
    ensureBoard();
    showIdleBoard(sg);
  }
  renderSeats();
});

// 対局中の離脱を1回止める。局面はどこにも保存していないので、
// 誤ってリロードすると40手の布石がそのまま消える。取り返しがつかない。
addEventListener('beforeunload', e => {
  if (!game || game.phase === 'over') return;
  e.preventDefault();
  e.returnValue = '';   // 古いブラウザはこちらを見る
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
  const humanColor = chosenColor();
  orientation = humanColor;
  // レベルは select を真とする（値を直接入れてから対局開始を押されても効くように）。
  const n = Number(ui.level.value);
  if (LEVELS[n]) aiLevel = n;
  const lv = LEVELS[aiLevel] ?? LEVELS[3];
  game = new Game({ ...engines, humanColor, movetimeMs: lv.movetimeMs, temperature: lv.temperature });
  soundedKifu = 0;
  soundedOver = false;
  viewPly = null;
  clock.sente = clock.gote = 0;
  clock.running = null;
  timeCtl = TIME_CONTROLS[ui.time.value] ?? null;
  humanClock = timeCtl ? { mainMs: timeCtl.initialMs } : null;
  // 一度指し始めたら見出しは畳む（狭い画面で1画面の1/4を食う）。終局後も戻さない。
  ui.app.classList.add('playing');
  ui.ioNote.textContent = '';
  // 時計は手番が変わったときにしか進まないので、表示だけ別に回す。
  // 時間切れの検出もここでやる。指さないまま切れる場合、render() は呼ばれない。
  clearInterval(clockTimer);
  clockTimer = setInterval(onClockTick, 250);

  ensureBoard();
  // 対局中に押せると、進行中の対局が黙って消える。投了で終わらせてから始める
  // （lishogiも対局中に新規対局は始められない）。
  ui.newGame.disabled = true;
  ui.resign.disabled = false;
  ui.resultActions.hidden = true;
  disarmResign();
  renderSettingsEnabled();
  render();
  drive();
}

/** 250msごと。時計を描き直し、人間の持ち時間が切れていたらそこで終局させる。 */
function onClockTick() {
  if (game && timeCtl && game.phase !== 'over' && game.turnColor === game.humanColor) {
    const st = humanClockState();
    if (st.inByoyomi && st.byMs <= 0) {
      game.timeout();
      render();
      return;
    }
  }
  renderSeats();
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
  human_timeout: '持ち時間が切れた',
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

/** 対局中に変えても効かない設定は触れなくする。
 *  手番は変更を握りつぶしていたし、持ち時間は対局開始のときにしか読まれない。
 *  触れるのに何も起きないのは、壊れているのと区別がつかない。 */
function renderSettingsEnabled() {
  const playing = !!game && game.phase !== 'over';
  ui.color.disabled = playing;
  ui.level.disabled = playing;
  ui.time.disabled = playing;
  // 対局中は畳む。無効化して灰色のまま置くと、棋譜に回せる高さを食うだけになる。
  // 要素は消さない（disabled を外から見られるようにしておく）。
  ui.controls.hidden = playing;
}

/** 席の名前・手番の印・時計。対局前でも呼べる。 */
function renderSeats() {
  // ランダムを選んで対局前のあいだは、どちらを持つか決まっていない。
  const randomPending = !game && ui.color.value === 'random';
  const humanColor = game ? game.humanColor : (ui.color.value === GOTE ? GOTE : SENTE);
  // 下が手前（自分）。盤を反転しても席の並びは動かさない。
  const bottom = orientation;
  const top = bottom === SENTE ? GOTE : SENTE;
  // AI側にはレベルを書く。どのくらいの相手と指しているかが席にないと分からない。
  // エンジン名（布石方策／やねうら王）は入れない。考えている間は setStatus の
  // 副題に出ていて二重になる。
  const label = c => {
    const name = c === SENTE ? '先手' : '後手';
    if (randomPending) return name;
    return c === humanColor ? `${name}（あなた）` : `${name}（布石AI レベル${aiLevel}）`;
  };
  ui.seatTopName.textContent = label(top);
  ui.seatBottomName.textContent = label(bottom);
  ui.clockTop.textContent = clockText(top);
  ui.clockBottom.textContent = clockText(bottom);
  // 残り30秒を切ったら色を変える。秒読み中は常に立てる。
  const low = c => {
    if (!timeCtl || !game || c !== game.humanColor || game.phase === 'over') return false;
    const st = humanClockState();
    return st.inByoyomi || st.mainMs < 30000;
  };
  ui.clockTop.classList.toggle('low', low(top));
  ui.clockBottom.classList.toggle('low', low(bottom));
  const turn = game && game.phase !== 'over' ? game.turnColor : null;
  ui.seatTop.classList.toggle('turn', turn === top);
  ui.seatBottom.classList.toggle('turn', turn === bottom);
  // 考えているのはAIのときだけ。人間の番で脈を打たせると急かしているように見える。
  const thinking = busy && turn !== null && turn !== humanColor;
  ui.seatTop.classList.toggle('thinking', thinking && turn === top);
  ui.seatBottom.classList.toggle('thinking', thinking && turn === bottom);
}

/** 通常フェーズに入ってから人間が指したか。41手目の案内を引っ込める合図に使う。
 *  通常フェーズは41手目＝先手から始まるので、指し手の並びの偶奇が色になる。 */
function hasHumanMovedInNormal() {
  if (!game || game.phase === 'fuseki') return false;
  return game.normalMoves.some((_, i) => (i % 2 === 0 ? SENTE : GOTE) === game.humanColor);
}

function render() {
  // 対局前は空の盤と満杯の駒台を出し、読み出しは空にしておく。
  if (!game) {
    if (sg) showIdleBoard(sg);
    ui.ply.textContent = ui.phase.textContent = ui.evaluation.textContent = '—';
    ui.engine.hidden = ui.gauge.hidden = ui.resultActions.hidden = true;
    ui.undo.disabled = true;
    ui.ioSfen.value = '';
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
  renderEngine();
  renderGauge();
  ui.ioSfen.value = game.sfen();
  ui.undo.disabled = busy || viewPly !== null || game.phase === 'over' || undoTarget() < 0;
  playMoveSounds();

  if (game.phase === 'over') {
    clearInterval(clockTimer);
    clockTimer = null;
    const { who, why } = resultLine();
    setStatus(who, why);
    ui.resign.disabled = true;
    ui.newGame.disabled = false;
    ui.resultActions.hidden = false;
    disarmResign();
    renderSettingsEnabled();
  } else if (viewPly !== null) {
    setStatus(`${viewPly}手目までを表示中`, '盤には触れない。最新へ戻すと指せる（→ / End）。');
  } else if (game.isHumanTurn) {
    // 41手目でルールが変わる。フェーズの表示が切り替わるだけでは気づけないので、
    // 通常フェーズで自分がまだ1手も指していないあいだは言い続ける。
    // 「一度だけ」にすると、直後の drive() の再描画に上書きされて誰も読めない。
    if (game.phase === 'normal' && !hasHumanMovedInNormal()) {
      setStatus('41手目。ここから普通の将棋。', '打つのは取った駒だけ。盤の駒を動かす。');
    } else {
      setStatus(game.phase === 'fuseki' ? 'あなたの番。駒台から駒を打つ。' : 'あなたの番。');
    }
  } else {
    setStatus('AIが考えている…', game.phase === 'fuseki' ? '布石方策（探索なし）' : 'やねうら王');
  }
}

/** 勝敗の一行。表示と棋譜の書き出しで共有する。 */
function resultLine() {
  const { winner, reason } = game.result;
  const who = winner === null ? '引き分け'
    : `${winner === SENTE ? '先手' : '後手'}の勝ち${winner === game.humanColor ? '（あなた）' : ''}`;
  return { who, why: RESULT_TEXT[reason] ?? reason };
}

/** エンジンの言い分。数字が誰のものかを画面に出す。 */
function renderEngine() {
  const ev = game.lastEval;
  if (!ev) { ui.engine.hidden = true; return; }
  ui.engine.hidden = false;
  if (ev.kind === 'policy') {
    ui.engineHead.textContent = '布石方策（探索なし）';
    // 候補手は方策が既に返している（policy.js の pick）。探索を増やさずに
    // 読み筋相当が作れる唯一の材料なので出す。
    ui.enginePv.textContent = (ev.candidates ?? [])
      .map(c => `${fusekiDropText(c.move.usi, c.move.role)} ${(c.probability * 100).toFixed(1)}%`)
      .join('  ');
    return;
  }
  const bits = ['やねうら王'];
  if (ev.depth != null) bits.push(`深さ${ev.depth}`);
  if (ev.nps != null) bits.push(formatNps(ev.nps));
  ui.engineHead.textContent = bits.join(' · ');
  // 読み筋はUSIのまま。日本語表記にするにはPositionを複製して1手ずつ進める必要があり、
  // それ自体が別の仕事になる。
  ui.enginePv.textContent = ev.pv?.length ? `読み筋 ${ev.pv.join(' ')}` : '';
}

function formatNps(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M NPS` : `${Math.round(n / 1000)}k NPS`;
}

/**
 * 評価ゲージ。通常フェーズだけ出す。
 *
 * 布石フェーズの「採用手の確率」は方策が自分の手にどれだけ自信があるかであって
 * 優劣ではない。両側に振れる帯に載せると「先手が良い」と読めてしまうので載せない。
 */
function renderGauge() {
  const ev = game.lastEval;
  const show = ev && ev.kind === 'search' && ev.score != null;
  ui.gauge.hidden = !show;
  if (!show) return;
  // USIの評価値は探索した側（＝AI）から見た値。先手から見た値に直す。
  const cp = ev.scoreKind === 'mate' ? (ev.score > 0 ? 1e5 : -1e5) : ev.score;
  const fromSente = game.aiColor === SENTE ? cp : -cp;
  const p = 1 / (1 + Math.exp(-fromSente / 400));
  ui.gauge.style.setProperty('--eval-p', String(p));
}

/**
 * 棋譜の書き出し。KIFとは呼ばない。KIFには「空の盤＋持ち駒20枚」を表す書き方が無く、
 * KIFと名乗って どのKIFリーダーも読めないのは、素のテキストより悪い。
 */
function kifuText() {
  const seats = game.humanColor === SENTE
    ? '先手 あなた・後手 布石AI' : '先手 布石AI・後手 あなた';
  const lines = [`布石将棋 / AIレベル${aiLevel} / ${seats}`];
  for (const e of game.kifu) {
    // 41手目の局面は指し手からは再現できない（布石フェーズにPositionが無い）。
    if (e.ply === 41 && game.finalSfen) lines.push(`41手目局面 sfen ${game.finalSfen}`);
    lines.push(`${String(e.ply).padStart(3, ' ')} ${e.text}`);
  }
  if (game.kifu.length === 40 && game.finalSfen) lines.push(`41手目局面 sfen ${game.finalSfen}`);
  if (game.phase === 'over') {
    const { who, why } = resultLine();
    lines.push(`結果: ${who}（${why}）`);
  }
  return lines.join('\n');
}

/** クリップボードへ。押したボタンの文言で結果を返す。 */
async function copyText(text, button, label) {
  const done = ok => {
    button.textContent = ok ? 'コピーした' : 'コピーできなかった';
    setTimeout(() => { button.textContent = label; }, 2000);
  };
  try {
    await navigator.clipboard.writeText(text);
    return done(true);
  } catch { /* httpsでない環境には clipboard が無い。下の手で拾う。 */ }
  // 選択してコピーする昔ながらの経路。これも駄目なら諦めてコンソールへ出す。
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok) console.log(text);
  done(ok);
}

/** 局面を渡すのは手順のほう。布石フェーズにはSFENから局面を作る道が無い。 */
function movesText() {
  return game ? [...game.fusekiMoves, ...game.normalMoves].join(' ') : '';
}

/**
 * 貼られた手順から対局を作り直す。
 *
 * SFENからは作れない。fuseki.js に局面を書き込むAPIが無く（reset と drop だけ）、
 * 打っていない駒はSFENに乗らないため。再生の経路は待った（undoTo）と同じ。
 */
function loadMoves() {
  const moves = ui.ioMoves.value.trim().split(/\s+/).filter(Boolean);
  if (!moves.length) return note('手順が空です。');
  if (!engines) return note('まだエンジンが起動していません。');
  if (busy) return note('AIが考えているあいだは読み込めません。');

  sound.unlock();     // 利用者の操作の中でしか起こせない。ここも最初の機会になりうる
  startGame();        // 時計も設定も入れ直す。この直後の drive() は下の undoTo で捨てられる
  game.undoTo(0);
  let i = 0;
  try {
    for (; i < moves.length; i++) {
      if (game.phase === 'over') throw new Error('この手順は途中で終局している');
      if (game.phase === 'fuseki') game.playFusekiDrop(moves[i]);
      else game.playNormalMove(moves[i]);
    }
  } catch (e) {
    // 途中まで再生された盤は、正しい盤と区別がつかない。握り潰さずどこで止めたか言う。
    note(`${i + 1}手目「${moves[i]}」で止まりました: ${e.message}`);
    soundedKifu = game.kifu.length;
    render();
    return;
  }
  note(`${moves.length}手を読み込みました。`);
  viewPly = null;
  soundedKifu = game.kifu.length;   // 読み込んだぶんの駒音は鳴らさない
  render();
  drive();
}

function note(text) { ui.ioNote.textContent = text; }

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
