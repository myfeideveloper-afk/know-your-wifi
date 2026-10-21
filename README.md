# Know Your WiFi

See how many devices are connected to your network and what they are: name, IP, MAC address, maker and a best-guess device type.

**Web page:** https://myfeideveloper-afk.github.io/know-your-wifi/

## How it works

Browsers can't scan a network, so the project has two parts:

| Part | What it does |
| --- | --- |
| `docs/` | The web page, hosted on GitHub Pages. |
| `agent/` | A small Node.js scanner you run on a computer on the network. It listens only on `127.0.0.1:7878` and only answers the GitHub Pages site. |

A scan:

1. Finds your network from the default route (for example `192.168.1.0/24`).
2. Sends one tiny UDP packet to every address, so the OS resolves each device's MAC address through ARP. This catches devices that ignore ping.
3. Reads the ARP table.
4. Asks each device for its name using mDNS (Apple, Android, Linux, printers), NetBIOS (Windows) and reverse DNS (names your router hands out).
5. Looks up the maker from the MAC prefix, using Wireshark's OUI list. The list is downloaded once and cached in `agent/.cache/`.

## Run it

You need Node.js 18 or later. There are no npm dependencies.

```sh
cd agent
npm start          # starts the scanner on http://127.0.0.1:7878
```

Then open the GitHub Pages link above, or http://127.0.0.1:7878, which the agent also serves. Use the local address on Safari, because Safari blocks HTTPS pages from calling `http://127.0.0.1`. Chrome may ask you to allow access to local network devices.

To scan from the terminal only:

```sh
npm run scan           # table
npm run scan -- --json # raw JSON
```

### Options (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7878` | Port for the local API. |
| `IFACE` | auto | Force an interface, for example `IFACE=en0`. |
| `ALLOWED_ORIGINS` | – | Extra comma-separated web origins allowed to call the agent. |

## Publish the page

In the GitHub repo, go to **Settings → Pages → Build and deployment**, then pick **Deploy from a branch**, branch `main`, folder `/docs`.

## Notes

- **Private MAC:** phones, tablets and laptops often use a randomized MAC, so the maker can't be identified. These devices usually still report a name.
- Devices that are asleep or on a separate guest network may not show up. Run another scan, or turn on auto-rescan.
- Large networks (bigger than /22) are limited to the /24 around your own address.
- Only scan networks you own or are allowed to scan.
