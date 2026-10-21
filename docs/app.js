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
const SETTLE_MS = 21_000; // > host_down_time, before the confirm pass and the next scan
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
async function probeHost(ip) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    await fetch(`https://${ip}/`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return performance.now() - t0;
  } catch {
    return ctrl.signal.aborted ? null : performance.now() - t0;
  } finally {
    clearTimeout(timer);
  }
}

// Probes every address at the same moment (one socket each; Chrome allows ~256),
// so the pass ends before the OS starts failing lookups in bulk.
async function probeAll(ips, onResult) {
  await Promise.all(ips.map(async (ip) => onResult(ip, await probeHost(ip))));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const wait = store.get('kyw.lastScanAt', 0) + SETTLE_MS - Date.now();
    if (wait > 0 && wait <= SETTLE_MS) {
      for (let s = Math.ceil(wait / 1000); s > 0; s--) {
        setMeta(`Letting the network settle… starting in ${s}s`);
        await sleep(1000);
      }
    }
    let subnet = $('subnet').value.trim().replace(/\.$/, '');
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
  }
}

async function sweep(subnet) {
  const knownKey = `kyw.known.${subnet}`;
  const known = new Set(store.get(knownKey, []));
  const firstScan = known.size === 0;
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
    devices.push({ ip, ms, isRouter: ip === `${subnet}.1`, isNew: !firstScan && !known.has(ip), checking: true });
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
  store.set('kyw.lastScanAt', Date.now());
  $('progress').hidden = true;

  for (const d of devices) known.add(d.ip);
  store.set(knownKey, [...known]);
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

function render() {
  $('deviceCount').textContent = devices.length;
  const q = $('search').value.trim().toLowerCase();
  const visible = devices
    .filter((d) => !q || d.ip.includes(q) || (nicknames[d.ip] ?? '').toLowerCase().includes(q))
    .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  const list = $('deviceList');
  list.replaceChildren(...visible.map(deviceRow));
  if (!visible.length) list.append(el('li', 'empty', scanning ? 'Looking…' : 'No devices found.'));
}

function deviceRow(d) {
  const li = el('li', `device${d.isNew ? ' is-new' : ''}${d.checking ? ' checking' : ''}`);
  li.append(el('div', 'icon', d.isRouter ? '📡' : '📶'));

  const info = el('div');
  const nameRow = el('div', 'name-row');
  const nick = nicknames[d.ip];
  const nameBtn = el('button', `name${nick || d.isRouter ? '' : ' unknown'}`,nick || (d.isRouter ? 'Router' : 'Add a nickname'));
  nameBtn.type = 'button';
  nameBtn.title = 'Click to set a nickname';
  nameBtn.onclick = () => editNickname(d, nameBtn);
  nameRow.append(nameBtn);
  if (d.isRouter) nameRow.append(el('span', 'tag router', 'Router'));
  if (d.isNew) nameRow.append(el('span', 'tag new', 'New'));
  info.append(nameRow);
  info.append(el('div', 'sub', `Answered in ${Math.round(d.ms)} ms`));
  li.append(info);

  const addr = el('div', 'addr');
  addr.append(el('div', 'ip', d.ip));
  const open = el('a', 'open', 'Open ↗');
  open.href = `http://${d.ip}/`;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  addr.append(open);
  li.append(addr);
  return li;
}

function editNickname(d, btn) {
  const input = el('input', 'nick-input');
  input.value = nicknames[d.ip] ?? '';
  input.placeholder = 'e.g. Mum’s iPhone';
  input.setAttribute('aria-label', `Nickname for ${d.ip}`);
  btn.replaceWith(input);
  input.focus();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) nicknames[d.ip] = v;
      else delete nicknames[d.ip];
      store.set('kyw.nicknames', nicknames);
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- wiring ----------

$('scanBtn').addEventListener('click', scan);
$('subnetForm').addEventListener('submit', (e) => { e.preventDefault(); scan(); });
$('search').addEventListener('input', render);

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
