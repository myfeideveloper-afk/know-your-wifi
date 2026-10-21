# Know Your WiFi

See how many devices are connected to your network, right from your browser. There's nothing to install.

**Web page:** https://myfeideveloper-afk.github.io/know-your-wifi/

## How it works

Browsers can't ping or read the network's device list, but a page *can* time a connection attempt:

1. **Find the network.** The page tries common router addresses (`192.168.1.1`, `192.168.0.1`, `10.0.0.1`, …) and picks the one that answers. You can also type it into the **Network** box.
2. **Knock on every address.** It sends one `https://` request to all 254 addresses at once. A switched-on device accepts or refuses within about 2 seconds. An empty address never answers.
3. **Double-check.** The computer's OS sometimes fails a batch of empty addresses instantly. It also remembers failed addresses for about 20 seconds (`host_down_time` on macOS). Both look like real answers. So the page waits 21 seconds, then re-checks only the addresses that answered. Empty addresses go silent the second time.

A scan takes about 25 seconds.

## Limits

- **No names, makers or MAC addresses.** Browsers can't read them. Give devices nicknames instead; they're saved in your browser. Use **Open** to visit a device's own web page (routers, printers, cameras).
- **The count is a minimum.** Devices with a strict firewall don't answer. On a test network, the page found about 100 of the 145 devices.
- **Chrome / Edge** may ask to allow access to devices on your local network. Click **Allow**.
- Only `/24` networks (254 addresses) are scanned.
- Only scan networks you own or are allowed to scan.

## Publish

In the GitHub repo, go to **Settings → Pages → Build and deployment**, then pick **Deploy from a branch**, branch `main`, folder `/docs`.

To try it locally, serve the `docs/` folder with any static server, for example `python3 -m http.server -d docs`.
