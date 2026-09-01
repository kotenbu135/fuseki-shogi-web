// src/ を dist/ へまとめる。バンドラを1本入れているのは、shogiops が
// '@badrap/result' をbare specifierで引いていて、素のESMではブラウザが解決できないため。
//
// 3つのエンジンのうちバンドルするのは onnxruntime-web だけで、残り2つは
// **コピーして置くだけ**にしている。理由はどちらもEmscripten製で、
// 自分のスクリプトURLからの相対で .wasm / .worker.js を探すため、
// バンドルに巻き込むと解決先が壊れるから。
//   - wasm/dist/fuseki.mjs      : import.meta.url 相対で fuseki.wasm を読む → 動的importで読む
//   - @mizarjp/yaneuraou.k-p    : document.currentScript.src 相対 → classic scriptで読む
// onnxruntime-web も .wasm は外に置くので、wasmPaths を明示して vendor/ort/ を指す。
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dist');
const watch = process.argv.includes('--watch');
const withModel = process.argv.includes('--with-model');

const copy = (from, toDir, name = path.basename(from)) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(from, path.join(toDir, name));
  return true;
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of ['index.html', 'style.css']) copy(path.join(HERE, 'src', f), OUT);
copy(path.join(HERE, '_headers'), OUT);

// 布石フェーズのWASM（wasm/build.sh の成果物）
const fusekiOk = ['fuseki.mjs', 'fuseki.wasm']
  .map(f => copy(path.join(HERE, 'wasm/dist', f), path.join(OUT, 'vendor/fuseki')))
  .every(Boolean);
if (!fusekiOk) {
  console.error('wasm/dist/fuseki.{mjs,wasm} がない。先に wasm/build.sh を実行すること。');
  process.exit(1);
}

// 通常フェーズのやねうら王。.wasm と .worker.js は .js の隣に居ないと読まれない。
const YANE = path.join(HERE, 'node_modules/@mizarjp/yaneuraou.k-p/lib');
for (const f of ['yaneuraou.k-p.js', 'yaneuraou.k-p.wasm', 'yaneuraou.k-p.worker.js'])
  copy(path.join(YANE, f), path.join(OUT, 'vendor/yaneuraou'));

// onnxruntime-web のwasm本体（JSグルーは bundle 版に同梱されている）
const ORT = path.join(HERE, 'node_modules/onnxruntime-web/dist');
copy(path.join(ORT, 'ort-wasm-simd-threaded.wasm'), path.join(OUT, 'vendor/ort'));

// 布石方策の重み。現行モデルは dlshogi with GCT (WCSC31) の派生物で再配布の許諾が
// 無いため（models/README.md）、**既定ではdistに入れない**。dist/ をそのまま
// Cloudflare Pages へ上げれば配布になるので、手元で動かすときだけ明示的に要求させる。
//
//   node build.mjs --with-model   ローカル確認用。このdistは配ってはいけない
//   node build.mjs                デプロイ用
const MODEL = 'fuseki_rollout_iter38.onnx';
if (withModel) {
  if (copy(path.join(HERE, 'models', MODEL), path.join(OUT, 'models')))
    console.warn(`--with-model: dist/models/${MODEL} を含めた。このdistは配布しないこと`);
  else
    console.warn(`警告: models/${MODEL} が無いのでdistに含めていない（布石AIは起動時にエラーになる）`);
} else {
  console.log('重みはdistに入れていない（配布用）。手元で対局するなら --with-model を付ける');
}

const options = {
  entryPoints: [path.join(HERE, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(OUT, 'app.js'),
  sourcemap: true,
  legalComments: 'linked', // GPLの著作権表示をdist側にも残す
  logLevel: 'info',
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
