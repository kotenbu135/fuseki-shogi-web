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
| `sound.js` | 対局音。音源は持たずWebAudioで合成する |
| `pieces/` | 駒の画像30枚（kanji_light / CC BY 4.0。[THIRD_PARTY.md](../THIRD_PARTY.md)） |
| `index.html` / `style.css` | 画面。見た目は lishogi に寄せてある（下記） |

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

## 見た目をlishogiに寄せるときに踏んだところ

**駒台は `hands.inlined: true` で shogiground に作らせる。** false（既定）だと
駒台がHTML側の別の要素に生えて、盤と同じ `.sg-wrap` の中に入らない。lishogi の
`grid-template-areas` は `.sg-wrap` 直下の3要素に掛かるので、その構造では
どうやっても駒台を盤の左右に回せない。

**後手の駒をCSSで回さない。** shogiground は駒の位置を transform の translate で
与えており、CSSの合成順は translate → rotate なので、駒を回すと後から掛かる
translate が回転後の座標系で効いて駒が盤の外へ飛ぶ。駒セットに入っている
回転済みの別ファイル（`1*.svg`）を使う。

**座標は盤の内側に置く。** 盤の外へ負のオフセットで出すと、上下に駒台が来たときに
重なる（実際に筋の数字が後手の駒台に潜り込んでいた）。

**駒画像は `image/svg+xml` で配る。** `application/octet-stream` になると
ブラウザがデコードせず、要素は在るのに盤が空に見える。DOMの数え上げでは
すり抜けるので、`browser_smoke.mjs` が実際に `Image` で読ませて確かめる。
配信側は `_headers` で明示している。

**対局前の盤に `viewOnly` を使わない。** shogiground の `set()` は
`forceRedrawProps` を `cRes &&` で判定していて偽値を弾くため、`true → false` の
切り替えが落ちる。すると対局開始後もドラッグ用のDOMが生えてこない。
`activeColor` を空にすれば盤は触れなくなる。

**盤の木目はCSSで描く。** lishogi の盤画像は AGPLv3+ で、駒セットの CC BY 4.0 とは
別のライセンス。既定盤 `wood.png` は縦方向に一様な縞なので `repeating-linear-gradient`
で同等のものが出る（[THIRD_PARTY.md](../THIRD_PARTY.md) に実測値）。

## エンジンの読み込み方が3者で違う理由

バンドルするのは onnxruntime-web だけで、残り2つはコピーして置くだけにしている。
どちらもEmscripten製で、自分のスクリプトURLからの相対で `.wasm` / `.worker.js` を
探すため、バンドルに巻き込むと解決先が壊れる。

- `wasm/dist/fuseki.mjs` … `import.meta.url` 相対 → 動的importで読む
- `@mizarjp/yaneuraou.k-p` … `document.currentScript.src` 相対 → classic scriptで読む
- `onnxruntime-web` … JSグルーは同梱の bundle 版を使い、`.wasm` だけ `vendor/ort/` を指す
