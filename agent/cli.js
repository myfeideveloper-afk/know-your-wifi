// Prints a one-off scan to the terminal: `npm run scan` (add --json for raw output).
import { scanNetwork } from './scan.js';

const result = await scanNetwork({ iface: process.env.IFACE });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const { network, count, durationMs } = result;
  console.log(`\n${count} devices on ${network.cidr} (${network.iface}) in ${(durationMs / 1000).toFixed(1)}s\n`);
  console.table(
    result.devices.map((d) => ({
      IP: d.ip,
      Name: d.name ?? '',
      Vendor: d.vendor ?? (d.randomizedMac ? '(private MAC)' : ''),
      MAC: d.mac,
      Note: [d.isSelf && 'this computer', d.isGateway && 'router'].filter(Boolean).join(', '),
    })),
  );
}
