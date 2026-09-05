// 部屋のルールのうち、Durable Object の API に依存しない部分。手番機・時計・トークンの形。
//
// 局面の合法性は見ない（段1）。両者のブラウザが同じコード（wasm/ と shogiops）で検証し、
// ここは「誰の番か」「手順の連番」「時計」だけを裁く。合法性まで見るのは段2
// （開発リポジトリ docs/plan-online-play.md）。
//
// test/rules_test.mjs が Node で直接通す。

export const SEATS = ['host', 'guest'];
export const SENTE = 'sente';
export const GOTE = 'gote';

/** 持ち時間。キーは src/main.js の TIME_CONTROLS と同じ（クライアントはキーだけ送る）。 */
export const TIME_CONTROLS = {
  none: null,
  '3m': { initialMs: 180000 },
  '10s': { initialMs: 0, byoyomiMs: 10000 },
  '10m+30s': { initialMs: 600000, byoyomiMs: 30000 },
  '5m+5s': { initialMs: 300000, incrementMs: 5000 },
};

/** 通常フェーズの手数の上限。ここまで指したら引き分け（部屋が無限に生きないため）。 */
export const MAX_NORMAL_MOVES = 320;
/** 相手が不在のまま、残った側が勝ちを申し出られるまでの時間。 */
export const ABANDON_MS = 5 * 60 * 1000;
/** 対局が始まった部屋を最後の動きから消すまで。 */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** 相手が来ないまま部屋を消すまで。 */
export const UNJOINED_TTL_MS = 2 * 60 * 60 * 1000;

const DROP_RE = /^[PLNSGBRK]\*[1-9][a-i]$/;
const KING_DROP_RE = /^K\*[1-9][a-i]$/;
const MOVE_RE = /^[1-9][a-i][1-9][a-i]\+?$/;
const CHOOSE_RE = /^choose:(sente|gote)$/;

export const other = seat => (seat === 'host' ? 'guest' : 'host');
export const otherColor = c => (c === SENTE ? GOTE : SENTE);

/** 役（天秤将棋）の席。 */
export function roleSeat(state, role) {
  return SEATS.find(s => state.seats[s].role === role) ?? null;
}
export function seatOfColor(state, color) {
  return SEATS.find(s => state.seats[s].side === color) ?? null;
}
export function colorOfSeat(state, seat) {
  return state.seats[seat]?.side ?? null;
}

/** 布石の駒打ちの数（天秤将棋の選択のトークンは数えない）。 */
export function dropCount(tokens) {
  return tokens.filter(t => !t.startsWith('choose:')).filter(t => t.includes('*')).length;
}
/** 41手目以降の手数。 */
export function normalCount(tokens) {
  const drops = tokens.filter(t => !t.startsWith('choose:'));
  return Math.max(0, drops.length - 40);
}

/**
 * いま誰の番か。対局が始まっていない・終わっていれば null。
 * 天秤将棋: 置く役が2手 → 選ぶ役が choose → 選ばれた側から交互。
 */
export function turnSeat(state) {
  if (state.result || !state.startedAt) return null;
  const n = state.tokens.length;
  if (state.mode === 'kings-first') {
    if (n < 2) return roleSeat(state, 'placer');
    if (n === 2) return roleSeat(state, 'chooser');
    const m = n - 3;
    return seatOfColor(state, m % 2 === 0 ? SENTE : GOTE);
  }
  return seatOfColor(state, n % 2 === 0 ? SENTE : GOTE);
}

/**
 * トークンの形と、その段で許される種類。合法性は見ない。
 * 返り値はエラーのコード（null なら通る）。
 */
export function tokenError(state, token) {
  if (typeof token !== 'string' || token.length > 12) return 'bad_token';
  const n = state.tokens.length;
  if (state.mode === 'kings-first') {
    if (n < 2) return KING_DROP_RE.test(token) ? null : 'expect_king';
    if (n === 2) return CHOOSE_RE.test(token) ? null : 'expect_choose';
  }
  if (token.startsWith('choose:')) return 'unexpected_choose';
  const drops = dropCount(state.tokens);
  if (drops < 40) return DROP_RE.test(token) ? null : 'expect_drop';
  if (normalCount(state.tokens) >= MAX_NORMAL_MOVES) return 'too_long';
  if (MOVE_RE.test(token)) return null;
  if (DROP_RE.test(token) && !token.startsWith('K*')) return null;
  return 'bad_token';
}

/** トークンを1つ適用したときの席の変化（天秤将棋の選択で色が決まる）。state を書き換える。 */
export function applyToken(state, token) {
  state.tokens.push(token);
  const m = CHOOSE_RE.exec(token);
  if (m) {
    const chooser = roleSeat(state, 'chooser');
    state.seats[chooser].side = m[1];
    state.seats[other(chooser)].side = otherColor(m[1]);
  }
}

// ---- 時計 ----
//
// 席ごとに持つ（色ではなく）。天秤将棋では先後が決まる前から手番があり、色で持つと
// 置く役の時計をどこにも置けない。
//
// 秒読みは「本時間を使い切ってから1手 byoyomiMs」（src/main.js と同じ）。
// 加算（フィッシャー）は着手の確定時に足す。

export function newClock(tc) {
  const entry = () => ({ mainMs: tc ? tc.initialMs : 0 });
  return { host: entry(), guest: entry(), running: null, since: 0 };
}

/** 席の残り。elapsedMs はその席の今の手番で使った時間（手番でなければ 0）。 */
export function remaining(entry, tc, elapsedMs) {
  if (!tc) return { mainMs: 0, byMs: 0, expired: false };
  const by = tc.byoyomiMs ?? 0;
  const main = entry.mainMs - elapsedMs;
  if (main > 0) return { mainMs: main, byMs: by, expired: false };
  // 本時間を使い切った。秒読みが無ければその時点で切れ（0 ちょうども切れ）。
  const left = by + main;   // main は 0 以下
  return { mainMs: 0, byMs: Math.max(0, left), expired: left <= 0 };
}

/** 手番が閉じた。使ったぶんを引き、加算を足す。切れていれば expired。 */
export function closeTurn(entry, tc, elapsedMs) {
  if (!tc) return { expired: false };
  const r = remaining(entry, tc, elapsedMs);
  if (r.expired) return { expired: true };
  entry.mainMs = r.mainMs + (tc.incrementMs ?? 0);
  return { expired: false };
}

/** 走っている席の時計が切れる時刻（ms）。無制限や止まっていれば null。 */
export function deadline(clock, tc) {
  if (!tc || !clock.running) return null;
  const e = clock[clock.running];
  return clock.since + e.mainMs + (tc.byoyomiMs ?? 0);
}

/** 部屋を消してよい時刻。 */
export function expiresAt(state) {
  return state.startedAt ? state.lastActiveAt + ROOM_TTL_MS : state.createdAt + UNJOINED_TTL_MS;
}

/** 8文字の部屋ID。読み違えやすい文字（0 o 1 l i）は使わない。 */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomId(bytes) {
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}
