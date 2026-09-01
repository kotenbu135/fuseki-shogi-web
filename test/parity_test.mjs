// WASM版 cppshogi が Python拡張版（parity_ref.py）と1ビットも違わないことを確認する。
import fs from 'node:fs';
import FusekiModule from '../wasm/dist/fuseki.mjs';

const M32 = 0xFFFFFFFFn, M64 = 0xFFFFFFFFFFFFFFFFn;
class Lcg {
  constructor(seed) { this.s = BigInt(seed) & M64; }
  next() { this.s = (this.s * 6364136223846793005n + 1442695040888963407n) & M64; return this.s >> 33n; }
}
const csumPairs = pairs => {
  let h = 0n;
  pairs.forEach(([pt, sq], i) => { h = (h + BigInt(i + 1) * BigInt(pt * 1000003 + sq * 31 + 7)) & M32; });
  return Number(h);
};
const csumFloats = arr => {
  let h = 0n, nz = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) { nz++; h = (h + BigInt(i + 1) * BigInt(Math.round(arr[i] * 1000))) & M32; }
  return [Number(h), nz];
};

const ref = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = Date.now();
const M = await FusekiModule();
console.log(`WASM初期化: ${Date.now() - t0}ms`);
const c = (n, r, a) => M.ccall(n, r, a || [], []);
const call = (n, r, at, av) => M.ccall(n, r, at, av);

M.ccall('fw_init', null, [], []);
const f1len = M.ccall('fw_features1_len', 'number', [], []);
const f2len = M.ccall('fw_features2_len', 'number', [], []);
const f1ptr = M.ccall('fw_features1_ptr', 'number', [], []);
const f2ptr = M.ccall('fw_features2_ptr', 'number', [], []);
console.log(`特徴量サイズ: features1=${f1len} (=${f1len / 81}プレーン x 81), features2=${f2len} (=${f2len / 81} x 81)`);

let mismatches = [], checks = 0;
const eq = (label, a, b, ctx) => { checks++; if (a !== b) mismatches.push(`${label}: wasm=${a} cpp=${b} @${ctx}`); };

const rng = new Lcg(ref.seed);
const tStart = Date.now();
for (const g of ref.data) {
  M.ccall('fw_reset', null, [], []);
  for (const p of g.plies) {
    const n = M.ccall('fw_legal_drops', 'number', [], []);
    const ptPtr = M.ccall('fw_drops_pt_ptr', 'number', [], []);
    const sqPtr = M.ccall('fw_drops_sq_ptr', 'number', [], []);
    const pts = M.HEAP32.subarray(ptPtr >> 2, (ptPtr >> 2) + n);
    const sqs = M.HEAP32.subarray(sqPtr >> 2, (sqPtr >> 2) + n);
    const legal = [...Array(n)].map((_, i) => [pts[i], sqs[i]]);
    M.ccall('fw_make_features', null, [], []);
    const [h1, nz1] = csumFloats(M.HEAPF32.subarray(f1ptr >> 2, (f1ptr >> 2) + f1len));
    const [h2, nz2] = csumFloats(M.HEAPF32.subarray(f2ptr >> 2, (f2ptr >> 2) + f2len));
    const color = M.ccall('fw_turn', 'number', [], []);
    let labels = 0n;
    legal.forEach(([pt, sq], i) => {
      labels = (labels + BigInt(i + 1) * BigInt(M.ccall('fw_move_label', 'number', ['number', 'number', 'number'], [pt, sq, color]) + 1)) & M32;
    });
    const ctx = `game=${g.game} ply=${p.ply}`;
    eq('ply', M.ccall('fw_ply', 'number', [], []), p.ply, ctx);
    eq('turn', color, p.turn, ctx);
    eq('legal数', n, p.n, ctx);
    eq('legal内容', csumPairs(legal), p.legal_csum, ctx);
    eq('features1', h1, p.f1_csum, ctx); eq('features1非零数', nz1, p.f1_nz, ctx);
    eq('features2', h2, p.f2_csum, ctx); eq('features2非零数', nz2, p.f2_nz, ctx);
    eq('moveLabel', Number(labels), p.label_csum, ctx);
    const idx = Number(rng.next() % BigInt(n));
    eq('LCG一致(pt)', legal[idx][0], p.pick[0], ctx);
    eq('LCG一致(sq)', legal[idx][1], p.pick[1], ctx);
    M.ccall('fw_do_drop', null, ['number', 'number'], legal[idx]);
  }
  const sfen = M.ccall('fw_to_sfen', 'string', [], []);
  eq('最終SFEN', sfen, g.sfen, `game=${g.game}`);
  eq('verifyFinalSfen', !!M.ccall('fw_verify_final_sfen', 'number', ['string'], [sfen]), g.verify, `game=${g.game}`);
  eq('玉の被利き(黒)', !!M.ccall('fw_is_king_attacked', 'number', ['number'], [0]), g.king_attacked[0], `game=${g.game}`);
  eq('玉の被利き(白)', !!M.ccall('fw_is_king_attacked', 'number', ['number'], [1]), g.king_attacked[1], `game=${g.game}`);
}
const ms = Date.now() - tStart;
console.log(`\n照合項目 ${checks} 件 / 不一致 ${mismatches.length} 件`);
mismatches.slice(0, 10).forEach(m => console.log('  NG ' + m));
const plies = ref.data.reduce((a, g) => a + g.plies.length, 0);
console.log(`${ref.data.length}局 x 40手 = ${plies}手 を ${ms}ms で照合 (1手あたり ${(ms / plies).toFixed(2)}ms、うち特徴量チェックサム計算が大半)`);
process.exit(mismatches.length ? 1 : 0);
