// 布石フェーズの評価値。1手あたりNNの前向き1回。
//
// **なぜ別のネットが要るのか。** 布石中の局面はやねうら王に渡せない。SFENが作れない
// （布石フェーズに Position が無い）だけでなく、玉が相手の利きに当たっている局面が
// 普通に出る——通常将棋の指し手生成は「相手玉が取れる局面は非合法」を前提に組まれて
// いるので、渡すのは未定義動作である（docs/rules.md「41手目の裁定」）。
//
// このネットは SFEN を要求しない。入力は方策とまったく同じ特徴量の面
// （input1 62面 + input2 59面）で、policy.js が毎手すでに作っている。同じテンソルを
// 渡すだけなので、増えるのは前向き計算1回ぶんだけ。
//
// 出力 output_value は**手番側から見た勝率のlogit**。sigmoid を掛けてから、手番で
// 先手視点へ直す。学習は開発リポジトリの scripts/train_value_mid.py（--stm-label）。
import * as ort from 'onnxruntime-web/wasm';
import { BLACK } from './fuseki.js';

const PLANES1 = 62, PLANES2 = 59;

export class FusekiValue {
  /**
   * @param {string|Uint8Array} model 重みのURL、またはその中身。
   * @param {string|object} [wasmPaths] onnxruntime-web の .wasm の場所。policy.js が先に
   *   読み込んでいれば ort.env は共有されるので、通常は渡さなくてよい。
   */
  static async load({ model, wasmPaths }) {
    if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    for (const name of ['input1', 'input2'])
      if (!session.inputNames.includes(name)) throw new Error(`ONNXの入力 ${name} が無い: ${session.inputNames}`);
    if (!session.outputNames.includes('output_value'))
      throw new Error(`価値ネットに output_value が無い: ${session.outputNames}`);
    return new FusekiValue(session);
  }

  constructor(session) { this.session = session; }

  /**
   * いまの布石局面の**先手勝率**（0〜1）。
   *
   * 序盤ほど当たらない。開発リポジトリの実測（iter1400以降のheld-out）で
   * AUC は t=2-5 で 0.61、t=34-39 で 0.76。表示する側はそれを踏まえること。
   *
   * @param {import('./fuseki.js').Fuseki} fuseki
   * @returns {Promise<number>} 先手から見た勝率
   */
  async winRate(fuseki) {
    const { input1, input2 } = fuseki.policyInputs();
    const out = await this.session.run({
      input1: new ort.Tensor('float32', input1, [1, PLANES1, 9, 9]),
      input2: new ort.Tensor('float32', input2, [1, PLANES2, 9, 9]),
    });
    const p = 1 / (1 + Math.exp(-out.output_value.data[0]));
    return fuseki.turn === BLACK ? p : 1 - p;
  }
}
