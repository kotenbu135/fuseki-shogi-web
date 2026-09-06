// dist/_headers の `/*` に書いた見出しを読む。
//
// 本番（Cloudflare Pages）は _headers をそのまま効かせる。手元の serve.mjs と
// ブラウザのスモークテストが独自の見出しを書いていると、**CSP を一度も試さないまま**
// 通ってしまう。読む口を1つにして、配る側3つが同じ見出しを返すようにする。
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} dir dist ディレクトリ @returns {Record<string,string>} */
export function siteHeaders(dir) {
  const f = path.join(dir, '_headers');
  if (!fs.existsSync(f)) return {};
  const out = {};
  let inGlob = false;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    // 字下げの無い行はブロックの見出し（`/*` や `#` のコメント）。
    if (/^\S/.test(line)) { inGlob = line.trim() === '/*'; continue; }
    const m = inGlob ? /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line) : null;
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
