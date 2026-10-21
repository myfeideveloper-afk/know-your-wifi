const DEFAULT_AGENT = 'http://127.0.0.1:7878';
const AUTO_SCAN_MS = 60_000;

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// When the agent serves this page itself, talk to it on the same origin.
const servedByAgent = ['127.0.0.1', 'localhost'].includes(location.hostname);
let agentUrl = servedByAgent ? location.origin : store.get('kyw.agent', DEFAULT_AGENT);

const nicknames = store.get('kyw.nicknames', {}); // mac -> nickname
let known = new Set(store.get('kyw.known', [])); // macs seen in earlier scans
let lastResult = null;
let activeFilter = 'all';
let autoTimer = null;

// ---------- device type guessing ----------

const TYPES = [
  { key: 'router', label: 'Network', icon: '📡', match: /unifi|u7|usw|uap|router|gateway|access.?point|mesh|deco|eero|ubiquiti|tp-?link|netgear|mikrotik|aruba|ruckus|linksys|cisco/i },
  { key: 'phone', label: 'Phone', icon: '📱', match: /iphone|android|galaxy|pixel|redmi|poco|xiaomi.*\d|oppo|vivo|realme|oneplus|huawei|honor|nokia|motorola|z-?fold|z-?flip|\bs2\d\b|\ba\d{2}\b|phone/i },
  { key: 'tablet', label: 'Tablet', icon: '📲', match: /ipad|tab\b|tablet|kindle/i },
  { key: 'watch', label: 'Wearable', icon: '⌚', match: /watch/i },
  { key: 'computer', label: 'Computer', icon: '💻', match: /macbook|imac|mac-?mini|mac-?studio|\bmac\b|laptop|desktop|\bpc\b|thinkpad|nitro|zenbook|asus.?zen|surface|azurewave|intel corporate|liteon|dell|lenovo|wnc corp/i },
  { key: 'printer', label: 'Printer', icon: '🖨️', match: /print|epson|canon|brother|^brw|^npi|laserjet|officejet/i },
  { key: 'tv', label: 'TV & media', icon: '📺', match: /\btv\b|roku|chromecast|fire.?stick|bravia|shield|apple.?tv|android.?tv|webos|tizen/i },
  { key: 'speaker', label: 'Speaker', icon: '🔊', match: /echo|alexa|sonos|homepod|nest|google.?home/i },
  { key: 'camera', label: 'Camera', icon: '📷', match: /cam|hikvision|dahua|ring|wyze|tapo|reolink|ezviz/i },
  { key: 'console', label: 'Console', icon: '🎮', match: /playstation|ps[45]|xbox|nintendo|switch/i },
  { key: 'iot', label: 'Smart home', icon: '💡', match: /tuya|espressif|shelly|sonoff|zhimi|xiaomi|yeelight|philips|hue|smartthings|broadlink|wlan0|esp_|raspberry/i },
];
const UNKNOWN = { key: 'other', label: 'Other', icon: '❔' };

function guessType(d) {
  if (d.isGateway) return TYPES[0];
  const nameHit = TYPES.find((t) => d.name && t.match.test(d.name));
  if (nameHit) return nameHit;
  const vendorHit = TYPES.find((t) => d.vendor && t.match.test(d.vendor));
  if (vendorHit) return vendorHit;
  // Randomized MACs are almost always phones, tablets or laptops.
  return d.randomizedMac ? { ...TYPES[1], label: 'Phone', icon: '📱' } : UNKNOWN;
}

// ---------- agent connection ----------

function setStatus(state, text) {
  $('agentStatus').dataset.state = state;
  $('agentText').textContent = text;
  $('scanBtn').disabled = state !== 'online';
  $('setup').hidden = state !== 'offline';
}

async function checkAgent() {
  setStatus('checking', 'Looking for scanner…');
  try {
    const res = await fetch(`${agentUrl}/api/health`, { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    setStatus('online', 'Scanner connected');
    return true;
  } catch {
    setStatus('offline', 'Scanner not running');
    return false;
  }
}

async function scan() {
  const btn = $('scanBtn');
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Scanning…';
  $('error').hidden = true;
  try {
    const res = await fetch(`${agentUrl}/api/scan`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    handleResult(data);
  } catch (err) {
    showError(`Scan failed: ${err.message}`);
    await checkAgent();
  } finally {
    btn.classList.remove('busy');
    btn.disabled = $('agentStatus').dataset.state !== 'online';
    btn.querySelector('.btn-label').textContent = 'Scan network';
  }
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

function handleResult(data) {
  // The first scan is the baseline; after that, unseen MACs are marked "new".
  const firstScan = known.size === 0;
  for (const d of data.devices) d.isNew = !firstScan && !known.has(d.mac);
  for (const d of data.devices) known.add(d.mac);
  store.set('kyw.known', [...known]);

  for (const d of data.devices) d.type = guessType(d);
  lastResult = data;
  render();
}

// ---------- rendering ----------

const displayName = (d) => nicknames[d.mac] || d.name;

function render() {
  const data = lastResult;
  if (!data) return;
  const { network } = data;

  $('deviceCount').textContent = data.count;
  $('networkLabel').textContent = network.cidr;
  const when = new Date(data.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const newCount = data.devices.filter((d) => d.isNew).length;
  $('scanMeta').textContent =
    `Scanned at ${when} in ${(data.durationMs / 1000).toFixed(1)}s via ${network.iface}` +
    (newCount ? ` · ${newCount} new` : '') +
    (network.clamped ? ' · large network, showing your /24 only' : '');
  $('results').hidden = false;

  renderFilters(data.devices);

  const q = $('search').value.trim().toLowerCase();
  const visible = data.devices.filter((d) => {
    if (activeFilter !== 'all' && d.type.key !== activeFilter) return false;
    if (!q) return true;
    return [displayName(d), d.name, d.ip, d.mac, d.vendor, d.type.label]
      .some((v) => v && v.toLowerCase().includes(q));
  });

  const list = $('deviceList');
  list.replaceChildren(...visible.map(deviceRow));
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No devices match.';
    list.append(li);
  }
}

function renderFilters(devices) {
  const counts = new Map();
  for (const d of devices) counts.set(d.type.key, (counts.get(d.type.key) ?? 0) + 1);
  const types = [...TYPES, UNKNOWN].filter((t) => counts.has(t.key));
  if (activeFilter !== 'all' && !counts.has(activeFilter)) activeFilter = 'all';

  const chip = (key, label, count) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(activeFilter === key));
    b.append(label, Object.assign(document.createElement('b'), { textContent: count }));
    b.onclick = () => { activeFilter = key; render(); };
    return b;
  };
  $('filters').replaceChildren(
    chip('all', 'All', devices.length),
    ...types.map((t) => chip(t.key, `${t.icon} ${t.label}`, counts.get(t.key))),
  );
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function deviceRow(d) {
  const li = el('li', `device${d.isNew ? ' is-new' : ''}`);
  li.append(el('div', 'icon', d.type.icon));

  const info = el('div');
  const nameRow = el('div', 'name-row');
  const label = displayName(d);
  const nameBtn = el('button', `name${label ? '' : ' unknown'}`, label || 'Unknown device');
  nameBtn.type = 'button';
  nameBtn.title = 'Click to set a nickname';
  nameBtn.onclick = () => editNickname(d, nameRow, nameBtn);
  nameRow.append(nameBtn);
  if (d.isSelf) nameRow.append(el('span', 'tag you', 'This device'));
  if (d.isGateway) nameRow.append(el('span', 'tag router', 'Router'));
  if (d.isNew) nameRow.append(el('span', 'tag new', 'New'));
  info.append(nameRow);

  const vendor = d.vendor ?? (d.randomizedMac ? 'Private MAC' : 'Unknown maker');
  const sub = [d.type.label, vendor];
  if (nicknames[d.mac] && d.name) sub.push(`reports as “${d.name}”`);
  info.append(el('div', 'sub', sub.join(' · ')));
  li.append(info);

  const addr = el('div', 'addr');
  addr.append(el('div', 'ip', d.ip), el('div', null, d.mac));
  li.append(addr);
  return li;
}

function editNickname(d, row, btn) {
  const input = el('input', 'nick-input');
  input.value = nicknames[d.mac] ?? d.name ?? '';
  input.placeholder = d.name ?? 'Nickname';
  input.setAttribute('aria-label', `Nickname for ${d.ip}`);
  btn.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v && v !== d.name) nicknames[d.mac] = v;
      else delete nicknames[d.mac];
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
$('search').addEventListener('input', render);

$('autoScan').checked = store.get('kyw.auto', false);
function applyAuto() {
  clearInterval(autoTimer);
  store.set('kyw.auto', $('autoScan').checked);
  if ($('autoScan').checked) autoTimer = setInterval(() => !document.hidden && scan(), AUTO_SCAN_MS);
}
$('autoScan').addEventListener('change', applyAuto);
applyAuto();

$('agentUrl').value = agentUrl;
$('agentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  agentUrl = $('agentUrl').value.trim().replace(/\/+$/, '') || DEFAULT_AGENT;
  store.set('kyw.agent', agentUrl);
  if (await checkAgent()) scan();
});

// Keep retrying quietly while the user follows the setup steps.
async function connectLoop() {
  if (await checkAgent()) return scan();
  const retry = setInterval(async () => {
    if ($('agentStatus').dataset.state === 'online') return clearInterval(retry);
    try {
      const res = await fetch(`${agentUrl}/api/health`, { cache: 'no-store' });
      if (res.ok) {
        clearInterval(retry);
        setStatus('online', 'Scanner connected');
        scan();
      }
    } catch {}
  }, 4000);
}
connectLoop();
