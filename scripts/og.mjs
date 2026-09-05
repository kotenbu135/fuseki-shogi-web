// 共有プレビュー（og:image）の画像を作る。
//
//   node scripts/og.mjs [seed]
//
// 布石エンジンに固定シードで40手打たせ、その41手目局面を 1200×630 に描いて
// src/og/og-ja.png と src/og/og-en.png に書く。build.mjs はこの2枚を dist/og/ へ
// 写すだけで、ビルド時には描かない（Cloudflare Pages のビルド環境に Chrome が無い）。
// 絵を変えたいときはここを回して PNG をコミットする。
//
// 駒は対局画面と同じ kanji_light（CC BY 4.0。THIRD_PARTY.md）。画像の縁に表示を入れる。
// 描くのは smoke と同じヘッドレス Chrome（CHROME 環境変数で差し替え）。--window-size は
// 見えない枠（87px）を含むので、そのぶん高い窓で撮って python3 + Pillow で上 630 行に切る
// （実測: 1200×630 を頼むと表示域は 543 行しかなく、盤の下が切れた）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fuseki } from '../src/fuseki.js';
import { FusekiPolicy } from '../src/policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SEED = Number(process.argv[2] || 20260904);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const W = 1200, H = 630, CHROME_UI = 87;
const MODEL = path.join(ROOT, 'models/fuseki_degct_b3_iter538.onnx');
const OUT = path.join(ROOT, 'src/og');

// 固定シード（mulberry32）。同じ seed からは同じ布石。
let s = SEED >>> 0;
const rng = () => {
  s = (s + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);
const policy = await FusekiPolicy.load({ model: new Uint8Array(fs.readFileSync(MODEL)) });
const pieces = [];
for (let i = 0; i < 40; i++) {
  const { move } = await policy.pick(fuseki, { temperature: 1, rng });
  fuseki.drop(move);
  pieces.push({ file: Math.floor(move.sq / 9), rank: move.sq % 9, role: move.role, gote: i % 2 === 1 });
}
console.log(`seed ${SEED}: ${fuseki.toSfen()}`);

const CODE = { pawn: 'FU', lance: 'KY', knight: 'KE', silver: 'GI', gold: 'KI', bishop: 'KA', rook: 'HI', king: 'OU' };
const PIECES = pathToFileURL(path.join(ROOT, 'src/pieces/kanji_light')).href;
const TEXT = {
  ja: { title: '布石将棋', line1: '空の盤に交互に20枚ずつ打つ。', line2: '41手目からは本将棋。', sub: 'ブラウザで指せる · AI対局 · 天秤将棋', credit: '駒: kanji_light (CC BY 4.0)' },
  en: { title: 'Fuseki Shogi', line1: 'Place 20 pieces each on an empty board.', line2: 'From move 41 it is ordinary shogi.', sub: 'Play in the browser · vs AI · Balance Shogi', credit: 'pieces: kanji_light (CC BY 4.0)' },
};

const html = lang => {
  const T = TEXT[lang];
  const B = 540, sq = B / 9;   // 盤の一辺
  const board = pieces.map(p => {
    const x = (8 - p.file) * sq, y = p.rank * sq;
    return `<img src="${PIECES}/${p.gote ? 1 : 0}${CODE[p.role]}.svg" style="left:${x}px;top:${y}px;width:${sq}px;height:${sq}px">`;
  }).join('');
  const lines = [1, 2, 3, 4, 5, 6, 7, 8].map(i =>
    `<i style="left:${i * sq}px;top:0;width:1px;height:${B}px"></i><i style="top:${i * sq}px;left:0;height:1px;width:${B}px"></i>`).join('');
  const stars = [[3, 3], [6, 3], [3, 6], [6, 6]].map(([x, y]) =>
    `<b style="left:${x * sq - 4}px;top:${y * sq - 4}px"></b>`).join('');
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body { background: #f6f2e9; color: #24201b; font-family: ${lang === 'en' ? 'Georgia, "Noto Serif", serif' : '"Noto Serif CJK JP", "Noto Sans CJK JP", "IPAPGothic", serif'}; position: relative; }
  .board { position: absolute; left: 44px; top: 45px; width: ${B}px; height: ${B}px; background: #f9b34e; border: 4px solid #6f5027; border-radius: 3px; box-shadow: 0 10px 30px -10px #0006; }
  .board i { position: absolute; background: #000; display: block; }
  .board b { position: absolute; width: 8px; height: 8px; border-radius: 50%; background: #000; }
  .board img { position: absolute; display: block; }
  .text { position: absolute; left: 650px; top: 120px; width: 510px; }
  h1 { margin: 0; font-size: 92px; line-height: 1.1; letter-spacing: .06em; font-weight: 700; }
  p { margin: 0; }
  .lead { margin-top: 28px; font-size: 30px; line-height: 1.5; color: #24201b; }
  .sub { margin-top: 26px; font-size: 22px; color: #6d6459; font-family: system-ui, "Noto Sans CJK JP", sans-serif; }
  .url { position: absolute; left: 650px; bottom: 44px; font-size: 24px; color: #b23a2c; font-family: system-ui, sans-serif; letter-spacing: .02em; }
  .credit { position: absolute; right: 24px; bottom: 14px; font-size: 13px; color: #9b9287; font-family: system-ui, sans-serif; }
</style>
<div class="board">${lines}${stars}${board}</div>
<div class="text"><h1>${T.title}</h1><p class="lead">${T.line1}<br>${T.line2}</p><p class="sub">${T.sub}</p></div>
<div class="url">fusekishogi.com${lang === 'en' ? '/en/' : ''}</div>
<div class="credit">${T.credit}</div>`;
};

fs.mkdirSync(OUT, { recursive: true });
for (const lang of ['ja', 'en']) {
  const tmp = path.join(OUT, `.og-${lang}.html`);
  fs.writeFileSync(tmp, html(lang));
  const png = path.join(OUT, `og-${lang}.png`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--allow-file-access-from-files', `--window-size=${W},${H + CHROME_UI}`, `--screenshot=${png}`, pathToFileURL(tmp).href],
  { stdio: 'ignore' });
  fs.unlinkSync(tmp);
  try {
    execFileSync('python3', ['-c', `from PIL import Image; im=Image.open(${JSON.stringify(png)}); `
      + `assert im.size==(${W},${H + CHROME_UI}), im.size; im.crop((0,0,${W},${H})).save(${JSON.stringify(png)}, optimize=True)`],
    { stdio: 'pipe' });
  } catch (e) {
    console.error(`切り出しに失敗した（python3 と Pillow が要る）: ${e.stderr?.toString() || e.message}`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, png)} ${(fs.statSync(png).size / 1024).toFixed(0)}KB`);
}
