// 実際のブラウザで dist/ を開き、ホームから対局を始めて盤に駒が並ぶところまでを見る。
//
// pipeline_smoke.mjs はNodeでロジックを通すが、**ブラウザでしか壊れない部分**
// （COOP/COEPとSharedArrayBuffer、vendor/以下のアセット解決、shogigroundの描画、
// パネルのレイアウト）は素通りしてしまう。ここはその差分だけを見るためのもの。
//
//   node build.mjs && node test/browser_smoke.mjs [dist ディレクトリ]
//   --full           布石40手→41手目の裁定→通常フェーズまで実際に指して通す
//   --kings-first    天秤将棋を両方の役で始め、盤の玉を押して先後を選ぶところまで
//   --watch          観戦（AI同士）をレベル1で終局まで流し、一時停止・中断・評価グラフを見る
//   --online         友達と対局（オンライン）。2つのタブで部屋を作って入り、指し、読み込み直し、投了まで。
//                    部屋の Worker が要る: cd worker && npx wrangler dev --port 8787
//                    dist/ は node build.mjs --rooms http://localhost:8787 で作っておく
//   --shots <dir>    要所の画面を PNG に残す（目で見るため）
//
// Chrome を --headless で起こして CDP で叩く（Node 26 の組み込み WebSocket を使うので
// 追加の依存は要らない）。CHROME 環境変数で実行ファイルを差し替えられる。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const flagValue = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const SHOTS = flagValue('--shots');
const args = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--shots');
const FULL = argv.includes('--full');
const KINGS = argv.includes('--kings-first');
const WATCH = argv.includes('--watch');
const ONLINE = argv.includes('--online');
const ROOMS = process.env.ROOMS_URL || 'http://127.0.0.1:8787';
const DIST = args[0] ? path.resolve(args[0]) : path.join(ROOT, 'dist');
const NORMAL_PLIES = Number(args[1] ?? 4);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
// 固定だと --full を並べて回したときにぶつかる。SMOKE_PORT で逃がせるようにする。
const PORT = Number(process.env.SMOKE_PORT || 8099);

if (!fs.existsSync(path.join(DIST, 'app.js'))) {
  console.error('dist/ が無い。先に node build.mjs を実行すること。');
  process.exit(1);
}
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** 画面から読める状態。1手ごとに何度も評価を往復しないよう1回でまとめて取る。 */
const SNAPSHOT = `({
  status: document.getElementById('status-line').textContent,
  sub: document.getElementById('status-sub').textContent,
  phase: document.getElementById('panel').dataset.phase ?? '',
  state: document.getElementById('panel').dataset.state ?? '',
  evaluation: document.getElementById('readout-eval').textContent,
  evalHidden: document.getElementById('engine').hidden,
  kifu: document.querySelectorAll('#kifu li').length,
  boardPieces: document.querySelectorAll('sg-pieces piece:not(.fading)').length,
})`;

// main.js が setStatus で出すエラーの文言。**ここを見るのが要点**で、drive() は
// 例外を握って表示へ流すため、Runtime.exceptionThrown には何も出てこない。
const FATAL_STATUS = ['起動に失敗した', 'エンジンでエラーが起きた', 'その手は指せない',
  'Failed to start', 'Engine error', 'That move is not legal'];

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// ---- dist/ をCOOP/COEP付きで配る（serve.mjs と同じ条件） ----
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  let file = path.join(DIST, rel);
  // Cloudflare Pages と同じく、ディレクトリは index.html。
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
    return void res.writeHead(404).end('not found');
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, r));

// ---- Chrome を起こす ----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fuseki-chrome-'));
const chrome = spawn(CHROME, [
  // --mute-audio: 開発機のスピーカーから駒音が鳴らないようにする。AudioContext は
  // 起きる（state が running になる）ので、音の経路の検査はそのまま通る。
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio', '--remote-debugging-port=0',
  '--window-size=1280,1600',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('ChromeのDevToolsが開かない')), 30000);
  chrome.stderr.on('data', d => {
    buf += d;
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(timer); resolve(m[0]); }
  });
  chrome.on('exit', c => reject(new Error(`Chromeが起動しない (exit ${c})。CHROME= で実行ファイルを指定する`)));
});

const cdp = await connect(wsUrl);
const logs = [];
/** これまでに出た未処理例外。logs は増え続けるので、その都度数える。 */
const exceptions = () => logs.filter(l => l.startsWith('EXCEPTION'));
let page;
try {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  page = await cdp.attach(target.targetId);
  page.on('Runtime.consoleAPICalled', e => logs.push(e.args.map(a => a.value ?? a.description).join(' ')));
  page.on('Runtime.exceptionThrown', e => logs.push('EXCEPTION ' + (e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)));
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `http://localhost:${PORT}/` });

  check('crossOriginIsolated', await evalUntil(page, 'crossOriginIsolated', v => v === true, 15000) === true,
    'COOP/COEPが効いていないとやねうら王が1スレッドに落ちる');
  // crossOriginIsolated は head の時点で立つ。body がまだ無いうちに要素を引くと null で落ちる（実際に落ちた）。
  await evalUntil(page, 'document.readyState', v => v === 'complete', 15000);

  // ---- ホーム ----
  check('最初はホームで、対局画面は隠れている', await evaluate(page,
    '!document.getElementById("view-home").hidden && document.getElementById("view-play").hidden'));
  check('ルールの選択肢が2つ（布石将棋・天秤将棋）',
    await evaluate(page, 'document.querySelectorAll("input[name=mode]").length') === 2);

  // 3つのエンジンが起きて「対局開始」が押せるようになるまで
  const ready = await evalUntil(page, 'document.getElementById("btn-new").disabled', v => v === false, 120000);
  check('3つのエンジンが起動した', ready === false,
    await evaluate(page, 'document.getElementById("boot").textContent'));
  if (failures) { console.log('--- コンソール ---'); logs.forEach(l => console.log('  ' + l)); }
  if (ready !== false) throw new Error('エンジンが起動しないので以降の確認はできない');
  // 対局開始がファーストビューに入っている（以前は設定の末尾で画面の外だった）。
  check('対局開始ボタンが画面の中にある', await evaluate(page, `(() => {
    const r = document.getElementById('btn-new').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  })()`));
  check('天秤将棋が選べる（天秤の表が読めている）',
    await evaluate(page, 'document.getElementById("mode-kings").disabled') === false);
  // ホームの盤（homeboard.js）。起動後に布石エンジンが打ち始め、紙色の駒が描かれる。
  const homeBoard = await evalUntil(page, `(() => {
    const c = document.getElementById('home-board'), ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let paper = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] > 240 && d[i + 1] > 230 && d[i + 2] > 190 && d[i + 2] < 230) paper++;
    return paper;
  })()`, v => v > 50, 8000);
  check('ホームの盤に布石エンジンの駒が落ちてくる', homeBoard > 50, `紙色の標本 ${homeBoard}`);
  await shot('01-home');

  // 誰と指すかの3タブ。選んだ相手に要る設定とボタンだけが出る（他は hidden）。
  const tabs = await evaluate(page, `(() => {
    const vis = id => !document.getElementById(id).hidden;
    const pick = id => document.getElementById(id).click();
    const de = document.documentElement;
    const snap = () => ({ level: vis('lbl-level'), nick: vis('lbl-nick'), start: vis('btn-new'), invite: vis('btn-invite'),
      lobby: vis('lobby'), label: document.getElementById('btn-invite').textContent,
      note: document.getElementById('opp-note').textContent,
      spectate: document.querySelector('#opt-color option[value="spectate"]').hidden,
      selected: [...document.querySelectorAll('#opp [role="tab"]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.opp).join(','),
      hscroll: de.scrollWidth > de.clientWidth });
    const r = {};
    pick('opp-friend'); r.friend = snap();
    pick('opp-lobby'); r.lobby = snap();
    pick('opp-ai'); r.ai = snap();
    return r;
  })()`);
  check('友達タブ: AIの強さが消え、名前と「招待リンクを作る」が出る',
    tabs.friend.selected === 'friend' && tabs.friend.nick && !tabs.friend.level && !tabs.friend.start && tabs.friend.invite
      && !tabs.friend.lobby && tabs.friend.label === '招待リンクを作る' && tabs.friend.note.length > 0 && tabs.friend.spectate && !tabs.friend.hscroll,
    JSON.stringify(tabs.friend));
  check('待合タブ: 募集の一覧と「待合に出す」が出る',
    tabs.lobby.selected === 'lobby' && tabs.lobby.lobby && tabs.lobby.nick && !tabs.lobby.level && !tabs.lobby.start && tabs.lobby.invite
      && tabs.lobby.label === '待合に出す' && !tabs.lobby.hscroll,
    JSON.stringify(tabs.lobby));
  check('AIタブ: AIの強さと対局開始だけ。名前・待合・観戦以外の注は出ない',
    tabs.ai.selected === 'ai' && tabs.ai.level && !tabs.ai.nick && tabs.ai.start && !tabs.ai.invite && !tabs.ai.lobby && !tabs.ai.spectate && !tabs.ai.hscroll,
    JSON.stringify(tabs.ai));

  // 1局通すときはレベル1（いちばん思考時間が短い）にする。movetimeMs は Game の
  // コンストラクタで固定されるので、対局開始を押す**前**に変える。
  if (FULL) await evaluate(page, 'document.getElementById("opt-level").value = "1"');
  // 実マウスで押す。element.click() は利用者の操作と見なされないので、
  // ブラウザの自動再生規制で AudioContext が suspended のままになり、
  // 「音が鳴らない」状態をテストが素通りしてしまう。
  await click(page, await center(page, '#btn-new'));

  check('対局開始で対局画面に切り替わり、URL が #play になる', await evaluate(page,
    'document.getElementById("view-home").hidden && !document.getElementById("view-play").hidden && location.hash === "#play"'));
  check('対局中は投了が押せる',
    await evaluate(page, 'document.getElementById("btn-resign").disabled') === false);
  check('フェーズ帯が2段で、布石が今の段', await evaluate(page, `(() => {
    const steps = [...document.querySelectorAll('#stepper .step')];
    return steps.length === 2 && steps[0].classList.contains('now') && steps[1].classList.contains('next');
  })()`));

  // 合成が動くことと、アプリの経路で鳴ることは別問題。AudioContext は利用者の操作の
  // 中でしか起こせないので、対局開始で起きていなければ1音も出ない。
  const audio = await evaluate(page, `(() => {
    const s = window.__sound;
    if (!s) return 'sound が公開されていない';
    return { ctx: !!s.ctx, state: s.ctx?.state };
  })()`);
  check('対局開始でAudioContextが起きている',
    typeof audio === 'object' && audio.ctx && audio.state === 'running',
    typeof audio === 'string' ? audio : `state=${audio.state}`);
  // 投了は取り消せないので1クリックでは終わらない。
  const resign = await evaluate(page, `(async () => {
    const b = document.getElementById('btn-resign');
    b.click();
    await new Promise(r => setTimeout(r, 150));
    return { label: b.textContent, notOver: document.getElementById('panel').dataset.phase !== 'over' };
  })()`);
  check('投了は1回目のクリックでは確定しない',
    resign.notOver && resign.label !== '投了', `1回目のラベル: ${resign.label}`);
  // DOMを手で戻すと main.js 側の確認待ちが残ったままになり、次の1クリックで
  // 本当に投了してしまう。自前で戻るまで待つ。
  await evalUntil(page, 'document.getElementById("btn-resign").textContent', v => v === '投了', 6000);

  // 先手が人間なので、盤に駒が1枚も無い状態で自分の番になる
  check('盤が描かれている', await evaluate(page, 'document.querySelectorAll("sg-squares sq").length') === 81, '81マス');
  check('持ち駒が8種並んでいる',
    await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom sg-hp-wrap").length') === 8);
  check('玉が持ち駒にある（布石では玉も打つ）',
    await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.king").length') === 1);
  check('駒台が盤と同じ .sg-wrap の中にある（gridで盤の左右へ回すため）',
    await evaluate(page, 'document.querySelectorAll(".sg-wrap > sg-hand-wrap").length') === 2);
  // 駒はCSSの背景画像。URLが通っていても Content-Type が image/svg+xml でないと
  // ブラウザがデコードせず、要素は在るのに何も描かれない（盤が空に見える）。
  check('駒の画像がデコードできる', await evaluate(page, `(async () => {
    const piece = document.querySelector('sg-hand piece');
    if (!piece) return 'sg-hand piece が無い';
    const url = getComputedStyle(piece).backgroundImage.match(/url\\("?([^")]+)"?\\)/)?.[1];
    if (!url) return '背景画像が設定されていない';
    return await new Promise(r => {
      const img = new Image();
      img.onload = () => r(img.naturalWidth > 0);
      img.onerror = () => r('デコードできない: ' + url);
      img.src = url;
    });
  })()`) === true, '駒画像が image/svg+xml で配られているか');

  // 音は合成なので、鳴らないまま気づかない事故が起きやすい。
  // OfflineAudioContext で書き出して、無音でないことを数値で見る。
  const sound = await evaluate(page, `(async () => {
    const VOICES = window.__VOICES;
    if (!VOICES) return 'VOICES が公開されていない';
    const out = {};
    for (const name of Object.keys(VOICES)) {
      const ctx = new OfflineAudioContext(1, 44100 * 1.5, 44100);
      VOICES[name](ctx, 0);
      const buf = await ctx.startRendering();
      const d = buf.getChannelData(0);
      let peak = 0, sum = 0;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; }
      out[name] = { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4) };
    }
    return out;
  })()`);
  check('7種類の音がすべて無音でない',
    typeof sound === 'object' && Object.keys(sound).length === 7
      && Object.values(sound).every(v => v.peak > 0.02 && v.rms > 0.001),
    typeof sound === 'string' ? sound
      : Object.entries(sound).map(([k, v]) => `${k} peak=${v.peak}`).join(' / '));

  await layoutCheck('対局開始直後');

  // 盤の大きさ。広げたときにページごと横スクロールしないこと。
  const scale = await evaluate(page, `(async () => {
    const set = v => { const s = document.getElementById('opt-scale');
      s.value = String(v); s.dispatchEvent(new Event('input')); };
    const wait = () => new Promise(r => setTimeout(r, 200));
    const w = () => document.querySelector('sg-board').getBoundingClientRect().width;
    const over = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;
    set(70); await wait(); const small = w(), smallOver = over();
    set(115); await wait(); const big = w(), bigOver = over();
    set(100); await wait();
    return { small: +small.toFixed(1), big: +big.toFixed(1), smallOver, bigOver };
  })()`);
  // 盤の下端が画面の外に出ると、指すたびにスクロールすることになる。
  // 縦に余裕のある画面では起きないので、横長の画面に変えて見る。
  for (const [w, h] of [[1366, 768], [1280, 720], [1920, 1080], [1400, 900]]) {
    await page.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 250));
    const fits = await evaluate(page, `(() => {
      const r = document.querySelector('.board-column').getBoundingClientRect();
      return { bottom: +r.bottom.toFixed(0), viewport: innerHeight };
    })()`);
    check(`盤が画面の高さに収まる（${w}x${h}）`, fits.bottom <= fits.viewport,
      `盤の下端 ${fits.bottom}px / 画面 ${fits.viewport}px`);
    await layoutCheck(`${w}x${h}`);
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  await new Promise(r => setTimeout(r, 250));

  check('盤の大きさを変えても横スクロールが出ない',
    scale.small < scale.big && !scale.smallOver && !scale.bigOver,
    `70%=${scale.small}px / 115%=${scale.big}px`);

  // 狭い画面。盤は .board-column の負のmarginで画面幅いっぱいにしているので、
  // 盤の大きさを上げたときに横スクロールが出ないことを見る（430px幅で実際に出たことがある）。
  // 席の並びもここで見る。lishogiと同じで相手＝盤の上、自分＝盤の下。操作は盤のすぐ下。
  await page.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(r => setTimeout(r, 300));
  const narrow = await evaluate(page, `(async () => {
    const set = v => { const s = document.getElementById('opt-scale');
      s.value = String(v); s.dispatchEvent(new Event('input')); };
    const wait = () => new Promise(r => setTimeout(r, 250));
    const de = document.documentElement;
    const top = e => document.querySelector(e).getBoundingClientRect().top;
    set(115); await wait();
    const bigOver = de.scrollWidth > de.clientWidth;
    const colW = Math.round(document.querySelector('.board-column').getBoundingClientRect().width);
    const order = top('#seat-top') < top('.board-column') && top('.board-column') < top('#seat-bottom')
      && top('#seat-bottom') < top('#stepper') && top('#stepper') < top('#actions') && top('#actions') < top('#kifu');
    set(100); await wait();
    // 自分の席（時計）は初期表示に入っていること。秒読み中に見えないのは致命的。
    const seat = document.getElementById('seat-bottom').getBoundingClientRect();
    const seatVisible = seat.bottom <= innerHeight;
    return { bigOver, order, seatVisible, seatBottom: Math.round(seat.bottom), full: colW === de.clientWidth, colW, clientW: de.clientWidth };
  })()`);
  await shot('02-mobile');
  await page.send('Emulation.clearDeviceMetricsOverride');
  await new Promise(r => setTimeout(r, 250));
  check('狭い画面で盤を広げても横スクロールが出ない', !narrow.bigOver);
  check('狭い画面では席・盤・席・帯・操作・棋譜の順に積まれる', narrow.order);
  check('狭い画面で自分の席と時計が初期表示に入る', narrow.seatVisible, `席の下端 ${narrow.seatBottom}px / 画面 844px`);
  check('狭い画面では盤が画面幅いっぱい', narrow.full, `${narrow.colW}px / 画面 ${narrow.clientW}px`);

  // 成りダイアログは開くまでDOMに中身が無いので、器の配置だけ先に見る。
  // static のままだと、開いた瞬間に通常フローへ入って盤の高さが崩れる。
  check('成りダイアログが絶対配置',
    await evaluate(page, 'getComputedStyle(document.querySelector("sg-promotion")).position') === 'absolute');

  // 盤の反転。set({orientation}) では再ラップされず、マスのキーと駒台の色が古いまま残る。
  const senteBefore = await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.sente").length');
  await evaluate(page, 'document.getElementById("btn-flip").click()');
  const goteAfter = await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.gote").length');
  check('盤を反転すると手前の駒台が入れ替わる', senteBefore === 8 && goteAfter === 8, `前=${senteBefore} 後=${goteAfter}`);
  await layoutCheck('盤を反転');
  await evaluate(page, 'document.getElementById("btn-flip").click()');

  // 駒の絵は色ごとに向きが焼き込んである（1*.svg が180度回した側）。手前＝自分の駒が
  // 上を向いていないと自分の駒に見えない。
  const facing = () => evaluate(page, `(() => {
    const roles = ['pawn', 'lance', 'knight', 'silver', 'gold', 'bishop', 'rook', 'king',
      'tokin', 'promotedlance', 'promotedknight', 'promotedsilver', 'horse', 'dragon'];
    const wrap = document.querySelector('.sg-wrap');
    const near = wrap.classList.contains('orientation-gote') ? 'gote' : 'sente';
    const bad = [];
    for (const role of roles) for (const color of ['sente', 'gote']) {
      const el = document.createElement('piece');
      el.className = color + ' ' + role;
      el.style.cssText = 'position:absolute;width:1px;height:1px';
      wrap.appendChild(el);
      const url = getComputedStyle(el).backgroundImage;
      el.remove();
      const file = url.slice(url.lastIndexOf('/') + 1);
      if (file[0] !== (color === near ? '0' : '1')) bad.push(role + '/' + color + '=' + file);
    }
    return { near, bad };
  })()`);
  const facingSente = await facing();
  await evaluate(page, 'document.getElementById("btn-flip").click()');
  const facingGote = await facing();
  await evaluate(page, 'document.getElementById("btn-flip").click()');
  check('どちらの向きでも手前の駒が上を向く',
    facingSente.near === 'sente' && facingGote.near === 'gote'
    && facingSente.bad.length === 0 && facingGote.bad.length === 0,
    `先手向き ${facingSente.bad.join(' ') || 'ずれ無し'} / 後手向き ${facingGote.bad.join(' ') || 'ずれ無し'}`);

  const squareBoard = await evaluate(page, `(() => {
    const r = document.querySelector('sg-board').getBoundingClientRect();
    return Math.abs(r.width - r.height) < 2;
  })()`);
  check('盤が正方形のまま', squareBoard);

  // 評価ゲージは出入りしても盤の大きさと位置を動かしてはいけない。
  const gaugeShift = await evaluate(page, `(() => {
    const g = document.getElementById('eval-gauge');
    const r = () => { const b = document.querySelector('sg-board').getBoundingClientRect();
      return { w: +b.width.toFixed(1), x: +b.left.toFixed(1) }; };
    const was = g.hidden;
    g.hidden = true; const hidden = r(); const display = getComputedStyle(g).display;
    g.hidden = false; const shown = r();
    g.hidden = was;
    return { hidden, shown, display };
  })()`);
  check('評価ゲージの出入りで盤が動かない',
    Math.abs(gaugeShift.hidden.w - gaugeShift.shown.w) < 0.5
    && Math.abs(gaugeShift.hidden.x - gaugeShift.shown.x) < 0.5
    && gaugeShift.display !== 'none',
    `隠す ${gaugeShift.hidden.w}px@${gaugeShift.hidden.x} / 出す ${gaugeShift.shown.w}px@${gaugeShift.shown.x}`);

  // shogiground は合成イベントを弾く（drag.unwantedEvent が isTrusted を見る）。
  // 本物の入力として届くよう Input.dispatchMouseEvent を使う。
  await click(page, await center(page, 'sg-hand-wrap.hand-bottom piece.pawn'));
  const shown = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  check('駒台の歩を選ぶと打てるマスが光る', shown > 0, `${shown}マス`);

  await click(page, await center(page, 'sg-squares sq.dest'));

  const pieces = await evalUntil(page, 'document.querySelectorAll("sg-pieces piece").length', v => v >= 2, 30000);
  check('人間の1手目とAIの応手が盤に乗った', pieces >= 2, `盤上${pieces}枚`);
  const kifuTexts = await evaluate(page, '[...document.querySelectorAll("#kifu li .m")].map(e => e.textContent)');
  check('棋譜が2手ぶん出ている', kifuTexts.length >= 2, kifuTexts.join(' '));
  check('日本語版の棋譜は「▲７六歩打」の形', /^▲[１-９][一二三四五六七八九].打$/.test(kifuTexts[0] ?? ''), kifuTexts[0]);
  check('布石の段の進み具合が出る', await evaluate(page,
    `document.querySelector('#stepper .step.now .bar i')?.style.getPropertyValue('--p')`) === '5%');
  await shot('03-play');

  // 評価の表示。布石専用ネットは価値ヘッドを持たないので勝率が出せず、
  // undefined を素通しすると "NaN%" と出る（落ちないので気付けない）。
  // 対局中は形勢が見えないように既定で隠している。
  check('対局中は既定でAIの評価を隠している', await evaluate(page, `(() => {
    const row = document.getElementById('engine');
    return row.hidden && getComputedStyle(row).display === 'none';
  })()`) === true);
  const evalShown = await evaluate(page, `(() => {
    const c = document.getElementById('opt-show-eval');
    c.checked = true; c.dispatchEvent(new Event('change'));
    return { text: document.getElementById('readout-eval').textContent,
             hidden: document.getElementById('engine').hidden };
  })()`);
  check('評価の表示がNaNでない', !/NaN|undefined/.test(evalShown.text) && !evalShown.hidden,
    JSON.stringify(evalShown));
  await layoutCheck('評価を出した');
  await evaluate(page, `(() => { const c = document.getElementById('opt-show-eval'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);

  // ---- 棋譜をさかのぼる ----
  const nav = await evaluate(page, `(async () => {
    const wait = () => new Promise(r => setTimeout(r, 400));   // animation.duration=250ms より長く
    const count = () => document.querySelectorAll('sg-pieces piece:not(.fading)').length;
    const dests = () => document.querySelectorAll('sq.dest').length;
    const plies = document.querySelectorAll('#kifu li').length;
    if (plies < 2) return '棋譜が2手に満たない';
    const live = count();

    document.getElementById('nav-first').click(); await wait();
    const atFirst = count();
    const reviewing = document.getElementById('board').classList.contains('reviewing');
    const hp = document.querySelector('sg-hand-wrap.hand-bottom sg-hp-wrap:not([data-nb="0"]) piece');
    hp?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await wait();
    const destsWhileReviewing = dests();

    document.getElementById('nav-next').click(); await wait();
    const afterOne = count();

    document.getElementById('nav-last').click(); await wait();
    const backLive = count();
    return {
      live, atFirst, afterOne, backLive, reviewing, destsWhileReviewing,
      stillReviewing: document.getElementById('board').classList.contains('reviewing'),
      navNextDisabledAtLive: document.getElementById('nav-next').disabled,
    };
  })()`);
  check('最初の局面へ戻ると盤が空になる',
    typeof nav === 'object' && nav.atFirst === 0 && nav.reviewing === true,
    typeof nav === 'string' ? nav : `最初=${nav.atFirst}枚 / 対局中=${nav.live}枚`);
  check('1手進めると駒が1枚だけ増える', typeof nav === 'object' && nav.afterOne === 1);
  check('さかのぼっている間は駒を打てない',
    typeof nav === 'object' && nav.destsWhileReviewing === 0,
    typeof nav === 'object' ? `打てるマス=${nav.destsWhileReviewing}` : '');
  check('最新へ戻すと対局中の局面に戻る',
    typeof nav === 'object' && nav.backLive === nav.live && nav.stillReviewing === false
      && nav.navNextDisabledAtLive === true);

  // 局面の受け渡しのダイアログを開いても崩れない。
  await evaluate(page, 'document.getElementById("btn-io-open").click()');
  await layoutCheck('受け渡しダイアログを開いた');
  await evaluate(page, 'document.getElementById("io-dialog").close()');

  // 待った。自分の1手とAIの応手が消える。
  await click(page, await center(page, '#btn-undo'));
  await new Promise(r => setTimeout(r, 400));
  check('待ったで自分の手とAIの応手が消える',
    await evaluate(page, 'document.querySelectorAll("#kifu li").length') === 0);
  await layoutCheck('待った');

  check('未処理の例外が無い', exceptions().length === 0, exceptions().join(' / '));

  if (FULL) await playWholeGame(page);

  // ---- 布石フェーズの途中で投了する ----
  // phase が 'over' になるのに position は null のままで落ちていたことがある。
  const beforeResign = exceptions().length;
  await evaluate(page, `(() => { const b = document.getElementById('btn-resign'); b.click(); b.click(); })()`);
  await new Promise(r => setTimeout(r, 600));
  const afterResign = await evaluate(page, `({
    phase: document.getElementById('panel').dataset.phase,
    state: document.getElementById('panel').dataset.state,
    status: document.getElementById('status-line').textContent,
    againVisible: document.getElementById('btn-again').getBoundingClientRect().width > 0,
    allDone: [...document.querySelectorAll('#stepper .step')].every(s => !s.classList.contains('now')),
  })`);
  check('布石フェーズの途中で投了しても落ちない',
    exceptions().length === beforeResign && afterResign.phase === 'over' && afterResign.state === 'over'
      && afterResign.againVisible && afterResign.allDone,
    `${JSON.stringify(afterResign)} / 例外 ${exceptions().length - beforeResign} 件`);
  await layoutCheck('終局');
  await shot('04-over');

  // ---- 2局目 ----
  // 1局目で溜めた状態（棋譜・時計・音を鳴らした位置・さかのぼり位置）を
  // 落とし忘れると、2局目に持ち越される。押す場所が同じなので気づきにくい。
  const second = await (async () => {
    await click(page, await center(page, '#btn-again'));
    await evalUntil(page, 'document.getElementById("status-line").textContent',
      v => v && v.startsWith('あなたの番'), 30000);
    return evaluate(page, `({
      棋譜: document.querySelectorAll('#kifu li').length,
      盤上: document.querySelectorAll('sg-pieces piece:not(.fading)').length,
      時計上: document.getElementById('clock-top').textContent,
      時計下: document.getElementById('clock-bottom').textContent,
      さかのぼり中: document.getElementById('board').classList.contains('reviewing'),
      navFirst無効: document.getElementById('nav-first').disabled,
      投了の文言: document.getElementById('btn-resign').textContent,
      状態: document.getElementById('panel').dataset.state,
      持ち駒: document.querySelectorAll('sg-hand-wrap.hand-bottom sg-hp-wrap:not([data-nb="0"])').length,
    })`);
  })();
  check('2局目が前の対局を持ち越していない',
    second.棋譜 === 0 && second.盤上 === 0 && second.さかのぼり中 === false
      && second.navFirst無効 === true && second.投了の文言 === '投了'
      && second.状態 === 'play' && second.持ち駒 === 8
      // 人間側だけが持ち時間を持つ。AI側（上の席）は空で、席から時計が消える。
      && second.時計上 === '' && second.時計下 === '無制限',
    JSON.stringify(second));

  // ---- ホームへ戻る ----
  // 対局中にロゴを押すと確認が出る。戻ればホーム、やめれば対局に留まる。
  await evaluate(page, 'document.getElementById("logo").click()');
  await new Promise(r => setTimeout(r, 200));
  const leave1 = await evaluate(page, `({
    open: document.getElementById('leave-dialog').open,
    playVisible: !document.getElementById('view-play').hidden,
  })`);
  check('対局中にロゴを押すと確認が出る', leave1.open && leave1.playVisible, JSON.stringify(leave1));
  await evaluate(page, 'document.getElementById("btn-leave-cancel").click()');
  await new Promise(r => setTimeout(r, 200));
  check('「対局に戻る」で対局に留まり、URL が #play に戻る', await evaluate(page,
    '!document.getElementById("leave-dialog").open && !document.getElementById("view-play").hidden && location.hash === "#play"'));
  await evaluate(page, 'document.getElementById("logo").click()');
  await new Promise(r => setTimeout(r, 200));
  await evaluate(page, 'document.getElementById("btn-leave-ok").click()');
  await new Promise(r => setTimeout(r, 300));
  check('「やめてホームへ」でホームに戻り、対局が消える', await evaluate(page,
    '!document.getElementById("view-home").hidden && document.getElementById("view-play").hidden'
    + ' && document.getElementById("panel").dataset.state === "idle" && location.hash !== "#play"'));

  if (KINGS) await playKingsFirst(page);
  if (WATCH) await watchGame(page);
  if (ONLINE) await playOnline(cdp, page);

  await checkPages(page);
  await checkEnglish(page);
} finally {
  cdp.close();
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chromeが掴んだままでも実害は無い */ }
}

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);

// ---- パネルのレイアウト ----

/**
 * 右のパネルが崩れていないか。「いかなる操作をしても」は、操作のたびにこれを呼んで
 * はじめて言える。広い画面ではパネルの高さが盤の列と同じで、パネルの子はパネルの
 * 矩形の中に収まり、ページに横スクロールが無い。
 */
async function layoutCheck(label, pg = page) {
  const r = await evaluate(pg, `(() => {
    const panel = document.getElementById('panel'), col = document.querySelector('.board-column');
    const de = document.documentElement;
    const narrow = getComputedStyle(panel).display === 'contents';
    const p = panel.getBoundingClientRect(), c = col.getBoundingClientRect();
    // 棋譜の中身はスクロールするので見ない（枠だけ見る）。hidden の要素は幅0で外れる。
    const outside = [...panel.querySelectorAll('*')]
      .filter(e => !e.closest('.kifu') || e.classList.contains('kifu'))
      .filter(e => { const b = e.getBoundingClientRect();
        return b.width > 0 && (b.right > p.right + 1 || b.left < p.left - 1 || b.bottom > p.bottom + 1 || b.top < p.top - 1); })
      // SVG の className は文字列でない（{} と出て何か分からなかった）。属性で読む。
      .map(e => e.id || e.getAttribute('class') || e.tagName.toLowerCase()).slice(0, 5);
    return { narrow, dh: Math.round(p.height - c.height), hscroll: de.scrollWidth > de.clientWidth,
             outside: narrow ? [] : outside };
  })()`);
  check(`パネルが崩れていない（${label}）`,
    !r.hscroll && r.outside.length === 0 && (r.narrow || Math.abs(r.dh) <= 2), JSON.stringify(r));
}

async function shot(name) {
  if (!SHOTS) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

// ---- オンライン対局（--online） ----

/**
 * 友達と対局。タブAが部屋を作って招待リンクを出し、タブBがそのリンクを開いて参加する。
 * 部屋の側（worker/）は worker/test/room_smoke.mjs が見ているので、ここで見るのは
 * **画面と2つのブラウザの同期**: 待つ画面とリンク、参加の確認、席と時計、着手が相手に届くこと、
 * 読み込み直しで同じ席に戻ること、投了が相手に届くこと、終局後に検討できること。
 */
async function playOnline(cdp, pageA) {
  console.log('\n--- オンライン対局（--online）---');
  const errorsAtStart = exceptions().length;
  const alive = await fetch(`${ROOMS}/`).then(r => r.ok).catch(() => false);
  check('部屋の Worker（wrangler dev）が動いている', alive, `${ROOMS} — cd worker && npx wrangler dev --port 8787`);
  if (!alive) return;
  const builtFor = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8').includes(ROOMS.replace('127.0.0.1', 'localhost'))
    || fs.readFileSync(path.join(DIST, 'app.js'), 'utf8').includes(ROOMS);
  check('dist/ が手元の部屋の URL で作られている', builtFor, `node build.mjs --rooms ${ROOMS.replace('127.0.0.1', 'localhost')}`);
  if (!builtFor) return;
  const snap = pg => evaluate(pg, `({
    state: document.getElementById('panel').dataset.state ?? '',
    phase: document.getElementById('panel').dataset.phase ?? '',
    line: document.getElementById('status-line').textContent,
    sub: document.getElementById('status-sub').textContent,
    top: document.getElementById('seat-top-name').textContent,
    bottom: document.getElementById('seat-bottom-name').textContent,
    clockTop: document.getElementById('clock-top').textContent,
    clockBottom: document.getElementById('clock-bottom').textContent,
    kifu: [...document.querySelectorAll('#kifu li .m')].map(e => e.textContent),
    pieces: document.querySelectorAll('sg-pieces piece:not(.fading)').length,
    undoHidden: document.getElementById('btn-undo').hidden,
    hash: location.hash,
    again: document.getElementById('btn-again').textContent,
    evalHidden: document.getElementById('engine').hidden,
  })`);

  // ---- A: 部屋を作る（名前を名乗り、待合にも載せる） ----
  await evaluate(pageA, `(() => {
    const m = document.getElementById('mode-standard'); m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('opt-color').value = 'sente';
    document.getElementById('opt-time').value = '10m+30s';
    document.getElementById('opt-color').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('opp-lobby').click();   // 待合タブ＝公開の募集
    const nick = document.getElementById('opt-nick'); nick.value = '太郎'; nick.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  check('待合は最初は空で、その旨が書いてある', await evaluate(pageA,
    'document.querySelectorAll("#seeks li").length === 0 && document.getElementById("lobby-note").textContent.length > 0'));
  check('待合タブの「待合に出す」が押せる', await evaluate(pageA,
    'document.getElementById("btn-invite").disabled === false && document.getElementById("btn-invite").textContent === "待合に出す"'));
  await click(pageA, await center(pageA, '#btn-invite'));
  const link = await evalUntil(pageA, 'document.getElementById("wait-link").value', v => /#room\/[a-z2-9]{8}$/.test(v || ''), 15000);
  let a = await snap(pageA);
  check('招待を押すと部屋ができ、待つ画面に招待リンクが出る',
    /#room\/[a-z2-9]{8}$/.test(link || '') && a.state === 'wait' && a.line === '相手を待っている' && a.hash === link.slice(link.indexOf('#')),
    `${a.state} / ${a.line} / ${link}`);
  check('待っているあいだは盤に触れない（打てるマスが無い）', await evaluate(pageA, `(async () => {
    const p = document.querySelector('sg-hand-wrap.hand-bottom piece.pawn');
    p?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await new Promise(r => setTimeout(r, 200));
    return document.querySelectorAll('sq.dest').length;
  })()`) === 0);
  check('待合に載せた部屋は、待つ画面にその旨が出る', (await evaluate(pageA, 'document.getElementById("wait-note").textContent')).length > 0);
  await layoutCheck('相手を待つ', pageA);
  await shot('10-online-wait');

  // ---- B: 待合から参加する ----
  // 別のブラウザ文脈で開く。同じ文脈だと localStorage を共有して、Bが host の席のトークンで
  // 同じ席に戻ってしまう（実際にそうなった）。相手は別の端末、という前提を作る。
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const targetB = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const pageB = await cdp.attach(targetB.targetId);
  pageB.on('Runtime.consoleAPICalled', e => logs.push('[B] ' + e.args.map(x => x.value ?? x.description).join(' ')));
  pageB.on('Runtime.exceptionThrown', e => logs.push('EXCEPTION [B] ' + (e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)));
  await pageB.send('Runtime.enable');
  await pageB.send('Page.enable');
  await pageB.send('Page.navigate', { url: link.slice(0, link.indexOf('#')) });
  // 別の人は初めて来た体なので AI タブで開く。待合の札に募集の数が出て、タブを押すと一覧が出る。
  await evalUntil(pageB, 'document.readyState', v => v === 'complete', 15000);
  const badge = await evalUntil(pageB, `(() => { const b = document.getElementById('lobby-count'); return b && !b.hidden ? b.textContent : null; })()`, v => v === '1', 20000);
  check('AIタブに居ても、待合タブの札に募集の数が出る', badge === '1', String(badge));
  check('#lobby で開くと待合タブになる', await evaluate(pageB, `(() => {
    location.hash = '#lobby';
    return new Promise(r => setTimeout(() => r(document.getElementById('opp-lobby').getAttribute('aria-selected') === 'true' && location.hash === '#/'), 200));
  })()`));
  const seek = await evalUntil(pageB, `(() => {
    const li = document.querySelector('#seeks li');
    return li ? { who: li.querySelector('.seek-who').textContent, info: li.querySelector('.seek-info').textContent, n: document.querySelectorAll('#seeks li').length } : null;
  })()`, v => !!v, 20000);
  check('別の人のホームの待合に、名前と何の対局か（あなたは後手）が載る',
    seek && seek.who === '太郎' && seek.info.includes('布石将棋') && seek.info.includes('10分＋30秒') && seek.info.includes('後手') && seek.n === 1,
    JSON.stringify(seek));
  check('自分の募集は自分の待合には出ない', await evaluate(pageA, 'document.querySelectorAll("#seeks li").length') === 0);
  // 参加はエンジンが起きてから押せる。
  await evalUntil(pageB, 'document.querySelector("#seeks li button")?.disabled', v => v === false, 120000);
  await click(pageB, await center(pageB, '#seeks li button'));
  const joinOpen = await evalUntil(pageB, 'document.getElementById("join-dialog").open', v => v === true, 20000);
  const join = await evaluate(pageB, `({
    title: document.getElementById('join-title').textContent,
    body: document.getElementById('join-body').textContent,
    eyebrow: document.querySelector('#join-dialog .join-eyebrow').textContent,
    homeShown: !document.getElementById('view-home').hidden,
  })`);
  check('待合の「参加」で確認が出て、誰からの招待で、何の対局でどちらを持つかが書いてある',
    joinOpen === true && join.title === '布石将棋' && join.eyebrow === '太郎からの招待' && join.body.includes('10分＋30秒') && join.body.includes('後手') && join.homeShown,
    JSON.stringify(join));
  const joinReady = await evalUntil(pageB, 'document.getElementById("btn-join-ok").disabled', v => v === false, 120000);
  check('エンジンが起きると参加が押せる', joinReady === false);
  await click(pageB, await center(pageB, '#btn-join-ok'));
  await evalUntil(pageA, 'document.getElementById("panel").dataset.state', v => v === 'play', 15000);
  await evalUntil(pageB, 'document.getElementById("panel").dataset.state', v => v === 'play', 15000);
  a = await snap(pageA);
  let b = await snap(pageB);
  check('両者が揃うと始まり、Aは先手で自分の番、Bは後手で相手の番。名乗った名前が相手の席に出る',
    a.line.startsWith('あなたの番') && a.bottom === 'あなた · 先手 ☗' && a.top === '相手 · 後手 ☖'
    && b.line === '相手の番。' && b.bottom === 'あなた · 後手 ☖' && b.top === '太郎 · 先手 ☗',
    `A: ${a.line} / ${a.bottom} / ${a.top} — B: ${b.line} / ${b.bottom} / ${b.top}`);
  check('待合から相手が来た募集は消える', await evalUntil(pageA, 'document.querySelectorAll("#seeks li").length', v => v === 0, 5000) === 0);
  check('オンラインでは「待ったを頼む」「引き分けを提案」が出て、まだ指していない側の待ったは押せない', await evaluate(pageA, `(() => {
    const tb = document.getElementById('btn-takeback'), dr = document.getElementById('btn-draw');
    return !tb.hidden && !dr.hidden && tb.disabled && !dr.disabled;
  })()`));
  check('両方の席に時計が出る（10分）', a.clockTop === '10:00' && a.clockBottom.startsWith('9:5') || a.clockBottom === '10:00',
    `A: ${a.clockBottom} / ${a.clockTop}`);
  check('オンラインでは待ったが無く、URL は部屋のもの', a.undoHidden && b.undoHidden && a.hash === b.hash && a.hash.startsWith('#room/'));
  check('Bの盤は後手向き（手前が自分）', await evaluate(pageB, 'document.querySelector(".sg-wrap").classList.contains("orientation-gote")'));
  await layoutCheck('オンラインの対局中', pageA);
  await layoutCheck('オンラインの対局中（B）', pageB);

  // ---- 着手が相手に届く ----
  await click(pageA, await center(pageA, 'sg-hand-wrap.hand-bottom piece.pawn'));
  await evalUntil(pageA, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  await click(pageA, await center(pageA, 'sg-squares sq.dest'));
  const kifuB = await evalUntil(pageB, 'document.querySelectorAll("#kifu li").length', v => v >= 1, 10000);
  b = await snap(pageB);
  check('Aの1手目がBの盤と棋譜に届き、Bの番になる', kifuB === 1 && b.pieces === 1 && b.line.startsWith('あなたの番'),
    `棋譜${kifuB} / 盤上${b.pieces} / ${b.line}`);
  await click(pageB, await center(pageB, 'sg-hand-wrap.hand-bottom piece.pawn'));
  await evalUntil(pageB, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  await click(pageB, await center(pageB, 'sg-squares sq.dest'));
  const kifuA = await evalUntil(pageA, 'document.querySelectorAll("#kifu li").length', v => v >= 2, 10000);
  a = await snap(pageA);
  b = await snap(pageB);
  check('Bの応手がAに届き、Aの番に戻る。棋譜は両方で同じ', kifuA === 2 && a.line.startsWith('あなたの番') && a.kifu.join(' ') === b.kifu.join(' '),
    `A: ${a.kifu.join(' ')} / B: ${b.kifu.join(' ')}`);
  check('対局中はAIの評価を出さない（設定に関わらず）', await evaluate(pageA, `(() => {
    const c = document.getElementById('opt-show-eval'); c.checked = true; c.dispatchEvent(new Event('change'));
    const hidden = document.getElementById('engine').hidden;
    c.checked = false; c.dispatchEvent(new Event('change'));
    return hidden;
  })()`) === true);
  await shot('11-online-play');

  // ---- 読み込み直しで同じ席に戻る ----
  // 読み込み直しの前の文書に印を付け、新しい文書になるまで待つ。印が残ったまま古い文書を
  // 見ると、state が play のままで検査が素通りし、次の snap が読み込み中の文書を見る（実際に起きた）。
  await evaluate(pageB, 'window.__before_reload = true');
  await pageB.send('Page.reload');
  await evalUntil(pageB, 'window.__before_reload === undefined && document.readyState === "complete"', v => v === true, 30000);
  await evalUntil(pageB, 'document.getElementById("panel")?.dataset.state', v => v === 'play', 120000);
  await evalUntil(pageB, 'document.querySelectorAll("#kifu li").length', v => v >= 2, 15000);
  b = await snap(pageB);
  check('Bを読み込み直しても確認なしに同じ席へ戻り、手順が2手ぶん復元される',
    b.kifu.length === 2 && b.bottom === 'あなた · 後手 ☖' && b.pieces === 2 && b.line === '相手の番。' && !(await evaluate(pageB, 'document.getElementById("join-dialog").open')),
    `${b.kifu.join(' ')} / ${b.bottom} / ${b.line} / ${b.hash} / ${await evaluate(pageB, 'document.getElementById("status-sub").textContent')}`);

  await evalUntil(pageA, 'document.getElementById("status-sub").textContent', v => !v.includes('つなぎ直') && !v.includes('切れた'), 10000);

  // ---- 観戦: 3人目が同じリンクを開く ----
  const ctxC = await cdp.send('Target.createBrowserContext');
  const targetC = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxC.browserContextId });
  const pageC = await cdp.attach(targetC.targetId);
  pageC.on('Runtime.exceptionThrown', e => logs.push('EXCEPTION [C] ' + (e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)));
  await pageC.send('Runtime.enable');
  await pageC.send('Page.enable');
  await pageC.send('Page.navigate', { url: link });
  await evalUntil(pageC, 'document.getElementById("join-dialog").open', v => v === true, 20000);
  const joinC = await evaluate(pageC, `({ ok: document.getElementById('btn-join-ok').textContent, note: document.getElementById('join-note').textContent })`);
  check('席が埋まった部屋のリンクを開くと「観戦する」になる', joinC.ok === '観戦する' && joinC.note.includes('観戦'), JSON.stringify(joinC));
  await evalUntil(pageC, 'document.getElementById("btn-join-ok").disabled', v => v === false, 120000);
  await click(pageC, await center(pageC, '#btn-join-ok'));
  await evalUntil(pageC, 'document.querySelectorAll("#kifu li").length', v => v >= 2, 15000);
  const c = await snap(pageC);
  check('観戦は手順が揃い、席に名前（無名は名無し）が出て、投了も待ったも無い',
    c.kifu.length === 2 && c.line === '観戦中' && c.top === '名無し · 後手 ☖' && c.bottom === '太郎 · 先手 ☗'
    && (await evaluate(pageC, 'document.getElementById("btn-resign").hidden && document.getElementById("btn-takeback").hidden && document.getElementById("btn-undo").hidden')),
    `${c.line} / ${c.top} / ${c.bottom} / ${c.kifu.join(' ')}`);
  check('観戦中は評価を出さない', c.evalHidden === true);
  await layoutCheck('観戦', pageC);
  await shot('14-online-watch');

  // ---- 待った: Bが頼み、Aが受ける ----
  await click(pageB, await center(pageB, '#btn-takeback'));
  const offerA = await evalUntil(pageA, 'document.getElementById("offer-row").hidden', v => v === false, 10000);
  const offerText = await evaluate(pageA, 'document.getElementById("offer-text").textContent');
  check('待ったの申し出が相手に出る（誰が、どこまで戻すか）', offerA === false && offerText.includes('待った') && offerText.includes('1手目'), offerText);
  check('頼んだ側は返事を待っていると言う', (await snap(pageB)).sub.includes('待ったを頼んだ'));
  await click(pageA, await center(pageA, '#btn-offer-accept'));
  await evalUntil(pageB, 'document.querySelectorAll("#kifu li").length', v => v === 1, 10000);
  a = await snap(pageA); b = await snap(pageB);
  check('受けると両方の棋譜が1手に戻り、Bの番になる', a.kifu.length === 1 && b.kifu.length === 1 && b.line.startsWith('あなたの番') && a.line === '相手の番。',
    `A: ${a.kifu.join(' ')} / ${a.line} — B: ${b.kifu.join(' ')} / ${b.line}`);
  check('観戦にも戻りが届く', await evalUntil(pageC, 'document.querySelectorAll("#kifu li").length', v => v === 1, 10000) === 1);
  // 指し直してから、引き分けを断る・受ける。
  await click(pageB, await center(pageB, 'sg-hand-wrap.hand-bottom piece.pawn'));
  await evalUntil(pageB, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  await click(pageB, await center(pageB, 'sg-squares sq.dest'));
  await evalUntil(pageA, 'document.querySelectorAll("#kifu li").length', v => v === 2, 10000);
  await click(pageA, await center(pageA, '#btn-draw'));
  await evalUntil(pageB, 'document.getElementById("offer-row").hidden', v => v === false, 10000);
  check('引き分けの提案が相手に出る', (await evaluate(pageB, 'document.getElementById("offer-text").textContent')).includes('引き分け'));
  await click(pageB, await center(pageB, '#btn-offer-decline'));
  const declined = await evalUntil(pageA, 'document.getElementById("status-sub").textContent', v => v.includes('断った'), 10000);
  check('断ると提案した側に伝わる', String(declined).includes('引き分けを断った'), String(declined));
  await click(pageA, await center(pageA, '#btn-draw'));
  await evalUntil(pageB, 'document.getElementById("offer-row").hidden', v => v === false, 10000);
  await click(pageB, await center(pageB, '#btn-offer-accept'));
  await evalUntil(pageA, 'document.getElementById("panel").dataset.phase', v => v === 'over', 10000);
  a = await snap(pageA);
  b = await snap(pageB);
  check('受けると合意の引き分けで終わる（両方）',
    a.line === '引き分け' && a.sub === '合意の引き分け' && b.line === '引き分け' && b.sub === '合意の引き分け',
    `A: ${a.line} / ${a.sub} — B: ${b.line} / ${b.sub}`);
  check('観戦にも終局が届く', await evalUntil(pageC, 'document.getElementById("panel").dataset.phase', v => v === 'over', 10000) === 'over');
  await cdp.send('Target.closeTarget', { targetId: targetC.targetId });
  await cdp.send('Target.disposeBrowserContext', { browserContextId: ctxC.browserContextId }).catch(() => {});
  check('終局後の行き先は「ホームへ」（相手が要るので、もう一局はしない）', a.again === 'ホームへ' && b.again === 'ホームへ');
  await evaluate(pageA, 'document.getElementById("btn-analyze").click()');
  await evalUntil(pageA, 'document.getElementById("panel").dataset.state', v => v === 'analyze', 5000);
  check('オンラインの対局も終局後に検討できる', (await snap(pageA)).state === 'analyze');
  await layoutCheck('オンラインの終局', pageA);
  await shot('12-online-over');
  await evaluate(pageA, 'document.getElementById("btn-analyze-end").click()');

  // ---- 天秤将棋: 置く役と選ぶ役が別のタブ ----
  await click(pageA, await center(pageA, '#btn-again'));   // ホームへ
  await evalUntil(pageA, 'document.getElementById("view-home").hidden', v => v === false, 5000);
  await evaluate(pageA, `(() => {
    const m = document.getElementById('mode-kings'); m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('opt-role').value = 'placer';
    document.getElementById('opt-time').value = 'none';
  })()`);
  await click(pageA, await center(pageA, '#btn-invite'));
  const link2 = await evalUntil(pageA, 'document.getElementById("wait-link").value', v => /#room\/[a-z2-9]{8}$/.test(v || '') && v !== link, 15000);
  await pageB.send('Page.navigate', { url: link2 });
  await evalUntil(pageB, 'document.getElementById("join-dialog").open', v => v === true, 20000);
  const join2 = await evaluate(pageB, 'document.getElementById("join-title").textContent + " / " + document.getElementById("join-body").textContent');
  check('天秤将棋の招待では、参加する側の役が書いてある', join2.startsWith('天秤将棋') && join2.includes('先後を選ぶ') && join2.includes('無制限'), join2);
  await evalUntil(pageB, 'document.getElementById("btn-join-ok").disabled', v => v === false, 120000);
  await click(pageB, await center(pageB, '#btn-join-ok'));
  await evalUntil(pageA, 'document.getElementById("status-line").textContent', v => v.startsWith('あなたが両玉を置く'), 15000);
  b = await snap(pageB);
  check('Aが両玉を置く番で、Bは相手が置くのを待つ（自分が選ぶ役だと言う）',
    b.line === '相手が両玉を置いている…' && b.sub.startsWith('あなたが先後を選ぶ'), `${b.line} / ${b.sub}`);
  check('無制限の対局は両方の席が「無制限」', b.clockTop === '無制限' && b.clockBottom === '無制限', `${b.clockTop} / ${b.clockBottom}`);
  for (const hand of ['hand-bottom', 'hand-top']) {
    await click(pageA, await center(pageA, `sg-hand-wrap.${hand} piece.king`));
    await evalUntil(pageA, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
    await click(pageA, await center(pageA, 'sg-squares sq.dest'));
    await new Promise(r => setTimeout(r, 400));
  }
  await evalUntil(pageB, 'document.getElementById("panel").dataset.state', v => v === 'choose', 10000);
  b = await snap(pageB);
  check('両玉が置かれるとBが先後を選ぶ番になり、両玉がBの盤にある', b.state === 'choose' && b.pieces === 2 && b.line.startsWith('どちらの玉で指すか'), `${b.state} / ${b.pieces} / ${b.line}`);
  a = await snap(pageA);
  check('Aは相手が選ぶのを待つ', a.line === '相手が先後を選んでいる…', a.line);
  await click(pageB, await center(pageB, '#btn-choose-gote'));
  await evalUntil(pageB, 'document.getElementById("btn-choose-confirm").disabled', v => v === false, 5000);
  await click(pageB, await center(pageB, '#btn-choose-confirm'));
  await evalUntil(pageA, 'document.getElementById("status-line").textContent', v => v.startsWith('あなたの番'), 10000);
  a = await snap(pageA);
  b = await snap(pageB);
  check('Bが後手を持つとAが先手で3手目の番。席の札と見出しに相手が出る',
    a.bottom === 'あなた · 先手 ☗' && a.top === '相手 · 後手 ☖' && a.kifu[2] === '△後手を持つ'
    && b.bottom === 'あなた · 後手 ☖' && b.line === '相手の番。'
    && (await evaluate(pageA, 'document.getElementById("kifu-head").textContent')) === 'あなたが両玉を置き、相手が後手 ☖を持った',
    `A: ${a.bottom} / ${a.top} / ${a.kifu.join(' ')} — B: ${b.bottom} / ${b.line}`);
  await layoutCheck('天秤将棋（オンライン）', pageA);
  await shot('13-online-kings');
  // 片付け。Aが投了して両方ホームへ。
  await evaluate(pageA, `(() => { const r = document.getElementById('btn-resign'); r.click(); r.click(); })()`);
  await evalUntil(pageB, 'document.getElementById("panel").dataset.phase', v => v === 'over', 10000);
  b = await snap(pageB);
  check('先後が決まった後の投了は色で言う', b.line === '後手 ☖の勝ち（あなた）' && b.sub === '相手の投了', `${b.line} / ${b.sub}`);
  await cdp.send('Target.closeTarget', { targetId: targetB.targetId });
  await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  await click(pageA, await center(pageA, '#btn-again'));
  await evalUntil(pageA, 'document.getElementById("view-home").hidden', v => v === false, 5000);
  check('ホームへ戻ると最後に使ったタブ（待合）のまま',
    await evaluate(pageA, 'document.getElementById("opp-lobby").getAttribute("aria-selected")') === 'true');
  // 後の検査（英語版）は AI タブで始めたいので戻しておく。タブは localStorage に残る。
  await click(pageA, await center(pageA, '#opp-ai'));
  check('オンライン対局で未処理の例外が無い', exceptions().length === errorsAtStart, exceptions().slice(errorsAtStart).join(' / '));
}

// ---- 天秤将棋（--kings-first） ----

/**
 * 天秤将棋を実ブラウザで通す。選ぶ役（AIが両玉を置き、人間が盤の玉を押して確定する）と
 * 置く役（人間が先手玉・後手玉を順に置き、AIが先後を選ぶ）の両方。
 * game.js の状態機械は test/kings_first_test.mjs が見ているので、ここで見るのは
 * **画面にしか無いもの**: 玉の札と輪、押した玉で盤が回ること、二段の確定、
 * 席の名前が選択で決まること、後手の駒台の玉を人間が打てること。
 */
async function playKingsFirst(page) {
  console.log('\n--- 天秤将棋（--kings-first）---');
  const errorsAtStart = exceptions().length;
  const status = () => evaluate(page, `({
    line: document.getElementById('status-line').textContent,
    sub: document.getElementById('status-sub').textContent,
    phase: document.getElementById('panel').dataset.phase,
    state: document.getElementById('panel').dataset.state,
    top: document.getElementById('seat-top-name').textContent,
    bottom: document.getElementById('seat-bottom-name').textContent,
    kifu: [...document.querySelectorAll('#kifu li .m')].map(e => e.textContent),
    pieces: document.querySelectorAll('sg-pieces piece:not(.fading)').length,
    undo: !document.getElementById('btn-undo').disabled,
    confirm: document.getElementById('btn-choose-confirm').textContent,
    confirmEnabled: !document.getElementById('btn-choose-confirm').disabled,
    tags: document.querySelectorAll('#king-tags .king-label').length,
    gote: document.querySelector('.sg-wrap').classList.contains('orientation-gote'),
    steps: [...document.querySelectorAll('#stepper .step')].map(s => s.className.replace('step ', '')),
    roleTop: document.getElementById('seat-top-role').hidden ? null : document.getElementById('seat-top-role').textContent,
    roleBottom: document.getElementById('seat-bottom-role').hidden ? null : document.getElementById('seat-bottom-role').textContent,
    head: document.getElementById('kifu-head').hidden ? null : document.getElementById('kifu-head').textContent,
  })`);
  // ホームに居る。ルールを天秤将棋、役を「先後を選ぶ」にして始める。
  await evaluate(page, `(() => {
    const m = document.getElementById('mode-kings'); m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('opt-role').value = 'chooser';
  })()`);
  check('ルールを天秤将棋にすると「手番」が消えて「役」が出る', await evaluate(page,
    'document.getElementById("lbl-color").hidden && !document.getElementById("lbl-role").hidden'
    + ' && getComputedStyle(document.getElementById("lbl-color")).display === "none"'));
  // AIが両玉を置くのは表引きで一瞬なので、その間の状態欄は後から観測できない。
  // 状態欄の書き換えを記録しておき、玉を置く段のあいだに何と言ったかを見る。
  await evaluate(page, `(() => {
    window.__subs = [];
    const sub = document.getElementById('status-sub'), panel = document.getElementById('panel');
    new MutationObserver(() => window.__subs.push([panel.dataset.phase, sub.textContent]))
      .observe(sub, { childList: true, characterData: true, subtree: true });
  })()`);
  await click(page, await center(page, '#btn-new'));
  await evalUntil(page, 'document.getElementById("panel").dataset.state', v => v === 'choose', 30000);
  let s = await status();
  check('AIが両玉を置くと先後を選ぶ番になり、両玉に札が付く',
    s.state === 'choose' && s.pieces === 2 && s.tags === 2 && s.phase === 'choose',
    `${s.state} / 盤上${s.pieces}枚 / 札${s.tags} / ${s.line}`);
  const subsSeen = await evaluate(page, 'window.__subs');
  check('AIが両玉を置いている間、状態欄が「あなたが先後を選ぶ」と言う',
    subsSeen.some(([ph, text]) => ph === 'kings' && text.startsWith('あなたが先後を選ぶ')),
    JSON.stringify(subsSeen));
  check('先後が決まる前は席に札が無く、棋譜の見出しは誰が置き誰が選ぶかだけ',
    s.roleTop === null && s.roleBottom === null && s.head === 'AIが両玉を置き、あなたが先後を選ぶ', `${s.head}`);
  check('フェーズ帯が4段で、先後を選ぶ段が今', s.steps.length === 4 && s.steps[1].includes('now') && s.steps[0].includes('done'),
    s.steps.join(' | '));
  check('選ぶ前は席に「あなた」が無く、確定は押せない',
    !s.top.includes('あなた') && !s.bottom.includes('あなた') && !s.confirmEnabled, `${s.top} / ${s.bottom}`);
  await layoutCheck('先後を選ぶ番');
  await shot('05-choose');

  // 盤の後手玉を押す（実マウス）。盤が後手向きに回り、確定ボタンに後手が入る。
  await piecesSettled(page);
  await click(page, await center(page, 'sg-pieces piece.gote.king'));
  await evalUntil(page, 'document.getElementById("btn-choose-confirm").disabled', v => v === false, 5000);
  s = await status();
  check('後手玉を押すと盤が回って手前が後手になり、確定ボタンに後手が入る',
    s.gote && s.confirmEnabled && s.confirm.includes('後手') && s.bottom.includes('あなた（仮）'),
    `${s.confirm} / ${s.bottom} / gote=${s.gote}`);
  check('押した玉の札が強調される', await evaluate(page,
    'document.querySelectorAll("#king-tags .king-label.pending").length') === 1);
  await layoutCheck('玉を押した');
  await shot('06-choose-pending');
  // もう一方の玉を押すと入れ替わる。
  await click(page, await center(page, 'sg-pieces piece.sente.king'));
  await evalUntil(page, 'document.getElementById("btn-choose-confirm").textContent', v => v.includes('先手'), 5000);
  s = await status();
  check('先手玉を押すと入れ替わり、盤が先手向きに戻る', !s.gote && s.confirm.includes('先手'), `${s.confirm} / gote=${s.gote}`);
  // 戻して後手で確定。
  await click(page, await center(page, 'sg-pieces piece.gote.king'));
  await evalUntil(page, 'document.getElementById("btn-choose-confirm").textContent', v => v.includes('後手'), 5000);
  await click(page, await center(page, '#btn-choose-confirm'));
  await evalUntil(page, 'document.getElementById("status-line").textContent',
    v => v && v.startsWith('あなたの番'), 30000);
  s = await status();
  check('後手を持って始めると自分が後手になり、盤が回って手前が後手',
    s.bottom === 'あなた · 後手 ☖' && s.top.startsWith('AI レベル') && s.top.endsWith('☗') && s.gote,
    `${s.top} / ${s.bottom}`);
  check('選択が棋譜に1行入り、AIの3手目が続く', s.kifu.length === 4 && s.kifu[2] === '△後手を持つ'
    && s.state === 'play' && s.tags === 0, s.kifu.join(' '));
  check('先後が決まると席に札が付く（手前のあなたが先後を選ぶ、向こうのAIが玉を置く）',
    s.roleBottom === '先後を選ぶ' && s.roleTop === '玉を置く', `${s.roleTop} / ${s.roleBottom}`);
  check('棋譜の見出しに誰が置き、誰がどちらを持ったかが出る',
    s.head === 'AIが両玉を置き、あなたが後手 ☖を持った', `${s.head}`);
  check('役の札が席の1行に収まる', await evaluate(page, `(() => {
    const seat = document.getElementById('seat-bottom'), chip = document.getElementById('seat-bottom-role');
    return chip.getBoundingClientRect().height < seat.getBoundingClientRect().height - 4
      && Math.abs(chip.getBoundingClientRect().top - document.getElementById('seat-bottom-name').getBoundingClientRect().top) < 8; })()`));
  check('帯の「先後を選ぶ」段に結果が残る（副題は側、誰が選んだかは title）', await evaluate(page,
    `(() => { const s = document.querySelectorAll("#stepper .step")[1];
      return s.textContent.includes('後手') && s.title.includes('あなた') && s.title.includes('後手'); })()`));
  // 4段の帯で段名が語の途中で折れない（「先後を選／ぶ」になっていた）。1行の高さに収まること。
  check('4段の帯の段名が1行に収まり、切れてもいない', await evaluate(page, `(() => {
    const ts = [...document.querySelectorAll('#stepper .step .t')];
    return ts.every(e => e.getBoundingClientRect().height < parseFloat(getComputedStyle(e).lineHeight) * 1.5
      && e.scrollWidth <= e.clientWidth + 1);
  })()`), await evaluate(page, `[...document.querySelectorAll('#stepper .step .t')].map(e => e.scrollWidth + '/' + e.clientWidth).join(' ')`));
  check('後手の駒台から打てる', await evaluate(page,
    'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.gote").length') === 8);
  await layoutCheck('先後が決まった');

  // 待ったで選択より前へ戻る。AIの3手目も自分の選択も消え、選ぶ番に戻る。
  await click(page, await center(page, '#btn-undo'));
  await evalUntil(page, 'document.getElementById("panel").dataset.state', v => v === 'choose', 10000);
  s = await status();
  check('待ったで選択まで戻ると選ぶ番に戻り、席から「あなた」が消える',
    s.state === 'choose' && s.kifu.length === 2 && !s.bottom.includes('あなた') && s.tags === 2 && !s.confirmEnabled,
    `${s.kifu.join(' ')} / ${s.bottom}`);
  // キーボード向けのボタンでも同じ二段になる。
  await click(page, await center(page, '#btn-choose-sente'));
  await evalUntil(page, 'document.getElementById("btn-choose-confirm").disabled', v => v === false, 5000);
  await click(page, await center(page, '#btn-choose-confirm'));
  await evalUntil(page, 'document.getElementById("status-line").textContent',
    v => v && v.startsWith('あなたの番'), 30000);
  s = await status();
  check('ボタンで先手を持つと自分が先手で、3手目は自分の番', s.bottom === 'あなた · 先手 ☗'
    && s.kifu.length === 3 && s.kifu[2] === '▲先手を持つ', `${s.bottom} / ${s.kifu.join(' ')}`);
  const sfen3 = await evaluate(page, `(() => {
    document.getElementById('btn-io-open').click();
    const v = document.getElementById('io-sfen').value;
    document.getElementById('io-dialog').close();
    return v;
  })()`);
  check('選択の後のSFENは3手目・先手番', String(sfen3).includes(' b 3'), sfen3);

  // ---- 玉を置く ----
  await evaluate(page, `(() => { const b = document.getElementById('btn-resign'); b.click(); b.click(); })()`);
  await evalUntil(page, 'document.getElementById("panel").dataset.phase', v => v === 'over', 10000);
  const note = await evaluate(page, 'document.getElementById("result-note").textContent');
  check('終局後に誰が両玉を置き、誰が先手を持ったか、表の値が出る',
    /^AIが両玉 [１-９][一二三四五六七八九]・[１-９][一二三四五六七八九] を置き、あなたが/.test(note) && /見立て 先手 \d+\.\d%/.test(note), note);
  await shot('07-kings-over');
  await evaluate(page, 'document.getElementById("logo").click()');   // 終局後なので確認は出ない
  await evalUntil(page, 'document.getElementById("view-home").hidden', v => v === false, 5000);
  await evaluate(page, `(() => { document.getElementById('opt-role').value = 'placer'; })()`);
  await click(page, await center(page, '#btn-new'));
  await evalUntil(page, 'document.getElementById("status-line").textContent',
    v => v && v.startsWith('あなたが両玉を置く'), 30000);
  // 玉以外は選べない（実マウスで押す。合成イベントは shogiground が弾く）。
  await click(page, await center(page, 'sg-hand-wrap.hand-bottom piece.pawn'));
  await new Promise(r => setTimeout(r, 300));
  check('1手目は玉以外を選べない',
    await evaluate(page, 'document.querySelectorAll("sq.dest").length') === 0);
  check('玉を置く番は駒台の玉以外が薄い', await evaluate(page,
    'parseFloat(getComputedStyle(document.querySelector("sg-hand-wrap.hand-bottom sg-hp-wrap:has(piece.pawn)")).opacity) < 0.5'));
  await click(page, await center(page, 'sg-hand-wrap.hand-bottom piece.king'));
  const kingDests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  check('1手目は先手玉で、先手陣36マス', kingDests === 36, `${kingDests}マス`);
  await click(page, await center(page, 'sg-squares sq.dest'));
  await evalUntil(page, 'document.getElementById("status-line").textContent',
    v => v && v.startsWith('次に後手玉'), 10000);
  // 2手目は相手（上）の駒台の玉。自分の色に関わらず置ける。
  await click(page, await center(page, 'sg-hand-wrap.hand-top piece.king'));
  const goteDests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  check('2手目は後手の駒台の玉を後手陣36マスへ', goteDests === 36, `${goteDests}マス`);
  await click(page, await center(page, 'sg-squares sq.dest'));
  await evalUntil(page, 'document.getElementById("status-line").textContent',
    v => v && v.startsWith('あなたの番'), 30000);
  s = await status();
  check('AIが先後を選ぶと自分の色が決まり、案内にAIの選択が出る',
    s.bottom.startsWith('あなた') && /AIが(先手 ☗|後手 ☖)を持った/.test(s.sub) && s.kifu.length >= 3
    && s.kifu[2].endsWith('を持つ'), `${s.bottom} / ${s.sub} / ${s.kifu.slice(0, 4).join(' ')}`);
  check('玉を置いたときは手前の席が「玉を置く」、向こうのAIが「先後を選ぶ」で、見出しにAIの選択が出る',
    s.roleBottom === '玉を置く' && s.roleTop === '先後を選ぶ'
    && /^あなたが両玉を置き、AIが(先手 ☗|後手 ☖)を持った$/.test(s.head), `${s.roleTop} / ${s.roleBottom} / ${s.head}`);
  check('天秤将棋で未処理の例外が無い', exceptions().length === errorsAtStart,
    exceptions().slice(errorsAtStart).join(' / '));
  // 次の確認のために終わらせてホームへ。
  await evaluate(page, `(() => { const b = document.getElementById('btn-resign'); b.click(); b.click(); })()`);
  await evalUntil(page, 'document.getElementById("panel").dataset.phase', v => v === 'over', 10000);
  await evaluate(page, 'document.getElementById("logo").click()');   // 終局後なので確認は出ない
  await evalUntil(page, 'document.getElementById("view-home").hidden', v => v === false, 5000);
}

// ---- 観戦（--watch） ----

/**
 * AI同士の対局をレベル1で終局まで流す。game.js 側は test/spectate_test.mjs が見ているので、
 * ここで見るのは画面にしか無いもの: 開始ボタンの文言、席の名前、一時停止と中断、
 * 布石の間（1手0.7秒）、終局後の評価グラフ（面が描かれ、押すとその手へ移る）。
 */
async function watchGame(page) {
  console.log('\n--- 観戦（--watch）---');
  const errorsAtStart = exceptions().length;
  const rows = () => evaluate(page, 'document.querySelectorAll("#kifu li").length');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await evaluate(page, `(() => {
    const m = document.getElementById('mode-standard'); m.checked = true; m.dispatchEvent(new Event('change'));
    const c = document.getElementById('opt-color'); c.value = 'spectate'; c.dispatchEvent(new Event('change'));
    document.getElementById('opt-level').value = '1';
  })()`);
  check('観戦を選ぶと開始ボタンの文言が変わり、持ち時間が触れなくなる', await evaluate(page,
    'document.getElementById("btn-new").textContent === "AI同士の対局を観戦する" && document.getElementById("opt-time").disabled'));
  await click(page, await center(page, '#btn-new'));
  await evalUntil(page, 'document.querySelectorAll("#kifu li").length', v => v >= 3, 30000);
  const s1 = await evaluate(page, `({
    status: document.getElementById('status-line').textContent,
    top: document.getElementById('seat-top-name').textContent,
    bottom: document.getElementById('seat-bottom-name').textContent,
    undoHidden: document.getElementById('btn-undo').hidden,
    resignHidden: document.getElementById('btn-resign').hidden,
    pauseVisible: document.getElementById('btn-pause').getBoundingClientRect().width > 0,
    clock: document.getElementById('clock-bottom').textContent,
  })`);
  check('観戦中は席が両方AI、待った・投了の代わりに一時停止・中断、時計は無し',
    s1.status === 'AI同士の対局を観戦中' && s1.top.startsWith('AI') && s1.bottom.startsWith('AI')
      && s1.undoHidden && s1.resignHidden && s1.pauseVisible && s1.clock === '', JSON.stringify(s1));
  const n0 = await rows();
  await wait(1500);
  const n1 = await rows();
  check('布石が目で追える速さ（1.5秒で1〜3手）', n1 - n0 >= 1 && n1 - n0 <= 3, `${n1 - n0}手`);
  await evaluate(page, 'document.getElementById("btn-pause").click()');
  await wait(1200);   // 指しかけの1手は入る
  const nP = await rows();
  await wait(1500);
  const nQ = await rows();
  const pausedText = await evaluate(page,
    'document.getElementById("status-line").textContent + "|" + document.getElementById("btn-pause").textContent');
  check('一時停止で止まる', nP === nQ && pausedText === '一時停止中|再開', `${nP}→${nQ} ${pausedText}`);
  await evaluate(page, 'document.getElementById("btn-pause").click()');
  const resumed = await evalUntil(page, 'document.querySelectorAll("#kifu li").length', v => v > nQ, 10000);
  check('再開で進む', resumed > nQ, `${nQ}→${resumed}`);
  await shot('11-watch');

  // 終局まで。41手目の裁定で布石のまま終わる局もある（AIの指し手しだい）。その局には
  // 通常フェーズの評価が無く、この先の確認ができないので、もう一局流して引き当てる。
  let s2;
  for (let attempt = 0; attempt < 4; attempt++) {
    await evalUntil(page, 'document.getElementById("panel").dataset.phase', v => v === 'over', 300000);
    await wait(300);
    s2 = await evaluate(page, `({
      kifu: document.querySelectorAll('#kifu li').length,
      status: document.getElementById('status-line').textContent,
      chartVisible: document.getElementById('eval-chart').getBoundingClientRect().height > 40,
      areas: document.querySelectorAll('#eval-chart-svg .area-sente').length,
      engineVisible: !document.getElementById('engine').hidden,
      evalText: document.getElementById('readout-eval').textContent,
      kifuHeight: document.getElementById('kifu').getBoundingClientRect().height,
    })`);
    if (s2.kifu > 40) break;
    console.log(`  .. 布石のまま終局（${s2.kifu}手・${s2.status}）。もう一局流す`);
    await click(page, await center(page, '#btn-again'));
    await evalUntil(page, 'document.querySelectorAll("#kifu li").length', v => v >= 1, 30000);
  }
  check('終局まで進み、評価グラフに面が描かれ、評価が出る',
    s2.kifu > 40 && s2.chartVisible && s2.areas >= 1 && s2.engineVisible && /深さ|手詰/.test(s2.evalText),
    JSON.stringify(s2));
  check('棋譜の枠が潰れていない（グラフの行が棋譜の行を奪っていない）', s2.kifuHeight > 100, `${s2.kifuHeight}px`);
  // グラフを押すとその手へ。左端寄りを押せば布石の途中の手になる。
  const b = JSON.parse(await evaluate(page, 'JSON.stringify(document.getElementById("eval-chart-svg").getBoundingClientRect())'));
  await click(page, { x: b.x + b.width * .25, y: b.y + b.height / 2 });
  await wait(400);
  const s3 = await evaluate(page, `({
    reviewing: document.getElementById('board').classList.contains('reviewing'),
    current: document.querySelector('#kifu li.current')?.querySelector('.n')?.textContent,
    labels: [...document.querySelectorAll('#eval-chart-svg text')].map(e => e.textContent),
  })`);
  check('グラフを押すとその手の局面へ', s3.reviewing && Number(s3.current) > 0 && Number(s3.current) < s2.kifu, JSON.stringify(s3));
  check('グラフに「布石（評価なし）」と「41手目〜」の文字がある',
    s3.labels.includes('布石（評価なし）') && s3.labels.includes('41手目〜'), JSON.stringify(s3.labels));
  await evaluate(page, 'document.getElementById("nav-last").click()');
  await layoutCheck('観戦の終局');
  await shot('12-watch-over');
  check('観戦で未処理の例外が無い', exceptions().length === errorsAtStart,
    exceptions().slice(errorsAtStart).join(' / '));

  // ---- 検討 ----
  await analyzeGame(page, s2.kifu);
  check('検討で未処理の例外が無い', exceptions().length === errorsAtStart,
    exceptions().slice(errorsAtStart).join(' / '));

  // 中断。もう一局を観戦で始めて、数手で止める。
  await click(page, await center(page, '#btn-again'));
  await evalUntil(page, 'document.querySelectorAll("#kifu li").length', v => v >= 2, 30000);
  await evaluate(page, 'document.getElementById("btn-abort").click()');
  await evalUntil(page, 'document.getElementById("panel").dataset.phase', v => v === 'over', 10000);
  const s4 = await evaluate(page, `({
    status: document.getElementById('status-line').textContent,
    state: document.getElementById('panel').dataset.state,
  })`);
  check('中断すると勝敗なしで結果画面になる', s4.status === '中断' && s4.state === 'over', JSON.stringify(s4));
  // 終局後なので確認は出ずにホームへ。
  await evaluate(page, 'document.getElementById("logo").click()');
  await evalUntil(page, 'document.getElementById("view-home").hidden', v => v === false, 5000);
  await evaluate(page, `(() => { const c = document.getElementById('opt-color'); c.value = 'sente'; c.dispatchEvent(new Event('change')); })()`);
}

// ---- 検討 ----

/**
 * 終局した対局を検討する。候補手が出ること、候補手を押すと変化として指せること、
 * 盤の駒を動かして変化が伸びること、本譜へ戻れること、全手の解析でグラフが埋まること、
 * 検討を終えると結果画面に戻ること。
 */
async function analyzeGame(page, kifuRows) {
  console.log('\n--- 検討 ---');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await evaluate(page, 'document.getElementById("nav-last").click()');
  await click(page, await center(page, '#btn-analyze'));
  const cands = await evalUntil(page, 'document.querySelectorAll("#candidates li").length', v => v >= 1, 8000);
  const a1 = await evaluate(page, `({
    state: document.getElementById('panel').dataset.state,
    analyzing: document.getElementById('board').classList.contains('analyzing'),
  })`);
  // 終局図は詰みで候補手が出ないことがあり、その直前も候補手が詰ましてしまう手で、
  // 変化に入った先で駒が動かせない。4手戻った局面で試す。
  if (!cands) await wait(200);
  for (let i = 0; i < 4; i++) await evaluate(page, 'document.getElementById("nav-prev").click()');
  await evalUntil(page, 'document.querySelectorAll("#candidates li").length', v => v >= 1, 8000);
  const a2 = await evaluate(page, `({
    n: document.querySelectorAll('#candidates li').length,
    ev: document.querySelector('#candidates li .ev')?.textContent,
    mv: document.querySelector('#candidates li .mv')?.textContent,
    arrows: document.querySelectorAll('.sg-shapes g.primary line, .sg-shapes g.primary ellipse').length,
    status: document.getElementById('status-line').textContent,
  })`);
  check('検討に入ると候補手（最大3本）と矢印が出る',
    a1.state === 'analyze' && a1.analyzing && a2.n >= 1 && a2.n <= 3 && /^[+-]?\d|手詰/.test(a2.ev ?? '')
      && (a2.mv ?? '').length >= 2 && a2.arrows >= 1 && a2.status.startsWith('検討中'),
    JSON.stringify({ a1, a2 }));
  // 候補手を押すと、その手が変化として入る。
  await click(page, await center(page, '#candidates li'));
  await wait(300);
  const v1 = await evaluate(page, `({
    rows: document.querySelectorAll('#variation li').length,
    hidden: document.getElementById('variation').hidden,
    status: document.getElementById('status-line').textContent,
    backEnabled: !document.getElementById('btn-var-back').disabled,
  })`);
  check('候補手を押すと変化が1手入る', v1.rows === 1 && !v1.hidden && /変化/.test(v1.status) && v1.backEnabled, JSON.stringify(v1));
  // 盤の駒を動かして変化を伸ばす。手番の色の駒を探す（どちらの色でも動かせる）。
  let moved = false;
  for (const color of ['sente', 'gote']) {
    const sel = `sg-pieces piece.${color}`;
    const total = await evaluate(page, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
    for (let i = 0; i < total && !moved; i++) {
      const at = await centerOfNth(page, sel, i);
      if (!at) break;
      await click(page, at);
      const dests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 800);
      if (!dests) continue;
      await click(page, await center(page, 'sg-squares sq.dest'));
      const choices = await evalUntil(page, 'document.querySelectorAll("sg-promotion piece").length', v => v > 0, 600);
      if (choices > 0) await click(page, await center(page, 'sg-promotion piece'));
      moved = true;
    }
    if (moved) break;
  }
  await wait(300);
  const v2 = await evaluate(page, 'document.querySelectorAll("#variation li").length');
  check('盤の駒を動かすと変化が伸びる', moved && v2 === 2, `動かせた=${moved} 変化=${v2}手`);
  // 変化の中を戻る・進む。
  await evaluate(page, 'document.getElementById("nav-prev").click()');
  await wait(200);
  const v3 = await evaluate(page, '[...document.querySelectorAll("#variation li")].findIndex(li => li.classList.contains("current"))');
  check('1手戻ると変化の1手目が現在になる', v3 === 0, `current=${v3}`);
  await evaluate(page, 'document.getElementById("btn-var-back").click()');
  await wait(200);
  const v4 = await evaluate(page, `({
    hidden: document.getElementById('variation').hidden,
    status: document.getElementById('status-line').textContent,
  })`);
  check('本譜へ戻ると変化が消える', v4.hidden && !/変化/.test(v4.status), JSON.stringify(v4));
  await shot('13-analyze');

  // 全手を解析。終わるとボタンの文言が戻り、グラフの線が通常フェーズの行の数だけ点を持つ。
  await evaluate(page, 'document.getElementById("btn-analyze-all").click()');
  await evalUntil(page, 'document.getElementById("btn-analyze-all").textContent', v => v === '解析を止める', 3000);
  const done = await evalUntil(page, 'document.getElementById("btn-analyze-all").textContent', v => v === '全手を解析', 180000);
  const pts = await evaluate(page, `[...document.querySelectorAll('#eval-chart-svg .line')]
    .reduce((n, p) => n + p.getAttribute('d').trim().split(/[ML]/).filter(Boolean).length, 0)`);
  check('全手を解析するとグラフが通常フェーズの全行で埋まる', done === '全手を解析' && pts >= kifuRows - 41,
    `点 ${pts} / 行 ${kifuRows}`);
  await evalUntil(page, 'document.querySelectorAll("#candidates li").length', v => v >= 1, 8000);
  check('解析が終わると検討に戻る', await evaluate(page, 'document.getElementById("status-line").textContent.startsWith("検討中")'));
  await layoutCheck('検討');
  await evaluate(page, 'document.getElementById("btn-analyze-end").click()');
  await wait(200);
  const e1 = await evaluate(page, `({
    state: document.getElementById('panel').dataset.state,
    shapes: document.querySelectorAll('.sg-shapes line, .sg-shapes ellipse').length,
    status: document.getElementById('status-line').textContent,
  })`);
  check('検討を終えると結果画面に戻り、矢印が消える', e1.state === 'over' && e1.shapes === 0 && !e1.status.startsWith('検討中'), JSON.stringify(e1));
}

// ---- 文章のページと英語版 ----

async function checkPages(page) {
  console.log('\n--- ルール・コラム ---');
  for (const p of ['/rules/', '/story/', '/en/rules/', '/en/story/']) {
    const r = await evaluate(page, `fetch(${JSON.stringify(p)}).then(r => r.status)`);
    check(`${p} が 200`, r === 200, String(r));
  }
  const nf = await evaluate(page, `fetch('/no/such/page').then(r => r.status)`);
  check('無いパスは 404', nf === 404, String(nf));
  await page.send('Page.navigate', { url: `http://localhost:${PORT}/story/` });
  const cells = await evalUntil(page, 'document.querySelectorAll(".heat-cell").length', v => v === 72, 10000);
  check('コラムのヒートマップが 36+36 マス描かれる', cells === 72, `${cells}マス`);
  check('コラムのメニューに現在地の印がある', await evaluate(page,
    'document.querySelector(".menu a.current")?.dataset.page') === 'story');
  await shot('08-story');
  await page.send('Page.navigate', { url: `http://localhost:${PORT}/en/rules/` });
  await evalUntil(page, 'document.readyState', v => v === 'complete', 10000);
  check('英語のルールは lang=en で、言語リンクが日本語版の同じページを指す', await evaluate(page,
    'document.documentElement.lang === "en" && document.querySelector(".menu .lang").getAttribute("href") === "/rules/"'));
}

/** 英語版。同じ app.js が lang を見て辞書を替え、棋譜は西洋式になる。 */
async function checkEnglish(page) {
  console.log('\n--- 英語版（/en/）---');
  const errorsAtStart = exceptions().length;
  await page.send('Page.navigate', { url: `http://localhost:${PORT}/en/` });
  const ready = await evalUntil(page, 'document.getElementById("btn-new").disabled', v => v === false, 120000);
  check('/en/ でもエンジンが起動する', ready === false);
  if (ready !== false) return;
  check('英語の文言で始まる', await evaluate(page,
    'document.documentElement.lang === "en" && document.getElementById("btn-new").textContent.startsWith("Start")'));
  check('英語の3タブが1行に収まる', await evaluate(page, `(() => {
    const tops = [...document.querySelectorAll('#opp [role="tab"]')].map(b => Math.round(b.getBoundingClientRect().top));
    const t = document.querySelector('#opp-ai .t').textContent;
    return t === 'Play the AI' && new Set(tops).size === 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
  })()`));
  // 対局の設定は前回の値を覚える（--kings-first の後は天秤将棋のまま）。ここは布石将棋で。
  await evaluate(page, `(() => { const m = document.getElementById('mode-standard'); m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click(page, await center(page, '#btn-new'));
  const enStatus = await evalUntil(page, 'document.getElementById("status-line").textContent', v => v && v.startsWith('Your turn'), 30000);
  check('英語の状態文で自分の番になる', String(enStatus).startsWith('Your turn'), String(enStatus));
  check('英語の帯（Placement / Shogi）', await evaluate(page,
    '[...document.querySelectorAll("#stepper .step .t")].map(e => e.textContent).join("/")') === 'Placement/Shogi');
  await click(page, await center(page, 'sg-hand-wrap.hand-bottom piece.pawn'));
  await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  await click(page, await center(page, 'sg-squares sq.dest'));
  await evalUntil(page, 'document.querySelectorAll("#kifu li").length', v => v >= 2, 30000);
  const kifu = await evaluate(page, '[...document.querySelectorAll("#kifu li .m")].map(e => e.textContent)');
  check('英語版の棋譜は西洋式（☗P*7f）', /^☗P\*\d[a-i]$/.test(kifu[0] ?? '') && /^☖[PLNSGBRK]\*\d[a-i]$/.test(kifu[1] ?? ''),
    kifu.join(' '));
  check('席の名前が英語', await evaluate(page,
    'document.getElementById("seat-bottom-name").textContent') === 'You · Sente ☗');
  await layoutCheck('英語版');
  await shot('09-en-play');
  check('英語版で未処理の例外が無い', exceptions().length === errorsAtStart,
    exceptions().slice(errorsAtStart).join(' / '));
}

// ---- 1局通す（--full） ----

/**
 * 布石40手 → 41手目の裁定 → 通常フェーズ、を実際にクリックで指して通す。
 * 布石の着手は温度1のサンプリングなので、同じ局面は二度と出ない。落ちたときに
 * 再現できるよう、最後に必ず棋譜を出す。
 */
async function playWholeGame(page) {
  const errorsAtFullStart = exceptions().length;
  console.log('\n--- 1局通す（--full）---');
  const t0 = Date.now();
  try {
    // ---- 布石フェーズ ----
    let s = await waitTurn(page);
    for (let guard = 0; guard < 45 && s.phase === 'fuseki'; guard++) {
      if (!alive(s)) return;
      const before = s.kifu;
      if (!await dropAnyPiece(page))
        return void check('布石で駒を打てる', false, `${await handText(page)} / ${JSON.stringify(s)}`);
      s = await waitTurn(page, before + 1);
    }
    if (!alive(s)) return;
    console.log(`  布石${s.kifu}手: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    check('布石が40手で終わった', s.kifu === 40, `${s.kifu}手`);

    // ---- 41手目の裁定 ----
    if (s.phase === 'over') {
      check('裁定で終わった理由が玉取りか詰み',
        ['41手目に玉を取れる形で布石が終わった', '詰み'].includes(s.sub),
        `${s.status} / ${s.sub}`);
      check('裁定で終わったときに例外が出ていない', exceptions().length === errorsAtFullStart,
        exceptions().slice(errorsAtFullStart).join(' / '));
      console.log('  41手目の裁定で決着したので通常フェーズは見ない');
      return;
    }
    check('通常フェーズへ移った', s.phase === 'normal', s.phase);
    const settled = await evalUntil(page,
      'document.querySelectorAll("sg-pieces piece:not(.fading)").length', v => v === 40, 5000);
    check('盤上に40枚ある', settled === 40, `${settled}枚`);
    check('41手目に入ったことを知らせている',
      s.status.includes('41手目') || s.status.startsWith('AIが考えている'),
      `${s.status} / ${s.sub}`);
    check('帯が将棋の段に進む', await evaluate(page,
      'document.querySelector("#stepper .step.now .t")?.textContent') === '本将棋');
    check('盤の縁が将棋の色に変わる', await evaluate(page,
      'document.querySelector(".sg-wrap").classList.contains("phase-normal")'));
    await layoutCheck('41手目');

    // ---- 通常フェーズ ----
    await evaluate(page, `(() => {
      window.__thinkingSeen = 0;
      window.__thinkingTimer = setInterval(() => {
        if (document.querySelector('.seat.thinking')) window.__thinkingSeen++;
      }, 20);
    })()`);

    for (let i = 0; i < NORMAL_PLIES && s.phase === 'normal'; i++) {
      const before = s.kifu;
      if (!await moveAnyPiece(page))
        return void check('通常フェーズで動かせる駒がある', false, JSON.stringify(s));
      s = await waitTurn(page, before + 1);
      if (!alive(s)) return;
    }

    const thinkingSeen = await evaluate(page,
      'clearInterval(window.__thinkingTimer), window.__thinkingSeen');
    check('AIが考えている間、席の印が動く', thinkingSeen > 0, `観測 ${thinkingSeen} 回`);
    check('通常フェーズで手が進んだ', s.kifu > 40, `${s.kifu}手`);
    // 41手目の行（指した後に初めて現れる）に区切りが付く。
    check('41手目の棋譜の行に区切りが付く', await evaluate(page,
      'document.querySelector("#kifu li.divider:not(.choice)")?.dataset.divider') === 'ここから本将棋');
    // やねうら王が指したので、評価の出どころが替わっている。見せる設定にして読む。
    await evaluate(page, `(() => { const c = document.getElementById('opt-show-eval'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    const ev = await evaluate(page, 'document.getElementById("readout-eval").textContent');
    check('通常フェーズの評価がやねうら王のものになった', s.phase === 'over' || /深さ|手詰/.test(ev), ev);

    const gaugeFlip = await evaluate(page, `(() => {
      const g = document.getElementById('eval-gauge');
      const p = () => parseFloat(getComputedStyle(g).getPropertyValue('--eval-p'));
      const before = p();
      document.getElementById('btn-flip').click();
      const after = p();
      document.getElementById('btn-flip').click();
      return { before, after, hidden: g.hidden };
    })()`);
    check('盤を反転すると評価の帯も裏返る',
      s.phase === 'over'
      || (!gaugeFlip.hidden && Math.abs(gaugeFlip.before + gaugeFlip.after - 1) < 1e-6),
      `反転前 ${gaugeFlip.before} / 反転後 ${gaugeFlip.after}`);
    await evaluate(page, `(() => { const c = document.getElementById('opt-show-eval'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);

    // 布石と通常はフェーズが違い、盤の出どころも違う。通常フェーズから布石の局面へ戻れるか。
    const cross = await evaluate(page, `(async () => {
      const wait = () => new Promise(r => setTimeout(r, 400));
      const count = () => document.querySelectorAll('sg-pieces piece:not(.fading)').length;
      const live = count();
      const rows = document.querySelectorAll('#kifu li');
      rows[19].click(); await wait();
      const at20 = count();
      rows[39].click(); await wait();
      const at40 = count();
      document.getElementById('nav-last').click(); await wait();
      return { live, at20, at40, back: count() };
    })()`);
    check('通常フェーズから布石の局面へ戻れる',
      cross.at20 === 20 && cross.at40 === 40 && cross.back === cross.live,
      `20手目=${cross.at20}枚 / 40手目=${cross.at40}枚 / 最新へ戻して=${cross.back}枚（対局中=${cross.live}枚）`);
    await layoutCheck('通常フェーズ');
    await shot('10-normal');
    check('1局通しても例外が出ていない', exceptions().length === errorsAtFullStart,
      exceptions().slice(errorsAtFullStart).join(' / '));
  } finally {
    console.log(`  棋譜: ${await kifuText(page)}`);
  }
}

/** 棋譜の文字列。落ちた局面を再現できるよう、失敗時に出す。 */
function kifuText(page) {
  return evaluate(page, `[...document.querySelectorAll('#kifu li .m')].map(e => e.textContent).join(' ')`);
}

/**
 * AIが指し終えて人間の番（か終局）になるまで待つ。
 *
 * @param {number} minKifu ここまでに進んでいるはずの手数。**省略してはいけない。**
 *   shogiground は着手のコールバックを setTimeout 越しに呼ぶ（events.after）。
 *   クリックが返った時点ではまだ handleDrop が走っておらず、表示は「あなたの番」の
 *   ままなので、「AIが考えている」の消滅だけで待つと**打つ前の状態**をそのまま拾う。
 */
async function waitTurn(page, minKifu = 0) {
  const s = await evalUntil(page, SNAPSHOT,
    v => v && v.kifu >= minKifu && !v.status.startsWith('AIが考えている'), 180000);
  await new Promise(r => setTimeout(r, 250));
  return s;
}

/** エラーの表示が出ていないか。出ていたら不一致として数える。 */
function alive(s) {
  const bad = FATAL_STATUS.find(t => s.status.startsWith(t));
  if (bad) check('エラーの表示が出ていない', false, `${s.status} / ${s.sub}`);
  return !bad;
}

/**
 * n番目の要素の中心。shogigroundの駒はマスのキーではなく transform で置かれていて、
 * セレクタでn番目を指す手が無い。**印のclassを足して指してはいけない**。
 */
function centerOfNth(page, selector, index) {
  return evaluate(page, `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

/** クリックが空振りしたときに、その座標に何があったのかを見る。 */
function elementAt(page, { x, y }) {
  return evaluate(page, `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    return el ? el.tagName + '.' + el.className : 'なし';
  })()`);
}

/**
 * 布石フェーズで駒を1つ打つ。打ち切った駒は data-nb="0" になるので選ばない。
 * 残っていても打てるとは限らない（歩は二歩の禁じ手で全9筋が埋まると打てなくなる）ので、
 * マスが光る駒が見つかるまで順に試す。
 */
async function dropAnyPiece(page) {
  const sel = 'sg-hand-wrap.hand-bottom sg-hp-wrap:not([data-nb="0"]) piece';
  const total = await evaluate(page, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
  for (let i = 0; i < total; i++) {
    const at = await centerOfNth(page, sel, i);
    if (!at) return false;
    await click(page, at);
    const dests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 3000);
    if (!dests) {
      console.log(`    ${i}番目の駒を押してもマスが光らない: 座標(${at.x.toFixed(0)},${at.y.toFixed(0)}) `
        + `にあるのは ${await elementAt(page, at)}`);
      continue;
    }
    await click(page, await center(page, 'sg-squares sq.dest'));
    return true;
  }
  return false;
}

/** 手前の駒台の残数。落ちたときにどの駒で詰まったのかを見るために出す。 */
function handText(page) {
  return evaluate(page, `[...document.querySelectorAll('sg-hand-wrap.hand-bottom sg-hp-wrap')]
    .map(w => w.dataset.nb + '×' + (w.querySelector('piece')?.className ?? '?')).join(' ')`);
}

/** 通常フェーズで自分の駒を1つ動かす。動かせる駒が見つかるまで順に試す。 */
async function moveAnyPiece(page) {
  const mine = 'sg-pieces piece.sente';
  const total = await evaluate(page, `document.querySelectorAll(${JSON.stringify(mine)}).length`);
  for (let i = 0; i < total; i++) {
    const at = await centerOfNth(page, mine, i);
    if (!at) return false;
    await click(page, at);
    const dests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 1500);
    if (!dests) continue;
    await click(page, await center(page, 'sg-squares sq.dest'));
    const choices = await evalUntil(page, 'document.querySelectorAll("sg-promotion piece").length', v => v > 0, 1000);
    if (choices > 0) await click(page, await center(page, 'sg-promotion piece'));
    return true;
  }
  return false;
}

// ---- 最小限のCDPクライアント ----

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDPに繋がらない')); });
  let id = 0;
  const pending = new Map();
  const sessions = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else {
      sessions.get(msg.sessionId)?.emit(msg.method, msg.params);
    }
  };
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  return {
    send,
    close: () => ws.close(),
    async attach(targetId) {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const handlers = new Map();
      sessions.set(sessionId, { emit: (m, p) => handlers.get(m)?.forEach(f => f(p)) });
      return {
        send: (method, params) => send(method, params, sessionId),
        on: (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]),
      };
    },
  };
}

/** セレクタで指した要素の中心（ビューポート座標）。画面外なら送り込んでから測る。 */
async function center(page, selector) {
  const r = await evaluate(page, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!r) throw new Error(`要素が見つからない: ${selector}`);
  return r;
}

async function click(page, { x, y }) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
}

async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** shogiground の駒は「置く」動きの途中だと盤の外の座標にいる。実測で後手玉が
 *  translate(-134.606%, 699.757%) にいるあいだに center() を取り、盤の左外
 *  （x=78, 盤は x>=142）を押して空振りしていた。300ms 後には translate(600%, 100%) に
 *  着地する。座標から押す操作の前に必ず静止を待つこと。整数%なら静止とみなす
 *  （アニメーション中だけ端数が出る。.anim クラスは付かないので使えない）。 */
async function piecesSettled(page, timeoutMs = 5000) {
  const ok = await evalUntil(page, `[...document.querySelectorAll('sg-pieces piece')].every(el => {
    const m = /translate\\(\\s*(-?[\\d.]+)%\\s*,\\s*(-?[\\d.]+)%\\s*\\)/.exec(el.getAttribute('style') || '');
    return m && Number.isInteger(+m[1]) && Number.isInteger(+m[2]);
  })`, v => v === true, timeoutMs);
  if (ok !== true) throw new Error('駒が静止しない（アニメーションが終わらない）');
}

/** 条件が満たされるまで評価を繰り返す。最後の値を返す。 */
async function evalUntil(page, expression, ok, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await evaluate(page, expression); } catch { last = undefined; }
    if (ok(last) || Date.now() > until) return last;
    await new Promise(r => setTimeout(r, 200));
  }
}
