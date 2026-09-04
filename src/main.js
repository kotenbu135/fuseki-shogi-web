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
import { Game, SENTE, GOTE, positionMoveDests, positionDropDests, promotionConfig, usiDropSquare } from './game.js';
import { parseSquareName, parseUsi, makeSquareName } from 'shogiops/util';
import { makeJapaneseSquare } from 'shogiops/notation/util';
import { makeSfen } from 'shogiops/sfen';
import { KingTable } from './kings.js';
import { createBoard, showIdleBoard, showSnapshot, showPosition, setShapes, syncBoard } from './board.js';
import { Sound, VOICES } from './sound.js';
import { HomeBoard } from './homeboard.js';
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
    ? 'fuseki_degct_b3_iter272.onnx' : __MODEL_FILE__}`, import.meta.url).href,
  // 天秤将棋の価値表（src/kings.js）。重みと世代が対（build.mjs の KING_TABLE）。
  kingTable: new URL(`./models/${typeof __KING_TABLE_FILE__ === 'undefined'
    ? 'king_pairs_iter272.json' : __KING_TABLE_FILE__}`, import.meta.url).href,
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
  toastLine: el('toast-line'), toastSub: el('toast-sub'),
  banner: el('result-banner'), bannerLine: el('rb-line'), bannerSub: el('rb-sub'),
  bannerAgain: el('rb-again'), bannerAnalyze: el('rb-analyze'),
  chart: el('eval-chart'), chartSvg: el('eval-chart-svg'),
  resultActions: el('result-actions'), resultNote: el('result-note'),
  again: el('btn-again'), replay: el('btn-replay'), copyKifu: el('btn-copy-kifu'), analyze: el('btn-analyze'),
  varBack: el('btn-var-back'), analyzeAll: el('btn-analyze-all'), flipAnalyze: el('btn-flip-analyze'),
  analyzeEnd: el('btn-analyze-end'), candidates: el('candidates'), variation: el('variation'),
  newGame: el('btn-new'), resign: el('btn-resign'), flip: el('btn-flip'), undo: el('btn-undo'),
  pause: el('btn-pause'), abort: el('btn-abort'),
  navFirst: el('nav-first'), navPrev: el('nav-prev'),
  navNext: el('nav-next'), navLast: el('nav-last'),
  seatTop: el('seat-top'), seatBottom: el('seat-bottom'),
  seatTopName: el('seat-top-name'), seatBottomName: el('seat-bottom-name'),
  seatTopRole: el('seat-top-role'), seatBottomRole: el('seat-bottom-role'), kifuHead: el('kifu-head'),
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

/** いま評価を出してよいか。対局中は設定しだい、終局後と観戦は常に出す（隠す理由が無い）。 */
function evalVisible() {
  return !!game && (game.phase === 'over' || game.spectate || showEvalInPlay);
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
// 温度で作る。布石フェーズの強さはレベル1〜2で散らし、4〜5では逆に絞る。
//
// 4〜5で温度を下げるのは実測に基づく（scripts/temperature_tradeoff.py、iter171・
// 帯の全組×5・やねうら王200k）。温度1では方策が自分の最善手を捨てており、
// 41手目で |cp|>=1000 が 48.0%、飛車以上のただ取りが 1.2% 残る。温度0.4では
// 26.6% / 0.6%、0.2では 25.5% / 0.0%（＝貪欲と同値）まで落ちる。多様性はほとんど
// 減らない: 同じ玉の組から作った200局は温度0.2でも全て異なり、序盤8手の異なりは
// 温度0.4で約118万通りある。布石が勝負を決めるゲームなので、強さの梯子は
// 通常フェーズの持ち時間だけでなく布石にも掛ける。
//
// レベル3が既定で、movetime 1000 / 温度1 はレベルを入れる前の挙動と同じ。
// レベル1は500ms以下にしておくこと（test/browser_smoke.mjs の --full が
// 1局通すのにレベル1を選ぶ）。
const LEVELS = {
  1: { movetimeMs: 300, temperature: 3.0 },
  2: { movetimeMs: 500, temperature: 1.8 },
  3: { movetimeMs: 1000, temperature: 1.0 },
  4: { movetimeMs: 3000, temperature: 0.6 },
  5: { movetimeMs: 10000, temperature: 0.4 },
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
// 天秤将棋では人間の色が選択の時点で決まる。その対局で一度だけ盤をその色へ回す
// （以後は手で反転できる）。回し終えた対局を覚えておく。
let orientedGame = null;
let busy = false;     // AIが考えている間の二重駆動を防ぐ
// 先後を選ぶ最中、押した（仮の）玉。確定するまで game には入れない。
let pendingSide = null;
// 段の境目の知らせ（トーストと音）のために、直前に描いたフェーズを覚えておく。
let phaseSeen = null;
// 観戦の一時停止。drive() のループが次の手を指す前に見る。
let paused = false;
// 検討（終局後）。中身は「検討」の節。render() が起動時から参照するので、宣言はここに置く。
let analysis = null;
// { variation: { moves: [{usi, text, capture}], at }, candidates: [], hover: null,
//   pass: null | { i, n, cancel }, live: null }
let analysisFuseki = null;   // 布石の局面を作り直すための2つ目のWASM。最初に要るときに読む
let infoGen = 0;             // 読んでいる局面の世代。古い info と古い候補手の計算を捨てる

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
    homeBoard.pause();     // 対局の裏で方策を回さない
  } else {
    homeBoard.fit();
    homeBoard.resume();
  }
}
// ホームの盤。タブが隠れているあいだも止める。
const homeBoard = new HomeBoard(el('home-board'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) homeBoard.pause();
  else if (currentView() === 'home') homeBoard.resume();
});

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
  openKifuIfAsked();
}

/** 文章のページのメニュー「棋譜」は #kifu でホームへ来る。ダイアログを開いて URL は戻す。 */
function openKifuIfAsked() {
  if (location.hash.replace(/^#\/?/, '') !== 'kifu') return;
  history.replaceState(null, '', '#/');
  if (!ui.ioDialog.open) ui.ioDialog.showModal();
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
  paused = false;
  disarmResign();
  endAnalysis();
  engines?.engine.stopSearch();   // 考えている最中なら切り上げる。busy がそのぶん早く解ける
  render();   // パネルを idle に戻し、盤を空にする
}

function goHome() {
  if (currentView() === 'home') { route(); return; }
  location.hash = '#/';   // hashchange → route()
}
ui.logo.addEventListener('click', e => { e.preventDefault(); goHome(); });
ui.navPlay.addEventListener('click', e => { e.preventDefault(); goHome(); });
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
  openKifuIfAsked();
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

    // 天秤将棋の価値表。無くても布石将棋は指せるので、落とさずにモードだけ閉じる。
    let kingTable = null;
    try {
      kingTable = await KingTable.load(ASSETS.kingTable, { modelFile: ASSETS.model });
    } catch (e) {
      console.warn('天秤将棋は使えない:', e.message);
      ui.modeKings.disabled = true;
      ui.modeKings.closest('.mode-card').title = t('kings_unavailable');
      if (ui.modeKings.checked) ui.modeStandard.checked = true;
      renderModeControls();
    }

    engines = { fuseki, policy, engine, kingTable };
    ui.newGame.disabled = false;
    // 起動が終わったら何も言わない（「準備できた」は要らない。開始ボタンが押せるようになるのが合図）。
    // 行は残す（.boot は min-height を持つ）ので、消えても開始ボタンは動かない。1スレッドに落ちたときだけ注記。
    setBoot('', threads === 1 ? t('ready_single_thread') : '');
    // ホームの盤に布石を打たせる。自分専用のWASMを起こすので対局の局面には触らない。
    if (currentView() === 'home') homeBoard.start({ fusekiUrl: ASSETS.fuseki, policy }).catch(e => console.warn(e));
    else homeBoard.start({ fusekiUrl: ASSETS.fuseki, policy }).then(() => homeBoard.pause()).catch(e => console.warn(e));
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
  // 色ではなく actor で見る。天秤将棋の置く役は両方の色の玉を置く。
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
// 観戦の一時停止と中断。一時停止は drive() のループが手を指す前に見る。
ui.pause.addEventListener('click', () => {
  if (!game || !game.spectate || game.phase === 'over') return;
  paused = !paused;
  render();
});
ui.abort.addEventListener('click', () => {
  if (!game || !game.spectate || game.phase === 'over') return;
  game.abort();
  paused = false;
  engines?.engine.stopSearch();   // 探索中なら切り上げる。結果は phase を見て捨てられる
  render();
});

/** ホームの「手番」（天秤将棋では「役」）で観戦が選ばれているか。 */
function spectateChosen() {
  return (modeValue() === 'kings-first' ? ui.role.value : ui.color.value) === 'spectate';
}

/** 対局開始時の人間の色。振り駒はここで決まる。 */
function chosenColor() {
  if (ui.color.value === 'random') return Math.random() < .5 ? SENTE : GOTE;
  return ui.color.value === GOTE ? GOTE : SENTE;
}

/** 天秤将棋での人間の役。振り駒はここで決まる。 */
function chosenRole() {
  if (ui.role.value === 'random') return Math.random() < .5 ? 'placer' : 'chooser';
  return ui.role.value === 'chooser' ? 'chooser' : 'placer';
}

/** ルールに応じて「手番」か「役」のどちらかを出す。両方出すと片方が効かないのに触れる。 */
function renderModeControls() {
  const kf = modeValue() === 'kings-first';
  ui.colorLabel.hidden = kf;
  ui.roleLabel.hidden = !kf;
  const watch = spectateChosen();
  // 持ち時間は人間側だけのもの。観戦では効かないので触れなくする。
  ui.time.disabled = watch;
  ui.newGame.textContent = t(watch ? 'btn_start_watch' : kf ? 'btn_start_kings' : 'btn_start_standard');
}
for (const r of [ui.modeKings, ui.modeStandard, ui.color, ui.role]) r.addEventListener('change', renderModeControls);

// ---- 先後の選択（天秤将棋） ----

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

/** 先後を選ぶあいだ、両玉に札（先手／後手）と輪を重ねる。押した玉の札は朱地なので記号は付けない。 */
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
    label.textContent = sidePlain(color);
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

/** 1手戻る・1手進む。検討で変化を試しているあいだは、その変化の中を動く。 */
function navPrev() {
  if (analysis?.variation.at > 0) return varStep(-1);
  goToPly((viewPly === null ? game?.kifu.length ?? 0 : viewPly) - 1);
}
function navNext() {
  const v = analysis?.variation;
  if (v && v.at < v.moves.length) return varStep(1);
  if (viewPly === null) return;   // 最新より先は無い
  goToPly(viewPly + 1);
}
ui.navFirst.addEventListener('click', () => goToPly(0));
ui.navPrev.addEventListener('click', navPrev);
ui.navNext.addEventListener('click', navNext);
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
  if (e.key === 'ArrowLeft') navPrev();
  else if (e.key === 'ArrowRight') navNext();
  else if (e.key === 'Home') goToPly(0);
  else if (e.key === 'End') goToPly(null);
  else return;
  e.preventDefault();
});

function flipBoard() {
  if (!sg) return;
  // set({orientation}) では駄目。向きはマスのsgKeyと駒台の色に焼き込まれていて、
  // 変更には再ラップが要る。それをやるのが toggleOrientation。
  sg.toggleOrientation();
  orientation = sg.state.orientation;
  renderSeats();
  // 帯の向きは orientation で決まる。ここで描き直さないと反転のあいだ裏返ったまま。
  if (game) { renderGauge(); renderKingTags(); }
}
ui.flip.addEventListener('click', flipBoard);
ui.flipAnalyze.addEventListener('click', flipBoard);

function startGame() {
  if (busy || !engines) return;
  endAnalysis();   // 前の対局の検討が開いていれば閉じる（MultiPV も戻す）
  // 天秤将棋は価値表が読めたときだけ。無ければ radio が無効になっている。
  const mode = modeValue() === 'kings-first' && engines.kingTable ? 'kings-first' : 'standard';
  // 観戦（AI同士）。人間の色も役も無い。盤は先手側から見る。
  const spectate = spectateChosen();
  // 天秤将棋の色は選択まで未定。盤は先手側から始め、決まった時点で回す（render）。
  const humanColor = spectate || mode !== 'standard' ? SENTE : chosenColor();
  const humanRole = mode === 'kings-first' && !spectate ? chosenRole() : null;
  orientation = humanColor;
  orientedGame = null;
  pendingSide = null;
  phaseSeen = null;
  paused = false;
  // レベルは select を真とする（値を直接入れてから対局開始を押されても効くように）。
  const n = Number(ui.level.value);
  if (LEVELS[n]) aiLevel = n;
  const lv = LEVELS[aiLevel] ?? LEVELS[3];
  game = new Game({
    ...engines, humanColor, mode, humanRole, spectate,
    movetimeMs: lv.movetimeMs, temperature: lv.temperature, notation: LANG,
  });
  soundedKifu = 0;
  soundedOver = false;
  viewPly = null;
  clock.sente = clock.gote = 0;
  clock.running = null;
  timeCtl = spectate ? null : (TIME_CONTROLS[ui.time.value] ?? null);
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
  if (analysis) return playVariation(`${USI_LETTER[piece.role]}*${key}`);
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
  if (analysis) return playVariation(`${orig}${dest}${prom ? '+' : ''}`);
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
  // 根はAIの手を指した後の局面＝棋譜の最後の行。読み筋から写した値（pv）をこれで置き換える。
  const ev = g.recordEval(at - 1, info, g.humanColor, 'analysis');
  if (ev) g.lastEval = ev;
  render();
}

/**
 * 画面に出す評価。さかのぼって見ているときはその手の行の評価、対局中の局面なら直近の評価。
 * 行の評価は「その手を指した後の局面」の値で、0手目（空の盤）には無い。
 */
function shownEval() {
  if (!game) return null;
  // 検討中は読み続けている局面の主変化の値（変化の局面なら行の評価は無いのでこれしか無い）。
  if (analysis) return analysis.live ?? (analysis.variation.at > 0 ? null : rowEval(viewedRow()));
  if (viewPly === null) return game.lastEval;
  return rowEval(viewPly);
}
/** 棋譜の行 row（1〜n）を指した後の評価。0 は空の盤で無い。 */
function rowEval(row) {
  return row === 0 ? null : (game.kifu[row - 1]?.eval ?? null);
}
/** いま盤に出している本譜の行（0 = 空の盤、n = 最新）。 */
function viewedRow() {
  return viewPly === null ? game.kifu.length : viewPly;
}

// 観戦で1手にかける下限。布石はNN1回で10msほどしかかからず、40手が1秒で終わって
// 目で追えない。通常フェーズは思考時間（レベル）で自然に間が空く。
const WATCH_MIN_MS = 700;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 人間の手番になるか終局するまでAIに指させる。観戦なら終局まで。 */
async function drive() {
  if (busy || !game) return;
  busy = true;
  const g = game;
  try {
    // ホームへ戻って対局が捨てられたら、そこで止まる（game が別物になる）。
    while (game === g && g.phase !== 'over' && !g.isHumanTurn) {
      while (paused && game === g && g.phase !== 'over') await sleep(100);
      if (game !== g || g.phase === 'over') break;
      render();
      const started = performance.now();
      await g.playAiMove();
      render();
      if (g.spectate) {
        const wait = WATCH_MIN_MS - (performance.now() - started);
        if (wait > 0) await sleep(wait);
      }
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
  wrap.classList.toggle('analyzing', !!analysis);
  wrap.classList.toggle('phase-normal', game.phase === 'normal' || (game.phase === 'over' && !!game.position));
  wrap.classList.toggle('kings-only', game.phase === 'kings' && game.isHumanTurn && !reviewing);
  // 布石フェーズは手番側の陣（置ける四段）を淡く塗る。手前か向こうかは盤の向きで決まる。
  const zone = !reviewing && !analysis && (game.phase === 'fuseki' || game.phase === 'kings') && game.turnColor
    ? (game.turnColor === orientation ? 'bottom' : 'top') : null;
  wrap.classList.toggle('zone-bottom', zone === 'bottom');
  wrap.classList.toggle('zone-top', zone === 'top');
  if (analysis) {
    // 検討。通常フェーズの局面なら両方の色を動かせる。布石の局面は控えのまま（印だけ）。
    const { pos, row, lastDests } = analysisPosition();
    const shapes = analysisShapes();
    if (pos) {
      showPosition(sg, pos, {
        lastDests, movable: positionMoveDests(pos), droppable: positionDropDests(pos),
        promotion: promotionConfig(() => analysisPosition().pos), active: !pos.outcome(), shapes,
      });
    } else if (row === 0) {
      showIdleBoard(sg);
      setShapes(sg, shapes);
    } else showSnapshot(sg, game.kifu[row - 1].snapshot, shapes);
    return;
  }
  if (!reviewing) return void syncBoard(sg, game);
  if (viewPly === 0) return void showIdleBoard(sg);
  showSnapshot(sg, game.kifu[viewPly - 1].snapshot);
}

/** さかのぼる操作。対局中の局面へ戻るまで盤は触れない。検討中は読む局面が変わる。 */
function goToPly(ply) {
  if (!game || !game.kifu.length) return;
  const last = game.kifu.length;
  viewPly = ply === null || ply >= last ? null : Math.max(0, ply);
  if (analysis) dropVariation();
  render();
  if (analysis) restartInfinite();
}

function renderNav() {
  const n = game ? game.kifu.length : 0;
  const at = viewPly === null ? n : viewPly;
  const v = analysis?.variation;
  ui.navFirst.disabled = n === 0 || at === 0;
  ui.navPrev.disabled = n === 0 || (at === 0 && !(v?.at > 0));
  ui.navNext.disabled = n === 0 || (viewPly === null && !(v && v.at < v.moves.length));
  ui.navLast.disabled = n === 0 || (viewPly === null && !v?.moves.length);
}

function sideName(color) { return t(color === SENTE ? 'side_sente' : 'side_gote'); }
/** 記号なしの先後。地が紙でない場所（トースト・朱のボタン・押した玉の札）はこちら。 */
function sidePlain(color) { return t(color === SENTE ? 'side_sente_plain' : 'side_gote_plain'); }

/** 席の名前・手番の印・時計。 */
function renderSeats() {
  if (!game) return;
  // 下が手前（自分）。盤を反転しても席の並びは動かさない。
  const bottom = orientation;
  const top = bottom === SENTE ? GOTE : SENTE;
  // 誰が座っているか。天秤将棋で選ぶ前は色しか無い。押した（仮の）玉があれば仮の席にする。
  const label = c => {
    const who = game.spectate ? t('seat_ai', { n: aiLevel })
      : game.humanColor !== null
        ? (c === game.humanColor ? t('seat_you') : t('seat_ai', { n: aiLevel }))
        : pendingSide !== null
          ? (c === pendingSide ? t('seat_you_pending') : t('seat_ai', { n: aiLevel }))
          : null;
    // 誰かが決まっても先後は語で言う（81Dojoと同じ）。天秤将棋は色と役が一致しないので、記号だけでは足りない。
    return who === null ? sideName(c) : `${who} · ${sideName(c)}`;
  };
  ui.seatTopName.textContent = label(top);
  ui.seatBottomName.textContent = label(bottom);
  // 役の札。先後が決まってから終局まで残す。選んだ側の色が選ぶ役で、もう一方が置く役。
  // 色と役は一致しないので、席の名前だけでは3手目を過ぎると思い出せない。
  const roleChip = (node, c) => {
    const show = game.mode === 'kings-first' && game.chosen !== null;
    node.hidden = !show;
    node.textContent = show ? t(c === game.chosen ? 'role_chip_chooser' : 'role_chip_placer') : '';
  };
  roleChip(ui.seatTopRole, top);
  roleChip(ui.seatBottomRole, bottom);
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

/** 棋譜の見出し行（天秤将棋だけ）。役と、決まっていれば誰がどちらを持ったか。
 *  書き出しの見出しと同じ文で、対局中も棋譜の上に残す。 */
function renderKifuHead() {
  const show = !!game && game.mode === 'kings-first';
  ui.kifuHead.hidden = !show;
  if (!show) { ui.kifuHead.textContent = ''; return; }
  ui.kifuHead.textContent = kifuHeadText();
}

/** 「誰が両玉を置き、誰が何を持ったか」の一文。対局中の棋譜の上と、書き出しの見出しで共有。 */
function kifuHeadText() {
  const humanChooses = !game.spectate && game.humanRole === 'chooser';
  const choice = game.chosen === null
    ? t(humanChooses ? 'choice_pending_you' : 'choice_pending_ai')
    : t('choice_took', { side: sideName(game.chosen) });   // 「後手 ☖」。記号込み
  return t(game.spectate ? 'kifu_head_spectate'
    : game.humanRole === 'placer' ? 'kifu_head_you_placer' : 'kifu_head_you_chooser', { choice });
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
        : state === 'done' && game.chosen ? sideName(game.chosen) : '';
      // 誰が選んだかは幅が足りず入らない（「あなた → …」で切れた）。title に回す。
      if (state === 'done' && game.chosen)
        li.title = t('step_chosen', { who: who(game.humanRole === 'chooser'), side: sideName(game.chosen) });
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
  if (analysis) return 'analyze';
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
    ui.engine.hidden = ui.gauge.hidden = ui.chart.hidden = ui.variation.hidden = true;
    ui.undo.disabled = true;
    ui.undo.hidden = ui.resign.hidden = false;
    ui.pause.hidden = ui.abort.hidden = true;
    ui.ioSfen.value = '';
    ui.seatTopRole.hidden = ui.seatBottomRole.hidden = true;
    renderKifuHead();
    renderNav();
    renderKingTags();
    renderBanner();
    return;
  }
  if (game.phase !== 'choose') pendingSide = null;
  // 天秤将棋で先後が決まった。人間の色が決まったので、その対局で一度だけ盤を回す。
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
  renderKifuHead();
  renderStepper();
  renderKifu();
  renderNav();
  renderEngine();
  renderGauge();
  renderChart();
  renderChoice();
  renderVariation();
  ui.varBack.disabled = !analysis?.variation.moves.length;
  ui.analyzeAll.textContent = t(analysis?.pass ? 'btn_analyze_stop' : 'btn_analyze_all');
  ui.ioSfen.value = game.sfen();
  ui.undo.disabled = busy || viewPly !== null || game.phase === 'over' || undoTarget() < 0;
  // 観戦では待った・投了の代わりに一時停止・中断。
  ui.undo.hidden = ui.resign.hidden = game.spectate;
  ui.pause.hidden = ui.abort.hidden = !game.spectate;
  ui.pause.textContent = t(paused ? 'btn_resume' : 'btn_pause');
  ui.pause.disabled = ui.abort.disabled = game.phase === 'over';
  playMoveSounds();

  if (analysis) {
    clearInterval(clockTimer);
    clockTimer = null;
    if (analysis.pass) {
      setStatus(t('status_analyze_all', { i: analysis.pass.i, n: analysis.pass.n }), t('status_analyze_all_sub'));
    } else {
      const { pos, row, inVariation } = analysisPosition();
      const line = inVariation ? t('status_analyze_var', { n: variationPly(analysis.variation.at) })
        : row === 0 ? t('status_analyze_start') : t('status_analyze', { n: game.kifu[row - 1].ply ?? row });
      setStatus(line, pos ? t('status_analyze_sub') : t('status_analyze_fuseki_sub'));
    }
  } else if (game.phase === 'over') {
    clearInterval(clockTimer);
    clockTimer = null;
    const { who, why } = resultLine();
    setStatus(who, why);
    ui.resultNote.textContent = resultNote();
    ui.resign.disabled = true;
    disarmResign();
  } else if (viewPly !== null) {
    setStatus(t('status_reviewing', { n: viewPly }), game.spectate ? '' : t('status_reviewing_sub'));
  } else if (game.spectate) {
    if (paused) setStatus(t('status_paused'), t('status_paused_sub'));
    else setStatus(t('status_watching'), t('status_watching_sub'));
  } else if (game.isHumanTurn) {
    // 41手目でルールが変わる。フェーズの表示が切り替わるだけでは気づけないので、
    // 通常フェーズで自分がまだ1手も指していないあいだは言い続ける。
    // 「一度だけ」にすると、直後の drive() の再描画に上書きされて誰も読めない。
    if (game.phase === 'kings') {
      // 置く役は自分の色を知らずに両玉を置く。2手目は相手の駒台の玉を相手陣へ。
      const first = game.fusekiMoves.length === 0;
      setStatus(t(first ? 'status_placer_first' : 'status_placer_second'),
        t(first ? 'status_placer_first_sub' : 'status_placer_second_sub'));
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
    // AIが両玉を置いている間は、自分が選ぶ役だと言う。役をランダムにした人が自分の役を知る最初の場面。
    const sub = t(game.phase === 'kings' ? 'status_ai_kings_sub'
      : game.phase === 'choose' ? 'engine_table'
      : game.phase === 'fuseki' ? 'engine_policy' : 'engine_yaneuraou');
    setStatus(line, sub);
  }
  renderKingTags();
  renderBanner();
  announcePhase();
}

/** 段の境目で一度だけ知らせる（トーストと音）。先後が決まったとき、41手目に入ったとき。 */
function announcePhase() {
  const prev = phaseSeen;
  phaseSeen = game.phase;
  if (prev === null || prev === game.phase) return;
  if (prev === 'choose' && game.phase === 'fuseki' && game.humanColor) {
    showToast(t('toast_side_sub', { side: sidePlain(game.humanColor) }), t('curtain_side'));
    sound.play('phase');
  } else if (game.phase === 'normal' && prev !== 'normal') {
    showToast(t('curtain_normal'), t('toast_normal'));
    sound.play('phase');
  }
}

/** 盤の中央の幕。1.6秒出て0.35秒で消える。動きは状態変化にだけ使う（ほかは静かに）。 */
let toastTimer = null, toastTimer2 = null;
function showToast(line, sub = '') {
  ui.toastLine.textContent = line;
  ui.toastSub.textContent = sub;
  ui.toast.classList.remove('leaving');
  ui.toast.hidden = true;
  void ui.toast.offsetWidth;   // 続けて出したときも入りの動きをやり直す
  ui.toast.hidden = false;
  clearTimeout(toastTimer); clearTimeout(toastTimer2);
  toastTimer = setTimeout(() => { ui.toast.classList.add('leaving'); }, 1600);
  toastTimer2 = setTimeout(() => { ui.toast.hidden = true; ui.toast.classList.remove('leaving'); }, 2000);
}

// ---- 終局の帯 ----
//
// 盤の上に結果と行き先（もう一局・検討）を重ねる。1局に一度だけ出て、5秒で消えるか、
// 盤を押すか、さかのぼるか、検討に入るかで引く。パネルの結果枠は消えないので、
// 帯を見逃しても行き先は失われない。
let bannerFor = null, bannerTimer = null, bannerTimer2 = null;
function hideBanner(now = false) {
  clearTimeout(bannerTimer); clearTimeout(bannerTimer2);
  if (ui.banner.hidden) return;
  if (now) { ui.banner.hidden = true; ui.banner.classList.remove('leaving'); return; }
  ui.banner.classList.add('leaving');
  bannerTimer2 = setTimeout(() => { ui.banner.hidden = true; ui.banner.classList.remove('leaving'); }, 400);
}
function renderBanner() {
  const over = !!game && game.phase === 'over' && !analysis && viewPly === null;
  if (!over) { if (bannerFor !== game) bannerFor = null; hideBanner(true); return; }
  if (bannerFor === game) return;   // この対局では出した
  bannerFor = game;
  const { who, why } = resultLine();
  ui.bannerLine.textContent = who;
  ui.bannerSub.textContent = why;
  // 幕（先後が決まった・41手目）が出ている最中に終局したら、幕は引く。重なると読めない。
  clearTimeout(toastTimer); clearTimeout(toastTimer2);
  ui.toast.hidden = true; ui.toast.classList.remove('leaving');
  ui.banner.classList.remove('leaving');
  ui.banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => hideBanner(), 5000);
}
ui.bannerAgain.addEventListener('click', () => { hideBanner(true); newGameClicked(); });
ui.bannerAnalyze.addEventListener('click', () => { hideBanner(true); ui.analyze.click(); });
el('board').addEventListener('pointerdown', () => hideBanner());

/** 先後の2択と確定ボタン。押した玉があれば、そちらに縁を立てて確定を開ける。 */
function renderChoice() {
  ui.chooseSente.classList.toggle('selected', pendingSide === SENTE);
  ui.chooseGote.classList.toggle('selected', pendingSide === GOTE);
  ui.chooseConfirm.disabled = pendingSide === null;
  ui.chooseConfirm.textContent = pendingSide === null
    ? t('btn_confirm_side_idle') : t('btn_confirm_side', { side: sidePlain(pendingSide) });
}

/** 天秤将棋で先後が決まった直後だけ、誰がどちらを持ったかを言う。3手目の案内に添える。 */
function chosenNote() {
  if (game.mode !== 'kings-first' || game.phase !== 'fuseki' || game.fusekiMoves.length > 3) return '';
  // 自分で選んだときは言わない（帯とトーストに出ている）。AIが選んだときだけ、その結果を添える。
  if (game.humanRole === 'chooser') return '';
  return t('status_chosen_note', {
    who: t(game.humanRole === 'chooser' ? 'You' : 'AI'),
    side: sideName(game.chosen), yours: sideName(game.humanColor),
  });
}

/** 終局後の一行。天秤将棋なら、役・両玉のマス・誰が先手を持ったか・表の値。 */
function resultNote() {
  if (game.mode !== 'kings-first' || !game.chosen) return '';
  const { sente, gote } = game.kingSquares;
  let p = '—';
  try { p = (engines.kingTable.v(sente, gote) * 100).toFixed(1); } catch { /* 表に無ければ出さない */ }
  // マスは棋譜と同じ表記で（日本語なら「４七」。表のキー 4g をそのまま出すと英字が混じる）。
  const sq = key => (LANG === 'en' ? key : makeJapaneseSquare(parseSquareName(key)));
  return t('summary_kings', {
    placer: t(game.humanRole === 'placer' ? 'You' : 'AI'), kb: sq(sente), kw: sq(gote),
    chooser: t(game.humanRole === 'chooser' ? 'You' : 'AI'), side: sideName(game.chosen), p,
  });
}

/** 勝敗の一行。表示と棋譜の書き出しで共有する。 */
function resultLine() {
  const { winner, reason, winnerIs } = game.result;
  // 天秤将棋で先後を選ぶ前に投了すると、勝った色が無い。人間とAIのどちらかだけ言う。
  const who = reason === 'aborted' ? t('result_aborted')
    : winner === null ? t(winnerIs === 'ai' ? 'result_ai_wins' : 'result_draw')
    : t('result_color_wins', { side: sideName(winner) }) + (winnerIs === 'human' ? t('result_you') : '');
  const key = `reason_${reason}`;
  const why = t(key);
  return { who, why: why === key ? reason : why };
}

/** エンジンの言い分。数字が誰のものかを画面に出す。 */
function renderEngine() {
  if (analysis) return renderCandidates();
  ui.candidates.hidden = true;
  const ev = shownEval();
  if (!ev || !evalVisible()) { ui.engine.hidden = true; return; }
  ui.engine.hidden = false;
  ui.evaluation.textContent = formatEval(ev);
  if (ev.kind === 'policy' || ev.kind === 'kings') {
    ui.engineHead.textContent = `· ${t(ev.kind === 'policy' ? 'engine_policy_random' : 'engine_table')}`;
    ui.enginePv.textContent = '';
    return;
  }
  const bits = [t('engine_yaneuraou')];
  if (ev.depth != null) bits.push(t('engine_depth', { d: ev.depth }));
  if (ev.nps != null && viewPly === null) bits.push(formatNps(ev.nps));
  ui.engineHead.textContent = `· ${bits.join(' · ')}`;
  // 読み筋は8手まで。全部出すと狭いパネルで3行になり、棋譜に回せる高さを食う。
  // さかのぼって見ているときは、その行の局面から並べる（いまの局面では非合法手で途切れる）。
  const at = viewPly === null ? null : viewPly - 1;
  const pv = at === null
    ? game.pvText(ev.pv?.slice(0, 8))
    : game.pvText(ev.pv?.slice(0, 8), { position: game.positionAt(at), lastDest: lastDestOf(at) });
  ui.enginePv.textContent = pv ? t('engine_pv', { pv }) : '';
}

/** 棋譜の行の着手先（「同」の判定用）。通常フェーズの行だけ。 */
function lastDestOf(index) {
  const usi = game.kifu[index]?.usi;
  if (!usi || usi.startsWith('choose:')) return undefined;
  return parseSquareName(usi.includes('*') ? usi.slice(2) : usi.slice(2, 4));
}

function formatNps(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M NPS` : `${Math.round(n / 1000)}k NPS`;
}

/**
 * 評価 → 先手の勝率（0〜1）。ゲージとグラフが同じ換算を使う。
 * 評価値（先手から見た値）は 1/(1+e^(-cp/400))、詰みは端に張り付ける。
 * 表の値（kings）は勝率そのもの。布石の「採用手の確率」は勝率ではないので null。
 */
function winRateOf(ev) {
  if (!ev) return null;
  if (ev.kind === 'kings') return ev.winRate;
  if (ev.kind !== 'search' || ev.score == null) return null;
  const cp = ev.scoreKind === 'mate' ? (ev.score > 0 ? 1e5 : -1e5) : ev.score;
  return 1 / (1 + Math.exp(-cp / 400));
}

/**
 * 評価ゲージ。通常フェーズだけ出す。
 *
 * 布石フェーズの「採用手の確率」は方策が自分の手にどれだけ自信があるかであって
 * 優劣ではない。両側に振れる帯に載せると「先手が良い」と読めてしまうので載せない。
 */
function renderGauge() {
  const ev = shownEval();
  const show = ev && ev.kind === 'search' && ev.score != null && evalVisible();
  ui.gauge.hidden = !show;
  if (!show) return;
  const p = winRateOf(ev);
  // 帯は手前（盤の下側）から伸びる。後手を持つと手前は後手なので、そのままでは
  // 自分が押しているときに相手側から伸びて見える。盤の向きに合わせて裏返す。
  // 見ているのは humanColor ではなく orientation。盤を反転したら帯も付いてくる。
  const bottom = orientation === SENTE ? p : 1 - p;
  ui.gauge.style.setProperty('--eval-p', String(bottom));
}

// ---- 検討 ----
//
// 終局後だけ。見ている局面（本譜の1行、または盤で試した変化の先）をやねうら王が
// 読み続け（go infinite・MultiPV 3）、候補手を出す。盤の駒はどちらの色も動かせて、
// 指した手は本譜の下に変化として1本だけ並ぶ（木は作らない）。
// 布石の局面はやねうら王で評価できない（持ち駒に玉、打ち場所の制限）ので、
// 布石エンジンの候補手（確率）だけを出す。そのための局面は2つ目のWASMで作り直す
// （対局の局面を持つ1つ目は触らない）。状態（analysis / analysisFuseki / infoGen）の宣言は
// 「対局の状態」の節にある。

function startAnalysis() {
  if (!game || game.phase !== 'over' || !engines || analysis) return;
  analysis = { variation: { moves: [], at: 0 }, candidates: [], hover: null, pass: null, live: null };
  engines.engine.setMultiPv(3);
  render();
  restartInfinite();
}

function endAnalysis() {
  if (!analysis) return;
  if (analysis.pass) analysis.pass.cancel = true;
  analysis = null;
  infoGen++;
  engines?.engine.stopInfinite();
  engines?.engine.setMultiPv(1);
  if (sg) setShapes(sg, []);
  render();
}
ui.analyze.addEventListener('click', startAnalysis);
ui.analyzeEnd.addEventListener('click', endAnalysis);
ui.varBack.addEventListener('click', () => {
  if (!analysis) return;
  dropVariation();
  render();
  restartInfinite();
});
ui.analyzeAll.addEventListener('click', () => {
  if (!analysis) return;
  if (analysis.pass) analysis.pass.cancel = true;
  else runPass();
});

/** 検討で盤に出している局面。本譜の行 row の局面から、変化を at 手だけ進めたもの。 */
function analysisPosition() {
  const row = viewedRow();
  const v = analysis.variation;
  const pos = row === 0 ? null : game.positionAt(row - 1);   // 布石の行なら null
  if (!pos) return { pos: null, row, lastDest: undefined, lastDests: [], inVariation: false };
  let lastDest = lastDestOf(row - 1);
  let lastDests = game.kifu[row - 1].snapshot?.lastDests ?? [];
  for (const m of v.moves.slice(0, v.at)) {
    const md = parseUsi(m.usi);
    pos.play(md);   // positionAt は毎回作り直すので、そのまま進めてよい
    lastDest = md.to;
    lastDests = 'from' in md ? [makeSquareName(md.from), makeSquareName(md.to)] : [makeSquareName(md.to)];
  }
  return { pos, row, lastDest, lastDests, inVariation: v.at > 0 };
}

/** 変化の k 手目の手数（本譜の行の手数の続き）。 */
function variationPly(k) {
  const row = viewedRow();
  return (row === 0 ? 0 : game.kifu[row - 1].ply ?? 40) + k;
}

function dropVariation() {
  if (!analysis) return;
  analysis.variation.moves.length = 0;
  analysis.variation.at = 0;
}

/** 変化の中を進む・戻る。 */
function varStep(delta) {
  const v = analysis.variation;
  v.at = Math.max(0, Math.min(v.moves.length, v.at + delta));
  render();
  restartInfinite();
}

/** 盤で指した手（または候補手）を変化として1手足す。見ている変化の先を切り捨てる。 */
function playVariation(usi) {
  if (!analysis) return;
  const { pos, lastDest } = analysisPosition();
  if (!pos) return render();
  const md = parseUsi(usi);
  if (!md || !pos.isLegal(md)) { setStatus(t('status_illegal'), usi); return; }
  const v = analysis.variation;
  v.moves.length = v.at;
  v.moves.push({ usi, text: game.moveText(pos, md, lastDest), capture: pos.board.get(md.to) !== undefined });
  v.at = v.moves.length;
  sound.play(v.moves[v.at - 1].capture ? 'capture' : 'move');
  render();
  restartInfinite();
}

/** 見ている局面を読み直す。通常フェーズの局面はやねうら王、布石の局面は布石エンジンの候補手。 */
function restartInfinite() {
  if (!analysis || analysis.pass) return;
  const gen = ++infoGen;
  analysis.candidates = [];
  analysis.live = null;
  analysis.hover = null;
  const { pos, row, inVariation } = analysisPosition();
  if (!pos) {
    engines.engine.stopInfinite();
    fusekiCandidates(row, gen);
    return;
  }
  // 詰んでいる局面は読めない（合法手が無い）。
  if (pos.outcome()) { engines.engine.stopInfinite(); renderAnalysis(); return; }
  const turn = pos.turn;
  const g = game;
  let queued = false;
  engines.engine.startInfinite({
    sfen: makeSfen(pos),
    onInfo: info => {
      if (gen !== infoGen || game !== g || info.score == null) return;
      const ev = {
        kind: 'search', scoreKind: info.scoreKind, score: turn === SENTE ? info.score : -info.score,
        depth: info.depth, nps: info.nps, pv: info.pv, source: 'analysis',
      };
      analysis.candidates[info.multipv - 1] = ev;
      if (info.multipv === 1) {
        analysis.live = ev;
        // 本譜の行なら、その行の評価も更新する（グラフとゲージに効く）。浅い値で深い値を潰さない。
        if (!inVariation && row > 0) {
          const old = g.kifu[row - 1].eval;
          if (!old || old.kind !== 'search' || old.source !== 'analysis' || (ev.depth ?? 0) >= (old.depth ?? 0)) {
            g.kifu[row - 1].eval = { ...ev };
            if (row === g.kifu.length) g.lastEval = g.kifu[row - 1].eval;
          }
        }
      }
      // info は1秒に何十行も来る。描き直しは1フレームに1回にまとめる。
      if (!queued) {
        queued = true;
        requestAnimationFrame(() => { queued = false; if (gen === infoGen) renderAnalysis(); });
      }
    },
  }).catch(() => {});
}

/** 検討の表示だけ描き直す（候補手・ゲージ・グラフ・矢印）。棋譜は触らない。 */
function renderAnalysis() {
  if (!analysis || !game) return;
  renderEngine();
  renderGauge();
  renderChart();
  if (sg) setShapes(sg, analysisShapes());
}

/** 布石の局面の候補手。2つ目のWASMに手順を入れ直して方策を1回通す。 */
async function fusekiCandidates(row, gen) {
  const g = game;
  // 天秤将棋の選択の行（局面は変わらない）と、1・2手目の玉の置き場所は候補を出さない
  // （方策は玉以外も混ぜて返す。置く役の指針は価値表のほうで、ここには載せない）。
  if (g.mode === 'kings-first' && row < 3) return renderAnalysis();
  if (!analysisFuseki) analysisFuseki = await Fuseki.load(ASSETS.fuseki);
  if (gen !== infoGen || game !== g) return;
  analysisFuseki.reset();
  for (const e of g.kifu.slice(0, row)) if (!e.usi.startsWith('choose:')) analysisFuseki.drop(e.usi);
  if (analysisFuseki.isPlacementDone) return renderAnalysis();
  const { logits } = await engines.policy.evaluate(analysisFuseki);
  if (gen !== infoGen || game !== g) return;
  const legal = analysisFuseki.legalDrops();
  const color = analysisFuseki.turn;
  const labelFn = engines.policy.labelFn;
  let max = -Infinity;
  const raw = legal.map(d => { const v = logits[analysisFuseki[labelFn](d.pt, d.sq, color)]; if (v > max) max = v; return v; });
  const exps = raw.map(v => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  analysis.candidates = legal
    .map((d, i) => ({ kind: 'policy', usi: d.usi, role: d.role, color: color === 0 ? SENTE : GOTE, probability: exps[i] / total }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);
  renderAnalysis();
}

/** 盤に重ねる矢印と印。候補手（なぞっている1本、無ければ最善）の最初の手。布石は上位5つのマス。 */
function analysisShapes() {
  if (!analysis) return [];
  const c = analysis.candidates.filter(Boolean);
  if (!c.length) return [];
  if (c[0].kind === 'policy') {
    return c.map((k, i) => {
      const sq = usiDropSquare(k.usi);
      return { orig: sq, dest: sq, brush: i === 0 ? 'primary' : 'alt', description: `${Math.round(k.probability * 100)}%` };
    });
  }
  const ev = c[Math.min(analysis.hover ?? 0, c.length - 1)];
  const md = ev?.pv?.[0] ? parseUsi(ev.pv[0]) : null;
  if (!md) return [];
  if ('from' in md) return [{ orig: makeSquareName(md.from), dest: makeSquareName(md.to), brush: 'primary' }];
  const pos = analysisPosition().pos;
  if (!pos) return [];
  return [{ orig: { color: pos.turn, role: md.role }, dest: makeSquareName(md.to), brush: 'primary' }];
}

/** 候補手の一覧（エンジン枠の中）。 */
function renderCandidates() {
  ui.engine.hidden = false;
  ui.candidates.hidden = false;
  ui.enginePv.textContent = '';
  const list = analysis.candidates.filter(Boolean);
  const { pos, lastDest } = analysisPosition();
  const live = analysis.live;
  if (!pos) {
    ui.evaluation.textContent = '—';
    ui.engineHead.textContent = `· ${t('engine_policy')}`;
  } else {
    // 詰んでいる局面は読まない（合法手が無い）。読み込み中と言い続けない。
    ui.evaluation.textContent = live ? formatEval(live) : pos.outcome() ? '—' : t('engine_analyzing');
    const bits = [t('engine_yaneuraou')];
    if (live?.depth != null) bits.push(t('engine_depth', { d: live.depth }));
    if (live?.nps != null) bits.push(formatNps(live.nps));
    ui.engineHead.textContent = `· ${bits.join(' · ')}`;
  }
  // 行の要素は作り直さず、あるものを書き換える。info は毎フレーム来るので、作り直すと
  // 押している最中に要素が替わって click が成立しない（mousedown と mouseup の的が別物になる）。
  while (ui.candidates.childElementCount > list.length) ui.candidates.lastElementChild.remove();
  while (ui.candidates.childElementCount < list.length) {
    const li = document.createElement('li');
    for (const cls of ['ev', 'mv', 'pv']) { const s = document.createElement('span'); s.className = cls; li.appendChild(s); }
    ui.candidates.appendChild(li);
  }
  list.forEach((c, i) => {
    const li = ui.candidates.children[i];
    li.dataset.i = String(i);
    li.classList.toggle('hover', c.kind === 'search' && i === (analysis.hover ?? 0));
    const [ev, mv, pv] = li.children;
    if (c.kind === 'policy') {
      ev.textContent = t('cand_prob', { p: (c.probability * 100).toFixed(1) });
      mv.textContent = game.fusekiMoveText(c.usi, c.role, c.color);
      pv.textContent = '';
    } else {
      ev.textContent = formatScore(c);
      const md = c.pv?.[0] ? parseUsi(c.pv[0]) : null;
      if (md && pos && pos.isLegal(md)) {
        mv.textContent = game.moveText(pos, md, lastDest);
        const next = pos.clone();
        next.play(md);
        // 読み筋は最初の手の続きを6手。
        pv.textContent = game.pvText(c.pv.slice(1, 7), { position: next, lastDest: md.to });
      } else { mv.textContent = c.pv?.[0] ?? ''; pv.textContent = ''; }
    }
  });
}

/** 評価値だけの短い形（候補手の行）。先手から見た値。 */
function formatScore(ev) {
  if (ev.scoreKind === 'mate') return t('eval_mate', { n: `${ev.score > 0 ? '' : '-'}${Math.abs(ev.score)}` });
  if (ev.scoreKind === 'cp') return `${ev.score > 0 ? '+' : ''}${ev.score}`;
  return '—';
}

// 候補手をなぞると矢印がその手に替わり、押すとその手を変化として指す。
ui.candidates.addEventListener('pointerover', e => {
  const li = e.target.closest('li');
  if (!li || !analysis) return;
  const i = Number(li.dataset.i);
  if (analysis.hover === i) return;
  analysis.hover = i;
  renderAnalysis();
});
ui.candidates.addEventListener('pointerleave', () => {
  if (!analysis || analysis.hover === null) return;
  analysis.hover = null;
  renderAnalysis();
});
ui.candidates.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li || !analysis) return;
  const c = analysis.candidates.filter(Boolean)[Number(li.dataset.i)];
  if (c?.kind === 'search' && c.pv?.[0]) playVariation(c.pv[0]);
});

/** 本譜の下の変化の行。 */
function renderVariation() {
  const v = analysis?.variation;
  if (!v || !v.moves.length) { ui.variation.hidden = true; ui.variation.replaceChildren(); return; }
  ui.variation.hidden = false;
  ui.variation.dataset.head = t('variation_head');
  const frag = document.createDocumentFragment();
  v.moves.forEach((m, k) => {
    const li = document.createElement('li');
    if (k + 1 === v.at) li.classList.add('current');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(variationPly(k + 1));
    const t2 = document.createElement('span'); t2.className = 'm'; t2.textContent = m.text;
    li.append(n, t2);
    frag.appendChild(li);
  });
  ui.variation.replaceChildren(frag);
}
ui.variation.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li || !analysis) return;
  analysis.variation.at = [...ui.variation.children].indexOf(li) + 1;
  render();
  restartInfinite();
});

/**
 * 全手を解析。評価の無い行（と、対局中の探索から写しただけの行）を1手0.3秒で順に埋める。
 * 読み続けている検討は止め、終わったら見ている局面の検討に戻る。同じエンジンを使うので
 * 並走はできない。
 */
async function runPass() {
  if (!analysis || analysis.pass || !engines) return;
  const g = game;
  const rows = g.kifu.map((e, i) => i).filter(i => {
    const e = g.kifu[i];
    if (e.ply === null || e.ply < 40 || !g.positionAt(i)) return false;
    return !(e.eval?.kind === 'search' && e.eval.source === 'analysis');
  });
  if (!rows.length) return;
  const pass = analysis.pass = { i: 0, n: rows.length, cancel: false };
  infoGen++;
  const eng = engines.engine;
  eng.stopInfinite();
  await eng.setMultiPv(1);
  render();
  for (const i of rows) {
    if (pass.cancel || game !== g || !analysis) break;
    const pos = g.positionAt(i);
    if (!pos.outcome()) {
      const info = await eng.analyze({ sfen: makeSfen(pos), movetimeMs: 300 }).catch(() => null);
      if (pass.cancel || game !== g || !analysis) break;
      if (info) g.recordEval(i, info, pos.turn, 'analysis');
    }
    pass.i++;
    renderChart();
    setStatus(t('status_analyze_all', { i: pass.i, n: pass.n }), t('status_analyze_all_sub'));
  }
  if (analysis && analysis.pass === pass) {
    analysis.pass = null;
    g.lastEval = g.kifu[g.kifu.length - 1]?.eval ?? g.lastEval;
    await eng.setMultiPv(3);
    render();
    restartInfinite();
  }
}

// ---- 評価グラフ ----

// 横軸は棋譜の行（0 = 空の盤、i = i行目を指した後）、縦軸は先手の勝率。
// 布石の手には評価が無いので左側は空白のまま。天秤将棋の2手目だけ表の値を点で打つ。
const CHART = { top: 4, bottom: 4, left: 2, right: 2 };
let chartHover = null;   // なぞっている行（0〜n）。null なら出さない

function renderChart() {
  const show = !!game && evalVisible() && (!!game.finalSfen || game.kifu.some(e => e.eval));
  ui.chart.hidden = !show;
  if (!show) return;
  const svg = ui.chartSvg;
  const rows = game.kifu;
  const n = Math.max(rows.length, 1);
  const W = svg.clientWidth || 280, H = svg.clientHeight || 72;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const x = i => CHART.left + (W - CHART.left - CHART.right) * (i / n);
  const y = p => CHART.top + (H - CHART.top - CHART.bottom) * (1 - p);
  const mid = y(.5);
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    frag.appendChild(e);
    return e;
  };
  for (const p of [.25, .75]) add('line', { class: 'grid', x1: x(0), x2: x(n), y1: y(p), y2: y(p), 'stroke-dasharray': '2 3' });
  add('line', { class: 'mid', x1: x(0), x2: x(n), y1: mid, y2: mid });

  // 値の並び。連続した区間ごとに面と線を描く。
  const vals = rows.map(e => (e.eval?.kind === 'search' ? winRateOf(e.eval) : null));
  let run = [];
  const flush = () => {
    if (run.length < 1) { run = []; return; }
    // 1点だけでも見えるように、直前の行（評価なし）から 0.5 で始める。
    const pts = run.map(([i, p]) => [x(i + 1), y(p)]);
    const x0 = run[0][0] > 0 && vals[run[0][0] - 1] == null ? x(run[0][0]) : pts[0][0];
    let top = `M${x0},${mid}`, bot = `M${x0},${mid}`, line = '';
    pts.forEach(([px, py], k) => {
      top += ` L${px},${Math.min(py, mid)}`;
      bot += ` L${px},${Math.max(py, mid)}`;
      line += `${k ? 'L' : 'M'}${px},${py} `;
    });
    const xe = pts[pts.length - 1][0];
    add('path', { class: 'area-sente', d: `${top} L${xe},${mid} Z` });
    add('path', { class: 'area-gote', d: `${bot} L${xe},${mid} Z` });
    add('path', { class: 'line', d: line });
    run = [];
  };
  vals.forEach((p, i) => { if (p == null) flush(); else run.push([i, p]); });
  flush();

  // 41手目の区切り。行の添字は天秤将棋の選択の行ぶんずれるので ply で探す。
  const i41 = rows.findIndex(e => e.ply === 41);
  const i40 = rows.findIndex(e => e.ply === 40);
  const split = i41 >= 0 ? i41 : i40 >= 0 ? i40 + 1 : -1;
  if (split >= 0 && split < n) {
    add('line', { class: 'divider', x1: x(split), x2: x(split), y1: CHART.top, y2: H - CHART.bottom });
    // 区切りは棋譜の右寄りに来ることが多い。右に書くと枠の外へはみ出て切れる（実際に切れていた）
    // ので、右半分では線の左に書く。
    const left = x(split) > W * .6;
    add('text', { x: x(split) + (left ? -3 : 3), y: CHART.top + 9, 'text-anchor': left ? 'end' : 'start' }, t('chart_from41'));
  }
  // 布石の区間に評価が無ければ、そう書いておく。最後の布石の行（40手目）は41手目の局面
  // そのものなので評価が付く。見るのはその手前まで。
  const blankEnd = split < 0 ? n : Math.max(0, split - 1);
  if (blankEnd > 0 && !vals.slice(0, blankEnd).some(p => p != null))
    add('text', { x: x(blankEnd / 2), y: mid - 3, 'text-anchor': 'middle' }, t('chart_no_eval'));
  // 天秤将棋の2手目。表の値を点で。
  rows.forEach((e, i) => {
    if (e.eval?.kind === 'kings') add('circle', { class: 'kings', cx: x(i + 1), cy: y(e.eval.winRate), r: 2.5 });
  });

  // 見ている手（なぞっていればその行）。
  const at = chartHover ?? (viewPly === null ? n : viewPly);
  add('line', { class: 'cursor', x1: x(at), x2: x(at), y1: CHART.top, y2: H - CHART.bottom });
  const ev = at > 0 ? rows[at - 1]?.eval : null;
  const p = winRateOf(ev);
  if (p != null) add('circle', { class: 'dot', cx: x(at), cy: y(p), r: 3 });
  if (chartHover !== null && at > 0) {
    const v = ev ? formatEval(ev) : '—';
    const label = t('chart_tip', { n: rows[at - 1]?.ply ?? '', v });
    const anchor = at / n > .6 ? 'end' : 'start';
    add('text', { class: 'tip', x: x(at) + (anchor === 'end' ? -4 : 4), y: H - CHART.bottom - 4, 'text-anchor': anchor }, label);
  }
  svg.replaceChildren(frag);
}

/** グラフの横位置 → 棋譜の行（0〜n）。 */
function chartRowAt(clientX) {
  const b = ui.chartSvg.getBoundingClientRect();
  const n = game.kifu.length;
  const f = (clientX - b.left - CHART.left) / Math.max(1, b.width - CHART.left - CHART.right);
  return Math.max(0, Math.min(n, Math.round(f * n)));
}
ui.chart.addEventListener('pointermove', e => {
  if (!game) return;
  const row = chartRowAt(e.clientX);
  if (e.buttons & 1) { chartHover = null; goToPly(row); return; }   // なぞってその手へ
  if (row !== chartHover) { chartHover = row; renderChart(); }
});
ui.chart.addEventListener('pointerleave', () => { chartHover = null; if (game) renderChart(); });
ui.chart.addEventListener('pointerdown', e => {
  if (!game) return;
  chartHover = null;
  const row = chartRowAt(e.clientX);
  // 最後の行は「最新」（null）。同じ行なら描き直さない（検討の読み直しを起こさない）。
  if (row === viewedRow() && !analysis?.variation.moves.length) return;
  goToPly(row);
});
addEventListener('resize', () => { if (game) renderChart(); });

/**
 * 棋譜の書き出し。KIFとは呼ばない。KIFには「空の盤＋持ち駒20枚」を表す書き方が無く、
 * KIFと名乗って どのKIFリーダーも読めないのは、素のテキストより悪い。
 */
function kifuText() {
  const seats = game.spectate ? t('kifu_seats_spectate')
    : game.humanColor === null ? t('kifu_seats_undecided')
    : t(game.humanColor === SENTE ? 'kifu_seats_you_sente' : 'kifu_seats_you_gote');
  // 天秤将棋は役も残す。色と役は一致するとは限らないので、両方書く。
  const roles = game.mode !== 'kings-first' ? '' : `${kifuHeadText()} / `;
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

  // ルールは手順に書いてある。選択のトークンがあれば天秤将棋。
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
    // 天秤将棋の選択は駒を動かさないので鳴らさない。
    if (!last.usi.startsWith('choose:'))
      sound.play(game.checks() ? 'check' : last.capture ? 'capture' : 'move');
    soundedKifu = game.kifu.length;
  }
  if (game.phase === 'over' && !soundedOver) {
    soundedOver = true;
    const { winnerIs } = game.result;
    // 観戦は勝ちも負けも無い。段の境目と同じ知らせの音にする。
    sound.play(game.spectate ? 'phase' : winnerIs === null ? 'draw' : winnerIs === 'human' ? 'win' : 'lose');
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
  // 天秤将棋の置く役・選ぶ役が引いた表の値。先手から見た勝率。
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
