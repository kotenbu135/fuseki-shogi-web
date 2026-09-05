// 1部屋＝1対局＝1 Durable Object。
//
// 部屋が持つ「対局の真実」は手順のトークン列（src/game.js の tokens() と同じ形）。
// 席・手番・手順の連番・時計・不在はここ（rules.js）が裁き、局面の合法性と終局は
// judge.js（ブラウザと同じ Game を Workers で動かす）が裁く。judge が起きない環境では
// 検証なしで続け、終局はブラウザの申告（over）を信じる（段1の挙動）。
//
// WebSocket Hibernation API を使う。待っている時間は課金されない。接続の属性
// （どの席か・観戦か）は serializeAttachment に持たせ、休眠から起きても失わない。
import {
  SEATS, TIME_CONTROLS, ABANDON_MS, MAX_NORMAL_MOVES, other, turnSeat, tokenError, applyToken, rewindTo,
  lastTokenOf, newClock, remaining, closeTurn, deadline, expiresAt, seatOfColor, colorOfSeat, cleanNick,
  normalCount,
} from './rules.js';
import { newJudge } from './judge.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.judge = null;         // 局面を持つ Game。最初に要るときに手順から作る
    this.judgeBroken = false;  // 作れなかった（手順が壊れている・WASMが起きない）。検証なしで続ける
    this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get('state')) ?? null;
    });
  }

  async save() {
    this.state.lastActiveAt = Date.now();
    await this.ctx.storage.put('state', this.state);
    await this.scheduleAlarm();
  }

  /** 次に起きるべき時刻。時計切れか、部屋の期限か、早いほう。 */
  async scheduleAlarm() {
    const s = this.state;
    if (!s) return;
    const times = [expiresAt(s)];
    const d = s.result ? null : deadline(s.clock, s.timeCtl);
    if (d !== null) times.push(d);
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/create' && req.method === 'POST') return this.create(await req.json());
    if (!this.state) return json({ error: 'no_room' }, 404);
    if (url.pathname === '/info') return json(this.info());
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ seat: null, spectator: false });
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not_found' }, 404);
  }

  /** 部屋を作る。席のトークンは部屋が発行し、作った人（host）に返す。 */
  async create(body) {
    if (this.state) return json({ error: 'exists' }, 409);
    const mode = body.mode === 'kings-first' ? 'kings-first' : 'standard';
    const tcKey = typeof body.time === 'string' && body.time in TIME_CONTROLS ? body.time : 'none';
    const now = Date.now();
    const seats = {
      host: { token: token(), side: null, role: null },
      guest: { token: null, side: null, role: null },
    };
    if (mode === 'standard') {
      const side = body.side === 'sente' || body.side === 'gote' ? body.side
        : (Math.random() < .5 ? 'sente' : 'gote');
      seats.host.side = side;
      seats.guest.side = side === 'sente' ? 'gote' : 'sente';
    } else {
      const role = body.role === 'placer' || body.role === 'chooser' ? body.role
        : (Math.random() < .5 ? 'placer' : 'chooser');
      seats.host.role = role;
      seats.guest.role = role === 'placer' ? 'chooser' : 'placer';
    }
    this.state = {
      v: 2, id: body.id, mode, timeKey: tcKey, timeCtl: TIME_CONTROLS[tcKey],
      lang: body.lang === 'en' ? 'en' : 'ja',
      public: body.public === true,
      names: { host: cleanNick(body.nick), guest: null },
      createdAt: now, startedAt: null, lastActiveAt: now,
      seats, tokens: [], clock: newClock(TIME_CONTROLS[tcKey]),
      result: null,
      // 申し出（引き分け・待った）。相手が受けるか断るか、誰かが指すまで残る。
      offers: { draw: null, takeback: null },
      // 不在になった時刻。null は在席。guest はまだ来ていないあいだ 'never'。
      away: { host: now, guest: 'never' },
    };
    await this.save();
    return json({ id: this.state.id, seat: this.state.seats.host.token });
  }

  /** 部屋の概要（参加する前に見せる分）。席のトークンは出さない。 */
  info() {
    const s = this.state;
    return {
      id: s.id, mode: s.mode, time: s.timeKey, lang: s.lang,
      open: s.seats.guest.token === null && !s.result,
      started: !!s.startedAt, over: !!s.result,
      // 参加する人が持つ側・役と、作った人の名前。
      guestSide: s.seats.guest.side, guestRole: s.seats.guest.role,
      hostName: s.names.host, watchers: this.watchers().length,
    };
  }

  /** 待合に載せる形。公開で、相手がまだ来ておらず、作った人が居るときだけ載る。 */
  lobbyEntry() {
    const s = this.state;
    return {
      id: s.id, mode: s.mode, time: s.timeKey, lang: s.lang, nick: s.names.host,
      guestSide: s.seats.guest.side, guestRole: s.seats.guest.role, createdAt: s.createdAt,
    };
  }
  lobbyShouldList() {
    const s = this.state;
    return !!s && s.public && s.seats.guest.token === null && !s.result && s.away.host === null;
  }
  /** 待合に載せる／外す。失敗しても対局には関わらないので握る。 */
  syncLobby() {
    const s = this.state;
    const id = s?.id ?? this._lastId;
    if (!id || !this.env.LOBBY) return;
    this._lastId = id;
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
    const path = this.lobbyShouldList() ? '/add' : '/remove';
    const body = path === '/add' ? this.lobbyEntry() : { id };
    this.ctx.waitUntil(stub.fetch(`https://lobby${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {}));
  }

  // ---- 席と接続 ----

  sockets(seat = null) {
    return this.ctx.getWebSockets().filter(ws => {
      const a = attachment(ws);
      return seat === null ? true : a.seat === seat;
    });
  }
  players() { return this.ctx.getWebSockets().filter(ws => attachment(ws).seat !== null); }
  watchers() { return this.ctx.getWebSockets().filter(ws => attachment(ws).spectator); }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets()) if (ws !== except) trySend(ws, text);
  }

  /** 席ごとの在席。'online' | 'away' | 'never'。 */
  presence() {
    const p = {};
    for (const seat of SEATS) {
      const a = this.state.away[seat];
      p[seat] = a === null ? 'online' : a === 'never' ? 'never' : 'away';
    }
    return p;
  }

  /** 時計の今の姿。走っている席の残りはサーバー時刻で引いてから渡す。 */
  clockView(now = Date.now()) {
    const s = this.state;
    const out = { running: s.clock.running, now };
    for (const seat of SEATS) {
      const elapsed = s.clock.running === seat && !s.result ? now - s.clock.since : 0;
      const r = remaining(s.clock[seat], s.timeCtl, elapsed);
      out[seat] = { mainMs: r.mainMs, byMs: r.byMs };
    }
    return out;
  }

  fullState(seat) {
    const s = this.state;
    const now = Date.now();
    return {
      t: 'state', id: s.id, mode: s.mode, time: s.timeKey, timeCtl: s.timeCtl, lang: s.lang,
      you: seat, names: s.names, public: s.public,
      seats: {
        host: { side: s.seats.host.side, role: s.seats.host.role },
        guest: { side: s.seats.guest.side, role: s.seats.guest.role },
      },
      tokens: s.tokens, started: !!s.startedAt, result: s.result, offers: s.offers,
      clock: this.clockView(now), presence: this.presence(), watchers: this.watchers().length,
      awaySince: seat ? awaySince(s, other(seat)) : null, abandonMs: ABANDON_MS, now,
    };
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { t: 'error', code: 'bad_json' }); }
    if (!this.state) return send(ws, { t: 'error', code: 'no_room' });
    const seat = attachment(ws).seat;
    if (msg.t === 'join') return this.join(ws, msg);
    if (msg.t === 'ping') return send(ws, { t: 'pong', now: Date.now() });
    if (msg.t === 'state') return send(ws, this.fullState(seat));
    if (!seat) return send(ws, { t: 'error', code: 'not_joined' });
    if (msg.t === 'move') return this.move(ws, seat, msg);
    if (msg.t === 'over') return this.over(ws, seat, msg);
    if (msg.t === 'resign') return this.resign(ws, seat);
    if (msg.t === 'claim') return this.claim(ws, seat);
    if (msg.t === 'cancel') return this.cancel(ws, seat);
    if (msg.t === 'offer') return this.offer(ws, seat, msg.kind);
    if (msg.t === 'accept') return this.accept(ws, seat, msg.kind);
    if (msg.t === 'decline') return this.decline(ws, seat, msg.kind);
    return send(ws, { t: 'error', code: 'unknown' });
  }

  /**
   * 席に着く。トークンがあればその席、無ければ空いている guest の席。席が埋まっていれば観戦。
   * 両者が揃った瞬間に対局が始まる（時計が回り出す）。
   */
  async join(ws, msg) {
    const s = this.state;
    let seat = null;
    if (typeof msg.seat === 'string') {
      seat = SEATS.find(x => s.seats[x].token === msg.seat) ?? null;
      if (!seat) return send(ws, { t: 'error', code: 'bad_seat' });
    } else if (!msg.spectate && s.seats.guest.token === null && !s.result) {
      seat = 'guest';
      s.seats.guest.token = token();
    } else {
      // 観戦。局面は流れてくるが、何も送れない。
      ws.serializeAttachment({ seat: null, spectator: true });
      send(ws, this.fullState(null));
      this.sendPresence();
      return;
    }
    ws.serializeAttachment({ seat, spectator: false });
    const nick = cleanNick(msg.nick);
    if (nick !== null || s.names[seat] === undefined) s.names[seat] = nick ?? s.names[seat] ?? null;
    const wasAway = s.away[seat] !== null;
    s.away[seat] = null;
    let started = false;
    if (!s.startedAt && s.seats.guest.token !== null && s.away.host === null && s.away.guest === null) {
      s.startedAt = Date.now();
      s.clock.running = turnSeat(s);
      s.clock.since = s.startedAt;
      started = true;
    }
    await this.save();
    this.syncLobby();
    const full = this.fullState(seat);
    if (seat === 'guest' && msg.seat === undefined) full.seatToken = s.seats.guest.token;
    send(ws, full);
    // 相手と観戦に在席を知らせる。始まった瞬間は state を丸ごと（時計が回り出し、名前も決まった）。
    if (started) {
      for (const x of this.sockets()) if (x !== ws) trySend(x, JSON.stringify(this.fullState(attachment(x).seat)));
    } else if (wasAway || nick !== null) {
      this.sendPresence();
    }
  }

  sendPresence() {
    const s = this.state;
    const base = { t: 'presence', presence: this.presence(), names: s.names, watchers: this.watchers().length, now: Date.now() };
    for (const ws of this.sockets()) {
      const seat = attachment(ws).seat;
      trySend(ws, JSON.stringify({ ...base, awaySince: seat ? awaySince(s, other(seat)) : null }));
    }
  }

  /** 局面の判定役。無ければ手順から作る。作れなければ null（検証なしで続ける）。 */
  async ensureJudge() {
    if (this.judge || this.judgeBroken) return this.judge;
    try {
      this.judge = await newJudge({ mode: this.state.mode, tokens: this.state.tokens });
    } catch (e) {
      console.error('judge を作れない。検証なしで続ける:', e?.message ?? e);
      this.judgeBroken = true;
      this.judge = null;
    }
    return this.judge;
  }

  async move(ws, seat, msg) {
    const s = this.state;
    if (s.result) return send(ws, { t: 'error', code: 'over', ply: msg.ply });
    if (turnSeat(s) !== seat) return send(ws, { t: 'error', code: 'not_your_turn', ply: msg.ply });
    if (msg.ply !== s.tokens.length) return send(ws, { t: 'error', code: 'bad_ply', ply: msg.ply, expected: s.tokens.length });
    const err = tokenError(s, msg.token);
    if (err) return send(ws, { t: 'error', code: err, ply: msg.ply });
    // 合法性と終局。ブラウザと同じ Game で見る。
    const judge = await this.ensureJudge();
    if (judge) {
      if (judge.phase === 'over') return send(ws, { t: 'error', code: 'over', ply: msg.ply });
      try { judge.play(msg.token); }
      catch (e) { return send(ws, { t: 'error', code: 'illegal', ply: msg.ply, detail: String(e?.message ?? e).slice(0, 120) }); }
    }
    const now = Date.now();
    // 時計。切れていれば着手は受けず、時間切れで終える（アラームが遅れた場合）。
    if (s.clock.running === seat) {
      const r = closeTurn(s.clock[seat], s.timeCtl, now - s.clock.since);
      if (r.expired) return this.end({ winnerSeat: other(seat), reason: 'timeout', by: seat });
    }
    applyToken(s, msg.token);
    s.offers = { draw: null, takeback: null };   // 指したら申し出は流れる
    s.clock.running = turnSeat(s);
    s.clock.since = now;
    await this.save();
    this.broadcast({ t: 'moved', ply: msg.ply, token: msg.token, clock: this.clockView(now) });
    // 終局の判定。詰み・指す手が無い・41手目の裁定・千日手は judge が、手数の上限はここが見る。
    if (judge && judge.phase === 'over' && judge.result) {
      const r = judge.result;
      return this.end({ winnerSeat: r.winner ? seatOfColor(s, r.winner) : null, winner: r.winner, reason: r.reason, by: null });
    }
    if (normalCount(s.tokens) >= MAX_NORMAL_MOVES) return this.end({ winnerSeat: null, winner: null, reason: 'too_long', by: null });
  }

  /**
   * ブラウザが判定した終局の申告。判定役が居れば要らない（自分で見る）ので、
   * 判定役が無いときだけ信じる。不整合（desync）の申告だけはいつでも受ける。
   */
  async over(ws, seat, msg) {
    const s = this.state;
    if (s.result) return;
    const r = msg.result ?? {};
    const reason = typeof r.reason === 'string' && /^[a-z_]{1,40}$/.test(r.reason) ? r.reason : 'unknown';
    if (reason === 'desync') return this.end({ winnerSeat: null, winner: null, reason: 'desync', by: seat });
    if (this.judge || !this.judgeBroken) {
      // 判定役で見直す。手順がそこで終わっていれば自分の結果で終える。
      const judge = await this.ensureJudge();
      if (judge) {
        if (judge.phase === 'over' && judge.result) {
          const j = judge.result;
          return this.end({ winnerSeat: j.winner ? seatOfColor(s, j.winner) : null, winner: j.winner, reason: j.reason, by: null });
        }
        return send(ws, { t: 'error', code: 'not_over' });
      }
    }
    if (msg.ply !== s.tokens.length) return send(ws, { t: 'error', code: 'bad_ply', ply: msg.ply, expected: s.tokens.length });
    const winner = r.winner === 'sente' || r.winner === 'gote' ? r.winner : null;
    await this.end({ winnerSeat: winner ? seatOfColor(s, winner) : null, reason, by: seat, winner });
  }

  async resign(ws, seat) {
    if (this.state.result) return;
    await this.end({ winnerSeat: other(seat), reason: 'resign', by: seat });
  }

  /** 相手が不在のまま ABANDON_MS 過ぎたら、残った側が勝ちを取れる。 */
  async claim(ws, seat) {
    const s = this.state;
    if (s.result) return;
    if (!s.startedAt) return send(ws, { t: 'error', code: 'not_started' });
    const since = awaySince(s, other(seat));
    if (since === null || Date.now() - since < ABANDON_MS) return send(ws, { t: 'error', code: 'not_claimable' });
    await this.end({ winnerSeat: seat, reason: 'abandon', by: seat });
  }

  /** 相手が来る前に作った人がやめた。部屋ごと消す（待合からも）。 */
  async cancel(ws, seat) {
    const s = this.state;
    if (seat !== 'host' || s.startedAt) return send(ws, { t: 'error', code: 'cannot_cancel' });
    await this.destroy('cancelled');
  }

  // ---- 申し出（引き分け・待った） ----

  async offer(ws, seat, kind) {
    const s = this.state;
    if (s.result || !s.startedAt) return send(ws, { t: 'error', code: 'not_started' });
    if (kind === 'draw') {
      if (s.offers.draw === other(seat)) return this.accept(ws, seat, 'draw');   // 相手も出していた
      s.offers.draw = seat;
    } else if (kind === 'takeback') {
      // 自分の直前の手まで戻す（その後の相手の手も消える）。まだ指していなければ頼めない。
      const i = lastTokenOf(s, seat);
      if (i < 0) return send(ws, { t: 'error', code: 'nothing_to_take_back' });
      s.offers.takeback = { by: seat, ply: i };
    } else return send(ws, { t: 'error', code: 'unknown' });
    await this.save();
    this.broadcast({ t: 'offer', kind, by: seat, ply: kind === 'takeback' ? s.offers.takeback.ply : undefined });
  }

  async accept(ws, seat, kind) {
    const s = this.state;
    if (s.result) return;
    if (kind === 'draw') {
      if (s.offers.draw !== other(seat)) return send(ws, { t: 'error', code: 'no_offer' });
      return this.end({ winnerSeat: null, winner: null, reason: 'agreement', by: seat });
    }
    if (kind === 'takeback') {
      const o = s.offers.takeback;
      if (!o || o.by !== other(seat)) return send(ws, { t: 'error', code: 'no_offer' });
      rewindTo(s, o.ply);
      this.judge = null;   // 手順から作り直す（次の着手で）
      s.offers = { draw: null, takeback: null };
      const now = Date.now();
      // 時計は返さない。戻した先の手番の席から回り直す。
      if (s.clock.running && s.clock.running !== turnSeat(s)) {
        closeTurn(s.clock[s.clock.running], s.timeCtl, now - s.clock.since);
      }
      s.clock.running = turnSeat(s);
      s.clock.since = now;
      await this.save();
      this.broadcast({ t: 'rewound', ply: s.tokens.length, tokens: s.tokens, by: seat, clock: this.clockView(now) });
      return;
    }
    return send(ws, { t: 'error', code: 'unknown' });
  }

  async decline(ws, seat, kind) {
    const s = this.state;
    if (kind === 'draw' && s.offers.draw === other(seat)) s.offers.draw = null;
    else if (kind === 'takeback' && s.offers.takeback?.by === other(seat)) s.offers.takeback = null;
    else return;
    await this.save();
    this.broadcast({ t: 'offer_declined', kind, by: seat });
  }

  async end({ winnerSeat, reason, by, winner }) {
    const s = this.state;
    s.result = {
      winner: winner ?? (winnerSeat ? colorOfSeat(s, winnerSeat) : null),
      winnerSeat: winnerSeat ?? null, reason, by: by ?? null,
    };
    s.clock.running = null;
    s.offers = { draw: null, takeback: null };
    await this.save();
    this.syncLobby();
    this.broadcast({ t: 'ended', result: s.result, clock: this.clockView() });
  }

  /** 部屋を消す。接続は理由を付けて閉じ、待合からも外す。 */
  async destroy(why) {
    for (const ws of this.sockets()) { try { ws.close(1000, why); } catch { /* 無視 */ } }
    this._lastId = this.state?.id;
    this.state = null;
    this.judge = null;
    await this.ctx.storage.deleteAll();
    if (this._lastId && this.env.LOBBY) {
      const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
      this.ctx.waitUntil(stub.fetch('https://lobby/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this._lastId }),
      }).catch(() => {}));
    }
  }

  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }

  /** 接続が切れた。その席の接続がもう無ければ不在にする。観戦なら人数が減るだけ。 */
  async gone(ws) {
    if (!this.state) return;
    const a = attachment(ws);
    try { ws.close(); } catch { /* 既に閉じている */ }
    if (a.spectator) return this.sendPresence();
    const seat = a.seat;
    if (!seat) return;
    if (this.sockets(seat).some(x => x !== ws)) return;
    if (this.state.away[seat] !== null) return;
    this.state.away[seat] = Date.now();
    await this.save();
    this.syncLobby();   // 作った人が居なくなった募集は待合から外す
    this.sendPresence();
  }

  /** 時計切れか、部屋の期限。 */
  async alarm() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (now >= expiresAt(s)) return this.destroy('expired');
    const d = s.result ? null : deadline(s.clock, s.timeCtl);
    if (d !== null && now >= d) {
      const loser = s.clock.running;
      await this.end({ winnerSeat: other(loser), reason: 'timeout', by: loser });
      return;
    }
    await this.scheduleAlarm();
  }
}

/** 相手が不在になった時刻（ms）。在席なら null。まだ来ていなければ null（申し出の対象ではない）。 */
function awaySince(state, seat) {
  const a = state.away[seat];
  return a === null || a === 'never' ? null : a;
}

function attachment(ws) {
  try { return ws.deserializeAttachment() ?? { seat: null, spectator: false }; } catch { return { seat: null, spectator: false }; }
}
function send(ws, msg) { trySend(ws, JSON.stringify(msg)); }
function trySend(ws, text) { try { ws.send(text); } catch { /* 閉じかけの接続 */ } }
function token() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
