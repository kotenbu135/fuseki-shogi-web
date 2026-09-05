// 部屋（Durable Object）を実際に動かして、2つの接続で1局の骨組みを通す。
//
//   cd worker && npx wrangler dev --port 8787      （別の端末で）
//   node worker/test/room_smoke.mjs [http://127.0.0.1:8787]
//
// 見るもの: 部屋の作成・参加・両者が揃って始まる・手番の裁定・連番のずれの拒否・
// 再接続で state が丸ごと返る・投了・不在の申し出は5分前には断られる・時計。
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const ORIGIN = 'http://localhost:8080';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** メッセージを溜めて、条件に合うものを待つ小さな口。 */
function open(id, seat) {
  const url = `${BASE.replace(/^http/, 'ws')}/rooms/${id}/ws`;
  const ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
  const inbox = [];
  const waiters = [];
  // 既に見た所までの印。同じ種類のメッセージ（error など）を2度待つとき、前のを拾わないため。
  let cursor = 0;
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    m._at = Date.now();
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); cursor = inbox.length; w.resolve(m); }
  });
  const client = {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 5000) => {
      const i = inbox.findIndex((m, k) => k >= cursor && pred(m));
      if (i >= 0) { cursor = i + 1; return Promise.resolve(inbox[i]); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: null };
        waiters.push(w);
        // indexOf が -1 のまま splice すると末尾の別の待ちを消す（実際に踏んだ）。見つかったときだけ。
        w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error(`待ちきれない: ${pred}`)); }, ms);
      });
    },
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => { client.send({ t: 'join', ...(seat ? { seat } : {}) }); resolve(client); });
    ws.on('error', reject);
  });
}

// ---- 作成 ----
let r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'standard', time: '10m+30s', side: 'sente', lang: 'ja' }) });
check('Origin 無しの作成は 403', r.status === 403, String(r.status));
r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ mode: 'standard', time: '10m+30s', side: 'sente', lang: 'ja' }) });
const made = await r.json();
check('部屋ができて席のトークンが返る', r.ok && /^[a-z2-9]{8}$/.test(made.id) && typeof made.seat === 'string', JSON.stringify(made));
const info = await (await fetch(`${BASE}/rooms/${made.id}`, { headers: { Origin: ORIGIN } })).json();
check('概要: 空いていて未開始、参加者は後手', info.open === true && info.started === false && info.guestSide === 'gote', JSON.stringify(info));
check('無い部屋は 404', (await fetch(`${BASE}/rooms/zzzzzzzz`, { headers: { Origin: ORIGIN } })).status === 404);

// ---- 参加と開始 ----
const host = await open(made.id, made.seat);
let st = await host.wait(m => m.t === 'state');
check('作った人は host の席で、まだ始まらない', st.you === 'host' && st.started === false && st.presence.guest === 'never', JSON.stringify(st.presence));
const guest = await open(made.id, null);
st = await guest.wait(m => m.t === 'state');
check('席のトークン無しで入ると guest の席とトークンをもらい、両者揃って始まる',
  st.you === 'guest' && typeof st.seatToken === 'string' && st.started === true && st.clock.running === 'host',
  JSON.stringify({ you: st.you, started: st.started, running: st.clock.running }));
const guestSeat = st.seatToken;
const hostStart = await host.wait(m => m.t === 'state' && m.started === true);
check('host にも開始の state が届く', hostStart.started === true && hostStart.seats.guest.side === 'gote');
const third = await open(made.id, null);
const full = await third.wait(m => m.t === 'error');
check('3人目は入れない', full.code === 'full', full.code);
third.close();

// ---- 手番と連番 ----
guest.send({ t: 'move', ply: 0, token: 'P*5c' });
let e = await guest.wait(m => m.t === 'error');
check('相手の番には指せない', e.code === 'not_your_turn', e.code);
host.send({ t: 'move', ply: 1, token: 'P*5g' });
e = await host.wait(m => m.t === 'error');
check('連番がずれていれば拒否', e.code === 'bad_ply' && e.expected === 0, JSON.stringify(e));
host.send({ t: 'move', ply: 0, token: '7g7f' });
e = await host.wait(m => m.t === 'error' && m.code !== 'bad_ply');
check('布石のあいだは駒打ちしか受けない', e.code === 'expect_drop', e.code);
host.send({ t: 'move', ply: 0, token: 'P*5g' });
const mv = await guest.wait(m => m.t === 'moved');
check('着手が相手に届き、時計が相手へ移る', mv.ply === 0 && mv.token === 'P*5g' && mv.clock.running === 'guest', JSON.stringify(mv.clock));
const echo = await host.wait(m => m.t === 'moved');
check('自分にも同じ着手が返る', echo.ply === 0 && echo.token === 'P*5g');
check('本時間が減っている（10分から）', mv.clock.host.mainMs <= 600000 && mv.clock.host.mainMs > 590000, String(mv.clock.host.mainMs));

// ---- 再接続 ----
host.close();
const away = await guest.wait(m => m.t === 'presence' && m.presence.host === 'away');
check('切れると相手に不在が伝わり、不在の時刻が付く', typeof away.awaySince === 'number');
guest.send({ t: 'claim' });
e = await guest.wait(m => m.t === 'error');
check('不在になった直後は勝ちを申し出られない', e.code === 'not_claimable', e.code);
const host2 = await open(made.id, made.seat);
st = await host2.wait(m => m.t === 'state');
check('席のトークンで戻ると手順が丸ごと返る', st.you === 'host' && st.tokens.length === 1 && st.tokens[0] === 'P*5g' && st.started === true,
  JSON.stringify(st.tokens));
const back = await guest.wait(m => m.t === 'presence' && m.presence.host === 'online');
check('戻ると在席に戻る', back.awaySince === null);

// ---- 投了 ----
guest.send({ t: 'resign' });
const ended = await host2.wait(m => m.t === 'ended');
check('投了で終わり、勝ちは host（先手）', ended.result.winnerSeat === 'host' && ended.result.winner === 'sente' && ended.result.reason === 'resign',
  JSON.stringify(ended.result));
host2.send({ t: 'move', ply: 1, token: 'P*5c' });
e = await host2.wait(m => m.t === 'error');
check('終局後は指せない', e.code === 'over', e.code);
host2.close(); guest.close();

// ---- 天秤将棋の骨組み ----
r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ mode: 'kings-first', time: 'none', role: 'chooser', lang: 'en' }) });
const k = await r.json();
const kh = await open(k.id, k.seat);
await kh.wait(m => m.t === 'state');
const kg = await open(k.id, null);
st = await kg.wait(m => m.t === 'state');
check('天秤: 参加者は置く役で、1手目は置く役の番', st.seats.guest.role === 'placer' && st.clock.running === 'guest' && st.timeCtl === null, JSON.stringify(st.seats));
kg.send({ t: 'move', ply: 0, token: 'P*5e' });
e = await kg.wait(m => m.t === 'error');
check('天秤: 1手目は玉だけ', e.code === 'expect_king', e.code);
kg.send({ t: 'move', ply: 0, token: 'K*5i' });
await kh.wait(m => m.t === 'moved' && m.ply === 0);
kg.send({ t: 'move', ply: 1, token: 'K*5a' });
const m1 = await kh.wait(m => m.t === 'moved' && m.ply === 1);
check('天秤: 2手目も置く役、そのあと選ぶ役の番', m1.clock.running === 'host');
kh.send({ t: 'move', ply: 2, token: 'choose:gote' });
const m2 = await kg.wait(m => m.t === 'moved' && m.ply === 2);
check('天秤: 選ぶと先手（置く役）の番になる', m2.token === 'choose:gote' && m2.clock.running === 'guest');
kg.send({ t: 'state' });
st = await kg.wait(m => m.t === 'state' && m.tokens.length === 3);
check('天秤: 色が席に付く（host=後手、guest=先手）', st.seats.host.side === 'gote' && st.seats.guest.side === 'sente', JSON.stringify(st.seats));
// ブラウザが判定した終局の申告。
kg.send({ t: 'move', ply: 3, token: 'P*5e' });
await kh.wait(m => m.t === 'moved' && m.ply === 3);
kh.send({ t: 'over', ply: 4, result: { winner: 'sente', reason: 'checkmate' } });
const kEnd = await kg.wait(m => m.t === 'ended');
check('天秤: 終局の申告が通り、勝った色から席が決まる', kEnd.result.winner === 'sente' && kEnd.result.winnerSeat === 'guest' && kEnd.result.reason === 'checkmate',
  JSON.stringify(kEnd.result));
kh.close(); kg.close();

// ---- 10秒将棋の時間切れ（アラーム） ----
r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ mode: 'standard', time: '10s', side: 'gote', lang: 'ja' }) });
const tRoom = await r.json();
const th = await open(tRoom.id, tRoom.seat);
await th.wait(m => m.t === 'state');
const tg = await open(tRoom.id, null);
st = await tg.wait(m => m.t === 'state');
check('10秒将棋: 先手（guest）の時計が秒読み10秒から', st.clock.running === 'guest' && st.clock.guest.byMs === 10000 && st.clock.guest.mainMs === 0, JSON.stringify(st.clock));
const t0 = Date.now();
const tEnd = await th.wait(m => m.t === 'ended', 15000).catch(() => null);
const tElapsed = Date.now() - t0;
console.log(`  （時間切れの通知まで ${tElapsed}ms）`);
check('10秒将棋: 指さないまま10秒で時間切れになり、host（後手）の勝ち',
  tEnd && tEnd.result.reason === 'timeout' && tEnd.result.winnerSeat === 'host', `${tElapsed}ms ` + JSON.stringify(tEnd?.result ?? th.inbox.map(m => `${m.t}@${m._at - t0}`)));
th.close(); tg.close();

await sleep(100);
console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
