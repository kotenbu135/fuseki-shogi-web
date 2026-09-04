// 布石方策のパリティ検証その1。ブラウザと同じ経路（WASMの特徴量 → onnxruntime-web）で
// 推論し、入力と出力をJSONに書き出す。
//
// parity_test.mjs が保証しているのは「WASMの特徴量がC++版と1ビットも違わない」ことまでで、
// **その特徴量を食わせたNNが本家と同じlogitを返すか**は誰も見ていない。ここがズレると
// AIは落ちずに弱くなるだけなので、UIのバグと区別できない。
//
//   node test/policy_probe.mjs policy_probe.json [局面数] [モデル.onnx]
//   python3 test/policy_parity.py policy_probe.json models/fuseki_degct_b3_iter272.onnx
//
// モデルは第3引数で差し替えられる（布石専用ネットの検証や、開発リポジトリ側に置いた
// 途中経過のONNXを当てるため）。省略すると従来どおり models/fuseki_degct_b3_iter272.onnx。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Fuseki } from '../src/fuseki.js';
import { FusekiPolicy } from '../src/policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = process.argv[2] || path.join(ROOT, 'policy_probe.json');
const SAMPLES = Number(process.argv[3] || 8);
const MODEL = process.argv[4] || path.join(ROOT, 'models/fuseki_degct_b3_iter272.onnx');

const fuseki = await Fuseki.load(pathToFileURL(path.join(ROOT, 'wasm/dist/fuseki.mjs')).href);
const policy = await FusekiPolicy.load({ model: new Uint8Array(fs.readFileSync(MODEL)) });

// 局面は固定の乱数で作る（Pythonの参照側は特徴量をそのまま受け取るので再現性は不要だが、
// 毎回違う局面を見た方が広く当たる）。
let seed = 20260901n;
const rng = () => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
  return Number(seed >> 40n) / 16777216;
};

const samples = [];
// 布石の序盤・中盤・終盤がまんべんなく入るよう、40手を等間隔でサンプリングする。
const targetPlies = new Set([...Array(SAMPLES)].map((_, i) => Math.floor((i + 1) * 40 / SAMPLES) - 1));
for (let ply = 0; ply < 40; ply++) {
  if (targetPlies.has(ply)) {
    const { input1, input2 } = fuseki.policyInputs();
    const { logits, value } = await policy.evaluate(fuseki);
    const legal = fuseki.legalDrops();
    const color = fuseki.turn;
    samples.push({
      ply, turn: color,
      input1: [...input1], input2: [...input2],
      logits: [...logits], value,
      // ラベル空間はモデルの出力次元で決まる（policy.js が判定した結果を使う）。
      // ここで moveLabel を決め打つと、布石専用ネットのときだけ 2268空間の
      // 添字で 648次元の配列を引いて、静かに undefined になる。
      legal: legal.map(d => ({ usi: d.usi, label: fuseki[policy.labelFn](d.pt, d.sq, color) })),
    });
  }
  const picked = await policy.pick(fuseki, { rng });
  fuseki.drop(picked.move);
}

fs.writeFileSync(OUT, JSON.stringify({
  model: path.basename(MODEL), labelFn: policy.labelFn, hasValue: policy.hasValue, samples,
}));
const bytes = fs.statSync(OUT).size;
console.log(`${samples.length}局面を ${OUT} に書き出した (${(bytes / 1024 / 1024).toFixed(1)}MB)`);
console.log(`方策の出力: ${policy.labelFn} / 価値ヘッド: ${policy.hasValue ? 'あり' : '無し'}`);
console.log(`照合: python3 test/policy_parity.py ${OUT} ${MODEL}`);
