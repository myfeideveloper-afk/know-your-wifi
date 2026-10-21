// Local HTTP API for the Know Your WiFi page. Listens on 127.0.0.1 only and
// answers only the origins listed below, so random websites can't use it to
// scan your network.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanNetwork } from './scan.js';

const PORT = Number(process.env.PORT ?? 7878);
const HOST = '127.0.0.1';
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const ALLOWED_ORIGINS = new Set([
  'https://myfeideveloper-afk.github.io',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...(process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

let inFlight = null; // share one scan between concurrent requests

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function serveStatic(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const file = normalize(join(WEB_ROOT, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(WEB_ROOT + sep)) return send(res, 403, 'Forbidden');
  try {
    const body = await readFile(file);
    send(res, 200, body, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  // Block DNS-rebinding attacks: only answer when addressed as localhost.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'Misdirected request');

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return send(res, 403, { error: `Origin ${origin} is not allowed. Add it with ALLOWED_ORIGINS.` });
  }
  const cors = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        Vary: 'Origin',
      }
    : {};

  if (req.method === 'OPTIONS') return send(res, 204, '', cors);
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed', cors);

  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/api/health') return send(res, 200, { ok: true, version: 1 }, cors);
  if (path === '/api/scan') {
    try {
      inFlight ??= scanNetwork({ iface: process.env.IFACE }).finally(() => (inFlight = null));
      return send(res, 200, await inFlight, cors);
    } catch (err) {
      return send(res, 500, { error: err.message }, cors);
    }
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Know Your WiFi agent running on http://${HOST}:${PORT}`);
  console.log(`Allowed web origins: ${[...ALLOWED_ORIGINS].join(', ')}`);
});
