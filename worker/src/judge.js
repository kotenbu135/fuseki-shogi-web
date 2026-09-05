// 部屋の中で局面を持ち、合法性と終局を判定する（段2の「サーバー側の検証」）。
//
// ブラウザと**同じ** Game（src/game.js）と布石のWASM（wasm/dist）を Workers で動かす。
// ルールを2度書かない。cppshogi の合法手・二歩回避の禁じ手・41手目の裁定・
// shogiops の詰み・千日手が、ブラウザと1ビットも違わずここでも効く。
//
// Workers は実行時に WebAssembly.instantiate(bytes) を許さない。.wasm はモジュールとして
// import し（wrangler が CompiledWasm として束ねる）、Emscripten の instantiateWasm フックで渡す。
// グルーは ENVIRONMENT=web で作った fuseki-worker.mjs（wasm/build.sh）。ブラウザ用の
// web,worker,node のグルーは workerd で node と誤認して import.meta.url を要求し、落ちる。
import FusekiModule from '../../wasm/dist/fuseki-worker.mjs';
import fusekiWasm from '../../wasm/dist/fuseki.wasm';
import { Fuseki } from '../../src/fuseki.js';
import { Game } from '../../src/game.js';

/**
 * 判定役の Game を作り、手順を入れる。手順のどれかが入らなければ例外
 * （部屋の手順が壊れている。部屋はその場合、検証なしで続ける）。
 */
export async function newJudge({ mode, tokens }) {
  const fuseki = await Fuseki.create(FusekiModule, {
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(fusekiWasm, imports);
      done(instance);
      return instance.exports;
    },
  });
  // 人間の色・役は判定には関係ない。コンストラクタが要求する形だけ満たす。
  const game = new Game({
    fuseki, policy: null, engine: null, opponent: 'remote', mode,
    humanColor: 'sente', humanRole: mode === 'kings-first' ? 'placer' : null, notation: 'en',
  });
  for (const t of tokens) game.play(t);
  return game;
}
