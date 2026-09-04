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
| 駒の画像 kanji_light（下記） | `pieces/*.svg` | CC BY 4.0 |
| 布石方策の重み（下記） | `models/fuseki_degct_b3_iter272.onnx` | 本リポジトリの著作物 |

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

### 駒の画像

`pieces/*.svg`（30枚）は lishogi の駒セット **kanji_light** をそのまま使っている。

- 作者: [Ka-hu](https://github.com/Ka-hu)
- ライセンス: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- 出所: <https://github.com/WandererXII/lishogi> の
  `ui/@build/pieces/assets/standard/kanji_light`（同リポジトリの `COPYING.md`）

CC BY 4.0 は表示のみを求めるので、GPL-3.0-only の配布物に同梱できる。この節が
その表示にあたる。共有プレビューの画像 `og/og-*.png`（`scripts/og.mjs` が描く）にも
この駒が写っているので、画像の縁に表示を入れてある。ファイル名の `0`/`1` は先手/後手で、後手の駒は**回転済みの
別ファイル**として入っている。CSSで回してはいけない（`src/style.css` の注記を参照）。

**盤の画像は取り込んでいない。** lishogi の `images/boards` は駒セットと違って
AGPLv3+ で、GPL-3.0-only の配布物に混ぜると配布物全体に AGPL 13条のネットワーク
経由のソース提供義務が乗る。既定盤 `wood.png` を調べたところ、1100x1200のうち
縦方向は全ピクセル同一で、横方向にだけ約200本の帯が入っているだけだった
（明度 mean 189.0 / sd 2.84 / コントラスト幅 6.8%）。つまり1次元のグラデーションを
引き伸ばした画像なので、`style.css` の `repeating-linear-gradient` で同等のものを
描いている（実測 sd 2.84 に対して 2.84）。

### 布石方策の重み

配布しているのは `models/fuseki_degct_b3_iter272.onnx`（布石専用ネット・648出力・
価値ヘッド無し）。**第三者の学習済みモデルを初期値にしていない。** 乱数初期化した
重みから出発し、やねうら王（`yaneuraou.k-p` 同梱の SuishoPetite）の探索結果だけを
教師信号にして自己対局で学習したものである。学習と検証の記録は非公開の開発リポジトリの
`docs/degct_plan.md` にある。

教師信号の出どころがやねうら王である以上、この重みは同エンジンの評価を蒸留したものと
いえる。やねうら王のWASMビルドは GPL-3.0 として配布されており（第3節）、こちらも
リポジトリと同じ GPL-3.0 で配る。

## 2. 配布していないもの

### GCT派生の重み

`models/fuseki_rollout_iter38.onnx` は
[dlshogi with GCT (WCSC31)](https://github.com/TadaoYamaoka/DeepLearningShogi/releases/tag/wcwc31)
の公開モデルを初期値として学習した派生物で、そのモデルには再配布の明文の許諾が無い。
`.gitignore` はファイル名を挙げて配布してよい重みだけを開けており、この重みは塞いだまま
である。手元で当てるときの `--model` は出力先を `dist-local/` に分けてあるので、
配布経路（`dist/`）には乗らない。

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
