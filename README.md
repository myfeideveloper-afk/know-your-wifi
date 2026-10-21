# Know Your WiFi

See how many devices are connected to your network, right from your browser. There's nothing to install.

**Web page:** https://myfeideveloper-afk.github.io/know-your-wifi/

## How it works

Browsers can't ping or read the network's device list, but a page *can* time a connection attempt:

1. **Find the network.** The page tries common router addresses (`192.168.1.1`, `192.168.0.1`, `10.0.0.1`, …) and picks the one that answers. You can also type it into the **Network** box.
2. **Knock on every address.** It sends one `https://` request to all 254 addresses at once. A switched-on device accepts or refuses within about 2 seconds. An empty address never answers.
3. **Double-check.** The computer's OS sometimes fails a batch of empty addresses instantly. It also remembers failed addresses for about 20 seconds (`host_down_time` on macOS). Both look like real answers. So the page waits 21 seconds, then re-checks only the addresses that answered. Empty addresses go silent the second time.
4. **Guess the type.** A closed port refuses in one round trip. An open one hangs or takes longer (a TLS handshake). The page compares a surely-closed port (47123) with a few telltale ports:

   | Group | Signal | Accuracy on a 145-device office network |
   | --- | --- | --- |
   | Network | The router address (`.1`) | Exact |
   | Computers | AirPlay port 7000 open (Macs) | 15–18 of 27 Macs, no false Macs |
   | Devices with a web page | Port 80/443 slower than the closed port | Both printers, plus a few machines that run a web server |
   | Phones & smart devices | Everything else (Android phones and smart plugs look identical) | n/a |

   Identification probes 12 devices at a time, and first checks that a known device (the router) answers promptly. If Chrome is still busy with earlier, abandoned attempts, requests wait in a queue, the wait gets added to every timing, and every type comes out wrong. A device that doesn't answer at all is retried rather than called a phone. "Mac" and "web page" results are remembered per address, because a napping Mac sometimes skips the AirPlay test.

The page shows devices as tiles, grouped by type like the Windows Start menu, or sorted by address. Click a tile for its details, a nickname, and a link to its web page. A scan takes about 90 seconds, and scans are spaced at least 45 seconds apart. The network is detected once and then reused, because detection tries routers of other networks, and those unreachable attempts clog Chrome for about 70 seconds.

## Limits

- **No names, makers, MAC addresses or Wi‑Fi network names (SSIDs).** Browsers can't read them, and only the access points know which SSID each device joined.
- **Windows PCs and iPhones are invisible.** They silently drop every connection, so they can't be counted or identified. Give devices nicknames instead; they're saved in your browser. Use **Open** to visit a device's own web page (routers, printers, cameras).
- **The count is a minimum.** Devices with a strict firewall don't answer. On a test network, the page found about 100 of the 145 devices.
- **Chrome / Edge** may ask to allow access to devices on your local network. Click **Allow**.
- Only `/24` networks (254 addresses) are scanned.
- Only scan networks you own or are allowed to scan.

## Publish

In the GitHub repo, go to **Settings → Pages → Build and deployment**, then pick **Deploy from a branch**, branch `main`, folder `/docs`.

To try it locally, serve the `docs/` folder with any static server, for example `python3 -m http.server -d docs`.
