// Maps a MAC address to its manufacturer using Wireshark's OUI database.
// The file (~3 MB) is downloaded once and cached for 30 days.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANUF_URL = 'https://www.wireshark.org/download/automated/data/manuf';
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'manuf.txt');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let table = null; // Map<hex prefix, vendor>, keyed by 6, 7 or 9 hex chars

async function loadText() {
  const info = await stat(CACHE_FILE).catch(() => null);
  if (info && Date.now() - info.mtimeMs < MAX_AGE_MS) return readFile(CACHE_FILE, 'utf8');
  try {
    const res = await fetch(MANUF_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, text);
    return text;
  } catch (err) {
    if (info) return readFile(CACHE_FILE, 'utf8'); // stale cache beats nothing
    console.warn(`[vendor] Could not download vendor list (${err.message}); vendors will be blank.`);
    return '';
  }
}

function parse(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [prefix, short, long] = line.split('\t').map((s) => s?.trim());
    if (!prefix) continue;
    const [addr, bits = '24'] = prefix.split('/');
    const hex = addr.replace(/[:-]/g, '').toLowerCase().slice(0, Number(bits) / 4);
    map.set(hex, long || short);
  }
  return map;
}

export async function loadVendors() {
  table ??= parse(await loadText());
  return table;
}

export function lookupVendor(mac) {
  if (!table || !mac) return null;
  const hex = mac.replace(/:/g, '');
  return table.get(hex.slice(0, 9)) ?? table.get(hex.slice(0, 7)) ?? table.get(hex.slice(0, 6)) ?? null;
}
