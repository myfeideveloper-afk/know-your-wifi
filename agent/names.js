// Resolves a human-friendly name for an IP using every cheap source available:
// unicast mDNS (Apple, Android, Linux, printers), NetBIOS (Windows), and DNS
// (names your router hands out via DHCP).
import dgram from 'node:dgram';
import dns from 'node:dns/promises';

const TIMEOUT = 1500;

const withTimeout = (promise, ms = TIMEOUT) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms, null))]).catch(() => null);

// Sends one UDP packet and resolves with the first reply, or null on timeout.
function udpQuery(ip, port, packet) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (value) => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(null), TIMEOUT);
    sock.on('error', () => done(null));
    sock.on('message', (msg, rinfo) => rinfo.address === ip && done(msg));
    sock.send(packet, port, ip, (err) => err && done(null));
  });
}

// Reads a (possibly compressed) DNS name starting at `offset`.
function readName(buf, offset) {
  const labels = [];
  let jumps = 0;
  while (offset < buf.length && jumps < 20) {
    const len = buf[offset];
    if (len === 0) return { name: labels.join('.'), end: offset + 1 };
    if ((len & 0xc0) === 0xc0) {
      const ptr = buf.readUInt16BE(offset) & 0x3fff;
      const rest = readName(buf, ptr);
      labels.push(rest.name);
      return { name: labels.join('.'), end: offset + 2 };
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += len + 1;
    jumps++;
  }
  return { name: labels.join('.'), end: offset };
}

const reverseName = (ip) => `${ip.split('.').reverse().join('.')}.in-addr.arpa`;

function encodeName(name) {
  const parts = name.split('.').map((label) => {
    const b = Buffer.from(label);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

// Asks the device itself (port 5353) "what is your name?" with a PTR query.
export async function mdnsName(ip) {
  const header = Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.concat([encodeName(reverseName(ip)), Buffer.from([0, 12, 0, 1])]);
  const reply = await udpQuery(ip, 5353, Buffer.concat([header, question]));
  if (!reply || reply.length < 12) return null;
  try {
    let offset = 12;
    for (let i = 0; i < reply.readUInt16BE(4); i++) offset = readName(reply, offset).end + 4;
    const answers = reply.readUInt16BE(6) + reply.readUInt16BE(8) + reply.readUInt16BE(10);
    for (let i = 0; i < answers; i++) {
      const { end } = readName(reply, offset);
      const type = reply.readUInt16BE(end);
      const rdlength = reply.readUInt16BE(end + 8);
      if (type === 12) return readName(reply, end + 10).name;
      offset = end + 10 + rdlength;
    }
  } catch {
    // Malformed reply; treat as no name.
  }
  return null;
}

// NetBIOS node status request for the wildcard name "*".
export async function netbiosName(ip) {
  const raw = Buffer.alloc(16);
  raw[0] = 0x2a;
  const encoded = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    encoded[i * 2] = (raw[i] >> 4) + 0x41;
    encoded[i * 2 + 1] = (raw[i] & 0x0f) + 0x41;
  }
  const packet = Buffer.concat([
    Buffer.from([0x13, 0x37, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x20]),
    encoded,
    Buffer.from([0, 0, 0x21, 0, 1]),
  ]);
  const reply = await udpQuery(ip, 137, packet);
  if (!reply || reply.length < 57) return null;
  const count = reply[56];
  for (let i = 0; i < count; i++) {
    const at = 57 + i * 18;
    if (at + 18 > reply.length) break;
    const suffix = reply[at + 15];
    const isGroup = reply.readUInt16BE(at + 16) & 0x8000;
    if (suffix === 0 && !isGroup) return reply.toString('latin1', at, at + 15).trim();
  }
  return null;
}

export async function dnsName(ip) {
  const names = await withTimeout(dns.reverse(ip));
  if (names?.[0]) return names[0];
  // getnameinfo goes through the OS resolver, which on macOS also asks mDNS.
  const svc = await withTimeout(dns.lookupService(ip, 0), 2500);
  return svc?.hostname && svc.hostname !== ip ? svc.hostname : null;
}

const cleanName = (name) =>
  name?.replace(/\.$/, '').replace(/\.(local|localdomain|lan|home|internal|home\.arpa)$/i, '') || null;

export async function resolveName(ip) {
  const [mdns, netbios, dnsResult] = await Promise.all([mdnsName(ip), netbiosName(ip), dnsName(ip)]);
  const sources = { mdns: cleanName(mdns), netbios: cleanName(netbios), dns: cleanName(dnsResult) };
  const name = sources.mdns ?? sources.netbios ?? sources.dns ?? null;
  const source = name ? Object.keys(sources).find((k) => sources[k] === name) : null;
  return { name, source };
}
