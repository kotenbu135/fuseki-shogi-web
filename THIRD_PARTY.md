# サードパーティのソフトウェア・データ

このリポジトリが**訪問者のブラウザへ配るもの**の出所と条件をまとめる。
ブラウザへJavaScript/WebAssemblyを送ることはGPLにおける「配布」に当たるため、
ここに挙げたものはすべて再配布の対象になる。

開発側（学習・実験）の依存については、非公開の開発リポジトリ側の `THIRD_PARTY.md`
に記録がある。このファイルは**配布物だけ**を扱う。

## 1. 配布しているもの

| 成果物 | dist内の位置 | ライセンス |
| --- | --- | --- |
| [shogiground](https://github.com/WandererXII/shogiground) | `app.js` にバンドル | GPL-3.0-or-later |
| [shogiops](https://github.com/WandererXII/shogiops) | `app.js` にバンドル | GPL-3.0-or-later |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | `app.js` + `vendor/ort/` | MIT |
| [@mizarjp/yaneuraou.k-p](https://www.npmjs.com/package/@mizarjp/yaneuraou.k-p) | `vendor/yaneuraou/` | GPL-3.0 |
| cppshogi のWASM化（`wasm/`） | `vendor/fuseki/` | GPL v3 |
| 対局画面（`src/`） | `app.js`, `index.html`, `style.css` | GPL-3.0-only |

`app.js` にバンドルした分の著作権表示は `app.js.LEGAL.txt` に出している
（esbuild の `legalComments: 'linked'`）。

### 対応するソースの提供

GPL v3 は、配ったバイナリに対応するソースを受け取った人へ提供することを求める。
このリポジトリ自体がその提供を担う。

- 対局画面・ビルド定義・WASM化のソース: このリポジトリ
- 布石フェーズのルールと特徴量抽出（cppshogi）: `engine/dlshogi` サブモジュール
  → <https://github.com/kotenbu135/DeepLearningShogi>

サブモジュールにしているのは、**ビルドに使ったソースのコミットIDが構成そのものに
記録される**ようにするため。配布されたページのフッタにそのコミットIDと
`fuseki.wasm` のSHA-256（先頭16桁）を出しており、`build-info.json` からも読める。

`wasm/dist/*` はビルド成果物だがコミットしている。Cloudflare Pages のビルド環境に
Emscripten が無く、CI側で `wasm/build.sh` を回せないため。成果物とソースが食い違って
いないことは上記のコミットIDとハッシュで確かめられる。

## 2. 配布していないもの

### 布石方策の重み

`models/` は `.gitignore` で塞いであり、**このリポジトリからは配布していない**。

現行の重み（`fuseki_rollout_iter38.onnx`）は
[dlshogi with GCT (WCSC31)](https://github.com/TadaoYamaoka/DeepLearningShogi/releases/tag/wcwc31)
の公開モデルを初期値として学習したもので、そのモデルには再配布の明文の許諾が無い。
配布可能な重みに置き換えるまで、公開版には重みを載せない。

`node build.mjs`（引数なし）は重みを出力に含めない。手元で対局するときの
`--with-model` は出力先を `dist-local/` に分けてあり、配布経路（`dist/`）には
どちらの操作でも重みが入らない。

### 水匠5 `nn.bin`

開発側で教師信号を作るのに使っているが、このリポジトリでは配布していない。
ブラウザ版が使う評価関数は下記の SuishoPetite（`yaneuraou.k-p` に内蔵）であって、
水匠5ではない。

## 3. やねうら王・水匠についての記録

`@mizarjp/yaneuraou.k-p` は評価関数 **SuishoPetite (2021-11)** を内蔵している
（パッケージの README に「Evaluation file has built in SuishoPetite(2021-11) by
たややん＠水匠(将棋AI)」とある）。パッケージ全体は GPL-3.0 として npm で公開され、
同梱の `LICENSE.md` は GPLv3 の全文である。

**弱点を明記しておく。** SuishoPetite 単体について、たややん氏が明文でライセンスを
与えた一次文書は確認できていない。依拠しているのは次の状況証拠である。

- パッケージャ（mizar 氏）が GPL-3.0 として npm で公開し、クレジットを明記している。
- lishogi が本番の検討エンジンとして長期運用している（`ui/ceval/src/worker.ts`）。
- 水匠の作者は評価関数の単体公開を継続しており、やねうら王公式もそれを配布している。

上流の <https://github.com/mizar/YaneuraOu.wasm> は 2022-11-02 にアーカイブされ
読み取り専用になっている（2026-09-01 確認）。

これは布石方策の重みの状況とは向きが逆である。あちらは権利者が「配布は一本化して
ほしい」と述べており、こちらは配布者が自ら GPL を掲げている。とはいえ書面の許諾では
ない点は同じなので、記録として残す。

## 4. ルールの出典

布石将棋のルールは [shogitter](https://shogitter.com/rule/%E5%B8%83%E7%9F%B3%E5%B0%86%E6%A3%8B)
の記述による。実装した解釈は開発リポジトリの `docs/rules.md` にある。
