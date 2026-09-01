# src/

対局画面。ビルドすると `dist/` に静的ファイル一式が出る（`node build.mjs`）。

| ファイル | 役割 |
| --- | --- |
| `main.js` | エントリ。3つのエンジンを起こし、アセットの場所を決め、Gameを回す |
| `game.js` | 対局の状態機械。**局面の真実はここだけが持つ**。41手目の裁定もここ |
| `fuseki.js` | `wasm/` のWASMラッパ。布石フェーズの合法手・利き・特徴量 |
| `policy.js` | 布石方策。onnxruntime-web で1手あたりNN前向き1回 |
| `normal.js` | やねうら王WASMとのUSIの往復 |
| `board.js` | [shogiground](https://github.com/WandererXII/shogiground) の生成とGameからの同期 |
| `index.html` / `style.css` | 画面。駒は画像を使わず、漢字＋`clip-path`でCSSだけで描いている |

## 守っていること

**41手目の裁定（手番側が相手玉を取れるなら手番側の勝ち）は、shogiops の Position を
作る前に適用する。** shogiops には chessops の `ignoreImpossibleCheck` 相当が無く、
その局面は `ERR_OPPOSITE_CHECK` で例外になる。裁定を後回しにすると「勝敗が確定した局面」が
「SFENの解析エラー」として出てくる。実装は `game.js` の `_transitionToNormal()`。

**布石フェーズのルールをJSに書かない。** 合法手も二歩回避の禁じ手も62プレーンの特徴量も
利きの判定も、すべて `wasm/` のC++（cppshogi）を呼ぶだけにしてある。書き直すとC++版と
静かにズレて、方策が「落ちないが弱い」という気付きにくい壊れ方をする。

**エンジンの `bestmove` をそのまま盤に適用しない。** 通常フェーズは
`Position.isLegal()` で照合してから進める。

## エンジンの読み込み方が3者で違う理由

バンドルするのは onnxruntime-web だけで、残り2つはコピーして置くだけにしている。
どちらもEmscripten製で、自分のスクリプトURLからの相対で `.wasm` / `.worker.js` を
探すため、バンドルに巻き込むと解決先が壊れる。

- `wasm/dist/fuseki.mjs` … `import.meta.url` 相対 → 動的importで読む
- `@mizarjp/yaneuraou.k-p` … `document.currentScript.src` 相対 → classic scriptで読む
- `onnxruntime-web` … JSグルーは同梱の bundle 版を使い、`.wasm` だけ `vendor/ort/` を指す
