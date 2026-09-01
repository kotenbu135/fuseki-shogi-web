# src/

対局画面の実装（これから作る）。

- 盤UI: [shogiground](https://github.com/WandererXII/shogiground)
- 布石フェーズ: `wasm/` のWASMが合法手と特徴量を出し、onnxruntime-web が方策を1手1回推論する
- 通常フェーズ: [@mizarjp/yaneuraou.k-p](https://www.npmjs.com/package/@mizarjp/yaneuraou.k-p)

**41手目の裁定（手番側が相手玉を取れるなら手番側の勝ち）は、shogiops の Position を
作る前に適用すること。** shogiops には chessops の `ignoreImpossibleCheck` 相当が無く、
その局面は `ERR_OPPOSITE_CHECK` で例外になる。
