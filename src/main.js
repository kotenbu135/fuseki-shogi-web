// 対局画面のエントリ。3つのエンジンを起こし、Gameを回し、盤へ映す。
//
// 画面は2つ。ホーム（ルールを選んで設定して始める）と対局画面（盤とパネル）。
// 場所は URL のハッシュで持つ（#/ がホーム、#play が対局）。言語はパスで持つ
// （/ と /en/。i18n.js）。
//
// アセットの場所をここで決めているのは、src/ の他のモジュールを環境に依存させないため。
// test/pipeline_smoke.mjs は同じモジュールをNodeから別のパスで起こしている。
import { Fuseki } from './fuseki.js';
import { FusekiPolicy } from './policy.js';
import { NormalEngine, loadYaneuraOuFactory } from './normal.js';
import { Game, SENTE, GOTE } from './game.js';
import { KingTable } from './kings.js';
import { createBoard, showIdleBoard, showSnapshot, syncBoard } from './board.js';
import { Sound, VOICES } from './sound.js';
import { t, LANG } from './i18n.js';

const ASSETS = {
  fuseki: new URL('./vendor/fuseki/fuseki.mjs', import.meta.url).href,
  // onnxruntime-web は bundle 版を使っているのでJSグルーは同梱されている。
  // 差し替えるのは .wasm だけ（文字列で渡すと .mjs も外部から取りにいってしまう）。
  ortWasm: { wasm: new URL('./vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href },
  // ファイル名は build.mjs が define で渡す（--model で差し替えられる）。
  // esbuildを通さずに素で読み込んだときのために既定値を持たせる。ここだけは
  // build.mjs の PUBLIC_MODEL と二重に持つことになるので、片方を変えたら両方直す。
  model: new URL(`./models/${typeof __MODEL_FILE__ === 'undefined'
    ? 'fuseki_degct_b3_iter122.onnx' : __MODEL_FILE__}`, import.meta.url).href,
  // 玉分け将棋の価値表（src/kings.js）。重みと世代が対（build.mjs の KING_TABLE）。
  kingTable: new URL(`./models/${typeof __KING_TABLE_FILE__ === 'undefined'
    ? 'king_pairs_iter122.json' : __KING_TABLE_FILE__}`, import.meta.url).href,
  yaneuraou: new URL('./vendor/yaneuraou/yaneuraou.k-p.js', import.meta.url).href,
};

// 起動時に「約15MB」と出す量。内訳は onnxruntime-web の .wasm 13.3MB と重み 1.9MB
// （dist/ の実測）。build.mjs がこの定数と実物を突き合わせる。
const LOAD_MB = 15;

// 布石フェーズの駒打ちのUSI表記（打つ駒の文字は手番に関わらず大文字）。
const USI_LETTER = {
  pawn: 'P', lance: 'L', knight: 'N', silver: 'S', bishop: 'B', rook: 'R', gold: 'G', king: 'K',
};
const RANKS = 'abcdefghi';

const el = id => document.getElementById(id);
const ui = {
  app: el('app'), viewHome: el('view-home'), viewPlay: el('view-play'),
  logo: el('logo'), navPlay: el('nav-play'),
  statusLine: el('status-line'), statusSub: el('status-sub'),
  bootLine: el('boot-line'), bootSub: el('boot-sub'), boot: el('boot'),
  kifu: el('kifu'), stepper: el('stepper'), panel: el('panel'),
  color: el('opt-color'), level: el('opt-level'), volume: el('opt-volume'),
  scale: el('opt-scale'), time: el('opt-time'), theme: el('opt-theme'),
  role: el('opt-role'), colorLabel: el('lbl-color'), roleLabel: el('lbl-role'),
  modeKings: el('mode-kings'), modeStandard: el('mode-standard'),
  choiceRow: el('choice-row'), chooseSente: el('btn-choose-sente'), chooseGote: el('btn-choose-gote'),
  chooseConfirm: el('btn-choose-confirm'),
  controls: el('controls'),
  gear: el('btn-settings'), settingsPop: el('display-settings'),
  ioMoves: el('io-moves'), ioSfen: el('io-sfen'), ioNote: el('io-note'),
  ioLoad: el('btn-io-load'), ioCopy: el('btn-io-copy'),
  ioOpen: el('btn-io-open'), ioDialog: el('io-dialog'),
  leaveDialog: el('leave-dialog'), leaveCopy: el('btn-leave-copy'),
  leaveCancel: el('btn-leave-cancel'), leaveOk: el('btn-leave-ok'),
  showEval: el('opt-show-eval'), evaluation: el('readout-eval'),
  engine: el('engine'), engineHead: el('engine-head'), enginePv: el('engine-pv'),
  gauge: el('eval-gauge'), kingTags: el('king-tags'), toast: el('toast'),
  resultActions: el('result-actions'), resultNote: el('result-note'),
  again: el('btn-again'), replay: el('btn-replay'), copyKifu: el('btn-copy-kifu'), home: el('btn-home'),
  newGame: el('btn-new'), resign: el('btn-resign'), flip: el('btn-flip'), undo: el('btn-undo'),
  navFirst: el('nav-first'), navPrev: el('nav-prev'),
  navNext: el('nav-next'), navLast: el('nav-last'),
  seatTop: el('seat-top'), seatBottom: el('seat-bottom'),
  seatTopName: el('seat-top-name'), seatBottomName: el('seat-bottom-name'),
  clockTop: el('clock-top'), clockBottom: el('clock-bottom'),
};

// ---- 表示の設定（歯車） ----

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

// 対局中にAIの評価を見せるか。既定は隠す。形勢が見えると対局として面白くない
// （lishogiも対局中は解析を出さない）。終局したら設定に関わらず出す。
const EVAL_KEY = 'fuseki-show-eval';
let showEvalInPlay = false;
{
  try { showEvalInPlay = localStorage.getItem(EVAL_KEY) === '1'; } catch { /* 既定は隠す */ }
  ui.showEval.checked = showEvalInPlay;
  ui.showEval.addEventListener('change', () => {
    showEvalInPlay = ui.showEval.checked;
    try { localStorage.setItem(EVAL_KEY, showEvalInPlay ? '1' : '0'); } catch { /* 残せなくても効く */ }
    render();
    analyzeForHuman();   // その場から見えるように、人間の手番なら聞きに行く
  });
}

/** いま評価を出してよいか。対局中は設定しだい、終局後は常に出す。 */
function evalVisible() {
  return !!game && (game.phase === 'over' || showEvalInPlay);
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

// 局面の受け渡しはダイアログ。メニューの「棋譜」から開く。
ui.ioOpen.addEventListener('click', () => {
  closeSettings();
  ui.ioDialog.showModal();
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
  ui.level.addEventListener('change', () => {
    const n = Number(ui.level.value);
    if (LEVELS[n]) aiLevel = n;
  });
}

// 対局の設定は前回の値を覚える（ホームに戻るたびに選び直さなくてよい）。
const SETUP_KEY = 'fuseki-setup';
function saveSetup() {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify({
      mode: modeValue(), color: ui.color.value, role: ui.role.value,
      level: ui.level.value, time: ui.time.value,
    }));
  } catch { /* 残せなくても困らない */ }
}
function restoreSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null');
    if (!s) return;
    if (s.mode === 'kings-first') ui.modeKings.checked = true;
    for (const [sel, v] of [[ui.color, s.color], [ui.role, s.role], [ui.level, s.level], [ui.time, s.time]])
      if (v && [...sel.options].some(o => o.value === v)) sel.value = v;
    const n = Number(ui.level.value);
    if (LEVELS[n]) aiLevel = n;
  } catch { /* 壊れていれば既定のまま */ }
}
restoreSetup();
ui.controls.addEventListener('change', saveSetup);

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
  ui.scale.addEventListener('input', () => { applyScale(Number(ui.scale.value)); renderKingTags(); });
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

// ---- 時計 ----

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

/**
 * 席に出す時計の文字列。
 *
 * 無制限のときは数えない。増えていく数字を時計の場所に置くと、持ち時間が
 * あるように見えて紛らわしい。時間の制約が無いことをそのまま書く。
 * 持ち時間があるのは人間側だけ。AI側の予算はレベルが決めていて、席に置く数字が無い。
 */
function clockText(color) {
  if (!game || color !== game.humanColor) return '';
  const tc = timeCtl;
  if (!tc) return t('clock_unlimited');
  const st = humanClockState();
  // 秒読み中は小数第1位まで。ここは1秒が意味を持つ場面なので秒だけでは足りない。
  // 秒読みの無い設定（切れ負け・加算）では出さない。本時間が0になった＝そこで負け。
  if (st.inByoyomi && (tc.byoyomiMs ?? 0) > 0) return t('clock_byoyomi', { s: (st.byMs / 1000).toFixed(1) });
  return formatClock(st.mainMs);
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const mmss = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  // 10秒未満は小数第1位まで出して、速さがそのまま見えるようにする。
  return total < 10 ? `${mmss}.${Math.floor(ms / 100) % 10}` : mmss;
}

// ---- 対局の状態 ----

let engines = null;   // { fuseki, policy, engine, kingTable }
let game = null;
let sg = null;
let orientation = SENTE;
// 玉分け将棋では人間の色が選択の時点で決まる。その対局で一度だけ盤をその色へ回す
// （以後は手で反転できる）。回し終えた対局を覚えておく。
let orientedGame = null;
let busy = false;     // AIが考えている間の二重駆動を防ぐ
// 先後を選ぶ最中、押した（仮の）玉。確定するまで game には入れない。
let pendingSide = null;
// 段の境目の知らせ（トーストと音）のために、直前に描いたフェーズを覚えておく。
let phaseSeen = null;

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

/** ホームのルール選択。radio の値。 */
function modeValue() {
  return ui.modeKings.checked && !ui.modeKings.disabled ? 'kings-first' : 'standard';
}
function setMode(v) {
  (v === 'kings-first' ? ui.modeKings : ui.modeStandard).checked = true;
  renderModeControls();
}

// ---- 画面の切り替え（ホーム／対局） ----

function currentView() {
  return location.hash.replace(/^#\/?/, '') === 'play' ? 'play' : 'home';
}

function showView(name) {
  ui.viewHome.hidden = name !== 'home';
  ui.viewPlay.hidden = name !== 'play';
  ui.app.dataset.view = name;
  ui.navPlay.classList.toggle('current', name === 'home');
  if (name === 'play') {
    ensureBoard();
    render();
  }
}

/** URL に合わせて画面を出す。対局中にホームへ戻ろうとしたら確認する。 */
function route() {
  const want = currentView();
  const live = !!game && game.phase !== 'over';
  if (want === 'play') {
    // 対局が無いのに #play だけ開かれた（共有リンクやリロード）。ホームへ。
    if (!game) { history.replaceState(null, '', '#/'); showView('home'); return; }
    showView('play');
    return;
  }
  if (live) { ui.leaveDialog.showModal(); return; }
  abandonGame();
  showView('home');
}
addEventListener('hashchange', route);

/** 進行中の対局を捨てる。局面はどこにも保存しない（決定）。 */
function abandonGame() {
  clearInterval(clockTimer);
  clockTimer = null;
  game = null;
  viewPly = null;
  pendingSide = null;
  phaseSeen = null;
  disarmResign();
  render();   // パネルを idle に戻し、盤を空にする
}

function goHome() {
  if (currentView() === 'home') { route(); return; }
  location.hash = '#/';   // hashchange → route()
}
ui.logo.addEventListener('click', e => { e.preventDefault(); goHome(); });
ui.navPlay.addEventListener('click', e => { e.preventDefault(); goHome(); });
ui.home.addEventListener('click', goHome);
ui.leaveCancel.addEventListener('click', () => {
  ui.leaveDialog.close();
  // 戻るボタンで #/ に来ていたら、対局の URL へ戻す。
  if (currentView() !== 'play') history.pushState(null, '', '#play');
});
ui.leaveDialog.addEventListener('cancel', e => { e.preventDefault(); ui.leaveCancel.click(); });
ui.leaveOk.addEventListener('click', () => {
  ui.leaveDialog.close();
  abandonGame();
  if (currentView() !== 'home') history.replaceState(null, '', '#/');
  showView('home');
});
ui.leaveCopy.addEventListener('click', () => game && copyText(kifuText(), ui.leaveCopy, t('leave_copy')));

// ---- 起動 ----

boot();

async function boot() {
  // エンジン3本のロードには時間がかかる。ホームに進捗を出しておく。
  renderModeControls();
  showView('home');
  if (currentView() === 'play') history.replaceState(null, '', '#/');
  try {
    setBoot(t('loading_rules'));
    const fuseki = await Fuseki.load(ASSETS.fuseki);

    // ここが起動でいちばん待たされる。数字（LOAD_MB）は build.mjs が実物と突き合わせる。
    setBoot(t('loading_policy'), t('loading_policy_sub', { mb: LOAD_MB }));
    const policy = await FusekiPolicy.load({ model: ASSETS.model, wasmPaths: ASSETS.ortWasm });

    // やねうら王はSharedArrayBufferを使う。COOP/COEPが立っていない配信では
    // 1スレッドに落ちる（_headers を参照）。
    const threads = globalThis.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    setBoot(t('loading_engine'), t('loading_engine_sub', { n: threads }));
    const engine = await NormalEngine.load({
      factory: await loadYaneuraOuFactory(ASSETS.yaneuraou), threads, hashMb: 64,
    });

    // 玉分け将棋の価値表。無くても布石将棋は指せるので、落とさずにモードだけ閉じる。
    let kingTable = null;
    try {
      kingTable = await KingTable.load(ASSETS.kingTable, { modelFile: ASSETS.model });
    } catch (e) {
      console.warn('玉分け将棋は使えない:', e.message);
      ui.modeKings.disabled = true;
      ui.modeKings.closest('.mode-card').title = t('kings_unavailable');
      if (ui.modeKings.checked) ui.modeStandard.checked = true;
      renderModeControls();
    }

    engines = { fuseki, policy, engine, kingTable };
    ui.newGame.disabled = false;
    setBoot(t('ready'), threads === 1 ? t('ready_single_thread') : '');
  } catch (e) {
    setBoot(t('boot_failed'), e.message, true);
    console.error(e);
  }
}

function setBoot(line, sub = '', error = false) {
  ui.bootLine.textContent = line;
  ui.bootSub.textContent = sub;
  ui.boot.classList.toggle('error', error);
}

// AudioContext は利用者の操作の中でしか起こせない。対局開始のクリックが最初の機会。
function newGameClicked() {
  sound.unlock();
  startGame();
}
ui.newGame.addEventListener('click', newGameClicked);
ui.again.addEventListener('click', newGameClicked);
ui.replay.addEventListener('click', () => goToPly(0));
ui.copyKifu.addEventListener('click', () => game && copyText(kifuText(), ui.copyKifu, t('btn_copy_kifu')));
ui.ioCopy.addEventListener('click', () => game && copyText(movesText(), ui.ioCopy, t('io_copy')));
ui.ioLoad.addEventListener('click', loadMoves);

// 待った。AI相手なので相手の合意は要らない。自分の直前の一手を取り消す。
ui.undo.addEventListener('click', () => {
  const n = undoTarget();
  if (n < 0 || busy || viewPly !== null || !game || game.phase === 'over') return;
  game.undoTo(n);
  // 戻した手をもう一度鳴らさない。
  soundedKifu = Math.min(soundedKifu, game.kifu.length);
  viewPly = null;
  pendingSide = null;
  disarmResign();
  render();
  // 普通は自分の手番に戻るので何も起きない。後手を持って0手目まで戻したときだけ効く。
  drive();
});

/** 待ったで戻す先（棋譜の行数）。自分がまだ1手も指していなければ -1。 */
function undoTarget() {
  if (!game) return -1;
  const k = game.kifu;
  let n = k.length;
  // 色ではなく actor で見る。玉分け将棋の置く役は両方の色の玉を置く。
  while (n > 0 && k[n - 1].actor !== 'human') n--;   // AIの手を飛ばす
  return n - 1;                                       // 自分の手を1つ消す
}
// 投了は取り消せない。1回目は確認に変え、2回目で確定する（lishogiも2段階）。
let resignArmed = null;
function disarmResign() {
  clearTimeout(resignArmed);
  resignArmed = null;
  ui.resign.textContent = t('btn_resign');
  ui.resign.classList.remove('armed');
}
ui.resign.addEventListener('click', () => {
  if (!game || game.phase === 'over') return;
  if (!resignArmed) {
    ui.resign.textContent = t('btn_resign_confirm');
    ui.resign.classList.add('armed');
    // 押しっぱなしにしておくと誤爆するので、少し経ったら戻す。
    resignArmed = setTimeout(disarmResign, 4000);
    return;
  }
  disarmResign();
  game.resign();
  render();
});
/** 対局開始時の人間の色。振り駒はここで決まる。 */
function chosenColor() {
  if (ui.color.value === 'random') return Math.random() < .5 ? SENTE : GOTE;
  return ui.color.value === GOTE ? GOTE : SENTE;
}

/** 玉分け将棋での人間の役。振り駒はここで決まる。 */
function chosenRole() {
  if (ui.role.value === 'random') return Math.random() < .5 ? 'placer' : 'chooser';
  return ui.role.value === 'chooser' ? 'chooser' : 'placer';
}

/** ルールに応じて「手番」か「役」のどちらかを出す。両方出すと片方が効かないのに触れる。 */
function renderModeControls() {
  const kf = modeValue() === 'kings-first';
  ui.colorLabel.hidden = kf;
  ui.roleLabel.hidden = !kf;
  ui.newGame.textContent = t(kf ? 'btn_start_kings' : 'btn_start_standard');
}
for (const r of [ui.modeKings, ui.modeStandard]) r.addEventListener('change', renderModeControls);

// ---- 先後の選択（玉分け将棋） ----

/** 押した玉を仮に持つ。盤がその玉が手前に来るよう回り、確定ボタンが押せるようになる。 */
function setPendingSide(side) {
  if (!game || game.phase !== 'choose' || !game.isHumanTurn || busy || viewPly !== null) return;
  pendingSide = side;
  orientation = side;
  ensureBoard();
  render();
}
ui.chooseSente.addEventListener('click', () => setPendingSide(SENTE));
ui.chooseGote.addEventListener('click', () => setPendingSide(GOTE));
ui.chooseConfirm.addEventListener('click', () => {
  if (!pendingSide || !game || game.phase !== 'choose' || !game.isHumanTurn || busy || viewPly !== null) return;
  try {
    game.choose(pendingSide);
  } catch (e) {
    setStatus(t('status_cannot_choose'), e.message);
  }
  pendingSide = null;
  render();
  drive();
});

/** 盤上の玉を押す。shogiground は触れない駒の mousedown を握る（preventDefault）が、
 *  pointerup は届く。座標からマスを引き当てるので DOM の駒には依存しない。 */
el('board').addEventListener('pointerup', e => {
  if (!game || game.phase !== 'choose' || !game.isHumanTurn || busy || viewPly !== null) return;
  const boardEl = document.querySelector('#board sg-board');
  if (!boardEl) return;
  const key = keyAtPoint(e.clientX, e.clientY, boardEl.getBoundingClientRect());
  if (!key) return;
  const { sente, gote } = game.kingSquares;
  if (key === sente) setPendingSide(SENTE);
  else if (key === gote) setPendingSide(GOTE);
});

/** 画面座標 → マス（USI）。盤の向きで筋と段の向きが変わる。 */
function keyAtPoint(x, y, b) {
  const sq = b.width / 9;
  const col = Math.floor((x - b.left) / sq), row = Math.floor((y - b.top) / sq);
  if (col < 0 || col > 8 || row < 0 || row > 8) return null;
  const file = orientation === SENTE ? 9 - col : col + 1;
  const rank = orientation === SENTE ? row : 8 - row;
  return `${file}${RANKS[rank]}`;
}

/** マス（USI）→ 盤の矩形の中の中心座標（px）。 */
function squareCenter(key, b) {
  const file = Number(key[0]), rank = RANKS.indexOf(key[1]);
  const col = orientation === SENTE ? 9 - file : file - 1;
  const row = orientation === SENTE ? rank : 8 - rank;
  const sq = b.width / 9;
  return { x: (col + .5) * sq, y: (row + .5) * sq, sq };
}

/** 先後を選ぶあいだ、両玉に札（先手 ☗／後手 ☖）と輪を重ねる。 */
function renderKingTags() {
  const show = !!game && game.phase === 'choose' && viewPly === null && !ui.viewPlay.hidden;
  const wrap = el('board');
  wrap.classList.toggle('choosing', show && game.isHumanTurn);
  ui.kingTags.hidden = !show;
  if (!show) { ui.kingTags.replaceChildren(); return; }
  const boardEl = wrap.querySelector('sg-board');
  if (!boardEl) return;
  const col = ui.kingTags.getBoundingClientRect();
  const b = boardEl.getBoundingClientRect();
  const frag = document.createDocumentFragment();
  for (const color of [SENTE, GOTE]) {
    const key = game.kingSquares[color];
    if (!key) continue;
    const { x, y, sq } = squareCenter(key, b);
    const cx = b.left - col.left + x, cy = b.top - col.top + y;
    const state = pendingSide === null ? '' : pendingSide === color ? 'pending' : 'dim';
    const ring = document.createElement('div');
    ring.className = `king-ring ${state}`;
    const r = sq * .58;
    ring.style.cssText = `left:${cx - r}px;top:${cy - r}px;width:${2 * r}px;height:${2 * r}px`;
    const label = document.createElement('div');
    label.className = `king-label ${state}`;
    label.textContent = t(color === SENTE ? 'side_sente' : 'side_gote');
    // 上半分の玉には札を下に、下半分の玉には上に。盤の外へは出さない。
    const upper = y < b.height / 2;
    label.style.cssText = upper
      ? `left:${cx}px;top:${cy + r + 2}px`
      : `left:${cx}px;top:${cy - r - 2}px;transform:translate(-50%,-100%)`;
    frag.append(ring, label);
  }
  ui.kingTags.replaceChildren(frag);
}
addEventListener('resize', renderKingTags);

// ---- 盤の操作 ----

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
  if (ui.viewPlay.hidden) return;
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
  // 帯の向きは orientation で決まる。ここで描き直さないと反転のあいだ裏返ったまま。
  if (game) { renderGauge(); renderKingTags(); }
});

function startGame() {
  if (busy || !engines) return;
  // 玉分け将棋は価値表が読めたときだけ。無ければ radio が無効になっている。
  const mode = modeValue() === 'kings-first' && engines.kingTable ? 'kings-first' : 'standard';
  // 玉分け将棋の色は選択まで未定。盤は先手側から始め、決まった時点で回す（render）。
  const humanColor = mode === 'standard' ? chosenColor() : SENTE;
  const humanRole = mode === 'kings-first' ? chosenRole() : null;
  orientation = humanColor;
  orientedGame = null;
  pendingSide = null;
  phaseSeen = null;
  // レベルは select を真とする（値を直接入れてから対局開始を押されても効くように）。
  const n = Number(ui.level.value);
  if (LEVELS[n]) aiLevel = n;
  const lv = LEVELS[aiLevel] ?? LEVELS[3];
  game = new Game({
    ...engines, humanColor, mode, humanRole,
    movetimeMs: lv.movetimeMs, temperature: lv.temperature, notation: LANG,
  });
  soundedKifu = 0;
  soundedOver = false;
  viewPly = null;
  clock.sente = clock.gote = 0;
  clock.running = null;
  timeCtl = TIME_CONTROLS[ui.time.value] ?? null;
  humanClock = timeCtl ? { mainMs: timeCtl.initialMs } : null;
  ui.ioNote.textContent = '';
  // 時計は手番が変わったときにしか進まないので、表示だけ別に回す。
  // 時間切れの検出もここでやる。指さないまま切れる場合、render() は呼ばれない。
  clearInterval(clockTimer);
  clockTimer = setInterval(onClockTick, 250);

  if (currentView() !== 'play') history.pushState(null, '', '#play');
  showView('play');
  ensureBoard();
  ui.resign.disabled = false;
  disarmResign();
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
    if (game.phase === 'kings' || game.phase === 'fuseki') game.playFusekiDrop(`${USI_LETTER[piece.role]}*${key}`);
    else game.playNormalMove(`${USI_LETTER[piece.role]}*${key}`);
  } catch (e) {
    setStatus(t('status_illegal'), e.message);
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
    setStatus(t('status_illegal'), e.message);
  }
  render();
  drive();
}

/**
 * 人間の手番のあいだ、いまの局面をやねうら王に見てもらう。指し手は使わず数字だけ取る。
 *
 * 布石フェーズはやらない。布石エンジンに価値ヘッドが無く（policy.js の hasValue）、
 * 出せる数字が「自分の手にどれだけ自信があるか」しかない。それは形勢ではないし、
 * 候補手を出せば人間への手筋の示唆になって対局の性質が変わる。
 */
async function analyzeForHuman() {
  if (!engines || !game || game.phase !== 'normal' || !game.isHumanTurn) return;
  if (!showEvalInPlay) return;
  // 待ったは epoch、着手は手数で見分ける。どちらも動いていたら、この結果は別の局面のもの。
  const g = game;
  const at = g.kifu.length;
  const epoch = g.epoch;
  const info = await engines.engine
    .analyze({ sfen: g.finalSfen, moves: g.normalMoves, movetimeMs: 800 })
    .catch(() => null);
  if (!info || game !== g || g.kifu.length !== at || g.epoch !== epoch) return;
  // lastEval は表示用の置き場。人間の手番ぶんはここから入れる。
  g.lastEval = { kind: 'search', ...info, side: g.humanColor };
  render();
}

/** 人間の手番になるか終局するまでAIに指させる。 */
async function drive() {
  if (busy || !game) return;
  busy = true;
  const g = game;
  try {
    // ホームへ戻って対局が捨てられたら、そこで止まる（game が別物になる）。
    while (game === g && g.phase !== 'over' && !g.isHumanTurn) {
      render();
      await g.playAiMove();
      render();
    }
  } catch (e) {
    setStatus(t('status_engine_error'), e.message);
    console.error(e);
  } finally {
    busy = false;
    render();
    analyzeForHuman();   // 人間の手番に戻ったので、見せる設定なら聞きに行く
  }
}

// ---- 表示 ----

/** 盤に何を映すか。過去を見ている間は対局中の局面を出さない。 */
function renderBoard() {
  if (!sg || !game) return;
  const reviewing = viewPly !== null;
  // .sg-wrap は shogiground が #board に足したクラス。内部を覗かず自分の要素を触る。
  const wrap = el('board');
  wrap.classList.toggle('reviewing', reviewing);
  wrap.classList.toggle('phase-normal', game.phase === 'normal' || (game.phase === 'over' && !!game.position));
  wrap.classList.toggle('kings-only', game.phase === 'kings' && game.isHumanTurn && !reviewing);
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

const SYMBOL = { [SENTE]: '☗', [GOTE]: '☖' };
function sideName(color) { return t(color === SENTE ? 'side_sente' : 'side_gote'); }

/** 席の名前・手番の印・時計。 */
function renderSeats() {
  if (!game) return;
  // 下が手前（自分）。盤を反転しても席の並びは動かさない。
  const bottom = orientation;
  const top = bottom === SENTE ? GOTE : SENTE;
  // 誰が座っているか。玉分け将棋で選ぶ前は色しか無い。押した（仮の）玉があれば仮の席にする。
  const label = c => {
    const who = game.humanColor !== null
      ? (c === game.humanColor ? t('seat_you') : t('seat_ai', { n: aiLevel }))
      : pendingSide !== null
        ? (c === pendingSide ? t('seat_you_pending') : t('seat_ai', { n: aiLevel }))
        : null;
    return who === null ? sideName(c) : `${who} ${SYMBOL[c]}`;
  };
  ui.seatTopName.textContent = label(top);
  ui.seatBottomName.textContent = label(bottom);
  ui.clockTop.textContent = clockText(top);
  ui.clockBottom.textContent = clockText(bottom);
  // 残り30秒を切ったら色を変える。秒読み中は常に立てる。
  const low = c => {
    if (!timeCtl || c !== game.humanColor || game.phase === 'over') return false;
    const st = humanClockState();
    return st.inByoyomi || st.mainMs < 30000;
  };
  ui.clockTop.classList.toggle('low', low(top));
  ui.clockBottom.classList.toggle('low', low(bottom));
  const turn = game.phase !== 'over' ? game.turnColor : null;
  ui.seatTop.classList.toggle('turn', turn === top);
  ui.seatBottom.classList.toggle('turn', turn === bottom);
  // 考えているのはAIのときだけ。人間の番で脈を打たせると急かしているように見える。
  const thinking = busy && turn !== null && turn !== game.humanColor;
  ui.seatTop.classList.toggle('thinking', thinking && turn === top);
  ui.seatBottom.classList.toggle('thinking', thinking && turn === bottom);
}

/** 通常フェーズに入ってから人間が指したか。41手目の案内を引っ込める合図に使う。
 *  通常フェーズは41手目＝先手から始まるので、指し手の並びの偶奇が色になる。 */
function hasHumanMovedInNormal() {
  if (!game || game.phase === 'fuseki') return false;
  return game.normalMoves.some((_, i) => (i % 2 === 0 ? SENTE : GOTE) === game.humanColor);
}

/** フェーズ帯。今どの段にいるかと、その段の中身（誰の番・残り）。 */
function renderStepper() {
  if (!game) { ui.stepper.replaceChildren(); return; }
  const kf = game.mode === 'kings-first';
  const steps = kf ? ['kings', 'choose', 'fuseki', 'normal'] : ['fuseki', 'normal'];
  const over = game.phase === 'over';
  // 終局したら、終わった段までを済みにする。
  const endStep = game.position ? 'normal'
    : kf && game.fusekiMoves.length < 2 ? 'kings'
    : kf && game.chosen === null ? 'choose' : 'fuseki';
  const cur = over ? endStep : game.phase;
  const curIdx = steps.indexOf(cur);
  const who = human => t(human ? 'step_you' : 'step_ai');
  const frag = document.createDocumentFragment();
  steps.forEach((s, i) => {
    const li = document.createElement('li');
    const state = i < curIdx ? 'done' : i === curIdx ? (over ? 'done' : 'now') : 'next';
    li.className = `step ${state}${s === 'fuseki' ? ' wide' : ''}`;
    li.title = t(`step_title_${s}`);
    let sub = '';
    let bar = null;
    if (over && i === curIdx) sub = t('step_over', { n: game.moveCount });
    else if (s === 'kings') {
      sub = state === 'now' ? `${who(game.humanRole === 'placer')} · ${t('step_left', { n: 2 - game.fusekiMoves.length })}`
        : state === 'next' ? t('step_kings_sub') : '';
    } else if (s === 'choose') {
      sub = state === 'now' ? t(game.humanRole === 'chooser' ? 'step_turn_you' : 'step_turn_ai')
        : state === 'done' && game.chosen
          ? t('step_chosen', { who: who(game.humanRole === 'chooser'), side: sideName(game.chosen) }) : '';
    } else if (s === 'fuseki') {
      const placed = game.fusekiMoves.length - (kf ? 2 : 0), total = kf ? 38 : 40;
      if (state === 'now') {
        sub = t('step_left', { n: 40 - game.fusekiMoves.length });
        bar = Math.max(0, Math.min(1, placed / total));
      } else if (state === 'next') sub = t(kf ? 'step_fuseki_sub_kings' : 'step_fuseki_sub_std');
    } else if (s === 'normal') {
      sub = state === 'now' ? t('step_ply', { n: game.ply }) : state === 'next' ? t('step_normal_sub') : '';
    }
    li.innerHTML = `<span class="t"></span><span class="s"></span>`;
    li.firstChild.textContent = t(`step_${s}`);
    li.lastChild.textContent = sub;
    if (bar !== null) {
      const b = document.createElement('span');
      b.className = 'bar';
      b.innerHTML = '<i></i>';
      b.firstChild.style.setProperty('--p', `${Math.round(bar * 100)}%`);
      li.appendChild(b);
    }
    frag.appendChild(li);
  });
  ui.stepper.classList.toggle('four', steps.length === 4);
  ui.stepper.replaceChildren(frag);
}

/** パネルの操作枠の中身を決める。 */
function panelState() {
  if (!game) return 'idle';
  if (game.phase === 'over') return 'over';
  if (game.phase === 'choose' && game.isHumanTurn && viewPly === null) return 'choose';
  return 'play';
}

function render() {
  if (!game) {
    if (sg) showIdleBoard(sg);
    ui.panel.dataset.state = 'idle';
    ui.stepper.replaceChildren();
    ui.kifu.replaceChildren();
    ui.engine.hidden = ui.gauge.hidden = true;
    ui.undo.disabled = true;
    ui.ioSfen.value = '';
    renderNav();
    renderKingTags();
    return;
  }
  if (game.phase !== 'choose') pendingSide = null;
  // 玉分け将棋で先後が決まった。人間の色が決まったので、その対局で一度だけ盤を回す。
  // 待ったで選択より前へ戻ると色が未定に戻るので、次の選択でもう一度回せるようにする。
  if (game.humanColor === null) {
    orientedGame = null;
  } else if (orientedGame !== game) {
    orientedGame = game;
    if (orientation !== game.humanColor) {
      orientation = game.humanColor;
      ensureBoard();
    }
  }
  renderBoard();
  ui.panel.dataset.state = panelState();
  ui.panel.dataset.phase = game.phase;
  tickClock(game.phase === 'over' ? null : game.turnColor);
  renderSeats();
  renderStepper();
  renderKifu();
  renderNav();
  renderEngine();
  renderGauge();
  renderChoice();
  ui.ioSfen.value = game.sfen();
  ui.undo.disabled = busy || viewPly !== null || game.phase === 'over' || undoTarget() < 0;
  playMoveSounds();

  if (game.phase === 'over') {
    clearInterval(clockTimer);
    clockTimer = null;
    const { who, why } = resultLine();
    setStatus(who, why);
    ui.resultNote.textContent = resultNote();
    ui.resign.disabled = true;
    disarmResign();
  } else if (viewPly !== null) {
    setStatus(t('status_reviewing', { n: viewPly }), t('status_reviewing_sub'));
  } else if (game.isHumanTurn) {
    // 41手目でルールが変わる。フェーズの表示が切り替わるだけでは気づけないので、
    // 通常フェーズで自分がまだ1手も指していないあいだは言い続ける。
    // 「一度だけ」にすると、直後の drive() の再描画に上書きされて誰も読めない。
    if (game.phase === 'kings') {
      // 置く役は自分の色を知らずに両玉を置く。2手目は相手の駒台の玉を相手陣へ。
      setStatus(t(game.fusekiMoves.length === 0 ? 'status_placer_first' : 'status_placer_second'),
        t('status_placer_sub'));
    } else if (game.phase === 'choose') {
      if (pendingSide) setStatus(t('status_pending', { side: sideName(pendingSide) }), t('status_pending_sub'));
      else setStatus(t('status_choose'), t('status_choose_sub'));
    } else if (game.phase === 'normal' && !hasHumanMovedInNormal()) {
      setStatus(t('status_normal_first'), t('status_normal_first_sub'));
    } else {
      setStatus(t(game.phase === 'fuseki' ? 'status_your_turn_fuseki' : 'status_your_turn'), chosenNote());
    }
  } else {
    const line = t(game.phase === 'kings' ? 'status_ai_kings'
      : game.phase === 'choose' ? 'status_ai_choose' : 'status_ai_thinking');
    const sub = t(game.phase === 'kings' || game.phase === 'choose' ? 'engine_table'
      : game.phase === 'fuseki' ? 'engine_policy' : 'engine_yaneuraou');
    setStatus(line, sub);
  }
  renderKingTags();
  announcePhase();
}

/** 段の境目で一度だけ知らせる（トーストと音）。先後が決まったとき、41手目に入ったとき。 */
function announcePhase() {
  const prev = phaseSeen;
  phaseSeen = game.phase;
  if (prev === null || prev === game.phase) return;
  if (prev === 'choose' && game.phase === 'fuseki' && game.humanColor) {
    showToast(t('toast_side_decided', { side: sideName(game.humanColor) }));
    sound.play('phase');
  } else if (game.phase === 'normal' && prev !== 'normal') {
    showToast(t('toast_normal'));
    sound.play('phase');
  }
}

let toastTimer = null;
function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3200);
}

/** 先後の2択と確定ボタン。押した玉があれば、そちらに縁を立てて確定を開ける。 */
function renderChoice() {
  ui.chooseSente.classList.toggle('selected', pendingSide === SENTE);
  ui.chooseGote.classList.toggle('selected', pendingSide === GOTE);
  ui.chooseConfirm.disabled = pendingSide === null;
  ui.chooseConfirm.textContent = pendingSide === null
    ? t('btn_confirm_side_idle') : t('btn_confirm_side', { side: sideName(pendingSide) });
}

/** 玉分け将棋で先後が決まった直後だけ、誰がどちらを持ったかを言う。3手目の案内に添える。 */
function chosenNote() {
  if (game.mode !== 'kings-first' || game.phase !== 'fuseki' || game.fusekiMoves.length > 3) return '';
  // 自分で選んだときは言わない（帯とトーストに出ている）。AIが選んだときだけ、その結果を添える。
  if (game.humanRole === 'chooser') return '';
  return t('status_chosen_note', {
    who: t(game.humanRole === 'chooser' ? 'You' : 'AI'),
    side: sideName(game.chosen), yours: sideName(game.humanColor),
  });
}

/** 終局後の一行。玉分け将棋なら、役・両玉のマス・誰が先手を持ったか・表の値。 */
function resultNote() {
  if (game.mode !== 'kings-first' || !game.chosen) return '';
  const { sente, gote } = game.kingSquares;
  let p = '—';
  try { p = (engines.kingTable.v(sente, gote) * 100).toFixed(1); } catch { /* 表に無ければ出さない */ }
  return t('summary_kings', {
    placer: t(game.humanRole === 'placer' ? 'you' : 'AI'), kb: sente, kw: gote,
    chooser: t(game.humanRole === 'chooser' ? 'You' : 'AI'), side: sideName(game.chosen), p,
  });
}

/** 勝敗の一行。表示と棋譜の書き出しで共有する。 */
function resultLine() {
  const { winner, reason, winnerIs } = game.result;
  // 玉分け将棋で先後を選ぶ前に投了すると、勝った色が無い。人間とAIのどちらかだけ言う。
  const who = winner === null ? t(winnerIs === 'ai' ? 'result_ai_wins' : 'result_draw')
    : t('result_color_wins', { side: sideName(winner) }) + (winnerIs === 'human' ? t('result_you') : '');
  const key = `reason_${reason}`;
  const why = t(key);
  return { who, why: why === key ? reason : why };
}

/** エンジンの言い分。数字が誰のものかを画面に出す。 */
function renderEngine() {
  const ev = game.lastEval;
  if (!ev || !evalVisible()) { ui.engine.hidden = true; return; }
  ui.engine.hidden = false;
  ui.evaluation.textContent = formatEval(ev);
  if (ev.kind === 'policy' || ev.kind === 'kings') {
    ui.engineHead.textContent = `· ${t(ev.kind === 'policy' ? 'engine_policy' : 'engine_table')}`;
    ui.enginePv.textContent = '';
    return;
  }
  const bits = [t('engine_yaneuraou')];
  if (ev.depth != null) bits.push(t('engine_depth', { d: ev.depth }));
  if (ev.nps != null) bits.push(formatNps(ev.nps));
  ui.engineHead.textContent = `· ${bits.join(' · ')}`;
  // 読み筋は8手まで。全部出すと狭いパネルで3行になり、棋譜に回せる高さを食う。
  const pv = game.pvText(ev.pv?.slice(0, 8));
  ui.enginePv.textContent = pv ? t('engine_pv', { pv }) : '';
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
  const show = ev && ev.kind === 'search' && ev.score != null && evalVisible();
  ui.gauge.hidden = !show;
  if (!show) return;
  // USIの評価値は探索した側から見た値。AIが指した手のときはAIの側、
  // 人間の手番に画面が聞いたときは人間の側。先手から見た値に直す。
  const cp = ev.scoreKind === 'mate' ? (ev.score > 0 ? 1e5 : -1e5) : ev.score;
  const fromSente = (ev.side ?? game.aiColor) === SENTE ? cp : -cp;
  const p = 1 / (1 + Math.exp(-fromSente / 400));
  // 帯は手前（盤の下側）から伸びる。後手を持つと手前は後手なので、そのままでは
  // 自分が押しているときに相手側から伸びて見える。盤の向きに合わせて裏返す。
  // 見ているのは humanColor ではなく orientation。盤を反転したら帯も付いてくる。
  const bottom = orientation === SENTE ? p : 1 - p;
  ui.gauge.style.setProperty('--eval-p', String(bottom));
}

/**
 * 棋譜の書き出し。KIFとは呼ばない。KIFには「空の盤＋持ち駒20枚」を表す書き方が無く、
 * KIFと名乗って どのKIFリーダーも読めないのは、素のテキストより悪い。
 */
function kifuText() {
  const seats = game.humanColor === null ? t('kifu_seats_undecided')
    : t(game.humanColor === SENTE ? 'kifu_seats_you_sente' : 'kifu_seats_you_gote');
  // 玉分け将棋は役も残す。色と役は一致するとは限らないので、両方書く。
  const roles = game.mode !== 'kings-first' ? ''
    : `${t(game.humanRole === 'placer' ? 'kifu_roles_you_placer' : 'kifu_roles_you_chooser')} / `;
  const rule = t(game.mode === 'kings-first' ? 'kifu_rule_kings' : 'kifu_rule_standard');
  const lines = [`${rule} / ${t('kifu_level', { n: aiLevel })} / ${roles}${seats}`];
  for (const e of game.kifu) {
    // 41手目の局面は指し手からは再現できない（布石フェーズにPositionが無い）。
    if (e.ply === 41 && game.finalSfen) lines.push(t('kifu_sfen41', { sfen: game.finalSfen }));
    lines.push(`${e.ply === null ? '   ' : String(e.ply).padStart(3, ' ')} ${e.text}`);
  }
  if (game.moveCount === 40 && game.finalSfen) lines.push(t('kifu_sfen41', { sfen: game.finalSfen }));
  if (game.phase === 'over') {
    const { who, why } = resultLine();
    lines.push(t('kifu_result', { who, why }));
  }
  return lines.join('\n');
}

/** クリップボードへ。押したボタンの文言で結果を返す。 */
async function copyText(text, button, label) {
  const done = ok => {
    button.textContent = t(ok ? 'copied' : 'copy_failed');
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
  return game ? game.tokens().join(' ') : '';
}

/**
 * 貼られた手順から対局を作り直す。
 *
 * SFENからは作れない。fuseki.js に局面を書き込むAPIが無く（reset と drop だけ）、
 * 打っていない駒はSFENに乗らないため。再生の経路は待った（undoTo）と同じ。
 */
function loadMoves() {
  const moves = ui.ioMoves.value.trim().split(/\s+/).filter(Boolean);
  if (!moves.length) return note(t('io_empty'));
  if (!engines) return note(t('io_not_ready'));
  if (busy) return note(t('io_busy'));

  // ルールは手順に書いてある。選択のトークンがあれば玉分け将棋。
  const kingsFirst = moves.some(m => m.startsWith('choose:'));
  if (kingsFirst && !engines.kingTable) return note(t('io_no_table'));
  setMode(kingsFirst ? 'kings-first' : 'standard');

  sound.unlock();     // 利用者の操作の中でしか起こせない。ここも最初の機会になりうる
  startGame();        // 時計も設定も入れ直す。この直後の drive() は下の undoTo で捨てられる
  game.undoTo(0);
  let i = 0;
  try {
    for (; i < moves.length; i++) {
      if (game.phase === 'over') throw new Error(t('io_over'));
      game.play(moves[i]);
    }
  } catch (e) {
    // 途中まで再生された盤は、正しい盤と区別がつかない。握り潰さずどこで止めたか言う。
    note(t('io_stopped', { n: i + 1, m: moves[i], e: e.message }));
    soundedKifu = game.kifu.length;
    phaseSeen = game.phase;
    render();
    return;
  }
  note(t('io_loaded', { n: moves.length }));
  ui.ioDialog.close();
  viewPly = null;
  soundedKifu = game.kifu.length;   // 読み込んだぶんの駒音は鳴らさない
  phaseSeen = game.phase;           // 読み込みで段をまたいでも知らせない
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
    // 玉分け将棋の選択は駒を動かさないので鳴らさない。
    if (!last.usi.startsWith('choose:'))
      sound.play(game.checks() ? 'check' : last.capture ? 'capture' : 'move');
    soundedKifu = game.kifu.length;
  }
  if (game.phase === 'over' && !soundedOver) {
    soundedOver = true;
    const { winnerIs } = game.result;
    sound.play(winnerIs === null ? 'draw' : winnerIs === 'human' ? 'win' : 'lose');
  }
}

function renderKifu() {
  // 追加された分だけ足す。1手ごとに全消しすると自動スクロールが跳ねる。
  while (ui.kifu.childElementCount > game.kifu.length) ui.kifu.lastElementChild.remove();
  for (let i = ui.kifu.childElementCount; i < game.kifu.length; i++) {
    const entry = game.kifu[i];
    const li = document.createElement('li');
    li.className = entry.color === SENTE ? 'sente' : 'gote';
    // 区切り。先後の選択の行と、41手目（ここから将棋）。棋譜を後から読んでも流れがわかる。
    if (entry.usi.startsWith('choose:')) {
      li.classList.add('divider', 'choice');
      li.dataset.divider = t('step_choose');
    } else if (entry.ply === 41) {
      li.classList.add('divider');
      li.dataset.divider = t('kifu_from41');
    }
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = entry.ply ?? '';
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = entry.text;
    li.append(n, m);
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
  // 玉分け将棋の置く役・選ぶ役が引いた表の値。先手から見た勝率。
  if (evaluation.kind === 'kings') return t('eval_table', { p: (evaluation.winRate * 100).toFixed(1) });
  if (evaluation.kind === 'policy') {
    // 布石専用ネットは価値ヘッドを持たない（採点はやねうら王がやる）ので勝率が出ない。
    // その場合は方策が採用手に与えた確率を出す。undefinedを%にして "NaN%" と
    // 表示させないこと。
    // 布石の合法手は序盤で288手あるので、整数%だと採用手が "0%" になる。小数1桁にする。
    if (evaluation.winRate == null)
      return t('eval_policy_prob', { p: (evaluation.probability * 100).toFixed(1) });
    return t('eval_policy_win', { p: (evaluation.winRate * 100).toFixed(0) });
  }
  if (evaluation.scoreKind === 'mate')
    return t('eval_mate', { n: `${evaluation.score > 0 ? '' : '-'}${Math.abs(evaluation.score)}` });
  if (evaluation.scoreKind === 'cp')
    return t('eval_cp', { cp: `${evaluation.score > 0 ? '+' : ''}${evaluation.score}`, d: evaluation.depth ?? '?' });
  return '—';
}

function setStatus(line, sub = '') {
  ui.statusLine.textContent = line;
  ui.statusSub.textContent = sub;
}
