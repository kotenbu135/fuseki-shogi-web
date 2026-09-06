// 待合。公開で募集している部屋の一覧を1つの Durable Object が持ち、
// ホームを開いている人へ WebSocket で流す（段2のロビー）。
//
// 部屋（room.js）が作られた・相手が来た・作った人が居なくなった・期限が切れた、の
// たびに部屋側から add / remove が来る。ここは一覧を持って配るだけで、対局には関わらない。
import { UNJOINED_TTL_MS, MAX_MSG_BYTES, MAX_LOBBY_SOCKETS, MAX_LOBBY_SEEKS, MSG_STRIKES, newBucket, takeToken } from './rules.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export class Lobby {
  constructor(ctx) {
    this.ctx = ctx;
    this.seeks = null;
    this.buckets = new WeakMap();
    this.ctx.blockConcurrencyWhile(async () => {
      this.seeks = (await this.ctx.storage.get('seeks')) ?? {};
    });
  }

  list() {
    return Object.values(this.seeks).sort((a, b) => b.createdAt - a.createdAt);
  }

  async save() {
    await this.ctx.storage.put('seeks', this.seeks);
    // 古い募集を落とす見回り。募集が1つでもあるあいだだけ。
    if (Object.keys(this.seeks).length) await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
  }

  broadcast() {
    const text = JSON.stringify({ t: 'seeks', seeks: this.list() });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(text); } catch { /* 閉じかけ */ } }
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/add' && req.method === 'POST') {
      const e = await req.json();
      // 溢れたら古い募集から落とす。待合が無限に育たないように。
      if (!(e.id in this.seeks) && Object.keys(this.seeks).length >= MAX_LOBBY_SEEKS) {
        const oldest = this.list().pop();
        if (oldest) delete this.seeks[oldest.id];
      }
      this.seeks[e.id] = e;
      await this.save();
      this.broadcast();
      return json({ ok: true });
    }
    if (url.pathname === '/remove' && req.method === 'POST') {
      const { id } = await req.json();
      if (id in this.seeks) {
        delete this.seeks[id];
        await this.save();
        this.broadcast();
      }
      return json({ ok: true });
    }
    if (url.pathname === '/list') return json({ seeks: this.list() });
    if (url.pathname === '/ws') {
      // 待合は全体で1つの Durable Object。繋げる数に上限を置かないと、ここが的になる。
      if (this.ctx.getWebSockets().length >= MAX_LOBBY_SOCKETS) return json({ error: 'busy' }, 503);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: 'seeks', seeks: this.list() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not_found' }, 404);
  }

  async webSocketMessage(ws, raw) {
    const size = typeof raw === 'string' ? raw.length : raw.byteLength;
    if (size > MAX_MSG_BYTES) { try { ws.close(1009, 'too_large'); } catch { /* 無視 */ } return; }
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!this.allow(ws, msg?.t)) return;
    if (msg?.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong', now: Date.now() })); } catch { /* 無視 */ } }
    else if (msg?.t === 'list') { try { ws.send(JSON.stringify({ t: 'seeks', seeks: this.list() })); } catch { /* 無視 */ } }
  }

  /** 1接続あたりの送信量。list は一覧を丸ごと返すので重く数える。 */
  allow(ws, type) {
    let b = this.buckets.get(ws);
    if (!b) { b = newBucket(); this.buckets.set(ws, b); }
    if (takeToken(b, type === 'list' ? 5 : 1)) return true;
    if (b.strikes >= MSG_STRIKES) { try { ws.close(1008, 'rate_limited'); } catch { /* 無視 */ } }
    return false;
  }
  async webSocketClose(ws) { try { ws.close(); } catch { /* 既に閉じている */ } }
  async webSocketError(ws) { try { ws.close(); } catch { /* 既に閉じている */ } }

  /** 期限の切れた募集を落とす（部屋が消えるのと同じ時間）。 */
  async alarm() {
    const now = Date.now();
    let changed = false;
    for (const [id, e] of Object.entries(this.seeks)) {
      if (now - e.createdAt >= UNJOINED_TTL_MS) { delete this.seeks[id]; changed = true; }
    }
    if (changed) { await this.save(); this.broadcast(); }
    else if (Object.keys(this.seeks).length) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000);
  }
}
