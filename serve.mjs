// dist/ をローカルへ配るだけの静的サーバ。
//
// 単にファイルを返すだけでは足りない。やねうら王のWASMは SharedArrayBuffer を使うので、
// COOP/COEP が立っていないブラウザは crossOriginIsolated にならず、スレッドが起動しない。
// 本番（Cloudflare Pages）は _headers が同じ2行を立てる。
//
//   node serve.mjs [ポート]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 既定は dist-local/（--with-model の出力＝重みが入っていて実際に指せる）。
// 無ければ dist/（配布用。布石AIは動かない）。第1引数で明示もできる。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? path.resolve(process.argv[2])
  : (fs.existsSync(path.join(HERE, 'dist-local')) ? path.join(HERE, 'dist-local') : path.join(HERE, 'dist'));
const PORT = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.json': 'application/json', '.map': 'application/json',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/  (${path.basename(ROOT)}/ を配信中)`));
