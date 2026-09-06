// 公開中のサイトを実ブラウザで開き、CSP が何も止めていないこと・エンジンが起きることを見る。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] ?? 'https://fusekishogi.com/';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
  '--mute-audio', '--disable-gpu', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = ''; const t = setTimeout(() => rej(new Error('DevTools が開かない')), 30000);
  chrome.stderr.on('data', d => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]); } });
});
let id = 0; const pend = new Map(); const viol = []; let sessionId = null;
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  if (m.method === 'Log.entryAdded' && /Content Security Policy/i.test(m.params?.entry?.text ?? '')) viol.push(m.params.entry.text);
};
const send = (method, params = {}, useSession = true) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params, ...(useSession && sessionId ? { sessionId } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
await send('Page.navigate', { url: URL_ });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
const until = async (expr, ok, ms) => { const end = Date.now() + ms; let v; for (;;) { try { v = await evaluate(expr); } catch { v = undefined; } if (ok(v) || Date.now() > end) return v; await new Promise(r => setTimeout(r, 500)); } };
const iso = await until('crossOriginIsolated', v => v === true, 20000);
await until('document.readyState', v => v === 'complete', 20000);
const ready = await until('!document.getElementById("btn-new").disabled', v => v === true, 90000);
const label = await evaluate('document.getElementById("btn-new")?.textContent ?? ""');
console.log(`URL              : ${URL_}`);
console.log(`crossOriginIsolated: ${iso}`);
console.log(`対局開始が押せる  : ${ready}  （${label.trim()}）`);
console.log(`CSP が止めたもの  : ${viol.length} 件`);
viol.slice(0, 5).forEach(v => console.log('  - ' + v));
ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 無視 */ }
process.exit(iso === true && ready === true && viol.length === 0 ? 0 : 1);
