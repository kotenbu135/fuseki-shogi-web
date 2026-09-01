// 布石フェーズのAI。1手あたりNNの前向き1回だけで指す（探索なし）。
//
// 手の選び方はエンジン側の MySearcher::goFuseki()（engine/dlshogi/usi/main.cpp）と
// 同じにしてある。合法手のラベルのlogitだけを集め、最大値を引いてexpし、
// 温度1でサンプリングする。argmaxにすると同じ布石ばかりになり棋風が別物になるため、
// ここを「決定的にした方が強そう」と変えないこと。
import * as ort from 'onnxruntime-web/wasm';

const PLANES1 = 62, PLANES2 = 59;
// 方策出力の次元でラベル空間を見分ける。2268 = 28スロット×81（resnet10_swish系、
// 通常フェーズと共有）、648 = 8スロット×81（布石専用ネット）。
// **旗（コンストラクタ引数や設定）にしないこと。** 288/648/2268の取り違えは、
// 落ちずにargmaxだけが別の手になる壊れ方をするので、判定する場所を1つに閉じる。
const LABEL_DIMS = { 2268: 'moveLabel', 648: 'compactLabel' };

export class FusekiPolicy {
  /**
   * @param {string|Uint8Array} model 重みのURL、またはその中身。
   * @param {string|object} [wasmPaths] onnxruntime-web の .wasm の場所。
   * @param {number} [numThreads] SharedArrayBufferが無い環境では1に落ちる。
   */
  static async load({ model, wasmPaths, numThreads = 1 }) {
    if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = numThreads;
    ort.env.logLevel = 'error';
    let session;
    try {
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    } catch (e) {
      // 公開デプロイには重みを載せていない（models/README.md）。404をスタックトレースで
      // 出すと原因が分からないので、何が足りないかを言って止まる。
      throw new Error(`布石方策を読み込めなかった。models/ に重みがあるか、`
        + `vendor/ort/ にonnxruntime-webの.wasmがあるかを確認する: ${e.message}`);
    }
    for (const name of ['input1', 'input2'])
      if (!session.inputNames.includes(name)) throw new Error(`ONNXの入力 ${name} が無い: ${session.inputNames}`);

    // ラベル空間と価値ヘッドの有無をモデル自身から判定する。出力の形は
    // session.outputNames だけでは分からないので、零入力で1回だけ前向きする
    // （1.95MBのネットで数ms。読み込み時の1回きり）。
    const probe = await session.run({
      input1: new ort.Tensor('float32', new Float32Array(PLANES1 * 81), [1, PLANES1, 9, 9]),
      input2: new ort.Tensor('float32', new Float32Array(PLANES2 * 81), [1, PLANES2, 9, 9]),
    });
    const dim = probe.output_policy.dims[1];
    const labelFn = LABEL_DIMS[dim];
    if (!labelFn) throw new Error(`方策出力の次元 ${dim} に対応するラベル空間が無い`
      + `（既知: ${Object.keys(LABEL_DIMS).join(', ')}）`);
    const hasValue = session.outputNames.includes('output_value');
    return new FusekiPolicy(session, labelFn, hasValue);
  }

  /**
   * @param {string} labelFn Fuseki側のラベル関数名（'moveLabel' か 'compactLabel'）。
   * @param {boolean} hasValue 価値ヘッドの有無。布石専用ネットには無い（採点はやねうら王）。
   */
  constructor(session, labelFn = 'moveLabel', hasValue = true) {
    this.session = session;
    this.labelFn = labelFn;
    this.hasValue = hasValue;
  }

  /**
   * 現局面の方策logitと勝率を返す。value は手番側から見た勝率（sigmoid済み）。
   * 価値ヘッドを持たないネットでは value は null になる。
   */
  async evaluate(fuseki) {
    const { input1, input2 } = fuseki.policyInputs();
    const out = await this.session.run({
      input1: new ort.Tensor('float32', input1, [1, PLANES1, 9, 9]),
      input2: new ort.Tensor('float32', input2, [1, PLANES2, 9, 9]),
    });
    return {
      logits: out.output_policy.data,
      value: this.hasValue ? out.output_value.data[0] : null,
    };
  }

  /**
   * 1手選ぶ。goFuseki() と同じ softmax サンプリング。
   * @returns {{move: object, probability: number, value: number, candidates: object[]}}
   */
  async pick(fuseki, { temperature = 1, rng = Math.random } = {}) {
    const legal = fuseki.legalDrops();
    if (legal.length === 0) throw new Error('布石フェーズで合法手が0（movegenの不変条件が破れている）');

    const { logits, value } = await this.evaluate(fuseki);
    const color = fuseki.turn;

    let maxLogit = -Infinity;
    const raw = new Float64Array(legal.length);
    for (let i = 0; i < legal.length; i++) {
      raw[i] = logits[fuseki[this.labelFn](legal[i].pt, legal[i].sq, color)];
      if (raw[i] > maxLogit) maxLogit = raw[i];
    }
    let total = 0;
    const probs = new Float64Array(legal.length);
    for (let i = 0; i < legal.length; i++) {
      probs[i] = Math.exp((raw[i] - maxLogit) / temperature);
      total += probs[i];
    }

    let r = rng() * total, chosen = legal.length - 1;
    for (let i = 0; i < legal.length; i++) {
      r -= probs[i];
      if (r <= 0) { chosen = i; break; }
    }

    const candidates = legal
      .map((move, i) => ({ move, probability: probs[i] / total }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5);

    return { move: legal[chosen], probability: probs[chosen] / total, value, candidates };
  }
}
