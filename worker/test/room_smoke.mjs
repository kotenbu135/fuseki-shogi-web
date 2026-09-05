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
function open(id, seat, nick = undefined) {
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
    ws.on('open', () => { client.send({ t: 'join', ...(seat ? { seat } : {}), ...(nick ? { nick } : {}) }); resolve(client); });
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
const full = await third.wait(m => m.t === 'state');
check('3人目は席が無く観戦になる', full.you === null && full.started === true, JSON.stringify({ you: full.you }));
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
kg.send({ t: 'move', ply: 3, token: 'P*5e' });   // 先手の陣（六〜九段）の外
e = await kg.wait(m => m.t === 'error', 10000);
check('天秤: 判定役が陣の外への駒打ちを断る', e.code === 'illegal', e.code);
kg.send({ t: 'move', ply: 3, token: 'P*5g' });
await kh.wait(m => m.t === 'moved' && m.ply === 3);
// ブラウザが判定した終局の申告は、判定役が見直す。終わっていなければ断る。
kh.send({ t: 'over', ply: 4, result: { winner: 'sente', reason: 'checkmate' } });
e = await kh.wait(m => m.t === 'error');
check('天秤: 終局の申告は判定役が見直し、終わっていなければ断る', e.code === 'not_over', e.code);
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

// ---- 判定役（judge）: 非合法手は部屋が断る。待った・引き分けの申し出 ----
r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ mode: 'standard', time: 'none', side: 'sente', nick: '太郎', lang: 'ja' }) });
const jRoom = await r.json();
const jh = await open(jRoom.id, jRoom.seat);
st = await jh.wait(m => m.t === 'state');
check('作った人の名前が state に入る', st.names.host === '太郎', JSON.stringify(st.names));
const jg = await open(jRoom.id, null, '花子');
st = await jg.wait(m => m.t === 'state');
check('参加した人の名前も入る', st.names.guest === '花子' && st.names.host === '太郎', JSON.stringify(st.names));
jh.send({ t: 'move', ply: 0, token: 'P*5a' });   // 先手が後手陣に打つ
e = await jh.wait(m => m.t === 'error', 10000);
check('判定役: 形は正しいが非合法な駒打ちを断る', e.code === 'illegal', e.code);
jh.send({ t: 'move', ply: 0, token: 'P*5g' });
await jg.wait(m => m.t === 'moved' && m.ply === 0, 10000);
jg.send({ t: 'move', ply: 1, token: 'P*5c' });
await jh.wait(m => m.t === 'moved' && m.ply === 1);
jg.send({ t: 'move', ply: 2, token: 'P*5g' });   // 相手の番
e = await jg.wait(m => m.t === 'error');
check('判定役が居ても手番の裁定は先', e.code === 'not_your_turn', e.code);
// 待った。host が頼む → 自分の直前の手（1手目）まで戻る → guest が受ける。
jh.send({ t: 'offer', kind: 'takeback' });
const tb = await jg.wait(m => m.t === 'offer');
check('待ったの申し出が相手に届き、戻る先が付く', tb.kind === 'takeback' && tb.by === 'host' && tb.ply === 0, JSON.stringify(tb));
jg.send({ t: 'accept', kind: 'takeback' });
const rw = await jh.wait(m => m.t === 'rewound');
check('受けると手順が戻り、頼んだ側の番から時計が回る', rw.ply === 0 && rw.tokens.length === 0 && rw.clock.running === 'host', JSON.stringify(rw));
jh.send({ t: 'move', ply: 0, token: 'P*7g' });
const again = await jg.wait(m => m.t === 'moved');
check('戻した後も判定役が続く（新しい手順で指せる）', again.token === 'P*7g' && again.ply === 0);
// 引き分け。guest が提案 → host が断る → もう一度 → host が受ける。
jg.send({ t: 'offer', kind: 'draw' });
const dr = await jh.wait(m => m.t === 'offer');
check('引き分けの提案が届く', dr.kind === 'draw' && dr.by === 'guest');
jh.send({ t: 'decline', kind: 'draw' });
const dc = await jg.wait(m => m.t === 'offer_declined');
check('断ると相手に伝わる', dc.kind === 'draw' && dc.by === 'host');
jg.send({ t: 'offer', kind: 'draw' });
await jh.wait(m => m.t === 'offer');
jh.send({ t: 'accept', kind: 'draw' });
const agreed = await jg.wait(m => m.t === 'ended');
check('受けると合意の引き分け', agreed.result.reason === 'agreement' && agreed.result.winner === null, JSON.stringify(agreed.result));
jh.close(); jg.close();

// ---- 待合（lobby）と観戦・取り消し ----
const lobbyWs = new WebSocket(`${BASE.replace(/^http/, 'ws')}/lobby/ws`, { headers: { Origin: ORIGIN } });
const lobbyMsgs = [];
lobbyWs.on('message', d => lobbyMsgs.push(JSON.parse(d.toString())));
await new Promise(res => lobbyWs.on('open', res));
await sleep(200);
check('待合の WebSocket は繋いだ直後に一覧を送る', lobbyMsgs.length >= 1 && lobbyMsgs[0].t === 'seeks' && Array.isArray(lobbyMsgs[0].seeks));
r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ mode: 'kings-first', time: '3m', role: 'chooser', nick: '待合の人', public: true, lang: 'ja' }) });
const pub = await r.json();
let lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
check('作っただけ（作った人がまだ居ない）では待合に載らない', !lobby.seeks.some(x => x.id === pub.id));
const ph = await open(pub.id, pub.seat);
await ph.wait(m => m.t === 'state');
await sleep(300);
lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
const entry = lobby.seeks.find(x => x.id === pub.id);
check('作った人が居れば待合に載る（モード・持ち時間・相手が持つ役・名前）',
  !!entry && entry.mode === 'kings-first' && entry.time === '3m' && entry.guestRole === 'placer' && entry.nick === '待合の人', JSON.stringify(entry));
check('待合の WebSocket にも流れる', lobbyMsgs.some(m => m.t === 'seeks' && m.seeks.some(x => x.id === pub.id)));
// 作った人が居なくなると外れ、戻ると載る。
ph.close();
await sleep(400);
lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
check('作った人が居なくなった募集は待合から外れる', !lobby.seeks.some(x => x.id === pub.id));
const ph2 = await open(pub.id, pub.seat);
await ph2.wait(m => m.t === 'state');
await sleep(300);
lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
check('戻ると載り直す', lobby.seeks.some(x => x.id === pub.id));
// 相手が来ると外れる。3人目は観戦。
const pg = await open(pub.id, null);
await pg.wait(m => m.t === 'state');
await sleep(300);
lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
check('相手が来ると待合から外れる', !lobby.seeks.some(x => x.id === pub.id));
const spec = await open(pub.id, null);
const specState = await spec.wait(m => m.t === 'state');
check('席が埋まった部屋に入ると観戦（席が無く、手順は届く）', specState.you === null && specState.started === true, JSON.stringify({ you: specState.you }));
const pres = await ph2.wait(m => m.t === 'presence' && m.watchers === 1, 5000).catch(() => null);
check('観戦の人数が対局者に伝わる', pres?.watchers === 1, JSON.stringify(pres));
pg.send({ t: 'move', ply: 0, token: 'K*5i' });
const seen = await spec.wait(m => m.t === 'moved');
check('観戦にも着手が流れる', seen.token === 'K*5i');
spec.send({ t: 'move', ply: 1, token: 'K*5a' });
e = await spec.wait(m => m.t === 'error');
check('観戦は指せない', e.code === 'not_joined', e.code);
ph2.close(); pg.close(); spec.close();
// 取り消し。作った人が相手を待つのをやめると部屋ごと消える。
r = await fetch(`${BASE}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ mode: 'standard', time: 'none', side: 'gote', public: true, lang: 'ja' }) });
const cx = await r.json();
const ch = await open(cx.id, cx.seat);
await ch.wait(m => m.t === 'state');
await sleep(300);
lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
check('取り消す前は待合にある', lobby.seeks.some(x => x.id === cx.id));
const closed = new Promise(res => ch.ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
ch.send({ t: 'cancel' });
const cl = await closed;
await sleep(300);
lobby = await (await fetch(`${BASE}/lobby`, { headers: { Origin: ORIGIN } })).json();
const gone = (await fetch(`${BASE}/rooms/${cx.id}`, { headers: { Origin: ORIGIN } })).status;
check('取り消すと接続が閉じ、部屋が消え、待合からも外れる', cl.reason === 'cancelled' && gone === 404 && !lobby.seeks.some(x => x.id === cx.id),
  JSON.stringify({ cl, gone }));
lobbyWs.close();

await sleep(100);
console.log(`\n不一致 ${failures} 件`);
process.exit(failures ? 1 : 0);
