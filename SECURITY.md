# セキュリティ

## 報告

**[Security → Report a vulnerability](https://github.com/kotenbu135/fuseki-shogi-web/security/advisories/new)**
（GitHub の非公開の報告窓口）を開けてあります。公開の Issue には書かないでください。
個人が趣味で運用しているサイトなので、返信は数日かかることがあります。

## この構成で守るもの

サイトは静的配信で、口座も個人情報も預かっていません。守る対象は2つです。

- **オンライン対局の部屋**（`worker/`、Cloudflare Workers + Durable Objects）。
  ここだけが状態を持ち、**呼ばれた分だけ課金される**。想定している脅威は棋譜の窃取ではなく
  請求で、対策は上限と数え上げ（README の「濫用への歯止め」）。
- **ブラウザに送るコード**。3つのWASMエンジンを動かすため COOP/COEP と
  `'wasm-unsafe-eval'` を許しているぶん、それ以外は Content-Security-Policy で閉じてある
  （`script-src` は自分と inline の sha256 だけ、`object-src`/`frame-ancestors`/`form-action` は `'none'`）。
  CSP は `build.mjs` が組み立てて `_headers` に書き出す。

対局の内容は部屋の Durable Object に載りますが、24時間で消えます。名前は入力したものが
そのまま相手と観戦者に見えます。ログイン・Cookie・アクセス解析の個人識別はありません。

## 対象外

- 布石AIが弱い・変な手を指す、といった**強さの問題**は脆弱性ではありません。Issue へどうぞ。
- 部屋の上限（1IPあたりの作成数など）に当たることは仕様です。数字は README にあります。
