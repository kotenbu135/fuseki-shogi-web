import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseSfen } from 'shogiops/sfen';
import { makeUsi, parseUsi } from 'shogiops/util';
const require = createRequire(import.meta.url);
const YaneuraOu_K_P = require('@mizarjp/yaneuraou.k-p');

const recs = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse)
  .filter(r => parseSfen('standard', r.sfen, false).isOk);
const N = Number(process.argv[3] || 12);
const MOVETIME = Number(process.argv[4] || 1000);

const t0 = Date.now();
const eng = await YaneuraOu_K_P();
console.log(`モジュール初期化: ${Date.now() - t0}ms`);
const lines = [];
eng.addMessageListener(l => lines.push(l));
const send = c => eng.postMessage(c);
const waitFor = (prefix, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const poll = () => {
    const hit = lines.find(l => l.startsWith(prefix));
    if (hit) return resolve(hit);
    if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting ${prefix}`));
    setTimeout(poll, 5);
  };
  poll();
});

send('usi'); console.log('usiok:', (await waitFor('usiok')) === 'usiok');
send('setoption name USI_Hash value 64');
send('setoption name Threads value 2');
send('isready'); await waitFor('readyok', 60000);
console.log(`isready まで: ${Date.now() - t0}ms`);
send('usinewgame');

let ok = 0, illegal = 0, resign = 0;
const times = [];
for (const r of recs.slice(0, N)) {
  lines.length = 0;
  const pos = parseSfen('standard', r.sfen, false).unwrap();
  const legal = new Set();
  for (const [from, dests] of pos.allMoveDests()) for (const to of dests) {
    legal.add(makeUsi({ from, to }));
    legal.add(makeUsi({ from, to, promotion: true }));
  }
  const s = Date.now();
  send(`position sfen ${r.sfen}`);
  send(`go movetime ${MOVETIME}`);
  const bm = await waitFor('bestmove');
  times.push(Date.now() - s);
  const mv = bm.split(' ')[1];
  const info = lines.filter(l => l.startsWith('info') && l.includes(' score ')).pop() || '';
  const sc = (info.match(/score (cp|mate) (-?\d+)/) || []).slice(1).join(' ');
  const depth = (info.match(/depth (\d+)/) || [])[1];
  if (mv === 'resign' || mv === 'win') { resign++; console.log(`  ${mv} : ${r.sfen}`); continue; }
  const isLegal = legal.has(mv) && pos.isLegal(parseUsi(mv));
  if (isLegal) ok++; else { illegal++; console.log(`  非合法!? ${mv} : ${r.sfen}`); }
  console.log(`  bestmove ${mv.padEnd(6)} legal=${isLegal} depth=${depth} score=${sc}`);
}
console.log(`\n合法 ${ok} / 非合法 ${illegal} / resign ${resign}  (${N}局面, movetime ${MOVETIME}ms)`);
console.log(`1手あたり実測: 平均 ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)}ms`);
eng.terminate();
process.exit(0);
