# fuseki-shogi-web

[布石将棋](https://shogitter.com/rule/布石将棋)をブラウザだけで指せる対局サイト。
サーバーを持たず、静的配信だけで動く。

布石将棋は通常の将棋と違い、**空の盤に双方が交互に20枚ずつ打ってから指し始める**変則ルール。
41手目からは通常の将棋になる。この2つのフェーズを、別々のエンジンで担当させている。

| 担当 | 使うもの | ライセンス |
| --- | --- | --- |
| 盤UI | [shogiground](https://github.com/WandererXII/shogiground) | GPL-3.0-or-later |
| 駒の画像 | lishogi の駒セット kanji_light（[Ka-hu](https://github.com/Ka-hu)） | CC BY 4.0 |
| 通常将棋のルール・棋譜 | [shogiops](https://github.com/WandererXII/shogiops) | GPL-3.0-or-later |
| 布石フェーズのルール・特徴量 | `wasm/`（cppshogiをWebAssembly化） | GPL v3 |
| 布石フェーズのAI | 布石方策 + [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT |
| 通常フェーズのAI | [@mizarjp/yaneuraou.k-p](https://www.npmjs.com/package/@mizarjp/yaneuraou.k-p) | GPL-3.0 |

布石フェーズはエンジン側も探索を行わず**1手あたりNN前向き1回**で指しているため、
ブラウザでも同じ手を再現できる。通常フェーズは素の将棋なので、やねうら王のWASMビルドに任せる。

盤と駒台の見た目・操作は lishogi に寄せてある（踏んだところは
[src/README.md](src/README.md)）。盤の木目と対局音は素材を持たず、
CSSとWebAudioで生成している（理由は [THIRD_PARTY.md](THIRD_PARTY.md)）。

## 構成

```
engine/dlshogi/   dlshogiのフォーク（submodule）。布石フェーズのmovegenと特徴量抽出
wasm/             cppshogiをEmscriptenでWASMにするビルド
src/              対局画面（src/README.md 参照）。駒の画像は src/pieces/
test/             同一性の照合とスモークテスト
models/           布石方策の重み。再配布できるものだけコミットする（models/README.md）
build.mjs         src/ と3つのエンジンのアセットを dist/ にまとめる
serve.mjs         dist/ をCOOP/COEP付きでローカルに配る
```

`engine/dlshogi` をsubmoduleにしているのは、**ビルドに使ったソースのコミットIDが構成
そのものに記録される**ようにするため。GPL v3の「対応するソースの提供」は、バイナリと
対応したソースを指せて初めて意味を持つ。

## デプロイ（Cloudflare Pages）

静的配信だけで動くが、**COOP/COEPヘッダを返せるホストが要る**。やねうら王のWASMが
SharedArrayBufferを使うため。GitHub Pagesはヘッダを設定できないので使えない。
Cloudflare Pagesは `_headers` を読むので、ビルド出力にコピーしている。

Gitインテグレーション（Pagesがリポジトリを直接ビルドする）を使う。

| 設定 | 値 |
| --- | --- |
| リポジトリ | `kotenbu135/fuseki-shogi-web` |
| ビルドコマンド | `npm run build` |
| 出力ディレクトリ | `dist` |
| 環境変数 | `NODE_VERSION` = `22` |

`wrangler pages deploy` や手元の `dist/` のドラッグ＆ドロップは使わない。
Pages側がリポジトリをcloneしてビルドすれば、ビルド環境に存在するのは**コミットしてある
重みだけ**になる。再配布できない重み（`models/README.md`）は `.gitignore` で塞いだままなので、
手元の操作ミスでそれが配布される経路が消える。

Emscriptenはビルド環境に無いので、`wasm/dist/*` はコミットしてある（[THIRD_PARTY.md](THIRD_PARTY.md)）。

`models/` に重みがあれば `index.html` は対局画面になる。重みが見つからないビルド
（クローンし損ねた等）では布石フェーズを指せないので、`index.html` は準備中ページ
（`src/soon.html`）に切り替わる。このページは疎通診断を兼ねていて、
`crossOriginIsolated` とエンジン2つの起動を実ブラウザで確かめられる。
対局画面はどちらの場合も `play.html` にも置かれる（重みを載せていなかった頃のURLが
404にならないようにするため）。

## ビルド

```bash
git clone --recursive https://github.com/kotenbu135/fuseki-shogi-web.git
cd fuseki-shogi-web
npm install
source ~/emsdk/emsdk_env.sh && wasm/build.sh     # -> wasm/dist/fuseki.{mjs,wasm}
npm start                                        # -> dist/ を作って http://localhost:8080/
```

`npm start` は `node build.mjs` と `node serve.mjs` を続けて実行する。ローカルでも
COOP/COEPが要るので、`dist/` を普通の静的サーバで開くとやねうら王が起動しない
（`serve.mjs` はその2行を立てる）。

バンドラを1本だけ入れているのは、shogiops が `@badrap/result` をbare specifierで
引いていて素のESMではブラウザが解決できないため。バンドルするのは `src/` と
shogiground・shogiops・onnxruntime-web で、布石WASMとやねうら王は
**コピーして置くだけ**にしている（理由は [src/README.md](src/README.md)）。

WASMは **209KB + 63KB**、初期化8ms、movegen＋特徴量が1手0.1ms。

ビルド上の注意が2点ある。`emcc` ではなく `em++` を使うこと（libc++がリンクされず
`operator new` が未定義になる）。EmscriptenのSSE4.2エミュレーションに `_mm_popcnt_u64`
が無いので `wasm/wasm_shim.h` で補っていること。CUDA依存は `#ifdef FP16` の中だけなので、
FP16を定義しなければ何も要らない。

## テスト

```bash
# WASM版とC++版が1ビットも違わないことの照合（要: dlshogiのPython拡張）
python3 test/gen_parity_ref.py parity_ref.json
node test/parity_test.mjs parity_ref.json

# 41手目局面に対する shogiops / やねうら王WASM の挙動
node test/shogiops_smoke.mjs test/sample_sfens.jsonl
node test/yaneuraou_smoke.mjs test/sample_sfens.jsonl 12 1000

# 布石方策が本家と同じlogitを返すか（onnxruntime-web ↔ Python onnxruntime）
node test/policy_probe.mjs policy_probe.json
python3 test/policy_parity.py policy_probe.json models/fuseki_degct_b3_iter4.onnx

# 41手目の裁定が shogiops の Position より前に効いていること
node test/adjudication_test.mjs

# 対局画面の経路を1局通す（布石40手 → 41手目の裁定 → 通常フェーズ）
node test/pipeline_smoke.mjs

# 実際のブラウザで dist/ を開いて対局が始まるところまで
node build.mjs && node test/browser_smoke.mjs

# 終局した Game から表示に使う値が取り出せるか（ブラウザもエンジンも不要・数秒）
node test/game_terminal_test.mjs
```

実測（`test/sample_sfens.jsonl` は実際の方策が作った41手目局面80件）:

- **照合 8880項目すべて一致**（legalDrops・62+59プレーンの特徴量・指し手ラベル・最終SFEN・玉の被利き）
- shogiops は 79/80 で局面を受理。唯一の失敗 `ERR_OPPOSITE_CHECK` は、41手目に勝敗が
  確定していて通常フェーズに入らない局面。**つまり拒否されるのは渡してはいけない局面だけ**
- やねうら王 K-P WASM は 12/12 で合法手を返し、`movetime 1000ms` / `Threads 2` で depth 13〜17

`game_terminal_test.mjs` は「布石フェーズのまま終局した Game」を直接組み立てる。
この状態は phase が `'over'` で position が `null` になり、表示の取り出し口が phase で
分岐していると `makeSfen(null)` で落ちる（盤が固まり、新規対局も始められなくなる）。
入る道は**布石フェーズでの投了**と**41手目の裁定での決着**の2つで、後者は
「40手完了時点で手番側が相手玉を取れる形」なので普通に起こる。どちらもAIの指し手
次第でしか再現できないので、道ではなく状態を作って不変条件を留めている。

`parity_test.mjs` が保証するのは「WASMの特徴量がC++版と一致すること」までで、その特徴量を
食わせたNNが同じlogitを返すかは別問題になる。ここがズレるとAIは落ちずに弱くなるだけなので、
`policy_probe.mjs` + `policy_parity.py` で分けて見ている（実測: 8局面で **logit最大差
7.9e-06 / value最大差 6.6e-07**、選ぶ手の不一致なし）。

`adjudication_test.mjs` は一様乱数で40手打つのを繰り返し、**裁定が実際に発火した局面**に対して
「Gameは `fuseki_king_capture` で終局する」「その局面はshogiopsが `ERR_OPPOSITE_CHECK` で
弾く」の両方を見る（実測: 60局中7局で発火）。順序を入れ替えると後者が例外になって表に出る。

`pipeline_smoke.mjs` は `src/` のモジュールをブラウザと同じ順で呼ぶ（onnxruntime-web の
wasmバックエンドはNodeでも動く）。実測で布石40手が **1.2秒（1手31ms）**、通常フェーズは
`movetime` どおり。`browser_smoke.mjs` はそこで見られない部分だけ
—— COOP/COEPとSharedArrayBuffer、`vendor/` のアセット解決、shogigroundの描画 —— を
Chromeを起こして確認する。

## 配信

**Cloudflare Pages**（無料・帯域無制限）。配るのは `node build.mjs` が作る `dist/` で、
`_headers` もその中に入る。やねうら王のWASMが SharedArrayBuffer を使うため、
下記を立てる必要がある。GitHub Pages はヘッダを設定できないので使えない。

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### distに入るのは配布してよい重みだけ

`node build.mjs` が `dist/` へ入れるのは `models/` にコミットしてある重み
（[models/README.md](models/README.md)）に限られる。再配布できない重みを手元で当てる
ときは `--model` で指定する。出力先が分かれるので、配布経路に混ざらない。

```bash
node build.mjs                                            # デプロイ用。dist/
node build.mjs --model models/fuseki_rollout_iter38.onnx  # dist-local/。配ってはいけない
```

## ライセンス

Copyright (C) 2026 kotenbu

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program.
If not, see <https://www.gnu.org/licenses/>.

ブラウザへJavaScriptとWebAssemblyを送ることはGPLにおける**配布**にあたるため、
このリポジトリを公開してソースを提供している。同梱・利用する第三者の成果物は上表のとおりで、
やねうら王のWASMビルドは評価関数 **SuishoPetite(2021-11)**（たややん氏提供）を内蔵している。

**布石方策の重みは、再配布できるものだけを配布している。** 何を置いてよいかは
[models/README.md](models/README.md) を参照。
