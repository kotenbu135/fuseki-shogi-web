// 布石フェーズのAI。1手あたりNNの前向き1回だけで指す（探索なし）。
//
// 手の選び方はエンジン側の MySearcher::goFuseki()（engine/dlshogi/usi/main.cpp）と
// 同じにしてある。合法手のラベルのlogitだけを集め、最大値を引いてexpし、
// 温度1でサンプリングする。argmaxにすると同じ布石ばかりになり棋風が別物になるため、
// ここを「決定的にした方が強そう」と変えないこと。
import * as ort from 'onnxruntime-web/wasm';

const PLANES1 = 62, PLANES2 = 59;

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
    return new FusekiPolicy(session);
  }

  constructor(session) { this.session = session; }

  /** 現局面の方策logitと勝率を返す。value は手番側から見た勝率（sigmoid済み）。 */
  async evaluate(fuseki) {
    const { input1, input2 } = fuseki.policyInputs();
    const out = await this.session.run({
      input1: new ort.Tensor('float32', input1, [1, PLANES1, 9, 9]),
      input2: new ort.Tensor('float32', input2, [1, PLANES2, 9, 9]),
    });
    return { logits: out.output_policy.data, value: out.output_value.data[0] };
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
      raw[i] = logits[fuseki.moveLabel(legal[i].pt, legal[i].sq, color)];
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
