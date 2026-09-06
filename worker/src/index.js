// オンライン対局の部屋を持つ Worker。静的配信（Cloudflare Pages）とは別のホストで動く。
//
//   POST /rooms            部屋を作る → { id, seat }（seat は作った人の席のトークン）
//   GET  /rooms/:id        部屋の概要（参加する前に見せる分）
//   GET  /rooms/:id/ws     WebSocket。以後は src/room.js のメッセージ
//   GET  /lobby            待合（公開で募集中の部屋）の一覧
//   GET  /lobby/ws         待合の WebSocket。一覧が変わるたびに流れてくる
//
// 部屋の中身は Durable Object（Room）、待合も1つの Durable Object（Lobby）。
// ここは Origin の確認・CORS・頻度制限だけ。
//
// この Worker は誰でも叩ける。守るものは棋譜ではなく**課金**で、
// 「無認証の1リクエストが Durable Object を1つ起こす」経路をどこにも残さないのが方針。
// Origin の確認は他所のサイトの JS を止めるだけで、curl は素通りする——歯止めは頻度制限。
import { Room } from './room.js';
import { Lobby } from './lobby.js';
import { randomId, clientKey, MAX_BODY_BYTES } from './rules.js';

export { Room, Lobby };

const ID_RE = /^[a-z2-9]{8}$/;

// 頻度の上限（IP、IPv6 は /64 ごと）。
//
// 部屋の ID は URL から取るので、**どんな ID でも Durable Object が1つ起きる**。
// 数え上げは現実的でない（31^8）が、無いIDを叩くだけで課金が増えるので、
// 部屋を触るリクエストは作成も照会も接続もすべて先に数える。
// 数える鍵は IP なので、狭く取ると**同じ NAT の裏（将棋クラブ・学校・CGNAT）が
// まとめて締め出される**。部屋は相手が来なければ2時間で消えるので、作成も含めて
// 「人が使う量よりずっと上、濫用には効く」ところに置く。
const LIMITS = {
  create: { max: 60, windowMs: 10 * 60 * 1000 },   // 部屋を作る
  lookup: { max: 120, windowMs: 60 * 1000 },       // 部屋の概要・待合の一覧
  ws: { max: 60, windowMs: 60 * 1000 },            // WebSocket を繋ぐ（再接続を含む）
};

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
      const isWs = url.pathname === '/lobby/ws';
      if (isWs && req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426, cors);
      if (await tooMany(env, req, isWs ? 'ws' : 'lookup')) return json({ error: 'rate_limited' }, 429, cors);
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
      if (isWs) return lobby.fetch('https://lobby/ws', req);
      return withHeaders(await lobby.fetch('https://lobby/list'), cors);
    }

    const m = /^\/rooms(?:\/([^/]+))?(\/ws)?$/.exec(url.pathname);
    if (!m) return json({ error: 'not_found' }, 404, cors);
    const [, id, ws] = m;

    if (!id && req.method === 'POST') {
      if (await tooMany(env, req, 'create')) return json({ error: 'rate_limited' }, 429, cors);
      // 本文は数百バイトしかない。長さを見てから読む（読んでから捨てるのでは遅い）。
      const len = Number(req.headers.get('Content-Length') ?? 0);
      if (len > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413, cors);
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400, cors); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad_json' }, 400, cors);
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
    if (ws && req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426, cors);
    if (req.method !== 'GET') return json({ error: 'method' }, 405, cors);
    // 数えてから Room を起こす。無い部屋でも idFromName は Durable Object を1つ作る。
    if (await tooMany(env, req, ws ? 'ws' : 'lookup')) return json({ error: 'rate_limited' }, 429, cors);
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    if (ws) return stub.fetch('https://room/ws', req);
    return withHeaders(await stub.fetch('https://room/info'), cors);
  },
};

/** 上限を超えていれば true。数える相手（IP）ごとに Durable Object が1つ。 */
async function tooMany(env, req, kind) {
  if (!env.LIMITER) return false;
  const key = clientKey(req.headers.get('CF-Connecting-IP') ?? 'unknown');
  const lim = env.LIMITER.get(env.LIMITER.idFromName(key));
  try {
    const r = await lim.fetch(`https://limiter/hit?kind=${kind}`);
    const { allowed } = await r.json();
    return !allowed;
  } catch {
    return false;   // 数えられなくても対局は通す（歯止めは他にもある）
  }
}

/** 種類ごとの頻度。IP（IPv6 は /64）ごとに1つ、窓ぶんの時刻だけを持つ。 */
export class Limiter {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const kind = new URL(req.url).searchParams.get('kind') ?? 'create';
    const rule = LIMITS[kind] ?? LIMITS.create;
    const now = Date.now();
    const stored = await this.ctx.storage.get('hits');
    // 旧い形（作成だけを数えていた頃の配列）から移す。
    const all = Array.isArray(stored) ? { create: stored } : (stored ?? {});
    const hits = (all[kind] ?? []).filter(t => now - t < rule.windowMs);
    const allowed = hits.length < rule.max;
    if (allowed) hits.push(now);
    all[kind] = hits;
    // 窓の外へ出たものは持たない（storage が育たないように）。
    for (const [k, v] of Object.entries(all))
      if (!v.length || now - v[v.length - 1] > (LIMITS[k]?.windowMs ?? 0)) delete all[k];
    await this.ctx.storage.put('hits', all);
    const longest = Math.max(...Object.values(LIMITS).map(r => r.windowMs));
    await this.ctx.storage.setAlarm(now + longest + 60 * 1000);
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
