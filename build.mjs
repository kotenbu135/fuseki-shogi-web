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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const withModel = process.argv.includes('--with-model');

// 出力先を --with-model で分ける。同じ dist/ に「重み入り」と「配布用」を書き分けると、
// 直前にどちらで叩いたかで dist/ の中身が変わってしまい、`wrangler pages deploy dist` や
// ダッシュボードへのドラッグ＆ドロップが**その時の状態次第で**再配布になる。
// パスを分けておけば、配布経路が触るのは常に重みの無いほうになる。
const OUT = path.join(HERE, withModel ? 'dist-local' : 'dist');

const copy = (from, toDir, name = path.basename(from)) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(from, path.join(toDir, name));
  return true;
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

copy(path.join(HERE, 'src', 'style.css'), OUT);
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
// 無いため（models/README.md）、**既定ではdistに入れない**。
//   node build.mjs --with-model   ローカル確認用。dist-local/ に出る。配ってはいけない
//   node build.mjs                デプロイ用。dist/ に出る
// --model <パス> で差し替えられる。布石専用ネット（648出力・価値ヘッド無し）の
// 動作確認や、学習中の途中経過を当てるときに使う。dist側のファイル名は
// esbuildのdefineでmain.jsへ渡すので、モデル名の定義はここ1箇所で済む。
const modelArg = process.argv[process.argv.indexOf('--model') + 1];
const MODEL_SRC = process.argv.includes('--model')
  ? path.resolve(modelArg) : path.join(HERE, 'models', 'fuseki_rollout_iter38.onnx');
const MODEL = path.basename(MODEL_SRC);
let hasModel = false;
if (withModel) {
  hasModel = copy(MODEL_SRC, path.join(OUT, 'models'));
  if (hasModel) console.warn(`--with-model: ${path.basename(OUT)}/models/${MODEL} を含めた。この出力は配布しないこと`);
  else console.warn(`警告: ${MODEL_SRC} が無いので含めていない`);
} else {
  console.log('重みは含めていない（配布用）。手元で対局するなら --with-model を付ける');
}

// ビルドの素性。GPL v3 の「対応するソースの提供」は、配ったバイナリと対応するソースを
// 指せて初めて意味を持つ。wasm/dist/ をコミットしている以上、成果物とソースが食い違って
// いないことを利用者が確かめられる必要があるので、submoduleのコミットIDと .wasm の
// ハッシュをページに出す。gitが無い環境（配布物からのビルド）では unknown にする。
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
};
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
const info = {
  built_at: new Date().toISOString(),
  // superproject が記録しているgitlink。submoduleを展開していなくても読める
  dlshogi_commit: git('rev-parse', 'HEAD:engine/dlshogi'),
  web_commit: git('rev-parse', 'HEAD'),
  fuseki_wasm_sha256: sha256(path.join(HERE, 'wasm/dist/fuseki.wasm')),
  model: hasModel ? MODEL : null,
};
fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

// 重みが無いビルドは布石フェーズを指せない。その状態で対局画面をindexに置くと
// 読み込みエラーが最初に見えるので、準備中ページ（疎通診断つき）をindexにする。
// 重みが入った時点で index は自動的に対局画面へ戻る。
const stamp = f => fs.readFileSync(path.join(HERE, 'src', f), 'utf8').replace(/<!--BUILD_INFO-->/g,
  `dlshogi <code>${info.dlshogi_commit.slice(0, 12)}</code> / ` +
  `web <code>${info.web_commit.slice(0, 12)}</code> / ` +
  `fuseki.wasm <code>${info.fuseki_wasm_sha256}</code>`);
const indexSrc = hasModel ? 'index.html' : 'soon.html';
fs.writeFileSync(path.join(OUT, 'index.html'), stamp(indexSrc));
if (!hasModel) fs.writeFileSync(path.join(OUT, 'play.html'), stamp('index.html'));

// 404。Cloudflare Pages は出力直下の 404.html を、見つからないパスに 404 で返す。
// 置かないと未知のURLが軒並み index.html を 200 で返し、検索エンジンから見ると
// 準備中ページが無数のURLで実在することになる。
fs.writeFileSync(path.join(OUT, '404.html'), stamp('404.html'));

console.log(`index = src/${indexSrc}  (dlshogi ${info.dlshogi_commit.slice(0, 12)})`);

const options = {
  entryPoints: [path.join(HERE, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(OUT, 'app.js'),
  sourcemap: true,
  legalComments: 'linked', // GPLの著作権表示をdist側にも残す
  // モデルのファイル名をmain.jsへ渡す。main.js側に名前を書くと定義が2箇所になり、
  // --model で差し替えたときに片方だけが古い名前を指す。
  define: { __MODEL_FILE__: JSON.stringify(MODEL) },
  logLevel: 'info',
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
