# fuseki-shogi-web

[布石将棋](https://shogitter.com/rule/布石将棋)をブラウザだけで指せる対局サイト。
サーバーを持たず、静的配信だけで動く。

布石将棋は通常の将棋と違い、**空の盤に双方が交互に20枚ずつ打ってから指し始める**変則ルール。
41手目からは通常の将棋になる。この2つのフェーズを、別々のエンジンで担当させている。

| 担当 | 使うもの | ライセンス |
| --- | --- | --- |
| 盤UI | [shogiground](https://github.com/WandererXII/shogiground) | GPL-3.0-or-later |
| 通常将棋のルール・棋譜 | [shogiops](https://github.com/WandererXII/shogiops) | GPL-3.0-or-later |
| 布石フェーズのルール・特徴量 | `wasm/`（cppshogiをWebAssembly化） | GPL v3 |
| 布石フェーズのAI | 布石方策 + onnxruntime-web | — |
| 通常フェーズのAI | [@mizarjp/yaneuraou.k-p](https://www.npmjs.com/package/@mizarjp/yaneuraou.k-p) | GPL-3.0 |

布石フェーズはエンジン側も探索を行わず**1手あたりNN前向き1回**で指しているため、
ブラウザでも同じ手を再現できる。通常フェーズは素の将棋なので、やねうら王のWASMビルドに任せる。

## 構成

```
engine/dlshogi/   dlshogiのフォーク（submodule）。布石フェーズのmovegenと特徴量抽出
wasm/             cppshogiをEmscriptenでWASMにするビルド
test/             同一性の照合とスモークテスト
src/              対局画面（実装中）
models/           重みの置き場（コミットしない。models/README.md 参照）
```

`engine/dlshogi` をsubmoduleにしているのは、**ビルドに使ったソースのコミットIDが構成
そのものに記録される**ようにするため。GPL v3の「対応するソースの提供」は、バイナリと
対応したソースを指せて初めて意味を持つ。

## ビルド

```bash
git clone --recursive https://github.com/kotenbu135/fuseki-shogi-web.git
cd fuseki-shogi-web
npm install
source ~/emsdk/emsdk_env.sh && wasm/build.sh     # -> wasm/dist/fuseki.{mjs,wasm}
```

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
```

実測（`test/sample_sfens.jsonl` は実際の方策が作った41手目局面80件）:

- **照合 8880項目すべて一致**（legalDrops・62+59プレーンの特徴量・指し手ラベル・最終SFEN・玉の被利き）
- shogiops は 79/80 で局面を受理。唯一の失敗 `ERR_OPPOSITE_CHECK` は、41手目に勝敗が
  確定していて通常フェーズに入らない局面。**つまり拒否されるのは渡してはいけない局面だけ**
- やねうら王 K-P WASM は 12/12 で合法手を返し、`movetime 1000ms` / `Threads 2` で depth 13〜17

## 配信

**Cloudflare Pages**（無料・帯域無制限）。やねうら王のWASMが SharedArrayBuffer を使うため、
`_headers` で下記を立てる必要がある。GitHub Pages はヘッダを設定できないので使えない。

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
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

**学習済みモデルはこのリポジトリでは配布しない。** 理由は [models/README.md](models/README.md) を参照。
