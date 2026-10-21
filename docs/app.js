// Browser-only LAN scan. A page can't read ARP tables or send pings, but it can
// time connection attempts: a live device answers (accepts or refuses) quickly,
// while an empty address never answers and the attempt times out.
// We use https:// so no request is blocked as mixed content.
//
// The catch: the OS sometimes fails a whole batch of empty addresses at once,
// and it remembers failed addresses for 20s (macOS host_down_time), failing new
// connections to them instantly. Both look exactly like a live device answering.
// So every scan is two passes: knock on everything, wait out that 20s memory,
// then re-check only the addresses that answered. Empty ones go silent.

// Live devices answer within ~2.1s (measured). Empty addresses are reported
// unreachable from ~2.2s on (macOS) or ~3s (Windows, Linux), so stay below that.
const TIMEOUT_MS = 2200;
const SETTLE_MS = 21_000; // > host_down_time, before the confirm pass
// Between scans. Chrome keeps abandoned attempts to unreachable addresses alive
// for ~70s and they hold its shared connection pool; this lets them drain.
const COOLDOWN_MS = 45_000;
const AUTO_SCAN_MS = 180_000;

// Router addresses used by most home and office networks.
const COMMON_SUBNETS = [
  '192.168.1', '192.168.0', '192.168.100', '192.168.2', '192.168.8', '192.168.31', '192.168.50',
  '192.168.88', '192.168.178', '192.168.10', '192.168.3', '192.168.11', '192.168.254',
  '10.0.0', '10.0.1', '10.1.1', '10.10.10', '172.16.0', '172.16.1',
];

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const nicknames = store.get('kyw.nicknames', {}); // "192.168.1.5" -> nickname
let devices = []; // { ip, ms, isRouter, isNew }
let scanning = false;
let autoTimer = null;

// ---------- probing ----------

// Resolves with the response time in ms, or null if nothing answered.
async function timePort(ip, port = 443, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  try {
    await fetch(`https://${ip}:${port}/`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return performance.now() - t0;
  } catch {
    return ctrl.signal.aborted ? null : performance.now() - t0;
  } finally {
    clearTimeout(timer);
  }
}

const probeHost = (ip) => timePort(ip);

// Probes every address at the same moment (one socket each; Chrome allows ~256),
// so the pass ends before the OS starts failing lookups in bulk.
async function probeAll(ips, onResult) {
  await Promise.all(ips.map(async (ip) => onResult(ip, await probeHost(ip))));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- identifying ----------
// A refused port answers in one round trip. A port with something listening
// either hangs (the service ignores our TLS hello) or takes extra round trips
// (a TLS handshake). Comparing against a port that's surely closed tells them
// apart. Measured on a real network: Macs keep AirPlay (7000) open; routers,
// access points and printers answer slower on 80/443 because they run a web page.
// Windows PCs and iPhones drop every connection, so they never show up at all.

const KINDS = {
  router: { label: 'Router', group: 'Network', icon: '📡', tint: 'blue' },
  mac: { label: 'Mac or Apple device', group: 'Computers', icon: '💻', tint: 'slate' },
  web: { label: 'Device with a web page', group: 'Devices with a web page', icon: '🌐', tint: 'teal' },
  other: { label: 'Phone or smart device', group: 'Phones & smart devices', icon: '📱', tint: 'violet' },
};
const KIND_ORDER = ['router', 'mac', 'web', 'other'];
const CLOSED_PORT = 47123; // nothing listens here; Chrome doesn't block it
const IDENTIFY_TIMEOUT_MS = 3000;
const IDENTIFY_CONCURRENCY = 12; // devices at once, ~4 sockets each. If requests have
// to queue in Chrome, the wait is added to the measurement and every type comes out wrong.
const INCONCLUSIVE = null;

// Waits until a device we know is alive answers promptly again, i.e. Chrome
// isn't queueing our requests behind earlier, abandoned ones.
async function waitForFreeConnections(ip, maxWaitMs = 30_000) {
  const end = Date.now() + maxWaitMs;
  while (Date.now() < end) {
    const answers = await Promise.all(Array.from({ length: 8 }, () => timePort(ip, CLOSED_PORT, 1000)));
    if (answers.filter((ms) => ms != null).length >= 7) return;
    await sleep(2000);
  }
}

async function fastest(ip, port, tries = 3) {
  let best = null;
  for (let i = 0; i < tries; i++) {
    const ms = await timePort(ip, port, IDENTIFY_TIMEOUT_MS);
    if (ms != null && (best == null || ms < best)) best = ms;
  }
  return best;
}

async function identify(d) {
  if (d.isRouter) return 'router';
  const [closed, https, http, airplay] = await Promise.all([
    fastest(d.ip, CLOSED_PORT),
    fastest(d.ip, 443),
    fastest(d.ip, 80),
    timePort(d.ip, 7000, IDENTIFY_TIMEOUT_MS),
  ]);
  // It answered a moment ago, so silence now means it's asleep or our requests
  // were held up, not that it's a phone. Try again later.
  if (closed == null || closed > 1500) return INCONCLUSIVE;
  if (airplay == null) return 'mac';
  const listening = (ms) => ms == null || (ms > closed * 2.5 && ms > closed + 40);
  if (listening(https) || listening(http)) return 'web';
  return 'other';
}

// `referenceIp` is a device known to answer (the router, or the fastest device),
// used to check Chrome isn't holding our requests back before each round.
async function identifyAll(list, referenceIp, onDone) {
  const runRound = async (queue) => {
    await waitForFreeConnections(referenceIp);
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const d = queue[next++];
        d.kind = await identify(d);
        if (d.kind !== INCONCLUSIVE) onDone(d);
      }
    };
    await Promise.all(Array.from({ length: IDENTIFY_CONCURRENCY }, worker));
  };
  await runRound(list);
  const retry = list.filter((d) => d.kind === INCONCLUSIVE);
  if (retry.length) {
    await sleep(3000);
    await runRound(retry);
  }
  for (const d of list) {
    if (d.kind === INCONCLUSIVE) {
      d.kind = d.previousKind ?? 'other';
      onDone(d);
    } else if (d.kind === 'other' && d.previousKind && d.previousKind !== 'other') {
      // "Mac" and "web page" are positive evidence; "other" is only the lack of it
      // (a napping Mac skips AirPlay now and then), so keep the earlier answer.
      d.kind = d.previousKind;
      onDone(d);
    }
  }
}

async function findSubnet() {
  const hits = await Promise.all(
    COMMON_SUBNETS.map(async (s) => ({ s, ms: await probeHost(`${s}.1`) })),
  );
  const live = hits.filter((h) => h.ms != null).sort((a, b) => a.ms - b.ms);
  return live[0]?.s ?? null;
}

const ipToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const validSubnet = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => +o <= 255);

async function scan() {
  if (scanning) return;
  scanning = true;
  setBusy(true);
  hideNotice();

  try {
    const wait = store.get('kyw.lastScanAt', 0) + COOLDOWN_MS - Date.now();
    if (wait > 0 && wait <= COOLDOWN_MS) {
      for (let s = Math.ceil(wait / 1000); s > 0; s--) {
        setMeta(`Letting the network settle… starting in ${s}s`);
        await sleep(1000);
      }
    }
    // Auto-detection knocks on routers of other networks, and those unreachable
    // attempts clog Chrome for ~70s, so detect once and reuse the answer.
    let subnet = $('subnet').value.trim().replace(/\.$/, '') || store.get('kyw.lastSubnet', '');
    if (!subnet) {
      setMeta('Finding your network…');
      subnet = await findSubnet();
      if (!subnet) {
        showNotice(
          'Couldn’t find your network automatically. If your browser asked for permission to access ' +
          'local network devices, click <b>Allow</b> and scan again. Otherwise type the first three parts ' +
          'of your router’s address (for example <code>192.168.1</code>) in the Network box.',
        );
        setMeta('No network found.');
        return;
      }
      $('subnet').placeholder = subnet;
    } else if (!validSubnet(subnet)) {
      showNotice('Network should look like <code>192.168.1</code>.');
      return;
    }
    await sweep(subnet);
  } finally {
    scanning = false;
    setBusy(false);
    render();
  }
}

async function sweep(subnet) {
  const knownKey = `kyw.known.${subnet}`;
  const known = new Set(store.get(knownKey, []));
  const firstScan = known.size === 0;
  const kindsKey = `kyw.kinds.${subnet}`;
  const pastKinds = store.get(kindsKey, {}); // ip -> kind from earlier scans
  const started = performance.now();
  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

  devices = [];
  $('networkLabel').textContent = `${subnet}.0/24`;
  $('results').hidden = false;
  $('progress').hidden = false;
  const progress = (fraction) => { $('progressBar').style.width = `${fraction * 100}%`; };
  progress(0);
  setMeta('Knocking on every address…');
  render();

  // Pass 1: find candidates.
  await probeAll(ips, (ip, ms) => {
    if (ms == null) return;
    devices.push({
      ip, ms, isRouter: ip === `${subnet}.1`, isNew: !firstScan && !known.has(ip), checking: true,
      previousKind: pastKinds[ip],
    });
    render();
  });

  // If the browser refused every request outright, every address "answers" instantly.
  if (devices.length > 240 && devices.filter((d) => d.ms < 40).length > 200) {
    devices = [];
    store.set('kyw.lastScanAt', Date.now());
    $('progress').hidden = true;
    render();
    showNotice(
      'Your browser blocked the scan. In Chrome or Edge, click the icon at the left of the address bar, ' +
      'allow <b>Local network access</b>, then scan again.',
    );
    setMeta('Scan blocked by the browser.');
    return;
  }

  // Wait out the OS's memory of failed addresses, then pass 2: confirm.
  const settleEnd = Date.now() + SETTLE_MS;
  while (Date.now() < settleEnd) {
    const left = settleEnd - Date.now();
    progress(0.1 + 0.8 * (1 - left / SETTLE_MS));
    setMeta(`Found ${devices.length} possible devices. Double-checking in ${Math.ceil(left / 1000)}s…`);
    await sleep(Math.min(1000, left));
  }
  progress(0.95);
  setMeta(`Double-checking ${devices.length} devices…`);
  const confirmed = new Map();
  await probeAll(devices.map((d) => d.ip), (ip, ms) => ms != null && confirmed.set(ip, ms));
  devices = devices
    .filter((d) => confirmed.has(d.ip))
    .map((d) => ({ ...d, ms: Math.min(d.ms, confirmed.get(d.ip)), checking: false }));

  // Pass 3: work out what each device is. Only live devices are probed, so the
  // OS's failed-address memory doesn't come into play here.
  let identified = 0;
  setMeta(`Found ${devices.length} devices. Working out what they are…`);
  render();
  const reference = devices.find((d) => d.isRouter) ?? [...devices].sort((a, b) => a.ms - b.ms)[0];
  if (reference) {
    await identifyAll(devices, reference.ip, () => {
      identified++;
      progress(0.95 + 0.05 * (identified / devices.length));
      render();
    });
  }
  store.set('kyw.lastScanAt', Date.now());
  $('progress').hidden = true;

  for (const d of devices) {
    known.add(d.ip);
    pastKinds[d.ip] = d.kind;
  }
  store.set(knownKey, [...known]);
  store.set(kindsKey, pastKinds);
  store.set('kyw.lastSubnet', subnet);

  const secs = ((performance.now() - started) / 1000).toFixed(1);
  const newCount = devices.filter((d) => d.isNew).length;
  const when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setMeta(`Scanned at ${when} in ${secs}s` + (newCount ? ` · ${newCount} new` : ''));
  render();
}

// ---------- rendering ----------

function setBusy(busy) {
  const btn = $('scanBtn');
  btn.classList.toggle('busy', busy);
  btn.disabled = busy;
  btn.querySelector('.btn-label').textContent = busy ? 'Scanning…' : 'Scan network';
}

const setMeta = (text) => { $('scanMeta').textContent = text; };
const hideNotice = () => { $('notice').hidden = true; };
function showNotice(html) {
  $('notice').innerHTML = html;
  $('notice').hidden = false;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const PENDING = { label: 'Checking…', group: 'Found so far', icon: '📶', tint: 'gray' };
const SHORT = { router: 'Router', mac: 'Mac', web: 'Web device', other: 'Device' };
const kindOf = (d) => KINDS[d.kind] ?? PENDING;
const tileName = (d) => nicknames[d.ip] || (d.kind ? SHORT[d.kind] : 'Checking…');

function render() {
  $('deviceCount').textContent = devices.length;
  const q = $('search').value.trim().toLowerCase();
  const visible = devices
    .filter((d) => !q || [d.ip, nicknames[d.ip], kindOf(d).label].some((v) => v?.toLowerCase().includes(q)))
    .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  const root = $('groups');
  if (!visible.length) {
    root.replaceChildren(el('p', 'empty', scanning ? 'Looking…' : 'No devices found.'));
    return;
  }
  if ($('view').value === 'all') {
    root.replaceChildren(group(null, visible));
    return;
  }
  const byKind = new Map();
  for (const d of visible) {
    const k = d.kind ?? 'pending';
    byKind.set(k, [...(byKind.get(k) ?? []), d]);
  }
  root.replaceChildren(
    ...[...KIND_ORDER, 'pending']
      .filter((k) => byKind.has(k))
      .map((k) => group(KINDS[k] ?? PENDING, byKind.get(k))),
  );
}

const COLLAPSED_TILES = 16; // about two rows on a laptop
const expanded = new Set(); // group names the user opened with "Show all"

function group(kind, list) {
  const section = el('section', 'group');
  const name = kind?.group ?? 'all';
  const open = expanded.has(name) || list.length <= COLLAPSED_TILES;
  const head = el('div', 'group-head');
  const title = el('h2', null, kind ? kind.group : 'All devices');
  title.append(el('span', 'group-count', list.length));
  head.append(title);
  if (list.length > COLLAPSED_TILES) {
    const toggle = el('button', 'show-all', open ? 'Show less ▴' : 'Show all ▾');
    toggle.type = 'button';
    toggle.onclick = () => {
      if (expanded.has(name)) expanded.delete(name);
      else expanded.add(name);
      render();
    };
    head.append(toggle);
  }
  section.append(head);
  const grid = el('ul', 'grid');
  grid.append(...(open ? list : list.slice(0, COLLAPSED_TILES)).map(tile));
  section.append(grid);
  return section;
}

function tile(d) {
  const kind = kindOf(d);
  const li = el('li');
  const btn = el('button', `tile${d.checking ? ' checking' : ''}`);
  btn.type = 'button';
  btn.title = `${kind.label} · ${d.ip}`;
  btn.append(el('span', `tile-icon tint-${kind.tint}`, kind.icon));
  btn.append(el('span', `tile-name${nicknames[d.ip] ? '' : ' muted'}`, tileName(d)));
  btn.append(el('span', 'tile-ip', d.ip));
  if (d.isNew) btn.append(el('span', 'badge', 'New'));
  btn.onclick = () => openDetail(d);
  li.append(btn);
  return li;
}

function openDetail(d) {
  const kind = kindOf(d);
  const dlg = $('detail');
  $('detailIcon').className = `tile-icon big tint-${kind.tint}`;
  $('detailIcon').textContent = kind.icon;
  $('detailTitle').textContent = nicknames[d.ip] || kind.label;
  $('detailType').textContent = kind.label;
  $('detailIp').textContent = d.ip;
  $('detailMs').textContent = `${Math.round(d.ms)} ms`;
  $('detailSeen').textContent = d.isNew ? 'New since your last scan' : 'Not new';
  $('detailOpen').href = `http://${d.ip}/`;
  $('nickInput').value = nicknames[d.ip] ?? '';
  dlg.dataset.ip = d.ip;
  dlg.showModal();
}

$('detailForm').addEventListener('submit', (e) => {
  // method="dialog" closes the dialog; Save stores the nickname first.
  if (e.submitter?.value !== 'save') return;
  const ip = $('detail').dataset.ip;
  const v = $('nickInput').value.trim();
  if (v) nicknames[ip] = v;
  else delete nicknames[ip];
  store.set('kyw.nicknames', nicknames);
  render();
});
$('detail').addEventListener('click', (e) => {
  if (e.target === $('detail')) $('detail').close(); // click on the backdrop
});

// ---------- wiring ----------

$('scanBtn').addEventListener('click', scan);
$('subnetForm').addEventListener('submit', (e) => { e.preventDefault(); scan(); });
$('search').addEventListener('input', render);
$('view').value = store.get('kyw.view', 'type');
$('view').addEventListener('change', () => { store.set('kyw.view', $('view').value); render(); });

const lastSubnet = store.get('kyw.lastSubnet', null);
if (lastSubnet) $('subnet').placeholder = lastSubnet;

$('autoScan').checked = store.get('kyw.auto', false);
function applyAuto() {
  clearInterval(autoTimer);
  store.set('kyw.auto', $('autoScan').checked);
  if ($('autoScan').checked) autoTimer = setInterval(() => !document.hidden && scan(), AUTO_SCAN_MS);
}
$('autoScan').addEventListener('change', applyAuto);
applyAuto();

// Test hook: ?autoscan starts a scan on load.
if (new URLSearchParams(location.search).has('autoscan')) scan();
