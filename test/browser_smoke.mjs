// 実際のブラウザで dist/ を開き、対局が始まって盤に駒が並ぶところまでを見る。
//
// pipeline_smoke.mjs はNodeでロジックを通すが、**ブラウザでしか壊れない部分**
// （COOP/COEPとSharedArrayBuffer、vendor/以下のアセット解決、shogigroundの描画）は
// 素通りしてしまう。ここはその差分だけを見るためのもの。
//
//   node build.mjs && node test/browser_smoke.mjs [dist ディレクトリ]
//   node build.mjs --full なしでも dist/ を見る。別の重みを当てるなら:
//   node build.mjs --model <重み> && node test/browser_smoke.mjs dist-local --full [手数]
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
// 位置引数は [distディレクトリ] [通常フェーズの手数]。--full を付けると、2手見て
// 終わりにせず布石40手→41手目の裁定→通常フェーズまで実際に指して通す。
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const FULL = process.argv.includes('--full');
const DIST = args[0] ? path.resolve(args[0]) : path.join(ROOT, 'dist');
const NORMAL_PLIES = Number(args[1] ?? 4);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
// 固定だと --full を並べて回したときにぶつかる。SMOKE_PORT で逃がせるようにする。
const PORT = Number(process.env.SMOKE_PORT || 8099);

if (!fs.existsSync(path.join(DIST, 'app.js'))) {
  console.error('dist/ が無い。先に node build.mjs を実行すること。');
  process.exit(1);
}

/** 画面から読める状態。1手ごとに何度も評価を往復しないよう1回でまとめて取る。 */
const SNAPSHOT = `({
  status: document.getElementById('status-line').textContent,
  sub: document.getElementById('status-sub').textContent,
  phase: document.getElementById('readout-phase').textContent,
  evaluation: document.getElementById('readout-eval').textContent,
  kifu: document.querySelectorAll('#kifu li').length,
  boardPieces: document.querySelectorAll('sg-pieces piece:not(.fading)').length,
})`;

// main.js が setStatus で出すエラーの文言。**ここを見るのが要点**で、drive() は
// 例外を握って表示へ流すため、Runtime.exceptionThrown には何も出てこない。
// _transitionToNormal() の「41手目局面をshogiopsが受理しない」もこの経路で消える。
const FATAL_STATUS = ['起動に失敗した', 'エンジンでエラーが起きた', 'その手は指せない'];

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
  // 駒の画像。octet-stream で配るとブラウザがSVGとしてデコードせず、駒が消える。
  '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(DIST, rel);
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
  '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
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
try {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const page = await cdp.attach(target.targetId);
  page.on('Runtime.consoleAPICalled', e => logs.push(e.args.map(a => a.value ?? a.description).join(' ')));
  page.on('Runtime.exceptionThrown', e => logs.push('EXCEPTION ' + (e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)));
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `http://localhost:${PORT}/` });

  check('crossOriginIsolated', await evalUntil(page, 'crossOriginIsolated', v => v === true, 15000) === true,
    'COOP/COEPが効いていないとやねうら王が1スレッドに落ちる');

  // 3つのエンジンが起きて「対局開始」が押せるようになるまで
  const ready = await evalUntil(page, 'document.getElementById("btn-new").disabled', v => v === false, 120000);
  check('3つのエンジンが起動した', ready === false,
    await evaluate(page, '[document.getElementById("status-line").textContent, document.getElementById("status-sub").textContent].join(" / ")'));
  if (failures) { console.log('--- コンソール ---'); logs.forEach(l => console.log('  ' + l)); }
  if (ready !== false) throw new Error('エンジンが起動しないので以降の確認はできない');

  // 1局通すときは持ち時間を最短にする。movetimeMs は Game のコンストラクタで固定
  // されるので、対局開始を押す**前**に変える。
  if (FULL) await evaluate(page, 'document.getElementById("opt-movetime").value = "500"');
  // 実マウスで押す。element.click() は利用者の操作と見なされないので、
  // ブラウザの自動再生規制で AudioContext が suspended のままになり、
  // 「音が鳴らない」状態をテストが素通りしてしまう。
  await click(page, await center(page, '#btn-new'));

  // 対局中に「対局開始」が押せると、進行中の対局が黙って消える。
  check('対局中は対局開始が押せない',
    await evaluate(page, 'document.getElementById("btn-new").disabled') === true);
  check('対局中は投了が押せる',
    await evaluate(page, 'document.getElementById("btn-resign").disabled') === false);

  // 合成が動くことと、アプリの経路で鳴ることは別問題。AudioContext は利用者の操作の
  // 中でしか起こせないので、対局開始で起きていなければ1音も出ない。
  // currentTime は resume した直後だとまだ 0 のことがあり、それを条件に入れると
  // たまに落ちる（20回まわして1回踏んだ）。state だけを見る。
  const audio = await evaluate(page, `(() => {
    const s = window.__sound;
    if (!s) return 'sound が公開されていない';
    return { ctx: !!s.ctx, state: s.ctx?.state };
  })()`);
  check('対局開始でAudioContextが起きている',
    typeof audio === 'object' && audio.ctx && audio.state === 'running',
    typeof audio === 'string' ? audio : `state=${audio.state}`);
  // 触れるのに効かない設定は「壊れている」と区別がつかない。対局中は閉じる。
  check('対局中は手番と持ち時間を変えられない', await evaluate(page, `(() =>
    document.getElementById('opt-color').disabled &&
    document.getElementById('opt-movetime').disabled)()`) === true);
  // 投了は取り消せないので1クリックでは終わらない。
  const resign = await evaluate(page, `(async () => {
    const b = document.getElementById('btn-resign');
    b.click();
    await new Promise(r => setTimeout(r, 150));
    return { label: b.textContent,
             まだ終局していない: document.getElementById('readout-phase').textContent !== '終局' };
  })()`);
  check('投了は1回目のクリックでは確定しない',
    resign.まだ終局していない && resign.label !== '投了', `1回目のラベル: ${resign.label}`);
  // DOMを手で戻すと main.js 側の確認待ちが残ったままになり、次の1クリックで
  // 本当に投了してしまう。自前で戻るまで待つ。
  await evalUntil(page, 'document.getElementById("btn-resign").textContent',
    v => v === '投了', 6000);

  // 先手が人間なので、盤に駒が1枚も無い状態で自分の番になる
  const dests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 30000);
  check('駒台の駒を選ぶ前に打てるマスが出る前段階（盤が描かれている）',
    await evaluate(page, 'document.querySelectorAll("sg-squares sq").length') === 81, '81マス');
  // 駒台は shogiground が .sg-wrap の直下に作る（board.js の hands.inlined）。
  // HTML側の器は無くなったので、hand-bottom クラスで引く。
  check('持ち駒が8種並んでいる',
    await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom sg-hp-wrap").length') === 8);
  check('玉が持ち駒にある（布石では玉も打つ）',
    await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.king").length') === 1);
  check('駒台が盤と同じ .sg-wrap の中にある（gridで盤の左右へ回すため）',
    await evaluate(page, 'document.querySelectorAll(".sg-wrap > sg-hand-wrap").length') === 2);
  // 駒はCSSの背景画像。URLが通っていても Content-Type が image/svg+xml でないと
  // ブラウザがデコードせず、要素は在るのに何も描かれない（盤が空に見える）。
  // 見た目だけの失敗はDOMの数え上げをすり抜けるので、実際に読ませて確かめる。
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
    const mod = await import('./app.js').catch(() => null);
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
  check('6種類の音がすべて無音でない',
    typeof sound === 'object' && Object.keys(sound).length === 6
      && Object.values(sound).every(v => v.peak > 0.02 && v.rms > 0.001),
    typeof sound === 'string' ? sound
      : Object.entries(sound).map(([k, v]) => `${k} peak=${v.peak}`).join(' / '));

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
  // 1366x768 と 1280x720 は実際にはみ出していた。
  for (const [w, h] of [[1366, 768], [1280, 720], [1920, 1080]]) {
    await page.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 250));
    const fits = await evaluate(page, `(() => {
      const r = document.querySelector('.board-column').getBoundingClientRect();
      return { bottom: +r.bottom.toFixed(0), viewport: innerHeight };
    })()`);
    check(`盤が画面の高さに収まる（${w}x${h}）`, fits.bottom <= fits.viewport,
      `盤の下端 ${fits.bottom}px / 画面 ${fits.viewport}px`);
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  await new Promise(r => setTimeout(r, 250));

  check('盤の大きさを変えても横スクロールが出ない',
    scale.small < scale.big && !scale.smallOver && !scale.bigOver,
    `70%=${scale.small}px / 115%=${scale.big}px`);

  check('対局前から盤が出ている', await evaluate(page, `(() => {
    const sq = document.querySelectorAll('sg-squares sq').length;
    const hp = document.querySelectorAll('sg-hp-wrap').length;
    return sq === 81 && hp === 16;
  })()`), '起動直後に空の盤と満杯の駒台が描かれる');

  // 人間の1手目を打ってAIに応じさせる
  // 成りダイアログは開くまでDOMに中身が無いので、器の配置だけ先に見る。
  // static のままだと、開いた瞬間に通常フローへ入って盤の高さが崩れる。
  check('成りダイアログが絶対配置',
    await evaluate(page, 'getComputedStyle(document.querySelector("sg-promotion")).position') === 'absolute');
  check('ダイアログの中身がマス1つ分の大きさになる', await evaluate(page, `(() => {
    const host = document.querySelector('sg-promotion');
    const sq = document.createElement('sg-promotion-square');
    sq.appendChild(document.createElement('sg-promotion-choices'));
    host.appendChild(sq);
    host.style.display = '';   // 開いていないと中身に大きさが付かない
    const cs = getComputedStyle(sq), board = document.querySelector('sg-board').getBoundingClientRect();
    const ok = cs.position === 'absolute' && Math.abs(parseFloat(cs.width) - board.width / 9) < 1.5;
    sq.remove();
    host.style.display = 'none';
    return ok;
  })()`));

  // 盤の反転。set({orientation}) では再ラップされず、マスのキーと駒台の色が古いまま残る。
  const senteBefore = await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.sente").length');
  await evaluate(page, 'document.getElementById("btn-flip").click()');
  const goteAfter = await evaluate(page, 'document.querySelectorAll("sg-hand-wrap.hand-bottom piece.gote").length');
  check('盤を反転すると手前の駒台が入れ替わる', senteBefore === 8 && goteAfter === 8, `前=${senteBefore} 後=${goteAfter}`);
  await evaluate(page, 'document.getElementById("btn-flip").click()');

  const squareBoard = await evaluate(page, `(() => {
    const r = document.querySelector('sg-board').getBoundingClientRect();
    return Math.abs(r.width - r.height) < 2;
  })()`);
  check('盤が正方形のまま', squareBoard);

  // shogiground は合成イベントを弾く（drag.unwantedEvent が isTrusted を見る）。
  // 本物の入力として届くよう Input.dispatchMouseEvent を使う。
  await click(page, await center(page, 'sg-hand-wrap.hand-bottom piece.pawn'));
  const shown = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  check('駒台の歩を選ぶと打てるマスが光る', shown > 0, `${shown}マス`);

  await click(page, await center(page, 'sg-squares sq.dest'));

  const pieces = await evalUntil(page, 'document.querySelectorAll("sg-pieces piece").length', v => v >= 2, 30000);
  check('人間の1手目とAIの応手が盤に乗った', pieces >= 2, `盤上${pieces}枚`);
  check('棋譜が2手ぶん出ている',
    await evaluate(page, 'document.querySelectorAll("#kifu li").length') >= 2,
    await evaluate(page, '[...document.querySelectorAll("#kifu li .m")].map(e => e.textContent).join(" ")'));

  // logs は増え続けるので、数えるのはその都度。const で切り取ると
  // それ以降に出た例外を1件も見なくなる。
  // 評価の表示。布石専用ネットは価値ヘッドを持たないので勝率が出せず、
  // undefined を素通しすると "NaN%" と出る（落ちないので気付けない）。
  const evalText = await evaluate(page, 'document.getElementById("readout-eval").textContent');
  check('評価の表示がNaNでない', !/NaN|undefined/.test(evalText), evalText);

  // ---- 棋譜をさかのぼる ----
  // 「盤に映っているのが対局中の局面ではない」という壊れ方をしうるので、
  // 戻した先の駒数と、戻っている間に着手を受け付けないことを見る。
  const nav = await evaluate(page, `(async () => {
    const wait = () => new Promise(r => setTimeout(r, 400));   // animation.duration=250ms より長く
    // アニメーション中は消えていく駒(.fading)がDOMに残るので除く。
      const count = () => document.querySelectorAll('sg-pieces piece:not(.fading)').length;
    const dests = () => document.querySelectorAll('sq.dest').length;
    const plies = document.querySelectorAll('#kifu li').length;
    if (plies < 2) return '棋譜が2手に満たない';
    const live = count();

    document.getElementById('nav-first').click(); await wait();
    const atFirst = count();
    const reviewing = document.getElementById('board').classList.contains('reviewing');
    // さかのぼっている間は駒台の駒を選んでも打てるマスが出てはいけない
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

  check('未処理の例外が無い', exceptions().length === 0, exceptions().join(' / '));

  if (FULL) await playWholeGame(page);

  // ---- 布石フェーズの途中で投了する ----
  // ここは長く落ちていた。phase が 'over' になるのに position は null のままで、
  // boardSfen() が phase で分岐して makeSfen(null) を呼んでいた。落ちると
  // render() が途中で止まるので盤も表示も固まり、新規対局も始められなくなる。
  // 例外は setStatus を通らないので、画面を見ているだけでは分からない。
  const beforeResign = exceptions().length;
  await evaluate(page, 'document.getElementById("btn-new").click()');
  await evalUntil(page, 'document.querySelectorAll("sg-hp-wrap").length', v => v > 0, 20000);
  await evalUntil(page, 'document.getElementById("status-line").textContent',
    v => v && v.startsWith('あなたの番'), 30000);
  await evaluate(page, `(() => { const b = document.getElementById('btn-resign'); b.click(); b.click(); })()`);
  await new Promise(r => setTimeout(r, 600));
  const afterResign = await evaluate(page, `({
    phase: document.getElementById('readout-phase').textContent,
    status: document.getElementById('status-line').textContent,
    newEnabled: !document.getElementById('btn-new').disabled,
    colorEnabled: !document.getElementById('opt-color').disabled,
  })`);
  check('布石フェーズの途中で投了しても落ちない',
    exceptions().length === beforeResign && afterResign.phase === '終局' && afterResign.newEnabled
      && afterResign.colorEnabled,
    `${afterResign.phase} / ${afterResign.status} / 例外 ${exceptions().length - beforeResign} 件`);
} finally {
  cdp.close();
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chromeが掴んだままでも実害は無い */ }
}

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);

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
    for (let guard = 0; guard < 45 && s.phase.startsWith('布石'); guard++) {
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
    // 40手完了時点で手番側が相手玉を取れる形は普通に起こる。そこで終わった場合も正常。
    if (s.phase === '終局') {
      check('裁定で終わったなら理由は布石の玉取り',
        s.sub === '41手目に玉を取れる形で布石が終わった', `${s.status} / ${s.sub}`);
      // ここは position が null のまま phase が 'over' になる経路で、
      // boardSfen() が phase で分岐していたころは makeSfen(null) で落ちていた。
      check('裁定で終わったときに例外が出ていない', exceptions().length === errorsAtFullStart,
        exceptions().slice(errorsAtFullStart).join(' / '));
      console.log('  41手目の裁定で決着したので通常フェーズは見ない');
      return;
    }
    check('通常フェーズへ移った', s.phase === '通常', s.phase);
    // 40手打った直後は最後の1手の描画がまだ動いていることがある。20回まわして
    // 1回だけ39枚と数えた。Nodeで25局まわしても盤の実体は必ず40枚だったので、
    // 実体ではなく描画の追いつき待ち。落ち着くまで待ってから数える。
    const settled = await evalUntil(page,
      'document.querySelectorAll("sg-pieces piece:not(.fading)").length', v => v === 40, 5000);
    check('盤上に40枚ある', settled === 40, `${settled}枚`);
    // 価値ヘッドの無いネットでは布石フェーズの評価は「採用手の確率」。移った直後は
    // まだ誰も通常フェーズの評価を出していないので、布石の確率が残っていてはいけない。
    check('布石の評価を持ち越していない', s.evaluation === '—', s.evaluation);
    // 41手目でルールが変わる。フェーズ表示が変わるだけでは気づけないので、
    // 移った最初の手番で一度だけ知らせる。
    check('41手目に入ったことを知らせている',
      s.status.includes('41手目') || s.status.startsWith('AIが考えている'),
      `${s.status} / ${s.sub}`);

    // ---- 通常フェーズ ----
    // やねうら王が考えている間、席の印が脈打つ。布石フェーズのAIは同期的で
    // イベントループに戻らないため印が出る隙が無いが、通常フェーズは別スレッドなので
    // ここでしか確かめられない。
    await evaluate(page, `(() => {
      window.__thinkingSeen = 0;
      window.__thinkingTimer = setInterval(() => {
        if (document.querySelector('.seat.thinking')) window.__thinkingSeen++;
      }, 20);
    })()`);

    for (let i = 0; i < NORMAL_PLIES && s.phase === '通常'; i++) {
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
    // やねうら王が指したので、評価の出どころが替わっている（formatEval のもう一方の枝）。
    check('通常フェーズの評価がやねうら王のものになった',
      s.phase === '終局' || /深さ|手詰/.test(s.evaluation), s.evaluation);

    // 布石と通常はフェーズが違い、盤の出どころ（boardPieces / shogiopsのPosition）も違う。
    // 通常フェーズから布石の局面へ戻れるかは、この継ぎ目でしか壊れない。
    const cross = await evaluate(page, `(async () => {
      const wait = () => new Promise(r => setTimeout(r, 400));   // animation.duration=250ms より長く
      // アニメーション中は消えていく駒(.fading)がDOMに残るので除く。
      const count = () => document.querySelectorAll('sg-pieces piece:not(.fading)').length;
      const live = count();
      const rows = document.querySelectorAll('#kifu li');
      rows[19].click(); await wait();          // 20手目（布石の途中）
      const at20 = count();
      rows[39].click(); await wait();          // 40手目（布石が終わった直後）
      const at40 = count();
      document.getElementById('nav-last').click(); await wait();
      return { live, at20, at40, back: count() };
    })()`);
    check('通常フェーズから布石の局面へ戻れる',
      cross.at20 === 20 && cross.at40 === 40 && cross.back === cross.live,
      `20手目=${cross.at20}枚 / 40手目=${cross.at40}枚 / 最新へ戻して=${cross.back}枚（対局中=${cross.live}枚）`);
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
 *   その古い状態で次の着手へ進むと、人間の手番でないのにクリックすることになる。
 *
 * 表示は render() が先に書き換わり、盤のアニメーション（board.js の duration 180ms）は
 * その後で終わる。動いている最中にクリックすると座標がずれるので、少し置いてから返す。
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
 * セレクタでn番目を指す手が無い。**印のclassを足して指してはいけない**。shogiground は
 * piece の className から色と駒種を作っているので、余計なclassは駒の同一性を狂わせる。
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
    // 動けない駒（周りが塞がっている）はマスが光らない。次の駒へ。
    const dests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 1500);
    if (!dests) continue;
    await click(page, await center(page, 'sg-squares sq.dest'));
    // 成りを選べる手なら、ダイアログが開く（強制成りのときは開かずに成る）。
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
