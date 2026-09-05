# src/

対局画面。ビルドすると `dist/` に静的ファイル一式が出る（`node build.mjs`）。

| ファイル | 役割 |
| --- | --- |
| `main.js` | エントリ。3つのエンジンを起こし、アセットの場所を決め、Gameを回す。ホーム／対局画面の切り替え（ハッシュ）もここ |
| `i18n.js` | 文言の辞書（日本語・英語）。`<html lang>` で選ぶ。静的HTMLの `{{key}}` は build.mjs がこれで埋める |
| `game.js` | 対局の状態機械。**局面の真実はここだけが持つ**。41手目の裁定もここ |
| `fuseki.js` | `wasm/` のWASMラッパ。布石フェーズの合法手・利き・特徴量 |
| `policy.js` | 布石方策。onnxruntime-web で1手あたりNN前向き1回 |
| `kings.js` | 天秤将棋で両玉を置く・先後を選ぶ。両玉のマスの組の価値表（`models/king_pairs_*.json`）を引くだけ |
| `normal.js` | やねうら王WASMとのUSIの往復 |
| `net.js` | オンライン対局の部屋（`worker/`）との WebSocket。手順のトークンと結果だけを運び、切れたら繋ぎ直す。席のトークンを localStorage に控える |
| `board.js` | [shogiground](https://github.com/WandererXII/shogiground) の生成とGameからの同期 |
| `sound.js` | 対局音。音源は持たずWebAudioで合成する |
| `homeboard.js` | ホームの盤。自分専用の Fuseki（WASMをもう1つ）に方策で40手打たせ、canvas に駒を落として見せる。対局には関わらない |
| `og/` | 共有プレビュー（og:image）の画像2枚。`scripts/og.mjs` が固定シードの布石を描く。ビルドは写すだけ（Pages のビルド環境に Chrome が無い） |
| `pieces/` | 駒の画像30枚（kanji_light / CC BY 4.0。[THIRD_PARTY.md](../THIRD_PARTY.md)） |
| `index.html` / `style.css` | 画面（テンプレート。`{{key}}` を build.mjs が2言語に展開する）。見た目は lishogi に寄せてある（下記） |
| `page.html` / `pages/<lang>/` | ルールとコラムのページ。殻と中身 |

## 画面の作り

**ホームと対局画面は同じページの2つの `<main>`**で、URL のハッシュ（`#/` と `#play`）で
切り替える。対局中にロゴやメニューの「対局」を押すと確認を出し、やめれば対局は消える
（局面は保存しない）。

**右のパネルは固定スロットの grid**（広い画面）。席・フェーズ帯・状態・操作・棋譜・グラフ・
エンジン・席の8行で、`minmax(0,1fr)` の棋譜の行だけが余りを取り、内側でスクロールする。操作の枠は
`#panel[data-state]`（play / choose / over / analyze）で中身を入れ替え、枠は消さない。
`hidden` の出し入れで高さが動く作りにしないこと。**`hidden` になりうる要素（グラフ・エンジン枠）は
棋譜より後ろに置く。** grid は `display:none` の子を数えないので、前に置くと棋譜が `auto` の行へ
落ちて潰れる（実際に起きた）。狭い画面では `display: contents` で `.layout` の直接の子に
並べ替える（席・盤・帯・状態・操作・棋譜・グラフ・エンジン・席の順）。

**盤の上に重ねるものは3つ**（`.board-column` の中、shogiground の外）。先後を選ぶときの両玉の札と輪（`#king-tags`）、
段の境目の幕（`#toast`。先後が決まった・41手目。盤の中央に1.6秒）、終局の帯（`#result-banner`。結果と
もう一局・検討。1局に一度、5秒か盤を押すまで）。強い動きはこの2つの境目にだけ使い、ほかは静かなまま。
布石フェーズは手番側の陣（置ける四段）を `.sg-wrap.zone-bottom / .zone-top` で淡く塗る（`sq` の並びは表示上の
位置なので、手前の4段は46番目から）。特異度は `:where()` で `sq` と同じに落とし、last-dest などの塗りに負けるようにしてある。

**天秤将棋では、両玉を置いた人と先後は一致しない**ので、席の名前だけでは3手目を過ぎると思い出せない。
先後が決まってから終局まで、席の名前の隣に役の札（`.seat-role`）を出し、棋譜の枠の上に見出し行（`#kifu-head`。
書き出しの見出しと同じ文＋誰がどちらを持ったか）を置く。AIが両玉を置いている間の状態欄は「あなたは選ぶ役」と言う
（役をランダムにした人が自分の役を知る最初の場面）。

**評価は棋譜の行ごとに持つ**（`kifu[i].eval`。その手を指した後の局面の値、**常に先手から見た値**）。
やねうら王の探索1回で2行が埋まる: 根の値は直前の手の行、同じ値をAIの手の行にも写す
（bestmove は読み筋の先頭で、根の値はその手を指した先の値）。人間の手番の解析と検討は
`source: 'analysis'` で上書きする。布石の手には評価が無い（やねうら王には渡せず、方策に価値ヘッドも無い）。
天秤将棋の2手目だけ価値表の値（`kind: 'kings'`）。さかのぼって見ているときはその行の評価を出す。

**評価グラフ**（`#eval-chart`）は inline SVG を `renderChart()` が1手ごとに描き直す。縦軸は
先手の勝率で、ゲージと同じ換算（`winRateOf`）。押す・なぞるとその手へ。

**観戦（AI同士）**は `Game` の `spectate: true`。人間の色も役も無く `isHumanTurn` が常に偽なので、
`drive()` が終局まで回る。布石は1手 0.7 秒の下限を置く（NN1回は10msで、40手が1秒で終わる）。
待った・投了の代わりに一時停止・中断。評価は常に出す。

**検討**（終局後）は `analysis` の状態で、見ている局面を `go infinite`（MultiPV 3）で読み続ける。
盤の駒はどちらの色も動かせ、指した手は本譜の下に変化として1本だけ並ぶ（木は作らない。
本譜を動くと変化は捨てる）。局面は `Game.positionAt(row)` から変化を再生して作り、`Game` の状態は
触らない。布石の局面は2つ目の `Fuseki`（WASMをもう1つ起こす）に手順を入れ直して方策の候補手だけ出す。
「全手を解析」は読み続ける検討を止めて1手0.3秒で埋め、終わったら戻る（エンジンは1つなので並走しない）。

**先後の選択は盤の玉を押す**。shogiground は触れない駒の mousedown を握るので、
`#board` の `pointerup` の座標からマスを引き当てる（`keyAtPoint`）。押した玉は仮
（`pendingSide`）で、盤がその玉が手前に来るよう回り、「◯◯を持って始める」で確定する。
両玉の札と輪は盤の中に置かず（shogiground の持ち物）、`.board-column` に重ねて矩形を測って書く。

**言語は `<html lang>` で決まる**（`i18n.js` の `LANG`）。実行時の文言は `t(key, params)`、
棋譜の表記は `Game` の `notation` オプション。実行中に言語を切り替える口は無い。

**オンライン対局（友達と対局）**は `Game({ opponent: 'remote' })`。AIは指さず、相手の手は部屋から
`moved` で届いて `game.play(token)` で入る（`drive()` は remote なら何もしない）。自分の手は手元で先に
適用してから部屋へ送り、断られたらその手を `undoTo` で戻す。繋ぎ直すたびに `state` が丸ごと来るので
`syncTokens()` が手順を突き合わせ、足りないぶんを足す（違っていれば `undoTo(0)` から作り直す）。
時計は部屋が席ごとに持つ値を `onlineRemaining()` が補間して出すだけで、切れの判定は部屋。
相手を待っているあいだはパネルの状態が `wait`（招待リンク）で、盤は `showIdleBoard` のまま。
URL は `#room/<id>`。同じリンクで戻ると席のトークン（localStorage）で確認なしに同じ席へ着く。
相手の呼び名（AI／相手）は `them()` / `Them()` / `themShort()` で引き、辞書の `{them}` に入る。

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

**1つのエンジンに `go` を重ねない。** `normal.js` は探索を promise の鎖（`_chain`）で
1本ずつ流す。検討の `go infinite` は鎖を塞ぐので、次の探索を積む前に必ず `stopInfinite()`
を呼ぶ。止めた時点でまだ始まっていない検討は世代（`_infGen`）で捨てる。`setoption` も
鎖に乗せる（探索中に送ると版によって捨てられる）。

## 見た目をlishogiに寄せるときに踏んだところ

**駒台は `hands.inlined: true` で shogiground に作らせる。** false（既定）だと
駒台がHTML側の別の要素に生えて、盤と同じ `.sg-wrap` の中に入らない。lishogi の
`grid-template-areas` は `.sg-wrap` 直下の3要素に掛かるので、その構造では
どうやっても駒台を盤の左右に回せない。

**後手の駒をCSSで回さない。** shogiground は駒の位置を transform の translate で
与えており、CSSの合成順は translate → rotate なので、駒を回すと後から掛かる
translate が回転後の座標系で効いて駒が盤の外へ飛ぶ。駒セットに入っている
回転済みの別ファイル（`1*.svg`）を使う。

**座標は盤の外に出す（広い画面）。** lishogi の既定は `Coords.OUTSIDE`
（`modules/pref/src/main/Pref.scala`）で、`_coords.scss` の内側の指定は狭い画面用。
狭い画面では外に出す余地が無いので内側に置くが、そのときは白抜きにしないこと。
盤（#f9b34e）に対して1.81:1、駒地に対して1.18:1しかなく読めない。濃い色に
明るい縁を付けると盤で7.6:1、駒地で11.7:1になる。

筋の数字が後手の駒台に潜り込んでいたのは座標の置き場所の問題ではなく、駒台が
`.sg-wrap` の外の別要素に生えていたせい（上の `hands.inlined` を参照）。

**盤は幅だけでなく画面の高さでも頭を押さえる。** 1366x768 のような横長の画面で
盤の下端が画面の外に出て、1手指すたびにスクロールすることになる。lishogi も
`100vh` から引いている。`.sg-wrap` の高さは幅の 9/11（左右の駒台ぶん）。

**駒画像は `image/svg+xml` で配る。** `application/octet-stream` になると
ブラウザがデコードせず、要素は在るのに盤が空に見える。DOMの数え上げでは
すり抜けるので、`browser_smoke.mjs` が実際に `Image` で読ませて確かめる。
配信側は `_headers` で明示している。

**対局前の盤に `viewOnly` を使わない。** shogiground の `set()` は
`forceRedrawProps` を `cRes &&` で判定していて偽値を弾くため、`true → false` の
切り替えが落ちる。すると対局開始後もドラッグ用のDOMが生えてこない。
`activeColor` を空にすれば盤は触れなくなる。

**棋譜をさかのぼるのは指し手の再生ではなく、1手ごとの控え。** 布石フェーズには
shogiops の Position が無く（盤は `boardPieces` の Map）、通常フェーズも41手目の
局面を作り直す必要がある。指し手から再生しようとすると、この継ぎ目に再生専用の
経路がもう1本生えて、対局の側と静かにズレる。`Game._snapshot()` がそのときの盤と
駒台をそのまま取っておく（1局200手でも数十KB）。40手目の控えは
`_transitionToNormal()` の**前**に取ること。41手目の裁定より前の姿でなければならない。

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
