// オンライン対局の通信。部屋（worker/src/room.js）との WebSocket の往復と、再接続。
//
// Game を知らない。渡すのは手順のトークンと結果だけで、局面はこちらでは持たない。
// 切れたら指数バックオフで繋ぎ直し、繋がるたびに join を送って state を丸ごと受ける
// （main.js がそれで手順を合わせる）。
//
// 席のトークンは localStorage に控える。同じ端末なら再読み込みしても同じ席に戻れる。

const SEAT_KEY = id => `fuseki-room-seat:${id}`;
const NICK_KEY = 'fuseki-nick';

/** ニックネーム。席の名前として部屋に送る。空なら無名。 */
export const nickStore = {
  save(v) { try { localStorage.setItem(NICK_KEY, v ?? ''); } catch { /* 残せなくても指せる */ } },
  load() { try { return localStorage.getItem(NICK_KEY) ?? ''; } catch { return ''; } },
};

export const seatStore = {
  save(id, seat) { try { localStorage.setItem(SEAT_KEY(id), seat); } catch { /* 残せなくても指せる */ } },
  load(id) { try { return localStorage.getItem(SEAT_KEY(id)); } catch { return null; } },
  drop(id) { try { localStorage.removeItem(SEAT_KEY(id)); } catch { /* 無視 */ } },
};

/** 部屋を作る。返るのは部屋の ID と、作った人の席のトークン。 */
export async function createRoom(base, { mode, time, side, role, lang, nick, isPublic }) {
  const r = await fetch(`${base}/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, time, side, role, lang, nick, public: !!isPublic }),
  });
  if (!r.ok) throw new Error(`部屋を作れない (${r.status})`);
  return r.json();
}

/** 部屋の概要。参加する前に「何の対局か」を見せるため。無ければ null。 */
export async function roomInfo(base, id) {
  const r = await fetch(`${base}/rooms/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`部屋を読めない (${r.status})`);
  return r.json();
}

/** 部屋の URL（招待リンク）。言語はこのページのもの。 */
export function roomUrl(id) {
  const u = new URL(location.href);
  u.hash = `#room/${id}`;
  return u.href;
}

/** URL のハッシュから部屋の ID。無ければ null。 */
export function roomIdFromHash(hash = location.hash) {
  const m = /^#\/?room\/([a-z2-9]{8})$/.exec(hash);
  return m ? m[1] : null;
}

export class RoomClient extends EventTarget {
  /**
   * @param {string} base Worker のURL（https://ws.fusekishogi.com）
   * @param {string} id 部屋の ID
   * @param {string|null} seat 席のトークン。無ければ空いている席に着く（埋まっていれば観戦）
   * @param {{nick?: string, spectate?: boolean}} [opts] 名前と、最初から観戦で入るか
   */
  constructor(base, id, seat, { nick = '', spectate = false } = {}) {
    super();
    this.base = base;
    this.id = id;
    this.seat = seat;
    this.nick = nick;
    this.spectate = spectate;
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this._timer = null;
    this.connected = false;
  }

  get wsUrl() {
    const u = new URL(`${this.base}/rooms/${encodeURIComponent(this.id)}/ws`);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    return u.href;
  }

  connect() {
    if (this.closed) return;
    clearTimeout(this._timer);
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch (e) { return this._retry(e); }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      this._emit('open');
      this.send({ t: 'join', ...(this.seat ? { seat: this.seat } : {}), ...(this.nick ? { nick: this.nick } : {}), ...(this.spectate ? { spectate: true } : {}) });
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'state' && msg.seatToken) {
        this.seat = msg.seatToken;
        seatStore.save(this.id, this.seat);
      }
      this._emit(msg.t, msg);
    };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      if (was) this._emit('close', { code: ev.code, reason: ev.reason });
      // 部屋が消えた（期限）なら繋ぎ直さない。
      if (ev.reason === 'expired' || ev.reason === 'cancelled') { this.closed = true; this._emit(ev.reason); return; }
      this._retry();
    };
    ws.onerror = () => { /* onclose が続く */ };
  }

  _retry() {
    if (this.closed) return;
    // 0.5秒から倍々で、10秒まで。
    const wait = Math.min(10000, 500 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this._emit('reconnecting', { attempt: this.attempt, waitMs: wait });
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), wait);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  move(ply, token) { return this.send({ t: 'move', ply, token }); }
  over(ply, result) { return this.send({ t: 'over', ply, result }); }
  resign() { return this.send({ t: 'resign' }); }
  claim() { return this.send({ t: 'claim' }); }
  cancel() { return this.send({ t: 'cancel' }); }
  offer(kind) { return this.send({ t: 'offer', kind }); }
  accept(kind) { return this.send({ t: 'accept', kind }); }
  decline(kind) { return this.send({ t: 'decline', kind }); }
  requestState() { return this.send({ t: 'state' }); }

  close() {
    this.closed = true;
    clearTimeout(this._timer);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    try { ws?.close(1000, 'leave'); } catch { /* 既に閉じている */ }
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * 待合（公開で募集している部屋の一覧）。ホームを開いているあいだ繋いでおき、
 * 一覧が変わるたびに seeks が届く。切れたら繋ぎ直す。
 */
export class LobbyClient extends EventTarget {
  constructor(base) {
    super();
    this.base = base;
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this._timer = null;
    this.seeks = [];
  }
  get wsUrl() {
    const u = new URL(`${this.base}/lobby/ws`);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    return u.href;
  }
  connect() {
    if (this.closed) return;
    clearTimeout(this._timer);
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch { return this._retry(); }
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'seeks' && Array.isArray(msg.seeks)) {
        this.seeks = msg.seeks;
        this.dispatchEvent(new CustomEvent('seeks', { detail: this.seeks }));
      }
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this._retry(); } };
    ws.onerror = () => { /* onclose が続く */ };
  }
  _retry() {
    if (this.closed) return;
    // 待合は急がない。2秒から倍々で、60秒まで。
    const wait = Math.min(60000, 2000 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), wait);
  }
  close() {
    this.closed = true;
    clearTimeout(this._timer);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, 'leave'); } catch { /* 既に閉じている */ }
  }
}
