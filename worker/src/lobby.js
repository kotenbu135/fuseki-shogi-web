// 待合。公開で募集している部屋の一覧を1つの Durable Object が持ち、
// ホームを開いている人へ WebSocket で流す（段2のロビー）。
//
// 部屋（room.js）が作られた・相手が来た・作った人が居なくなった・期限が切れた、の
// たびに部屋側から add / remove が来る。ここは一覧を持って配るだけで、対局には関わらない。
import { UNJOINED_TTL_MS } from './rules.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export class Lobby {
  constructor(ctx) {
    this.ctx = ctx;
    this.seeks = null;
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
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: 'seeks', seeks: this.list() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not_found' }, 404);
  }

  async webSocketMessage(ws, raw) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong', now: Date.now() })); } catch { /* 無視 */ } }
    else if (msg?.t === 'list') { try { ws.send(JSON.stringify({ t: 'seeks', seeks: this.list() })); } catch { /* 無視 */ } }
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
