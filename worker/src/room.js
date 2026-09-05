// 1部屋＝1対局＝1 Durable Object。
//
// 部屋が持つ「対局の真実」は手順のトークン列（src/game.js の tokens() と同じ形）。
// 局面は持たない。両者のブラウザが同じコードで局面を作り、合法性もそちらで検証する
// （段1）。ここが裁くのは席・手番・手順の連番・時計・不在。
//
// WebSocket Hibernation API を使う。待っている時間は課金されない。接続の属性
// （どの席か）は serializeAttachment に持たせ、休眠から起きても失わない。
import {
  SEATS, TIME_CONTROLS, ABANDON_MS, other, turnSeat, tokenError, applyToken,
  newClock, remaining, closeTurn, deadline, expiresAt, seatOfColor, colorOfSeat,
} from './rules.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
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
      server.serializeAttachment({ seat: null });
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
      v: 1, id: body.id, mode, timeKey: tcKey, timeCtl: TIME_CONTROLS[tcKey],
      lang: body.lang === 'en' ? 'en' : 'ja',
      createdAt: now, startedAt: null, lastActiveAt: now,
      seats, tokens: [], clock: newClock(TIME_CONTROLS[tcKey]),
      result: null,
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
      open: s.seats.guest.token === null,
      started: !!s.startedAt, over: !!s.result,
      // 参加する人が持つ側・役。
      guestSide: s.seats.guest.side, guestRole: s.seats.guest.role,
    };
  }

  // ---- 席と接続 ----

  sockets(seat = null) {
    return this.ctx.getWebSockets().filter(ws => seat === null || attachment(ws).seat === seat);
  }

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
      you: seat,
      seats: {
        host: { side: s.seats.host.side, role: s.seats.host.role },
        guest: { side: s.seats.guest.side, role: s.seats.guest.role },
      },
      tokens: s.tokens, started: !!s.startedAt, result: s.result,
      clock: this.clockView(now), presence: this.presence(),
      awaySince: awaySince(s, other(seat)), abandonMs: ABANDON_MS, now,
    };
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { t: 'error', code: 'bad_json' }); }
    if (!this.state) return send(ws, { t: 'error', code: 'no_room' });
    const seat = attachment(ws).seat;
    if (msg.t === 'join') return this.join(ws, msg);
    if (msg.t === 'ping') return send(ws, { t: 'pong', now: Date.now() });
    if (!seat) return send(ws, { t: 'error', code: 'not_joined' });
    if (msg.t === 'move') return this.move(ws, seat, msg);
    if (msg.t === 'over') return this.over(ws, seat, msg);
    if (msg.t === 'resign') return this.resign(ws, seat);
    if (msg.t === 'claim') return this.claim(ws, seat);
    if (msg.t === 'state') return send(ws, this.fullState(seat));
    return send(ws, { t: 'error', code: 'unknown' });
  }

  /**
   * 席に着く。トークンがあればその席、無ければ空いている guest の席を渡す。
   * 両者が揃った瞬間に対局が始まる（時計が回り出す）。
   */
  async join(ws, msg) {
    const s = this.state;
    let seat = null;
    if (typeof msg.seat === 'string') {
      seat = SEATS.find(x => s.seats[x].token === msg.seat) ?? null;
      if (!seat) return send(ws, { t: 'error', code: 'bad_seat' });
    } else if (s.seats.guest.token === null && !s.result) {
      seat = 'guest';
      s.seats.guest.token = token();
    } else {
      return send(ws, { t: 'error', code: 'full' });
    }
    ws.serializeAttachment({ seat });
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
    const full = this.fullState(seat);
    if (seat === 'guest' && msg.seat === undefined) full.seatToken = s.seats.guest.token;
    send(ws, full);
    // 相手に在席を知らせる。始まった瞬間は state を丸ごと（時計が回り出したので）。
    if (started) {
      for (const x of this.sockets(other(seat))) trySend(x, JSON.stringify(this.fullState(other(seat))));
    } else if (wasAway) {
      this.sendPresence();
    }
  }

  sendPresence() {
    const s = this.state;
    for (const seat of SEATS) {
      const m = { t: 'presence', presence: this.presence(), awaySince: awaySince(s, other(seat)), now: Date.now() };
      const text = JSON.stringify(m);
      for (const ws of this.sockets(seat)) trySend(ws, text);
    }
  }

  async move(ws, seat, msg) {
    const s = this.state;
    if (s.result) return send(ws, { t: 'error', code: 'over', ply: msg.ply });
    if (turnSeat(s) !== seat) return send(ws, { t: 'error', code: 'not_your_turn', ply: msg.ply });
    if (msg.ply !== s.tokens.length) return send(ws, { t: 'error', code: 'bad_ply', ply: msg.ply, expected: s.tokens.length });
    const err = tokenError(s, msg.token);
    if (err) return send(ws, { t: 'error', code: err, ply: msg.ply });
    const now = Date.now();
    // 時計。切れていれば着手は受けず、時間切れで終える（アラームが遅れた場合）。
    if (s.clock.running === seat) {
      const r = closeTurn(s.clock[seat], s.timeCtl, now - s.clock.since);
      if (r.expired) return this.end({ winnerSeat: other(seat), reason: 'timeout', by: seat });
    }
    applyToken(s, msg.token);
    s.clock.running = turnSeat(s);
    s.clock.since = now;
    await this.save();
    this.broadcast({ t: 'moved', ply: msg.ply, token: msg.token, clock: this.clockView(now) });
  }

  /**
   * ブラウザが判定した終局（詰み・41手目の裁定・指す手が無い・手数上限）。
   * 段1はサーバーが局面を持たないので、両者のどちらかの申告を信じる。
   * 申告できるのは最後の手を受けた直後（ply が一致）だけ。
   */
  async over(ws, seat, msg) {
    const s = this.state;
    if (s.result) return;
    if (msg.ply !== s.tokens.length) return send(ws, { t: 'error', code: 'bad_ply', ply: msg.ply, expected: s.tokens.length });
    const r = msg.result ?? {};
    const winner = r.winner === 'sente' || r.winner === 'gote' ? r.winner : null;
    const reason = typeof r.reason === 'string' && /^[a-z_]{1,40}$/.test(r.reason) ? r.reason : 'unknown';
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

  async end({ winnerSeat, reason, by, winner }) {
    const s = this.state;
    s.result = {
      winner: winner ?? (winnerSeat ? colorOfSeat(s, winnerSeat) : null),
      winnerSeat: winnerSeat ?? null, reason, by: by ?? null,
    };
    s.clock.running = null;
    await this.save();
    this.broadcast({ t: 'ended', result: s.result, clock: this.clockView() });
  }

  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }

  /** 接続が切れた。その席の接続がもう無ければ不在にする。 */
  async gone(ws) {
    if (!this.state) return;
    const seat = attachment(ws).seat;
    try { ws.close(); } catch { /* 既に閉じている */ }
    if (!seat) return;
    if (this.sockets(seat).some(x => x !== ws)) return;
    if (this.state.away[seat] !== null) return;
    this.state.away[seat] = Date.now();
    await this.save();
    this.sendPresence();
  }

  /** 時計切れか、部屋の期限。 */
  async alarm() {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (now >= expiresAt(s)) {
      for (const ws of this.sockets()) { try { ws.close(1000, 'expired'); } catch { /* 無視 */ } }
      await this.ctx.storage.deleteAll();
      this.state = null;
      return;
    }
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
  try { return ws.deserializeAttachment() ?? { seat: null }; } catch { return { seat: null }; }
}
function send(ws, msg) { trySend(ws, JSON.stringify(msg)); }
function trySend(ws, text) { try { ws.send(text); } catch { /* 閉じかけの接続 */ } }
function token() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
