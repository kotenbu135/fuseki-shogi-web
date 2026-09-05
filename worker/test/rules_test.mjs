// 部屋のルール（手番機・トークンの形・時計）を Node で通す。Durable Object は要らない。
//
//   node worker/test/rules_test.mjs
import {
  TIME_CONTROLS, MAX_NORMAL_MOVES, turnSeat, tokenError, applyToken, newClock, remaining, closeTurn, deadline,
} from '../src/rules.js';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK ${label}`); }
  catch (e) { failures++; console.log(`  NG ${label} — ${e.message}`); }
};
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
};

const room = (mode, hostSideOrRole) => ({
  mode, tokens: [], result: null, startedAt: 1,
  seats: mode === 'standard'
    ? { host: { side: hostSideOrRole }, guest: { side: hostSideOrRole === 'sente' ? 'gote' : 'sente' } }
    : { host: { role: hostSideOrRole, side: null }, guest: { role: hostSideOrRole === 'placer' ? 'chooser' : 'placer', side: null } },
});
const play = (s, token) => { const e = tokenError(s, token); if (e) throw new Error(`${token}: ${e}`); applyToken(s, token); };

// 布石の40手（適当な合法風の駒打ち。合法性は見ないので形だけ）。
const drops = [];
for (let i = 0; i < 40; i++) drops.push(`${'PLNSGBRK'[i % 8]}*${1 + (i % 9)}${'abcdefghi'[i % 2 ? 7 : 1]}`);

check('通常: 先手の席から交互', () => {
  const s = room('standard', 'gote');
  eq(turnSeat(s), 'guest', '初手は先手の席（guest）');
  play(s, drops[0]);
  eq(turnSeat(s), 'host', '2手目');
});
check('通常: 始まる前と終わった後は手番が無い', () => {
  const s = room('standard', 'sente');
  s.startedAt = null;
  eq(turnSeat(s), null, '始まる前');
  s.startedAt = 1; s.result = { reason: 'resign' };
  eq(turnSeat(s), null, '終局後');
});
check('通常: 40手目までは駒打ちだけ、41手目から指し手も', () => {
  const s = room('standard', 'sente');
  eq(tokenError(s, '7g7f'), 'expect_drop', '布石で指し手');
  eq(tokenError(s, 'choose:sente'), 'unexpected_choose', '通常で選択');
  for (const d of drops) play(s, d);
  eq(tokenError(s, '7g7f'), null, '41手目の指し手');
  eq(tokenError(s, 'P*5e'), null, '41手目の駒打ち');
  eq(tokenError(s, 'K*5e'), 'bad_token', '玉は打てない');
  eq(tokenError(s, '7g7f+'), null, '成り');
  eq(tokenError(s, '7g7f++'), 'bad_token', '形が違う');
});
check('通常: 手数の上限', () => {
  const s = room('standard', 'sente');
  for (const d of drops) play(s, d);
  for (let i = 0; i < MAX_NORMAL_MOVES; i++) play(s, '7g7f');
  eq(tokenError(s, '7g7f'), 'too_long', '上限');
});
check('天秤: 置く役が2手、選ぶ役が choose、選ばれた側から', () => {
  const s = room('kings-first', 'chooser');   // host が選ぶ役、guest が置く役
  eq(turnSeat(s), 'guest', '1手目は置く役');
  eq(tokenError(s, 'P*5e'), 'expect_king', '1手目に玉以外');
  play(s, 'K*5i');
  eq(turnSeat(s), 'guest', '2手目も置く役');
  play(s, 'K*5a');
  eq(turnSeat(s), 'host', '3つ目は選ぶ役');
  eq(tokenError(s, 'P*5e'), 'expect_choose', '選ぶ前に駒打ち');
  play(s, 'choose:gote');
  eq(s.seats.host.side, 'gote', '選ぶ役の色');
  eq(s.seats.guest.side, 'sente', '置く役の色');
  eq(turnSeat(s), 'guest', '3手目は先手（置く役）');
  play(s, 'P*5e');
  eq(turnSeat(s), 'host', '4手目は後手');
  eq(tokenError(s, 'choose:sente'), 'unexpected_choose', '二度目の選択');
});
check('時計: 本時間 → 秒読み → 切れ', () => {
  const tc = TIME_CONTROLS['10m+30s'];
  const e = { mainMs: 5000 };
  let r = remaining(e, tc, 1000);
  eq(r.mainMs, 4000, '本時間が減る'); eq(r.expired, false, '');
  r = remaining(e, tc, 5000);
  eq(r.mainMs, 0, '使い切り'); eq(r.byMs, 30000, '秒読みが丸ごと'); eq(r.expired, false, '');
  r = remaining(e, tc, 20000);
  eq(r.byMs, 15000, '秒読みの途中'); eq(r.expired, false, '');
  r = remaining(e, tc, 35000);
  eq(r.expired, true, '切れ');
});
check('時計: 10秒将棋は最初から秒読み', () => {
  const tc = TIME_CONTROLS['10s'];
  const e = { mainMs: 0 };
  eq(remaining(e, tc, 0).byMs, 10000, '手番の頭');
  eq(remaining(e, tc, 9999).expired, false, '9.999秒');
  eq(remaining(e, tc, 10000).expired, true, '10秒');
});
check('時計: 切れ負けは本時間が尽きたら終わり、加算は着手で足す', () => {
  eq(remaining({ mainMs: 1000 }, TIME_CONTROLS['3m'], 1000).expired, true, '切れ負け');
  const e = { mainMs: 10000 };
  const r = closeTurn(e, TIME_CONTROLS['5m+5s'], 3000);
  eq(r.expired, false, ''); eq(e.mainMs, 12000, '10-3+5');
  eq(closeTurn({ mainMs: 100 }, TIME_CONTROLS['5m+5s'], 200).expired, true, '加算の前に切れる');
  eq(closeTurn({ mainMs: 0 }, null, 999999).expired, false, '無制限');
});
check('時計: アラームの時刻', () => {
  const c = newClock(TIME_CONTROLS['10m+30s']);
  eq(deadline(c, TIME_CONTROLS['10m+30s']), null, '止まっている');
  c.running = 'host'; c.since = 1000;
  eq(deadline(c, TIME_CONTROLS['10m+30s']), 1000 + 600000 + 30000, '本時間＋秒読み');
  eq(deadline(newClock(null), null), null, '無制限');
});

console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
