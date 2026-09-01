// 実際のブラウザで dist/ を開き、対局が始まって盤に駒が並ぶところまでを見る。
//
// pipeline_smoke.mjs はNodeでロジックを通すが、**ブラウザでしか壊れない部分**
// （COOP/COEPとSharedArrayBuffer、vendor/以下のアセット解決、shogigroundの描画）は
// 素通りしてしまう。ここはその差分だけを見るためのもの。
//
//   node build.mjs && node test/browser_smoke.mjs
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
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = 8099;

if (!fs.existsSync(path.join(DIST, 'app.js'))) {
  console.error('dist/ が無い。先に node build.mjs を実行すること。');
  process.exit(1);
}

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

  await evaluate(page, 'document.getElementById("btn-new").click()');

  // 先手が人間なので、盤に駒が1枚も無い状態で自分の番になる
  const dests = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 30000);
  check('駒台の駒を選ぶ前に打てるマスが出る前段階（盤が描かれている）',
    await evaluate(page, 'document.querySelectorAll("sg-squares sq").length') === 81, '81マス');
  check('持ち駒が8種並んでいる',
    await evaluate(page, 'document.querySelectorAll("#hand-bottom sg-hp-wrap").length') === 8);
  check('玉が持ち駒にある（布石では玉も打つ）',
    await evaluate(page, 'document.querySelectorAll("#hand-bottom piece.king").length') === 1);

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
  const senteBefore = await evaluate(page, 'document.querySelectorAll("#hand-bottom piece.sente").length');
  await evaluate(page, 'document.getElementById("btn-flip").click()');
  const goteAfter = await evaluate(page, 'document.querySelectorAll("#hand-bottom piece.gote").length');
  check('盤を反転すると手前の駒台が入れ替わる', senteBefore === 8 && goteAfter === 8, `前=${senteBefore} 後=${goteAfter}`);
  await evaluate(page, 'document.getElementById("btn-flip").click()');

  const squareBoard = await evaluate(page, `(() => {
    const r = document.querySelector('sg-board').getBoundingClientRect();
    return Math.abs(r.width - r.height) < 2;
  })()`);
  check('盤が正方形のまま', squareBoard);

  // shogiground は合成イベントを弾く（drag.unwantedEvent が isTrusted を見る）。
  // 本物の入力として届くよう Input.dispatchMouseEvent を使う。
  await click(page, await center(page, '#hand-bottom piece.pawn'));
  const shown = await evalUntil(page, 'document.querySelectorAll("sq.dest").length', v => v > 0, 10000);
  check('駒台の歩を選ぶと打てるマスが光る', shown > 0, `${shown}マス`);

  await click(page, await center(page, 'sg-squares sq.dest'));

  const pieces = await evalUntil(page, 'document.querySelectorAll("sg-pieces piece").length', v => v >= 2, 30000);
  check('人間の1手目とAIの応手が盤に乗った', pieces >= 2, `盤上${pieces}枚`);
  check('棋譜が2手ぶん出ている',
    await evaluate(page, 'document.querySelectorAll("#kifu li").length') >= 2,
    await evaluate(page, '[...document.querySelectorAll("#kifu li .m")].map(e => e.textContent).join(" ")'));

  const errors = logs.filter(l => l.startsWith('EXCEPTION'));
  check('未処理の例外が無い', errors.length === 0, errors.join(' / '));
} finally {
  cdp.close();
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chromeが掴んだままでも実害は無い */ }
}

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);

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
