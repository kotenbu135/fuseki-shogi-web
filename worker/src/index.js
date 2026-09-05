// オンライン対局の部屋を持つ Worker。静的配信（Cloudflare Pages）とは別のホストで動く。
//
//   POST /rooms            部屋を作る → { id, seat }（seat は作った人の席のトークン）
//   GET  /rooms/:id        部屋の概要（参加する前に見せる分）
//   GET  /rooms/:id/ws     WebSocket。以後は src/room.js のメッセージ
//   GET  /lobby            待合（公開で募集中の部屋）の一覧
//   GET  /lobby/ws         待合の WebSocket。一覧が変わるたびに流れてくる
//
// 部屋の中身は Durable Object（Room）、待合も1つの Durable Object（Lobby）。
// ここは Origin の確認・CORS・作成の頻度制限だけ。
import { Room } from './room.js';
import { Lobby } from './lobby.js';
import { randomId } from './rules.js';

export { Room, Lobby };

const ID_RE = /^[a-z2-9]{8}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allowed = allowedOrigin(origin, env);
    const cors = allowed ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'vary': 'Origin',
    } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (url.pathname === '/' || url.pathname === '') return new Response('fuseki-shogi rooms\n', { headers: cors });

    // ブラウザからしか来ない。Origin が無い・許していないなら断る（curl での健康診断は / だけ）。
    if (!allowed) return json({ error: 'origin' }, 403);

    if (url.pathname === '/lobby' || url.pathname === '/lobby/ws') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
      if (url.pathname === '/lobby/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426, cors);
        return lobby.fetch('https://lobby/ws', req);
      }
      return withHeaders(await lobby.fetch('https://lobby/list'), cors);
    }

    const m = /^\/rooms(?:\/([^/]+))?(\/ws)?$/.exec(url.pathname);
    if (!m) return json({ error: 'not_found' }, 404, cors);
    const [, id, ws] = m;

    if (!id && req.method === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
      const lim = env.LIMITER.get(env.LIMITER.idFromName(ip));
      const ok = await (await lim.fetch('https://limiter/hit')).json();
      if (!ok.allowed) return json({ error: 'rate_limited' }, 429, cors);
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400, cors); }
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      const roomId = randomId(bytes);
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      const r = await stub.fetch('https://room/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, id: roomId }),
      });
      return withHeaders(r, cors);
    }
    if (!id || !ID_RE.test(id)) return json({ error: 'not_found' }, 404, cors);
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    if (ws) {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426, cors);
      return stub.fetch('https://room/ws', req);
    }
    if (req.method === 'GET') return withHeaders(await stub.fetch('https://room/info'), cors);
    return json({ error: 'method' }, 405, cors);
  },
};

/** 部屋の作成の頻度。IP ごとに 10 分で 20 部屋まで。 */
export class Limiter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch() {
    const now = Date.now();
    const hits = ((await this.ctx.storage.get('hits')) ?? []).filter(t => now - t < 10 * 60 * 1000);
    const allowed = hits.length < 20;
    if (allowed) hits.push(now);
    await this.ctx.storage.put('hits', hits);
    await this.ctx.storage.setAlarm(now + 11 * 60 * 1000);
    return json({ allowed });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

function allowedOrigin(origin, env) {
  if (!origin) return false;
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin);
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
