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
// 重みを外から差したときだけ出力先を分ける（下の OUT を参照）。
const custom = process.argv.includes('--model');

// 出力先を --model で分ける。同じ dist/ に「配布してよい重み」と「配布できない重み」を
// 書き分けると、直前にどちらで叩いたかで dist/ の中身が変わってしまい、
// `wrangler pages deploy dist` やダッシュボードへのドラッグ＆ドロップが**その時の
// 状態次第で**再配布になる。パスを分けておけば、配布経路が触るのは常に models/ に
// コミットしてある重み（＝再配布してよいもの）だけになる。
const OUT = path.join(HERE, custom ? 'dist-local' : 'dist');

const copy = (from, toDir, name = path.basename(from)) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(from, path.join(toDir, name));
  return true;
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

copy(path.join(HERE, 'src', 'style.css'), OUT);
copy(path.join(HERE, 'src', 'favicon.svg'), OUT);
copy(path.join(HERE, '_headers'), OUT);

// 駒の画像（CC BY 4.0 / Ka-hu。THIRD_PARTY.md を参照）。
// style.css が pieces/<ファイル名> の相対で引くので、dist直下に同じ名前で置く。
{
  const from = path.join(HERE, 'src', 'pieces', 'kanji_light');
  const files = fs.existsSync(from) ? fs.readdirSync(from).filter(f => f.endsWith('.svg')) : [];
  if (files.length !== 30) {
    console.error(`src/pieces/kanji_light の駒画像が30個ない（${files.length}個）。`);
    process.exit(1);
  }
  for (const f of files) copy(path.join(from, f), path.join(OUT, 'pieces'));
}

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

// 布石方策の重み。
//
//   node build.mjs                 公開用。models/ の PUBLIC_MODEL が dist/ に入る
//   node build.mjs --model <パス>   手元確認用。dist-local/ に出る。配ってはいけない
//
// **models/ にコミットしてよいのは再配布できる重みだけ**（models/README.md）。現行の
// 公開重みは乱数初期化からやねうら王の採点だけで学習したもので、GCT由来のパラメータを
// 持たない。GCT派生の重み（fuseki_rollout_iter38.onnx）を手元で当てるときは --model で
// 指定する。出力が dist-local/ に分かれるので、配布経路（dist/）には乗らない。
//
// 名前は esbuild の define で main.js へ渡すので、定義はここ1箇所で済む。
const PUBLIC_MODEL = 'fuseki_degct_b3_iter64.onnx';
const modelArg = process.argv[process.argv.indexOf('--model') + 1];
const MODEL_SRC = custom ? path.resolve(modelArg) : path.join(HERE, 'models', PUBLIC_MODEL);
const MODEL = path.basename(MODEL_SRC);
const hasModel = copy(MODEL_SRC, path.join(OUT, 'models'));
if (!hasModel) console.warn(`警告: ${MODEL_SRC} が無いので含めていない。布石フェーズは指せない`);
else if (custom) console.warn(`--model: ${path.basename(OUT)}/models/${MODEL} を含めた。この出力は配布しないこと`);

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
// play.html は重みを載せていなかった頃に対局画面を置いていたURL。index が対局画面へ
// 戻った後も、出回ったリンクが404にならないよう同じ内容で残す。
fs.writeFileSync(path.join(OUT, 'play.html'), stamp('index.html'));

// 404。Cloudflare Pages は出力直下の 404.html を、見つからないパスに 404 で返す。
// 置かないと未知のURLが軒並み index.html を 200 で返し、検索エンジンから見ると
// 準備中ページが無数のURLで実在することになる。
fs.writeFileSync(path.join(OUT, '404.html'), stamp('404.html'));

// 起動時に「約15MB」と出しているのは onnxruntime-web の .wasm と重みの合計。
// 片方だけ差し替えると表示だけ古くなるので、ここで突き合わせる。
{
  const mb = f => (fs.existsSync(f) ? fs.statSync(f).size : 0) / 1048576;
  const shown = (fs.readFileSync(path.join(HERE, 'src/main.js'), 'utf8')
    .match(/setStatus\('布石方策を読み込んでいる…', '約(\d+)MB'\)/) ?? [])[1];
  // 重みは --model で差し替わるので、置いた実物（MODEL）を見る。
  const actual = mb(path.join(OUT, 'vendor/ort/ort-wasm-simd-threaded.wasm'))
    + mb(path.join(OUT, 'models', MODEL));
  if (shown && Math.abs(Number(shown) - actual) > 3)
    console.warn(`起動時の表示「約${shown}MB」が実物（${actual.toFixed(1)}MB）とずれている。`
      + ' src/main.js の setStatus を直すこと。');
}

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
