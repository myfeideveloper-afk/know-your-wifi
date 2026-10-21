// Finds the local network, wakes every host on it, and reads the ARP table.
import os from 'node:os';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Subnets bigger than this are clamped to the /24 around our own address.
const MIN_PREFIX = 22;

export const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
export const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

const maskToPrefix = (mask) =>
  ipToInt(mask).toString(2).replace(/0+$/, '').length;

export function normalizeMac(mac) {
  const parts = mac.toLowerCase().split(/[:-]/);
  if (parts.length !== 6) return null;
  return parts.map((p) => p.padStart(2, '0')).join(':');
}

async function defaultRoute() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('route', ['-n', 'get', 'default']);
      return {
        gateway: stdout.match(/gateway:\s*(\S+)/)?.[1],
        iface: stdout.match(/interface:\s*(\S+)/)?.[1],
      };
    }
    if (process.platform === 'linux') {
      const { stdout } = await run('ip', ['-4', 'route', 'show', 'default']);
      return {
        gateway: stdout.match(/via\s+(\S+)/)?.[1],
        iface: stdout.match(/dev\s+(\S+)/)?.[1],
      };
    }
    if (process.platform === 'win32') {
      const { stdout } = await run('route', ['print', '-4', '0.0.0.0']);
      const m = stdout.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)/m);
      return { gateway: m?.[1], localIp: m?.[2] };
    }
  } catch {
    // No default route (offline) or the tool is missing; fall through.
  }
  return {};
}

// Picks the IPv4 network to scan. `preferIface` comes from the IFACE env var.
export async function detectNetwork(preferIface) {
  const route = await defaultRoute();
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const prefix = maskToPrefix(a.netmask);
      const network = (ipToInt(a.address) & ipToInt(a.netmask)) >>> 0;
      candidates.push({ iface: name, address: a.address, mac: a.mac, prefix, network });
    }
  }
  if (!candidates.length) throw new Error('No active IPv4 network interface found. Are you connected to Wi-Fi?');

  const inSubnet = (c, ip) => ip && ((ipToInt(ip) ^ c.network) >>> (32 - c.prefix)) === 0;
  const pick =
    candidates.find((c) => c.iface === preferIface) ??
    candidates.find((c) => c.iface === route.iface && inSubnet(c, route.gateway)) ??
    candidates.find((c) => c.address === route.localIp) ??
    candidates.find((c) => inSubnet(c, route.gateway)) ??
    candidates[0];

  let { prefix, network } = pick;
  const clamped = prefix < MIN_PREFIX;
  if (clamped) {
    prefix = 24;
    network = (ipToInt(pick.address) & 0xffffff00) >>> 0;
  }
  const broadcast = (network | (2 ** (32 - prefix) - 1)) >>> 0;
  return {
    iface: pick.iface,
    address: pick.address,
    mac: normalizeMac(pick.mac),
    gateway: inSubnet({ network, prefix }, route.gateway) ? route.gateway : null,
    cidr: `${intToIp(network)}/${prefix}`,
    first: network + 1,
    last: broadcast - 1,
    clamped,
  };
}

// Sending any UDP packet to an address on the LAN makes the OS resolve its MAC
// via ARP, even if the device ignores pings. The port doesn't matter.
export async function wakeHosts(net, rounds = 2) {
  const sock = dgram.createSocket('udp4');
  sock.on('error', () => {});
  const payload = Buffer.from([0]);
  try {
    for (let r = 0; r < rounds; r++) {
      for (let n = net.first; n <= net.last; n++) {
        sock.send(payload, 9, intToIp(n), () => {});
        if (n % 64 === 0) await sleep(5); // avoid ENOBUFS on large subnets
      }
      await sleep(400);
    }
    await sleep(1200);
  } finally {
    sock.close();
  }
}

async function readArpText() {
  if (process.platform === 'linux') {
    try {
      return await readFile('/proc/net/arp', 'utf8');
    } catch {
      // fall back to the arp binary below
    }
  }
  const args = process.platform === 'win32' ? ['-a'] : ['-an'];
  const { stdout } = await run('arp', args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function readArpTable(net) {
  const text = await readArpText();
  const seen = new Map();
  for (const line of text.split('\n')) {
    const ip = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
    const rawMac = line.match(/\b([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/i)?.[1];
    if (!ip || !rawMac) continue;
    const mac = normalizeMac(rawMac);
    const n = ipToInt(ip);
    if (!mac || n < net.first || n > net.last) continue;
    if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') continue;
    if (parseInt(mac.slice(0, 2), 16) & 1) continue; // multicast
    seen.set(ip, mac);
  }
  return [...seen].map(([ip, mac]) => ({ ip, mac }));
}

// Locally administered bit set = randomized "private" MAC (iOS, Android, Windows).
export const isRandomizedMac = (mac) => (parseInt(mac.slice(0, 2), 16) & 2) === 2;
