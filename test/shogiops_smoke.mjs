import fs from 'node:fs';
import { parseSfen, makeSfen } from 'shogiops/sfen';
import { makeUsi, parseUsi } from 'shogiops/util';

const recs = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
let strictOk = 0, looseOk = 0;
const failures = [];
for (const r of recs) {
  for (const strict of [true, false]) {
    const res = parseSfen('standard', r.sfen, strict);
    if (res.isOk) { strict ? strictOk++ : looseOk++; }
    else failures.push({ strict, sfen: r.sfen, kc: r.king_capturable, err: String(res.error) });
  }
}
console.log(`局面数: ${recs.length}`);
console.log(`parseSfen strict=true  成功: ${strictOk}/${recs.length}`);
console.log(`parseSfen strict=false 成功: ${looseOk}/${recs.length}`);
for (const f of failures.slice(0, 10)) console.log(`  NG strict=${f.strict} kc=${f.kc} ${f.err}\n     ${f.sfen}`);

// 合法手生成とラウンドトリップ
let totalMoves = 0, minMoves = 1e9, roundtripOk = 0, playOk = 0;
for (const r of recs) {
  const pr = parseSfen('standard', r.sfen, false);
  if (!pr.isOk) continue;   // ルール(1)で決着済みの局面は通常フェーズに入らない
  const pos = pr.unwrap();
  let n = 0;
  const usis = [];
  for (const [from, dests] of pos.allMoveDests()) for (const to of dests) { n++; usis.push(makeUsi({ from, to })); }
  totalMoves += n; minMoves = Math.min(minMoves, n);
  if (makeSfen(pos) === r.sfen) roundtripOk++;
  // 先頭の合法手を実際に指せるか
  if (usis.length) { const p2 = pos.clone(); p2.play(parseUsi(usis[0])); playOk++; }
}
console.log(`合法手数 平均: ${(totalMoves / looseOk).toFixed(1)} / 最小: ${minMoves}`);
console.log(`SFENラウンドトリップ一致: ${roundtripOk}/${looseOk}`);
console.log(`1手進行成功: ${playOk}/${looseOk}`);

// 王手/玉取り局面の扱い
const kc = recs.filter(r => r.king_capturable);
console.log(`king_capturable 局面: ${kc.length}`);
for (const r of kc) {
  const res = parseSfen('standard', r.sfen, true);
  if (!parseSfen('standard', r.sfen, false).isOk) { console.log(`  → shogiopsは受理しない（ルール(1)で先手勝ち確定の局面）`); console.log(`  ${r.sfen}`); continue; }
  const pos = parseSfen('standard', r.sfen, false).unwrap();
  const ctx = pos.ctx();
  console.log(`  strict=${res.isOk ? 'OK' : 'NG(' + res.error + ')'} 王手中=${ctx.checkers.nonEmpty()} 合法手=${[...pos.allMoveDests()].reduce((a, [, d]) => a + d.size(), 0)}`);
  console.log(`  ${r.sfen}`);
}
