// app.js — wiring. Loads the manifest, runs the picker, builds the workbench,
// keeps the grade live, and stores progress the same way the rest of the
// packet site does.

import { loadLab, recordCommand } from '../engine/lab.js';
import { execute, contextHelp, complete, promptFor } from '../engine/ios.js';
import { executePc, pcComplete, setStatic, setDhcp } from '../engine/pcsh.js';
import { getDevice, getIface, ifaceUp, lineStatus } from '../engine/net.js';
import { createTerminal } from './term.js';
import { renderInspector, renderAnswers } from './inspector.js';
import { startDrill } from './drill.js';

const BASE = new URL('.', import.meta.url).href.replace(/ui\/$/, '');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  manifest: null,
  topologies: null,
  run: null,
  activeDevice: null,
  term: null,
  timer: null,
  startedAt: null,
  filter: { round: 'all', unit: 'all' }
};

/* ------------------------------------------------------------ storage --- */
// Same conventions as the rest of the site: pt_* keys, cs_theme shared with
// every drill app, everything guarded so a locked-down browser cannot break
// the page.

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }
};

/** Progress is per student profile, using the site's active profile. */
function profileKey() {
  const id = window.PT ? (PT.active()?.id || null) : null;
  return `pt_cli_progress${id ? '_' + id : ''}`;
}
function getProgress() { return store.get(profileKey(), {}); }
function saveProgress(slug, percent, seconds) {
  const all = getProgress();
  const prev = all[slug] || {};
  all[slug] = {
    best: Math.max(prev.best || 0, percent),
    lastPercent: percent,
    bestSeconds: percent === 100
      ? Math.min(prev.bestSeconds || Infinity, seconds || Infinity)
      : prev.bestSeconds,
    at: Date.now()
  };
  if (all[slug].bestSeconds === Infinity) delete all[slug].bestSeconds;
  store.set(profileKey(), all);
}

/**
 * Report to the site scoreboard. PT is a global on this page because
 * index.html loads cs-core.js; the parent-frame branch is there for the day
 * someone embeds a lab in a module page.
 */
function reportBest(slug, seconds, meta) {
  try {
    const pt = window.PT || (window.parent !== window ? window.parent.PT : null);
    if (pt && pt.recordBest) return pt.recordBest(slug, seconds, meta);
  } catch { /* cross-origin or absent; not important */ }
  return false;
}

/* --------------------------------------------------------------- boot --- */

async function boot() {
  // The shared nav, brand, profile switcher and theme buttons, exactly as on
  // every other page. cs-core.js applies the saved cs_theme itself.
  if (window.PT) PT.mountChrome({ nav: 'CLI Lab' });

  const [manifest, topologies] = await Promise.all([
    fetch(BASE + 'cli-labs.json').then(r => r.json()),
    fetch(BASE + 'labs/topologies.json').then(r => r.json())
  ]);
  state.manifest = manifest;
  state.topologies = topologies;

  window.addEventListener('popstate', route);
  // Switching profile in the site chrome changes whose progress this is.
  window.addEventListener('pt:progress', () => {
    if (document.body.dataset.view === 'picker') renderPicker();
  });
  route();
}

function route() {
  const params = new URLSearchParams(location.search);
  const slug = params.get('lab');
  const mode = params.get('mode');
  if (mode === 'drill') return openDrill();
  if (slug) return openLab(slug);
  renderPicker();
}

function go(search) {
  history.pushState({}, '', search ? `?${search}` : location.pathname);
  route();
}

/* ------------------------------------------------------------- picker --- */

function renderPicker() {
  stopTimer();
  document.body.dataset.view = 'picker';
  $('#crumb').innerHTML = '';
  const root = $('#view');
  const progress = getProgress();

  const rounds = state.manifest.rounds;
  const units = state.manifest.units;

  root.className = 'picker';
  root.replaceChildren();
  const wrap = el('div', 'cli-wrap');

  wrap.append(html(`
    <div class="lede">
      <h1>IOS Command Lab</h1>
      <p>A working Cisco command line in the browser, on a network that really
         responds. Type <code>ip address</code> with the wrong mask and the ping
         really fails — nothing here is scripted.</p>
      <p>Pick a lab. Each one has a short brief, a task list that grades itself
         as you work, and a reset button. Nothing is submitted anywhere.</p>
    </div>`));

  const filters = el('div', 'filters');
  filters.append(html('<span class="label">Round</span>'));
  filters.append(chip('All', state.filter.round === 'all', () => { state.filter.round = 'all'; renderPicker(); }));
  for (const r of rounds) {
    filters.append(chip(r.name, state.filter.round === r.id, () => { state.filter.round = r.id; renderPicker(); }));
  }
  wrap.append(filters);

  const drillCard = el('div', 'filters');
  drillCard.append(html('<span class="label">Also</span>'));
  const db = el('button', 'cli-chip');
  db.textContent = 'Command drill — timed';
  db.addEventListener('click', () => go('mode=drill'));
  drillCard.append(db);
  wrap.append(drillCard);

  const grid = el('div', 'grid');
  const labs = state.manifest.labs.filter(l =>
    state.filter.round === 'all' || l.round === state.filter.round || l.round === 'any');

  if (!labs.length) {
    grid.append(html('<p class="brief">No labs unlock at that round yet.</p>'));
  }

  for (const lab of labs) {
    const p = progress[lab.slug];
    const card = el('button', 'card');
    card.type = 'button';
    card.setAttribute('aria-label', `${lab.name} — ${lab.tagline}`);
    const unitName = units[lab.unit]?.name || lab.unit;

    card.append(html(`
      <div class="row">
        <span class="tag unit">${lab.unit.toUpperCase()}</span>
        ${lab.timed ? '<span class="tag">timed</span>' : ''}
        <span class="progress-pill ${p && p.best === 100 ? 'complete' : ''}">${p ? p.best + '%' : 'not started'}</span>
      </div>
      <h3>${escapeHtml(lab.name)}</h3>
      <p>${escapeHtml(lab.tagline)}</p>
      <div class="meta">
        <span>${escapeHtml(unitName)}</span>
        ${lab.estMinutes ? `<span>${lab.estMinutes} min</span>` : ''}
        <span class="dots" aria-label="difficulty ${lab.difficulty} of 4">${
          [1, 2, 3, 4].map(i => `<i class="${i <= lab.difficulty ? 'on' : ''}"></i>`).join('')
        }</span>
      </div>`));

    card.addEventListener('click', () => go(`lab=${lab.slug}`));
    grid.append(card);
  }

  wrap.append(grid);
  root.append(wrap);
}

function chip(label, pressed, onClick) {
  const b = el('button', 'cli-chip');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

/* ---------------------------------------------------------------- lab --- */

async function openLab(slug) {
  const entry = state.manifest.labs.find(l => l.slug === slug);
  if (!entry) return renderPicker();
  const lab = await fetch(`${BASE}labs/${slug}.json`).then(r => r.json());
  state.run = loadLab(lab, state.topologies);
  state.activeDevice = lab.startDevice;
  state.startedAt = Date.now();
  document.body.dataset.view = 'bench';
  renderWorkbench();
  if (lab.timeLimitSeconds) startTimer(lab.timeLimitSeconds);
}

function renderWorkbench() {
  const { lab, net } = state.run;
  const root = $('#view');
  root.className = '';
  root.replaceChildren();

  $('#crumb').innerHTML =
    `<button class="cli-chip" id="back" type="button">← All labs</button> <b>${escapeHtml(lab.name)}</b>`;
  $('#back').addEventListener('click', () => { state.run = null; go(''); });

  root.append(html(`
    <div class="bench">
      <aside class="pane left" aria-label="Topology and devices">
        <h2>Topology</h2>
        <div class="map" id="map"></div>
        <h2>Devices</h2>
        <div class="scroll"><div class="devlist" id="devlist" role="group" aria-label="Choose a device"></div></div>
      </aside>

      <section class="pane term-wrap" aria-label="Terminal">
        <div class="term-head">
          <span id="termdev"></span>
          <span class="mode" id="termmode"></span>
          <span class="spacer"></span>
          <button type="button" id="ipcfg" style="display:none">IP Configuration</button>
        </div>
        <div class="term" id="scrollback" role="log" aria-live="polite" aria-label="Terminal output"></div>
        <div class="term-input">
          <span class="prompt"></span>
          <input type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
                 aria-label="Command input" />
        </div>
      </section>

      <aside class="pane right" aria-label="Tasks and briefing">
        <div class="cli-ring" id="ring"></div>
        <div class="scroll">
          <ul class="tasks" id="tasks"></ul>
          <details class="cli-fold" id="briefpanel" open>
            <summary>Briefing</summary>
            <div class="body brief" id="brief"></div>
          </details>
          <details class="cli-fold">
            <summary>Packet inspector</summary>
            <div class="body inspector" id="inspector"></div>
            <div class="body" id="answers"></div>
          </details>
          <details class="cli-fold">
            <summary>Debrief &amp; extension</summary>
            <div class="body brief" id="debrief"></div>
          </details>
        </div>
      </aside>
    </div>

    <div class="benchbar">
      <button type="button" id="reset">Reset lab</button>
      <span class="clock" id="clock"></span>
      <span class="spacer"></span>
      <span class="sr-only" id="announce" role="status" aria-live="polite"></span>
      <details class="cli-fold" style="border:0;margin:0;padding:0">
        <summary>Answer key</summary>
        <div class="body"><pre id="solution"></pre></div>
      </details>
    </div>
  `));

  const termRoot = $('.term-wrap');
  state.term = createTerminal(termRoot, {
    getPrompt: currentPrompt,
    onSubmit: onSubmit,
    onHelp: onHelp,
    onComplete: onCompleteLine,
    onEnd: () => {
      const s = session();
      if (s.kind !== 'pc' && s.mode.startsWith('config')) { execute(s, 'end'); drainLog(); state.term.refresh(); }
    }
  });

  $('#reset').addEventListener('click', resetLab);
  $('#ipcfg').addEventListener('click', openIpConfig);

  renderDevices();
  renderMap();
  renderBrief();
  switchDevice(state.activeDevice, true);
  regrade();
  state.term.focus();
}

const session = () => state.run.sessions[state.activeDevice];

function currentPrompt() {
  const s = session();
  if (s.pending) return s.pending.prompt;
  return s.kind === 'pc' ? 'C:\\>' : promptFor(s);
}

/* ------------------------------------------------------------ devices --- */

function renderDevices() {
  const list = $('#devlist');
  list.replaceChildren();
  for (const dev of state.run.net.devices) {
    const b = el('button', 'dev');
    b.type = 'button';
    const anyUp = dev.ifaces.some(i => ifaceUp(state.run.net, dev, i));
    const hasIp = dev.ifaces.some(i => i.ip);
    b.append(html(`
      <span class="led ${anyUp ? (hasIp || dev.kind === 'switch' ? '' : 'bad') : 'off'}"></span>
      <span class="name">${escapeHtml(dev.hostname)}</span>
      <span class="kind">${dev.kind}</span>`));
    b.setAttribute('aria-current', String(dev.id === state.activeDevice));
    b.addEventListener('click', () => switchDevice(dev.id));
    list.append(b);
  }
}

function switchDevice(id, initial = false) {
  state.activeDevice = id;
  const s = session();
  const dev = s.dev;
  $('#termdev').textContent = dev.hostname;
  $('#termmode').textContent = s.kind === 'pc' ? 'Command Prompt' : modeName(s.mode);
  $('#ipcfg').style.display = s.kind === 'pc' ? '' : 'none';
  state.term.clear();
  state.term.setMasked(false);

  if (s.kind === 'pc') {
    state.term.write([`Packet Tracer PC Command Line 1.0`, '']);
  } else {
    if (dev.bannerMotd) state.term.write([dev.bannerMotd, '']);
    state.term.write([`Console connection to ${dev.hostname} (${dev.label})`,
                      `Press ? at any point for help. Tab completes.`, '']);
  }
  drainLog();
  state.term.refresh();
  renderDevices();
  if (!initial) state.term.focus();
}

function modeName(mode) {
  return ({
    user: 'User EXEC', priv: 'Privileged EXEC', config: 'Global config',
    'config-if': 'Interface config', 'config-line': 'Line config', 'config-dhcp': 'DHCP pool config'
  })[mode] || mode;
}

/** Console messages queued on this device by link changes elsewhere. */
function drainLog() {
  const dev = session().dev;
  if (!dev.log.length) return;
  state.term.write(dev.log, 'sys');
  dev.log.length = 0;
}

/* ----------------------------------------------------------- terminal --- */

function onSubmit(line) {
  const s = session();
  const wasPending = !!s.pending;
  if (!wasPending) recordCommand(state.run.ctx, s.dev.id, line);

  let res;
  if (s.kind === 'pc') {
    res = executePc(s, line);
    if (res.clear) state.term.clear();
  } else {
    res = execute(s, line);
  }

  state.term.output(res.lines || []);
  drainLog();
  state.term.setMasked(!!(s.pending && s.pending.secret));
  $('#termmode').textContent = s.kind === 'pc' ? 'Command Prompt' : modeName(s.mode);
  $('#termdev').textContent = s.dev.hostname;
  state.term.refresh();
  renderDevices();
  renderMap();
  regrade();
}

function onHelp(line) {
  const s = session();
  // A help request is still evidence the student engaged with the CLI.
  recordCommand(state.run.ctx, s.dev.id, line + '?');
  regrade();
  if (s.kind === 'pc') {
    return ['', 'Type a command name for help, or `help` for the list.', ''];
  }
  return contextHelp(s, line);
}

function onCompleteLine(line) {
  const s = session();
  return s.kind === 'pc' ? pcComplete(s, line) : complete(s, line);
}

/* ---------------------------------------------------------- the grade --- */

function regrade() {
  const { lab, ctx, net } = state.run;
  const grade = state.run.grade();
  renderRing(grade);
  renderTasks(grade);
  renderInspector($('#inspector'), net, lastTrace());
  renderAnswers($('#answers'), lab, ctx, () => regrade());

  const seconds = Math.round((Date.now() - state.startedAt) / 1000);
  if (!lab.sandbox) saveProgress(lab.slug, grade.percent, seconds);

  if (grade.complete && !state.run.celebrated) {
    state.run.celebrated = true;
    stopTimer();
    const best = reportBest(lab.slug, seconds, { kind: 'cli-lab', name: lab.name });
    if (lab.gate && window.PT && PT.recordGate) PT.recordGate(lab.unit, true, seconds);
    toast(best ? `Lab complete — ${formatTime(seconds)}, personal best`
               : `Lab complete — ${formatTime(seconds)}`);
    $('#announce').textContent = `All objectives complete in ${formatTime(seconds)}.`;
  }
}

function lastTrace() {
  for (const id of Object.keys(state.run.sessions)) {
    const s = state.run.sessions[id];
    if (s.dev.id === state.activeDevice && s.lastTrace) return s.lastTrace;
  }
  // Fall back to the most recent trace anywhere.
  let best = null;
  for (const s of Object.values(state.run.sessions)) if (s.lastTrace) best = s.lastTrace;
  return best;
}

function renderRing(grade) {
  const r = 26, c = 2 * Math.PI * r;
  const done = c * (grade.percent / 100);
  // At 0% a round cap would still paint a dot, which reads as "1%".
  const cap = grade.percent === 0 ? 'butt' : 'round';
  $('#ring').innerHTML = `
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="6"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--accent)" stroke-width="6"
              stroke-linecap="${cap}" stroke-dasharray="${done} ${c}"
              transform="rotate(-90 32 32)"/>
    </svg>
    <div>
      <div class="pct">${grade.percent}%</div>
      <div class="sub">${grade.earned} of ${grade.total} points</div>
    </div>`;
}

function renderTasks(grade) {
  const ul = $('#tasks');
  ul.replaceChildren();
  if (!grade.tasks.length) {
    ul.append(html('<p class="brief">Sandbox — nothing to score. Try things.</p>'));
    return;
  }
  for (const t of grade.tasks) {
    const li = el('li', 'task' + (t.met ? ' met' : ''));
    li.append(html(`
      <div class="t">
        <span class="box" aria-hidden="true"></span>
        <span>${escapeHtml(t.text)}</span>
        <span class="pts">${t.points}</span>
      </div>`));
    li.setAttribute('aria-label', `${t.met ? 'Complete' : 'Not complete'}: ${t.text}`);
    if (t.hint && !t.met) {
      const btn = el('button', 'hintbtn');
      btn.type = 'button';
      btn.textContent = 'Hint';
      const p = el('p', 'hint');
      p.hidden = true;
      p.textContent = t.hint;
      btn.addEventListener('click', () => { p.hidden = !p.hidden; btn.textContent = p.hidden ? 'Hint' : 'Hide hint'; });
      li.append(btn, p);
    }
    ul.append(li);
  }
}

function renderBrief() {
  const { lab } = state.run;
  const b = $('#brief');
  b.replaceChildren();
  for (const para of String(lab.brief || '').split('\n\n')) {
    b.append(html(`<p>${escapeHtml(para)}</p>`));
  }
  if (lab.watchFor) b.append(html(`<p class="watch">${escapeHtml(lab.watchFor)}</p>`));
  if (lab.focus?.length) {
    b.append(html(`<p style="font-family:var(--mono);font-size:12px">Commands in play: ${
      lab.focus.map(escapeHtml).join(' · ')}</p>`));
  }

  const d = $('#debrief');
  d.replaceChildren();
  if (lab.extension) d.append(html(`<p><b>Extension.</b> ${escapeHtml(lab.extension)}</p>`));
  for (const para of String(lab.debrief || '').split('\n\n').filter(Boolean)) {
    d.append(html(`<p>${escapeHtml(para)}</p>`));
  }
  if (!lab.extension && !lab.debrief) d.append(html('<p>No debrief for a sandbox.</p>'));

  $('#solution').textContent = (lab.solution || [])
    .filter(s => s.cmds)
    .map(s => `${s.device}\n  ` + s.cmds.filter(c => !c.startsWith('__')).join('\n  '))
    .join('\n\n') || 'Sandbox — no answer key.';
}

/* --------------------------------------------------------------- map --- */

function renderMap() {
  const net = state.run.net;
  const cols = Math.max(...net.devices.map(d => d.x ?? 0)) + 1;
  const rows = Math.max(...net.devices.map(d => d.y ?? 0)) + 1;
  const CW = 62, RH = 54, BOX = 46;
  const W = cols * CW, H = rows * RH;

  const pos = {};
  for (const d of net.devices) {
    pos[d.id] = { x: (d.x ?? 0) * CW + CW / 2, y: (d.y ?? 0) * RH + RH / 2 };
  }

  const edges = net.links.map(l => {
    const a = pos[l.a.dev], b = pos[l.b.dev];
    const devA = getDevice(net, l.a.dev), devB = getDevice(net, l.b.dev);
    const up = l.ok &&
      lineStatus(net, devA, getIface(devA, l.a.iface)) === 'up' &&
      lineStatus(net, devB, getIface(devB, l.b.iface)) === 'up';
    return `<line class="edge ${up ? '' : 'down'}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
  }).join('');

  const nodes = net.devices.map(d => {
    const p = pos[d.id];
    const active = d.id === state.activeDevice ? ' active' : '';
    return `<g class="node${active}">
      <rect x="${p.x - BOX / 2}" y="${p.y - 12}" width="${BOX}" height="24" rx="5"/>
      <text x="${p.x}" y="${p.y + 4}">${escapeHtml(d.hostname).slice(0, 7)}</text>
    </g>`;
  }).join('');

  $('#map').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Network topology">${edges}${nodes}</svg>`;
}

/* -------------------------------------------------- IP Configuration --- */

function openIpConfig() {
  const dev = session().dev;
  const iface = dev.ifaces[0];
  const dlg = $('#ipdialog');
  dlg.innerHTML = `
    <h3>IP Configuration — ${escapeHtml(dev.hostname)}</h3>
    <p class="sub">The same dialog Packet Tracer puts under Desktop.</p>
    <form method="dialog">
      <div class="radios">
        <label><input type="radio" name="mode" value="dhcp" ${dev.host.dhcp ? 'checked' : ''}> DHCP</label>
        <label><input type="radio" name="mode" value="static" ${dev.host.dhcp ? '' : 'checked'}> Static</label>
      </div>
      <div class="field"><span>IPv4 Address</span><input type="text" name="ip" value="${iface.ip || ''}"></div>
      <div class="field"><span>Subnet Mask</span><input type="text" name="mask" value="${iface.mask || ''}"></div>
      <div class="field"><span>Default Gateway</span><input type="text" name="gateway" value="${dev.host.gateway || ''}"></div>
      <div class="field"><span>DNS Server</span><input type="text" name="dns" value="${dev.host.dnsServer || ''}"></div>
      <div class="actions">
        <button type="button" id="ipcancel">Cancel</button>
        <button type="submit" class="primary" id="ipsave">Apply</button>
      </div>
    </form>`;

  const form = dlg.querySelector('form');
  const setDisabled = () => {
    const dhcp = form.mode.value === 'dhcp';
    for (const n of ['ip', 'mask', 'gateway', 'dns']) form[n].disabled = dhcp;
  };
  form.addEventListener('change', setDisabled);
  setDisabled();

  dlg.querySelector('#ipcancel').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', () => {
    if (form.mode.value === 'dhcp') {
      const r = setDhcp(state.run.net, dev);
      recordCommand(state.run.ctx, dev.id, 'ipconfig /renew');
      state.term.write(['', r.ok ? `DHCP: address ${r.ip} acquired from ${r.server}`
                                 : 'DHCP: no server responded — check the pool and the link.', '']);
    } else {
      setStatic(state.run.net, dev, {
        ip: form.ip.value.trim() || null,
        mask: form.mask.value.trim() || null,
        gateway: form.gateway.value.trim() || null,
        dns: form.dns.value.trim() || null
      });
      state.term.write(['', 'IP configuration applied.', '']);
    }
    renderDevices(); renderMap(); regrade(); state.term.refresh();
  });

  dlg.showModal();
}

/* -------------------------------------------------------------- reset --- */

async function resetLab() {
  const slug = state.run.lab.slug;
  stopTimer();
  await openLab(slug);
  toast('Lab reset');
}

/* -------------------------------------------------------------- timer --- */

function startTimer(limitSeconds) {
  const el = $('#clock');
  const tick = () => {
    const left = limitSeconds - Math.round((Date.now() - state.startedAt) / 1000);
    el.textContent = left >= 0 ? `⏱ ${formatTime(left)} left` : `⏱ over by ${formatTime(-left)}`;
    el.classList.toggle('low', left <= 60);
  };
  tick();
  state.timer = setInterval(tick, 1000);
}
function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
function formatTime(s) {
  const m = Math.floor(Math.abs(s) / 60), r = Math.abs(s) % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/* -------------------------------------------------------------- drill --- */

function openDrill() {
  stopTimer();
  document.body.dataset.view = 'drill';
  $('#crumb').innerHTML = `<button class="cli-chip" id="back" type="button">← All labs</button> <b>Command drill</b>`;
  $('#back').addEventListener('click', () => go(''));
  const root = $('#view');
  root.className = 'picker';
  root.replaceChildren();
  startDrill(root, {
    onBest: (seconds) => { reportBest('cli-command-drill', seconds); },
    store
  });
}

/* ------------------------------------------------------------- helpers --- */

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function html(str) { const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = el('div', 'cli-toast');
  t.textContent = msg;
  t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

boot();
