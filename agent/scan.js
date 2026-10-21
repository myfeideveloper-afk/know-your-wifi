import os from 'node:os';
import { detectNetwork, ipToInt, isRandomizedMac, readArpTable, wakeHosts } from './network.js';
import { resolveName } from './names.js';
import { loadVendors, lookupVendor } from './vendor.js';

const NAME_CONCURRENCY = 32;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function scanNetwork({ iface } = {}) {
  const started = Date.now();
  const [net] = await Promise.all([detectNetwork(iface), loadVendors()]);
  await wakeHosts(net);

  const entries = await readArpTable(net);
  if (net.mac && !entries.some((e) => e.ip === net.address)) {
    entries.push({ ip: net.address, mac: net.mac });
  }
  entries.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  const devices = await mapLimit(entries, NAME_CONCURRENCY, async ({ ip, mac }) => {
    const isSelf = ip === net.address;
    let { name, source } = await resolveName(ip);
    if (!name && isSelf) [name, source] = [os.hostname().split('.')[0], 'os'];
    return {
      ip,
      mac,
      name,
      nameSource: source,
      vendor: lookupVendor(mac),
      randomizedMac: isRandomizedMac(mac),
      isSelf,
      isGateway: ip === net.gateway,
    };
  });

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    network: {
      iface: net.iface,
      cidr: net.cidr,
      address: net.address,
      gateway: net.gateway,
      clamped: net.clamped,
    },
    count: devices.length,
    devices,
  };
}
